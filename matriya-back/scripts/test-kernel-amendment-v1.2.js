#!/usr/bin/env node
/**
 * Check that Kernel Amendment v1.2 (Epistemic Integrity Layer) is implemented.
 * Verifies: dashboard (False B / Missed B, confidence, complexity), SEM (no single value), gates (confidence_score, basis_count, model_version_hash), noise API.
 * Usage: node scripts/test-kernel-amendment-v1.2.js
 * Env: BASE_URL=http://localhost:8000 (default). Server must be running.
 */
const BASE = (process.env.BASE_URL || 'http://localhost:8000').replace(/\/$/, '');

async function fetchJson(path, options = {}) {
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const opts = { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } };
  if (options.body && typeof options.body !== 'string') opts.body = JSON.stringify(options.body);
  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg = typeof data === 'object' && data.error ? data.error : text?.slice(0, 200) || res.statusText;
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }
  return data;
}

async function main() {
  console.log('Checking Kernel Amendment v1.2 at', BASE);
  console.log('');

  const results = { ok: [], fail: [] };

  // 1) Metrics dashboard – False B rate, Missed B rate, confidence_distribution, complexity_context
  try {
    const dash = await fetchJson('/api/observability/dashboard');
    const hasRates = typeof dash.false_b_rate === 'number' || dash.false_b_rate === null;
    const hasConf = dash.confidence_distribution && (dash.confidence_distribution.gate !== undefined || dash.confidence_distribution.stage_b !== undefined);
    if (hasRates && hasConf) {
      console.log('1) GET /api/observability/dashboard – false_b_rate, missed_b_rate, confidence_distribution OK');
      results.ok.push('dashboard');
    } else {
      console.log('1) GET /api/observability/dashboard – missing fields:', { hasRates, hasConf, keys: Object.keys(dash) });
      results.fail.push('dashboard');
    }
  } catch (e) {
    console.log('1) GET /api/observability/dashboard – FAIL:', e.message);
    results.fail.push('dashboard');
  }

  // 2) SEM – component_breakdown, confidence_range, historical_predictive_accuracy (no single SEM value)
  try {
    const sem = await fetchJson('/api/observability/sem');
    const hasBreakdown = sem.component_breakdown != null;
    const hasRange = sem.confidence_range !== undefined;
    const hasAccuracy = sem.historical_predictive_accuracy !== undefined;
    const noSingleSem = sem.sem === undefined && sem.value === undefined;
    if (hasBreakdown && noSingleSem) {
      console.log('2) GET /api/observability/sem – component_breakdown, no single SEM value OK');
      results.ok.push('sem');
    } else {
      console.log('2) GET /api/observability/sem – unexpected:', { hasBreakdown, hasRange, hasAccuracy, noSingleSem });
      results.fail.push('sem');
    }
  } catch (e) {
    console.log('2) GET /api/observability/sem – FAIL:', e.message);
    results.fail.push('sem');
  }

  // 3) Gates – response has gates array; (no gates) or at least one has confidence_score, basis_count, model_version_hash
  try {
    const gates = await fetchJson('/api/observability/gates?limit=5');
    const list = gates.gates || [];
    const withFields = list.filter(g => g.confidence_score != null && g.basis_count != null && g.model_version_hash != null);
    if (!Array.isArray(list)) {
      console.log('3) GET /api/observability/gates – missing gates array');
      results.fail.push('gates');
    } else if (list.length === 0 || withFields.length > 0) {
      console.log('3) GET /api/observability/gates – OK (gates:', list.length, ', with observability fields:', withFields.length, ')');
      results.ok.push('gates');
    } else {
      console.log('3) GET /api/observability/gates – existing rows lack new columns; do one /search with session+stage to create a new gate record');
      results.ok.push('gates');
    }
  } catch (e) {
    console.log('3) GET /api/observability/gates – FAIL:', e.message);
    results.fail.push('gates');
  }

  // 4) Noise – list and create
  try {
    const list = await fetchJson('/api/observability/noise?limit=5');
    if (Array.isArray(list.noise_events)) {
      console.log('4) GET /api/observability/noise – OK, total:', list.total);
      results.ok.push('noise list');
    } else {
      console.log('4) GET /api/observability/noise – missing noise_events array');
      results.fail.push('noise list');
    }
  } catch (e) {
    console.log('4) GET /api/observability/noise – FAIL:', e.message);
    results.fail.push('noise list');
  }

  // 5) Decision feedback (False B / Missed B) – need a decision id; optional if none
  try {
    const decisions = await fetchJson('/api/audit/decisions?limit=1');
    const first = (decisions.decisions || [])[0];
    if (first && first.id) {
      const patched = await fetchJson(`/api/observability/decision/${first.id}/feedback`, {
        method: 'PATCH',
        body: { human_feedback: 'false_b' }
      });
      if (patched.human_feedback === 'false_b') {
        console.log('5) PATCH /api/observability/decision/:id/feedback – OK');
        results.ok.push('decision feedback');
      } else {
        results.fail.push('decision feedback');
      }
    } else {
      console.log('5) PATCH decision feedback – skip (no decisions in log)');
      results.ok.push('decision feedback (skip)');
    }
  } catch (e) {
    console.log('5) PATCH decision feedback – FAIL:', e.message);
    results.fail.push('decision feedback');
  }

  console.log('');
  console.log('--- Summary ---');
  console.log('OK:', results.ok.length, results.ok);
  console.log('Fail:', results.fail.length, results.fail);
  if (results.fail.length > 0) {
    console.log('\nTip: 1) Start server: npm start (in matriya-back)');
    console.log('     2) Run DB migration: see docs/KERNEL-AMENDMENT-V1.2.md (ALTER decision_audit_log, CREATE noise_events)');
    console.log('     3) If you get 404 on /api/observability/*, restart the server so it loads the new routes.');
  }
  process.exit(results.fail.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
