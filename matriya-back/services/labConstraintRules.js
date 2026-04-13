/**
 * Lab-triggered constraint rules (ISM-001, etc.).
 * Analytical layer only: does not influence decision_status, evidence, or external_context.
 */

import { experimentPlanFromRule } from './ruleToExperimentPlan.js';

function num(x, def = NaN) {
  const n = Number(x);
  return Number.isFinite(n) ? n : def;
}

const MIN_CONFIDENCE = 0.35;

/**
 * ISM-001: surface barrier / hydrophobicity vs bulk penetration follow-up.
 *
 * Triggers when:
 * - Explicit outcome_signals (penetration none + hydrophobic surface), or
 * - REAL VALID_CONCLUSION with material unchanged, meaningful max_delta, small |ph_delta|
 *   or v6-dominant rheology proxy consistent with surface-dominated stress (no bulk chemistry shift).
 *
 * @param {object} lab — lab contract / composeAnswer lab input
 * @returns {{ matched: boolean, confidence: number }}
 */
function evaluateIsm001(lab) {
  if (!lab || typeof lab !== 'object') return { matched: false, confidence: 0 };

  const ds = lab.delta_summary && typeof lab.delta_summary === 'object' ? lab.delta_summary : {};
  const detail = lab.detail && typeof lab.detail === 'object' ? lab.detail : {};
  const md = detail.material_delta && typeof detail.material_delta === 'object' ? detail.material_delta : {};
  const os = detail.outcome_signals && typeof detail.outcome_signals === 'object' ? detail.outcome_signals : {};

  const phDeltaAbs = Math.abs(num(ds.ph_delta, NaN));
  const maxPct = num(ds.max_delta_pct, 0);
  const materialIdentical = md.identical === true;
  const pen = String(os.penetration_evidence || '').toLowerCase();
  const wet = String(os.surface_wetting || '').toLowerCase();

  if (pen === 'none' && wet === 'hydrophobic') {
    return { matched: true, confidence: 0.95 };
  }

  const phOk = Number.isFinite(phDeltaAbs) && phDeltaAbs <= 0.25;
  const v6Dom = String(ds.dominant_channel || '').toLowerCase() === 'v6';
  const surfaceProxy = phOk || (v6Dom && maxPct >= 12 && materialIdentical);

  const strongLab =
    lab.data_grade === 'REAL' &&
    lab.conclusion_status === 'VALID_CONCLUSION' &&
    maxPct >= 10 &&
    materialIdentical === true &&
    surfaceProxy;

  if (!strongLab) return { matched: false, confidence: 0 };

  let c = 0.55;
  if (v6Dom) c += 0.12;
  if (phOk && phDeltaAbs <= 0.12) c += 0.1;
  if (maxPct >= 15) c += 0.08;
  return { matched: true, confidence: Math.min(0.92, c) };
}

/**
 * @param {object|null|undefined} lab
 * @returns {Array<{
 *   rule_id: string,
 *   matched: boolean,
 *   confidence: number,
 *   recommended_experiments: { id: number, line: string }[],
 *   expected_failure_pattern: string
 * }>}
 */
export function evaluateConstraintRulesForLab(lab) {
  const out = [];
  if (!lab || typeof lab !== 'object') return out;

  const ism = evaluateIsm001(lab);
  if (!ism.matched || ism.confidence < MIN_CONFIDENCE) return out;

  try {
    const plan = experimentPlanFromRule('ISM-001');
    const confidence = Math.round(Math.min(1, Math.max(0, ism.confidence)) * 1000) / 1000;
    out.push({
      rule_id: 'ISM-001',
      matched: true,
      confidence,
      recommended_experiments: plan.recommended_experiments,
      expected_failure_pattern: plan.expected_failure_pattern,
    });
  } catch {
    /* isolation: bad plan file must not break composer */
  }
  return out;
}
