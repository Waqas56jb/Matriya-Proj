#!/usr/bin/env node
/**
 * David — Constraint Engine operational: lab-shaped input triggers ISM-001
 * (surface hydrophobic, no bulk penetration) with expected follow-up experiments.
 * Does not assert decision_status (analytical layer only).
 */
import assert from 'assert';
import { composeAnswer } from '../services/answerComposer.js';

const surfaceHydrophobicNoPenetrationLab = {
  source_run_ids: ['run-a', 'run-b'],
  data_grade: 'REAL',
  run_type: 'CONTROLLED_OVAT',
  conclusion_status: 'VALID_CONCLUSION',
  baseline_run_id: 'run-b',
  delta_summary: {
    max_delta_pct: 12,
    ph_delta: -0.05,
    dominant_channel: 'v6',
    channels: [],
  },
  detail: {
    material_delta: { identical: true },
    outcome_signals: {
      penetration_evidence: 'none',
      surface_wetting: 'hydrophobic',
    },
  },
};

const out = await composeAnswer('lab constraint probe', surfaceHydrophobicNoPenetrationLab, null, {
  skipExternalFetch: true,
});

assert.strictEqual(out.decision_status, 'VALID_CONCLUSION', 'decision must be unchanged by constraint layer');

const rules = out.constraint_rules;
assert.ok(Array.isArray(rules), 'constraint_rules must be an array');
assert.ok(rules.length >= 1, 'ISM-001 must be present for surface / no-penetration lab');

const ism = rules.find((r) => r && r.rule_id === 'ISM-001');
assert.ok(ism, 'ISM-001 entry missing');
assert.strictEqual(ism.matched, true);
assert.ok(typeof ism.confidence === 'number' && ism.confidence >= 0 && ism.confidence <= 1);
assert.ok(
  typeof ism.expected_failure_pattern === 'string' && ism.expected_failure_pattern.length > 0,
  'expected_failure_pattern required'
);

const lines = (ism.recommended_experiments || []).map((e) => String(e.line || '').toLowerCase()).join(' | ');
assert.ok(lines.includes('penetration'), `expected penetration depth experiment, got: ${lines}`);
assert.ok(lines.includes('ftir'), `expected FTIR cross-section experiment, got: ${lines}`);
assert.ok(
  lines.includes('abrasion') && lines.includes('contact angle'),
  `expected abrasion + contact angle experiment, got: ${lines}`
);

console.log('[PASS] verify-lab-constraint-rules.js');
