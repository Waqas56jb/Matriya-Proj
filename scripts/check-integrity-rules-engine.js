#!/usr/bin/env node
/**
 * Checks that Task 2 Integrity Rules Engine works:
 * - GET /admin/recovery/rules returns rules and conditionTypes
 * - Default rules include unjustified_growth, unexplained_decrease, no_progress
 * - Condition types include growth_above_ratio, decrease_without_structural_change, no_progress_cycles, metric_above, metric_below, drop_percent_above
 * Run from matriya-back with backend up: node scripts/check-integrity-rules-engine.js
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

const REQUIRED_RULE_IDS = ['unjustified_growth', 'unexplained_decrease', 'no_progress'];
const REQUIRED_CONDITION_TYPES = [
  'growth_above_ratio',
  'decrease_without_structural_change',
  'no_progress_cycles',
  'metric_above',
  'metric_below',
  'drop_percent_above'
];

async function main() {
  console.log('Integrity Rules Engine check');
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

  console.log('1) GET /admin/recovery/rules');
  let data;
  try {
    data = await request('GET', '/admin/recovery/rules', auth);
    allPass = ok('returns 200', true) && allPass;
    allPass = ok('rules is array', Array.isArray(data.rules), `length=${data.rules?.length ?? 0}`) && allPass;
    allPass = ok('conditionTypes is array', Array.isArray(data.conditionTypes), `length=${data.conditionTypes?.length ?? 0}`) && allPass;
  } catch (e) {
    console.log('  [FAIL]', e.message);
    process.exit(1);
  }
  console.log('');

  console.log('2) Rules shape and required ids');
  const ruleIds = (data.rules || []).map((r) => r.id);
  for (const id of REQUIRED_RULE_IDS) {
    allPass = ok(`rule "${id}" present`, ruleIds.includes(id)) && allPass;
  }
  for (const r of data.rules || []) {
    allPass = ok(`rule has id, condition, action, reason`, !!(r.id && r.condition && r.action != null && r.reason != null), r.id) && allPass;
    allPass = ok(`  condition has type`, !!(r.condition && typeof r.condition.type === 'string'), r.id) && allPass;
  }
  console.log('');

  console.log('3) Condition types');
  const condTypes = (data.conditionTypes || []).map((c) => c.type);
  for (const type of REQUIRED_CONDITION_TYPES) {
    allPass = ok(`condition type "${type}" present`, condTypes.includes(type)) && allPass;
  }
  for (const c of data.conditionTypes || []) {
    allPass = ok(`  has type, params, description`, !!(c.type && Array.isArray(c.params) && c.description != null), c.type) && allPass;
  }
  console.log('');

  console.log('4) Rule condition types match engine');
  const knownTypes = new Set(condTypes);
  for (const r of data.rules || []) {
    const t = r.condition?.type;
    allPass = ok(`rule ${r.id} condition type "${t}" is registered`, !t || knownTypes.has(t)) && allPass;
  }
  console.log('');

  if (allPass) {
    console.log('All Integrity Rules Engine checks passed.');
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
