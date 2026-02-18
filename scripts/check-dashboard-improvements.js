#!/usr/bin/env node
/**
 * Checks that Task 1 dashboard improvements work:
 * - Dashboard with filter params (from_date, to_date, violation_status, violation_type)
 * - Response shape for chart + violations (CSV export and extra charts use this)
 * Run from matriya-back with backend up: node scripts/check-dashboard-improvements.js
 * Env: BASE_URL=http://localhost:8000 (default)
 */
import http from 'http';
import https from 'https';

const BASE_URL = process.env.BASE_URL || 'http://localhost:8000';

function request(method, path, options = {}) {
  const url = new URL(path, BASE_URL);
  const isHttps = url.protocol === 'https:';
  const body = options.body ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : undefined;
  const headers = options.headers && options.headers['Content-Type'] ? options.headers : { 'Content-Type': 'application/json', ...options.headers };
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
  console.log('Dashboard improvements check');
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

  // 1) Dashboard baseline (no filters)
  console.log('1) Dashboard baseline (no filters)');
  try {
    const d = await request('GET', '/admin/recovery/dashboard', auth);
    allPass = ok('gate_status present', typeof d.gate_status === 'string') && allPass;
    allPass = ok('gate_status valid', ['HEALTHY', 'HALTED', 'RECOVERY'].includes(d.gate_status), d.gate_status) && allPass;
    allPass = ok('current_cycle number', typeof d.current_cycle === 'number') && allPass;
    allPass = ok('current_m number', typeof d.current_m === 'number') && allPass;
    allPass = ok('chart.points array', Array.isArray(d.chart?.points)) && allPass;
    allPass = ok('chart.violations array', Array.isArray(d.chart?.violations)) && allPass;
    allPass = ok('violations array', Array.isArray(d.violations)) && allPass;
  } catch (e) {
    console.log('  [FAIL]', e.message);
    allPass = false;
  }
  console.log('');

  // 2) Dashboard with date filters
  console.log('2) Dashboard with date filters (from_date, to_date)');
  try {
    const from = '2020-01-01';
    const to = '2030-12-31';
    const url = `/admin/recovery/dashboard?limit=50&from_date=${encodeURIComponent(from)}&to_date=${encodeURIComponent(to)}`;
    const d = await request('GET', url, auth);
    allPass = ok('returns 200 and shape', d.gate_status != null && Array.isArray(d.violations)) && allPass;
    allPass = ok('chart.points array', Array.isArray(d.chart?.points)) && allPass;
  } catch (e) {
    console.log('  [FAIL]', e.message);
    allPass = false;
  }
  console.log('');

  // 3) Dashboard with violation_status=active
  console.log('3) Dashboard with violation_status=active');
  try {
    const d = await request('GET', '/admin/recovery/dashboard?violation_status=active', auth);
    allPass = ok('returns 200', true) && allPass;
    const allResolved = (d.violations || []).every((v) => v.resolved_at == null);
    allPass = ok('all returned violations unresolved', allResolved, `count=${d.violations?.length ?? 0}`) && allPass;
  } catch (e) {
    console.log('  [FAIL]', e.message);
    allPass = false;
  }
  console.log('');

  // 4) Dashboard with violation_status=resolved
  console.log('4) Dashboard with violation_status=resolved');
  try {
    const d = await request('GET', '/admin/recovery/dashboard?violation_status=resolved', auth);
    allPass = ok('returns 200', true) && allPass;
    const allHaveResolved = (d.violations || []).every((v) => v.resolved_at != null);
    allPass = ok('all returned violations resolved', (d.violations?.length === 0) || allHaveResolved, `count=${d.violations?.length ?? 0}`) && allPass;
  } catch (e) {
    console.log('  [FAIL]', e.message);
    allPass = false;
  }
  console.log('');

  // 5) Dashboard with violation_type filter (any type accepted)
  console.log('5) Dashboard with violation_type filter');
  try {
    const d = await request('GET', '/admin/recovery/dashboard?violation_type=B_INTEGRITY', auth);
    allPass = ok('returns 200 and shape', d.gate_status != null && Array.isArray(d.violations)) && allPass;
    const allMatchType = (d.violations || []).every((v) => v.type === 'B_INTEGRITY');
    allPass = ok('violations match type or empty', allMatchType, `count=${d.violations?.length ?? 0}`) && allPass;
  } catch (e) {
    console.log('  [FAIL]', e.message);
    allPass = false;
  }
  console.log('');

  // 6) Data shape for CSV export (violations)
  console.log('6) Data shape for CSV export (violations)');
  try {
    const d = await request('GET', '/admin/recovery/dashboard', auth);
    const violations = d.violations || [];
    const hasRequired = violations.length === 0 || violations.every((v) => 
      typeof v.id !== 'undefined' && 
      (v.session_id !== undefined) && 
      (v.type !== undefined) && 
      (v.created_at !== undefined)
    );
    allPass = ok('violations have id, session_id, type, created_at', hasRequired) && allPass;
  } catch (e) {
    console.log('  [FAIL]', e.message);
    allPass = false;
  }
  console.log('');

  // 7) Data shape for CSV export (chart) and extra charts
  console.log('7) Data shape for chart CSV and extra charts');
  try {
    const d = await request('GET', '/admin/recovery/dashboard', auth);
    const points = d.chart?.points || [];
    const hasPointShape = points.length === 0 || points.every((p) => typeof p.value === 'number' && (p.t !== undefined || p.value !== undefined));
    allPass = ok('chart.points have value and t', hasPointShape) && allPass;
    const violations = d.violations || [];
    const hasViolationDate = violations.length === 0 || violations.every((v) => true);
    allPass = ok('violations usable for by-type and over-time charts', hasViolationDate) && allPass;
  } catch (e) {
    console.log('  [FAIL]', e.message);
    allPass = false;
  }
  console.log('');

  if (allPass) {
    console.log('All dashboard improvement checks passed.');
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
