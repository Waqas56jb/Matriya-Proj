// routes/external/sources.js
import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';

const router = Router();

/** Lazy Supabase client — avoids crashing at import time if env vars not yet set. */
let _sb = null;
function getSupabase() {
  if (_sb) return _sb;
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_KEY are required');
  _sb = createClient(url, key);
  return _sb;
}

const ALLOWED_TRUST_GRADES = ['C', 'D'];

// GET /api/external/sources/count
router.get('/count', async (req, res) => {
  try {
    const { count, error } = await getSupabase()
      .from('external_sources')
      .select('*', { count: 'exact', head: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ count });
  } catch (e) { res.status(503).json({ error: e.message }); }
});

// GET /api/external/sources
router.get('/', async (req, res) => {
  try {
    const { data, error } = await getSupabase()
      .from('external_sources')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (e) { res.status(503).json({ error: e.message }); }
});

// POST /api/external/sources
router.post('/', async (req, res) => {
  const { name, source_type, source_code, trust_grade, url } = req.body;

  // Iron rule — trust_grade must be C or D
  if (!ALLOWED_TRUST_GRADES.includes(trust_grade)) {
    return res.status(403).json({
      error: 'TRUST_GRADE_VIOLATION',
      message: 'External sources cannot hold grade A or B. Only C or D allowed.'
    });
  }

  // Provenance required
  const required = ['name', 'source_type', 'source_code', 'trust_grade'];
  for (const field of required) {
    if (!req.body[field]) {
      return res.status(400).json({
        error: 'MISSING_FIELD',
        field,
        message: `Field '${field}' is required.`
      });
    }
  }

  const sb = getSupabase();
  const { data, error } = await sb
    .from('external_sources')
    .insert([{ name, source_type, source_code, trust_grade, url }])
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  await sb.from('external_audit_log').insert([{
    query_text: `SOURCE_CREATED: ${name}`,
    used_external_as_context_only: true,
    external_document_ids: []
  }]);

  res.status(201).json(data);
});

// Absolute block — no trust_grade update allowed
router.patch('/:id', (req, res) => {
  if (req.body.trust_grade) {
    return res.status(405).json({
      error: 'METHOD_NOT_ALLOWED',
      message: 'trust_grade cannot be modified after creation.'
    });
  }
  res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
});

export default router;
