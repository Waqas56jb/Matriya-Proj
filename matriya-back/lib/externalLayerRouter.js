/**
 * External Layer Phase 1 — read-only HTTP context API.
 *
 * Governance (David):
 *   - Context only, not evidence; no causal conclusions from these rows.
 *   - Must not affect lab conclusion_status (no writes to lab tables; no routes here mutate science).
 *   - Every listed row includes full_provenance (or provenance_stub on sources).
 *
 * Isolation (David 2026-04-12): External data MUST stay out of scientific decision
 * logic. This router is NOT imported from researchGate, lab bridge, FSCTM, or
 * kernel paths. Any future wiring that lets external context upgrade
 * INCONCLUSIVE → VALID_CONCLUSION or alter conclusion_status is a SYSTEM ERROR
 * (CI: scripts/verifyExternalLayerIsolation.js).
 *
 * Base path: /api/external/v1
 */
import express from 'express';
import { getExternalLayerPool, getExternalLayerConnectionString } from './externalLayerPool.js';

const GOVERNANCE = {
  layer: 'external_phase_1',
  context_only: true,
  not_evidence: true,
  does_not_affect_conclusion_status: true,
  no_causal_conclusions_from_external: true,
  cannot_upgrade_inconclusive_to_valid: true,
  fsctm_uses_internal_real_data_only: true,
  isolation_violation_is_system_error: true,
  full_provenance_required: true,
  api_writes: 'none_public',
};

export const externalLayerRouter = express.Router();

function governanceHeaders(res) {
  res.setHeader('X-External-Layer', 'context-only');
  res.setHeader('X-External-Layer-Governance', 'no-conclusions-from-external;provenance-required');
}

function envelope(data, extra = {}) {
  return {
    governance: GOVERNANCE,
    ...extra,
    data,
  };
}

function parseLimit(raw, def = 50, max = 200) {
  const n = parseInt(String(raw || def), 10);
  if (Number.isNaN(n) || n < 1) return def;
  return Math.min(n, max);
}

function poolOr503(req, res) {
  const pool = getExternalLayerPool();
  if (!pool) {
    res.status(503).json({
      error: 'EXTERNAL_LAYER_DB_UNAVAILABLE',
      message: 'Set EXTERNAL_LAYER_POSTGRES_URL or POSTGRES_URL to enable External Layer.',
    });
    return null;
  }
  governanceHeaders(res);
  return pool;
}

externalLayerRouter.get('/governance', (req, res) => {
  governanceHeaders(res);
  res.status(200).json({
    governance: GOVERNANCE,
    connection_configured: Boolean(getExternalLayerConnectionString()),
    endpoints: [
      'GET /api/external/v1/sources',
      'GET /api/external/v1/documents',
      'GET /api/external/v1/claims',
      'GET /api/external/v1/climate',
      'GET /api/external/v1/patents',
      'GET /api/external/v1/freshness',
    ],
    note: 'No POST/PUT/PATCH on this router. Freshness is updated by scripts/externalLayerFreshnessCron.js only.',
  });
});

externalLayerRouter.get('/sources', async (req, res) => {
  const pool = poolOr503(req, res);
  if (!pool) return;
  const limit = parseLimit(req.query.limit);
  const offset = parseInt(String(req.query.offset || 0), 10) || 0;
  const type = req.query.source_type ? String(req.query.source_type) : null;
  try {
    const params = [limit, offset];
    let where = '';
    if (type) {
      params.push(type);
      where = `WHERE source_type = $3`;
    }
    const { rows } = await pool.query(
      `SELECT id, source_type, code, display_name, authority_uri, notes, stale_after_hours,
              last_freshness_check_at, freshness_status, provenance_stub, created_at
       FROM external_ctx.source_registry ${where}
       ORDER BY code ASC LIMIT $1 OFFSET $2`,
      type ? [limit, offset, type] : [limit, offset]
    );
    res.json(envelope(rows, { collection: 'sources' }));
  } catch (e) {
    if (e.code === '42P01') {
      res.status(503).json({ error: 'EXTERNAL_LAYER_SCHEMA_MISSING', message: 'Apply sql/external_layer_phase1.sql' });
      return;
    }
    res.status(500).json({ error: e.message });
  }
});

externalLayerRouter.get('/documents', async (req, res) => {
  const pool = poolOr503(req, res);
  if (!pool) return;
  const limit = parseLimit(req.query.limit);
  const offset = parseInt(String(req.query.offset || 0), 10) || 0;
  try {
    const { rows } = await pool.query(
      `SELECT d.id, d.source_id, d.title, d.document_kind, d.canonical_uri, d.retrieved_at,
              d.content_fingerprint, d.full_provenance, d.last_freshness_check_at, d.freshness_status, d.created_at,
              s.code AS source_code, s.display_name AS source_display_name
       FROM external_ctx.external_document d
       JOIN external_ctx.source_registry s ON s.id = d.source_id
       ORDER BY d.retrieved_at DESC NULLS LAST
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json(envelope(rows, { collection: 'documents' }));
  } catch (e) {
    if (e.code === '42P01') {
      res.status(503).json({ error: 'EXTERNAL_LAYER_SCHEMA_MISSING', message: 'Apply sql/external_layer_phase1.sql' });
      return;
    }
    res.status(500).json({ error: e.message });
  }
});

externalLayerRouter.get('/claims', async (req, res) => {
  const pool = poolOr503(req, res);
  if (!pool) return;
  const limit = parseLimit(req.query.limit);
  const offset = parseInt(String(req.query.offset || 0), 10) || 0;
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.source_id, c.document_id, c.claim_domain, c.claim_text, c.qualifier,
              c.full_provenance, c.retrieved_at, c.last_freshness_check_at, c.freshness_status, c.created_at,
              s.code AS source_code
       FROM external_ctx.external_claim c
       JOIN external_ctx.source_registry s ON s.id = c.source_id
       ORDER BY c.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json(envelope(rows, { collection: 'claims' }));
  } catch (e) {
    if (e.code === '42P01') {
      res.status(503).json({ error: 'EXTERNAL_LAYER_SCHEMA_MISSING', message: 'Apply sql/external_layer_phase1.sql' });
      return;
    }
    res.status(500).json({ error: e.message });
  }
});

externalLayerRouter.get('/climate', async (req, res) => {
  const pool = poolOr503(req, res);
  if (!pool) return;
  const limit = parseLimit(req.query.limit);
  const offset = parseInt(String(req.query.offset || 0), 10) || 0;
  const region = req.query.region_code ? String(req.query.region_code) : null;
  try {
    const params = region ? [limit, offset, region] : [limit, offset];
    const where = region ? 'WHERE region_code = $3' : '';
    const { rows } = await pool.query(
      `SELECT cl.id, cl.source_id, cl.region_code, cl.metric_name, cl.value_numeric, cl.value_text, cl.unit,
              cl.period_start, cl.period_end, cl.full_provenance, cl.retrieved_at,
              cl.last_freshness_check_at, cl.freshness_status, cl.created_at,
              s.code AS source_code
       FROM external_ctx.climate_snapshot cl
       JOIN external_ctx.source_registry s ON s.id = cl.source_id
       ${where}
       ORDER BY cl.region_code, cl.metric_name
       LIMIT $1 OFFSET $2`,
      params
    );
    res.json(envelope(rows, { collection: 'climate' }));
  } catch (e) {
    if (e.code === '42P01') {
      res.status(503).json({ error: 'EXTERNAL_LAYER_SCHEMA_MISSING', message: 'Apply sql/external_layer_phase1.sql' });
      return;
    }
    res.status(500).json({ error: e.message });
  }
});

externalLayerRouter.get('/patents', async (req, res) => {
  const pool = poolOr503(req, res);
  if (!pool) return;
  const limit = parseLimit(req.query.limit);
  const offset = parseInt(String(req.query.offset || 0), 10) || 0;
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.source_id, p.publication_number, p.title, p.abstract_excerpt, p.assignee,
              p.full_provenance, p.retrieved_at, p.last_freshness_check_at, p.freshness_status, p.created_at,
              s.code AS source_code
       FROM external_ctx.patent_reference p
       JOIN external_ctx.source_registry s ON s.id = p.source_id
       ORDER BY p.publication_number
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json(envelope(rows, { collection: 'patents' }));
  } catch (e) {
    if (e.code === '42P01') {
      res.status(503).json({ error: 'EXTERNAL_LAYER_SCHEMA_MISSING', message: 'Apply sql/external_layer_phase1.sql' });
      return;
    }
    res.status(500).json({ error: e.message });
  }
});

externalLayerRouter.get('/freshness', async (req, res) => {
  const pool = poolOr503(req, res);
  if (!pool) return;
  try {
    const [{ rows: jobs }, { rows: countRows }] = await Promise.all([
      pool.query(
        `SELECT id, job_type, started_at, finished_at, status, documents_updated, claims_updated,
                climate_updated, patents_updated, sources_updated, error_message
         FROM external_ctx.freshness_job
         ORDER BY started_at DESC
         LIMIT 20`
      ),
      pool.query(`
        SELECT
          (SELECT count(*)::int FROM external_ctx.source_registry) AS sources,
          (SELECT count(*)::int FROM external_ctx.external_document) AS documents,
          (SELECT count(*)::int FROM external_ctx.external_claim) AS claims,
          (SELECT count(*)::int FROM external_ctx.climate_snapshot) AS climate_rows,
          (SELECT count(*)::int FROM external_ctx.patent_reference) AS patents,
          (SELECT count(*)::int FROM external_ctx.standard_publication) AS standards,
          (SELECT count(*)::int FROM external_ctx.supplier_catalog_item) AS suppliers
      `),
    ]);
    res.json(
      envelope(
        { row_counts: countRows[0] || {}, recent_jobs: jobs },
        { collection: 'freshness' }
      )
    );
  } catch (e) {
    if (e.code === '42P01') {
      res.status(503).json({ error: 'EXTERNAL_LAYER_SCHEMA_MISSING', message: 'Apply sql/external_layer_phase1.sql' });
      return;
    }
    res.status(500).json({ error: e.message });
  }
});

/** Optional: log once at startup */
export function initExternalLayerFromEnv(log) {
  if (getExternalLayerConnectionString()) {
    log?.info?.('External Layer: Postgres URL configured (schema external_ctx).');
  } else {
    log?.warn?.('External Layer: no Postgres URL — /api/external/v1 will return 503 until configured.');
  }
}
