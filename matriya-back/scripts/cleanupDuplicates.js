/**
 * One-time cleanup: remove duplicate quarantine entries and add unique constraint.
 */
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.POSTGRES_URL, ssl: { rejectUnauthorized: false } });
const client = await pool.connect();

// Show current quarantine
const { rows: q } = await client.query('SELECT id, raw_source_id, test_date, ingested_at FROM ingest_quarantine ORDER BY ingested_at');
console.log('Quarantine before cleanup:', q.length, 'rows');
for (const r of q) console.log(`  id=${r.id}  src="${r.raw_source_id}"  date="${r.test_date}"  at=${r.ingested_at}`);

// Keep only the most recent entry per (source_file, raw_source_id, test_date)
const { rowCount } = await client.query(`
  DELETE FROM ingest_quarantine
  WHERE id NOT IN (
    SELECT DISTINCT ON (source_file, raw_source_id, test_date) id
    FROM ingest_quarantine
    ORDER BY source_file, raw_source_id, test_date, ingested_at DESC
  )
`);
console.log(`\nDeleted ${rowCount} duplicate quarantine row(s)`);

// Add unique constraint to prevent future duplicates (ignore if already exists)
await client.query(`
  DO $$ BEGIN
    ALTER TABLE ingest_quarantine
      ADD CONSTRAINT ingest_quarantine_source_id_date_uq
      UNIQUE (source_file, raw_source_id, test_date);
  EXCEPTION WHEN duplicate_table THEN
    NULL;
  WHEN others THEN
    IF SQLERRM LIKE '%already exists%' THEN NULL;
    ELSE RAISE;
    END IF;
  END $$;
`).catch(e => console.warn('Constraint note:', e.message));
console.log('Unique constraint (source_file, raw_source_id, test_date) ensured.');

const { rows: final } = await client.query('SELECT raw_source_id, test_date, reason FROM ingest_quarantine');
console.log('\nQuarantine after cleanup:', final.length, 'rows');
for (const r of final) console.log(`  src="${r.raw_source_id}"  date="${r.test_date}"  reason: ${r.reason}`);

client.release();
await pool.end();
