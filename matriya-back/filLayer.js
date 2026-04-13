/**
 * FIL-01 (Failure Intelligence Layer) – mines patterns from violations.
 * Returns warnings only; does not change Hard Stop or block any endpoint.
 */
import { Op } from 'sequelize';
import { Violation } from './database.js';
import logger from './logger.js';

const DEFAULT_DAYS = 30;
const MIN_OCCURRENCES_FOR_PATTERN = 2;

/**
 * Mine patterns from violations and return warnings.
 * @param {object} options - { session_id?, days?, limit? }
 * @returns {Promise<{ warnings: Array<{ id: string, type: string, message: string, details: object }>, mined_at: string }>}
 */
export async function getFilWarnings(options = {}) {
  const sessionId = options.session_id?.trim?.() || null;
  const days = Math.min(Math.max(parseInt(options.days, 10) || DEFAULT_DAYS, 1), 365);
  const limit = Math.min(parseInt(options.limit, 10) || 100, 500);

  const warnings = [];
  const minedAt = new Date().toISOString();

  if (!Violation) {
    return { warnings: [], mined_at: minedAt };
  }

  try {
    const since = new Date();
    since.setDate(since.getDate() - days);
    const where = { created_at: { [Op.gte]: since } };
    if (sessionId) where.session_id = sessionId;

    const violations = await Violation.findAll({
      where,
      order: [['created_at', 'DESC']],
      limit: limit * 2,
      attributes: ['id', 'session_id', 'reason', 'details', 'type', 'created_at', 'resolved_at'],
      raw: true
    });

    // Pattern: same reason recurring
    const byReason = {};
    for (const v of violations) {
      const r = v.reason || v.type || 'B_INTEGRITY';
      if (!byReason[r]) byReason[r] = [];
      byReason[r].push(v);
    }
    for (const [reason, list] of Object.entries(byReason)) {
      if (list.length >= MIN_OCCURRENCES_FOR_PATTERN) {
        const unresolved = list.filter(x => !x.resolved_at);
        warnings.push({
          id: `fil_reason_${reason}`,
          type: 'recurring_reason',
          message: `Reason "${reason}" occurred ${list.length} time(s) in the last ${days} days${unresolved.length > 0 ? ` (${unresolved.length} unresolved)` : ''}.`,
          details: { reason, count: list.length, unresolved: unresolved.length, session_ids: [...new Set(list.map(x => x.session_id))].slice(0, 5) }
        });
      }
    }

    // Pattern: same session multiple violations
    const bySession = {};
    for (const v of violations) {
      const s = v.session_id;
      if (!bySession[s]) bySession[s] = [];
      bySession[s].push(v);
    }
    for (const [sid, list] of Object.entries(bySession)) {
      if (list.length >= MIN_OCCURRENCES_FOR_PATTERN) {
        warnings.push({
          id: `fil_session_${sid}`,
          type: 'session_repeated_violations',
          message: `Session ${sid} has ${list.length} violation(s) in the period.`,
          details: { session_id: sid, count: list.length, reasons: [...new Set(list.map(x => x.reason || x.type))] }
        });
      }
    }

    // Active violations count (informational warning)
    const activeCount = violations.filter(v => !v.resolved_at).length;
    if (activeCount > 0) {
      warnings.push({
        id: 'fil_active_count',
        type: 'active_violations',
        message: `${activeCount} active (unresolved) violation(s) in the selected period – gate locked for affected sessions.`,
        details: { count: activeCount }
      });
    }

    return {
      warnings: warnings.slice(0, limit),
      mined_at: minedAt,
      filters_applied: { days, session_id: sessionId || 'all' }
    };
  } catch (e) {
    logger.error(`FIL-01 getFilWarnings: ${e.message}`);
    return { warnings: [], mined_at: minedAt, error: e.message };
  }
}
