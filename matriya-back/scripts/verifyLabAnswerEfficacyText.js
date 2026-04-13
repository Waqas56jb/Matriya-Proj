#!/usr/bin/env node
/**
 * David / Milestone 1 — efficacy answer must expose only the active decision in one line:
 * - VALID_CONCLUSION case: no substring INCONCLUSIVE in `answer`
 * - INCONCLUSIVE case: no substring VALID_CONCLUSION in `answer`
 * - Shapes match buildNaturalLanguageAnswer (composeAnswer).
 */
import assert from 'assert';
import { composeAnswer } from '../services/answerComposer.js';

const labValid = {
  source_run_ids: ['a', 'b'],
  data_grade: 'REAL',
  run_type: 'CONTROLLED_OVAT',
  conclusion_status: 'VALID_CONCLUSION',
  baseline_run_id: 'b',
  delta_summary: { max_delta_pct: 16.67 },
};

const outValid = await composeAnswer('BASE-003', labValid, null, { skipExternalFetch: true });
assert.strictEqual(outValid.decision_status, 'VALID_CONCLUSION');
assert.match(
  outValid.answer,
  /^max_delta \(\d+(?:\.\d+)?%\) ≥ threshold \(\d+(?:\.\d+)?%\) → VALID_CONCLUSION$/,
  `expected David display line shape, got: ${JSON.stringify(outValid.answer)}`
);
assert.ok(
  !/\bINCONCLUSIVE\b/i.test(outValid.answer),
  'VALID case: answer must not mention INCONCLUSIVE'
);

const labInc = {
  source_run_ids: ['a', 'b'],
  data_grade: 'REAL',
  run_type: 'CONTROLLED_OVAT',
  conclusion_status: 'VALID_CONCLUSION',
  baseline_run_id: 'b',
  delta_summary: { max_delta_pct: 5 },
};
const outInc = await composeAnswer('q', labInc, null, { skipExternalFetch: true });
assert.strictEqual(outInc.decision_status, 'INCONCLUSIVE');
assert.match(
  outInc.answer,
  /^max_delta \(\d+(?:\.\d+)?%\) < threshold \(\d+(?:\.\d+)?%\) → INCONCLUSIVE$/,
  `expected INCONCLUSIVE one-line shape, got: ${JSON.stringify(outInc.answer)}`
);
assert.ok(
  !/\bVALID_CONCLUSION\b/i.test(outInc.answer),
  'INCONCLUSIVE case: answer must not mention VALID_CONCLUSION'
);

console.log('[PASS] verifyLabAnswerEfficacyText.js');
