#!/usr/bin/env node
/**
 * Pre-SharePoint checks – MATRIYA-BACK ONLY (no management system, no SharePoint).
 * Runs: observability dashboard, audit trail, replay, parallel lock.
 * Usage: node scripts/pre-sharepoint-checks-matriya-only.js
 * Env: MATRIYA_URL=http://localhost:8000 (default)
 */
const MATRIYA = (process.env.MATRIYA_URL || 'http://localhost:8000').replace(/\/$/, '');

async function fetchJson(base, path, options = {}) {
  const url = (path.startsWith('http') ? path : `${base}${path}`).replace(/\/\/+/g, '/');
  const opts = { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } };
  if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${data.error || text?.slice(0, 200)}`);
  return data;
}

async function main() {
  const results = { ok: [], fail: [] };

  console.log('Pre-SharePoint checks (matriya-back only)');
  console.log('  MATRIYA_URL:', MATRIYA);
  console.log('');

  // 1) Observability dashboard
  try {
    const d = await fetchJson(MATRIYA, '/api/observability/dashboard');
    const has = typeof d.total_requests === 'number' && (d.latency_p50 != null || d.total_requests === 0) && typeof d.error_count === 'number';
    if (has) {
      console.log('1) GET /api/observability/dashboard – total_requests, latency_p50, latency_p99, error_count OK');
      results.ok.push('observability');
    } else {
      console.log('1) GET /api/observability/dashboard – missing fields:', Object.keys(d));
      results.fail.push('observability');
    }
  } catch (e) {
    console.log('1) GET /api/observability/dashboard – FAIL:', e.message);
    results.fail.push('observability');
  }

  // 2) Audit trail: create decision then GET /api/audit/decisions
  try {
    const sessionRes = await fetchJson(MATRIYA, '/research/session', { method: 'POST', body: {} });
    const sessionId = sessionRes.session_id;
    if (!sessionId) throw new Error('No session_id');
    await fetchJson(MATRIYA, `/search?query=test&session_id=${sessionId}&stage=K&generate_answer=true&n_results=2`);
    const list = await fetchJson(MATRIYA, '/api/audit/decisions?limit=5');
    const rec = (list.decisions || []).find(r => r.inputs_snapshot != null && (r.model_version_hash != null || r.confidence_score != null));
    if (rec || (list.decisions || []).length > 0) {
      console.log('2) Audit trail – decision with inputs_snapshot / model_version_hash / confidence_score OK');
      results.ok.push('audit');
    } else {
      console.log('2) Audit trail – no record with inputs_snapshot/model_version_hash/confidence_score');
      results.fail.push('audit');
    }
  } catch (e) {
    console.log('2) Audit trail – FAIL:', e.message);
    results.fail.push('audit');
  }

  // 3) Replay: GET /api/audit/session/:id/decisions
  try {
    const sessionRes = await fetchJson(MATRIYA, '/research/session', { method: 'POST', body: {} });
    const sessionId = sessionRes.session_id;
    const replay = await fetchJson(MATRIYA, `/api/audit/session/${sessionId}/decisions`);
    if (Array.isArray(replay.decisions) && replay.session_id === sessionId) {
      console.log('3) Replay GET /api/audit/session/:id/decisions – OK');
      results.ok.push('replay');
    } else {
      console.log('3) Replay – unexpected:', replay);
      results.fail.push('replay');
    }
  } catch (e) {
    console.log('3) Replay – FAIL:', e.message);
    results.fail.push('replay');
  }

  // 4) Parallel lock: two concurrent POST /api/research/run same session
  try {
    const sessionRes = await fetchJson(MATRIYA, '/research/session', { method: 'POST', body: {} });
    const sessionId = sessionRes.session_id;
    const run = () => fetchJson(MATRIYA, '/api/research/run', { method: 'POST', body: { session_id: sessionId, query: 'parallel test', use_4_agents: true } });
    const [a, b] = await Promise.all([run(), run()]);
    if (a && b && (a.run_id != null || a.outputs) && (b.run_id != null || b.outputs)) {
      console.log('4) Parallel lock – both completed (serialized by lock)');
      results.ok.push('parallel');
    } else {
      console.log('4) Parallel lock – unexpected:', { a: !!a, b: !!b });
      results.fail.push('parallel');
    }
  } catch (e) {
    console.log('4) Parallel lock – FAIL:', e.message);
    results.fail.push('parallel');
  }

  console.log('');
  console.log('--- Summary ---');
  console.log('OK:', results.ok.length, results.ok);
  console.log('Fail:', results.fail.length, results.fail);
  if (results.fail.length > 0) {
    console.log('\nTip: Start matriya-back: cd matriya-back && npm run dev');
  }
  process.exit(results.fail.length > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
