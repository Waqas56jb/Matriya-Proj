/**
 * routes/webhook/github.js
 *
 * POST /api/webhook/github
 * Receives push events from GitHub and logs them to Supabase `github_events`.
 *
 * Supabase DDL (run once — see sql/github_events.sql):
 *   CREATE TABLE github_events (
 *     id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
 *     repo           TEXT,
 *     branch         TEXT,
 *     commit_message TEXT,
 *     pusher         TEXT,
 *     created_at     TIMESTAMPTZ DEFAULT NOW()
 *   );
 *
 * Env (optional — enables HMAC-SHA256 signature check):
 *   GITHUB_WEBHOOK_SECRET — the secret set when creating the webhook in GitHub
 */

import crypto from 'crypto';
import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import logger from '../../logger.js';

const router = Router();
const TABLE = 'github_events';

// ─── Lazy Supabase client ─────────────────────────────────────────────────────

let _sb = null;
function getSupabase() {
  if (_sb) return _sb;
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim();
  const key = (process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_KEY are required for GitHub webhook');
  _sb = createClient(url, key);
  return _sb;
}

// ─── Optional signature validation ───────────────────────────────────────────

function verifyGithubSignature(req) {
  const secret = (process.env.GITHUB_WEBHOOK_SECRET || '').trim();
  if (!secret) return true; // no secret configured → skip check (dev mode)

  const sig = req.get('x-hub-signature-256') || '';
  if (!sig) return false;

  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(req.body))
    .digest('hex');

  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

// ─── Routes ───────────────────────────────────────────────────────────────────

router.get('/', (_req, res) => {
  res.status(200).type('text/plain').send('GitHub webhook OK');
});

router.post('/', async (req, res) => {
  // Only handle push events
  const event = req.get('x-github-event') || 'unknown';
  if (event !== 'push') {
    return res.json({ received: true, event, skipped: true });
  }

  if (!verifyGithubSignature(req)) {
    logger.warn('[github webhook] invalid signature');
    return res.status(403).json({ received: false, error: 'Invalid signature' });
  }

  const payload = req.body || {};

  const repo          = payload.repository?.full_name || null;
  const branch        = (payload.ref || '').replace('refs/heads/', '') || null;
  const commit_message = payload.head_commit?.message || null;
  const pusher        = payload.pusher?.name || null;

  logger.info(`[github webhook] push repo=${repo} branch=${branch} pusher=${pusher}`);

  try {
    const { error } = await getSupabase()
      .from(TABLE)
      .insert([{ repo, branch, commit_message, pusher }]);

    if (error) {
      logger.error(`[github webhook] DB insert error: ${error.message}`);
      return res.status(500).json({ received: false, error: error.message });
    }
  } catch (e) {
    logger.error(`[github webhook] exception: ${e.message}`);
    return res.status(503).json({ received: false, error: e.message });
  }

  return res.json({ received: true });
});

export default router;
