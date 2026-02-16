/**
 * B-Integrity Monitor – runs after each research cycle.
 * Checks: |𝓜| growth without justification, decrease without structural change, no progress over cycles.
 * If a problem is detected → creates a Violation (locks the gate for that session).
 */
import { IntegrityCycleSnapshot, Violation } from './database.js';
import logger from './logger.js';

const VIOLATION_TYPE = 'B_INTEGRITY';

/** Default thresholds (overridable via env or config later) */
const MAX_GROWTH_RATIO = parseFloat(process.env.B_INTEGRITY_MAX_GROWTH_RATIO) || 0.5;  // 50% growth per cycle = suspect
const NO_PROGRESS_CYCLES = parseInt(process.env.B_INTEGRITY_NO_PROGRESS_CYCLES, 10) || 3;
const MIN_SNAPSHOTS_FOR_CHECK = 2;

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
 * Run integrity checks on the last N snapshots for this session.
 * - Growth: current metric > previous * (1 + MAX_GROWTH_RATIO) → violation "unjustified_growth"
 * - Decrease: current < previous (no structural change flag) → violation "unexplained_decrease"
 * - No progress: last NO_PROGRESS_CYCLES snapshots have same metric_value → violation "no_progress"
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
  if (snapshots.length < MIN_SNAPSHOTS_FOR_CHECK) return false;

  const current = snapshots[0];
  const previous = snapshots[1];
  const metricCurrent = current.metric_value;
  const metricPrevious = previous.metric_value;

  // 1) Unjustified growth
  const growthThreshold = metricPrevious * (1 + MAX_GROWTH_RATIO);
  if (metricCurrent > growthThreshold) {
    await createViolation(sessionId, 'unjustified_growth', {
      metric_value: metricCurrent,
      previous_value: metricPrevious,
      threshold: growthThreshold
    });
    return true;
  }

  // 2) Unexplained decrease (no structural change recorded in details)
  if (metricCurrent < metricPrevious) {
    const structuralChange = current.details && current.details.structural_change === true;
    if (!structuralChange) {
      await createViolation(sessionId, 'unexplained_decrease', {
        metric_value: metricCurrent,
        previous_value: metricPrevious
      });
      return true;
    }
  }

  // 3) No progress over last NO_PROGRESS_CYCLES
  const forNoProgress = snapshots.slice(0, NO_PROGRESS_CYCLES);
  if (forNoProgress.length >= NO_PROGRESS_CYCLES) {
    const allSame = forNoProgress.every(s => s.metric_value === metricCurrent);
    if (allSame && metricCurrent > 0) {
      await createViolation(sessionId, 'no_progress', {
        metric_value: metricCurrent,
        cycles: NO_PROGRESS_CYCLES
      });
      return true;
    }
  }

  return false;
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
