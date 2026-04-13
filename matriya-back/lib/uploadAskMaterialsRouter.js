/**
 * Upload tab «שאל על המסמכים»: first LLM gate — materials-library vs document text.
 * No changes to vector RAG; management data comes from optional MANAGEMENT API HTTP fetch.
 */
import axios from 'axios';
import logger from '../logger.js';
import settings from '../config.js';

const CLASSIFIER_SYSTEM = `You gate routing to the INTERNAL management API (materials library + lab experiments metadata per project). Reply YES only when you are confident the user wants THAT registry — not document text.

Reply YES when the question is clearly about one or more of:
- What materials / raw materials are registered in the management "material library" or lab module for projects (names, roles, lists, coverage across projects).
- Which projects have which materials according to management data, or summaries of experiment↔material links as stored in management.
- Explicitly asking to use or query "ספריית חומרים", "החומרים בניהול", "במערכת הניהול", "material library in management", etc.

Reply NO (default when unsure) for:
- Part numbers, catalog numbers, מקט, SKU, barcode, manufacturer codes, prices, specs, safety sheets — even if the question names a material or product (those usually live in uploaded documents, not in this API).
- Anything that is primarily: "מה המקט של …", "what is the SKU…", datasheet facts, invoice/BOM line items, or page/clause content in files.
- General chemistry/science or vague "tell me about substance X" with no tie to the management registry.
- If the user could reasonably expect the answer from PDF/Word/Excel they attached — that is NO.

Important: When in doubt, reply NO.

Reply with exactly one token: YES or NO (uppercase). No punctuation or explanation.`;

const MATERIALS_ANSWER_RULES = [
  'Grounding: Use ONLY the "Materials library & projects (management)" section below.',
  'Do NOT invent materials, projects, or facts not listed there. Do not use general training knowledge for factual claims.',
  'You may organize, compare, or summarize only what appears in that section.',
  'If the section does not contain enough information, say so clearly in Hebrew.',
  'Consistency: For the same question and the same data below, keep wording stable — same facts and structure; avoid decorative rephrasing.',
  'Respond in Hebrew (עברית) only. Do not use Arabic.'
].join('\n');

const ASK_MATRIYA_MATERIALS_LLM_SEED = 918_273_645;

export async function classifyMaterialsLibraryIntent(userMessage, openaiApiKey) {
  const msg = String(userMessage || '').trim();
  if (!msg || !openaiApiKey) return false;
  try {
    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: CLASSIFIER_SYSTEM },
          { role: 'user', content: msg.slice(0, 4000) }
        ],
        max_tokens: 8,
        temperature: 0
      },
      {
        headers: {
          Authorization: `Bearer ${openaiApiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 25000
      }
    );
    const raw = String(res.data?.choices?.[0]?.message?.content || '').trim();
    const rawUp = raw.toUpperCase();
    const yes = /^YES\b/.test(rawUp) || rawUp === 'YES';
    logger.info(
      `[ask-matriya routing] LLM classifier (materials_library vs documents): raw="${raw}" → intent=${yes ? 'MATERIALS_LIBRARY' : 'DOCUMENTS'} | query_preview="${msg.slice(0, 120).replace(/\s+/g, ' ')}${msg.length > 120 ? '…' : ''}"`
    );
    return yes;
  } catch (e) {
    logger.warn(
      `[ask-matriya routing] LLM classifier failed → default DOCUMENTS path | error=${e.message}`
    );
    return false;
  }
}

function truncate(s, n) {
  const t = String(s || '').trim();
  if (t.length <= n) return t;
  return `${t.slice(0, n)}…`;
}

const MAX_PROJECTS_ENRICH = 35;
const EXPERIMENTS_PAGE_LIMIT = 80;
const PROJECT_FETCH_CONCURRENCY = 5;

function materialsFromExperimentRow(exp) {
  const out = [];
  const mats = exp?.materials;
  if (Array.isArray(mats)) {
    for (const m of mats) {
      if (m == null) continue;
      if (typeof m === 'string' && m.trim()) out.push(m.trim());
      else if (typeof m === 'object' && m.material_name) out.push(String(m.material_name).trim());
      else if (typeof m === 'object' && m.name) out.push(String(m.name).trim());
    }
  } else if (mats && typeof mats === 'object') {
    for (const k of Object.keys(mats)) {
      if (k && String(k).trim()) out.push(String(k).trim());
    }
  }
  const pct = exp?.percentages;
  if (pct && typeof pct === 'object') {
    for (const k of Object.keys(pct)) {
      if (k && String(k).trim()) out.push(String(k).trim());
    }
  }
  return [...new Set(out)];
}

async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  for (let b = 0; b < items.length; b += concurrency) {
    const slice = items.slice(b, b + concurrency);
    const chunk = await Promise.all(slice.map((item, j) => fn(item, b + j)));
    for (let k = 0; k < chunk.length; k++) results[b + k] = chunk[k];
  }
  return results;
}

async function fetchExperimentsForProject(base, headers, projectId) {
  try {
    const r = await axios.get(`${base}/api/projects/${encodeURIComponent(projectId)}/experiments`, {
      headers,
      timeout: 20000,
      params: { limit: EXPERIMENTS_PAGE_LIMIT, offset: 0 }
    });
    return Array.isArray(r.data?.experiments) ? r.data.experiments : [];
  } catch (e) {
    logger.warn(`[ask-matriya routing] GET /api/projects/${projectId}/experiments failed: ${e.message}`);
    return [];
  }
}

function buildMaterialsContextText(enrichedRows, materialsCatalogRows) {
  const matLines = (materialsCatalogRows || []).slice(0, 500).map((m) => {
    const name = m.material_name ?? m.name ?? m.material_id ?? '?';
    const id = m.material_id != null ? String(m.material_id) : '';
    const dom = m.technology_domain ?? m.domain ?? '';
    const proj = m.project_name != null && String(m.project_name).trim() ? String(m.project_name).trim() : '';
    const role = m.role_or_function != null && String(m.role_or_function).trim() ? String(m.role_or_function).trim() : '';
    const extras = [
      proj ? `project: ${proj}` : dom ? dom : '',
      role ? `role: ${role}` : ''
    ].filter(Boolean);
    const suffix = extras.length ? ` — ${extras.join('; ')}` : '';
    return `- ${name}${id ? ` (id: ${id})` : ''}${suffix}`;
  });

  const globalCatalogSection = matLines.length
    ? `Global materials catalog (${matLines.length} rows):\n${matLines.join('\n')}`
    : '';

  const perProjectSections = enrichedRows.map((row) => {
    const matStr =
      row.materials_from_experiments.length > 0
        ? row.materials_from_experiments.join(', ')
        : '(no materials union from lab experiments in this project)';
    const lines = [
      `### Project: ${row.name}`,
      `- project_id: ${row.id}`,
      row.description ? `- description: ${row.description}` : null,
      `- experiments_fetched: ${row.experiment_count}`,
      row.experiments_truncated ? `- note: experiment list truncated for size` : null,
      `- materials (union from those experiments): ${matStr}`
    ].filter(Boolean);
    if (row.experiment_summaries.length > 0) {
      lines.push('- experiment breakdown:');
      for (const ex of row.experiment_summaries) {
        const mid = ex.experiment_id || '?';
        const dom = ex.technology_domain ? ` domain=${ex.technology_domain}` : '';
        const oc = ex.outcome ? ` outcome=${ex.outcome}` : '';
        const mm = ex.materials.length ? ` materials=[${ex.materials.join(', ')}]` : '';
        lines.push(`  • ${mid}${dom}${oc}${mm}`);
      }
    }
    return lines.join('\n');
  });

  const parts = [];
  if (globalCatalogSection) parts.push(globalCatalogSection);
  if (perProjectSections.length) {
    parts.push(
      `Projects with per-project materials (from management) (${perProjectSections.length}):\n\n${perProjectSections.join('\n\n')}`
    );
  }
  return parts.join('\n\n');
}

function logEnrichedPayload(enrichedRows, sourceTag) {
  for (const row of enrichedRows) {
    const preview = row.experiment_summaries.slice(0, 12);
    logger.info(
      `[ask-matriya routing] AI materials payload (sent to LLM) [${sourceTag}] | project_id=${row.id} project_name=${JSON.stringify(row.name)} experiment_count=${row.experiment_count} materials_union=${JSON.stringify(row.materials_from_experiments)} experiments_preview=${JSON.stringify(preview)}`
    );
    logger.debug(
      `[ask-matriya routing] AI materials payload experiments_full | project_id=${row.id} ${JSON.stringify(row.experiment_summaries)}`
    );
  }
}

function rowsFromSummaryPayload(data) {
  const catalog = Array.isArray(data?.materials_catalog) ? data.materials_catalog : [];
  const projects = Array.isArray(data?.projects) ? data.projects : [];
  const enrichedRows = projects.map((p) => {
    const union = Array.isArray(p.materials_union) ? p.materials_union : [];
    const exps = Array.isArray(p.experiments) ? p.experiments : [];
    return {
      id: String(p.id),
      name: String(p.name ?? '?'),
      description: truncate(p.description ?? '', 200),
      experiment_count: typeof p.experiment_count === 'number' ? p.experiment_count : exps.length,
      experiments_truncated: Boolean(p.experiments_truncated),
      materials_from_experiments: union.slice(0, 300),
      experiment_summaries: exps.slice(0, 40).map((ex) => ({
        experiment_id: ex.experiment_id != null ? String(ex.experiment_id) : '',
        technology_domain: ex.technology_domain != null ? String(ex.technology_domain) : '',
        outcome: ex.experiment_outcome != null ? String(ex.experiment_outcome) : '',
        materials: Array.isArray(ex.materials) ? ex.materials.slice(0, 40) : []
      }))
    };
  });
  return { catalog, enrichedRows };
}

/**
 * @param {string | undefined} authHeader - e.g. Authorization from Matriya request (forwarded to management API)
 * @param {string} baseUrl - no trailing slash
 * @returns {{ text: string, ok: boolean }}
 */
export async function fetchManagementMaterialsLibraryContext(authHeader, baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/$/, '');
  if (!base) {
    logger.info(
      `[ask-matriya routing] management fetch skipped: MATRIYA_MANAGEMENT_API_URL empty → will use DOCUMENTS path if classifier was YES`
    );
    return { text: '', ok: false };
  }
  const hasAuth = Boolean(authHeader && String(authHeader).trim());
  logger.info(
    `[ask-matriya routing] management fetch start | base=${base} | authorization=${hasAuth ? 'present' : 'missing'}`
  );
  const headers = {
    Accept: 'application/json',
    ...(authHeader ? { Authorization: authHeader } : {}),
    ...(settings.MATRIYA_MANAGEMENT_MATERIALS_KEY
      ? { 'X-Matriya-Materials-Key': settings.MATRIYA_MANAGEMENT_MATERIALS_KEY }
      : {})
  };
  try {
    try {
      const sumRes = await axios.get(`${base}/api/matriya/projects-with-materials-summary`, {
        headers,
        timeout: 90000,
        params: { max_experiments_per_project: 200 }
      });
      const payload = sumRes.data;
      if (sumRes.status === 200 && payload && typeof payload === 'object') {
        const { catalog, enrichedRows } = rowsFromSummaryPayload(payload);
        const text = buildMaterialsContextText(enrichedRows, catalog);
        const ok = Boolean(text.trim());
        if (ok || catalog.length || enrichedRows.length) {
          logger.info(
            `[ask-matriya routing] management aggregate OK | GET /api/matriya/projects-with-materials-summary | projects=${enrichedRows.length} catalog_rows=${catalog.length} usable=${ok}`
          );
          logEnrichedPayload(enrichedRows, 'aggregate');
          logger.info(
            `[ask-matriya routing] management fetch done [aggregate] | catalog_materials=${catalog.length} projects_enriched=${enrichedRows.length} context_chars=${text.length} usable=${ok}`
          );
          return { text, ok };
        }
      }
    } catch (sumErr) {
      const st = sumErr.response?.status;
      logger.warn(
        `[ask-matriya routing] aggregate /api/matriya/projects-with-materials-summary failed${st != null ? ` (${st})` : ''}: ${sumErr.message} → legacy multi-request fetch`
      );
    }

    const [matRes, projRes] = await Promise.all([
      axios.get(`${base}/api/materials`, { headers, timeout: 20000 }).catch((e) => {
        logger.warn(`[ask-matriya routing] GET /api/materials failed: ${e.message}`);
        return { data: {} };
      }),
      axios
        .get(`${base}/api/projects`, { headers, timeout: 20000, params: { limit: 200, offset: 0 } })
        .catch((e) => {
          logger.warn(`[ask-matriya routing] GET /api/projects failed: ${e.message}`);
          return { data: {} };
        })
    ]);
    const materials = Array.isArray(matRes.data?.materials) ? matRes.data.materials : [];
    const projects = Array.isArray(projRes.data?.projects) ? projRes.data.projects : [];

    const projectsToEnrich = projects.slice(0, MAX_PROJECTS_ENRICH).filter((p) => p && p.id != null);
    const enrichedRows = await mapPool(projectsToEnrich, PROJECT_FETCH_CONCURRENCY, async (p) => {
      const pid = String(p.id);
      const exps = await fetchExperimentsForProject(base, headers, pid);
      const union = new Set();
      for (const exp of exps) {
        for (const m of materialsFromExperimentRow(exp)) {
          if (m) union.add(m);
        }
      }
      const materialsUnion = [...union].slice(0, 250);
      return {
        id: pid,
        name: String(p.name ?? p.title ?? '?'),
        description: truncate(p.description ?? p.notes ?? '', 200),
        experiment_count: exps.length,
        experiments_truncated: false,
        materials_from_experiments: materialsUnion,
        experiment_summaries: exps.slice(0, 25).map((exp) => ({
          experiment_id: exp.experiment_id != null ? String(exp.experiment_id) : '',
          technology_domain: exp.technology_domain != null ? String(exp.technology_domain) : '',
          outcome: exp.experiment_outcome != null ? String(exp.experiment_outcome) : '',
          materials: materialsFromExperimentRow(exp).slice(0, 40)
        }))
      };
    });

    const text = buildMaterialsContextText(enrichedRows, materials);
    const ok = Boolean(text.trim());
    logEnrichedPayload(enrichedRows, 'legacy');
    logger.info(
      `[ask-matriya routing] management fetch done [legacy] | catalog_materials=${materials.length} projects_list=${projects.length} projects_enriched=${enrichedRows.length} context_chars=${text.length} usable=${ok}`
    );
    return { text, ok };
  } catch (e) {
    logger.warn(`[ask-matriya routing] management fetch exception: ${e.message}`);
    return { text: '', ok: false };
  }
}

export async function answerFromMaterialsLibraryContext(userMessage, libraryText, openaiApiKey, historySlice) {
  const systemContent = `${MATERIALS_ANSWER_RULES}

Materials library & projects (management):
${libraryText}`;

  const messages = [
    { role: 'system', content: systemContent },
    ...(Array.isArray(historySlice) ? historySlice : []),
    { role: 'user', content: String(userMessage || '').trim().slice(0, 4000) }
  ];

  logger.info(
    `[ask-matriya routing] LLM answer (materials_library path) | system_context_chars=${libraryText.length} history_msgs=${Array.isArray(historySlice) ? historySlice.length : 0}`
  );
  const res = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      messages,
      max_tokens: 1200,
      temperature: 0,
      seed: ASK_MATRIYA_MATERIALS_LLM_SEED
    },
    {
      headers: {
        Authorization: `Bearer ${openaiApiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 60000
    }
  );
  const out = String(res.data?.choices?.[0]?.message?.content || '').trim();
  logger.info(
    `[ask-matriya routing] response path=MATERIALS_LIBRARY | reply_chars=${out.length}`
  );
  return out;
}
