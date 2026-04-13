#!/usr/bin/env node
/**
 * External Layer — freshness tick (cron-safe).
 *
 * Updates last_freshness_check_at and freshness_status on external_ctx rows
 * based on retrieved_at vs source stale_after_hours. Logs a row in freshness_job.
 *
 * Does NOT touch lab tables (production_runs, outcomes, conclusion_status, etc.).
 *
 * Usage (e.g. crontab every 6 hours):
 *   node --env-file=.env scripts/externalLayerFreshnessCron.js
 */

import 'dotenv/config';
import pg from 'pg';

function connStr() {
  return (
    process.env.EXTERNAL_LAYER_POSTGRES_URL ||
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL ||
    ''
  ).trim();
}

async function main() {
  const cs = connStr();
  if (!cs) {
    console.error('No POSTGRES_URL / EXTERNAL_LAYER_POSTGRES_URL');
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: cs, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  let jobId = null;
  try {
    const { rows: [job] } = await client.query(
      `INSERT INTO external_ctx.freshness_job (job_type, status) VALUES ('scheduled_tick', 'RUNNING')
       RETURNING id`
    );
    jobId = job.id;

    // Sources: no retrieved_at column — age from created_at vs stale_after_hours
    const srcUpd = await client.query(`
      UPDATE external_ctx.source_registry SET
        last_freshness_check_at = now(),
        freshness_status = CASE
          WHEN now() - created_at > stale_after_hours * interval '1 hour' THEN 'STALE'
          ELSE 'FRESH'
        END
    `);

    const d = await client.query(`
      UPDATE external_ctx.external_document SET
        last_freshness_check_at = now(),
        freshness_status = CASE
          WHEN now() - retrieved_at > (SELECT sr.stale_after_hours * interval '1 hour' FROM external_ctx.source_registry sr WHERE sr.id = source_id) THEN 'STALE'
          ELSE 'FRESH'
        END
    `);

    const c = await client.query(`
      UPDATE external_ctx.external_claim SET
        last_freshness_check_at = now(),
        freshness_status = CASE
          WHEN now() - retrieved_at > (SELECT sr.stale_after_hours * interval '1 hour' FROM external_ctx.source_registry sr WHERE sr.id = source_id) THEN 'STALE'
          ELSE 'FRESH'
        END
    `);

    const cl = await client.query(`
      UPDATE external_ctx.climate_snapshot SET
        last_freshness_check_at = now(),
        freshness_status = CASE
          WHEN now() - retrieved_at > (SELECT sr.stale_after_hours * interval '1 hour' FROM external_ctx.source_registry sr WHERE sr.id = source_id) THEN 'STALE'
          ELSE 'FRESH'
        END
    `);

    const p = await client.query(`
      UPDATE external_ctx.patent_reference SET
        last_freshness_check_at = now(),
        freshness_status = CASE
          WHEN now() - retrieved_at > (SELECT sr.stale_after_hours * interval '1 hour' FROM external_ctx.source_registry sr WHERE sr.id = source_id) THEN 'STALE'
          ELSE 'FRESH'
        END
    `);

    const std = await client.query(`
      UPDATE external_ctx.standard_publication SET
        last_freshness_check_at = now(),
        freshness_status = CASE
          WHEN now() - retrieved_at > (SELECT sr.stale_after_hours * interval '1 hour' FROM external_ctx.source_registry sr WHERE sr.id = source_id) THEN 'STALE'
          ELSE 'FRESH'
        END
    `);
    const sup = await client.query(`
      UPDATE external_ctx.supplier_catalog_item SET
        last_freshness_check_at = now(),
        freshness_status = CASE
          WHEN now() - retrieved_at > (SELECT sr.stale_after_hours * interval '1 hour' FROM external_ctx.source_registry sr WHERE sr.id = source_id) THEN 'STALE'
          ELSE 'FRESH'
        END
    `);

    await client.query(
      `UPDATE external_ctx.freshness_job SET
        finished_at = now(),
        status = 'SUCCESS',
        documents_updated = $1,
        claims_updated = $2,
        climate_updated = $3,
        patents_updated = $4,
        sources_updated = $5,
        standards_updated = $6,
        suppliers_updated = $7
       WHERE id = $8`,
      [d.rowCount, c.rowCount, cl.rowCount, p.rowCount, srcUpd.rowCount, std.rowCount, sup.rowCount, jobId]
    );

    console.log('[OK] Freshness tick', {
      documents: d.rowCount,
      claims: c.rowCount,
      climate: cl.rowCount,
      patents: p.rowCount,
      sources: srcUpd.rowCount,
      standards: std.rowCount,
      suppliers: sup.rowCount,
      job_id: jobId,
    });
  } catch (e) {
    if (jobId) {
      await client.query(
        `UPDATE external_ctx.freshness_job SET finished_at = now(), status = 'FAILED', error_message = $1 WHERE id = $2`,
        [e.message, jobId]
      );
    }
    console.error('[FAIL]', e.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
