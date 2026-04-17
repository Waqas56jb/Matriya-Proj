/**
 * routes/webhook/whatsapp.js
 *
 * POST /api/webhook/whatsapp
 * Receives incoming WhatsApp messages via Twilio webhook.
 * Logs each message to Supabase table `whatsapp_tasks`.
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
 */

import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';

const router = Router();

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

const TABLE = 'whatsapp_tasks';

/**
 * POST /api/webhook/whatsapp
 *
 * Twilio sends form-encoded body. Key fields:
 *   Body — the message text
 *   From — sender WhatsApp number (e.g. whatsapp:+972541234567)
 */
router.post('/', async (req, res) => {
  const message     = (req.body?.Body  || '').trim();
  const from_number = (req.body?.From  || '').trim();

  if (!message || !from_number) {
    return res.status(400).json({
      received: false,
      error: 'Missing required Twilio fields: Body, From',
    });
  }

  const { data, error } = await supabase
    .from(TABLE)
    .insert([{ from_number, message, status: 'PENDING' }])
    .select()
    .single();

  if (error) {
    return res.status(500).json({
      received: false,
      error: error.message,
    });
  }

  res.json({
    received: true,
    task: message,
    id: data.id,
    from: from_number,
    status: data.status,
    received_at: data.received_at,
  });
});

export default router;
