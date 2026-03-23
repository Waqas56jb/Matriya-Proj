/**
 * Stage 1 – Research FSM Gate (FSCTM)
 * Enforces: K→C→B→N→L only. No skip. Gate rules per stage.
 * When an active B-Integrity Violation exists for the session, the gate is locked.
 * Gate is deterministic: decision depends only on DB state (session, completed_stages, violations).
 * Kernel v1.6: optional kernel_signals / data_anchors / methodology_flags (see validateAndAdvance opts).
 */
import crypto from 'crypto';
import { ResearchSession, ResearchAuditLog, STAGES_ORDER } from './database.js';
import { getActiveViolation } from './integrityMonitor.js';
import logger from './logger.js';
import {
  KERNEL_V16_VERSION,
  evaluateBreakdown,
  evaluateFailSafe,
  validateDataAnchors,
  checkExtrapolationRule,
  checkMethodologyFlags,
  validateLGate,
  isStrictV16,
  isAnchorRequired
} from './kernelV16.js';

const VALID_STAGES = new Set(STAGES_ORDER);

const GATE_VERSION = '1.6';
/** Model version hash for Gate observability (Kernel Amendment v1.2). */
export function getModelVersionHash() {
  return crypto.createHash('sha256').update(`gate-${GATE_VERSION}-kv${KERNEL_V16_VERSION}-${STAGES_ORDER.join(',')}`).digest('hex').slice(0, 16);
}

/** Gate observability context: confidence_score, basis_count, model_version_hash. */
export function getGateObservabilityContext() {
  return {
    confidence_score: 1.0,
    basis_count: 2,
    model_version_hash: getModelVersionHash()
  };
}

/** Response types for audit */
const RESPONSE_TYPE = {
  HARD_STOP: 'hard_stop',
  INFO_ONLY: 'info_only',
  FULL_ANSWER: 'full_answer'
};

/**
 * Get the next allowed stage after completed_stages (empty => K).
 */
function getNextAllowedStage(completedStages) {
  const completed = new Set(Array.isArray(completedStages) ? completedStages : []);
  for (const s of STAGES_ORDER) {
    if (!completed.has(s)) return s;
  }
  return STAGES_ORDER[STAGES_ORDER.length - 1]; // L – can repeat
}

/**
 * Check if stage X is allowed: either already completed (repeat) or is the next in sequence.
 */
function isStageAllowed(completedStages, stage) {
  if (!VALID_STAGES.has(stage)) return false;
  const completed = new Set(Array.isArray(completedStages) ? completedStages : []);
  if (completed.has(stage)) return true; // repeat allowed
  const next = getNextAllowedStage(completedStages);
  return stage === next;
}

function sortStagesByOrder(stages) {
  const arr = Array.isArray(stages) ? [...stages] : [];
  return arr.sort((a, b) => STAGES_ORDER.indexOf(a) - STAGES_ORDER.indexOf(b));
}

function stripPostBStages(completedStages) {
  return sortStagesByOrder((Array.isArray(completedStages) ? completedStages : []).filter((s) => s !== 'N' && s !== 'L'));
}

function mergeKernelContext(session, patch) {
  const prev = session.kernel_context && typeof session.kernel_context === 'object' ? session.kernel_context : {};
  return { ...prev, ...patch, kernel_spec: KERNEL_V16_VERSION };
}

/**
 * Get existing session by id. Returns { session, completed_stages } or null if not found.
 * Does NOT create. Use for search: no valid session → no handling.
 */
export async function getSession(sessionId) {
  if (!ResearchSession || !sessionId) return null;
  const session = await ResearchSession.findByPk(sessionId);
  if (!session) return null;
  return { session, completed_stages: session.completed_stages || [] };
}

/**
 * Create a new research session (only via POST /research/session).
 * Returns { session, completed_stages }.
 */
export async function getOrCreateSession(sessionId, userId = null) {
  if (!ResearchSession) {
    throw new Error('ResearchSession model not available');
  }
  if (sessionId) {
    const existing = await getSession(sessionId);
    if (existing) return existing;
  }
  const session = await ResearchSession.create({
    user_id: userId,
    completed_stages: []
  });
  return { session, completed_stages: [] };
}

/**
 * FSCTM Gate: validate request. Requires valid session_id + stage.
 * Returns { ok, error, session, completed_stages, responseType }.
 * responseType: 'hard_stop' | 'info_only' | 'full_answer'
 * Without valid session → no handling.
 * @param {object} [opts]
 * @param {object|null} [opts.kernel_signals] – breakdown / OOD / residuals / l_validation / flags
 * @param {object|null} [opts.data_anchors] – only experiment_snapshot | similar_experiments | failure_patterns
 * @param {object|null} [opts.methodology_flags] – repeated_solution, patches, cost_rising_no_progress
 */
export async function validateAndAdvance(sessionId, stage, userId = null, opts = {}) {
  if (!stage || !VALID_STAGES.has(stage)) {
    return { ok: false, error: 'stage is required and must be one of: K, C, B, N, L' };
  }
  if (!sessionId) {
    return { ok: false, error: 'session_id is required. Create a session via POST /research/session first.' };
  }
  const violation = await getActiveViolation(sessionId);
  if (violation) {
    return {
      ok: false,
      error: `Session locked due to B-Integrity violation (${violation.reason || violation.type}). Use Recovery API to resolve.`,
      violation_id: violation.id,
      research_gate_locked: true,
      status: 'stopped',
      stopPipeline: true,
      allowed_next_step: 'recovery_required'
    };
  }
  const data = await getSession(sessionId);
  if (!data) {
    return { ok: false, error: 'Invalid or expired session. Use a valid session_id from POST /research/session.' };
  }
  const { session, completed_stages } = data;
  let workingStages = sortStagesByOrder(completed_stages);
  const completedSet = new Set(workingStages);

  const kernelSignals = opts.kernel_signals && typeof opts.kernel_signals === 'object' ? opts.kernel_signals : null;
  const dataAnchors = opts.data_anchors && typeof opts.data_anchors === 'object' ? opts.data_anchors : null;
  const methodologyFlags = opts.methodology_flags && typeof opts.methodology_flags === 'object' ? opts.methodology_flags : null;

  const meth = checkMethodologyFlags(methodologyFlags);
  if (meth.trip) {
    const rolled = stripPostBStages(workingStages);
    const kc = mergeKernelContext(session, {
      possibility_shutdown: true,
      methodology_trip: meth.reasons,
      last_rollback_at: new Date().toISOString()
    });
    try {
      await session.update({
        completed_stages: rolled,
        kernel_context: kc,
        updated_at: new Date()
      });
    } catch (e) {
      logger.warn(`Kernel v1.6 rollback update failed (kernel_context column missing?): ${e.message}`);
      await session.update({ completed_stages: rolled, updated_at: new Date() });
    }
    return {
      ok: false,
      error:
        'זוהתה כשל מתודולוגי (חזרות פתרון / טלאים / עלות עולה ללא התקדמות). בוצע חזרה מ-N/L והופעל סגירת אפשרויות. המשך מ-B.',
      kernel_v16: {
        back_to_B: true,
        shutdown: true,
        reasons: meth.reasons
      }
    };
  }

  const anchorCheck = validateDataAnchors(dataAnchors);
  if (!anchorCheck.ok) {
    return { ok: false, error: anchorCheck.error_he || anchorCheck.error_en || 'Invalid data anchors' };
  }
  if (isAnchorRequired() && anchorCheck.skipped) {
    return {
      ok: false,
      error:
        'נדרש עוגן נתונים (experiment_snapshot / similar_experiments / failure_patterns) — KERNEL_V16_ANCHOR_REQUIRED.',
      kernel_v16: { code: 'ANCHORS_REQUIRED' }
    };
  }

  if (!isStageAllowed(workingStages, stage)) {
    const next = getNextAllowedStage(workingStages);
    return {
      ok: false,
      error: `Invalid stage transition. Allowed next stage: ${next}. Order is K→C→B→N→L only.`
    };
  }

  const firstVisitToN = stage === 'N' && !completedSet.has('N');
  const firstVisitToL = stage === 'L' && !completedSet.has('L');

  if (firstVisitToN) {
    if (!completedSet.has('B')) {
      return {
        ok: false,
        error: 'אין מעבר ל-N ללא השלמת שלב B.'
      };
    }
    const extrap = checkExtrapolationRule(kernelSignals || {});
    if (!extrap.ok) {
      return { ok: false, error: extrap.message_he, kernel_v16: { code: 'EXTRAPOLATION_BLOCKED' } };
    }
    const strict = isStrictV16();
    const signalsObj = kernelSignals && Object.keys(kernelSignals).length > 0 ? kernelSignals : null;

    if (signalsObj) {
      const fs = evaluateFailSafe(signalsObj);
      if (!fs.ok) {
        return {
          ok: false,
          error: fs.message_he || fs.message_en,
          insufficient_information: true,
          kernel_v16: { code: fs.code }
        };
      }
      const br = evaluateBreakdown(signalsObj);
      if (!br.breakdown) {
        return {
          ok: false,
          error:
            'לא זוהתה שבירה (B) לפי אותות שנשלחו — אין מעבר ל-N. עצירה: לא ממשיכים ללא breakdown.',
          kernel_v16: { code: 'NO_BREAKDOWN', stop_to_N: true }
        };
      }
    } else if (strict) {
      return {
        ok: false,
        error: 'במצב KERNEL_V16_STRICT נדרש אובייקט kernel_signals עם זיהוי שבירה לשלב N.',
        kernel_v16: { code: 'SIGNALS_REQUIRED_FOR_N' }
      };
    }
  }

  if (firstVisitToL) {
    if (!completedSet.has('N')) {
      return { ok: false, error: 'אין מעבר ל-L ללא השלמת שלב N.' };
    }
    const strict = isStrictV16();
    const lv = kernelSignals?.l_validation ?? kernelSignals?.lValidation;
    if (lv) {
      const lg = validateLGate(lv);
      if (!lg.ok) {
        return {
          ok: false,
          error: `וידיאציית L נכשלה (${lg.reason}). נדרשו: ≥3 הרצות, שיפור מובהק מול baseline, יציבות.`,
          kernel_v16: { code: lg.reason }
        };
      }
    } else if (strict) {
      return {
        ok: false,
        error: 'במצב KERNEL_V16_STRICT נדרש l_validation בקלט (≥3 הרצות, שיפור מול baseline, יציבות).',
        kernel_v16: { code: 'L_VALIDATION_REQUIRED' }
      };
    }
  }

  if (!completedSet.has(stage)) {
    completedSet.add(stage);
    const updated = sortStagesByOrder(Array.from(completedSet));
    let kernelPatch = { updated_at: new Date().toISOString() };
    if (firstVisitToN) {
      const br = kernelSignals && Object.keys(kernelSignals).length > 0 ? evaluateBreakdown(kernelSignals) : null;
      if (br?.breakdown) {
        kernelPatch = {
          ...kernelPatch,
          possibility_shutdown: true,
          breakdown_reasons: br.reasons,
          b_evaluated: true
        };
      } else if (!isStrictV16()) {
        kernelPatch = {
          ...kernelPatch,
          document_mode_n: true
        };
      }
    }
    if (firstVisitToL && (kernelSignals?.l_validation || kernelSignals?.lValidation)) {
      kernelPatch = { ...kernelPatch, l_validated: true };
    }
    const kc = mergeKernelContext(session, kernelPatch);
    try {
      await session.update({
        completed_stages: updated,
        kernel_context: kc,
        updated_at: new Date()
      });
    } catch (e) {
      logger.warn(`Research session update without kernel_context: ${e.message}`);
      await session.update({
        completed_stages: updated,
        updated_at: new Date()
      });
    }
  } else {
    await session.update({ updated_at: new Date() });
  }

  await session.reload();

  let responseType;
  if (stage === 'B') {
    responseType = RESPONSE_TYPE.HARD_STOP;
  } else if (stage === 'K' || stage === 'C') {
    responseType = RESPONSE_TYPE.INFO_ONLY;
  } else {
    responseType = RESPONSE_TYPE.FULL_ANSWER;
  }

  return {
    ok: true,
    session,
    completed_stages: session.completed_stages || workingStages,
    responseType,
    kernel_v16: {
      spec: KERNEL_V16_VERSION,
      possibility_shutdown: !!(session.kernel_context && session.kernel_context.possibility_shutdown)
    }
  };
}

/**
 * Log one audit entry.
 */
export async function logAudit(sessionId, stage, responseType, requestQuery = null) {
  if (!ResearchAuditLog) return;
  try {
    await ResearchAuditLog.create({
      session_id: sessionId,
      stage,
      response_type: responseType,
      request_query: requestQuery ? String(requestQuery).slice(0, 2000) : null
    });
  } catch (e) {
    logger.warn(`Research audit log failed: ${e.message}`);
  }
}

/**
 * Hard Stop message for stage B (no smart answer).
 */
export const HARD_STOP_MESSAGE = 'זהו שלב B – Hard Stop. אין תשובות חכמות בשלב זה.';

/**
 * Strip suggestions from text (for K/C: only existing info, no solutions).
 * Simple heuristic: remove lines that look like recommendations (ממליץ, יש ל..., כדאי, מומלץ, פתרון).
 */
export function stripSuggestions(text) {
  if (!text || typeof text !== 'string') return text;
  const suggestionPatterns = [
    /^[\s\-•]*\.*(ממליץ|ממליצה|מומלץ|כדאי|יש ל|צריך ל|רצוי|פתרון|הצעה|המלצה)[^\n]*$/gim,
    /^[\s\-•]*\.*(לסיכום|בסיכום)[^\n]*$/gim
  ];
  let out = text;
  for (const p of suggestionPatterns) {
    out = out.replace(p, '');
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Thresholds for deterministic pre-LLM evidence gate (tune via env / real queries).
 */
export function getPreLlmGateThresholds() {
  const minSimilarity = parseFloat(process.env.MATRIYA_PRE_LLM_MIN_SIMILARITY || '0.75');
  const minStrongChunks = Math.max(1, parseInt(process.env.MATRIYA_PRE_LLM_MIN_CHUNKS || '2', 10));
  return {
    minSimilarity: Number.isFinite(minSimilarity) ? minSimilarity : 0.75,
    minStrongChunks
  };
}

const MIN_DOC_CHARS_EVIDENCE = 12;

/**
 * Unified retrieval strength for pre-LLM gate: OpenAI rank scores vs vector cosine (stored in `distance`).
 */
export function retrievalSimilarityForGate(hit) {
  if (!hit || typeof hit !== 'object') return 0;
  const doc = String(hit.document ?? hit.text ?? '').trim();
  if (doc.length < MIN_DOC_CHARS_EVIDENCE) return 0;

  const d = hit.distance;
  const rs = hit.relevance_score;

  if (hit.evidence_metric === 'openai_rank' && typeof rs === 'number' && !Number.isNaN(rs)) {
    return Math.min(1, Math.max(0, rs));
  }
  if (hit.evidence_metric === 'cosine' && typeof d === 'number' && !Number.isNaN(d)) {
    return Math.min(1, Math.max(0, d));
  }

  if (typeof d === 'number' && typeof rs === 'number' && d > 0 && d < 0.5 && rs >= 0.5) {
    return Math.min(1, Math.max(0, rs));
  }

  if (typeof d === 'number' && !Number.isNaN(d) && d >= 0 && d <= 1.0001) {
    if (typeof rs === 'number' && rs > 1.01) {
      return Math.min(1, Math.max(0, d));
    }
    return Math.min(1, Math.max(0, d));
  }

  if (typeof rs === 'number' && !Number.isNaN(rs)) {
    return Math.min(1, Math.max(0, Math.min(rs, 1)));
  }
  return 0;
}

/**
 * Steps 1–2 only: no / weak evidence (no DB).
 */
export function evaluatePreLlmEvidenceGate(searchResults) {
  const cfg = getPreLlmGateThresholds();
  const chunks = Array.isArray(searchResults) ? searchResults : [];
  if (chunks.length === 0) {
    return { ok: false, httpStatus: 422, code: 'INSUFFICIENT_EVIDENCE' };
  }
  const substantive = chunks.filter((c) => String(c.document ?? c.text ?? '').trim().length >= MIN_DOC_CHARS_EVIDENCE);
  if (substantive.length === 0) {
    return { ok: false, httpStatus: 422, code: 'INSUFFICIENT_EVIDENCE' };
  }
  const strong = substantive.filter((c) => retrievalSimilarityForGate(c) > cfg.minSimilarity);
  if (strong.length < cfg.minStrongChunks) {
    return { ok: false, httpStatus: 422, code: 'LOW_CONFIDENCE_EVIDENCE' };
  }
  return { ok: true };
}

/** Research FSM only (no DB). Exported for tests / scripts. */
export function evaluatePreLlmFsmGateOnly({ stage, completedStages }) {
  if (!isStageAllowed(completedStages, stage)) {
    return {
      ok: false,
      httpStatus: 409,
      code: 'INVALID_STATE_TRANSITION',
      message: 'Invalid research stage transition (FSM).'
    };
  }
  return { ok: true };
}

/** Map active DB violation row to gate denial (no DB). Exported for tests / scripts. */
export function evaluatePreLlmIntegrityGate(activeViolation) {
  if (!activeViolation) return { ok: true };
  return {
    ok: false,
    httpStatus: 422,
    code: 'INTEGRITY_VIOLATION',
    message: 'Session blocked by active B-Integrity violation.',
    violation_id: activeViolation.id
  };
}

/**
 * Deterministic pre-LLM gate: evidence → research FSM stage → integrity (defense in depth).
 * Order matches product spec: insufficient → low confidence → invalid stage → violation.
 * FSM is checked before querying violations (no extra DB round-trip on bad stage).
 */
export async function evaluatePreLlmResearchGate({ sessionId, stage, completedStages, searchResults }) {
  const ev = evaluatePreLlmEvidenceGate(searchResults);
  if (!ev.ok) return ev;

  const fsm = evaluatePreLlmFsmGateOnly({ stage, completedStages });
  if (!fsm.ok) return fsm;

  const violation = await getActiveViolation(sessionId);
  const integ = evaluatePreLlmIntegrityGate(violation);
  if (!integ.ok) return integ;

  return { ok: true };
}

export { RESPONSE_TYPE, STAGES_ORDER, VALID_STAGES, getNextAllowedStage, isStageAllowed };
