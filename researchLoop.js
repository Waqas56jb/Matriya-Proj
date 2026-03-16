/**
 * Research Loop MVP – fixed 4-agent chain: analysis → research → critic → synthesis.
 * After each agent: save output, create Justification if change.
 * Justification labels/descriptions come from justification templates when available.
 */
import logger from './logger.js';
import { ResearchLoopRun } from './database.js';
import { getJustificationDisplay } from './justificationTemplates.js';

const AGENT_ORDER = ['analysis', 'research', 'critic', 'synthesis'];

function getAgentPrompt(agentName, query, previousOutput, ragContext = null) {
  const prev = previousOutput ? `\n\nPrevious step output:\n${String(previousOutput).slice(0, 2000)}` : '';
  const docContext = ragContext ? `\n\nDocument context (use if relevant):\n${String(ragContext).slice(0, 5000)}` : '';
  const base = `Query: ${query}${prev}${docContext}`;
  const hebrewOnly = ' Always respond in Hebrew (עברית) only. Do not use Arabic.';
  const prompts = {
    analysis: {
      system: 'You are the analysis agent. Analyze the query and previous context. Output a concise analysis in Hebrew (עברית) only.' + hebrewOnly,
      user: base
    },
    research: {
      system: 'You are the research agent. Based on the analysis and document context above, produce a short research summary in Hebrew (עברית) only.' + hebrewOnly,
      user: base
    },
    critic: {
      system: 'You are the critic agent. Review the research output critically. Point out gaps or strengths briefly. Respond in Hebrew (עברית) only.' + hebrewOnly,
      user: base
    },
    synthesis: {
      system: 'You are the synthesis agent. Synthesize the analysis, research, and critique into a final concise conclusion in Hebrew (עברית) only. Do not use Arabic.',
      user: base
    }
  };
  return prompts[agentName] || { system: 'Process the input.', user: base };
}

/**
 * Run one agent: build context and call LLM.
 */
async function runAgent(agentName, query, previousOutput, ragService, ragContextForResearch = null) {
  const { system, user } = getAgentPrompt(agentName, query, previousOutput, ragContextForResearch);
  const llm = ragService.llmService;
  if (!llm || !llm.isAvailable()) {
    return { output: null, error: 'LLM not available' };
  }
  const context = `${system}\n\n${user}`;
  const question = query;
  try {
    const output = await llm.generateAnswer(question, context, 600);
    return { output: output || '', error: null };
  } catch (e) {
    logger.error(`Research loop agent ${agentName} error: ${e.message}`);
    return { output: null, error: e.message };
  }
}

/**
 * Run the full 4-agent loop. After each agent: save output, justification if changed.
 * No Integrity Monitor – just the 4 agents (no K/C/B/N/L snapshots or violation checks).
 * @param {string} sessionId - Research session UUID
 * @param {string} query - User query
 * @param {object} ragService - RAG service (has llmService, generateAnswer)
 * @param {object|null} filterMetadata - Optional { filename } to restrict RAG to one file
 * @param {object|null} runOptions - Optional { pre_justification_text, doe_design_id }
 * @returns {Promise<{ run_id, outputs, justifications, error? }>}
 */
export async function runLoop(sessionId, query, ragService, filterMetadata = null, runOptions = null) {
  const startMs = Date.now();
  const outputs = {};
  const justifications = [];

  let previousOutput = null;
  let ragContext = null;

  // When searching a single file, use fewer chunks; when no filter or multiple filenames (project scope), use more
  const singleFileFilter = filterMetadata && typeof filterMetadata.filename === 'string' && filterMetadata.filename.trim();
  const isAllFiles = !singleFileFilter;
  const nResults = isAllFiles ? 20 : 5;
  const maxContextChars = isAllFiles ? 6000 : 3000;

  try {
    if (ragService.generateAnswer) {
      const res = await ragService.generateAnswer(query, nResults, filterMetadata || null, false);
      let text = (res.context || res.results?.map(r => r.document || r.content).join('\n') || '').slice(0, maxContextChars);
      if (filterMetadata) {
        const files = Array.isArray(filterMetadata.filenames) && filterMetadata.filenames.length > 0
          ? filterMetadata.filenames
          : (typeof filterMetadata.filename === 'string' && filterMetadata.filename.trim() ? [filterMetadata.filename] : null);
        if (files && files.length > 0) {
          const sourceLine = `Sources (files) this answer is based on: ${files.join(', ')}.\n\n`;
          text = sourceLine + text;
        }
      }
      ragContext = text;
    }
  } catch (e) {
    logger.warn(`RAG context for research step: ${e.message}`);
  }

  for (const agentName of AGENT_ORDER) {
    const { output, error } = await runAgent(
      agentName,
      query,
      previousOutput,
      ragService,
      ragContext
    );
    if (error) {
      return {
        run_id: null,
        outputs,
        justifications,
        error: `Agent ${agentName} failed: ${error}`
      };
    }
    const out = (output || '').trim();
    outputs[agentName] = out;
    if (previousOutput !== null && out !== previousOutput) {
      const reasonCode = 'output_changed';
      const ctx = { agent: agentName, previous_snippet: String(previousOutput).slice(0, 200) };
      const display = await getJustificationDisplay(reasonCode, ctx);
      justifications.push({
        agent: agentName,
        reason: reasonCode,
        ...display,
        previous_snippet: ctx.previous_snippet,
        created_at: new Date().toISOString()
      });
    }
    previousOutput = out;
  }

  const durationMs = Date.now() - startMs;
  const opts = runOptions && typeof runOptions === 'object' ? runOptions : {};
  const runRecord = await saveRun(sessionId, query, outputs, justifications, false, null, durationMs, opts.pre_justification_text ?? null, opts.doe_design_id ?? null);
  return {
    run_id: runRecord?.id ?? null,
    outputs,
    justifications,
    duration_ms: durationMs
  };
}

async function saveRun(sessionId, query, outputs, justifications, stoppedByViolation = false, violationId = null, durationMs = null, preJustificationText = null, doeDesignId = null) {
  if (!ResearchLoopRun) return null;
  try {
    const run = await ResearchLoopRun.create({
      session_id: sessionId,
      query,
      outputs: outputs || {},
      justifications: justifications || [],
      stopped_by_violation: stoppedByViolation,
      violation_id: violationId,
      duration_ms: durationMs,
      pre_justification_text: preJustificationText || null,
      doe_design_id: doeDesignId || null
    });
    return run;
  } catch (e) {
    logger.warn(`Failed to save research loop run: ${e.message}`);
    return null;
  }
}

export { AGENT_ORDER };
