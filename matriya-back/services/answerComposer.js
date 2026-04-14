/**
 * Answer Composer — lab-only decisions, mandatory JSON contract (David).
 *
 * - decision_status is derived ONLY from labResult (never from external_context).
 * - No VALID_CONCLUSION unless data_grade === REAL', comparable delta, and delta ≥ threshold.
 * - Efficacy mapping: decideEfficacyFromDelta(max_delta, threshold) only; natural-language answer for that branch is a single line (active outcome only — no alternate-branch prose).
 * - external_context is attached only after decision is fixed; it MUST NOT affect decision_status.
 * - constraint_rules: optional analytical layer from evaluateConstraintRulesForLab(lab); never affects decision_status, evidence, or external_context.
 */

import axios from 'axios';
import assert from 'assert';
import { evaluateConstraintRulesForLab } from './labConstraintRules.js';

export const ALLOWED_DECISION_STATUSES = [
  'VALID_CONCLUSION',
  'INCONCLUSIVE',
  'INVALID_EXPERIMENT',
  'INSUFFICIENT_DATA',
  'STRUCTURAL_INCOMPLETE',
  'REFERENCE_ONLY',
];

const DEFAULT_THRESHOLD_PCT = parseFloat(process.env.LAB_VISCOSITY_THRESHOLD_PCT || '10', 10) || 10;

/**
 * Single source of truth for efficacy once preconditions pass: comparable max_delta_pct vs threshold only.
 * @returns {'VALID_CONCLUSION'|'INCONCLUSIVE'}
 */
export function decideEfficacyFromDelta(maxDeltaPct, thresholdPct) {
  const md = Number(maxDeltaPct);
  const thr = Number(thresholdPct);
  if (!Number.isFinite(md) || !Number.isFinite(thr)) {
    throw new Error('decideEfficacyFromDelta: maxDeltaPct and thresholdPct must be finite');
  }
  return md >= thr ? 'VALID_CONCLUSION' : 'INCONCLUSIVE';
}

/**
 * Lab-only decision. Never pass external_context or external fetches here.
 */
export function buildDecisionStatus(labResult) {
  if (!labResult || typeof labResult !== 'object') {
    return 'INSUFFICIENT_DATA';
  }

  // Formulation delta is evidence-backed by formulation_materials (not production_runs).
  // Decision here is informational only; never VALID_CONCLUSION.
  if (labResult.query_type === 'formulation_delta') {
    const lines = labResult.detail?.composition_delta?.delta_lines;
    if (Array.isArray(lines) && lines.length > 0) {
      return 'REFERENCE_ONLY';
    }
    return 'INSUFFICIENT_DATA';
  }

  const ids = Array.isArray(labResult.source_run_ids) ? labResult.source_run_ids : [];
  if (ids.length === 0) {
    return 'INSUFFICIENT_DATA';
  }

  if (labResult.data_grade !== 'REAL') {
    return 'REFERENCE_ONLY';
  }

  if (labResult.run_type === 'NON_CONTROLLED') {
    return 'INVALID_EXPERIMENT';
  }

  if (labResult.conclusion_status === 'STRUCTURAL_INCOMPLETE') {
    return 'STRUCTURAL_INCOMPLETE';
  }

  if (labResult.conclusion_status === 'INVALID_EXPERIMENT') {
    return 'INVALID_EXPERIMENT';
  }

  if (labResult.conclusion_status === 'INSUFFICIENT_DATA') {
    return 'INSUFFICIENT_DATA';
  }

  if (labResult.run_type === 'NO_BASELINE') {
    return 'INSUFFICIENT_DATA';
  }

  const rawMax = labResult.delta_summary?.max_delta_pct;
  const maxDelta = rawMax == null ? NaN : Number(rawMax);
  if (!Number.isFinite(maxDelta)) {
    return 'INSUFFICIENT_DATA';
  }

  return decideEfficacyFromDelta(maxDelta, DEFAULT_THRESHOLD_PCT);
}

/** True when buildDecisionStatus uses only max_delta vs threshold (no earlier gate). */
function labReachesDeltaComparison(labResult) {
  if (!labResult || typeof labResult !== 'object') return false;
  const ids = Array.isArray(labResult.source_run_ids) ? labResult.source_run_ids : [];
  if (ids.length === 0) return false;
  if (labResult.data_grade !== 'REAL') return false;
  if (labResult.run_type === 'NON_CONTROLLED') return false;
  if (labResult.conclusion_status === 'STRUCTURAL_INCOMPLETE') return false;
  if (labResult.conclusion_status === 'INVALID_EXPERIMENT') return false;
  if (labResult.conclusion_status === 'INSUFFICIENT_DATA') return false;
  if (labResult.run_type === 'NO_BASELINE') return false;
  const rawMax = labResult.delta_summary?.max_delta_pct;
  const maxDelta = rawMax == null ? NaN : Number(rawMax);
  return Number.isFinite(maxDelta);
}

function buildDecisionTrace(labResult, finalDecisionStatus) {
  if (!labResult || typeof labResult !== 'object') return null;
  const rawMax = labResult.delta_summary?.max_delta_pct;
  const md = rawMax == null ? null : Number(rawMax);
  const thr = DEFAULT_THRESHOLD_PCT;
  const efficacy_branch = labReachesDeltaComparison(labResult);
  return {
    efficacy_branch,
    input: {
      data_grade: labResult.data_grade ?? null,
      run_type: labResult.run_type ?? null,
      conclusion_status: labResult.conclusion_status ?? null,
      source_run_ids: Array.isArray(labResult.source_run_ids) ? [...labResult.source_run_ids] : [],
    },
    delta_vs_threshold: {
      max_delta_pct: Number.isFinite(md) ? md : null,
      threshold_pct: thr,
    },
    decision_status: finalDecisionStatus,
  };
}

/** @deprecated use buildDecisionStatus */
export function computeDecisionStatusFromLab(labResult) {
  return buildDecisionStatus(labResult);
}

function evidenceDataGrade(labResult) {
  return labResult?.data_grade === 'REAL' ? 'REAL' : 'HISTORICAL_REFERENCE';
}

function buildEvidence(labResult, decisionStatus) {
  const ds =
    labResult?.delta_summary && typeof labResult.delta_summary === 'object'
      ? { ...labResult.delta_summary }
      : {};

  const thresholdApplies = decisionStatus === 'VALID_CONCLUSION' || decisionStatus === 'INCONCLUSIVE';

  return {
    run_ids: Array.isArray(labResult?.source_run_ids) ? [...labResult.source_run_ids] : [],
    baseline_run_id: labResult?.baseline_run_id ?? null,
    data_grade: evidenceDataGrade(labResult),
    delta_summary: ds,
    threshold: thresholdApplies ? DEFAULT_THRESHOLD_PCT : null,
  };
}

function buildNaturalLanguageAnswer(query, labResult, decisionStatus, evidence) {
  // Delta/Comparison layer (David): show computed component deltas, not copied text.
  if (labResult?.query_type === 'formulation_delta') {
    const lines = labResult.detail?.composition_delta?.delta_lines;
    if (Array.isArray(lines) && lines.length > 0) {
      return lines.join('\n');
    }
    return 'אין במערכת מידע תומך לשאלה זו.';
  }

  const thr = evidence.threshold;
  const mdRaw = labResult?.delta_summary?.max_delta_pct;
  const mdNum = mdRaw == null ? NaN : Number(mdRaw);
  const thrNum = thr == null ? NaN : Number(thr);

  // Milestone 1 closure (David): efficacy branch — answer is ONLY one line, active decision only (no alternate branch text).
  if (
    (decisionStatus === 'VALID_CONCLUSION' || decisionStatus === 'INCONCLUSIVE') &&
    Number.isFinite(mdNum) &&
    Number.isFinite(thrNum)
  ) {
    if (decisionStatus === 'VALID_CONCLUSION') {
      return `max_delta (${mdNum}%) ≥ threshold (${thrNum}%) → VALID_CONCLUSION`;
    }
    return `max_delta (${mdNum}%) < threshold (${thrNum}%) → INCONCLUSIVE`;
  }

  const qt = labResult?.query_type ?? 'lab_query';
  const q = typeof query === 'string' && query.trim() ? query.trim().slice(0, 200) : '(structured lab request)';
  const parts = [`Query: ${q}`, `[${qt}]`];

  parts.push(`Data grade (evidence): ${evidence.data_grade}.`);

  if (evidence.run_ids.length) {
    parts.push(`Runs (evidence.run_ids): ${evidence.run_ids.join(', ')}.`);
  } else {
    parts.push('Runs (evidence.run_ids): (none — empty array per contract).');
  }

  if (Number.isFinite(mdNum) && Number.isFinite(thrNum)) {
    parts.push(`max_delta (${mdNum}%) vs threshold (${thrNum}%) — see decision_status.`);
  } else if (decisionStatus === 'INSUFFICIENT_DATA' && evidence.run_ids.length && labResult?.data_grade === 'REAL') {
    parts.push('Comparable delta vs threshold could not be established (missing or non-finite max_delta_pct).');
  }

  if (labResult?.blocked_reason && decisionStatus !== 'VALID_CONCLUSION') {
    parts.push(`Lab note: ${labResult.blocked_reason}`);
  }

  return parts.join(' ');
}

export function generateBlockedReason(labResult, decisionStatus) {
  if (decisionStatus === 'VALID_CONCLUSION') {
    return null;
  }
  if (labResult?.blocked_reason) {
    return String(labResult.blocked_reason);
  }
  switch (decisionStatus) {
    case 'INSUFFICIENT_DATA':
      return 'No valid conclusion: missing runs, missing comparable delta, lab INSUFFICIENT_DATA, or baseline gap.';
    case 'REFERENCE_ONLY':
      return 'No causal conclusion: data_grade is not REAL on the compared evidence channel.';
    case 'INVALID_EXPERIMENT':
      return 'No conclusion: NON_CONTROLLED or INVALID_EXPERIMENT — OVAT / validity requirements failed.';
    case 'STRUCTURAL_INCOMPLETE':
      return 'No conclusion: FSCTM structural completeness not satisfied on the lab record.';
    case 'INCONCLUSIVE':
      return `No definitive efficacy conclusion: max delta is below the ${DEFAULT_THRESHOLD_PCT}% threshold (or lab marked inconclusive with comparable delta).`;
    default:
      return 'No valid scientific conclusion under the current lab contract.';
  }
}

export function generateNextStep(labResult, decisionStatus) {
  switch (decisionStatus) {
    case 'VALID_CONCLUSION':
      return 'Proceed to production change control with cited REAL runs; retain provenance for audit.';
    case 'INCONCLUSIVE':
      return 'Plan additional controlled REAL runs with declared single-variable delta vs an approved baseline.';
    case 'INSUFFICIENT_DATA':
      return 'Acquire missing runs, comparable measurements (max_delta_pct), or FSCTM fields; then re-run the same lab query type.';
    case 'REFERENCE_ONLY':
      return 'Execute REAL validated production runs for all compared versions before causal claims.';
    case 'INVALID_EXPERIMENT':
      return 'Redesign batch as OVAT with exactly one declared change vs baseline; re-submit through lab workflow.';
    case 'STRUCTURAL_INCOMPLETE':
      return 'Complete FSCTM K/C/B/L on the outcome record and re-evaluate through the lab approval path.';
    default:
      return 'Review lab contract fields and re-run when internal REAL data is complete.';
  }
}

/**
 * External slices for UI context only. Called only when decision_status !== VALID_CONCLUSION.
 * externalData: if array, merged as context (still not evidence).
 */
export async function attachExternalContext(query, decisionStatus, externalData, opts = {}) {
  if (decisionStatus === 'VALID_CONCLUSION') {
    return [];
  }
  if (Array.isArray(externalData)) {
    return externalData.map((x) => ({ ...x, _context_only: true, _not_evidence: true }));
  }
  if (opts.skipExternalFetch || !opts.internalBaseUrl) {
    return [];
  }
  return fetchExternalContextOnly(opts.internalBaseUrl);
}

/**
 * Fetch read-only external slices (never fed into buildDecisionStatus).
 */
export async function fetchExternalContextOnly(internalBaseUrl) {
  const base = (internalBaseUrl || '').replace(/\/$/, '');
  if (!base) return [];

  const paths = [
    ['/api/external/v1/sources?limit=3', 'source'],
    ['/api/external/v1/documents?limit=2', 'document'],
  ];
  const blocks = [];
  for (const [path, kind] of paths) {
    try {
      const { data, status } = await axios.get(`${base}${path}`, {
        timeout: 8000,
        validateStatus: () => true,
      });
      if (status !== 200 || !data?.data) continue;
      for (const row of data.data) {
        blocks.push({
          kind: `external_${kind}`,
          id: row.id,
          summary:
            kind === 'source'
              ? `${row.display_name || row.code || ''}`.trim()
              : `${row.title || ''}`.trim(),
          provenance: kind === 'source' ? row.provenance_stub || null : row.full_provenance || null,
          _context_only: true,
          _not_evidence: true,
        });
      }
    } catch {
      /* isolation: external fetch failure must not affect lab decision */
    }
  }
  return blocks;
}

/**
 * @param {string} query
 * @param {object|null} labResult
 * @param {object|null|undefined} externalData
 * @param {{ internalBaseUrl?: string, skipExternalFetch?: boolean, bridgeFailureReason?: string }} [opts]
 */
export async function composeAnswer(query, labResult, externalData, opts = {}) {
  const lab = labResult && typeof labResult === 'object' ? labResult : null;
  let decision_status = buildDecisionStatus(lab);
  const evidence = buildEvidence(lab, decision_status);

  let blocked_reason = generateBlockedReason(lab, decision_status);
  if (!lab && opts.bridgeFailureReason) {
    blocked_reason = opts.bridgeFailureReason;
  }

  const answer = buildNaturalLanguageAnswer(query, lab, decision_status, evidence);
  const next_step = generateNextStep(lab, decision_status);

  const external_context = await attachExternalContext(query, decision_status, externalData, opts);

  const out = {
    answer,
    decision_status,
    evidence,
    external_context,
    blocked_reason,
    next_step,
  };

  if (!ALLOWED_DECISION_STATUSES.includes(decision_status)) {
    out.decision_status = 'INSUFFICIENT_DATA';
    out.blocked_reason =
      out.blocked_reason || 'Composer internal guard: invalid decision state normalized.';
    out.evidence = buildEvidence(lab, out.decision_status);
    out.answer = buildNaturalLanguageAnswer(query, lab, out.decision_status, out.evidence);
    out.next_step = generateNextStep(lab, out.decision_status);
    out.external_context = await attachExternalContext(query, out.decision_status, externalData, opts);
  }

  const trace = buildDecisionTrace(lab, out.decision_status);
  if (trace?.efficacy_branch) {
    assert.ok(
      out.decision_status === 'VALID_CONCLUSION' || out.decision_status === 'INCONCLUSIVE',
      `efficacy delta branch must yield only VALID_CONCLUSION or INCONCLUSIVE, got ${out.decision_status}`
    );
  }
  if (trace) {
    out.decision_trace = trace;
  }

  let constraint_rules = [];
  try {
    if (lab) constraint_rules = evaluateConstraintRulesForLab(lab);
  } catch {
    constraint_rules = [];
  }
  out.constraint_rules = constraint_rules;

  return out;
}
