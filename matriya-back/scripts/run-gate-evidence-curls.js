#!/usr/bin/env node
/**
 * Run Gate evidence curl-style checks and print outputs to stdout.
 * Usage: node scripts/run-gate-evidence-curls.js [BASE_URL]
 * Default BASE_URL: http://localhost:8000
 * Save to file: node scripts/run-gate-evidence-curls.js > gate-evidence-output.txt
 */
const BASE = (process.env.MATRIYA_URL || process.argv[2] || 'http://localhost:8000').replace(/\/$/, '');

async function fetchJson(path, options = {}) {
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json', ...options.headers }, ...options });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.status, data, ok: res.ok };
}

function section(title) {
  console.log('\n' + '='.repeat(60));
  console.log(title);
  console.log('='.repeat(60));
}

async function main() {
  console.log('Gate evidence – live outputs');
  console.log('BASE_URL:', BASE);
  console.log('Time:', new Date().toISOString());

  // C1. Health
  section('C1. GET /health');
  try {
    const h = await fetchJson('/health');
    console.log('Status:', h.status);
    console.log(JSON.stringify(h.data, null, 2));
  } catch (e) {
    console.log('Error:', e.message);
  }

  // C2. Dashboard
  section('C2. GET /api/observability/dashboard');
  try {
    const d = await fetchJson('/api/observability/dashboard');
    console.log('Status:', d.status);
    console.log(JSON.stringify(d.data, null, 2));
  } catch (e) {
    console.log('Error:', e.message);
  }

  // A5. Staging proof (need valid session)
  section('A5. GET /research/staging-proof');
  let sessionId = null;
  try {
    const sess = await fetchJson('/research/session', { method: 'POST', body: '{}' });
    if (sess.ok && sess.data.session_id) {
      sessionId = sess.data.session_id;
      const proof = await fetchJson(`/research/staging-proof?session_id=${sessionId}`);
      console.log('Status:', proof.status);
      console.log(JSON.stringify(proof.data, null, 2));
    } else {
      console.log('Could not create session:', sess.status, sess.data);
    }
  } catch (e) {
    console.log('Error:', e.message);
  }

  // B2/B3. Audit – list and replay
  section('B2/B3. GET /api/audit/decisions (limit=3)');
  try {
    const list = await fetchJson('/api/audit/decisions?limit=3');
    console.log('Status:', list.status);
    console.log(JSON.stringify(list.data, null, 2));
  } catch (e) {
    console.log('Error:', e.message);
  }

  if (sessionId) {
    section('B3. GET /api/audit/session/:id/decisions (replay)');
    try {
      const replay = await fetchJson(`/api/audit/session/${sessionId}/decisions`);
      console.log('Status:', replay.status);
      console.log(JSON.stringify(replay.data, null, 2));
    } catch (e) {
      console.log('Error:', e.message);
    }
  }

  // A3. Gate – missing stage → 400
  section('A3. GET /search without session_id (expect 400)');
  try {
    const bad = await fetchJson('/search?query=test&stage=K&generate_answer=true');
    console.log('Status:', bad.status);
    console.log(JSON.stringify(bad.data, null, 2));
  } catch (e) {
    console.log('Error:', e.message);
  }

  console.log('\nDone.');
}

main().catch((e) => { console.error(e); process.exit(1); });
