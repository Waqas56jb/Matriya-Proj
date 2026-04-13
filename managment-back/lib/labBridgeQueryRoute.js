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
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  if (!s) return null;
  const scheme = s.split(':', 1)[0].toLowerCase();
  if (scheme !== 'postgres' && scheme !== 'postgresql') {
    poolConfigHint =
      `Lab bridge needs POSTGRES_URL (or DATABASE_URL) as postgres://… or postgresql://… (node-pg). ` +
      `Current scheme "${scheme || '(empty)'}" is not supported. ` +
      `Copy the "URI" connection string from Supabase (or Neon "connection string" for psql), not the serverless/neon driver URL.`;
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
  const delta_pct = Math.round(((r - b) / b) * 1e4) / 1e4;
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
        const body = await handleVersionComparison(
          client,
          req.query.base_id,
          req.query.version_a,
          req.query.version_b
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
