/**
 * POST /api/experiments/upload
 * Accepts a single experiment row from Rachel (or lab UI) and upserts into `experiments`.
 */
import { Router } from 'express';
import { Experiment, initDb } from '../../database.js';
import logger from '../../logger.js';

const router = Router();

function requireFields(body) {
  const experiment_id =
    body?.experiment_id != null && String(body.experiment_id).trim() !== ''
      ? String(body.experiment_id).trim()
      : null;
  const dateRaw =
    body?.date != null && String(body.date).trim() !== '' ? String(body.date).trim() : null;
  const formulation =
    body?.formulation != null && String(body.formulation).trim() !== ''
      ? String(body.formulation).trim()
      : null;
  let results = body?.results;
  if (results === undefined || results === null || String(results).trim() === '') {
    results = null;
  } else if (typeof results !== 'string') {
    try {
      results = JSON.stringify(results);
    } catch (_) {
      results = String(results);
    }
  } else {
    results = results.trim();
  }
  return { experiment_id, dateRaw, formulation, results };
}

/** YYYY-MM-DD or ISO date string → DATEONLY-safe string */
function normalizeDateOnly(dateRaw) {
  if (!dateRaw) return null;
  const s = dateRaw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

router.post('/upload', async (req, res) => {
  try {
    try {
      await initDb();
    } catch (e) {
      logger.error(`initDb for /api/experiments/upload: ${e.message}`);
      return res.status(503).json({ error: 'Database unavailable' });
    }
    if (!Experiment) {
      return res.status(503).json({ error: 'Experiments table not available' });
    }

    const { experiment_id, dateRaw, formulation, results } = requireFields(req.body || {});
    const missing = [];
    if (!experiment_id) missing.push('experiment_id');
    if (!dateRaw) missing.push('date');
    if (!formulation) missing.push('formulation');
    if (!results) missing.push('results');
    if (missing.length) {
      return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
    }

    const experiment_date = normalizeDateOnly(dateRaw);
    if (!experiment_date) {
      return res.status(400).json({ error: 'Invalid date — use YYYY-MM-DD or a valid ISO date' });
    }

    await Experiment.upsert(
      {
        experiment_id,
        experiment_date,
        formula: formulation,
        results,
        experiment_outcome: 'success',
        is_production_formula: false,
        updated_at: new Date()
      },
      { conflictFields: ['experiment_id'] }
    );

    return res.json({ success: true, experiment_id });
  } catch (e) {
    logger.error(`/api/experiments/upload error: ${e.message}`);
    return res.status(500).json({ error: e.message || 'Upload failed' });
  }
});

export default router;
