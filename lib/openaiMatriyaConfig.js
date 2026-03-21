/**
 * Matriya OpenAI File Search: env + persisted vector store id (after first sync).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import settings from '../config.js';

const STORE_FILE = '.matriya_openai_vector_store_id';

export function getMatriyaOpenAiVectorStoreId() {
  const fromEnv = process.env.MATRIYA_OPENAI_VECTOR_STORE_ID?.trim();
  if (fromEnv) return fromEnv;
  try {
    const p = join(settings.UPLOAD_DIR, STORE_FILE);
    if (existsSync(p)) {
      const id = readFileSync(p, 'utf8').trim();
      return id || null;
    }
  } catch (_) {}
  return null;
}

export function persistMatriyaOpenAiVectorStoreId(id) {
  const trimmed = String(id || '').trim();
  if (!trimmed) return;
  try {
    const dir = settings.UPLOAD_DIR;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const p = join(dir, STORE_FILE);
    writeFileSync(p, trimmed, 'utf8');
  } catch (e) {
    console.warn('[openaiMatriyaConfig] could not persist vector store id:', e.message);
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
