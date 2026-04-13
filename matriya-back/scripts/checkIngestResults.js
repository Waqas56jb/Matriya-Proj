/**
 * Quick check of what was written to DB after ingest.
 */
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.POSTGRES_URL, ssl: { rejectUnauthorized: false } });
const client = await pool.connect();

const tables = ['formulations','formulation_materials','production_runs','production_steps','measurements','outcomes','ingest_quarantine'];
console.log('\n=== DB Row Counts ===');
for (const t of tables) {
  const { rows } = await client.query(`SELECT COUNT(*) AS n FROM ${t}`);
  console.log(`  ${t.padEnd(28)} : ${rows[0].n}`);
}

// Check outcomes column names
const { rows: outcCols } = await client.query(`
  SELECT column_name FROM information_schema.columns
  WHERE table_name='outcomes' ORDER BY ordinal_position
`);
console.log('\noutcomes columns:', outcCols.map(c=>c.column_name).join(', '));

// Show measurements with formulation chain (dynamic join based on actual schema)
console.log('\n=== Measurements (full chain) ===');
const { rows: meas } = await client.query(`
  SELECT
    f.source_id        AS formulation,
    f.base_id,
    f.version,
    pr.batch_id,
    m.test_date,
    m.linkage_confidence,
    pr.batch_id_is_synthetic
  FROM measurements m
  JOIN production_runs pr ON pr.id = m.production_run_id
  JOIN formulations f ON f.id = pr.formulation_id
  ORDER BY f.base_id, f.version, m.test_date
`);
for (const r of meas) {
  const date = r.test_date instanceof Date ? r.test_date.toISOString().slice(0,10) : String(r.test_date).slice(0,10);
  console.log(`  ${r.formulation.padEnd(22)} base=${r.base_id} ver=${r.version ?? 'root'} date=${date}  conf=${r.linkage_confidence}  synthetic=${r.batch_id_is_synthetic}`);
}

// Show quarantine
console.log('\n=== Quarantine ===');
const { rows: q } = await client.query('SELECT raw_source_id, test_date, reason FROM ingest_quarantine');
if (q.length === 0) {
  console.log('  (empty)');
} else {
  for (const r of q) {
    console.log(`  source="${r.raw_source_id}"  date="${r.test_date}"  reason: ${r.reason}`);
  }
}

client.release();
await pool.end();
