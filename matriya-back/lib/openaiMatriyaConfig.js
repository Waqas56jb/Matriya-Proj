/**
 * Matriya OpenAI File Search: env + persisted vector store id (after first sync).
 * On Vercel, filesystem under the project is not durable; we also store the id in Postgres (matriya_app_kv).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import settings from '../config.js';
import { MatriyaAppKv, sequelize, initDb } from '../database.js';

const STORE_FILE = '.matriya_openai_vector_store_id';
const KV_KEY = 'openai_vector_store_id';
/** JSON map: logical filename → { file_id, fp } (sha256 hex) for incremental OpenAI sync */
const SYNC_FILE_MAP_KEY = 'openai_vector_file_map_v1';

/** In-memory cache after DB hydrate or persist (same serverless instance). */
let memoryVectorStoreId = null;

export function getMatriyaOpenAiVectorStoreId() {
  const fromEnv = process.env.MATRIYA_OPENAI_VECTOR_STORE_ID?.trim();
  if (fromEnv) return fromEnv;
  if (memoryVectorStoreId) return memoryVectorStoreId;
  try {
    const p = join(settings.UPLOAD_DIR, STORE_FILE);
    if (existsSync(p)) {
      const id = readFileSync(p, 'utf8').trim();
      return id || null;
    }
  } catch (_) {}
  return null;
}

/**
 * Load vector store id from DB into memory (call before relying on get* on serverless).
 * Re-runs on each call so a new id written by another instance is picked up.
 */
export async function hydrateMatriyaOpenAiVectorStoreId() {
  if (process.env.MATRIYA_OPENAI_VECTOR_STORE_ID?.trim()) return;
  if (!MatriyaAppKv || !sequelize) return;
  try {
    await initDb();
    const row = await MatriyaAppKv.findByPk(KV_KEY);
    const v = row?.value?.trim();
    if (v) memoryVectorStoreId = v;
  } catch (e) {
    console.warn('[openaiMatriyaConfig] hydrate vector store id:', e.message);
  }
}

/** @returns {Promise<Record<string, { file_id: string, fp: string }>>} */
export async function getMatriyaOpenAiSyncFileMap() {
  if (!MatriyaAppKv || !sequelize) return {};
  try {
    await initDb();
    const row = await MatriyaAppKv.findByPk(SYNC_FILE_MAP_KEY);
    if (!row?.value) return {};
    const o = JSON.parse(row.value);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch (_) {
    return {};
  }
}

export async function persistMatriyaOpenAiSyncFileMap(map) {
  if (!MatriyaAppKv || !sequelize) return;
  try {
    await initDb();
    await MatriyaAppKv.upsert({
      key: SYNC_FILE_MAP_KEY,
      value: JSON.stringify(map && typeof map === 'object' ? map : {}),
      updated_at: new Date()
    });
  } catch (e) {
    console.warn('[openaiMatriyaConfig] persist sync file map:', e.message);
  }
}

export async function persistMatriyaOpenAiVectorStoreId(id) {
  const trimmed = String(id || '').trim();
  if (!trimmed) return;
  memoryVectorStoreId = trimmed;
  try {
    const dir = settings.UPLOAD_DIR;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const p = join(dir, STORE_FILE);
    writeFileSync(p, trimmed, 'utf8');
  } catch (e) {
    console.warn('[openaiMatriyaConfig] file persist vector store id:', e.message);
  }
  if (!MatriyaAppKv || !sequelize) return;
  try {
    await initDb();
    await MatriyaAppKv.upsert({
      key: KV_KEY,
      value: trimmed,
      updated_at: new Date()
    });
  } catch (e) {
    console.warn('[openaiMatriyaConfig] DB persist vector store id:', e.message);
  }
}

export function useOpenAiFileSearchEnabled() {
  const v = process.env.USE_OPENAI_FILE_SEARCH;
  return v === 'true' || v === '1';
}

export function getOpenAiApiBase() {
  return (process.env.OPENAI_API_BASE || 'https://api.openai.com/v1').replace(/\/$/, '');
}

export function getOpenAiRagModel() {
  return (process.env.OPENAI_RAG_MODEL || 'gpt-4o-mini').trim();
}
