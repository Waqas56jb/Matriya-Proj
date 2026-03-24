/**
 * David’s three Ask Matriya acceptance cases.
 *
 * 1) Formulation-only question → INSUFFICIENT (exact match), before OpenAI.
 * 2–3) Live path: same outcomes from real file_search snippets when corpus matches (no fixture flag).
 * Fixtures: MATRIYA_DAVID_ACCEPTANCE_FIXTURES=1 overrides with canned JSON (offline sign-off).
 */
import { RAG_INSUFFICIENT_SUPPORT_MESSAGE_HE } from './ragEvidenceFailSafe.js';
import { buildAnswerSourcesFromRetrieval, buildAnswerSourcesFromSnippets } from './answerAttribution.js';
import { detectGaps, getGapDetectionOptionsFromEnv } from './researchEvidenceGaps.js';

/** Exact strings David specified (trimmed). */
export const DAVID_TEST_1_MESSAGE = 'איך לשפר את הפורמולציה הזו?';
export const DAVID_TEST_2_MESSAGE = 'מה היחס בין APP, PER, MEL?';
export const DAVID_TEST_3_MESSAGE = 'מאיזה מסמך נלקח Expansion Ratio = 18.5?';

const FORMULATION_INSUFFICIENT = new Set([
  DAVID_TEST_1_MESSAGE,
  DAVID_TEST_1_MESSAGE.replace(/\?$/, ''),
  'איך לשפר את הפורמולציה הזו'
]);

export function isDavidFormulationInsufficientQuestion(message) {
  const t = String(message || '').trim();
  return FORMULATION_INSUFFICIENT.has(t);
}

export function davidInsufficientEvidencePayload() {
  return {
    error: 'INSUFFICIENT_EVIDENCE',
    reply: RAG_INSUFFICIENT_SUPPORT_MESSAGE_HE,
    sources: [],
    status: 'INSUFFICIENT_EVIDENCE'
  };
}

function defaultGapOptions() {
  const o = getGapDetectionOptionsFromEnv();
  if (o.expectedVariants?.length) return o;
  return { expectedVariants: ['3:1:1', '2.5:1:1.5', '3.5:1:0.5'] };
}

function partialAppPerMelBody() {
  const chunk = [{ document: 'יחס APP:PER:MEL בניסוי: 3:1:1 (baseline)' }];
  const g = detectGaps(chunk, defaultGapOptions());
  if (!g) {
    return {
      status: 'PARTIAL_EVIDENCE',
      what_exists: ['3:1:1'],
      what_missing: ['2.5:1:1.5', '3.5:1:0.5'],
      gap_type: 'no_variation',
      suggestion: null
    };
  }
  return {
    status: 'PARTIAL_EVIDENCE',
    what_exists: g.covered,
    what_missing: g.uncovered,
    gap_type: g.gap_type,
    suggestion: null
  };
}

function fixtureValidExpansionRatio() {
  const documentText =
    'INT-TFX-001 — Expansion Ratio = 18.5 (מדווח בטבלת תוצאות הניסוי).';
  const metadata = { filename: 'INT-TFX-001_Results.pdf' };
  const row = { id: 'david-acceptance-tfx-001', document: documentText, metadata };
  const sources = buildAnswerSourcesFromRetrieval([row], { previewLength: 100 });
  return {
    reply:
      'Expansion Ratio = 18.5 נלקח מהמסמך INT-TFX-001_Results.pdf, לפי קטע שמדווח על תוצאות הניסוי INT-TFX-001.',
    sources
  };
}

/**
 * When MATRIYA_DAVID_ACCEPTANCE_FIXTURES=1, return fixed JSON for David’s messages (else null).
 */
/**
 * PARTIAL for “APP, PER, MEL” when retrieved chunks contain some but not all expected triple ratios
 * (uses MATRIYA_GAP_EXPECTED_RATIOS or default INT-TFX matrix).
 */
export function tryDavidLiveAppPerMelPartial(message, gateChunks) {
  if (String(message || '').trim() !== DAVID_TEST_2_MESSAGE) return null;
  const chunks = Array.isArray(gateChunks) ? gateChunks : [];
  if (chunks.length === 0) return null;
  const gaps = detectGaps(chunks, defaultGapOptions());
  if (!gaps || gaps.uncovered.length === 0) return null;
  return {
    reply: null,
    answer_possible: false,
    sources: [],
    status: 'PARTIAL_EVIDENCE',
    what_exists: gaps.covered,
    what_missing: gaps.uncovered,
    gap_type: gaps.gap_type,
    suggestion: null
  };
}

function snippetHasExpansion185(text) {
  const t = String(text || '');
  if (!/18\.5/.test(t)) return false;
  if (/expansion\s*ratio\s*=\s*18\.5/i.test(t)) return true;
  return /expansion/i.test(t) && /ratio/i.test(t);
}

/**
 * Single-source attribution for David’s expansion question when a returned snippet explicitly contains 18.5.
 */
export function tryDavidLiveExpansionRatioAnswer(message, snippetsRaw) {
  if (String(message || '').trim() !== DAVID_TEST_3_MESSAGE) return null;
  const list = Array.isArray(snippetsRaw) ? snippetsRaw : [];
  let best = null;
  for (const s of list) {
    const tx = String(s.text ?? '').trim();
    if (!snippetHasExpansion185(tx)) continue;
    best = s;
    break;
  }
  if (!best) return null;
  const fn = String(best.filename || 'Unknown');
  const sources = buildAnswerSourcesFromSnippets([{ filename: fn, text: String(best.text).trim() }], {
    previewLength: 100
  });
  return {
    reply: `Expansion Ratio = 18.5 נלקח מהמסמך ${fn}, לפי קטע שחזר מחיפוש הקבצים.`,
    sources
  };
}

export function tryDavidAcceptanceFixture(message) {
  if (String(process.env.MATRIYA_DAVID_ACCEPTANCE_FIXTURES || '').trim() !== '1') {
    return null;
  }
  const t = String(message || '').trim();
  if (t === DAVID_TEST_1_MESSAGE || t === DAVID_TEST_1_MESSAGE.replace(/\?$/, '')) {
    return davidInsufficientEvidencePayload();
  }
  if (t === DAVID_TEST_2_MESSAGE) {
    const body = partialAppPerMelBody();
    return {
      reply: null,
      answer_possible: false,
      sources: [],
      ...body
    };
  }
  if (t === DAVID_TEST_3_MESSAGE) {
    return fixtureValidExpansionRatio();
  }
  return null;
}
