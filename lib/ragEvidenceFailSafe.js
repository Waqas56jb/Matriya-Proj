/**
 * Deterministic RAG fail-safe: no supporting evidence → no model "advice" or next steps in the same reply.
 */

export const RAG_INSUFFICIENT_SUPPORT_MESSAGE_HE =
  'אין במערכת מידע תומך לשאלה זו.';

/** True if OpenAI file_search yielded at least one non-empty snippet. */
export function hasFileSearchEvidence(snippets) {
  if (!Array.isArray(snippets) || snippets.length === 0) return false;
  return snippets.some((s) => String(s?.text ?? s?.excerpt ?? '').trim().length > 0);
}

/** True if vector (or mapped) search rows include substantive document text. */
export function hasVectorSearchEvidence(results, minChars = 12) {
  if (!Array.isArray(results) || results.length === 0) return false;
  return results.some((r) => String(r?.document ?? r?.text ?? '').trim().length >= minChars);
}

const NO_SUPPORT_IN_OPENING_RE =
  /(אין\s+(במסמכים|מידע|נתונים|תשובה)|לא\s+נמצא(ה)?\s+(מידע|תשובה|במסמכים)|חסר(ים)?\s+מידע|המסמכים\s+אינם\s+מכילים)/i;

const SUGGESTION_LINE_RE =
  /^(מומלץ|ממליץ|ממליצה|כדאי|ניתן ל|יש ל|רצוי|הצעה|המלצה|לבחון|לנסות|שלב\s+הבא|בנוסף|לחלופין|אפשר\s+ל|כדי\s+ל)/i;

/**
 * If the model claims no support in the opening block but continues with lists or advice, keep only the first block (deterministic).
 */
export function sanitizeAnswerWhenNoSupportClaimed(answer) {
  if (!answer || typeof answer !== 'string') return answer;
  const t = answer.trim();
  if (!t) return answer;
  const blocks = t.split(/\n\n+/);
  const firstBlock = (blocks[0] || '').trim();
  if (!NO_SUPPORT_IN_OPENING_RE.test(firstBlock.slice(0, 280))) return answer;
  if (blocks.length <= 1) {
    const lines = t.split('\n');
    const kept = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trim = line.trim();
      if (i > 0 && SUGGESTION_LINE_RE.test(trim)) break;
      if (i > 0 && /^[\s\-•*]+/.test(trim) && trim.length > 2) break;
      if (i > 0 && /^\d+[\.)]\s/.test(trim)) break;
      kept.push(line);
    }
    const joined = kept.join('\n').trim();
    return joined || RAG_INSUFFICIENT_SUPPORT_MESSAGE_HE;
  }
  return firstBlock || RAG_INSUFFICIENT_SUPPORT_MESSAGE_HE;
}
