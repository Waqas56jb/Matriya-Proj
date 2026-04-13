import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.POSTGRES_URL, ssl: { rejectUnauthorized: false } });
const client = await pool.connect();

// Show all tables
const { rows: tables } = await client.query(`
  SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename
`);
console.log('\nAll tables:', tables.map(r=>r.tablename).join(', '));

// Show formulations columns
const { rows: cols } = await client.query(`
  SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='formulations'
  ORDER BY ordinal_position
`);
console.log('\nformulations columns:');
for (const c of cols) {
  console.log(' ', c.column_name.padEnd(25), c.data_type.padEnd(20), 'nullable='+c.is_nullable);
}

// Count rows in formulations
const { rows: cnt } = await client.query('SELECT COUNT(*) FROM formulations');
console.log('\nformulations row count:', cnt[0].count);

client.release();
await pool.end();
