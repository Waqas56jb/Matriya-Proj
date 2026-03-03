#!/usr/bin/env node
/**
 * Test MATRIYA Scopes 1–3: health+metrics, staging-proof, decision audit, read-only audit endpoints.
 * Usage: node scripts/test-scopes-1-2-3.js
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
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${data.error || text || res.statusText}`);
  return data;
}

async function main() {
  console.log('Testing MATRIYA Scopes 1–3 at', BASE);
  console.log('');

  let sessionId;
  const results = { ok: [], fail: [] };

  // --- Scope 3: Health with metrics ---
  try {
    const health = await fetchJson('/health');
    if (health.metrics != null && typeof health.metrics.total_requests === 'number') {
      console.log('1) GET /health – metrics present:', JSON.stringify(health.metrics));
      results.ok.push('health with metrics');
    } else {
      console.log('1) GET /health – missing metrics:', health);
      results.fail.push('health metrics');
    }
  } catch (e) {
    console.log('1) GET /health – FAIL:', e.message);
    results.fail.push('health');
  }

  // --- Scope 1: Staging proof ---
  try {
    const sessionRes = await fetchJson('/research/session', { method: 'POST', body: {} });
    sessionId = sessionRes.session_id;
    if (!sessionId) throw new Error('No session_id');
    console.log('2) POST /research/session – session_id:', sessionId);
    results.ok.push('create session');
  } catch (e) {
    console.log('2) POST /research/session – FAIL:', e.message);
    results.fail.push('create session');
    sessionId = null;
  }

  if (sessionId) {
    try {
      const proof = await fetchJson(`/research/staging-proof?session_id=${sessionId}`);
      const hasStage = proof.next_allowed != null && proof.gate_locked === false;
      if (hasStage) {
        console.log('3) GET /research/staging-proof – next_allowed:', proof.next_allowed, 'gate_locked:', proof.gate_locked);
        results.ok.push('staging-proof');
      } else {
        console.log('3) GET /research/staging-proof – unexpected:', proof);
        results.fail.push('staging-proof shape');
      }
    } catch (e) {
      console.log('3) GET /research/staging-proof – FAIL:', e.message);
      results.fail.push('staging-proof');
    }

    // Trigger gate + decision audit (Scope 2)
    try {
      const searchRes = await fetchJson(
        `/search?query=test&session_id=${sessionId}&stage=K&generate_answer=true&n_results=2`
      );
      if (searchRes.session_id && searchRes.research_stage === 'K') {
        console.log('4) GET /search (stage K) – session_id + research_stage OK');
        results.ok.push('search gate');
      } else {
        console.log('4) GET /search – unexpected:', { session_id: searchRes.session_id, research_stage: searchRes.research_stage });
        results.fail.push('search response');
      }
    } catch (e) {
      console.log('4) GET /search – FAIL:', e.message);
      results.fail.push('search');
    }
  }

  // --- Scope 2: Read-only audit endpoints ---
  try {
    const list = await fetchJson('/api/audit/decisions?limit=5');
    if (Array.isArray(list.decisions)) {
      console.log('5) GET /api/audit/decisions – count:', list.decisions.length, 'total:', list.total);
      results.ok.push('audit decisions list');
    } else {
      console.log('5) GET /api/audit/decisions – missing decisions array:', list);
      results.fail.push('audit decisions');
    }
  } catch (e) {
    console.log('5) GET /api/audit/decisions – FAIL:', e.message);
    results.fail.push('audit decisions');
  }

  if (sessionId) {
    try {
      const sessionDec = await fetchJson(`/api/audit/session/${sessionId}/decisions?limit=10`);
      if (Array.isArray(sessionDec.decisions) && sessionDec.session_id === sessionId) {
        console.log('6) GET /api/audit/session/:id/decisions – count:', sessionDec.decisions.length);
        results.ok.push('audit session decisions');
      } else {
        console.log('6) GET /api/audit/session/:id/decisions – unexpected:', sessionDec);
        results.fail.push('audit session decisions');
      }
    } catch (e) {
      console.log('6) GET /api/audit/session/:id/decisions – FAIL:', e.message);
      results.fail.push('audit session decisions');
    }
  }

  console.log('');
  console.log('--- Summary ---');
  console.log('OK:', results.ok.length, results.ok);
  console.log('Fail:', results.fail.length, results.fail);
  if (results.ok.length === 0 && results.fail.length > 0) {
    console.log('\nTip: Start the server first: npm start (or node server.js) in matriya-back root.');
  }
  process.exit(results.fail.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
