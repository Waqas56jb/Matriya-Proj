/**
 * creativityOrchestrator.js
 *
 * Computes the Eₛ (Emergence Score) for any agent output.
 *
 * Formula:  Eₛ = 0.30·C + 0.25·X + 0.20·B + 0.15·M + 0.10·U
 *
 * Components
 *   C — Conceptual novelty   (0–1)  unique domain terms, non-trivial assertions
 *   X — Cross-domain linking (0–1)  references to external domains / analogies
 *   B — B-proven alignment   (0–1)  measurable / falsifiable claims present
 *   M — Mechanistic depth    (0–1)  causal chain length
 *   U — Uncertainty handling (0–1)  explicit acknowledgement of unknowns
 *
 * Regimes
 *   CREATIVE  ≥ 0.65  → PASS
 *   STRAINED  0.30–0.65 → WARNING + feedback
 *   FLAT      < 0.30  → REJECT + feedback loop (max 3 retries)
 */

const WEIGHTS = { C: 0.30, X: 0.25, B: 0.20, M: 0.15, U: 0.10 };

const MAX_RETRIES = 3;

// ─── Heuristic scorers ────────────────────────────────────────────────────────

function scoreC(text) {
  const domainTerms = (text.match(/\b(formul|mechanism|corrosion|oxidation|barrier|matrix|polymer|alloy|galvanic|substrate|adhesion|thermal|inhibit|passiv|coat|nano|micro|crystal|phase|react|bond|diffus)/gi) || []).length;
  const sentences = text.split(/[.!?]+/).filter(Boolean).length || 1;
  return Math.min(1, domainTerms / (sentences * 1.5));
}

function scoreX(text) {
  const crossDomain = (text.match(/\b(biology|neural|biomimetic|aerospace|medical|optical|quantum|electro|magneti|fluid|thermal|acoustic|digital|software|algorithm|network|analogy|similar to|like a|resembles)/gi) || []).length;
  return Math.min(1, crossDomain / 3);
}

function scoreB(text) {
  const measurable = (text.match(/\b(\d+(\.\d+)?\s*(%|mg|g|kg|mm|nm|µm|°C|K|MPa|GPa|ppm|mol|bar|hz|rpm)|proven|measured|tested|verified|confirmed|experiment|result|data|study|reference)/gi) || []).length;
  return Math.min(1, measurable / 4);
}

function scoreM(text) {
  const causalWords = (text.match(/\b(because|therefore|causes|leads to|results in|due to|hence|consequently|mechanism|pathway|chain|sequence|step|stage|process|flow|reaction|trigger|initiat)/gi) || []).length;
  return Math.min(1, causalWords / 5);
}

function scoreU(text) {
  const uncertaintyWords = (text.match(/\b(unknown|uncertain|unclear|may|might|could|possibly|potentially|further research|not yet|open question|hypothesis|assumption|limit|caveat|however|nevertheless|despite)/gi) || []).length;
  return Math.min(1, uncertaintyWords / 3);
}

// ─── Feedback generator ───────────────────────────────────────────────────────

function buildFeedback(components, regime) {
  const feedback = [];
  if (components.C < 0.4) feedback.push('Increase domain-specific terminology and novel assertions.');
  if (components.X < 0.3) feedback.push('Add cross-domain analogies or references to adjacent fields.');
  if (components.B < 0.3) feedback.push('Include measurable data points or falsifiable claims.');
  if (components.M < 0.3) feedback.push('Elaborate the causal/mechanistic chain (why → how → result).');
  if (components.U < 0.2) feedback.push('Acknowledge uncertainties, limitations, or open questions.');
  if (regime === 'FLAT') feedback.push('Output is too generic — restructure with specific technical content.');
  return feedback;
}

// ─── Core scorer ─────────────────────────────────────────────────────────────

function computeEs(text) {
  const C = scoreC(text);
  const X = scoreX(text);
  const B = scoreB(text);
  const M = scoreM(text);
  const U = scoreU(text);

  const Es_score = parseFloat(
    (WEIGHTS.C * C + WEIGHTS.X * X + WEIGHTS.B * B + WEIGHTS.M * M + WEIGHTS.U * U).toFixed(4)
  );

  const components = { C, X, B, M, U };

  let regime;
  if (Es_score >= 0.65) regime = 'CREATIVE';
  else if (Es_score >= 0.30) regime = 'STRAINED';
  else regime = 'FLAT';

  return { Es_score, regime, components };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Evaluate a single agent output.
 *
 * @param {{ text: string, agent_name: string }} input
 * @returns {{ Es_score: number, regime: string, components: object, feedback: string[] }}
 */
function evaluate({ text, agent_name }) {
  if (!text || typeof text !== 'string') {
    throw new Error('creativityOrchestrator.evaluate: `text` must be a non-empty string');
  }

  const { Es_score, regime, components } = computeEs(text);
  const feedback = regime === 'CREATIVE' ? [] : buildFeedback(components, regime);

  return {
    agent_name: agent_name || 'unknown',
    Es_score,
    regime,
    components,
    feedback,
  };
}

/**
 * Evaluate with automatic retry loop for FLAT outputs.
 * Each retry appends previous feedback to the text so callers can build on it.
 * In a real pipeline the caller would regenerate; here we re-score and record attempts.
 *
 * @param {{ text: string, agent_name: string }} input
 * @param {Function} [regenerate]  optional async fn(feedback) → new text
 * @returns {Promise<{ Es_score, regime, components, feedback, attempts }>}
 */
async function evaluateWithRetry({ text, agent_name }, regenerate = null) {
  let current = text;
  let result;
  let attempts = 0;

  do {
    attempts += 1;
    result = evaluate({ text: current, agent_name });

    if (result.regime !== 'FLAT') break;
    if (attempts >= MAX_RETRIES) break;

    if (regenerate) {
      current = await regenerate(result.feedback);
    } else {
      break;
    }
  } while (attempts < MAX_RETRIES);

  return { ...result, attempts };
}

export { evaluate, evaluateWithRetry, computeEs, WEIGHTS, MAX_RETRIES };
