/**
 * Constraint → experiment plan (Milestone 2 precursor, David ISM-001).
 * Rule → structured experiments + methods + expected failure pattern.
 * No DB; data from data/ism001_experiment_plan.json
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ISM001_PATH = join(__dirname, '..', 'data', 'ism001_experiment_plan.json');

let _doc = null;

function loadIsm001() {
  if (_doc) return _doc;
  const raw = readFileSync(ISM001_PATH, 'utf8');
  _doc = JSON.parse(raw);
  return _doc;
}

/**
 * @param {string} ruleId — e.g. "ISM-001"
 * @returns {{
 *   rule_id: string,
 *   observable_map: object[],
 *   measurement_methods: { method: string, measurement: string }[],
 *   recommended_experiments: { id: number, line: string }[],
 *   expected_failure_pattern: string
 * }}
 */
export function experimentPlanFromRule(ruleId) {
  const id = String(ruleId || '').trim().toUpperCase().replace(/\s+/g, '');
  if (id !== 'ISM-001') {
    throw new Error(`experimentPlanFromRule: unsupported rule_id "${ruleId}" (only ISM-001 is implemented).`);
  }
  const doc = loadIsm001();
  return {
    rule_id: doc.rule_id,
    observable_map: doc.observable_map,
    measurement_methods: doc.test_protocol,
    recommended_experiments: doc.recommended_experiments.map((e) => ({
      id: e.id,
      line: e.line,
    })),
    expected_failure_pattern: doc.expected_failure_pattern,
  };
}

/** Human-readable block (e.g. for logs / email to client). */
export function formatExperimentPlanText(plan) {
  const lines = [];
  lines.push(`Rule: ${plan.rule_id}`);
  lines.push('');
  lines.push('Recommended experiments:');
  for (const ex of plan.recommended_experiments) {
    lines.push(`- ${ex.line}`);
  }
  lines.push('');
  lines.push('Measurement methods (from Test_Protocol):');
  for (const m of plan.measurement_methods) {
    lines.push(`- ${m.method}: ${m.measurement}`);
  }
  lines.push('');
  lines.push('Expected failure pattern:');
  lines.push(plan.expected_failure_pattern);
  return lines.join('\n');
}
