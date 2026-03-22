/**
 * OpenAI Responses API + file_search for Matriya (same tool shape as maneger-back gpt-rag/query).
 */
import axios from 'axios';
import {
  getMatriyaOpenAiVectorStoreId,
  getOpenAiApiBase,
  getOpenAiRagModel
} from './openaiMatriyaConfig.js';
import settings from '../config.js';

export function extractOpenAiResponsesOutputText(data) {
  if (!data || typeof data !== 'object') return '';
  if (typeof data.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
  const out = data.output;
  if (!Array.isArray(out)) return '';
  const parts = [];
  for (const item of out) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c && typeof c.text === 'string' && (c.type === 'output_text' || c.type === 'text')) parts.push(c.text);
      }
    }
  }
  return parts.join('\n\n').trim();
}

/**
 * Best-effort map of file_search_call payloads (shape varies by API version).
 */
export function collectFileSearchSnippetsFromResponse(data) {
  const chunks = [];
  const out = data?.output;
  if (!Array.isArray(out)) return chunks;
  for (const item of out) {
    if (item.type !== 'file_search_call') continue;
    const results = item.results || item.search_results || item.content || [];
    const list = Array.isArray(results) ? results : [];
    for (const r of list) {
      const text =
        (typeof r === 'string' && r) ||
        r.text ||
        r.content ||
        r.chunk ||
        r.snippet ||
        '';
      const fname =
        r.filename ||
        r.file_name ||
        (r.file && (r.file.filename || r.file.name)) ||
        r.name ||
        'Unknown';
      if (text && String(text).trim()) {
        chunks.push({ filename: String(fname), text: String(text).trim() });
      }
    }
  }
  return chunks;
}

/** API shape for management/Matriya UI: { filename, excerpt }[] */
export function normalizeEvidenceSources(snippets, maxItems = 24, maxLen = 4000) {
  const seen = new Set();
  const out = [];
  for (const s of snippets) {
    const fn = String(s.filename ?? '—');
    const raw = String(s.text ?? s.excerpt ?? '').trim();
    if (!raw) continue;
    const key = `${fn}\0${raw.slice(0, 120)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      filename: fn,
      excerpt: raw.length > maxLen ? `${raw.slice(0, maxLen)}…` : raw
    });
    if (out.length >= maxItems) break;
  }
  return out;
}

export function evidenceFromSearchResults(results, maxItems = 24, maxLen = 4000) {
  const snippets = (Array.isArray(results) ? results : []).map((item) => ({
    filename: item.metadata?.filename || 'Unknown',
    text: item.document || item.text || ''
  }));
  return normalizeEvidenceSources(snippets, maxItems, maxLen);
}

function jsonHeaders(apiKey) {
  return { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
}

function buildFilenameHint(filterMetadata) {
  if (!filterMetadata || typeof filterMetadata !== 'object') return '';
  const files = Array.isArray(filterMetadata.filenames)
    ? filterMetadata.filenames.filter((f) => typeof f === 'string' && f.trim())
    : [];
  if (files.length > 0) {
    return `\n\n(User asked to focus on these document paths/names if relevant: ${files.join(', ')})`;
  }
  const one = typeof filterMetadata.filename === 'string' ? filterMetadata.filename.trim() : '';
  return one ? `\n\n(User asked to focus on: ${one})` : '';
}

/** Real logical filenames in Matriya (disambiguation; claims must still come from file_search only). */
export function buildMatriyaCatalogAppendix(filenames) {
  const list = Array.isArray(filenames) ? filenames.map((f) => String(f || '').trim()).filter(Boolean) : [];
  const unique = [...new Set(list)].slice(0, 120);
  if (!unique.length) return '';
  return (
    '\n\n[System — indexed document names in Matriya. When the user names a file, map to these paths. Every factual claim must be supported only by file_search snippets; do not answer from general knowledge. If nothing in the documents answers the question, say so clearly in Hebrew.]\n' +
    unique.map((n) => `· ${n}`).join('\n') +
    '\n'
  );
}

const INSTRUCTIONS_CONTEXT =
  'You retrieve evidence for downstream agents. Use ONLY file_search results from the attached vector store. Include source document names (as in search results) next to excerpts. Respond in Hebrew (עברית) when the source is Hebrew. Do not use general knowledge for factual claims. If retrieval has no relevant content, state that briefly in Hebrew — do not invent.';

/** Same rules as manager GPT RAG — shared with POST /ask-matriya (file_search path). */
export const MATRIYA_FILE_SEARCH_INSTRUCTIONS_ANSWER =
  'You answer using ONLY content from file_search in the attached vector store. Do NOT use general knowledge, training data, or the web for facts (materials, products, formulas, regulations, etc.). If the documents do not contain the answer, say clearly in Hebrew that it does not appear in the indexed documents — never substitute a plausible answer from memory. When the user asks about a specific file, prioritize snippets from that file and cite its name. For cross-document questions, list only facts actually present in retrieved text, each with its source filename. Respond in Hebrew (עברית) only. Do not use Arabic.';

/**
 * @param {object} opts
 * @param {string} opts.query
 * @param {string} opts.vectorStoreId
 * @param {string} opts.instructions
 * @param {number} [opts.maxNumResults]
 * @param {object|null} [opts.filterMetadata]
 * @param {boolean} [opts.includeResultDetails]
 */
export async function openAiResponsesFileSearch(opts) {
  const apiKey = (settings.OPENAI_API_KEY || '').trim();
  if (!apiKey) {
    const err = new Error('OPENAI_API_KEY not configured');
    err.code = 'OPENAI_KEY_MISSING';
    throw err;
  }
  const base = getOpenAiApiBase();
  const model = getOpenAiRagModel();
  const vsId = opts.vectorStoreId || getMatriyaOpenAiVectorStoreId();
  if (!vsId) {
    const err = new Error('No OpenAI vector store. Run GPT document sync from the Files tab or set MATRIYA_OPENAI_VECTOR_STORE_ID.');
    err.code = 'OPENAI_VS_MISSING';
    throw err;
  }
  const catalogBit =
    opts.catalogAppendix != null && String(opts.catalogAppendix).trim() !== ''
      ? String(opts.catalogAppendix)
      : '';
  const input = String(opts.query || '') + buildFilenameHint(opts.filterMetadata || null) + catalogBit;
  const payload = {
    model,
    instructions: opts.instructions,
    input,
    tools: [
      {
        type: 'file_search',
        vector_store_ids: [vsId],
        max_num_results: Math.min(50, Math.max(4, opts.maxNumResults ?? 20))
      }
    ],
    include: opts.includeResultDetails !== false ? ['file_search_call.results'] : []
  };
  const r = await axios.post(`${base}/responses`, payload, {
    headers: jsonHeaders(apiKey),
    timeout: 120000
  });
  return r.data;
}

export async function openAiFileSearchAnswerAndSnippets(
  query,
  filterMetadata,
  { forContextOnly = false, catalogFilenames = null } = {}
) {
  const instructions = forContextOnly ? INSTRUCTIONS_CONTEXT : MATRIYA_FILE_SEARCH_INSTRUCTIONS_ANSWER;
  const catalogAppendix = buildMatriyaCatalogAppendix(
    Array.isArray(catalogFilenames) ? catalogFilenames : null
  );

  const data = await openAiResponsesFileSearch({
    query,
    filterMetadata,
    instructions,
    catalogAppendix,
    maxNumResults: forContextOnly ? 28 : 24,
    includeResultDetails: true
  });
  const answerText = extractOpenAiResponsesOutputText(data);
  let snippets = collectFileSearchSnippetsFromResponse(data);
  if (snippets.length === 0 && answerText) {
    snippets = [{ filename: 'OpenAI file search', text: answerText }];
  }
  return { data, answerText, snippets };
}
