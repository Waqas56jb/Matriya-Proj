/**
 * Sync Matriya RAG files (extracted text in DB) into a dedicated OpenAI vector store.
 * Original binaries are not kept; each document is uploaded as UTF-8 .txt for file_search.
 * When a vector store id already exists, only new or changed documents are uploaded (content fingerprint).
 */
import axios from 'axios';
import FormData from 'form-data';
import path from 'path';
import { createHash } from 'crypto';
import { GPT_RAG_FILE_RE, GPT_RAG_MAX_FILE_BYTES, GPT_RAG_MAX_FILES } from './gptRagEligible.js';
import {
  getOpenAiApiBase,
  getMatriyaOpenAiVectorStoreId,
  hydrateMatriyaOpenAiVectorStoreId,
  getMatriyaOpenAiSyncFileMap,
  persistMatriyaOpenAiSyncFileMap
} from './openaiMatriyaConfig.js';

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

function fingerprintBuffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
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

async function listCompletedOpenAiFileIdsInVectorStore(openaiBase, openaiApiKey, vsId) {
  const set = new Set();
  let after;
  for (let page = 0; page < 50; page++) {
    const params = { limit: 100, filter: 'completed' };
    if (after) params.after = after;
    const r = await axios.get(`${openaiBase}/vector_stores/${vsId}/files`, {
      headers: jsonHeaders(openaiApiKey),
      params,
      timeout: 60000
    });
    const data = r.data?.data || [];
    for (const it of data) {
      if (it.status && it.status !== 'completed') continue;
      let fid = it.file_id;
      if (!fid) {
        try {
          const d = await axios.get(`${openaiBase}/vector_stores/${vsId}/files/${it.id}`, {
            headers: jsonHeaders(openaiApiKey),
            timeout: 30000
          });
          fid = d.data?.file_id;
        } catch (_) {}
      }
      if (fid) set.add(fid);
    }
    if (!r.data?.has_more) break;
    after = r.data?.last_id;
  }
  return set;
}

async function detachOpenAiFileFromVectorStore(openaiBase, openaiApiKey, vsId, fileId) {
  await axios.delete(`${openaiBase}/vector_stores/${vsId}/files/${fileId}`, {
    headers: jsonHeaders(openaiApiKey),
    timeout: 30000
  });
}

async function deleteOpenAiUploadedFile(openaiBase, openaiApiKey, fileId) {
  await axios.delete(`${openaiBase}/files/${fileId}`, {
    headers: jsonHeaders(openaiApiKey),
    timeout: 30000
  });
}

async function reconcileFileMapFromVectorStore(
  openaiBase,
  openaiApiKey,
  vsId,
  prepared,
  fileMap,
  log
) {
  const byUploadName = new Map(prepared.map((p) => [p.uploadName, p]));
  const ids = await listCompletedOpenAiFileIdsInVectorStore(openaiBase, openaiApiKey, vsId);
  log(`reconcile: ${ids.size} files in vector store, matching upload names…`);
  for (const fileId of ids) {
    try {
      const r = await axios.get(`${openaiBase}/files/${fileId}`, {
        headers: jsonHeaders(openaiApiKey),
        timeout: 30000
      });
      const fname = r.data?.filename;
      const p = fname ? byUploadName.get(fname) : null;
      if (p) fileMap[p.name] = { file_id: fileId, fp: p.fp };
    } catch (_) {}
  }
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

async function uploadOnePrepared(openaiBase, openaiApiKey, p, log) {
  const form = new FormData();
  form.append('purpose', 'assistants');
  form.append('file', p.buffer, {
    filename: p.uploadName,
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
  log(`uploaded: ${p.name}`);
  return { openai_file_id: fid, name: p.name, upload_name: p.uploadName, fp: p.fp };
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

  await hydrateMatriyaOpenAiVectorStoreId();

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

  const skipped = [];
  /** @type {{ row: object, name: string, uploadName: string, buffer: Buffer, fp: string }[]} */
  const prepared = [];
  for (const row of candidates) {
    const name = displayFilename(row);
    try {
      const text = await ragService.getFullTextForFile(row.filename);
      if (!text || !String(text).trim()) {
        skipped.push({ filename: name, error: 'No extracted text' });
        continue;
      }
      const header = `---\nמקור מסמך (שם קובץ במערכת): ${name}\n---\n\n`;
      const buffer = Buffer.from(header + text, 'utf8');
      if (buffer.length > GPT_RAG_MAX_FILE_BYTES) {
        skipped.push({ filename: name, error: 'Extracted text too large for OpenAI upload' });
        continue;
      }
      prepared.push({
        row,
        name,
        uploadName: safeUploadName(name),
        buffer,
        fp: fingerprintBuffer(buffer)
      });
    } catch (e) {
      skipped.push({ filename: name, error: e.message || 'read failed' });
    }
  }

  if (prepared.length === 0) {
    return {
      ok: false,
      status: 400,
      error: 'No documents with extractable text to sync.',
      skipped
    };
  }

  let fileMap = await getMatriyaOpenAiSyncFileMap();
  let vsId = getMatriyaOpenAiVectorStoreId();
  let vsExists = false;

  if (vsId) {
    try {
      await axios.get(`${openaiBase}/vector_stores/${vsId}`, {
        headers: jsonHeaders(openaiApiKey),
        timeout: 30000
      });
      vsExists = true;
    } catch (e) {
      if (e.response?.status === 404) {
        log('stored vector store missing on OpenAI; full sync with a new store');
        vsId = null;
        vsExists = false;
        fileMap = {};
      } else {
        return { ok: false, status: 502, error: e.response?.data?.error?.message || e.message };
      }
    }
  }

  let vsFileIds = new Set();
  if (vsExists && vsId) {
    vsFileIds = await listCompletedOpenAiFileIdsInVectorStore(openaiBase, openaiApiKey, vsId);
    if (Object.keys(fileMap).length === 0 && prepared.length > 0 && vsFileIds.size > 0) {
      await reconcileFileMapFromVectorStore(openaiBase, openaiApiKey, vsId, prepared, fileMap, log);
      await persistMatriyaOpenAiSyncFileMap(fileMap);
      vsFileIds = await listCompletedOpenAiFileIdsInVectorStore(openaiBase, openaiApiKey, vsId);
    }
  }

  const toUpload = prepared.filter((p) => {
    const prev = fileMap[p.name];
    return !(vsExists && prev && prev.fp === p.fp && vsFileIds.has(prev.file_id));
  });

  if (vsExists && vsId && toUpload.length === 0) {
    return {
      ok: true,
      vector_store_id: vsId,
      uploaded: 0,
      incremental: true,
      batch_status: 'completed',
      skipped: skipped.length ? skipped : undefined
    };
  }

  const skipIndexWait =
    process.env.MATRIYA_OPENAI_SYNC_SKIP_INDEX_WAIT === 'true' ||
    process.env.MATRIYA_OPENAI_SYNC_SKIP_INDEX_WAIT === '1' ||
    process.env.VERCEL === '1';

  const finishBatch = async (targetVsId, batchId, uploadedCount) => {
    if (skipIndexWait) {
      log(`batch ${batchId} queued; skipping wait for indexing (OpenAI finishes in background).`);
      return {
        ok: true,
        vector_store_id: targetVsId,
        uploaded: uploadedCount,
        skipped: skipped.length ? skipped : undefined,
        incremental: vsExists,
        batch_status: 'in_progress',
        indexing_pending: true,
        batch_id: batchId
      };
    }
    const polled = await pollVectorStoreBatchComplete(openaiBase, openaiApiKey, targetVsId, batchId);
    if (!polled.ok) {
      return {
        ok: false,
        status: 502,
        error: polled.error || 'Vector indexing failed',
        uploaded: uploadedCount,
        batch_id: batchId
      };
    }
    return {
      ok: true,
      vector_store_id: targetVsId,
      uploaded: uploadedCount,
      skipped: skipped.length ? skipped : undefined,
      incremental: vsExists,
      batch_status: polled.data?.status
    };
  };

  /** @type {{ openai_file_id: string, name: string, upload_name: string, fp: string }[]} */
  let uploaded = [];

  if (vsExists && vsId) {
    for (const p of toUpload) {
      const prev = fileMap[p.name];
      if (prev?.file_id && vsFileIds.has(prev.file_id) && prev.fp !== p.fp) {
        try {
          await detachOpenAiFileFromVectorStore(openaiBase, openaiApiKey, vsId, prev.file_id);
          await deleteOpenAiUploadedFile(openaiBase, openaiApiKey, prev.file_id).catch(() => {});
          vsFileIds.delete(prev.file_id);
        } catch (e) {
          log(`warn: could not remove old OpenAI file for ${p.name}: ${e.message}`);
        }
      }
    }

    await runWithConcurrency(toUpload, UPLOAD_CONCURRENCY, async (p) => {
      try {
        const u = await uploadOnePrepared(openaiBase, openaiApiKey, p, log);
        uploaded.push(u);
      } catch (e) {
        skipped.push({ filename: p.name, error: e.response?.data?.error?.message || e.message });
      }
    });

    if (uploaded.length === 0) {
      return { ok: false, status: 502, error: 'Could not upload any new files to OpenAI', skipped };
    }

    const fileIds = uploaded.map((u) => u.openai_file_id);
    log(`attach ${fileIds.length} new/changed files to existing vector store, wait for indexing…`);
    const batchRes = await axios.post(
      `${openaiBase}/vector_stores/${vsId}/file_batches`,
      { file_ids: fileIds },
      { headers: jsonHeaders(openaiApiKey), timeout: 120000 }
    );
    const batchId = batchRes.data?.id;
    if (!batchId) {
      return { ok: false, status: 500, error: 'OpenAI file batch missing id' };
    }

    for (const u of uploaded) {
      fileMap[u.name] = { file_id: u.openai_file_id, fp: u.fp };
    }
    await persistMatriyaOpenAiSyncFileMap(fileMap);

    return finishBatch(vsId, batchId, uploaded.length);
  }

  /* ——— Full sync: no usable vector store ——— */
  fileMap = {};
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

  uploaded = [];
  await runWithConcurrency(prepared, UPLOAD_CONCURRENCY, async (p) => {
    try {
      const u = await uploadOnePrepared(openaiBase, openaiApiKey, p, log);
      uploaded.push(u);
    } catch (e) {
      skipped.push({ filename: p.name, error: e.response?.data?.error?.message || e.message });
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

  for (const u of uploaded) {
    fileMap[u.name] = { file_id: u.openai_file_id, fp: u.fp };
  }
  await persistMatriyaOpenAiSyncFileMap(fileMap);

  const out = await finishBatch(newVsId, batchId, uploaded.length);
  if (!out.ok) {
    return out;
  }
  return { ...out, incremental: false };
}
