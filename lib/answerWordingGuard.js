/**
 * Post-check for neutral answers (David checklist §7): no ranking / recommendation language
 * unless we're only quoting a negation ("אין מומלץ" etc.).
 */

/* Note: \b is unreliable for Hebrew in JS; use explicit substrings / Unicode-aware checks */
const RANKING_OR_RECOMMENDATION_RE = [
  /הכי טוב/i,
  /הכי מתאים/i,
  /נכון ביותר/i,
  /\bbest\b/i,
  /\brecommended\b/i,
  /\bprefer(?:red)?\b/i
];

/**
 * @param {string} text
 * @returns {boolean} true if text likely violates neutral wording rules
 */
export function answerViolatesNeutralWordingPolicy(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  for (const re of RANKING_OR_RECOMMENDATION_RE) {
    if (re.test(t)) return true;
  }
  // "מומלץ"/"עדיף" as recommendation, but allow "אין מומלץ" (caution, not endorsement)
  if (!/אין\s+מומלץ/i.test(t) && /מומלץ/.test(t)) return true;
  if (!/אין\s+עדיף/i.test(t) && /(^|[.!?])\s*עדיף\b/i.test(t)) return true;
  if (/עדיף\s+(ל|ש|כי)/i.test(t) && !/אין\s+עדיף/i.test(t)) return true;
  return false;
}
