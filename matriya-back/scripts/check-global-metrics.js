#!/usr/bin/env node
/**
 * Checks that Task 4 Global Metrics dashboard works:
 * - GET /admin/metrics/global returns all expected numeric metrics
 * Run from matriya-back with backend up: node scripts/check-global-metrics.js
 * Env: BASE_URL=http://localhost:8000 (default)
 */
import http from 'http';
import https from 'https';

const BASE_URL = process.env.BASE_URL || 'http://localhost:8000';

const EXPECTED_KEYS = [
  'users',
  'research_sessions',
  'search_history_entries',
  'integrity_cycle_snapshots',
  'violations_total',
  'violations_active',
  'violations_resolved',
  'system_snapshots',
  'research_loop_runs',
  'document_count'
];

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
  console.log('Global Metrics (Task 4) check');
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
    console.error('Ensure backend is running and admin/admin123 exists.');
    process.exit(1);
  }

  const auth = { headers: { Authorization: `Bearer ${token}` } };
  let allPass = true;

  console.log('1) GET /admin/metrics/global');
  let data;
  try {
    data = await request('GET', '/admin/metrics/global', auth);
    allPass = ok('returns 200', true) && allPass;
  } catch (e) {
    console.log('  [FAIL]', e.message);
    process.exit(1);
  }

  console.log('2) Response has all expected keys');
  for (const key of EXPECTED_KEYS) {
    allPass = ok(`has "${key}"`, key in data) && allPass;
  }

  console.log('3) All metric values are numbers');
  for (const key of EXPECTED_KEYS) {
    const val = data[key];
    const isNum = typeof val === 'number' && !Number.isNaN(val);
    allPass = ok(`${key} is number`, isNum, String(val)) && allPass;
  }

  console.log('4) violations_resolved = total - active');
  const total = data.violations_total ?? 0;
  const active = data.violations_active ?? 0;
  const resolved = data.violations_resolved ?? 0;
  allPass = ok('violations_resolved consistent', resolved === total - active, `resolved=${resolved}, total-active=${total - active}`) && allPass;

  console.log('');
  if (allPass) {
    console.log('All Global Metrics checks passed.');
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
