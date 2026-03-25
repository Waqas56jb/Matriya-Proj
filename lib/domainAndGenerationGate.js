/**
 * Domain: keep only retrieval rows/snippets that align with the query (token overlap).
 * Conclusion: logical readiness checks before calling the local LLM (vector path) or accepting cloud RAG output.
 */
import { retrievalSimilarityForGate, getRetrievalSimilarityThreshold } from '../researchGate.js';

function tokenizeQuery(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2)
    .slice(0, 80);
}

/** Same idea as openaiFileSearchMatriya — match English ingredient labels in Hebrew questions. */
function latinTokensFromQuery(query) {
  const latin = String(query || '').match(/[a-zA-Z][a-zA-Z0-9.\-]{2,}/g) || [];
  const out = [];
  for (const w of latin) {
    const low = w.toLowerCase();
    if (low.length >= 2 && !out.includes(low)) out.push(low);
  }
  return out.slice(0, 24);
}

function queryTokensForDomain(query) {
  return [...tokenizeQuery(query), ...latinTokensFromQuery(query)].slice(0, 80);
}

export function getDomainFilterOptions() {
  const minOverlap = parseInt(process.env.MATRIYA_DOMAIN_MIN_QUERY_OVERLAP || '2', 10);
  return {
    /** Minimum sum of query-token hits in chunk text (2 pts per token). 0 = disable domain filter. */
    minQueryOverlap: Number.isFinite(minOverlap) ? Math.max(0, minOverlap) : 2
  };
}

function overlapScore(textLower, queryToks) {
  let s = 0;
  for (const t of queryToks) {
    if (t.length >= 2 && textLower.includes(t)) s += 2;
  }
  return s;
}

/**
 * Drop chunks with no query-term presence when the query has lexical tokens (numbers-only → no filter).
 * @param {string} query
 * @param {object[]} rows - RAG rows { document, text, metadata, ... }
 */
export function filterRetrievalRowsByQueryDomain(query, rows) {
  const { minQueryOverlap } = getDomainFilterOptions();
  const arr = Array.isArray(rows) ? rows : [];
  if (minQueryOverlap <= 0) return arr;

  const qt = queryTokensForDomain(query);
  if (qt.length === 0) return arr;

  const scored = arr.map((r) => {
    const low = String(r.document ?? r.text ?? '').toLowerCase();
    return { r, overlap: overlapScore(low, qt) };
  });
  const maxO = Math.max(0, ...scored.map((x) => x.overlap));
  if (maxO === 0) {
    // Several chunks with no lexical hit: trust file_search order (e.g. Hebrew Q vs English table). One chunk + no hit: drop.
    if (arr.length > 1) return arr;
    return [];
  }

  return scored.filter((x) => x.overlap >= minQueryOverlap).map((x) => x.r);
}

/**
 * @param {string} query
 * @param {{ filename?: string, text?: string }[]} snippets
 */
export function filterSnippetsByQueryDomain(query, snippets) {
  const { minQueryOverlap } = getDomainFilterOptions();
  const list = Array.isArray(snippets) ? snippets : [];
  if (minQueryOverlap <= 0) return list;

  const qt = queryTokensForDomain(query);
  if (qt.length === 0) return list;

  const scored = list.map((s) => {
    const low = String(s.text ?? s.excerpt ?? '').toLowerCase();
    return { s, overlap: overlapScore(low, qt) };
  });
  const maxO = Math.max(0, ...scored.map((x) => x.overlap));
  if (maxO === 0) {
    if (list.length > 1) return list;
    return [];
  }

  return scored.filter((x) => x.overlap >= minQueryOverlap).map((x) => x.s);
}

export function getGenerationReadinessOptions() {
  const minChunks = Math.max(1, parseInt(process.env.MATRIYA_GENERATION_MIN_CHUNKS || '1', 10) || 1);
  const minTopKSum = parseFloat(process.env.MATRIYA_GENERATION_MIN_TOPK_SIMILARITY_SUM || '0');
  return {
    minChunks,
    minTopKSimilaritySum: Number.isFinite(minTopKSum) && minTopKSum > 0 ? minTopKSum : 0,
    topKForSum: Math.max(1, Math.min(5, parseInt(process.env.MATRIYA_GENERATION_TOPK_SUM_K || '3', 10) || 3))
  };
}

/**
 * Preconditions before surfacing an LLM answer (vector generation) or trusting evidence-backed replies.
 * @param {string} query
 * @param {object[]} chunks - post-similarity, post-domain rows
 * @returns {{ ok: true } | { ok: false, code: string }}
 */
export function evaluateConclusionBeforeGeneration(query, chunks) {
  const { minChunks, minTopKSimilaritySum, topKForSum } = getGenerationReadinessOptions();
  const arr = Array.isArray(chunks) ? chunks : [];
  if (arr.length < minChunks) {
    return { ok: false, code: 'INSUFFICIENT_EVIDENCE' };
  }

  const thr = getRetrievalSimilarityThreshold();
  const sorted = [...arr].sort((a, b) => retrievalSimilarityForGate(b) - retrievalSimilarityForGate(a));
  const topSim = retrievalSimilarityForGate(sorted[0]);
  if (topSim < thr) {
    return { ok: false, code: 'INSUFFICIENT_EVIDENCE' };
  }

  if (minTopKSimilaritySum > 0) {
    const k = Math.min(topKForSum, sorted.length);
    const sum = sorted.slice(0, k).reduce((acc, c) => acc + retrievalSimilarityForGate(c), 0);
    if (sum < minTopKSimilaritySum) {
      return { ok: false, code: 'INSUFFICIENT_EVIDENCE' };
    }
  }

  return { ok: true };
}
