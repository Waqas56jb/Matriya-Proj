/**
 * Debounced rebuild of the cloud document vector store after Matriya ingests new files.
 * Runs only when USE_OPENAI_FILE_SEARCH=true and OPENAI_API_KEY is set.
 */
import logger from '../logger.js';
import settings from '../config.js';
import { useOpenAiFileSearchEnabled, persistMatriyaOpenAiVectorStoreId } from './openaiMatriyaConfig.js';
import { syncMatriyaRagToOpenAI } from './matriyaOpenAiSync.js';

const DEBOUNCE_MS = Math.max(
  5000,
  parseInt(String(process.env.MATRIYA_OPENAI_AUTO_SYNC_DEBOUNCE_MS || '45000'), 10) || 45000
);

let timer = null;

/**
 * @param {() => import('../ragService.js').default} getRagService - lazy getter (may throw if RAG unavailable)
 * @param {string} [hint] - log tag, e.g. "ingest/file"
 */
export function scheduleMatriyaOpenAiSyncAfterIngest(getRagService, hint = '') {
  const apiKey = (settings.OPENAI_API_KEY || '').trim();
  if (!apiKey || !useOpenAiFileSearchEnabled()) return;

  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    timer = null;
    let rag;
    try {
      rag = getRagService();
    } catch (e) {
      logger.warn(`[matriya cloud auto-sync] skip (no RAG): ${e.message}`);
      return;
    }
    try {
      const r = await syncMatriyaRagToOpenAI(rag, {
        openaiApiKey: apiKey,
        openaiBase: settings.OPENAI_API_BASE,
        onLog: (msg) => logger.info(`[matriya cloud auto-sync]${hint ? ` ${hint}` : ''} ${msg}`)
      });
      if (r.ok && r.vector_store_id) {
        await persistMatriyaOpenAiVectorStoreId(r.vector_store_id);
        logger.info(
          `[matriya cloud auto-sync] done uploaded=${r.uploaded}${hint ? ` (${hint})` : ''}`
        );
      } else if (r.status === 400) {
        logger.info(`[matriya cloud auto-sync] skip — ${r.error || 'no eligible docs'}${hint ? ` (${hint})` : ''}`);
      } else {
        logger.warn(`[matriya cloud auto-sync]`, r.status, r.error, hint || '');
      }
    } catch (e) {
      logger.warn(`[matriya cloud auto-sync] exception${hint ? ` ${hint}` : ''}: ${e.message}`);
    }
  }, DEBOUNCE_MS);
}
