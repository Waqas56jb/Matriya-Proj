/**
 * Detect formulation-like structured data in retrieval chunks/snippets so we do not
 * return INSUFFICIENT solely on low similarity when the document actually contains
 * percentages / weight / ratio lines (e.g. ERL-ONE with 0.xx or NN.NN%).
 */

const CUES =
  /%|אחוז|percent|weight|ratio|wt\.?\b|w\/w|פורמול|הרכב|יחס|משקל|ingredient|formula|composition/i;
const PCT_LITERAL = /\b\d{1,3}(?:\.\d+)?\s*%/;
const FRAC = /\b0\.\d{2,8}\b/;
/** Product / variant codes often appear next to formulation tables */
const PRODUCT_CODE = /\b[A-Z]{2,}[-–][A-Z0-9][A-Z0-9\-]{0,20}\b/;
const EXCEL_PCT_PAIR = /\b\d{1,3}\.\d{2}%\b/g;

/**
 * @param {string} text - chunk or snippet body
 * @returns {boolean}
 */
export function textHasStructuredPercentOrCompositionSignals(text) {
  const t = String(text || '');
  if (t.length < 12) return false;
  if (PCT_LITERAL.test(t) && CUES.test(t)) return true;
  const fr = t.match(FRAC);
  if (fr && fr.length >= 2) return true;
  const excelStyle = t.match(EXCEL_PCT_PAIR);
  if (excelStyle && excelStyle.length >= 2) return true;
  if (FRAC.test(t) && CUES.test(t)) return true;
  if (PRODUCT_CODE.test(t) && (PCT_LITERAL.test(t) || (fr && fr.length >= 1))) return true;
  return false;
}

/** @param {{ document?: string, text?: string }} row */
export function chunkLikeHasStructuredData(row) {
  if (!row || typeof row !== 'object') return false;
  return textHasStructuredPercentOrCompositionSignals(row.document ?? row.text ?? '');
}

/** @param {object[]} chunks */
export function detectStructuredDataInChunks(chunks) {
  const arr = Array.isArray(chunks) ? chunks : [];
  return arr.some((c) => chunkLikeHasStructuredData(c));
}

/** @param {{ text?: string, excerpt?: string }[]} snippets */
export function detectStructuredDataInSnippets(snippets) {
  const list = Array.isArray(snippets) ? snippets : [];
  return list.some((s) =>
    textHasStructuredPercentOrCompositionSignals(s.text ?? s.excerpt ?? '')
  );
}
