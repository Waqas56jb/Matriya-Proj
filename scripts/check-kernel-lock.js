#!/usr/bin/env node
/**
 * Proof: single violation flow – Kernel Lock on both /search and POST /api/research/run.
 * 1. Create session
 * 2. Create violation for that session
 * 3. GET /search → expect 400/409 with research_gate_locked: true
 * 4. POST /api/research/run → expect 409 (not 200) with research_gate_locked: true
 * 5. Resolve violation (PATCH /admin/recovery/violations/:id)
 * 6. GET /search and POST /api/research/run → expect success (200)
 * Run from matriya-back with backend up: node scripts/check-kernel-lock.js
 * Env: BASE_URL=http://localhost:8000 (default)
 */
import http from 'http';
import https from 'https';

const BASE_URL = process.env.BASE_URL || 'http://localhost:8000';

function request(method, path, options = {}) {
  const url = path.startsWith('http') ? new URL(path) : new URL(path, BASE_URL);
  const isHttps = url.protocol === 'https:';
  const body = options.body !== undefined
    ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body))
    : undefined;
  const headers = options.headers && options.headers['Content-Type']
    ? options.headers
    : { 'Content-Type': 'application/json', ...options.headers };
  if (body && headers['Content-Type'] === 'application/json') headers['Content-Length'] = Buffer.byteLength(body);

  return new Promise((resolve, reject) => {
    const req = (isHttps ? https : http).request(
      url,
      { method, headers, rejectUnauthorized: false },
      (res) => {
        let data = '';
        res.on('data', (ch) => (data += ch));
        res.on('end', () => {
          try {
            const json = data ? JSON.parse(data) : {};
            if (res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode}: ${json.error || data || res.statusMessage}`));
            } else {
              resolve(json);
            }
          } catch (e) {
            if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            else resolve(data);
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(20000);
    if (body) req.write(body);
    req.end();
  });
}

/** Returns { statusCode, body } for any response (used when we expect 4xx). */
function requestRaw(method, path, options = {}) {
  const url = path.startsWith('http') ? new URL(path) : new URL(path, BASE_URL);
  const isHttps = url.protocol === 'https:';
  const body = options.body !== undefined
    ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body))
    : undefined;
  const headers = options.headers && options.headers['Content-Type']
    ? options.headers
    : { 'Content-Type': 'application/json', ...options.headers };
  if (body && headers['Content-Type'] === 'application/json') headers['Content-Length'] = Buffer.byteLength(body);

  return new Promise((resolve, reject) => {
    const req = (isHttps ? https : http).request(
      url,
      { method, headers, rejectUnauthorized: false },
      (res) => {
        let data = '';
        res.on('data', (ch) => (data += ch));
        res.on('end', () => {
          try {
            const parsed = data ? JSON.parse(data) : {};
            resolve({ statusCode: res.statusCode, body: parsed });
          } catch (e) {
            resolve({ statusCode: res.statusCode, body: data });
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(20000);
    if (body) req.write(body);
    req.end();
  });
}

function ok(name, pass, detail = '') {
  const status = pass ? 'OK' : 'FAIL';
  console.log(`  [${status}] ${name}${detail ? ` – ${detail}` : ''}`);
  return pass;
}

async function main() {
  console.log('Kernel Lock proof: violation → /search & /api/research/run locked → recovery → both work');
  console.log('BASE_URL:', BASE_URL);
  console.log('');

  let token;
  try {
    const loginRes = await request('POST', '/auth/login', {
      body: { username: 'admin', password: 'admin123' }
    });
    token = loginRes.access_token;
    if (!token) throw new Error('No access_token');
  } catch (e) {
    console.error('Login failed:', e.message);
    process.exit(1);
  }

  const auth = { headers: { Authorization: `Bearer ${token}` } };
  let allPass = true;

  console.log('1) Create session (POST /research/session)');
  let sessionId;
  try {
    const sessionRes = await request('POST', '/research/session', auth);
    sessionId = sessionRes.session_id || sessionRes.id;
    allPass = ok('session created', !!sessionId, sessionId) && allPass;
  } catch (e) {
    console.error('  [FAIL]', e.message);
    process.exit(1);
  }
  console.log('');

  console.log('2) Create violation for session (POST /admin/recovery/violations)');
  let violationId;
  try {
    const createRes = await request('POST', '/admin/recovery/violations', {
      ...auth,
      body: { session_id: sessionId, reason: 'test-kernel-lock' }
    });
    violationId = createRes.violation_id;
    allPass = ok('violation created', !!violationId, 'id=' + violationId) && allPass;
  } catch (e) {
    console.error('  [FAIL]', e.message);
    process.exit(1);
  }
  console.log('');

  console.log('3) GET /search with session_id + stage → expect locked (4xx, research_gate_locked: true)');
  try {
    const searchUrl = `/search?query=test&session_id=${sessionId}&stage=B&generate_answer=true`;
    const searchRes = await requestRaw('GET', searchUrl, auth);
    const locked = searchRes.statusCode === 400 || searchRes.statusCode === 409;
    const gateLocked = searchRes.body?.research_gate_locked === true;
    allPass = ok('GET /search returns 4xx when violation', locked, 'status=' + searchRes.statusCode) && allPass;
    allPass = ok('GET /search has research_gate_locked', gateLocked) && allPass;
  } catch (e) {
    console.log('  [FAIL]', e.message);
    allPass = false;
  }
  console.log('');

  console.log('4) POST /api/research/run → expect 409 (not 200), research_gate_locked: true');
  try {
    const runRes = await requestRaw('POST', '/api/research/run', {
      ...auth,
      body: { session_id: sessionId, query: 'test query', use_4_agents: true }
    });
    const is409 = runRes.statusCode === 409;
    const runLocked = runRes.body?.research_gate_locked === true;
    allPass = ok('POST /api/research/run returns 409 when violation', is409, 'status=' + runRes.statusCode) && allPass;
    allPass = ok('POST /api/research/run has research_gate_locked', runLocked) && allPass;
  } catch (e) {
    console.log('  [FAIL]', e.message);
    allPass = false;
  }
  console.log('');

  console.log('5) Resolve violation (PATCH /admin/recovery/violations/:id)');
  try {
    await request('PATCH', `/admin/recovery/violations/${violationId}`, {
      ...auth,
      body: { resolve_note: 'kernel-lock proof' }
    });
    allPass = ok('violation resolved', true) && allPass;
  } catch (e) {
    console.log('  [FAIL]', e.message);
    process.exit(1);
  }
  console.log('');

  console.log('6) GET /search again → expect 200');
  try {
    const searchUrl = `/search?query=test&session_id=${sessionId}&stage=B&generate_answer=true`;
    const searchRes = await requestRaw('GET', searchUrl, auth);
    allPass = ok('GET /search returns 200 after recovery', searchRes.statusCode === 200, 'status=' + searchRes.statusCode) && allPass;
  } catch (e) {
    console.log('  [FAIL]', e.message);
    allPass = false;
  }
  console.log('');

  console.log('7) POST /api/research/run again → expect 200');
  try {
    const runRes = await requestRaw('POST', '/api/research/run', {
      ...auth,
      body: { session_id: sessionId, query: 'test query', use_4_agents: true }
    });
    allPass = ok('POST /api/research/run returns 200 after recovery', runRes.statusCode === 200, 'status=' + runRes.statusCode) && allPass;
  } catch (e) {
    console.log('  [FAIL]', e.message);
    allPass = false;
  }
  console.log('');

  if (!allPass) {
    console.log('Some assertions failed.');
    process.exit(1);
  }
  console.log('All kernel lock checks passed.');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
