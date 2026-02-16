/**
 * Stage 1 – Research FSM Gate (FSCTM)
 * Enforces: K→C→B→N→L only. No skip. Gate rules per stage.
 * When an active B-Integrity Violation exists for the session, the gate is locked.
 */
import { ResearchSession, ResearchAuditLog, STAGES_ORDER } from './database.js';
import { getActiveViolation } from './integrityMonitor.js';
import logger from './logger.js';

const VALID_STAGES = new Set(STAGES_ORDER);

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
 */
export async function validateAndAdvance(sessionId, stage, userId = null) {
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
      research_gate_locked: true
    };
  }
  const data = await getSession(sessionId);
  if (!data) {
    return { ok: false, error: 'Invalid or expired session. Use a valid session_id from POST /research/session.' };
  }
  const { session, completed_stages } = data;
  if (!isStageAllowed(completed_stages, stage)) {
    const next = getNextAllowedStage(completed_stages);
    return {
      ok: false,
      error: `Invalid stage transition. Allowed next stage: ${next}. Order is K→C→B→N→L only.`
    };
  }

  const completedSet = new Set(completed_stages);
  if (!completedSet.has(stage)) {
    completedSet.add(stage);
    const updated = Array.from(completedSet).sort(
      (a, b) => STAGES_ORDER.indexOf(a) - STAGES_ORDER.indexOf(b)
    );
    await session.update({
      completed_stages: updated,
      updated_at: new Date()
    });
  }

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
    completed_stages: session.completed_stages || completed_stages,
    responseType
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

export { RESPONSE_TYPE, STAGES_ORDER, VALID_STAGES, getNextAllowedStage, isStageAllowed };
