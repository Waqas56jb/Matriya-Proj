// routes/external/sources.js
import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';

const router = Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const ALLOWED_TRUST_GRADES = ['C', 'D'];

// GET /api/external/sources
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('external_sources')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
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

  const { data, error } = await supabase
    .from('external_sources')
    .insert([{ name, source_type, source_code, trust_grade, url }])
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // Audit log required
  await supabase.from('external_audit_log').insert([{
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
