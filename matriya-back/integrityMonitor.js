/**
 * B-Integrity Monitor – runs after each research cycle.
 * Uses the Integrity Rules Engine: conditions (growth, decrease, no_progress, metric_above, etc.) and actions (create_violation).
 * If a rule fires → creates a Violation (locks the gate for that session).
 */
import { IntegrityCycleSnapshot, Violation } from './database.js';
import { getDefaultRules, buildContextFromSnapshots, runRules } from './integrityRulesEngine.js';
import logger from './logger.js';

const VIOLATION_TYPE = 'B_INTEGRITY';

/** Minimum snapshots required to run any rule (at least current + previous) */
const MIN_SNAPSHOTS_FOR_CHECK = 2;
const NO_PROGRESS_CYCLES = parseInt(process.env.B_INTEGRITY_NO_PROGRESS_CYCLES, 10) || 3;

/**
 * Get active (unresolved) violation for a session, if any.
 * @returns {Promise<object|null>} Violation instance or null
 */
export async function getActiveViolation(sessionId) {
  if (!Violation || !sessionId) return null;
  const v = await Violation.findOne({
    where: { session_id: sessionId, resolved_at: null }
  });
  return v;
}

/**
 * Record a cycle snapshot (metric value at end of a stage, typically when L is completed).
 * @param {string} sessionId - Research session UUID
 * @param {string} stage - Stage just completed (e.g. 'L')
 * @param {number} metricValue - |𝓜| value (e.g. document count)
 * @param {object} [details] - Optional extra payload
 */
export async function recordSnapshot(sessionId, stage, metricValue, details = null) {
  if (!IntegrityCycleSnapshot) return;
  try {
    const count = await IntegrityCycleSnapshot.count({ where: { session_id: sessionId } });
    await IntegrityCycleSnapshot.create({
      session_id: sessionId,
      stage,
      cycle_index: count,
      metric_name: 'document_count',
      metric_value: metricValue,
      details: details || null
    });
  } catch (e) {
    logger.warn(`Integrity snapshot failed: ${e.message}`);
  }
}

/**
 * Create a violation for the session (locks the gate).
 * @param {string} sessionId
 * @param {string} reason - Short reason code or message
 * @param {object} [details]
 */
export async function createViolation(sessionId, reason, details = null) {
  if (!Violation) return;
  try {
    await Violation.create({
      session_id: sessionId,
      type: VIOLATION_TYPE,
      reason,
      details: details || null
    });
    logger.info(`B-Integrity violation created for session ${sessionId}: ${reason}`);
  } catch (e) {
    logger.error(`Failed to create violation: ${e.message}`);
  }
}

/**
 * Run integrity checks via the Rules Engine on the last N snapshots for this session.
 * Rules (e.g. unjustified_growth, unexplained_decrease, no_progress, metric_cap_exceeded, large_drop) are evaluated in order.
 * @param {string} sessionId
 * @returns {Promise<boolean>} true if a violation was created
 */
export async function runIntegrityCheck(sessionId) {
  if (!IntegrityCycleSnapshot || !Violation) return false;
  const limit = Math.max(MIN_SNAPSHOTS_FOR_CHECK, NO_PROGRESS_CYCLES) + 2;
  const snapshots = await IntegrityCycleSnapshot.findAll({
    where: { session_id: sessionId },
    order: [['created_at', 'DESC']],
    limit
  });
  const context = buildContextFromSnapshots(snapshots);
  if (!context) return false;

  const rules = getDefaultRules();
  const result = await runRules(rules, context, { createViolation }, sessionId);
  return result.fired;
}

/**
 * Run after a research cycle (e.g. when stage L completed): record snapshot then run check.
 * getMetricAsync should return a number (e.g. document count).
 * @param {string} sessionId
 * @param {string} stage - Stage just completed
 * @param {() => Promise<number>} getMetricAsync
 * @returns {Promise<boolean>} true if a violation was created
 */
export async function runAfterCycle(sessionId, stage, getMetricAsync) {
  let metricValue = 0;
  try {
    metricValue = await getMetricAsync();
    if (typeof metricValue !== 'number' || metricValue < 0) metricValue = 0;
  } catch (e) {
    logger.warn(`B-Integrity getMetric failed: ${e.message}`);
    return false;
  }
  await recordSnapshot(sessionId, stage, metricValue);
  return await runIntegrityCheck(sessionId);
}
