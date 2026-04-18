/**
 * routes/webhook/whatsapp.js
 *
 * POST /api/webhook/whatsapp
 * Receives incoming WhatsApp messages via Twilio webhook.
 * Logs each message to Supabase table `whatsapp_tasks`.
 * Optionally validates X-Twilio-Signature (set TWILIO_AUTH_TOKEN + TWILIO_WEBHOOK_PUBLIC_URL).
 * Optionally runs Claude Code (see env vars below).
 *
 * Supabase DDL (run once):
 * ─────────────────────────────────────────────────────
 * CREATE TABLE whatsapp_tasks (
 *   id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
 *   from_number TEXT        NOT NULL,
 *   message     TEXT        NOT NULL,
 *   received_at TIMESTAMPTZ DEFAULT NOW(),
 *   status      TEXT        DEFAULT 'PENDING'
 * );
 * ─────────────────────────────────────────────────────
 *
 * Env (Twilio — add to matriya-back .env):
 *   TWILIO_AUTH_TOKEN           — Auth token from Twilio Console (enables signature check)
 *   TWILIO_WEBHOOK_PUBLIC_URL   — Full public URL of this route, exactly as configured in Twilio
 *                                 e.g. https://your-api.example.com/api/webhook/whatsapp
 *
 * Env (optional sender allowlist):
 *   WHATSAPP_ALLOWED_FROM       — Comma-separated Twilio From values, e.g. whatsapp:+9725...,whatsapp:+1...
 *
 * Env (Claude Code / automation — optional):
 *   CLAUDE_CODE_WEBHOOK_ENABLED — Set to "1" to run a subprocess after each stored message
 *   CLAUDE_CODE_ARGV_JSON       — JSON array: executable + args (task text is appended last), e.g.
 *                                 ["npx","-y","@anthropic-ai/claude-code","--message"]
 *   CLAUDE_CODE_SCRIPT          — Alternative: path to a Node script; we run: node <script> "<task>"
 *   CLAUDE_CODE_CWD             — Working directory for the subprocess (default: process.cwd())
 *   Each run also sets CLAUDE_WHATSAPP_TASK=<message> in the child environment.
 *
 * Outbound reply (optional — same 24h session as inbound; uses Messages API with Body, not templates):
 *   TWILIO_ACCOUNT_SID            — Account SID (starts with AC...)
 *   TWILIO_WHATSAPP_FROM          — Your Twilio WhatsApp number, e.g. whatsapp:+972539647624
 *   TWILIO_WHATSAPP_REPLY         — Set to "1" to send a short confirmation to the sender (To = inbound From)
 *   TWILIO_REPLY_TEXT_TEMPLATE    — Optional; include {task} for message preview (defaults to Hebrew ack + task)
 */

import crypto from 'crypto';
import { spawn } from 'child_process';
import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import logger from '../../logger.js';

const router = Router();

const TABLE = 'whatsapp_tasks';

/** Lazy Supabase client — safe at import time when env vars may not be present yet. */
let _sbWa = null;
function getSupabase() {
  if (_sbWa) return _sbWa;
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_KEY are required for WhatsApp webhook');
  _sbWa = createClient(url, key);
  return _sbWa;
}

/** Twilio request validation (same algorithm as twilio-node). */
function validateTwilioSignature(authToken, twilioSignature, url, params) {
  if (!authToken || !twilioSignature || !url || !params) return false;
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + (params[key] ?? '');
  }
  const expected = crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
  try {
    const a = Buffer.from(twilioSignature, 'utf-8');
    const b = Buffer.from(expected, 'utf-8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function getWebhookPublicUrl(req) {
  const explicit = (process.env.TWILIO_WEBHOOK_PUBLIC_URL || '').trim();
  if (explicit) return explicit.replace(/\/$/, '');
  const host = req.get('host') || '';
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const path = (req.originalUrl || req.url || '').split('?')[0];
  return `${proto}://${host}${path}`;
}

/**
 * Reply to the user who messaged you: To = their whatsapp:+..., From = your Twilio WhatsApp number.
 * Works inside the customer care / session window after they messaged you (freeform Body).
 */
async function sendWhatsAppReplyToSender(toAddress, inboundMessage) {
  if (process.env.TWILIO_WHATSAPP_REPLY !== '1') return;

  const accountSid = (process.env.TWILIO_ACCOUNT_SID || '').trim();
  const authToken = (process.env.TWILIO_AUTH_TOKEN || '').trim();
  let fromRaw = (process.env.TWILIO_WHATSAPP_FROM || '').trim();

  if (!accountSid || !authToken || !fromRaw) {
    logger.warn('TWILIO_WHATSAPP_REPLY=1 but TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or TWILIO_WHATSAPP_FROM missing');
    return;
  }

  const from = fromRaw.startsWith('whatsapp:') ? fromRaw : `whatsapp:${fromRaw}`;
  const preview =
    inboundMessage.length > 900 ? `${inboundMessage.slice(0, 900)}…` : inboundMessage;
  const template = (process.env.TWILIO_REPLY_TEXT_TEMPLATE || '').trim();
  const bodyText = template
    ? template.split('{task}').join(preview)
    : `MATRIYA: קיבלנו את המשימה ונריץ עיבוד.\n\n${preview}`;

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const params = new URLSearchParams();
  params.set('From', from);
  params.set('To', toAddress);
  params.set('Body', bodyText);

  await axios.post(url, params.toString(), {
    auth: { username: accountSid, password: authToken },
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15000
  });
}

function triggerClaudeCode(task) {
  if (process.env.CLAUDE_CODE_WEBHOOK_ENABLED !== '1') return;

  const cwd = (process.env.CLAUDE_CODE_CWD || '').trim() || process.cwd();
  const env = { ...process.env, CLAUDE_WHATSAPP_TASK: task };

  const argvJson = (process.env.CLAUDE_CODE_ARGV_JSON || '').trim();
  const script = (process.env.CLAUDE_CODE_SCRIPT || '').trim();

  try {
    if (argvJson) {
      const argv = JSON.parse(argvJson);
      if (!Array.isArray(argv) || argv.length === 0) {
        throw new Error('CLAUDE_CODE_ARGV_JSON must be a non-empty JSON array');
      }
      const [exe, ...args] = argv;
      const child = spawn(exe, [...args, task], {
        cwd,
        env,
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
      child.on('error', (err) => logger.error(`Claude Code spawn: ${err.message}`));
      logger.info('Claude Code subprocess started (CLAUDE_CODE_ARGV_JSON)');
      return;
    }
    if (script) {
      const child = spawn(process.execPath, [script, task], {
        cwd,
        env,
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
      child.on('error', (err) => logger.error(`Claude Code spawn: ${err.message}`));
      logger.info(`Claude Code subprocess started (CLAUDE_CODE_SCRIPT=${script})`);
      return;
    }
    logger.warn('CLAUDE_CODE_WEBHOOK_ENABLED=1 but neither CLAUDE_CODE_ARGV_JSON nor CLAUDE_CODE_SCRIPT is set');
  } catch (e) {
    logger.error(`triggerClaudeCode: ${e.message}`);
  }
}

router.get('/', (_req, res) => {
  res.status(200).type('text/plain').send('WhatsApp webhook OK');
});

/**
 * POST /api/webhook/whatsapp
 *
 * Twilio sends form-encoded body. Key fields:
 *   Body — the message text
 *   From — sender WhatsApp number (e.g. whatsapp:+972541234567)
 */
router.post('/', async (req, res) => {
  const message = (req.body?.Body || '').trim();
  const from_number = (req.body?.From || '').trim();

  if (!message || !from_number) {
    return res.status(400).json({
      received: false,
      task: '',
      error: 'Missing required Twilio fields: Body, From'
    });
  }

  const authToken = (process.env.TWILIO_AUTH_TOKEN || '').trim();
  const signature = req.get('X-Twilio-Signature') || '';
  if (authToken) {
    const url = getWebhookPublicUrl(req);
    const ok = validateTwilioSignature(authToken, signature, url, req.body);
    if (!ok) {
      logger.warn('Twilio signature validation failed (check TWILIO_WEBHOOK_PUBLIC_URL matches Twilio console)');
      return res.status(403).json({ received: false, task: '', error: 'Invalid Twilio signature' });
    }
  } else if (process.env.NODE_ENV === 'production') {
    logger.warn('TWILIO_AUTH_TOKEN not set — webhook is not signature-validated');
  }

  const allowed = (process.env.WHATSAPP_ALLOWED_FROM || '').trim();
  if (allowed) {
    const set = new Set(
      allowed
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    );
    if (!set.has(from_number)) {
      return res.status(403).json({ received: false, task: message, error: 'Sender not allowed' });
    }
  }

  // Insert to Supabase (best-effort — don't block the TwiML reply on DB errors)
  try {
    const { error } = await getSupabase().from(TABLE).insert([{ from_number, message, status: 'PENDING' }]);
    if (error) logger.error(`whatsapp_tasks insert: ${error.message}`);
  } catch (e) {
    logger.error(`whatsapp_tasks insert exception: ${e.message}`);
  }

  // Trigger Claude Code synchronously (fire-and-forget child process)
  try {
    triggerClaudeCode(message);
  } catch (e) {
    logger.error(`triggerClaudeCode: ${e.message}`);
  }

  // Respond with TwiML so Twilio delivers the reply as a WhatsApp message.
  // This is the only reliable pattern on serverless (setImmediate is killed after res.send).
  const template = (process.env.TWILIO_REPLY_TEXT_TEMPLATE || '').trim();
  const preview = message.length > 900 ? `${message.slice(0, 900)}…` : message;
  const replyText = template
    ? template.split('{task}').join(preview)
    : `MATRIYA: קיבלנו את המשימה ונריץ עיבוד.\n\n${preview}`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${replyText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</Message></Response>`;
  res.set('Content-Type', 'text/xml');
  res.send(twiml);
});

export default router;
