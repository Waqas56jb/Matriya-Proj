/**
 * agents/orchestration.js
 *
 * Milestone 0 — MATRIYA Pipeline Orchestration
 *
 * runPipeline(input) → { consilium, gate, score, decision, experiment }
 *
 * Maps the five MATRIYA reasoning stages into a single async call,
 * bridging the existing LLM / RAG infrastructure:
 *
 *   consilium  — knowledge gathering (RAG / LLM context)
 *   gate       — domain + eligibility gate
 *   score      — Emergence Score (Eₛ)
 *   decision   — GO / STOP / ITERATE + reason text (= WhatsApp reply)
 *   experiment — suggested follow-up experiment (if applicable)
 */

import axios from 'axios';
import logger from '../logger.js';
import settings from '../config.js';
import { evaluate as evaluateCreativity } from '../services/creativityOrchestrator.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Lightweight domain check: is the message related to MATRIYA's chemistry/coatings domain? */
function checkDomainGate(input) {
  const domainTerms = /\b(formul|corrosion|coating|experiment|viscosit|polymer|alloy|substrate|inhibit|passiv|adhesion|thermal|nano|crystal|react|bond|intumesc|material|lab|test|result|ציפוי|נוסחה|ניסוי|חומר|תוצאות|מעבדה)/i;
  const passed = domainTerms.test(input);
  return {
    passed,
    stage: passed ? 'DOMAIN_PASS' : 'DOMAIN_WARN',
    reason: passed ? 'Input matches MATRIYA domain' : 'Input may be outside core domain — answering best-effort'
  };
}

/** Call OpenAI to get a structured MATRIYA answer for the input. */
async function callLlm(input) {
  const apiKey = (settings.OPENAI_API_KEY || process.env.OPENAI_API_KEY || '').trim();
  const model = settings.OPENAI_RAG_MODEL || process.env.OPENAI_RAG_MODEL || 'gpt-4o-mini';
  const base = (settings.OPENAI_API_BASE || process.env.OPENAI_API_BASE || 'https://api.openai.com/v1').replace(/\/$/, '');

  if (!apiKey) {
    return {
      answer: 'MATRIYA מערכת לא מוגדרת עם מפתח LLM. אנא פנה למנהל המערכת.',
      decision_status: 'INSUFFICIENT_DATA',
      experiment_suggestion: null
    };
  }

  const systemPrompt = `You are MATRIYA, an advanced materials science AI assistant.
You specialize in coatings, corrosion protection, intumescent formulations, and lab experiments.
Answer in the same language the user wrote in (Hebrew if Hebrew, English if English).
Be concise (max 3 sentences for WhatsApp). End with: decision = GO | STOP | ITERATE.`;

  const resp = await axios.post(
    `${base}/chat/completions`,
    {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: input }
      ],
      max_tokens: 400,
      temperature: 0.3
    },
    {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 20000
    }
  );

  const text = resp.data?.choices?.[0]?.message?.content || '';

  // Extract decision keyword from response
  let decision_status = 'INCONCLUSIVE';
  if (/decision\s*=\s*GO/i.test(text)) decision_status = 'VALID_CONCLUSION';
  else if (/decision\s*=\s*STOP/i.test(text)) decision_status = 'INSUFFICIENT_DATA';
  else if (/decision\s*=\s*ITERATE/i.test(text)) decision_status = 'INCONCLUSIVE';

  // Extract experiment suggestion if present
  const expMatch = text.match(/experiment[:\s]+(.+)/i);

  return {
    answer: text.replace(/decision\s*=\s*(GO|STOP|ITERATE)/i, '').trim(),
    decision_status,
    experiment_suggestion: expMatch ? expMatch[1].trim() : null
  };
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Run the full MATRIYA pipeline for a given input string.
 *
 * @param {string} input — raw user message (WhatsApp body)
 * @returns {{ consilium, gate, score, decision, experiment }}
 */
export async function runPipeline(input) {
  const startedAt = Date.now();
  logger.info(`[pipeline] runPipeline: "${input.slice(0, 80)}..."`);

  // 1. Consilium — knowledge gathering
  const consilium = {
    input,
    sources: [],
    context: `MATRIYA pipeline started for: "${input.slice(0, 120)}"`,
    timestamp: new Date().toISOString()
  };

  // 2. Gate — domain eligibility check
  const gate = checkDomainGate(input);

  // 3. LLM call — produces answer + decision_status + experiment_suggestion
  let llmResult;
  try {
    llmResult = await callLlm(input);
  } catch (e) {
    logger.error(`[pipeline] LLM call failed: ${e.message}`);
    llmResult = {
      answer: `MATRIYA: לא ניתן לעבד כרגע. שגיאה: ${e.message}`,
      decision_status: 'INSUFFICIENT_DATA',
      experiment_suggestion: null
    };
  }

  // 4. Score — Emergence Score using creativityOrchestrator
  const scoreResult = evaluateCreativity(llmResult.answer || '');
  const score = {
    emergence_score: scoreResult.score ?? 0,
    regime: scoreResult.regime ?? 'UNKNOWN',
    components: scoreResult.components ?? {}
  };

  // 5. Decision — GO / STOP / ITERATE
  const actionMap = {
    VALID_CONCLUSION: 'GO',
    INCONCLUSIVE: 'ITERATE',
    NO_CHANGE: 'ITERATE',
    INSUFFICIENT_DATA: 'STOP',
    STRUCTURAL_INCOMPLETE: 'STOP',
    INVALID_EXPERIMENT: 'STOP',
    REFERENCE_ONLY: 'STOP'
  };
  const decision = {
    status: llmResult.decision_status,
    action_required: actionMap[llmResult.decision_status] ?? 'STOP',
    reason: llmResult.answer,
    elapsed_ms: Date.now() - startedAt
  };

  // 6. Experiment — optional follow-up suggestion
  const experiment = llmResult.experiment_suggestion
    ? { suggestion: llmResult.experiment_suggestion, status: 'PROPOSED' }
    : null;

  logger.info(`[pipeline] done in ${decision.elapsed_ms}ms — action=${decision.action_required}`);
  return { consilium, gate, score, decision, experiment };
}

/** Build a structured action package from pipeline result (used by handleOutbound). */
export function createActionPackage(pipelineResult, recipientPhone) {
  return {
    to: recipientPhone,
    message: pipelineResult.decision?.reason || 'MATRIYA: עיבוד הושלם.',
    expectedResponseType: pipelineResult.decision?.action_required ?? 'STOP',
    pipeline_result: pipelineResult,
    created_at: new Date().toISOString()
  };
}
