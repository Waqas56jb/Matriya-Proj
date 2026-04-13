/**
 * Applies the lab chain schema and migration v2 to the database.
 * Safe to run multiple times (uses IF NOT EXISTS / ALTER IF NOT EXISTS).
 *
 * Order:
 *   1. sql/lab_chain_schema.sql   — full CREATE TABLE statements
 *   2. sql/lab_chain_schema_migration_v2.sql — ADD COLUMN (idempotent)
 *
 * Usage: node scripts/applySchema.js
 */

import pg from 'pg';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  const client = await pool.connect();
  try {
    console.log('\n=== Applying lab chain schema ===\n');

    // Check existing tables
    const { rows: existing } = await client.query(`
      SELECT tablename FROM pg_tables
      WHERE schemaname='public'
        AND tablename IN (
          'formulations','formulation_materials','production_runs',
          'production_steps','measurements','outcomes','ingest_quarantine'
        )
      ORDER BY tablename
    `);
    console.log('Existing lab tables before apply:', existing.map(r => r.tablename));

    // Drop the old RAG-era formulations table if it has the old schema
    // (detected by presence of document_id column — not part of lab chain schema)
    const { rows: oldCols } = await client.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='formulations'
        AND column_name='document_id'
      LIMIT 1
    `);
    if (oldCols.length > 0) {
      console.log('\n  Detected old RAG formulations table (has document_id). Dropping...');
      await client.query('DROP TABLE IF EXISTS formulations CASCADE');
      console.log('  ✓ Old formulations table dropped (0 rows, schema mismatch)');
    }

    // Apply main schema
    const schemaSQL = fs.readFileSync(
      path.join(__dirname, '../sql/lab_chain_schema.sql'), 'utf8'
    );
    console.log('\n[1] Applying sql/lab_chain_schema.sql ...');
    await client.query(schemaSQL);
    console.log('    ✓ Done');

    // Apply migration v2
    const migrationSQL = fs.readFileSync(
      path.join(__dirname, '../sql/lab_chain_schema_migration_v2.sql'), 'utf8'
    );
    console.log('\n[2] Applying sql/lab_chain_schema_migration_v2.sql ...');
    await client.query(migrationSQL);
    console.log('    ✓ Done');

    // Verify final state
    const { rows: final } = await client.query(`
      SELECT tablename FROM pg_tables
      WHERE schemaname='public'
        AND tablename IN (
          'formulations','formulation_materials','production_runs',
          'production_steps','measurements','outcomes','ingest_quarantine'
        )
      ORDER BY tablename
    `);
    console.log('\nTables after apply:', final.map(r => r.tablename));

    // Verify new columns exist
    const { rows: cols } = await client.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'formulations'
        AND column_name IN ('composition_scale','id_suffix','raw_source_id','source_id')
      ORDER BY column_name
    `);
    console.log('\nformulations columns (key fields):');
    for (const c of cols) {
      console.log(`  ${c.column_name.padEnd(20)} ${c.data_type.padEnd(15)} nullable=${c.is_nullable} default=${c.column_default || 'none'}`);
    }

    // Apply migration v3 (FSCTM + workflow + operator + capacity fields)
    const migV3SQL = fs.readFileSync(
      path.join(__dirname, '../sql/lab_chain_schema_migration_v3.sql'), 'utf8'
    );
    console.log('\n[3] Applying sql/lab_chain_schema_migration_v3.sql ...');
    await client.query(migV3SQL);
    console.log('    ✓ Done');

    // Verify v3 columns
    const { rows: v3cols } = await client.query(`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE (table_name = 'production_runs'
             AND column_name IN ('operator_name','prep_location','workflow_state',
                                 'baseline_run_id','declared_changed_variable',
                                 'run_type','load_type','load_conditions'))
         OR (table_name = 'outcomes'
             AND column_name IN ('capacity_ratings','failure_signature',
                                 'stability_classification','mechanism_tag','conclusion_status'))
         OR (table_name = 'formulation_materials'
             AND column_name = 'recommended_material')
      ORDER BY table_name, column_name
    `);
    console.log('\nv3 columns verified:');
    for (const c of v3cols) {
      console.log(`  ${c.table_name}.${c.column_name.padEnd(28)} ${c.data_type}`);
    }

    console.log('\n✓ Schema ready.\n');
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});
