/**
 * PostgreSQL pool for External Layer Phase 1 (schema external_ctx).
 * Uses EXTERNAL_LAYER_POSTGRES_URL if set, else POSTGRES_URL / DATABASE_URL / SUPABASE_DB_URL.
 * Read-only API routes use this pool — never UPDATE lab outcomes / conclusion fields.
 */
import pg from 'pg';

let _pool = null;

export function getExternalLayerConnectionString() {
  return (
    process.env.EXTERNAL_LAYER_POSTGRES_URL ||
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.SUPABASE_DB_URL ||
    ''
  ).trim();
}

export function getExternalLayerPool() {
  const conn = getExternalLayerConnectionString();
  if (!conn) return null;
  if (!_pool) {
    _pool = new pg.Pool({
      connectionString: conn,
      max: 3,
      idleTimeoutMillis: 20000,
      ssl: { rejectUnauthorized: false },
    });
  }
  return _pool;
}

export async function closeExternalLayerPool() {
  if (_pool) {
    await _pool.end().catch(() => {});
    _pool = null;
  }
}
