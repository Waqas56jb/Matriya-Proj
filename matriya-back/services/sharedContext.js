/**
 * sharedContext.js
 * Shared JSON object passed between all agents in the MATRIYA pipeline.
 * Each run has its own isolated context instance.
 */

function buildDefault() {
  return {
    original_task: null,
    suspected_assumptions: [],
    missing_data_points: [],
    B_proven: false,
    Es_scores: {},
    creativity_feedback: [],
    cache: {},
  };
}

const _contexts = new Map();

/**
 * Create a fresh context for a run.
 * @param {string} runId - unique identifier for this pipeline run
 * @param {string} original_task - the task description
 * @returns {object} the new context
 */
function createContext(runId, original_task = null) {
  const ctx = buildDefault();
  if (original_task !== null) ctx.original_task = original_task;
  _contexts.set(runId, ctx);
  return ctx;
}

/**
 * Merge partial updates into an existing context.
 * @param {string} runId
 * @param {object} updates - partial fields to merge (arrays are concatenated, objects are merged)
 * @returns {object} updated context
 */
function updateContext(runId, updates = {}) {
  if (!_contexts.has(runId)) {
    throw new Error(`sharedContext: no context found for runId "${runId}"`);
  }
  const ctx = _contexts.get(runId);

  for (const [key, value] of Object.entries(updates)) {
    if (Array.isArray(ctx[key]) && Array.isArray(value)) {
      ctx[key] = [...ctx[key], ...value];
    } else if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof ctx[key] === 'object' &&
      !Array.isArray(ctx[key])
    ) {
      ctx[key] = { ...ctx[key], ...value };
    } else {
      ctx[key] = value;
    }
  }

  return ctx;
}

/**
 * Retrieve the current context snapshot for a run.
 * @param {string} runId
 * @returns {object} context (readonly reference — do not mutate directly)
 */
function getContext(runId) {
  if (!_contexts.has(runId)) {
    throw new Error(`sharedContext: no context found for runId "${runId}"`);
  }
  return _contexts.get(runId);
}

/**
 * Delete a context after the run completes (memory cleanup).
 * @param {string} runId
 */
function clearContext(runId) {
  _contexts.delete(runId);
}

export { createContext, updateContext, getContext, clearContext };
