/**
 * Verifies all four pre-LLM research gate outcomes (deterministic checks).
 * No DB required for 1–4 unit checks; optional async check when DB is configured.
 *
 * Run: npm run check:pre-llm-gate
 */
import {
  evaluatePreLlmEvidenceGate,
  evaluatePreLlmEvidencePhase,
  evaluatePreLlmFsmGateOnly,
  evaluatePreLlmIntegrityGate,
  evaluatePreLlmResearchGate,
  retrievalSimilarityForGate
} from '../researchGate.js';
import { detectGaps } from '../lib/researchEvidenceGaps.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const chunk = (text, metric, rel, dist) => ({
  document: text,
  evidence_metric: metric,
  relevance_score: rel,
  distance: dist
});

const twoStrong = [
  chunk('a'.repeat(20), 'openai_rank', 0.9, 0.15),
  chunk('b'.repeat(20), 'openai_rank', 0.85, 0.16)
];

console.log('--- 1. INSUFFICIENT_EVIDENCE (no chunks) ---');
{
  const r = evaluatePreLlmEvidenceGate([]);
  assert(r.ok === false && r.httpStatus === 422 && r.code === 'INSUFFICIENT_EVIDENCE', String(r.code));
}

console.log('--- 1b. INSUFFICIENT_EVIDENCE (no substantive text) ---');
{
  const r = evaluatePreLlmEvidenceGate([{ document: 'short', evidence_metric: 'openai_rank', relevance_score: 1, distance: 0.15 }]);
  assert(r.code === 'INSUFFICIENT_EVIDENCE', r.code);
}

console.log('--- 2. PARTIAL_EVIDENCE (single strong chunk, no gap matrix) ---');
{
  const oneAt076 = [
    {
      document: 'x'.repeat(20),
      evidence_metric: 'openai_rank',
      relevance_score: 0.76,
      distance: 0.15,
      metadata: { filename: 'doc-a.pdf' }
    }
  ];
  const ph = evaluatePreLlmEvidencePhase(oneAt076);
  assert(ph.outcome === 'partial', String(ph.outcome));
  assert(ph.body.status === 'PARTIAL_EVIDENCE' && ph.body.suggestion === null, 'partial body');
  assert(Array.isArray(ph.body.what_exists) && ph.body.what_exists.some((x) => String(x).includes('doc-a.pdf')), 'what_exists');
  assert(Array.isArray(ph.body.what_missing) && ph.body.what_missing.length >= 1, 'what_missing');
  assert(Array.isArray(ph.body.sources) && ph.body.sources.length === 1, 'sources from retrieval');
  const r = evaluatePreLlmEvidenceGate(oneAt076);
  assert(r.ok === false && r.httpStatus === 422 && r.code === 'PARTIAL_EVIDENCE', r.code);
}

console.log('--- 2b. INSUFFICIENT_EVIDENCE (two chunks below similarity threshold) ---');
{
  const weakPair = [
    chunk('a'.repeat(20), 'cosine', 0.5, 0.5),
    chunk('b'.repeat(20), 'cosine', 0.5, 0.5)
  ];
  const r = evaluatePreLlmEvidenceGate(weakPair);
  assert(r.code === 'INSUFFICIENT_EVIDENCE', r.code);
}

console.log('--- 2c. Evidence pass (two strong OpenAI-ranked chunks) ---');
assert(evaluatePreLlmEvidenceGate(twoStrong).ok === true, 'two strong should pass evidence gate');

console.log('--- 3. INVALID_STATE_TRANSITION (FSM: skip to C with empty completed) ---');
{
  const r = evaluatePreLlmFsmGateOnly({ stage: 'C', completedStages: [] });
  assert(r.ok === false && r.httpStatus === 409 && r.code === 'INVALID_STATE_TRANSITION', r.code);
}

console.log('--- 3b. FSM allow first stage K ---');
assert(evaluatePreLlmFsmGateOnly({ stage: 'K', completedStages: [] }).ok === true, 'K first');

console.log('--- 4. INTEGRITY_VIOLATION (mock active violation row) ---');
{
  const r = evaluatePreLlmIntegrityGate({ id: 4242 });
  assert(r.ok === false && r.httpStatus === 422 && r.code === 'INTEGRITY_VIOLATION' && r.violation_id === 4242, r.code);
}
assert(evaluatePreLlmIntegrityGate(null).ok === true, 'no violation → ok');

console.log('--- Integration: evaluatePreLlmResearchGate stops at FSM (no DB hit for invalid stage) ---');
{
  const sid = '00000000-0000-4000-8000-000000000099';
  const r = await evaluatePreLlmResearchGate({
    sessionId: sid,
    stage: 'N',
    completedStages: [],
    searchResults: twoStrong
  });
  assert(r.ok === false && r.code === 'INVALID_STATE_TRANSITION', `expected FSM deny, got ${r.code}`);
}

console.log('--- retrievalSimilarityForGate (cosine path) ---');
assert(
  retrievalSimilarityForGate({ document: 'y'.repeat(20), evidence_metric: 'cosine', distance: 0.8 }) > 0.75,
  'cosine metric'
);

console.log('--- 5. detectGaps (triple ratios) ---');
{
  const g = detectGaps([{ document: 'ניסוי ביחס 3:1:1 לעומת baseline' }], {
    expectedVariants: ['3:1:1', '2.5:1:1.5', '3.5:1:0.5']
  });
  assert(g && g.covered.includes('3:1:1') && g.uncovered.length === 2, 'gaps covered/uncovered');
  assert(g.gap_type === 'no_variation', 'gap_type');
}

console.log('--- 5b. PARTIAL_EVIDENCE via evaluatePreLlmEvidencePhase (env matrix) ---');
{
  const prev = process.env.MATRIYA_GAP_EXPECTED_RATIOS;
  process.env.MATRIYA_GAP_EXPECTED_RATIOS = '3:1:1,2.5:1:1.5,3.5:1:0.5';
  const oneRatioChunk = [
    chunk(`INT-TFX ${'z'.repeat(12)} יחס 3:1:1 במסמך`, 'openai_rank', 0.9, 0.15)
  ];
  const ph = evaluatePreLlmEvidencePhase(oneRatioChunk);
  assert(ph.outcome === 'partial', String(ph.outcome));
  assert(ph.body.status === 'PARTIAL_EVIDENCE' && ph.body.suggestion === null, 'partial body');
  assert(Array.isArray(ph.body.what_exists) && ph.body.what_exists.includes('3:1:1'), 'what_exists');
  assert(Array.isArray(ph.body.what_missing) && ph.body.what_missing.length === 2, 'what_missing');
  assert(Array.isArray(ph.body.sources) && ph.body.sources.length === 1, 'sources bound to chunk');
  if (prev === undefined) delete process.env.MATRIYA_GAP_EXPECTED_RATIOS;
  else process.env.MATRIYA_GAP_EXPECTED_RATIOS = prev;
}

console.log('');
console.log('check-pre-llm-gate: all 4 gate types + partial + integration OK');
