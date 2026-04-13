#!/usr/bin/env node
/**
 * External Layer Phase 1 — PASS criteria (David).
 *
 * 1) All tables exist (external_ctx.*)
 * 2) GET endpoints return 200 (MATRIYA_BASE_URL or BASE_URL, default 127.0.0.1:8000)
 * 3) Freshness cron updates freshness_job + row last_freshness_check_at (optional if DB URL set)
 * 4) No path here mutates conclusion_status (assertion: grep / manual — external router is GET-only)
 *
 * Usage:
 *   node --env-file=.env scripts/verifyExternalLayerPhase1.js
 *   BASE_URL=http://127.0.0.1:8000 node scripts/verifyExternalLayerPhase1.js --no-cron
 */

import 'dotenv/config';
import pg from 'pg';
import axios from 'axios';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const BASE = (process.env.MATRIYA_BASE_URL || process.env.BASE_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
const SKIP_CRON = process.argv.includes('--no-cron');

const TABLES = [
  'external_ctx.freshness_job',
  'external_ctx.source_registry',
  'external_ctx.external_document',
  'external_ctx.external_claim',
  'external_ctx.climate_snapshot',
  'external_ctx.patent_reference',
  'external_ctx.standard_publication',
  'external_ctx.supplier_catalog_item',
];

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
    console.error('[FAIL] No POSTGRES_URL for schema checks');
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: cs, ssl: { rejectUnauthorized: false } });

  for (const t of TABLES) {
    const { rows } = await pool.query(`SELECT to_regclass($1) AS c`, [t]);
    if (!rows[0]?.c) {
      console.error(`[FAIL] Missing table ${t} — run sql/external_layer_phase1.sql`);
      await pool.end();
      process.exit(2);
    }
  }
  console.log('[PASS] All external_ctx tables present:', TABLES.length);

  const paths = [
    '/api/external/v1/governance',
    '/api/external/v1/sources',
    '/api/external/v1/documents',
    '/api/external/v1/claims',
    '/api/external/v1/climate',
    '/api/external/v1/patents',
    '/api/external/v1/freshness',
  ];
  for (const p of paths) {
    const url = `${BASE}${p}`;
    const { status, data } = await axios.get(url, { timeout: 30000, validateStatus: () => true });
    if (status !== 200) {
      console.error(`[FAIL] ${p} HTTP ${status}`, typeof data === 'object' ? JSON.stringify(data).slice(0, 400) : data);
      await pool.end();
      process.exit(3);
    }
    const ctxOnly =
      data?.governance?.context_only === true ||
      data?.context_only === true;
    if (!ctxOnly) {
      console.warn(`[WARN] ${p} missing governance.context_only in JSON`);
    }
  }
  console.log('[PASS] All GET endpoints HTTP 200:', paths.length);

  if (!SKIP_CRON) {
    const envFile = path.join(ROOT, '.env');
    const cronScript = path.join(ROOT, 'scripts', 'externalLayerFreshnessCron.js');
    const spawnArgs = fs.existsSync(envFile) ? ['--env-file=' + envFile, cronScript] : [cronScript];
    const r = spawnSync(process.execPath, spawnArgs, {
      cwd: ROOT,
      env: process.env,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    if (r.status !== 0) {
      console.error('[FAIL] externalLayerFreshnessCron.js', r.stderr || r.stdout);
      await pool.end();
      process.exit(4);
    }
    const { rows } = await pool.query(
      `SELECT status, documents_updated, sources_updated FROM external_ctx.freshness_job ORDER BY started_at DESC LIMIT 1`
    );
    if (!rows[0] || rows[0].status !== 'SUCCESS') {
      console.error('[FAIL] freshness_job last row not SUCCESS', rows[0]);
      await pool.end();
      process.exit(5);
    }
    console.log('[PASS] Freshness cron SUCCESS', rows[0]);
  } else {
    console.log('[SKIP] --no-cron: not running freshness script');
  }

  await pool.end();
  console.log('\n=== External Layer Phase 1 verification: PASS ===\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(99);
});
