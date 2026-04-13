#!/usr/bin/env node
/**
 * PASS checks for services/answerComposer.js (David).
 * - decision_status always one of six allowed values
 * - no VALID_CONCLUSION when data_grade !== REAL or empty run_ids or delta < threshold
 * - NON_CONTROLLED → INVALID_EXPERIMENT
 * - delta vs threshold overrides lab conclusion_status when comparable
 * - external_context only when decision !== VALID_CONCLUSION; never changes decision
 */
import assert from 'assert';
import { buildDecisionStatus, composeAnswer, computeDecisionStatusFromLab } from '../services/answerComposer.js';

function eq(a, b) {
  assert.strictEqual(a, b);
}

eq(
  buildDecisionStatus({ source_run_ids: [], data_grade: 'REAL', conclusion_status: 'VALID_CONCLUSION' }),
  'INSUFFICIENT_DATA'
);
eq(computeDecisionStatusFromLab({ source_run_ids: [] }), 'INSUFFICIENT_DATA');

eq(
  buildDecisionStatus({
    source_run_ids: ['a'],
    data_grade: 'HISTORICAL_REFERENCE',
    conclusion_status: 'VALID_CONCLUSION',
    delta_summary: { max_delta_pct: 99 },
  }),
  'REFERENCE_ONLY'
);

eq(
  buildDecisionStatus({
    source_run_ids: ['a'],
    data_grade: 'REAL',
    run_type: 'NON_CONTROLLED',
    conclusion_status: 'VALID_CONCLUSION',
    delta_summary: { max_delta_pct: 99 },
  }),
  'INVALID_EXPERIMENT'
);

eq(
  buildDecisionStatus({
    source_run_ids: ['a', 'b'],
    data_grade: 'REAL',
    run_type: 'CONTROLLED_OVAT',
    conclusion_status: 'VALID_CONCLUSION',
    delta_summary: { max_delta_pct: 15 },
  }),
  'VALID_CONCLUSION'
);

eq(
  buildDecisionStatus({
    source_run_ids: ['a', 'b'],
    data_grade: 'REAL',
    run_type: 'CONTROLLED_OVAT',
    conclusion_status: 'VALID_CONCLUSION',
    delta_summary: { max_delta_pct: 5 },
  }),
  'INCONCLUSIVE'
);

eq(
  buildDecisionStatus({
    source_run_ids: ['a', 'b'],
    data_grade: 'REAL',
    run_type: 'CONTROLLED_OVAT',
    conclusion_status: 'INCONCLUSIVE',
    delta_summary: { max_delta_pct: 20 },
  }),
  'VALID_CONCLUSION'
);

const lab1 = {
  source_run_ids: ['x'],
  data_grade: 'REAL',
  run_type: 'REPLICATION',
  conclusion_status: 'INCONCLUSIVE',
  delta_summary: { max_delta_pct: 5 },
};
const c1 = await composeAnswer('q', lab1, null, { skipExternalFetch: true });
const c2 = await composeAnswer('q', lab1, null, { skipExternalFetch: true });
assert.strictEqual(JSON.stringify(c1), JSON.stringify(c2));
assert.ok(c1.blocked_reason);
assert.strictEqual(c1.decision_status, 'INCONCLUSIVE');

const valid = await composeAnswer(
  'q',
  {
    source_run_ids: ['b', 'a'],
    data_grade: 'REAL',
    run_type: 'CONTROLLED_OVAT',
    conclusion_status: 'VALID_CONCLUSION',
    baseline_run_id: 'a',
    delta_summary: { max_delta_pct: 20 },
  },
  null,
  { skipExternalFetch: true }
);
assert.strictEqual(valid.decision_status, 'VALID_CONCLUSION');
assert.strictEqual(valid.blocked_reason, null);
assert.deepStrictEqual(valid.external_context, []);

const poison = [{ _would_never: 'VALID_CONCLUSION' }];
const withExt = await composeAnswer('q', lab1, poison, { skipExternalFetch: true });
assert.strictEqual(withExt.decision_status, 'INCONCLUSIVE');
assert.ok(Array.isArray(withExt.external_context) && withExt.external_context.length > 0);

const keys = Object.keys(valid).sort();
assert.deepStrictEqual(keys, [
  'answer',
  'blocked_reason',
  'constraint_rules',
  'decision_status',
  'decision_trace',
  'evidence',
  'external_context',
  'next_step',
]);
assert.ok(Array.isArray(valid.constraint_rules));

console.log('[PASS] answerComposer checks');
