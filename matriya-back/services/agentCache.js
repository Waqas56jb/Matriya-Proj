/**
 * agentCache.js
 *
 * Hash-based cache stored in Supabase table `agent_cache`.
 *
 * Table DDL (run once in Supabase SQL editor):
 * ─────────────────────────────────────────────
 * CREATE TABLE IF NOT EXISTS agent_cache (
 *   key         TEXT PRIMARY KEY,
 *   value       JSONB NOT NULL,
 *   agent_name  TEXT NOT NULL,
 *   expires_at  TIMESTAMPTZ NOT NULL,
 *   created_at  TIMESTAMPTZ DEFAULT NOW()
 * );
 * CREATE INDEX IF NOT EXISTS idx_agent_cache_expires ON agent_cache (expires_at);
 * ─────────────────────────────────────────────
 *
 * TTL defaults:
 *   Consilium    → 1 hour
 *   Night Agent  → 24 hours
 *   default      → 1 hour
 */

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const TABLE = 'agent_cache';

/** Lazy singleton — only created on first use so missing env vars don't crash startup. */
let _supabase = null;
function getSupabase() {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_KEY are required for agentCache');
  _supabase = createClient(url, key);
  return _supabase;
}

/** TTL in milliseconds per agent type */
const TTL_MS = {
  consilium:   1  * 60 * 60 * 1000,  // 1 hour
  night_agent: 24 * 60 * 60 * 1000,  // 24 hours
};

/**
 * Resolve TTL for a given agent name.
 * @param {string} agent_name
 * @returns {number} milliseconds
 */
function resolveTtl(agent_name) {
  const key = (agent_name || '').toLowerCase().replace(/[\s-]/g, '_');
  return TTL_MS[key] ?? TTL_MS.consilium;
}

/**
 * Compute cache key: SHA-256 of (input + agent_name), hex-truncated to 64 chars.
 * @param {string|object} input
 * @param {string} agent_name
 * @returns {string}
 */
function buildKey(input, agent_name) {
  const raw = JSON.stringify(input) + '|' + (agent_name || '');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Read a cached value. Returns null if missing or expired.
 * @param {string|object} input
 * @param {string} agent_name
 * @returns {Promise<any|null>}
 */
async function get(input, agent_name) {
  const key = buildKey(input, agent_name);
  const sb = getSupabase();
  const { data, error } = await sb
    .from(TABLE)
    .select('value, expires_at')
    .eq('key', key)
    .maybeSingle();

  if (error || !data) return null;

  if (new Date(data.expires_at) <= new Date()) {
    await sb.from(TABLE).delete().eq('key', key);
    return null;
  }

  return data.value;
}

/**
 * Write a value to the cache (upsert).
 * @param {string|object} input
 * @param {string} agent_name
 * @param {any} value  — must be JSON-serialisable
 * @returns {Promise<{ key: string, expires_at: string }>}
 */
async function set(input, agent_name, value) {
  const key = buildKey(input, agent_name);
  const ttl = resolveTtl(agent_name);
  const expires_at = new Date(Date.now() + ttl).toISOString();

  const { error } = await getSupabase().from(TABLE).upsert(
    { key, value, agent_name: agent_name || 'unknown', expires_at },
    { onConflict: 'key' }
  );

  if (error) throw new Error(`agentCache.set failed: ${error.message}`);
  return { key, expires_at };
}

/**
 * Convenience wrapper: return cached result if available, otherwise run fn() and cache it.
 * @param {string|object} input
 * @param {string} agent_name
 * @param {Function} fn  — async function that produces the value
 * @returns {Promise<{ result: any, cached: boolean }>}
 */
async function getOrCompute(input, agent_name, fn) {
  const cached = await get(input, agent_name);
  if (cached !== null) {
    return { result: cached, cached: true };
  }
  const result = await fn();
  await set(input, agent_name, result);
  return { result, cached: false };
}

/**
 * Explicitly delete a cached entry.
 * @param {string|object} input
 * @param {string} agent_name
 */
async function invalidate(input, agent_name) {
  const key = buildKey(input, agent_name);
  await getSupabase().from(TABLE).delete().eq('key', key);
}

/**
 * Purge all expired entries (run periodically if needed).
 * @returns {Promise<number>} count of deleted rows
 */
async function purgeExpired() {
  const { data, error } = await getSupabase()
    .from(TABLE)
    .delete()
    .lt('expires_at', new Date().toISOString())
    .select('key');

  if (error) throw new Error(`agentCache.purgeExpired failed: ${error.message}`);
  return (data || []).length;
}

export { get, set, getOrCompute, invalidate, purgeExpired, buildKey, resolveTtl, TTL_MS };
