/**
 * B-Integrity Rules Engine – configurable rules with conditions and actions.
 * Conditions evaluate against a context (current/previous snapshots, metrics).
 * Actions: create_violation, log_only (future).
 * Rules run in order; first match wins (or run all and collect – currently first match).
 */
import logger from './logger.js';

/** Default thresholds (env overrides applied when building default rules) */
const DEFAULT_MAX_GROWTH_RATIO = parseFloat(process.env.B_INTEGRITY_MAX_GROWTH_RATIO) || 0.5;
const DEFAULT_NO_PROGRESS_CYCLES = parseInt(process.env.B_INTEGRITY_NO_PROGRESS_CYCLES, 10) || 3;
const DEFAULT_METRIC_CAP = parseInt(process.env.B_INTEGRITY_METRIC_CAP, 10) || 0; // 0 = disabled
const DEFAULT_MAX_DROP_PERCENT = parseFloat(process.env.B_INTEGRITY_MAX_DROP_PERCENT) || 100; // 100 = any drop can trigger if no structural change

const MIN_SNAPSHOTS_FOR_CHECK = 2;

/**
 * Evaluate a single condition against context.
 * @param {object} condition - { type: string, params: object }
 * @param {object} context - { current, previous, snapshots, options }
 * @returns {boolean}
 */
export function evaluateCondition(condition, context) {
  if (!condition || !condition.type) return false;
  const { current, previous, snapshots = [], options = {} } = context;
  const metricCurrent = current?.metric_value ?? 0;
  const metricPrevious = previous?.metric_value ?? 0;
  const params = condition.params || {};

  switch (condition.type) {
    case 'growth_above_ratio': {
      const ratio = params.ratio ?? DEFAULT_MAX_GROWTH_RATIO;
      const threshold = metricPrevious * (1 + ratio);
      return metricPrevious > 0 && metricCurrent > threshold;
    }
    case 'decrease_without_structural_change': {
      if (metricCurrent >= metricPrevious) return false;
      const structuralChange = current?.details?.structural_change === true;
      return !structuralChange;
    }
    case 'no_progress_cycles': {
      const cycles = params.cycles ?? DEFAULT_NO_PROGRESS_CYCLES;
      const slice = snapshots.slice(0, cycles);
      if (slice.length < cycles) return false;
      const allSame = slice.every(s => s.metric_value === metricCurrent);
      return allSame && metricCurrent > 0;
    }
    case 'metric_above': {
      const cap = params.value ?? DEFAULT_METRIC_CAP;
      if (cap <= 0) return false;
      return metricCurrent > cap;
    }
    case 'metric_below': {
      const floor = params.value;
      if (floor == null) return false;
      return metricCurrent < floor;
    }
    case 'drop_percent_above': {
      if (metricPrevious <= 0 || metricCurrent >= metricPrevious) return false;
      const maxDropPercent = params.max_percent ?? DEFAULT_MAX_DROP_PERCENT;
      const dropPercent = ((metricPrevious - metricCurrent) / metricPrevious) * 100;
      const structuralChange = current?.details?.structural_change === true;
      return !structuralChange && dropPercent > maxDropPercent;
    }
    default:
      logger.warn(`Integrity rules engine: unknown condition type "${condition.type}"`);
      return false;
  }
}

/**
 * Build context from snapshot list (DESC by created_at).
 * @param {Array} snapshots
 * @returns {object|null} context or null if insufficient snapshots
 */
export function buildContextFromSnapshots(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length < MIN_SNAPSHOTS_FOR_CHECK) return null;
  return {
    current: snapshots[0],
    previous: snapshots[1],
    snapshots,
    options: {
      max_growth_ratio: DEFAULT_MAX_GROWTH_RATIO,
      no_progress_cycles: DEFAULT_NO_PROGRESS_CYCLES,
      metric_cap: DEFAULT_METRIC_CAP
    }
  };
}

/**
 * Get the default rule set (original three + optional metric_above, drop_percent_above).
 * Order matters: first matching rule fires. large_drop before unexplained_decrease when configured.
 * Each rule: { id, condition: { type, params }, action, reason, buildDetails?: (context) => object }
 */
export function getDefaultRules() {
  const rules = [
    {
      id: 'unjustified_growth',
      condition: { type: 'growth_above_ratio', params: { ratio: DEFAULT_MAX_GROWTH_RATIO } },
      action: 'create_violation',
      reason: 'unjustified_growth',
      buildDetails: (ctx) => ({
        metric_value: ctx.current?.metric_value,
        previous_value: ctx.previous?.metric_value,
        threshold: (ctx.previous?.metric_value ?? 0) * (1 + DEFAULT_MAX_GROWTH_RATIO)
      })
    }
  ];

  if (DEFAULT_MAX_DROP_PERCENT < 100) {
    rules.push({
      id: 'large_drop_without_justification',
      condition: { type: 'drop_percent_above', params: { max_percent: DEFAULT_MAX_DROP_PERCENT } },
      action: 'create_violation',
      reason: 'large_drop_without_justification',
      buildDetails: (ctx) => {
        const prev = ctx.previous?.metric_value ?? 0;
        const curr = ctx.current?.metric_value ?? 0;
        const dropPct = prev > 0 ? ((prev - curr) / prev) * 100 : 0;
        return {
          metric_value: curr,
          previous_value: prev,
          drop_percent: dropPct,
          max_allowed_percent: DEFAULT_MAX_DROP_PERCENT
        };
      }
    });
  }

  rules.push(
    {
      id: 'unexplained_decrease',
      condition: { type: 'decrease_without_structural_change', params: {} },
      action: 'create_violation',
      reason: 'unexplained_decrease',
      buildDetails: (ctx) => ({
        metric_value: ctx.current?.metric_value,
        previous_value: ctx.previous?.metric_value
      })
    },
    {
      id: 'no_progress',
      condition: { type: 'no_progress_cycles', params: { cycles: DEFAULT_NO_PROGRESS_CYCLES } },
      action: 'create_violation',
      reason: 'no_progress',
      buildDetails: (ctx) => ({
        metric_value: ctx.current?.metric_value,
        cycles: DEFAULT_NO_PROGRESS_CYCLES
      })
    }
  );

  if (DEFAULT_METRIC_CAP > 0) {
    rules.push({
      id: 'metric_cap_exceeded',
      condition: { type: 'metric_above', params: { value: DEFAULT_METRIC_CAP } },
      action: 'create_violation',
      reason: 'metric_cap_exceeded',
      buildDetails: (ctx) => ({
        metric_value: ctx.current?.metric_value,
        cap: DEFAULT_METRIC_CAP
      })
    });
  }

  return rules;
}

/**
 * Run the rule set against context. Executes the first matching rule's action.
 * @param {Array} rules - From getDefaultRules() or custom
 * @param {object} context - From buildContextFromSnapshots
 * @param {object} actions - { createViolation: async (sessionId, reason, details) => void }
 * @param {string} sessionId
 * @returns {Promise<{ fired: boolean, ruleId?: string }>}
 */
export async function runRules(rules, context, actions, sessionId) {
  if (!context || !Array.isArray(rules) || !actions?.createViolation) {
    return { fired: false };
  }
  for (const rule of rules) {
    if (!evaluateCondition(rule.condition, context)) continue;
    const reason = rule.reason || rule.id;
    const details = typeof rule.buildDetails === 'function' ? rule.buildDetails(context) : undefined;
    if (rule.action === 'create_violation') {
      await actions.createViolation(sessionId, reason, details);
      logger.info(`Integrity rule fired: ${rule.id} (${reason}) for session ${sessionId}`);
      return { fired: true, ruleId: rule.id };
    }
    if (rule.action === 'log_only') {
      logger.warn(`Integrity rule [log_only]: ${rule.id} – ${reason}`, details);
      return { fired: false, ruleId: rule.id };
    }
  }
  return { fired: false };
}

/**
 * List registered condition types (for admin/docs).
 */
export function getConditionTypes() {
  return [
    { type: 'growth_above_ratio', params: ['ratio'], description: 'Current metric > previous * (1 + ratio)' },
    { type: 'decrease_without_structural_change', params: [], description: 'Current < previous and no structural_change in details' },
    { type: 'no_progress_cycles', params: ['cycles'], description: 'Last N snapshots have same metric_value' },
    { type: 'metric_above', params: ['value'], description: 'Current metric > value (cap)' },
    { type: 'metric_below', params: ['value'], description: 'Current metric < value (floor)' },
    { type: 'drop_percent_above', params: ['max_percent'], description: 'Drop % from previous exceeds max_percent without structural change' }
  ];
}
