/**
 * OpenAI Responses API + file_search for Matriya (same tool shape as maneger-back gpt-rag/query).
 */
import axios from 'axios';
import {
  getMatriyaOpenAiVectorStoreId,
  getOpenAiApiBase,
  getOpenAiRagModel
} from './openaiMatriyaConfig.js';
import settings from '../config.js';

export function extractOpenAiResponsesOutputText(data) {
  if (!data || typeof data !== 'object') return '';
  if (typeof data.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
  const out = data.output;
  if (!Array.isArray(out)) return '';
  const parts = [];
  for (const item of out) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c && typeof c.text === 'string' && (c.type === 'output_text' || c.type === 'text')) parts.push(c.text);
      }
    }
  }
  return parts.join('\n\n').trim();
}

/**
 * Best-effort relevance from file_search result row (API shape varies).
 * @returns {number|null} clamped 0..1 or null if absent
 */
export function extractFileSearchResultScore(r) {
  if (!r || typeof r !== 'object') return null;
  const candidates = [
    r.score,
    r.similarity_score,
    r.relevance_score,
    r.ranking_score,
    r.weight,
    r.attributes?.score,
    r.metadata?.score
  ];
  for (const v of candidates) {
    if (typeof v === 'number' && !Number.isNaN(v)) {
      let x = v;
      if (x > 1 && x <= 100) x = x / 100;
      return Math.min(1, Math.max(0, x));
    }
  }
  return null;
}

/**
 * Best-effort map of file_search_call payloads (shape varies by API version).
 * @returns {{ filename: string, text: string, apiScore?: number }[]}
 */
export function collectFileSearchSnippetsFromResponse(data) {
  const chunks = [];
  const out = data?.output;
  if (!Array.isArray(out)) return chunks;
  for (const item of out) {
    if (item.type !== 'file_search_call') continue;
    const results = item.results || item.search_results || item.content || [];
    const list = Array.isArray(results) ? results : [];
    for (const r of list) {
      const text =
        (typeof r === 'string' && r) ||
        r.text ||
        r.content ||
        r.chunk ||
        r.snippet ||
        '';
      const fname =
        r.filename ||
        r.file_name ||
        (r.file && (r.file.filename || r.file.name)) ||
        r.name ||
        'Unknown';
      if (text && String(text).trim()) {
        const apiScore = extractFileSearchResultScore(r);
        const row = { filename: String(fname), text: String(text).trim() };
        if (apiScore != null) row.apiScore = apiScore;
        chunks.push(row);
      }
    }
  }
  return chunks;
}

const ASK_MATRIYA_MIN_DOC_CHARS = 12;

/**
 * Turn raw file_search snippets into gate-shaped rows (relevance 0..1, top=1) for evaluatePreLlmEvidencePhase.
 * Uses token overlap with query + draft answer and optional API scores. Drops weak tails vs best match.
 */
export function buildAskMatriyaGateChunksFromSnippets(snippets, query = '', answerText = '') {
  const maxRows = Math.max(4, Math.min(24, parseInt(process.env.MATRIYA_ASK_MAX_GATE_CHUNKS || '16', 10) || 16));
  const qt = tokenizeForEvidenceOverlap(query);
  const at = tokenizeForEvidenceOverlap(answerText).slice(0, 50);
  const seen = new Set();
  const deduped = [];
  for (const s of Array.isArray(snippets) ? snippets : []) {
    const fn = String(s.filename ?? 'Unknown');
    const raw = String(s.text ?? s.excerpt ?? '').trim();
    if (raw.length < ASK_MATRIYA_MIN_DOC_CHARS) continue;
    const key = `${fn}\0${raw.slice(0, 120)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const apiScore = typeof s.apiScore === 'number' && !Number.isNaN(s.apiScore) ? Math.min(1, Math.max(0, s.apiScore)) : null;
    deduped.push({ filename: fn, text: raw, apiScore });
  }
  if (deduped.length === 0) return [];

  const scored = deduped.map((row) => {
    const low = row.text.toLowerCase();
    return { ...row, overlapSc: scoreSnippetOverlap(low, qt, at) };
  });
  const bestOverlap = Math.max(...scored.map((x) => x.overlapSc), 0);
  const bestApi = Math.max(...scored.map((x) => x.apiScore ?? 0), 0);

  const withCombined = scored.map((row) => {
    const overlapNorm = bestOverlap > 0 ? row.overlapSc / bestOverlap : 0;
    const apiNorm = bestApi > 0 ? (row.apiScore ?? 0) / bestApi : 0;
    const combined = Math.max(overlapNorm, apiNorm);
    return { ...row, combined };
  });

  let bestCombined = Math.max(...withCombined.map((x) => x.combined), 0);

  /** Single substantive chunk from file_search but no overlap tokens / scores — still allow gate (retrieval order). */
  if (bestCombined <= 0 && deduped.length === 1) {
    return [
      {
        document: deduped[0].text,
        text: deduped[0].text,
        metadata: { filename: deduped[0].filename },
        evidence_metric: 'openai_rank',
        relevance_score: 1
      }
    ];
  }
  if (bestCombined <= 0) return [];

  const normalized = withCombined.map((row) => ({
    document: row.text,
    text: row.text,
    metadata: { filename: row.filename },
    evidence_metric: 'openai_rank',
    relevance_score: Math.min(1, row.combined / bestCombined)
  }));

  normalized.sort((a, b) => (b.relevance_score || 0) - (a.relevance_score || 0));
  return normalized.slice(0, maxRows);
}

/** Default count of source excerpts shown in UI (ranked by overlap with query / answer). */
export const DEFAULT_EVIDENCE_MAX_ITEMS = 6;

function tokenizeForEvidenceOverlap(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2)
    .slice(0, 80);
}

function scoreSnippetOverlap(snippetLower, queryToks, answerToks) {
  let s = 0;
  for (const t of queryToks) {
    if (t.length >= 2 && snippetLower.includes(t)) s += 2;
  }
  for (const t of answerToks) {
    if (t.length >= 3 && snippetLower.includes(t)) s += 1;
  }
  return s;
}

/**
 * Dedupe, rank by token overlap with query (and lightly with answer), drop weak tails when any strong match exists.
 * Preserves retrieval order when there is no usable query/answer text or all scores are zero.
 */
export function selectRankedSnippetList(
  snippets,
  query = '',
  answerText = '',
  maxItems = DEFAULT_EVIDENCE_MAX_ITEMS,
  minScoreRatio = 0.35
) {
  const cap = Math.max(1, maxItems);
  const list = Array.isArray(snippets) ? snippets : [];
  const seen = new Set();
  const deduped = [];
  let ord = 0;
  for (const s of list) {
    const fn = String(s.filename ?? '—');
    const raw = String(s.text ?? s.excerpt ?? '').trim();
    if (!raw) continue;
    const key = `${fn}\0${raw.slice(0, 120)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({ filename: fn, text: raw, _i: ord++ });
  }
  const qt = tokenizeForEvidenceOverlap(query);
  const at = tokenizeForEvidenceOverlap(answerText).slice(0, 50);
  if (qt.length === 0 && at.length === 0) {
    return deduped.slice(0, cap).map(({ filename, text }) => ({ filename, text }));
  }
  const scored = deduped.map((row) => {
    const low = row.text.toLowerCase();
    return { ...row, sc: scoreSnippetOverlap(low, qt, at) };
  });
  scored.sort((a, b) => b.sc - a.sc || a._i - b._i);
  const best = scored[0]?.sc ?? 0;
  if (best <= 0) {
    return deduped.slice(0, cap).map(({ filename, text }) => ({ filename, text }));
  }
  const floor = Math.max(1, best * minScoreRatio);
  const strong = scored.filter((x) => x.sc >= floor);
  const pool = strong.length ? strong : scored;
  return pool.slice(0, cap).map(({ filename, text }) => ({ filename, text }));
}

/** API shape for management/Matriya UI: { filename, excerpt }[] */
export function normalizeEvidenceSources(
  snippets,
  maxItems = DEFAULT_EVIDENCE_MAX_ITEMS,
  maxLen = 4000,
  query = '',
  answerText = ''
) {
  const itemCap = maxItems == null ? DEFAULT_EVIDENCE_MAX_ITEMS : maxItems;
  const lenCap = maxLen == null ? 4000 : maxLen;
  const ranked = selectRankedSnippetList(snippets, query, answerText, itemCap);
  return ranked.map((s) => {
    const fn = String(s.filename ?? '—');
    const raw = String(s.text ?? '').trim();
    const excerpt = raw.length > lenCap ? `${raw.slice(0, lenCap)}…` : raw;
    return { filename: fn, excerpt };
  });
}

/** Placeholder rows when API omits structured chunks — not real document excerpts. */
const SYNTHETIC_EVIDENCE_FILENAMES = new Set([
  'חיפוש במסמכים (מאגר מסונכרן)',
  'OpenAI file search'
]);

export function evidenceFromSearchResults(
  results,
  maxItems = DEFAULT_EVIDENCE_MAX_ITEMS,
  maxLen = 4000,
  query = '',
  answerText = ''
) {
  const itemCap = maxItems == null ? DEFAULT_EVIDENCE_MAX_ITEMS : maxItems;
  const lenCap = maxLen == null ? 4000 : maxLen;
  const snippets = (Array.isArray(results) ? results : [])
    .filter((item) => !SYNTHETIC_EVIDENCE_FILENAMES.has(item.metadata?.filename || ''))
    .map((item) => ({
      filename: item.metadata?.filename || 'Unknown',
      text: item.document || item.text || ''
    }));
  return normalizeEvidenceSources(snippets, itemCap, lenCap, query, answerText);
}

function jsonHeaders(apiKey) {
  return { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
}

function buildFilenameHint(filterMetadata) {
  if (!filterMetadata || typeof filterMetadata !== 'object') return '';
  const files = Array.isArray(filterMetadata.filenames)
    ? filterMetadata.filenames.filter((f) => typeof f === 'string' && f.trim())
    : [];
  if (files.length > 0) {
    return `\n\n(User asked to focus on these document paths/names if relevant: ${files.join(', ')})`;
  }
  const one = typeof filterMetadata.filename === 'string' ? filterMetadata.filename.trim() : '';
  return one ? `\n\n(User asked to focus on: ${one})` : '';
}

/** Real logical filenames in Matriya (disambiguation; claims must still come from file_search only). */
export function buildMatriyaCatalogAppendix(filenames) {
  const list = Array.isArray(filenames) ? filenames.map((f) => String(f || '').trim()).filter(Boolean) : [];
  const unique = [...new Set(list)].slice(0, 120);
  if (!unique.length) return '';
  return (
    '\n\n[System — indexed document names in Matriya. Broad questions (על מה המסמך מדבר וכו׳): combine several file_search quotes into a source-based general summary; no themes/details beyond quotes. Other questions: shorten/organize quotes only; same prohibitions. No general knowledge. If nothing answers, say so in Hebrew.]\n' +
    unique.map((n) => `· ${n}`).join('\n') +
    '\n'
  );
}

/** Search / RAG path: evidence for kernel and agents (`forContextOnly: true`). */
const FAIL_SAFE_NO_EVIDENCE_HE =
  'אם file_search לא החזיר קטעי טקסט שימושיים, השב במשפט יחיד בדיוק בעברית: "אין במערכת מידע תומך לשאלה זו." בלי נקודות, בלי רשימות, בלי המלצות, בלי המשך, בלי "אבל" או "לחלופין".';

const INSTRUCTIONS_CONTEXT =
  'You retrieve evidence from file_search for downstream agents. Use ONLY the attached vector store. ' +
  'חוקי תשובה: מותר לקחת כמה ציטוטים, לקצר אותם ולארגן למשפטים ברורים. אסור להוסיף מידע שלא בציטוטים, להשלים פערים או להסיק מעבר למה שכתוב — טרנספורמציה של הציטוטים בלבד. ' +
  'שאלות כלליות (נושא המסמך, על מה מדובר): חובה לספק מספר ציטוטים ולבנות מהם תיאור כללי או סיכום מבוסס מקור — בלי נושאים או פרטים שלא עולים מהציטוטים. ' +
  'Label excerpts with source filenames. No general knowledge for facts. ' +
  FAIL_SAFE_NO_EVIDENCE_HE;

/** Ask Matriya + answered search (`forContextOnly: false`). Aligned with management GPT RAG policy. */
export const MATRIYA_FILE_SEARCH_INSTRUCTIONS_ANSWER =
  'You answer using ONLY file_search snippets from the attached vector store. ' +
  'חוקי תשובה (חובה): מותר לקחת כמה ציטוטים, לקצר אותם, ולארגן אותם למשפטים ברורים. ' +
  'אסור להוסיף מידע שלא מופיע בציטוטים, להשלים פערים, או להסיק מעבר למה שכתוב בציטוטים. התשובה = טרנספורמציה של הציטוטים בלבד. ' +
  'שאלות כלליות (למשל «על מה המסמך מדבר», מה נושא המסמך): חייבים לענות — לשלב מספר ציטוטים לתיאור כללי או סיכום מבוסס מקור; זו לא תשובה עובדתית נקודתית אחת. כל חלק בסיכום חייב להישען על תוכן הציטוטים — בלי נושאים או פרטים שלא עולים מהם. ' +
  'English: For broad/overview questions, you must produce a coherent high-level summary from multiple excerpts — source-based only, no unsupported themes. For specific questions, same quote rules as above. ' +
  'Cite source filenames. Respond in Hebrew (עברית) unless the user explicitly asks otherwise. Do not use Arabic. ' +
  'Do NOT use general knowledge, training data, or the web for facts. ' +
  FAIL_SAFE_NO_EVIDENCE_HE +
  ' When the user names a file, prioritize snippets from that file; for multiple documents, keep excerpts tied to each filename.';

/**
 * @param {object} opts
 * @param {string} opts.query
 * @param {string} opts.vectorStoreId
 * @param {string} opts.instructions
 * @param {number} [opts.maxNumResults]
 * @param {object|null} [opts.filterMetadata]
 * @param {boolean} [opts.includeResultDetails]
 */
export async function openAiResponsesFileSearch(opts) {
  const apiKey = (settings.OPENAI_API_KEY || '').trim();
  if (!apiKey) {
    const err = new Error('OPENAI_API_KEY not configured');
    err.code = 'OPENAI_KEY_MISSING';
    throw err;
  }
  const base = getOpenAiApiBase();
  const model = getOpenAiRagModel();
  const vsId = opts.vectorStoreId || getMatriyaOpenAiVectorStoreId();
  if (!vsId) {
    const err = new Error('No OpenAI vector store. Run GPT document sync from the Files tab or set MATRIYA_OPENAI_VECTOR_STORE_ID.');
    err.code = 'OPENAI_VS_MISSING';
    throw err;
  }
  const catalogBit =
    opts.catalogAppendix != null && String(opts.catalogAppendix).trim() !== ''
      ? String(opts.catalogAppendix)
      : '';
  const input = String(opts.query || '') + buildFilenameHint(opts.filterMetadata || null) + catalogBit;
  const payload = {
    model,
    instructions: opts.instructions,
    input,
    tools: [
      {
        type: 'file_search',
        vector_store_ids: [vsId],
        max_num_results: Math.min(50, Math.max(4, opts.maxNumResults ?? 20))
      }
    ],
    include: opts.includeResultDetails !== false ? ['file_search_call.results'] : []
  };
  const r = await axios.post(`${base}/responses`, payload, {
    headers: jsonHeaders(apiKey),
    timeout: 120000
  });
  return r.data;
}

export async function openAiFileSearchAnswerAndSnippets(
  query,
  filterMetadata,
  { forContextOnly = false, catalogFilenames = null } = {}
) {
  const instructions = forContextOnly ? INSTRUCTIONS_CONTEXT : MATRIYA_FILE_SEARCH_INSTRUCTIONS_ANSWER;
  const catalogAppendix = buildMatriyaCatalogAppendix(
    Array.isArray(catalogFilenames) ? catalogFilenames : null
  );

  const data = await openAiResponsesFileSearch({
    query,
    filterMetadata,
    instructions,
    catalogAppendix,
    maxNumResults: forContextOnly ? 28 : 24,
    includeResultDetails: true
  });
  const answerText = extractOpenAiResponsesOutputText(data);
  const snippets = collectFileSearchSnippetsFromResponse(data);
  return { data, answerText, snippets };
}
