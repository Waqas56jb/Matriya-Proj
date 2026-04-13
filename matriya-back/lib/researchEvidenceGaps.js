/**
 * Project-specific evidence gaps (e.g. APP:PER:MEL ratio design matrix for INT-TFX).
 * Configure expected variants via MATRIYA_GAP_EXPECTED_RATIOS (comma-separated triples).
 * When unset, detectGaps returns null and the API returns INSUFFICIENT_EVIDENCE if strong chunks < min.
 */

function parseTripleRatio(str) {
  if (str == null || typeof str !== 'string') return null;
  const t = str.trim().replace(/\s+/g, '');
  const m = t.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])];
}

function triplesClose(a, b, eps = 1e-3) {
  if (!a || !b || a.length !== 3 || b.length !== 3) return false;
  return a.every((x, i) => Math.abs(x - b[i]) <= eps);
}

/**
 * All unique triple ratios found in text (numeric comparison for dedup).
 */
export function extractTripleRatiosFromText(text) {
  const s = String(text || '');
  const out = [];
  const seen = new Set();
  let m;
  const re = /(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/g;
  while ((m = re.exec(s)) !== null) {
    const triple = [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])];
    if (triple.some((n) => Number.isNaN(n))) continue;
    const key = triple.map((n) => n.toFixed(6)).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(triple);
  }
  return out;
}

/**
 * Parse MATRIYA_GAP_EXPECTED_RATIOS="3:1:1,2.5:1:1.5,3.5:1:0.5"
 */
export function getGapDetectionOptionsFromEnv() {
  const raw = (process.env.MATRIYA_GAP_EXPECTED_RATIOS || '').trim();
  if (!raw) return { expectedVariants: [] };
  const expectedVariants = raw
    .split(/[,;\n]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  return { expectedVariants };
}

/**
 * @param {Array<{ document?: string, text?: string }>} relevantChunks
 * @param {{ expectedVariants?: string[] }} options
 * @returns {{ covered: string[], uncovered: string[], gap_type: 'no_variation' } | null}
 */
export function detectGaps(relevantChunks, options = {}) {
  const expectedVariants = Array.isArray(options.expectedVariants) ? options.expectedVariants : [];
  if (expectedVariants.length === 0) return null;

  const text = (Array.isArray(relevantChunks) ? relevantChunks : [])
    .map((c) => String(c?.document ?? c?.text ?? ''))
    .join('\n');
  const found = extractTripleRatiosFromText(text);

  const expectedParsed = expectedVariants
    .map((raw) => ({ raw, triple: parseTripleRatio(raw) }))
    .filter((x) => x.triple && !x.triple.some((n) => Number.isNaN(n)));
  if (expectedParsed.length === 0) return null;

  const covered = [];
  const uncovered = [];
  for (const { raw, triple } of expectedParsed) {
    const hit = found.some((ft) => triplesClose(ft, triple));
    if (hit) covered.push(raw);
    else uncovered.push(raw);
  }

  if (covered.length === 0) return null;
  if (uncovered.length === 0) return null;

  return { covered, uncovered, gap_type: 'no_variation' };
}
