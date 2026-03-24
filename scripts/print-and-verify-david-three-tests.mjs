/**
 * Prints the three David acceptance JSON bodies and validates shape (no HTTP, no JWT).
 *
 * Run:
 *   npm run verify:david-three
 *
 * Same JSON from live POST /ask-matriya when:
 *   MATRIYA_DAVID_ACCEPTANCE_FIXTURES=1
 * (plus Bearer auth). Test 1 also passes without fixtures via formulation short-circuit.
 */
import assert from 'assert';
import {
  tryDavidAcceptanceFixture,
  tryDavidLiveAppPerMelPartial,
  tryDavidLiveExpansionRatioAnswer,
  isDavidFormulationInsufficientQuestion,
  davidInsufficientEvidencePayload,
  DAVID_TEST_1_MESSAGE,
  DAVID_TEST_2_MESSAGE,
  DAVID_TEST_3_MESSAGE
} from '../lib/davidAskMatriyaAcceptance.js';

process.env.MATRIYA_GAP_EXPECTED_RATIOS =
  process.env.MATRIYA_GAP_EXPECTED_RATIOS || '3:1:1,2.5:1:1.5,3.5:1:0.5';

function assertInsufficient(obj) {
  assert.strictEqual(obj.error, 'INSUFFICIENT_EVIDENCE');
  assert.strictEqual(obj.status, 'INSUFFICIENT_EVIDENCE');
  assert.deepStrictEqual(obj.sources, []);
  assert.strictEqual(typeof obj.reply, 'string');
}

function assertPartial(obj) {
  assert.strictEqual(obj.status, 'PARTIAL_EVIDENCE');
  assert.strictEqual(obj.answer_possible, false);
  assert.strictEqual(obj.suggestion, null);
  assert.deepStrictEqual(obj.sources, []);
  assert.strictEqual(obj.reply, null);
  assert.ok(Array.isArray(obj.what_exists) && obj.what_exists.length >= 1);
  assert.ok(Array.isArray(obj.what_missing) && obj.what_missing.length >= 1);
}

function assertValid(obj) {
  assert.ok(obj.reply && typeof obj.reply === 'string');
  assert.ok(Array.isArray(obj.sources) && obj.sources.length === 1);
  const s = obj.sources[0];
  assert.ok(s.source_id);
  assert.ok(s.document_name);
  assert.ok(s.preview);
  assert.ok(obj.reply.includes('18.5'));
  assert.ok(s.preview.includes('18.5') || s.preview.includes('Expansion'));
}

console.log('=== Test 1 — fixture off returns null; fixture on = INSUFFICIENT ===\n');
process.env.MATRIYA_DAVID_ACCEPTANCE_FIXTURES = '0';
assert.strictEqual(tryDavidAcceptanceFixture(DAVID_TEST_1_MESSAGE), null);
assert.strictEqual(isDavidFormulationInsufficientQuestion(DAVID_TEST_1_MESSAGE), true);

process.env.MATRIYA_DAVID_ACCEPTANCE_FIXTURES = '1';
const r1 = tryDavidAcceptanceFixture(DAVID_TEST_1_MESSAGE);
assertInsufficient(r1);
console.log(JSON.stringify(r1, null, 2));

console.log('\n=== Test 2 — PARTIAL_EVIDENCE (fixtures) ===\n');
const r2 = tryDavidAcceptanceFixture(DAVID_TEST_2_MESSAGE);
assertPartial(r2);
console.log(JSON.stringify(r2, null, 2));

console.log('\n=== Test 3 — VALID (one source, bound to chunk) ===\n');
const r3 = tryDavidAcceptanceFixture(DAVID_TEST_3_MESSAGE);
assertValid(r3);
console.log(JSON.stringify(r3, null, 2));

console.log('\n=== Test 1 — formulation short-circuit payload (no fixture flag) ===\n');
const q1 = davidInsufficientEvidencePayload();
assertInsufficient(q1);
console.log(JSON.stringify(q1, null, 2));

console.log('\n=== Live path (no fixture): Q2 from gateChunks with one triple ===\n');
{
  process.env.MATRIYA_GAP_EXPECTED_RATIOS = '3:1:1,2.5:1:1.5,3.5:1:0.5';
  const gateChunks = [
    {
      document: 'APP PER MEL יחס 3:1:1 בניסוי',
      text: 'APP PER MEL יחס 3:1:1 בניסוי',
      metadata: { filename: 'x.pdf' },
      evidence_metric: 'openai_rank',
      relevance_score: 1
    }
  ];
  const lp = tryDavidLiveAppPerMelPartial(DAVID_TEST_2_MESSAGE, gateChunks);
  assertPartial(lp);
  console.log(JSON.stringify(lp, null, 2));
}

console.log('\n=== Live path (no fixture): Q3 from snippets with Expansion Ratio = 18.5 ===\n');
{
  const snips = [
    { filename: 'noise.pdf', text: 'כללי ' + 'z'.repeat(20) },
    { filename: 'INT-TFX-001_Results.pdf', text: 'INT-TFX-001 Expansion Ratio = 18.5 בטבלה ' + 'y'.repeat(15) }
  ];
  const le = tryDavidLiveExpansionRatioAnswer(DAVID_TEST_3_MESSAGE, snips);
  assertValid(le);
  assert.strictEqual(le.sources[0].document_name, 'INT-TFX-001_Results.pdf');
  console.log(JSON.stringify(le, null, 2));
}

console.log('\nverify:david-three — all assertions OK');
