/**
 * twilioGateway.js — Shared Transport Module
 *
 * Milestones 1 & 2: Twilio WhatsApp inbound + outbound gateway.
 *
 * Functions exported:
 *   verifyTwilioSignature(req)              → boolean
 *   handleInbound(req, res)                 → Express handler (POST /api/whatsapp/inbound)
 *   handleOutbound(actionPackage)           → async, sends WhatsApp + logs ticket
 *   sendWhatsAppMessage(to, body)           → async
 *   logTicket(phone, content, direction, parentId?) → async → UUID
 *
 * Database table required (run sql/twilio_tickets.sql once in Supabase):
 *   twilio_tickets — id, phone_number, direction, message, pipeline_result,
 *                    action_package, parent_ticket_id, created_at
 *
 * Environment variables:
 *   TWILIO_ACCOUNT_SID        — Twilio account SID
 *   TWILIO_AUTH_TOKEN         — Twilio auth token (also enables signature check)
 *   TWILIO_WHATSAPP_NUMBER    — Your Twilio WhatsApp number, e.g. +14155238886
 *   TWILIO_WEBHOOK_PUBLIC_URL — Full public URL of POST /api/whatsapp/inbound
 *   SUPABASE_URL              — Supabase project URL
 *   SUPABASE_KEY / SUPABASE_SERVICE_ROLE_KEY — Supabase service key
 */

import twilio from 'twilio';
import { createClient } from '@supabase/supabase-js';
import { runPipeline, createActionPackage } from './agents/orchestration.js';
import logger from './logger.js';

// ─── Lazy singletons ──────────────────────────────────────────────────────────

let _twilioClient = null;
function getTwilioClient() {
  if (_twilioClient) return _twilioClient;
  const sid = (process.env.TWILIO_ACCOUNT_SID || '').trim();
  const token = (process.env.TWILIO_AUTH_TOKEN || '').trim();
  if (!sid || !token) throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required');
  _twilioClient = twilio(sid, token);
  return _twilioClient;
}

let _supabase = null;
function getSupabase() {
  if (_supabase) return _supabase;
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim();
  const key = (process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_KEY are required for Twilio gateway');
  _supabase = createClient(url, key);
  return _supabase;
}

// ─── 1. Signature Verification ────────────────────────────────────────────────

/**
 * Verifies the X-Twilio-Signature header using TWILIO_AUTH_TOKEN.
 * Returns true if valid OR if TWILIO_AUTH_TOKEN is not set (dev mode).
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
export function verifyTwilioSignature(req) {
  const authToken = (process.env.TWILIO_AUTH_TOKEN || '').trim();
  if (!authToken) {
    logger.warn('[twilioGateway] TWILIO_AUTH_TOKEN not set — skipping signature check (dev mode)');
    return true;
  }

  const twilioSignature = (req.headers['x-twilio-signature'] || '').trim();
  if (!twilioSignature) return false;

  // Always derive the URL from the actual request so it matches whatever URL
  // is configured in the Twilio Console for this specific endpoint.
  // trust proxy: 1 is set in server.js so req.protocol is correctly "https" behind Vercel.
  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  const params = req.body || {};

  return twilio.validateRequest(authToken, twilioSignature, url, params);
}

// ─── 2. Inbound Handler (Milestone 1) ─────────────────────────────────────────

/**
 * POST /api/whatsapp/inbound
 *
 * 1. Verify Twilio signature
 * 2. Log inbound ticket to twilio_tickets
 * 3. Run MATRIYA pipeline
 * 4. Send response via WhatsApp
 * 5. Log outbound ticket (with parent_ticket_id)
 * 6. Return <Response></Response> so Twilio marks webhook as handled
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function handleInbound(req, res) {
  // Signature check
  if (!verifyTwilioSignature(req)) {
    logger.warn('[twilioGateway] handleInbound: invalid Twilio signature');
    return res.status(403).send('Invalid signature');
  }

  const from = (req.body?.From || '').trim();        // whatsapp:+972...
  const userMessage = (req.body?.Body || '').trim();

  if (!from || !userMessage) {
    logger.warn('[twilioGateway] handleInbound: missing From or Body');
    // Still return 200 so Twilio doesn't retry
    res.set('Content-Type', 'text/xml');
    return res.send('<Response></Response>');
  }

  logger.info(`[twilioGateway] inbound from=${from} message="${userMessage.slice(0, 80)}"`);

  // Log inbound ticket
  let ticketId;
  try {
    ticketId = await logTicket(from, userMessage, 'inbound');
  } catch (e) {
    logger.error(`[twilioGateway] logTicket(inbound) failed: ${e.message}`);
  }

  // Run MATRIYA pipeline
  let pipelineResult;
  try {
    pipelineResult = await runPipeline(userMessage);
  } catch (e) {
    logger.error(`[twilioGateway] runPipeline failed: ${e.message}`);
    pipelineResult = {
      consilium: { input: userMessage },
      gate: { passed: false },
      score: { emergence_score: 0 },
      decision: { status: 'INSUFFICIENT_DATA', action_required: 'STOP', reason: 'MATRIYA: שגיאה בעיבוד הבקשה. אנא נסה שנית.' },
      experiment: null
    };
  }

  const replyText = pipelineResult.decision?.reason || 'MATRIYA: עיבוד הושלם.';

  // Send WhatsApp reply (async, don't block the response)
  sendWhatsAppMessage(from, replyText).catch(e =>
    logger.error(`[twilioGateway] sendWhatsAppMessage failed: ${e.message}`)
  );

  // Log outbound ticket
  logTicket(from, pipelineResult, 'outbound', ticketId).catch(e =>
    logger.error(`[twilioGateway] logTicket(outbound) failed: ${e.message}`)
  );

  // Acknowledge to Twilio — empty TwiML, reply is sent via Messages API above
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');
}

// ─── 3. Outbound Handler (Milestone 2) ────────────────────────────────────────

/**
 * Send an action package as a WhatsApp message and log it.
 * Called after createActionPackage() produces a { to, message, expectedResponseType } object.
 *
 * @param {{ to: string, message: string, expectedResponseType: string, pipeline_result?: any }} actionPackage
 */
export async function handleOutbound(actionPackage) {
  const { to, message, expectedResponseType } = actionPackage;

  if (!to || !message) {
    logger.warn('[twilioGateway] handleOutbound: missing to or message');
    return;
  }

  logger.info(`[twilioGateway] outbound to=${to} action=${expectedResponseType}`);

  await sendWhatsAppMessage(to, message);
  await logTicket(to, actionPackage, 'outbound_action').catch(e =>
    logger.error(`[twilioGateway] logTicket(outbound_action) failed: ${e.message}`)
  );
}

// ─── 4. WhatsApp Sender ────────────────────────────────────────────────────────

/**
 * Send a WhatsApp message via the Twilio Messages API.
 *
 * @param {string} to   — recipient address, e.g. "whatsapp:+972..." or plain "+972..."
 * @param {string} body — message text
 */
export async function sendWhatsAppMessage(to, body) {
  const fromRaw = (process.env.TWILIO_WHATSAPP_NUMBER || process.env.TWILIO_WHATSAPP_FROM || '').trim();
  if (!fromRaw) {
    logger.warn('[twilioGateway] TWILIO_WHATSAPP_NUMBER not set — cannot send WhatsApp message');
    return;
  }

  const from = fromRaw.startsWith('whatsapp:') ? fromRaw : `whatsapp:${fromRaw}`;
  const toAddr = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;

  await getTwilioClient().messages.create({ from, to: toAddr, body });
  logger.info(`[twilioGateway] message sent to ${toAddr}`);
}

// ─── 5. Shared Ticket Logging ─────────────────────────────────────────────────

/**
 * Insert a row into twilio_tickets and return the new UUID.
 *
 * @param {string}  phone      — phone number / WhatsApp address
 * @param {any}     content    — message text (string) or pipeline result / action package (object)
 * @param {string}  direction  — 'inbound' | 'outbound' | 'outbound_action'
 * @param {string=} parentId   — UUID of parent ticket for outbound replies
 * @returns {Promise<string|null>} new ticket UUID or null on error
 */
export async function logTicket(phone, content, direction, parentId) {
  try {
    const row = {
      phone_number: phone,
      direction,
      parent_ticket_id: parentId || null,
      created_at: new Date().toISOString()
    };

    if (typeof content === 'string') {
      row.message = content;
    } else {
      row.message = content?.decision?.reason || content?.message || JSON.stringify(content).slice(0, 500);
      row.pipeline_result = content?.consilium !== undefined ? content : null;
      row.action_package = content?.expectedResponseType !== undefined ? content : null;
    }

    const { data, error } = await getSupabase()
      .from('twilio_tickets')
      .insert([row])
      .select('id')
      .single();

    if (error) {
      logger.error(`[twilioGateway] logTicket DB error: ${error.message}`);
      return null;
    }

    return data?.id ?? null;
  } catch (e) {
    logger.error(`[twilioGateway] logTicket exception: ${e.message}`);
    return null;
  }
}

// ─── Re-export createActionPackage for use in existing routes ─────────────────
export { createActionPackage };
