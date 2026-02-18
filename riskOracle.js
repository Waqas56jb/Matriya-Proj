/**
 * Risk Oracle – predicts/assesses risks based on current integrity state (snapshots, violations).
 * Does not create violations; returns risk indicators for dashboard or admin.
 */
import { Op } from 'sequelize';
import { IntegrityCycleSnapshot, Violation } from './database.js';
import { buildContextFromSnapshots } from './integrityRulesEngine.js';
import logger from './logger.js';

const MAX_GROWTH_RATIO = parseFloat(process.env.B_INTEGRITY_MAX_GROWTH_RATIO) || 0.5;
const NO_PROGRESS_CYCLES = parseInt(process.env.B_INTEGRITY_NO_PROGRESS_CYCLES, 10) || 3;
const ORACLE_SNAPSHOTS_LIMIT = 10;
const ORACLE_VIOLATIONS_DAYS = 7;
const VIOLATION_SPIKE_THRESHOLD = 2;

/**
 * Evaluate risk indicators from recent snapshots and violations.
 * @param {string|null} sessionId - If null, aggregate across all sessions (global view).
 * @returns {Promise<{ risks: Array<{ id: string, type: string, severity: string, message: string, details: object }>, evaluated_at: string }>}
 */
export async function evaluateRisks(sessionId = null) {
  const risks = [];
  const evaluatedAt = new Date().toISOString();

  if (!IntegrityCycleSnapshot && !Violation) {
    return { risks: [], evaluated_at: evaluatedAt };
  }

  try {
    const snapshotWhere = sessionId ? { session_id: sessionId } : {};
    const snapshots = IntegrityCycleSnapshot
      ? await IntegrityCycleSnapshot.findAll({
          where: snapshotWhere,
          order: [['created_at', 'DESC']],
          limit: ORACLE_SNAPSHOTS_LIMIT
        })
      : [];

    const since = new Date();
    since.setDate(since.getDate() - ORACLE_VIOLATIONS_DAYS);
    const violationWhere = { created_at: { [Op.gte]: since } };
    if (sessionId) violationWhere.session_id = sessionId;
    const violations = Violation
      ? await Violation.findAll({
          where: violationWhere,
          order: [['created_at', 'DESC']],
          limit: 100
        })
      : [];

    const activeViolations = Violation
      ? await Violation.count({ where: { resolved_at: null, ...(sessionId && { session_id: sessionId }) } })
      : 0;

    if (activeViolations > 0) {
      risks.push({
        id: 'active_violations',
        type: 'active_violations',
        severity: 'high',
        message: `קיימות ${activeViolations} הפרות פעילות (גייט נעול לסשנים רלוונטיים)`,
        details: { count: activeViolations }
      });
    }

    const context = buildContextFromSnapshots(snapshots);
    if (context) {
      const current = context.current?.metric_value ?? 0;
      const previous = context.previous?.metric_value ?? 0;

      if (previous > 0) {
        const growthRatio = (current - previous) / previous;
        if (growthRatio > 0 && growthRatio >= MAX_GROWTH_RATIO * 0.6) {
          risks.push({
            id: 'potential_growth',
            type: 'potential_growth',
            severity: growthRatio >= MAX_GROWTH_RATIO ? 'high' : 'medium',
            message: `עלייה במדד (${(growthRatio * 100).toFixed(1)}%) – עלול להפעיל חוקר "unjustified_growth"`,
            details: { current, previous, growth_ratio: growthRatio, threshold_ratio: MAX_GROWTH_RATIO }
          });
        }

        if (current < previous) {
          const structuralChange = context.current?.details?.structural_change === true;
          if (!structuralChange) {
            risks.push({
              id: 'potential_decrease',
              type: 'potential_decrease',
              severity: 'medium',
              message: 'ירידה במדד ללא סימון structural_change – עלול להפעיל "unexplained_decrease"',
              details: { current, previous }
            });
          }
        }
      }

      const forNoProgress = snapshots.slice(0, NO_PROGRESS_CYCLES - 1);
      if (forNoProgress.length >= NO_PROGRESS_CYCLES - 1 && current > 0) {
        const allSame = forNoProgress.every(s => s.metric_value === current);
        if (allSame) {
          risks.push({
            id: 'potential_no_progress',
            type: 'potential_no_progress',
            severity: 'low',
            message: `מדד יציב ב-${forNoProgress.length} מחזורים אחרונים – מחזור נוסף ללא שינוי עלול להפעיל "no_progress"`,
            details: { metric_value: current, cycles_stable: forNoProgress.length, threshold: NO_PROGRESS_CYCLES }
          });
        }
      }
    }

    const violationsLast24h = violations.filter(v => {
      const t = v.created_at ? new Date(v.created_at).getTime() : 0;
      return t >= Date.now() - 24 * 60 * 60 * 1000;
    });
    if (violationsLast24h.length >= VIOLATION_SPIKE_THRESHOLD) {
      risks.push({
        id: 'violation_spike',
        type: 'violation_spike',
        severity: 'medium',
        message: `הפרות ב-24 השעות האחרונות: ${violationsLast24h.length} – עלייה בפעילות הפרות`,
        details: { count_24h: violationsLast24h.length, threshold: VIOLATION_SPIKE_THRESHOLD }
      });
    }
  } catch (e) {
    logger.error(`Risk Oracle evaluateRisks: ${e.message}`);
  }

  return { risks, evaluated_at: evaluatedAt };
}
