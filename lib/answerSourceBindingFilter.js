/**
 * Deterministic binding: keep only retrieval rows/snippets whose text (± filename) actually
 * contains the factual literals present in the answer. No LLM.
 */
import { isRagInsufficientMessage } from './ragEvidenceFailSafe.js';

/**
 * @typedef {{ type: 'substring' | 'decimal' | 'id', value: string, alt?: string }} BindingReq
 */

/**
 * @param {string} answerText
 * @returns {BindingReq[]|null} null → caller should not filter (no extractable facts / insufficient reply)
 */
export function getAnswerBindingRequirements(answerText) {
  const t = String(answerText || '').trim();
  if (!t || isRagInsufficientMessage(t)) return null;
  if (t.length < 6) return null;

  /** @type {BindingReq[]} */
  const reqs = [];

  const addSub = (s) => {
    const v = String(s).toLowerCase().replace(/\s+/g, ' ').trim();
    if (v.length >= 2) reqs.push({ type: 'substring', value: v });
  };

  let m;
  const reExpansion = /expansion\s+ratio\s*=\s*\d+(?:[.,]\d+)?/gi;
  while ((m = reExpansion.exec(t)) !== null) addSub(m[0]);

  const reHeExpansion = /יחס\s+התרחבות[^\d\n]{0,60}\d{1,3}[.,]\d+/gi;
  while ((m = reHeExpansion.exec(t)) !== null) addSub(m[0]);

  const reTriple =
    /\b\d+(?:\.\d+)?\s*:\s*\d+(?:\.\d+)?\s*:\s*\d+(?:\.\d+)?\b/g;
  while ((m = reTriple.exec(t)) !== null) {
    reqs.push({ type: 'substring', value: m[0].replace(/\s+/g, '') });
  }

  const reDec = /\d{1,3}[.,]\d+/g;
  while ((m = reDec.exec(t)) !== null) {
    const raw = m[0];
    reqs.push({
      type: 'decimal',
      value: raw.replace(',', '.').toLowerCase(),
      alt: raw.toLowerCase()
    });
  }

  const reInt = /\bINT-[A-Z0-9][A-Z0-9-]{2,}[A-Z0-9]\b/gi;
  while ((m = reInt.exec(t)) !== null) {
    reqs.push({ type: 'id', value: m[0].toLowerCase() });
  }

  if (reqs.length === 0) return null;

  const seen = new Set();
  const deduped = [];
  for (const r of reqs) {
    const key = `${r.type}:${r.value}:${r.alt || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
  }
  return deduped;
}

function haystackForRow(row) {
  const text = String(row?.document ?? row?.text ?? row?.snippet ?? '').toLowerCase();
  const fn = String(row?.metadata?.filename ?? row?.metadata?.name ?? row?.filename ?? '').toLowerCase();
  return `${text}\n${fn}`;
}

function alnumCompact(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** INT-TFX-001 vs filename ניסוי_INT-TFX_001.pdf — hyphens/underscores ignored. */
function idMatchesHay(hay, idLower) {
  if (hay.includes(idLower)) return true;
  const idC = alnumCompact(idLower);
  if (idC.length < 4) return false;
  return alnumCompact(hay).includes(idC);
}

function meetsRequirements(hay, reqs) {
  for (const req of reqs) {
    if (req.type === 'substring') {
      const compactHay = hay.replace(/\s+/g, '');
      const needle = req.value.replace(/\s+/g, '');
      if (!hay.includes(req.value) && !compactHay.includes(needle)) return false;
    } else if (req.type === 'decimal') {
      if (!hay.includes(req.value) && !(req.alt && hay.includes(req.alt))) return false;
    } else if (req.type === 'id') {
      if (!idMatchesHay(hay, req.value)) return false;
    }
  }
  return true;
}

/**
 * Filter vector / kernel rows { document, text, metadata }
 */
export function filterRetrievalRowsByAnswerBinding(rows, answerText) {
  const reqs = getAnswerBindingRequirements(answerText);
  if (!reqs) return Array.isArray(rows) ? rows : [];
  const arr = Array.isArray(rows) ? rows : [];
  return arr.filter((row) => meetsRequirements(haystackForRow(row), reqs));
}

/**
 * Filter { filename, text } snippets (Ask Matriya).
 */
export function filterSnippetsByAnswerBinding(snippets, answerText) {
  const reqs = getAnswerBindingRequirements(answerText);
  if (!reqs) return Array.isArray(snippets) ? snippets : [];
  const arr = Array.isArray(snippets) ? snippets : [];
  return arr.filter((s) => meetsRequirements(haystackForRow(s), reqs));
}
