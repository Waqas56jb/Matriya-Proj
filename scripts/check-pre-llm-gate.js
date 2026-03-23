/**
 * Verifies all four pre-LLM research gate outcomes (deterministic checks).
 * No DB required for 1–4 unit checks; optional async check when DB is configured.
 *
 * Run: npm run check:pre-llm-gate
 */
import {
  evaluatePreLlmEvidenceGate,
  evaluatePreLlmFsmGateOnly,
  evaluatePreLlmIntegrityGate,
  evaluatePreLlmResearchGate,
  retrievalSimilarityForGate
} from '../researchGate.js';

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

console.log('--- 2. LOW_CONFIDENCE_EVIDENCE (single strong chunk) ---');
{
  const oneAt076 = [chunk('x'.repeat(20), 'openai_rank', 0.76, 0.15)];
  const r = evaluatePreLlmEvidenceGate(oneAt076);
  assert(r.ok === false && r.httpStatus === 422 && r.code === 'LOW_CONFIDENCE_EVIDENCE', r.code);
}

console.log('--- 2b. LOW_CONFIDENCE (two chunks but similarity below threshold) ---');
{
  const weakPair = [
    chunk('a'.repeat(20), 'cosine', 0.5, 0.5),
    chunk('b'.repeat(20), 'cosine', 0.5, 0.5)
  ];
  const r = evaluatePreLlmEvidenceGate(weakPair);
  assert(r.code === 'LOW_CONFIDENCE_EVIDENCE', r.code);
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

console.log('');
console.log('check-pre-llm-gate: all 4 gate types + integration OK');
