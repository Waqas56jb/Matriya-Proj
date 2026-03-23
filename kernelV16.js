/**
 * Kernel FSCTM v1.6 – deterministic breakdown / anchoring / L-gate helpers.
 * Document-only מחקר stays allowed when kernel_signals are omitted (unless KERNEL_V16_STRICT).
 */

export const KERNEL_V16_VERSION = '1.6';

const ALLOWED_ANCHOR_KEYS = new Set(['experiment_snapshot', 'similar_experiments', 'failure_patterns']);

/** Minimal unified model shape for coverage / fit checks. */
export function normalizeModelRepresentation(model) {
  if (!model || typeof model !== 'object') return null;
  const type = model.type;
  if (!['linear', 'polynomial', 'piecewise'].includes(type)) return null;
  return {
    type,
    parameters: model.parameters != null && typeof model.parameters === 'object' ? model.parameters : {},
    domain: model.domain != null && typeof model.domain === 'object' ? model.domain : {}
  };
}

function modelFitAllFailed(mf) {
  if (!mf || typeof mf !== 'object') return false;
  const types = ['linear', 'polynomial', 'piecewise'];
  const attempted = types.filter((t) => mf[t] != null);
  if (attempted.length < 3) return false;
  return types.every((t) => {
    const v = mf[t];
    return v && (v.ok === false || v.failed === true);
  });
}

/**
 * B – breakdown detection (at least one must hold for “breakdown” when signals are supplied).
 */
export function evaluateBreakdown(signals = {}) {
  const reasons = [];
  const mf = signals.model_fits ?? signals.modelFits;
  if (modelFitAllFailed(mf)) reasons.push('MODEL_FIT_ALL_CLASSES_FAILED');

  const train = signals.train_error ?? signals.trainError;
  const hold = signals.holdout_error ?? signals.holdoutError;
  const minRatio = typeof signals.ood_ratio_threshold === 'number' ? signals.ood_ratio_threshold : 2;
  if (typeof train === 'number' && typeof hold === 'number' && train > 0 && hold / train >= minRatio) {
    reasons.push('OOD_ERROR_ELEVATED');
  }

  if (signals.residual_non_random === true || signals.residualNonRandom === true) {
    reasons.push('RESIDUAL_NON_RANDOM');
  }
  const cp = signals.change_point_score ?? signals.changePointScore;
  const cpTh = typeof signals.change_point_threshold === 'number' ? signals.change_point_threshold : 0.5;
  if (typeof cp === 'number' && cp >= cpTh) reasons.push('CHANGE_POINT');

  return {
    breakdown: reasons.length > 0,
    reasons,
    shutdownOptimization: reasons.length > 0
  };
}

/** Fail-safe: explicit insufficient data or indistinguishable factors. */
export function evaluateFailSafe(signals) {
  if (!signals || typeof signals !== 'object' || Object.keys(signals).length === 0) {
    return { ok: true, skipped: true };
  }
  if (signals.variables_distinguishable === false || signals.variablesDistinguishable === false) {
    return {
      ok: false,
      code: 'VARIABLES_NOT_DISTINGUISHABLE',
      message_he: 'אין יכולת להבדיל בין משתנים — insufficient information',
      message_en: 'insufficient information'
    };
  }
  if (signals.sufficient_data === false || signals.sufficientData === false) {
    return {
      ok: false,
      code: 'INSUFFICIENT_DATA',
      message_he: 'אין נתונים מספקים — insufficient information',
      message_en: 'insufficient information'
    };
  }
  return { ok: true };
}

export function validateDataAnchors(anchors) {
  if (anchors == null || typeof anchors !== 'object') return { ok: true, skipped: true };
  const keys = Object.keys(anchors);
  if (keys.length === 0) return { ok: true, skipped: true };
  for (const k of keys) {
    if (!ALLOWED_ANCHOR_KEYS.has(k)) {
      return {
        ok: false,
        error_he: `עוגן נתונים לא מורשה: ${k}. מותרים בלבד: experiment_snapshot, similar_experiments, failure_patterns.`,
        error_en: `Invalid anchor key: ${k}`
      };
    }
  }
  return { ok: true };
}

export function checkExtrapolationRule(signals) {
  if (!signals || typeof signals !== 'object') return { ok: true, skipped: true };
  const intent = signals.extrapolation_intent === true || signals.extrapolate === true;
  const inDomain = signals.data_in_domain === true || signals.dataCoversRange === true;
  if (intent && !inDomain) {
    return {
      ok: false,
      message_he: 'אין נתונים בטווח — אין הכללה מחוץ לדאטה ואין לנחש.',
      message_en: 'No extrapolation beyond observed data'
    };
  }
  return { ok: true };
}

export function checkMethodologyFlags(flags) {
  if (!flags || typeof flags !== 'object') return { trip: false, reasons: [] };
  const reasons = [];
  if (flags.repeated_solution === true) reasons.push('REPEATED_SOLUTION');
  if (flags.patches_without_hypothesis === true || flags.patches === true) reasons.push('PATCHES');
  if (flags.cost_rising_no_progress === true) reasons.push('COST_NO_PROGRESS');
  return { trip: reasons.length > 0, reasons };
}

/** L – validation gate (first entry to L). */
export function validateLGate(lValidation) {
  if (!lValidation || typeof lValidation !== 'object') {
    return { ok: false, reason: 'L_VALIDATION_MISSING' };
  }
  const runs = lValidation.repeat_runs ?? lValidation.runs;
  if (typeof runs !== 'number' || runs < 3) return { ok: false, reason: 'L_RUNS_LT_3' };
  if (lValidation.significant_improvement_vs_baseline !== true) {
    return { ok: false, reason: 'L_NOT_SIGNIFICANT_VS_BASELINE' };
  }
  if (lValidation.stable_over_conditions !== true && lValidation.stable !== true) {
    return { ok: false, reason: 'L_NOT_STABLE' };
  }
  return { ok: true };
}

/** N – structural generation hints (deterministic; not LLM). */
export function suggestStructuralGeneration(breakdownReasons = []) {
  const ideas = [
    { kind: 'piecewise_regime', desc_he: 'פיצול למשטרים (מודל piecewise) כאשר יש שינוי משטר.' },
    { kind: 'interaction', desc_he: 'הוספת אינטראקציה בין משתנים שוברת הנחת אדitivity.' },
    { kind: 'latent_variable', desc_he: 'משתנה חבוי פשוט המייצג גורם לא נמדד.' }
  ];
  const tail = Array.isArray(breakdownReasons) && breakdownReasons.length
    ? ` מקושר לזיהוי: ${breakdownReasons.join(', ')}.`
    : '';
  return {
    ideas,
    acceptance_criteria_he: `תנאי קבלה: שובר הנחה קיימת; לא שיפור פרמטרי בלבד.${tail}`
  };
}

function avgDistance(sources) {
  if (!Array.isArray(sources) || !sources.length) return null;
  const nums = sources
    .map((s) => s.distance ?? s.metadata?.distance)
    .filter((d) => typeof d === 'number' && !Number.isNaN(d));
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/**
 * Fixed response shell: Evidence, Pattern, Conclusion, Confidence (0–1).
 */
export function buildStructuredKernelOutput({
  stage,
  answer,
  sources,
  insufficientInfo = false,
  extraEvidence = ''
}) {
  if (insufficientInfo) {
    return {
      Evidence: 'אין בסיס מספק לעוגן ניתוח.',
      Pattern: '—',
      Conclusion: 'אין במערכת מידע תומך לשאלה זו.',
      Confidence: 0
    };
  }
  const n = Array.isArray(sources) ? sources.length : 0;
  const dist = avgDistance(sources);
  let confidence = 0.45;
  if (n >= 3) confidence += 0.15;
  if (n >= 1 && typeof dist === 'number') confidence += Math.max(0, Math.min(0.25, (1 - Math.min(dist, 1)) * 0.25));
  confidence = Math.min(0.95, Math.max(0.15, confidence));

  const evidenceParts = [];
  if (extraEvidence) evidenceParts.push(extraEvidence);
  evidenceParts.push(n > 0 ? `${n} קטעי מסמך שימשו כבסיס.` : 'תשובה מבוססת חיפוש במסמכים (ללא קטעים בתוצאה).');
  return {
    Evidence: evidenceParts.join(' '),
    Pattern: `שלב ${stage}: סינתזה ממסמכים (FSCTM v${KERNEL_V16_VERSION})`,
    Conclusion: (answer || '').trim() || '—',
    Confidence: Math.round(confidence * 100) / 100
  };
}

export function parseKernelJsonParam(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function isStrictV16() {
  return process.env.KERNEL_V16_STRICT === 'true' || process.env.KERNEL_V16_STRICT === '1';
}

export function isAnchorRequired() {
  return process.env.KERNEL_V16_ANCHOR_REQUIRED === 'true' || process.env.KERNEL_V16_ANCHOR_REQUIRED === '1';
}
