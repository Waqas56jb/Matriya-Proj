/**
 * services/whatsappPipeline.js
 *
 * WhatsApp Pipeline — closes the loop.
 *
 * Polls the `whatsapp_tasks` table every 30 seconds for rows with status = PENDING.
 * For each pending task:
 *   1. Read the message
 *   2. Run through the 9-agent MATRIYA pipeline (runPipeline)
 *   3. Extract GO / WAIT / NO-GO + confidence + summary
 *   4. Send WhatsApp reply to David's number via Twilio
 *   5. Update row status: PENDING → DONE
 *
 * For Vercel (serverless): use GET /api/whatsapp/process-pending (cron endpoint)
 * For long-running servers: call startPolling() once at startup
 *
 * Env vars required:
 *   SUPABASE_URL, SUPABASE_KEY / SUPABASE_SERVICE_ROLE_KEY
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
 *   TWILIO_WHATSAPP_FROM   — sender number, e.g. whatsapp:+14155238886
 *   DAVID_WHATSAPP         — recipient, e.g. whatsapp:+972544568078
 */

import { createClient } from '@supabase/supabase-js';
import twilio from 'twilio';
import { runPipeline } from '../agents/orchestration.js';
import logger from '../logger.js';

const TABLE = 'whatsapp_tasks';
const POLL_INTERVAL_MS = 30_000; // 30 seconds

// ─── Lazy singletons ──────────────────────────────────────────────────────────

let _sb = null;
function getSupabase() {
  if (_sb) return _sb;
  const url = (process.env.SUPABASE_URL || '').trim();
  const key = (process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_KEY are required for whatsappPipeline');
  _sb = createClient(url, key);
  return _sb;
}

let _twilio = null;
function getTwilio() {
  if (_twilio) return _twilio;
  const sid = (process.env.TWILIO_ACCOUNT_SID || '').trim();
  const token = (process.env.TWILIO_AUTH_TOKEN || '').trim();
  if (!sid || !token) throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required');
  _twilio = twilio(sid, token);
  return _twilio;
}

// ─── Reply formatter ──────────────────────────────────────────────────────────

/**
 * Map pipeline action_required → emoji + label for David's reply.
 *   GO     → ✅ GO
 *   ITERATE → ⚠️ WAIT
 *   STOP   → ❌ NO-GO
 */
function mapAction(action_required) {
  switch ((action_required || '').toUpperCase()) {
    case 'GO':      return '✅ GO';
    case 'ITERATE': return '⚠️ WAIT';
    case 'STOP':
    default:        return '❌ NO-GO';
  }
}

/**
 * Build the WhatsApp reply string in David's requested format:
 *
 * ✅ MATRIYA Result:
 * GO
 * Confidence: 75%
 * Summary: [one sentence]
 */
function formatReply(pipelineResult) {
  const action    = pipelineResult?.decision?.action_required ?? 'STOP';
  const rawScore  = pipelineResult?.score?.emergence_score ?? 0;
  const confidence = Math.round(Math.min(Math.max(rawScore, 0), 1) * 100);

  // One-sentence summary: first sentence of decision.reason, stripped of trailing "decision = X"
  const fullReason = (pipelineResult?.decision?.reason || '').replace(/decision\s*=\s*(GO|STOP|ITERATE)/gi, '').trim();
  const firstSentence = fullReason.split(/[.!?\n]/)[0].trim() || 'No summary available.';

  return (
    `✅ MATRIYA Result:\n` +
    `${mapAction(action)}\n` +
    `Confidence: ${confidence}%\n` +
    `Summary: ${firstSentence}`
  );
}

// ─── Core processing ──────────────────────────────────────────────────────────

/**
 * Fetch all PENDING rows from whatsapp_tasks, process each through the pipeline,
 * send the reply, and mark DONE.
 *
 * @returns {{ processed: number, errors: number }}
 */
export async function processPendingTasks() {
  const sb = getSupabase();

  // Fetch PENDING rows
  const { data: tasks, error: fetchError } = await sb
    .from(TABLE)
    .select('id, from_number, message')
    .eq('status', 'PENDING')
    .order('received_at', { ascending: true })
    .limit(20); // process at most 20 per cycle to avoid timeout

  if (fetchError) {
    logger.error(`[whatsappPipeline] fetch error: ${fetchError.message}`);
    return { processed: 0, errors: 1 };
  }

  if (!tasks || tasks.length === 0) {
    logger.info('[whatsappPipeline] no pending tasks');
    return { processed: 0, errors: 0 };
  }

  logger.info(`[whatsappPipeline] processing ${tasks.length} pending task(s)`);

  let processed = 0;
  let errors = 0;

  for (const task of tasks) {
    try {
      // 1. Run the MATRIYA pipeline
      logger.info(`[whatsappPipeline] task ${task.id} → runPipeline("${task.message.slice(0, 60)}")`);
      const pipelineResult = await runPipeline(task.message);

      // 2. Format the reply
      const replyText = formatReply(pipelineResult);
      logger.info(`[whatsappPipeline] task ${task.id} → reply: ${replyText.replace(/\n/g, ' | ')}`);

      // 3. Send WhatsApp reply to David's number
      await sendReply(replyText);

      // 4. Mark task as DONE
      const { error: updateError } = await sb
        .from(TABLE)
        .update({ status: 'DONE' })
        .eq('id', task.id);

      if (updateError) {
        logger.error(`[whatsappPipeline] update error for ${task.id}: ${updateError.message}`);
        errors++;
      } else {
        logger.info(`[whatsappPipeline] task ${task.id} → DONE`);
        processed++;
      }

    } catch (e) {
      logger.error(`[whatsappPipeline] error on task ${task.id}: ${e.message}`);
      errors++;

      // Mark as ERROR so it's not retried endlessly
      try {
        await sb.from(TABLE).update({ status: 'ERROR' }).eq('id', task.id);
      } catch (_) { /* best-effort */ }
    }
  }

  return { processed, errors };
}

// ─── Twilio sender ────────────────────────────────────────────────────────────

/**
 * Send a WhatsApp message to David's number (DAVID_WHATSAPP env var).
 * Falls back to TWILIO_WHATSAPP_FROM as "from".
 */
async function sendReply(body) {
  const davidRaw = (process.env.DAVID_WHATSAPP || '').trim();
  const fromRaw  = (process.env.TWILIO_WHATSAPP_FROM || process.env.TWILIO_WHATSAPP_NUMBER || '').trim();

  if (!davidRaw) {
    logger.warn('[whatsappPipeline] DAVID_WHATSAPP not set — skipping reply');
    return;
  }
  if (!fromRaw) {
    logger.warn('[whatsappPipeline] TWILIO_WHATSAPP_FROM not set — skipping reply');
    return;
  }

  const to   = davidRaw.startsWith('whatsapp:') ? davidRaw : `whatsapp:${davidRaw}`;
  const from = fromRaw.startsWith('whatsapp:') ? fromRaw  : `whatsapp:${fromRaw}`;

  await getTwilio().messages.create({ from, to, body });
  logger.info(`[whatsappPipeline] sent reply to ${to}`);
}

// ─── Polling (non-serverless environments) ────────────────────────────────────

let _pollingTimer = null;

/**
 * Start the 30-second polling loop.
 * Safe to call multiple times — only one loop will run.
 * On Vercel, skip this and use the cron endpoint instead.
 */
export function startPolling() {
  if (_pollingTimer) return; // already running
  logger.info(`[whatsappPipeline] starting polling every ${POLL_INTERVAL_MS / 1000}s`);

  const tick = async () => {
    try {
      const result = await processPendingTasks();
      if (result.processed > 0 || result.errors > 0) {
        logger.info(`[whatsappPipeline] tick: processed=${result.processed} errors=${result.errors}`);
      }
    } catch (e) {
      logger.error(`[whatsappPipeline] tick error: ${e.message}`);
    }
  };

  // Run immediately on start, then on interval
  tick();
  _pollingTimer = setInterval(tick, POLL_INTERVAL_MS);
}

/**
 * Stop the polling loop (e.g. for tests or graceful shutdown).
 */
export function stopPolling() {
  if (_pollingTimer) {
    clearInterval(_pollingTimer);
    _pollingTimer = null;
    logger.info('[whatsappPipeline] polling stopped');
  }
}
