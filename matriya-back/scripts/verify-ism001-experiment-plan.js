#!/usr/bin/env node
import assert from 'assert';
import { experimentPlanFromRule, formatExperimentPlanText } from '../services/ruleToExperimentPlan.js';

const p = experimentPlanFromRule('ISM-001');
assert.strictEqual(p.rule_id, 'ISM-001');
assert.strictEqual(p.recommended_experiments.length, 3);
assert.strictEqual(p.measurement_methods.length, 3);
assert.ok(p.expected_failure_pattern.includes('Surface hydrophobicity'));
const txt = formatExperimentPlanText(p);
assert.ok(txt.includes('Experiment 1: measure penetration depth'));
assert.ok(txt.includes('Expected failure pattern:'));

let threw = false;
try {
  experimentPlanFromRule('ISM-002');
} catch {
  threw = true;
}
assert.ok(threw, 'unknown rule must throw');

console.log('[PASS] verify-ism001-experiment-plan.js');
