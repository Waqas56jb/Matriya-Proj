#!/usr/bin/env node
/**
 * Apply sql/external_layer_phase1.sql and optional seed to Postgres.
 * Usage: node --env-file=.env scripts/applyExternalLayerPhase1.js [--seed]
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function connStr() {
  return (
    process.env.EXTERNAL_LAYER_POSTGRES_URL ||
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL ||
    ''
  ).trim();
}

async function runFile(client, relPath) {
  const p = path.join(ROOT, relPath);
  const sql = fs.readFileSync(p, 'utf8');
  await client.query(sql);
  console.log('[OK] Applied', relPath);
}

async function main() {
  const cs = connStr();
  if (!cs) {
    console.error('Set POSTGRES_URL or EXTERNAL_LAYER_POSTGRES_URL');
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: cs, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  try {
    await runFile(client, 'sql/external_layer_phase1.sql');
    await runFile(client, 'sql/external_layer_phase1b_tables_7_8.sql');
    if (process.argv.includes('--seed')) {
      await runFile(client, 'sql/external_layer_phase1_seed.sql');
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error('[FAIL]', e.message);
  process.exit(1);
});
