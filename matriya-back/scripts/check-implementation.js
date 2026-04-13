#!/usr/bin/env node
/**
 * Checks the 7 implementation areas: Kernel Lock, Governance, Value Summary, Justification, DoE, Risk Oracle, FIL-01.
 * Run from matriya-back with backend up: node scripts/check-implementation.js
 * Env: BASE_URL=http://localhost:8000 (default). Uses admin/admin123.
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
    req.setTimeout(options.timeout || 25000);
    if (body) req.write(body);
    req.end();
  });
}

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
    req.setTimeout(25000);
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
  console.log('Implementation check – Kernel Lock, Governance, Value Summary, Justification, DoE, Risk Oracle, FIL-01');
  console.log('BASE_URL:', BASE_URL);
  console.log('');

  let token;
  try {
    const loginRes = await request('POST', '/auth/login', { body: { username: 'admin', password: 'admin123' } });
    token = loginRes.access_token;
    if (!token) throw new Error('No access_token');
  } catch (e) {
    console.error('Login failed:', e.message || e.code || String(e));
    if (e.code === 'ECONNREFUSED') console.error('Is the backend running on', BASE_URL, '? Start with: npm run dev');
    process.exit(1);
  }

  const auth = { headers: { Authorization: `Bearer ${token}` } };
  let allPass = true;

  // --- 1. Kernel Lock (gate response includes status, stopPipeline, allowed_next_step) ---
  console.log('1) Kernel Lock – gate response shape (status, stopPipeline, allowed_next_step)');
  let sessionId, violationId;
  try {
    const sessionRes = await request('POST', '/research/session', auth);
    sessionId = sessionRes.session_id || sessionRes.id;
    const createRes = await request('POST', '/admin/recovery/violations', { ...auth, body: { session_id: sessionId, reason: 'check-impl' } });
    violationId = createRes.violation_id;

    const searchRes = await requestRaw('GET', `/search?query=x&session_id=${sessionId}&stage=B&generate_answer=true`, auth);
    const searchLocked = searchRes.statusCode === 400 || searchRes.statusCode === 409;
    allPass = ok('GET /search returns 4xx when locked', searchLocked) && allPass;
    allPass = ok('GET /search has research_gate_locked', searchRes.body?.research_gate_locked === true) && allPass;
    allPass = ok('GET /search has status=stopped', searchRes.body?.status === 'stopped') && allPass;
    allPass = ok('GET /search has stopPipeline', searchRes.body?.stopPipeline === true) && allPass;
    allPass = ok('GET /search has allowed_next_step', searchRes.body?.allowed_next_step === 'recovery_required') && allPass;

    const runRes = await requestRaw('POST', '/api/research/run', { ...auth, body: { session_id: sessionId, query: 'test', use_4_agents: true } });
    allPass = ok('POST /api/research/run returns 409 when locked', runRes.statusCode === 409) && allPass;
    allPass = ok('POST /api/research/run has status=stopped', runRes.body?.status === 'stopped') && allPass;

    await request('PATCH', `/admin/recovery/violations/${violationId}`, { ...auth, body: { resolve_note: 'check' } });
    // After recovery, next allowed stage is K (we never advanced); use K to get 200
    const afterSearch = await requestRaw('GET', `/search?query=x&session_id=${sessionId}&stage=K&generate_answer=true`, auth);
    allPass = ok('GET /search returns 200 after recovery', afterSearch.statusCode === 200) && allPass;
  } catch (e) {
    console.log('  [FAIL]', e.message || e.code || String(e));
    allPass = false;
  }
  console.log('');

  // --- 2. Value Summary (filters, duration_ms, violations array, CSV) ---
  console.log('2) Value Summary – filters, duration_ms, violations array');
  try {
    const vs = await request('GET', '/admin/reports/value-summary', { ...auth, headers: { ...auth.headers, Accept: 'application/json' } });
    allPass = ok('value-summary returns runs', typeof vs.runs?.total === 'number') && allPass;
    allPass = ok('value-summary returns violations array', Array.isArray(vs.violations)) && allPass;
    allPass = ok('value-summary may return duration_ms', vs.duration_ms == null || (typeof vs.duration_ms?.avg_ms === 'number' || vs.duration_ms === null)) && allPass;

    const vsFiltered = await request('GET', '/admin/reports/value-summary', { ...auth, headers: { ...auth.headers } });
    allPass = ok('value-summary filtered response shape', vsFiltered.runs != null && vsFiltered.violations_by_reason != null) && allPass;
  } catch (e) {
    console.log('  [FAIL]', e.message);
    allPass = false;
  }
  console.log('');

  // --- 3. FIL-01 warnings ---
  console.log('3) FIL-01 – GET /admin/fil/warnings');
  try {
    const fil = await request('GET', '/admin/fil/warnings', { ...auth, headers: { ...auth.headers } });
    allPass = ok('FIL returns warnings array', Array.isArray(fil.warnings)) && allPass;
    allPass = ok('FIL returns mined_at', typeof fil.mined_at === 'string') && allPass;
  } catch (e) {
    console.log('  [FAIL]', e.message);
    allPass = false;
  }
  console.log('');

  // --- 4. Risk Oracle (warnings only) ---
  console.log('4) Risk Oracle – GET /admin/risk-oracle');
  try {
    const oracle = await request('GET', '/admin/risk-oracle', auth);
    allPass = ok('Risk Oracle returns risks array', Array.isArray(oracle.risks)) && allPass;
  } catch (e) {
    console.log('  [FAIL]', e.message);
    allPass = false;
  }
  console.log('');

  // --- 5. Justification – POST /api/research/run with pre_justification ---
  console.log('5) Justification – POST /api/research/run with pre_justification');
  if (!sessionId) {
    try {
      const r = await request('POST', '/research/session', auth);
      sessionId = r.session_id || r.id;
    } catch (e) {
      sessionId = null;
    }
  }
  if (sessionId) {
    try {
      const runRes = await request('POST', '/api/research/run', {
        ...auth,
        timeout: 90000,
        body: { session_id: sessionId, query: 'one word', use_4_agents: true, pre_justification: 'Script check justification' }
      });
      allPass = ok('research/run with pre_justification returns 200', !!runRes.run_id || (runRes.outputs != null)) && allPass;
    } catch (e) {
      console.log('  [FAIL]', e.message || e.code || String(e));
      allPass = false;
    }
  } else {
    console.log('  [SKIP] no session_id');
  }
  console.log('');

  // --- 6. DoE – designs list and export includes pre_justification_text, doe_design_id, duration_ms ---
  console.log('6) DoE – designs list and export columns');
  try {
    const designs = await request('GET', '/admin/doe/designs', auth);
    allPass = ok('DoE designs endpoint', Array.isArray(designs.designs)) && allPass;

    const exportRes = await request('GET', '/admin/doe/export', { ...auth, headers: { ...auth.headers } });
    const firstRun = (exportRes.runs || [])[0];
    const hasNewFields = !firstRun || (firstRun.pre_justification_text !== undefined && firstRun.doe_design_id !== undefined && firstRun.duration_ms !== undefined);
    allPass = ok('DoE export includes pre_justification_text, doe_design_id, duration_ms', hasNewFields) && allPass;
  } catch (e) {
    console.log('  [FAIL]', e.message || e.code || String(e));
    allPass = false;
  }
  console.log('');

  // --- 7. Recovery / Rules registry ---
  console.log('7) Governance – Rules registry');
  try {
    const rules = await request('GET', '/admin/recovery/rules', auth);
    allPass = ok('Rules registry returns rules array', Array.isArray(rules.rules)) && allPass;
    allPass = ok('Rules registry returns conditionTypes', Array.isArray(rules.conditionTypes)) && allPass;
  } catch (e) {
    console.log('  [FAIL]', e.message || e.code || String(e));
    allPass = false;
  }
  console.log('');

  if (!allPass) {
    console.log('Some checks failed.');
    process.exit(1);
  }
  console.log('All implementation checks passed.');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
