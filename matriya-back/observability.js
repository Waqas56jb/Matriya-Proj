/**
 * Kernel Amendment v1.2 – Epistemic Integrity Layer.
 * Metrics dashboard (False B rate, Missed B rate, confidence distribution, complexity context),
 * SEM output (component breakdown, confidence range, historical accuracy),
 * Gate observability (confidence_score, basis_count, model_version_hash).
 */
import { DecisionAuditLog } from './database.js';

/**
 * Metrics dashboard: False B rate, Missed B rate, confidence distribution (Gate + B), complexity context.
 */
export async function getMetricsDashboard() {
  if (!DecisionAuditLog) return null;
  const rows = await DecisionAuditLog.findAll({ order: [['created_at', 'DESC']], limit: 5000 });
  const withFeedback = rows.filter(r => r.human_feedback === 'false_b' || r.human_feedback === 'missed_b');
  const falseBCount = rows.filter(r => r.human_feedback === 'false_b').length;
  const missedBCount = rows.filter(r => r.human_feedback === 'missed_b').length;
  const stageBCount = rows.filter(r => r.stage === 'B').length;
  const totalDecisions = rows.length;
  const falseBRate = totalDecisions > 0 ? falseBCount / totalDecisions : null;
  const missedBRate = totalDecisions > 0 ? missedBCount / totalDecisions : null;

  const withConfidence = rows.filter(r => r.confidence_score != null);
  const confidenceGate = withConfidence.map(r => Number(r.confidence_score));
  const confidenceB = rows.filter(r => r.stage === 'B' && r.confidence_score != null).map(r => Number(r.confidence_score));

  const complexityContexts = rows.map(r => r.complexity_context).filter(Boolean);

  return {
    false_b_rate: falseBRate,
    missed_b_rate: missedBRate,
    false_b_count: falseBCount,
    missed_b_count: missedBCount,
    total_decisions: totalDecisions,
    stage_b_count: stageBCount,
    confidence_distribution: {
      gate: confidenceGate.length ? { samples: confidenceGate.length, min: Math.min(...confidenceGate), max: Math.max(...confidenceGate), mean: confidenceGate.reduce((a, b) => a + b, 0) / confidenceGate.length } : null,
      stage_b: confidenceB.length ? { samples: confidenceB.length, min: Math.min(...confidenceB), max: Math.max(...confidenceB), mean: confidenceB.reduce((a, b) => a + b, 0) / confidenceB.length } : null
    },
    complexity_context_sample: complexityContexts[0] || null,
    complexity_context_count: complexityContexts.length
  };
}

/**
 * SEM output: component_breakdown, confidence_range, historical_predictive_accuracy (no single value).
 */
export async function getSEMOutput() {
  if (!DecisionAuditLog) return null;
  const rows = await DecisionAuditLog.findAll({ order: [['created_at', 'DESC']], limit: 2000 });
  const withConfidence = rows.filter(r => r.confidence_score != null).map(r => Number(r.confidence_score));
  const componentBreakdown = {
    gate_checks: rows.length,
    with_confidence: withConfidence.length,
    by_stage: rows.reduce((acc, r) => { acc[r.stage] = (acc[r.stage] || 0) + 1; return acc; }, {})
  };
  const confidenceRange = withConfidence.length
    ? { min: Math.min(...withConfidence), max: Math.max(...withConfidence), p50: percentile(withConfidence, 50), p99: percentile(withConfidence, 99) }
    : null;
  const withFeedback = rows.filter(r => r.human_feedback != null).length;
  const historicalPredictiveAccuracy = rows.length > 0
    ? { labeled_count: withFeedback, total: rows.length, accuracy_note: 'From human_feedback when present' }
    : null;

  return {
    component_breakdown: componentBreakdown,
    confidence_range: confidenceRange,
    historical_predictive_accuracy: historicalPredictiveAccuracy
  };
}

function percentile(arr, p) {
  if (!arr || arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

/**
 * Gate records for dashboard: each with confidence_score, basis_count, model_version_hash.
 */
export async function getGateRecords(limit = 100, offset = 0) {
  if (!DecisionAuditLog) return { gates: [], total: 0 };
  const { count, rows } = await DecisionAuditLog.findAndCountAll({
    order: [['created_at', 'DESC']],
    limit: Math.min(200, limit),
    offset
  });
  return {
    gates: rows.map(r => ({
      id: r.id,
      session_id: r.session_id,
      stage: r.stage,
      decision: r.decision,
      response_type: r.response_type,
      confidence_score: r.confidence_score != null ? Number(r.confidence_score) : null,
      basis_count: r.basis_count,
      model_version_hash: r.model_version_hash,
      complexity_context: r.complexity_context,
      created_at: r.created_at
    })),
    total: count,
    limit,
    offset
  };
}
