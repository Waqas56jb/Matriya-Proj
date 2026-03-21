/**
 * Sync Matriya RAG files (extracted text in DB) into a dedicated OpenAI vector store.
 * Original binaries are not kept; each document is uploaded as UTF-8 .txt for file_search.
 */
import axios from 'axios';
import FormData from 'form-data';
import path from 'path';
import { GPT_RAG_FILE_RE, GPT_RAG_MAX_FILE_BYTES, GPT_RAG_MAX_FILES } from './gptRagEligible.js';
import { getOpenAiApiBase } from './openaiMatriyaConfig.js';
import settings from '../config.js';

/** Parallel OpenAI file uploads (wall time dominates on Vercel’s serverless limit). */
const UPLOAD_CONCURRENCY = 4;

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runWithConcurrency(items, concurrency, worker) {
  const queue = items.slice();
  const n = Math.max(1, Math.min(concurrency, queue.length || 1));
  const runners = Array.from({ length: n }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (item !== undefined) await worker(item);
    }
  });
  await Promise.all(runners);
}

function jsonHeaders(openaiApiKey) {
  return { Authorization: `Bearer ${openaiApiKey}`, 'Content-Type': 'application/json' };
}

async function pollVectorStoreBatchComplete(openaiBase, openaiApiKey, vectorStoreId, batchId) {
  const url = `${openaiBase}/vector_stores/${vectorStoreId}/file_batches/${batchId}`;
  for (let i = 0; i < 90; i++) {
    const r = await axios.get(url, { headers: jsonHeaders(openaiApiKey), timeout: 60000 });
    const st = r.data?.status;
    if (st === 'completed') return { ok: true, data: r.data };
    if (st === 'failed' || st === 'cancelled') return { ok: false, error: r.data?.errors || r.data || st };
    await sleepMs(2000);
  }
  return { ok: false, error: 'Vector store indexing timed out' };
}

function displayFilename(row) {
  const f = String(row?.filename || '').trim();
  return f || 'file';
}

function safeUploadName(filename) {
  const base = path.basename(String(filename).replace(/\\/g, '/')) || 'document';
  const stem = base.replace(/\.[^.]+$/, '') || 'document';
  const safe = stem.replace(/[/\\?%*:|"<>]/g, '_').slice(0, 120);
  return `${safe}.txt`;
}

/**
 * @param {object} ragService - RAGService with getFilesWithMetadata(), getFullTextForFile()
 * @param {{ openaiApiKey: string, openaiBase?: string, onLog?: (msg: string) => void }} opts
 */
export async function syncMatriyaRagToOpenAI(ragService, opts) {
  const openaiApiKey = (opts.openaiApiKey || '').trim();
  const openaiBase = (opts.openaiBase || getOpenAiApiBase()).replace(/\/$/, '');
  const log = opts.onLog || (() => {});

  if (!openaiApiKey) {
    return { ok: false, status: 503, error: 'OPENAI_API_KEY not set' };
  }

  let rows;
  try {
    rows = await ragService.getFilesWithMetadata();
  } catch (e) {
    return { ok: false, status: 500, error: e.message || 'Failed to list files' };
  }

  const candidates = (rows || [])
    .filter((r) => r && GPT_RAG_FILE_RE.test(displayFilename(r)))
    .slice(0, GPT_RAG_MAX_FILES);

  if (candidates.length === 0) {
    return {
      ok: false,
      status: 400,
      error:
        'No OpenAI-searchable documents in the index (e.g. PDF, DOCX, TXT, XLSX). Ingest supported files first, then sync.'
    };
  }

  const vsName = `matriya-${Date.now()}`.slice(0, 48);
  log(`create vector store "${vsName}"…`);
  const vsRes = await axios.post(
    `${openaiBase}/vector_stores`,
    { name: vsName, metadata: { app: 'matriya' } },
    { headers: jsonHeaders(openaiApiKey), timeout: 60000 }
  );
  const newVsId = vsRes.data?.id;
  if (!newVsId) {
    return { ok: false, status: 500, error: 'OpenAI did not return vector_store id' };
  }

  const uploaded = [];
  const skipped = [];
  let uploadDone = 0;

  await runWithConcurrency(candidates, UPLOAD_CONCURRENCY, async (row) => {
    const name = displayFilename(row);
    try {
      const text = await ragService.getFullTextForFile(row.filename);
      if (!text || !String(text).trim()) {
        skipped.push({ filename: name, error: 'No extracted text' });
        return;
      }
      const header = `---\nמקור מסמך (שם קובץ במערכת): ${name}\n---\n\n`;
      const buffer = Buffer.from(header + text, 'utf8');
      if (buffer.length > GPT_RAG_MAX_FILE_BYTES) {
        skipped.push({ filename: name, error: 'Extracted text too large for OpenAI upload' });
        return;
      }
      const uploadName = safeUploadName(name);
      const form = new FormData();
      form.append('purpose', 'assistants');
      form.append('file', buffer, {
        filename: uploadName,
        contentType: 'text/plain; charset=utf-8'
      });

      const up = await axios.post(`${openaiBase}/files`, form, {
        headers: { ...form.getHeaders(), Authorization: `Bearer ${openaiApiKey}` },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 120000
      });
      const fid = up.data?.id;
      if (!fid) throw new Error('OpenAI file upload missing id');
      uploaded.push({ openai_file_id: fid, name, upload_name: uploadName });
      uploadDone += 1;
      log(`uploaded ${uploadDone}/${candidates.length}: ${name}`);
    } catch (e) {
      skipped.push({
        filename: name,
        error: e.response?.data?.error?.message || e.message
      });
    }
  });

  if (uploaded.length === 0) {
    try {
      await axios.delete(`${openaiBase}/vector_stores/${newVsId}`, { headers: jsonHeaders(openaiApiKey), timeout: 30000 });
    } catch (_) {}
    return { ok: false, status: 502, error: 'Could not upload any files to OpenAI', skipped };
  }

  const fileIds = uploaded.map((u) => u.openai_file_id);
  log(`attach ${fileIds.length} files to vector store, wait for indexing…`);
  const batchRes = await axios.post(
    `${openaiBase}/vector_stores/${newVsId}/file_batches`,
    { file_ids: fileIds },
    { headers: jsonHeaders(openaiApiKey), timeout: 120000 }
  );
  const batchId = batchRes.data?.id;
  if (!batchId) {
    try {
      await axios.delete(`${openaiBase}/vector_stores/${newVsId}`, { headers: jsonHeaders(openaiApiKey), timeout: 30000 });
    } catch (_) {}
    return { ok: false, status: 500, error: 'OpenAI file batch missing id' };
  }

  const polled = await pollVectorStoreBatchComplete(openaiBase, openaiApiKey, newVsId, batchId);
  if (!polled.ok) {
    return {
      ok: false,
      status: 502,
      error: polled.error || 'Vector indexing failed',
      uploaded: uploaded.length,
      batch_id: batchId
    };
  }

  return {
    ok: true,
    vector_store_id: newVsId,
    uploaded: uploaded.length,
    skipped: skipped.length ? skipped : undefined,
    batch_status: polled.data?.status
  };
}
