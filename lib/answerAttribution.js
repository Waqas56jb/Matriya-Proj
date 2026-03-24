/**
 * Deterministic answer ↔ retrieval binding. Sources are built only here (never from LLM JSON).
 */
import crypto from 'crypto';

function hash16(parts) {
  return crypto.createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16);
}

/** Default max sources for document flow; research flow uses MATRIYA_MAX_ATTRIBUTION_SOURCES (default 3). */
const DEFAULT_MAX_ITEMS = 48;

/**
 * From RAG / vector rows (id, metadata.filename, document).
 * @param {Array<object>} results
 * @param {{ previewLength?: number, maxItems?: number }} [opts]
 * @returns {{ source_id: string, document_name: string, preview: string, filename: string, excerpt: string }[]}
 */
export function buildAnswerSourcesFromRetrieval(results, opts = {}) {
  const previewLength = opts.previewLength ?? 100;
  const maxItems = opts.maxItems ?? DEFAULT_MAX_ITEMS;
  const arr = Array.isArray(results) ? results : [];
  const out = [];
  let seq = 0;
  for (const item of arr) {
    if (out.length >= maxItems) break;
    const text = String(item?.document ?? item?.text ?? '').trim();
    if (!text) continue;
    const document_name = String(item?.metadata?.filename ?? item?.metadata?.name ?? 'Unknown');
    const idPart = item?.id != null && item.id !== '' ? String(item.id) : null;
    const h = hash16([document_name, text.slice(0, 400)]);
    const source_id = idPart ? `row:${idPart}` : `retrieval:${seq}:${h}`;
    const preview = text.length > previewLength ? `${text.slice(0, previewLength)}…` : text;
    out.push({
      source_id,
      document_name,
      preview,
      filename: document_name,
      excerpt: preview
    });
    seq += 1;
  }
  return out;
}

/**
 * OpenAI file_search snippets: { filename, text } only — stable ids from content hash.
 */
export function buildAnswerSourcesFromSnippets(snippets, opts = {}) {
  const previewLength = opts.previewLength ?? 100;
  const arr = Array.isArray(snippets) ? snippets : [];
  return arr
    .map((s, i) => {
      const document_name = String(s?.filename ?? 'Unknown');
      const text = String(s?.text ?? s?.excerpt ?? '').trim();
      if (!text) return null;
      const h = hash16([document_name, text.slice(0, 400), String(i)]);
      const source_id = `snippet:${i}:${h}`;
      const preview = text.length > previewLength ? `${text.slice(0, previewLength)}…` : text;
      return {
        source_id,
        document_name,
        preview,
        filename: document_name,
        excerpt: preview
      };
    })
    .filter(Boolean);
}
