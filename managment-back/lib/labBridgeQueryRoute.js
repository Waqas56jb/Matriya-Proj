/**
 * Lab bridge — GET /api/lab/query
 * Matriya (flow=lab) calls this with query params; response must match Answer Composer lab contract.
 */
import pg from 'pg';

const { Pool } = pg;

let poolSingleton = null;
/** Last reason getPool() refused to connect (for 503 JSON). */
let poolConfigHint = null;

/**
 * `pg` requires a standard postgres:// or postgresql:// URI.
 * Vercel/Neon sometimes expose `neon://` or other schemes on DATABASE_URL — those throw "Invalid URL" on connect.
 */
function normalizePgConnectionString() {
  poolConfigHint = null;
  const raw = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (raw == null || raw === '') return null;
  let s = String(raw).replace(/^\uFEFF/, '').trim();
  // Strip surrounding quotes (common Vercel copy-paste mistake).
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  // Strip accidental "KEY=value" prefix — happens when someone pastes the full .env line
  // e.g. "POSTGRES_URL=postgresql://..." instead of just "postgresql://..."
  if (/^[A-Z_]+=.+/i.test(s)) {
    const eqIdx = s.indexOf('=');
    if (eqIdx !== -1) s = s.slice(eqIdx + 1).trim();
  }
  if (!s) return null;
  const scheme = s.split(':', 1)[0].toLowerCase();
  if (scheme !== 'postgres' && scheme !== 'postgresql') {
    poolConfigHint =
      `Lab bridge needs POSTGRES_URL (or DATABASE_URL) as postgres://… or postgresql://… (node-pg). ` +
      `Current scheme "${scheme || '(empty)'}" is not supported. ` +
      `In Vercel → Environment Variables, the VALUE must be ONLY the URI string (e.g. postgresql://user:pass@host:6543/db), ` +
      `NOT "POSTGRES_URL=postgresql://…". Do not include the variable name in the value field.`;
    return null;
  }
  return s;
}

function getPool() {
  if (poolSingleton) return poolSingleton;
  const conn = normalizePgConnectionString();
  if (!conn) return null;
  try {
    poolSingleton = new Pool({
      connectionString: conn,
      ssl: { rejectUnauthorized: false },
    });
  } catch (e) {
    poolSingleton = null;
    poolConfigHint = e?.message || String(e);
    return null;
  }
  return poolSingleton;
}

function str(v) {
  if (v == null) return '';
  const s = String(v).trim();
  return s;
}

/** @param {string} baseId */
function baseIdSqlMatch(paramIndex) {
  return `(
    f.base_id = $${paramIndex}
    OR f.base_id = regexp_replace($${paramIndex}, '^BASE-', '')
    OR ($${paramIndex} ~ '^BASE-' IS FALSE AND f.base_id = ('BASE-' || $${paramIndex}))
  )`;
}

function emptyVersionComparison(blocked) {
  return {
    query_type: 'version_comparison',
    source_run_ids: [],
    baseline_run_id: null,
    data_grade: 'NO_DATA',
    run_type: null,
    conclusion_status: 'INSUFFICIENT_DATA',
    delta_summary: {},
    blocked_reason: blocked,
    source_metadata: {},
  };
}

function emptyFormulationDelta(blocked) {
  return {
    query_type: 'formulation_delta',
    source_run_ids: [],
    baseline_run_id: null,
    data_grade: 'NO_DATA',
    run_type: null,
    conclusion_status: 'INSUFFICIENT_DATA',
    delta_summary: {},
    blocked_reason: blocked,
    source_metadata: {},
    detail: {},
  };
}

function isDdMmYyyy(s) {
  return /^\d{2}\.\d{2}\.\d{4}$/.test(String(s || '').trim());
}

async function findFormulationBySourceIdOrDate(client, token, base_id = null) {
  const t = str(token);
  if (!t) return null;
  const byDate = isDdMmYyyy(t);
  const params = [];
  let where = '';
  if (byDate) {
    params.push(`${t}-%`);
    where = `f.source_id LIKE $1`;
  } else {
    params.push(t);
    where = `f.source_id = $1 OR f.raw_source_id = $1`;
  }
  if (base_id) {
    const baseMatch = baseIdSqlMatch(2);
    params.push(str(base_id));
    where = `${where} AND ${baseMatch}`;
  }
  const { rows } = await client.query(
    `SELECT f.id, f.source_id, f.raw_source_id, f.base_id, f.version, f.source_file, f.composition_scale
     FROM formulations f
     WHERE ${where}
     ORDER BY f.created_at DESC, f.source_id DESC
     LIMIT 1`,
    params
  );
  return rows && rows[0] ? rows[0] : null;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function formatDeltaLine(name, pctA, pctB) {
  const a = round2(pctA);
  const b = round2(pctB);
  const d = round2(b - a);
  const sign = d > 0 ? '+' : '';
  return `- ${name}: ${a.toFixed(2)} → ${b.toFixed(2)} (${sign}${d.toFixed(2)}%)`;
}

async function handleFormulationDelta(client, base_id, id_a, id_b) {
  const aTok = str(id_a);
  const bTok = str(id_b);
  const base = str(base_id);
  if (!aTok || !bTok) {
    return emptyFormulationDelta(
      'formulation_delta requires id_a and id_b (source_id like 27.10.2022-001 or date like 27.10.2022).'
    );
  }
  const fa = await findFormulationBySourceIdOrDate(client, aTok, base || null);
  const fb = await findFormulationBySourceIdOrDate(client, bTok, base || null);
  if (!fa || !fb) {
    return emptyFormulationDelta(`Could not find formulations for "${aTok}" and/or "${bTok}".`);
  }

  const { rows } = await client.query(
    `SELECT formulation_id, material_name, fraction::float AS fraction
     FROM formulation_materials
     WHERE formulation_id = ANY($1::uuid[])`,
    [[fa.id, fb.id]]
  );
  const mapA = new Map();
  const mapB = new Map();
  for (const r of rows) {
    const name = String(r.material_name || '').trim();
    if (!name) continue;
    const fid = String(r.formulation_id);
    if (fid === String(fa.id)) mapA.set(name, Number(r.fraction));
    if (fid === String(fb.id)) mapB.set(name, Number(r.fraction));
  }

  const scaleA = Number(fa.composition_scale) || 1;
  const scaleB = Number(fb.composition_scale) || 1;
  const keys = new Set([...mapA.keys(), ...mapB.keys()]);

  const changed = [];
  const added = [];
  const removed = [];
  for (const name of keys) {
    const fracA = mapA.has(name) ? mapA.get(name) : null;
    const fracB = mapB.has(name) ? mapB.get(name) : null;
    const pctA = fracA != null && Number.isFinite(fracA) ? (fracA / scaleA) * 100 : null;
    const pctB = fracB != null && Number.isFinite(fracB) ? (fracB / scaleB) * 100 : null;
    if (pctA == null && pctB == null) continue;
    if (pctA == null && pctB != null) {
      added.push({ material: name, pctA: null, pctB });
      continue;
    }
    if (pctA != null && pctB == null) {
      removed.push({ material: name, pctA, pctB: null });
      continue;
    }
    const delta = pctB - pctA;
    if (Math.abs(delta) > 1e-6) {
      changed.push({ material: name, pctA, pctB, delta });
    }
  }

  changed.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  added.sort((x, y) => x.material.localeCompare(y.material));
  removed.sort((x, y) => x.material.localeCompare(y.material));

  const delta_lines = [
    ...changed.map((r) => formatDeltaLine(r.material, r.pctA, r.pctB)),
    ...(added.length ? [`- New components: ${added.map((x) => x.material).join(', ')}`] : []),
    ...(removed.length ? [`- Removed components: ${removed.map((x) => x.material).join(', ')}`] : []),
  ];

  return {
    query_type: 'formulation_delta',
    source_run_ids: [String(fa.source_id), String(fb.source_id)],
    baseline_run_id: null,
    data_grade: 'HISTORICAL_REFERENCE',
    run_type: null,
    conclusion_status: delta_lines.length ? 'OK' : 'INSUFFICIENT_DATA',
    delta_summary: {},
    blocked_reason: delta_lines.length ? null : 'No component differences detected (or no materials found).',
    source_metadata: {
      base_id: base || null,
      id_a: aTok,
      id_b: bTok,
      matched_a: fa.source_id,
      matched_b: fb.source_id,
      source_file_a: fa.source_file,
      source_file_b: fb.source_file,
    },
    detail: {
      composition_delta: {
        changed,
        added,
        removed,
        delta_lines,
      },
    },
  };
}

/**
 * @param {number|null} run
 * @param {number|null} baseline
 */
function channelDelta(run, baseline) {
  const r = run == null ? NaN : Number(run);
  const b = baseline == null ? NaN : Number(baseline);
  if (!Number.isFinite(r) || !Number.isFinite(b)) {
    return { status: 'INCOMPARABLE', run_value: null, baseline_value: null, delta_pct: null };
  }
  if (b === 0) {
    return { status: 'INCOMPARABLE', run_value: r, baseline_value: b, delta_pct: null };
  }
  // delta_pct is in PERCENT (0-100 scale) so it can be compared directly to threshold (e.g. 10%).
  // Formula: (run - baseline) / baseline * 100, rounded to 2 decimal places.
  const delta_pct = Math.round(((r - b) / b) * 1e4) / 1e2;
  return { status: 'COMPARED', run_value: r, baseline_value: b, delta_pct };
}

function buildDeltaSummary(outCompare, outBaseline) {
  const channels = ['v6', 'v12', 'v30', 'v60'].map((channel) => {
    const runKey = channel;
    const baseKey = channel;
    const row = channelDelta(outCompare?.[runKey], outBaseline?.[baseKey]);
    return { channel, ...row };
  });

  let maxAbs = 0;
  let dominant = null;
  for (const ch of channels) {
    if (ch.status !== 'COMPARED' || ch.delta_pct == null) continue;
    const a = Math.abs(ch.delta_pct);
    if (a > maxAbs) {
      maxAbs = a;
      dominant = ch.channel;
    }
  }

  const phR = outCompare?.ph != null ? Number(outCompare.ph) : NaN;
  const phB = outBaseline?.ph != null ? Number(outBaseline.ph) : NaN;
  const ph_delta =
    Number.isFinite(phR) && Number.isFinite(phB)
      ? Math.round((phR - phB) * 1e4) / 1e4
      : null;

  const ph_run = Number.isFinite(phR) ? phR : null;
  const ph_baseline = Number.isFinite(phB) ? phB : null;

  const max_delta_pct = maxAbs > 0 ? Math.round(maxAbs * 1e4) / 1e4 : null;

  return {
    channels,
    max_delta_pct,
    dominant_channel: dominant,
    ph_run,
    ph_baseline,
    ph_delta,
  };
}

async function loadMaterialDelta(client, formIdA, formIdB) {
  const { rows } = await client.query(
    `SELECT formulation_id, material_name, fraction::float AS fraction
     FROM formulation_materials
     WHERE formulation_id = ANY($1::uuid[])`,
    [[formIdA, formIdB]]
  );
  const mapA = {};
  const mapB = {};
  for (const r of rows) {
    const t = String(r.material_name || '');
    const fid = String(r.formulation_id);
    if (fid === String(formIdA)) mapA[t] = r.fraction;
    if (fid === String(formIdB)) mapB[t] = r.fraction;
  }
  const keys = new Set([...Object.keys(mapA), ...Object.keys(mapB)]);
  const changed = [];
  let identical = true;
  for (const k of keys) {
    const a = mapA[k];
    const b = mapB[k];
    if (a == null && b == null) continue;
    if (a == null || b == null || Math.abs(a - b) > 1e-6) {
      identical = false;
      changed.push({ material: k, fraction_a: a ?? null, fraction_b: b ?? null });
    }
  }
  return { identical, changed_materials: changed };
}

async function handleVersionComparison(client, base_id, version_a, version_b) {
  const b = str(base_id);
  const va = str(version_a);
  const vb = str(version_b);
  if (!b || !va || !vb) {
    return emptyVersionComparison('version_comparison requires base_id, version_a, and version_b.');
  }

  // Deterministic short-circuit: same version compared against itself → zero delta, no DB needed.
  if (va.toLowerCase() === vb.toLowerCase()) {
    return {
      query_type: 'version_comparison',
      source_run_ids: [],
      baseline_run_id: null,
      data_grade: 'LOGICAL',
      run_type: null,
      conclusion_status: 'NO_CHANGE',
      delta_summary: {
        channels: [],
        max_delta_pct: 0,
        dominant_channel: null,
        ph_run: null,
        ph_baseline: null,
        ph_delta: null,
      },
      blocked_reason: null,
      source_metadata: { base_id: b, version_a: va, version_b: vb },
      detail: { note: 'version_a equals version_b — no change by definition.' },
    };
  }

  const baseMatch = baseIdSqlMatch(1);
  const { rows: forms } = await client.query(
    `SELECT f.id, f.version
     FROM formulations f
     WHERE ${baseMatch} AND f.version IN ($2, $3)`,
    [b, va, vb]
  );

  const fa = forms.find((r) => str(r.version) === va);
  const fb = forms.find((r) => str(r.version) === vb);
  if (!fa || !fb) {
    return emptyVersionComparison(`No runs found for ${b} versions "${va}" or "${vb}".`);
  }

  const { rows: runsA } = await client.query(
    `SELECT id, baseline_run_id, run_type, run_origin
     FROM production_runs
     WHERE formulation_id = $1
     ORDER BY production_date DESC NULLS LAST, id DESC`,
    [fa.id]
  );
  const { rows: runsB } = await client.query(
    `SELECT id, baseline_run_id, run_type, run_origin
     FROM production_runs
     WHERE formulation_id = $1
     ORDER BY production_date DESC NULLS LAST, id DESC`,
    [fb.id]
  );

  if (!runsA.length || !runsB.length) {
    return emptyVersionComparison(`No production_runs for versions "${va}" / "${vb}".`);
  }

  let runBaseline = runsA[0];
  let runCompare = runsB.find((r) => r.baseline_run_id && String(r.baseline_run_id) === String(runBaseline.id));
  if (!runCompare) runCompare = runsB[0];

  if (String(runCompare.id) === String(runBaseline.id) && runsB.length > 1) {
    runCompare = runsB.find((r) => String(r.id) !== String(runBaseline.id)) || runCompare;
  }

  const runIds = [runCompare.id, runBaseline.id];

  const { rows: outs } = await client.query(
    `SELECT DISTINCT ON (m.production_run_id)
        m.production_run_id,
        COALESCE(o.v6, o.viscosity_6rpm_cps)::float AS v6,
        COALESCE(o.v12, o.viscosity_12rpm_cps)::float AS v12,
        COALESCE(o.v30, o.viscosity_30rpm_cps)::float AS v30,
        COALESCE(o.v60, o.viscosity_60rpm_cps)::float AS v60,
        o.ph::float AS ph,
        o.conclusion_status
     FROM outcomes o
     JOIN measurements m ON m.id = o.measurement_id
     WHERE m.production_run_id = ANY($1::uuid[])
     ORDER BY m.production_run_id, o.test_date DESC NULLS LAST, o.id DESC`,
    [runIds]
  );

  const byRun = {};
  for (const o of outs) byRun[String(o.production_run_id)] = o;

  const ob = byRun[String(runBaseline.id)];
  const oc = byRun[String(runCompare.id)];
  if (!ob || !oc) {
    return {
      ...emptyVersionComparison('Missing outcomes for one or both runs (measurements/outcomes).'),
      source_run_ids: [String(runCompare.id), String(runBaseline.id)],
      baseline_run_id: String(runBaseline.id),
      data_grade:
        runBaseline.run_origin === 'REAL' && runCompare.run_origin === 'REAL'
          ? 'REAL'
          : 'HISTORICAL_REFERENCE',
      run_type: runCompare.run_type || null,
    };
  }

  const delta_summary = buildDeltaSummary(oc, ob);
  const data_grade =
    runBaseline.run_origin === 'REAL' && runCompare.run_origin === 'REAL' ? 'REAL' : 'HISTORICAL_REFERENCE';

  let detail = {};
  try {
    const material_delta = await loadMaterialDelta(client, fa.id, fb.id);
    detail = { material_delta };
  } catch {
    detail = {};
  }

  return {
    query_type: 'version_comparison',
    source_run_ids: [String(runCompare.id), String(runBaseline.id)],
    baseline_run_id: String(runBaseline.id),
    data_grade,
    run_type: runCompare.run_type || null,
    conclusion_status: oc.conclusion_status || 'INSUFFICIENT_DATA',
    delta_summary,
    blocked_reason: null,
    source_metadata: { version_a: va, version_b: vb, base_id: b },
    detail,
  };
}

export async function labBridgeQueryHandler(req, res) {
  const type = str(req.query.type);
  if (!type) {
    return res.status(400).json({ error: 'Missing query param: type' });
  }

  if (type === 'missing_variable_detection') {
    return res.json({
      query_type: 'missing_variable_detection',
      source_run_ids: [],
      baseline_run_id: null,
      data_grade: 'NO_DATA',
      run_type: null,
      conclusion_status: 'INSUFFICIENT_DATA',
      delta_summary: {},
      blocked_reason: null,
      source_metadata: { ping: true },
    });
  }

  const pool = getPool();
  if (!pool) {
    return res.status(503).json({
      error: poolConfigHint || 'POSTGRES_URL or DATABASE_URL is not configured for lab bridge.',
    });
  }

  try {
    if (type === 'version_comparison') {
      // Read version_a / version_b from query string OR body (handles both GET and POST).
      const pick2 = (k) => {
        const v = req.query[k] ?? (req.body && req.body[k]);
        return v == null ? '' : String(v).trim();
      };
      const va_req   = pick2('version_a');
      const vb_req   = pick2('version_b');
      const base_req = pick2('base_id');
      // Always log incoming values so Vercel logs show exactly what arrived.
      console.error(`[lab/query] version_comparison: version_a="${va_req}" version_b="${vb_req}" base_id="${base_req}"`);

      // Deterministic short-circuit: same version vs itself → NO_CHANGE, no DB needed.
      if (va_req && vb_req && va_req.toLowerCase() === vb_req.toLowerCase()) {
        console.error(`[lab/query] NO_CHANGE short-circuit triggered`);
        return res.json({
          query_type: 'version_comparison',
          source_run_ids: [],
          baseline_run_id: null,
          data_grade: 'LOGICAL',
          run_type: null,
          conclusion_status: 'NO_CHANGE',
          delta_summary: {
            channels: [],
            max_delta_pct: 0,
            dominant_channel: null,
            ph_run: null,
            ph_baseline: null,
            ph_delta: null,
          },
          blocked_reason: null,
          source_metadata: { base_id: base_req, version_a: va_req, version_b: vb_req },
          detail: { note: 'version_a equals version_b — no change by definition.' },
        });
      }

      let client;
      try {
        client = await pool.connect();
      } catch (e) {
        const msg = e?.message || String(e);
        const hint =
          /invalid url/i.test(msg) || /invalid URL/i.test(msg)
            ? ' Usually DATABASE_URL uses a non-postgres scheme (e.g. neon://) or a broken string — set POSTGRES_URL to the Supabase/Postgres "URI" (postgres://…).'
            : '';
        console.error('[lab/query] pool.connect:', msg);
        return res.status(503).json({
          error: `Lab database connection failed: ${msg}.${hint}`,
        });
      }
      try {
        // Pass the already-trimmed values (same ones checked above) to avoid re-parsing differences.
        const body = await handleVersionComparison(client, base_req, va_req, vb_req);
        return res.json(body);
      } finally {
        client.release();
      }
    }

    // compare_latest_runs: auto-pick the 2 most recent formulation versions for a base and compare them.
    // Used by "compare runs BASE-XXX" natural-language queries where explicit version IDs are not supplied.
    if (type === 'compare_latest_runs') {
      const pick = (k) => {
        const v = req.query[k] ?? (req.body && req.body[k]);
        return v == null ? '' : String(v).trim();
      };
      const base_req = pick('base_id');
      if (!base_req) {
        return res.status(400).json({ error: 'compare_latest_runs requires base_id.' });
      }
      let client;
      try {
        client = await pool.connect();
      } catch (e) {
        const msg = e?.message || String(e);
        console.error('[lab/query] pool.connect:', msg);
        return res.status(503).json({ error: `Lab database connection failed: ${msg}.` });
      }
      try {
        const baseMatch = baseIdSqlMatch(1);
        // Get the 2 most recent formulation versions that have at least one production run.
        // Filter NULL versions — rows without a version string cannot be compared.
        const { rows: versions } = await client.query(
          `SELECT DISTINCT f.version
           FROM formulations f
           JOIN production_runs pr ON pr.formulation_id = f.id
           WHERE ${baseMatch}
             AND f.version IS NOT NULL
             AND f.version <> ''
           ORDER BY f.version DESC
           LIMIT 2`,
          [base_req]
        );
        if (versions.length < 2) {
          return res.json({
            ...emptyVersionComparison(
              `compare_latest_runs: fewer than 2 versions with runs found for base_id="${base_req}". ` +
              `Available: ${versions.map((v) => v.version).join(', ') || 'none'}`
            ),
            source_metadata: { base_id: base_req, auto_selected: true },
          });
        }
        // versions[0] is the newer, versions[1] is the older → version_a=older (baseline), version_b=newer (compare)
        const va = str(versions[1].version); // older = baseline
        const vb = str(versions[0].version); // newer = compare
        console.error(`[lab/query] compare_latest_runs: base_id="${base_req}" auto-selected version_a="${va}" version_b="${vb}"`);
        const body = await handleVersionComparison(client, base_req, va, vb);
        return res.json({ ...body, source_metadata: { ...body.source_metadata, auto_selected: true } });
      } finally {
        client.release();
      }
    }

    if (type === 'formulation_delta') {
      let client;
      try {
        client = await pool.connect();
      } catch (e) {
        const msg = e?.message || String(e);
        const hint =
          /invalid url/i.test(msg) || /invalid URL/i.test(msg)
            ? ' Usually DATABASE_URL uses a non-postgres scheme (e.g. neon://) or a broken string — set POSTGRES_URL to the Supabase/Postgres "URI" (postgres://…).'
            : '';
        console.error('[lab/query] pool.connect:', msg);
        return res.status(503).json({
          error: `Lab database connection failed: ${msg}.${hint}`,
        });
      }
      try {
        const body = await handleFormulationDelta(
          client,
          req.query.base_id,
          req.query.id_a,
          req.query.id_b
        );
        return res.json(body);
      } finally {
        client.release();
      }
    }

    return res.status(400).json({ error: `Unsupported lab query type: ${type}` });
  } catch (e) {
    console.error('[lab/query]', e);
    return res.status(500).json({ error: e.message || 'lab query failed' });
  }
}

/**
 * GET /api/lab/health
 * Verifies POSTGRES_URL is set and DB is reachable.
 * Returns { ok, db_status, hint? } — safe for public health-check polling.
 */
export async function labHealthHandler(req, res) {
  const raw = process.env.POSTGRES_URL || process.env.DATABASE_URL || '';
  if (!raw) {
    return res.status(503).json({
      ok: false,
      db_status: 'not_configured',
      hint: 'POSTGRES_URL (or DATABASE_URL) is not set. Go to Vercel → managment-back project → Environment Variables and add POSTGRES_URL = postgresql://... (Supabase URI).',
    });
  }

  const pool = getPool();
  if (!pool) {
    return res.status(503).json({
      ok: false,
      db_status: 'invalid_url',
      hint: poolConfigHint || 'POSTGRES_URL scheme is not postgres:// or postgresql://. Copy the "URI" from Supabase → Project Settings → Database.',
    });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query('SELECT 1');
    return res.json({ ok: true, db_status: 'connected' });
  } catch (e) {
    const msg = e?.message || String(e);
    return res.status(503).json({
      ok: false,
      db_status: 'connection_failed',
      error: msg,
      hint: /password authentication/i.test(msg)
        ? 'Wrong password in POSTGRES_URL. Reset it in Supabase → Project Settings → Database → Reset password.'
        : /ENOTFOUND|ETIMEDOUT/i.test(msg)
        ? 'Host not reachable. Use the Supabase Transaction Pooler URI (port 6543), not the direct connection (port 5432) — Vercel blocks direct Supabase connections.'
        : 'Check POSTGRES_URL in Vercel env vars. Must be postgresql://[user]:[password]@[host]:[port]/[db]?sslmode=require',
    });
  } finally {
    client?.release();
  }
}
