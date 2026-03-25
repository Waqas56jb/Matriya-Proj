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

/** @type {{ mode: 'none' } | { mode: 'full' } | { mode: 'partial'; names: Set<string> }} */
let pendingScope = { mode: 'none' };

/**
 * @param {() => import('../ragService.js').default} getRagService - lazy getter (may throw if RAG unavailable)
 * @param {string} [hint] - log tag, e.g. "ingest/file"
 * @param {{ logicalName?: string, fullIndex?: boolean }} [syncScope]
 *        - logicalName: only sync that file to OpenAI (merged across debounce window)
 *        - fullIndex: sync entire index (directory ingest, manual /gpt-rag/sync)
 */
export function scheduleMatriyaOpenAiSyncAfterIngest(getRagService, hint = '', syncScope = {}) {
  const apiKey = (settings.OPENAI_API_KEY || '').trim();
  if (!apiKey || !useOpenAiFileSearchEnabled()) return;

  const { logicalName, fullIndex } = syncScope;
  if (fullIndex) {
    pendingScope = { mode: 'full' };
  } else if (logicalName && String(logicalName).trim()) {
    const n = String(logicalName).trim();
    if (pendingScope.mode === 'full') {
      /* keep full */
    } else if (pendingScope.mode === 'partial') {
      pendingScope.names.add(n);
    } else {
      pendingScope = { mode: 'partial', names: new Set([n]) };
    }
  }

  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    timer = null;
    const spec = pendingScope;
    pendingScope = { mode: 'none' };

    let rag;
    try {
      rag = getRagService();
    } catch (e) {
      logger.warn(`[matriya cloud auto-sync] skip (no RAG): ${e.message}`);
      return;
    }
    const onlyLogicalNames =
      spec.mode === 'partial' && spec.names.size > 0 ? [...spec.names] : undefined;
    try {
      const r = await syncMatriyaRagToOpenAI(rag, {
        openaiApiKey: apiKey,
        openaiBase: settings.OPENAI_API_BASE,
        onlyLogicalNames,
        onLog: (msg) => logger.info(`[matriya cloud auto-sync]${hint ? ` ${hint}` : ''} ${msg}`)
      });
      if (r.ok && r.vector_store_id) {
        await persistMatriyaOpenAiVectorStoreId(r.vector_store_id);
        logger.info(
          `[matriya cloud auto-sync] done uploaded=${r.uploaded}${r.incremental ? ' (incremental)' : ''}${hint ? ` (${hint})` : ''}`
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
