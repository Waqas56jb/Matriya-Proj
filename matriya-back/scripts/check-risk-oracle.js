#!/usr/bin/env node
/**
 * Checks that Task 8 Risk Oracle works:
 * - GET /admin/recovery/oracle returns risks array and evaluated_at
 * - Optional session_id query returns same shape
 * Run from matriya-back with backend up: node scripts/check-risk-oracle.js
 * Env: BASE_URL=http://localhost:8000 (default)
 */
import http from 'http';
import https from 'https';

const BASE_URL = process.env.BASE_URL || 'http://localhost:8000';

function request(method, path, options = {}) {
  const url = new URL(path, BASE_URL);
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
    req.setTimeout(15000);
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
  console.log('Risk Oracle (Task 8) check');
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

  console.log('1) GET /admin/recovery/oracle (global)');
  let data;
  try {
    data = await request('GET', '/admin/recovery/oracle', auth);
    allPass = ok('returns 200', true) && allPass;
    allPass = ok('risks is array', Array.isArray(data.risks)) && allPass;
    allPass = ok('evaluated_at present', typeof data.evaluated_at === 'string') && allPass;
  } catch (e) {
    console.log('  [FAIL]', e.message);
    process.exit(1);
  }
  console.log('');

  console.log('2) Risk items shape');
  const risks = data.risks || [];
  allPass = ok('each risk has id, type, severity, message', risks.every(r => 
    typeof r.id === 'string' && typeof r.type === 'string' && 
    ['low', 'medium', 'high'].includes(r.severity) && typeof r.message === 'string'
  ), risks.length ? `count=${risks.length}` : 'count=0') && allPass;
  console.log('');

  console.log('3) GET /admin/recovery/oracle?session_id=... (optional session)');
  try {
    const withSession = await request('GET', '/admin/recovery/oracle?session_id=00000000-0000-0000-0000-000000000001', auth);
    allPass = ok('returns 200', true) && allPass;
    allPass = ok('risks array and evaluated_at', Array.isArray(withSession.risks) && typeof withSession.evaluated_at === 'string') && allPass;
  } catch (e) {
    console.log('  [FAIL]', e.message);
    allPass = false;
  }
  console.log('');

  if (allPass) {
    console.log('All Risk Oracle checks passed.');
    process.exit(0);
  } else {
    console.log('Some checks failed.');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
