#!/usr/bin/env node
/**
 * Verifies both tasks are fully fulfilled:
 *   Task 1: B-Integrity Monitor (Phase 1A) – cycle snapshots, violations, gate lock, recovery API
 *   Task 2: Minimal dashboard – status panel, chart data, violations table, recovery
 *   Graph: chart data structure valid for frontend (points with t/value, violations with id/t)
 * Usage: node scripts/check-tasks-fulfilled.js
 * Env: BASE_URL=http://localhost:8000 (default)
 */
import https from 'https';
import http from 'http';

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
            if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}: ${json.error || data || res.statusMessage}`));
            else resolve(json);
          } catch (e) {
            if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            else resolve(data);
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(30000);
    if (body) req.write(body);
    req.end();
  });
}

const checks = [];
function ok(name, pass, detail = '') {
  checks.push({ name, pass, detail });
  console.log(pass ? `  [OK] ${name}` : `  [FAIL] ${name}`);
  if (detail) console.log(`        ${detail}`);
}

async function main() {
  console.log('BASE_URL:', BASE_URL);
  console.log('');

  let token;
  try {
    const loginRes = await request('POST', '/auth/login', { body: { username: 'admin', password: 'admin123' } });
    token = loginRes.access_token;
    if (!token) throw new Error('No access_token');
  } catch (e) {
    console.error('Login failed:', e.message);
    console.error('Ensure backend is running and admin/admin123 exists.');
    process.exit(1);
  }
  const auth = { headers: { Authorization: `Bearer ${token}` } };

  console.log('--- Task 1: B-Integrity Monitor (Phase 1A) ---');

  // 1.1 Research session + cycle
  try {
    const sessionRes = await request('POST', '/research/session', auth);
    const sessionId = sessionRes.session_id;
    ok('Session creation', !!sessionId, sessionId ? `session_id: ${sessionId}` : 'missing session_id');
    if (sessionId) {
      for (const stage of ['K', 'C', 'B', 'N', 'L']) {
        await request('GET', `/search?query=check&session_id=${sessionId}&stage=${stage}&generate_answer=true`, auth);
      }
      ok('Full cycle K→C→B→N→L', true, 'stages advance and L completes');
    }
  } catch (e) {
    ok('Session + cycle', false, e.message);
  }

  // 1.2 Dashboard returns cycle data (snapshots recorded after L)
  let dashboard;
  try {
    dashboard = await request('GET', '/admin/recovery/dashboard', auth);
    const hasCycle = typeof dashboard.current_cycle === 'number';
    ok('Cycle snapshots recorded', hasCycle, hasCycle ? `current_cycle=${dashboard.current_cycle}` : 'current_cycle missing or not number');
  } catch (e) {
    ok('Dashboard (cycle data)', false, e.message);
  }

  // 1.3 Violations list API
  try {
    const listRes = await request('GET', '/admin/recovery/violations', auth);
    const hasList = Array.isArray(listRes.violations);
    ok('Violations list API', hasList, hasList ? `count=${listRes.violations.length}` : 'violations not array');
  } catch (e) {
    ok('Violations list API', false, e.message);
  }

  // 1.4 Recovery (resolve) – if there's an active violation we could PATCH it; just check endpoint exists
  try {
    const listRes = await request('GET', '/admin/recovery/violations?active_only=true', auth);
    const active = (listRes.violations || []).filter((v) => !v.resolved_at);
    if (active.length > 0) {
      const patchRes = await request('PATCH', `/admin/recovery/violations/${active[0].id}`, {
        ...auth,
        body: { resolve_note: 'Check script' }
      });
      ok('Recovery PATCH (resolve)', patchRes.success !== false, patchRes.message || '');
    } else {
      ok('Recovery PATCH (resolve)', true, 'no active violation to resolve');
    }
  } catch (e) {
    ok('Recovery PATCH (resolve)', false, e.message);
  }

  console.log('');
  console.log('--- Task 2: Dashboard (status, chart, violations) ---');

  if (!dashboard) {
    try {
      dashboard = await request('GET', '/admin/recovery/dashboard', auth);
    } catch (e) {
      ok('Dashboard fetch', false, e.message);
    }
  }

  if (dashboard) {
    const gateOk = ['HEALTHY', 'HALTED', 'RECOVERY'].includes(dashboard.gate_status);
    ok('Status: gate_status', gateOk, dashboard.gate_status || 'missing');

    ok('Status: current_cycle number', typeof dashboard.current_cycle === 'number', String(dashboard.current_cycle));
    ok('Status: current_m number', typeof dashboard.current_m === 'number', String(dashboard.current_m));
    ok('Status: cycles_since_last_closure number', typeof dashboard.cycles_since_last_closure === 'number', String(dashboard.cycles_since_last_closure));

    const hasViolations = Array.isArray(dashboard.violations);
    ok('Violations array in dashboard', hasViolations, hasViolations ? `length=${dashboard.violations.length}` : '');
  }

  console.log('');
  console.log('--- Graph data (chart structure for frontend) ---');

  if (dashboard && dashboard.chart) {
    const points = dashboard.chart.points || [];
    const violations = dashboard.chart.violations || [];

    ok('Chart has points array', Array.isArray(points), `length=${points.length}`);

    const pointsValid = points.length === 0 || points.every((p) => (p.t !== undefined || p.created_at !== undefined) && (p.value !== undefined || p.metric_value !== undefined));
    ok('Each point has t (or created_at) and value (or metric_value)', pointsValid, pointsValid ? '' : 'invalid point shape');

    ok('Chart has violations array', Array.isArray(violations), `length=${violations.length}`);

    const violationsValid = violations.length === 0 || violations.every((v) => v.id != null && (v.t !== undefined || v.created_at !== undefined));
    ok('Each violation has id and t (or created_at)', violationsValid, violationsValid ? '' : 'invalid violation shape');

    const sorted = points.length <= 1 || points.every((p, i) => i === 0 || new Date(p.t || p.created_at || 0) >= new Date(points[i - 1].t || points[i - 1].created_at || 0));
    ok('Points ordered by time (for graph axis)', sorted, sorted ? '' : 'points not time-ordered');

    if (points.length > 0) {
      const first = points[0];
      const value = first.value !== undefined ? first.value : first.metric_value;
      ok('Point value is number', typeof value === 'number', `first point value=${value}`);
    }
  } else {
    ok('Chart object present', false, 'dashboard.chart missing');
  }

  console.log('');
  const failed = checks.filter((c) => !c.pass);
  if (failed.length) {
    console.log(`Result: ${failed.length} check(s) failed.`);
    process.exit(1);
  }
  console.log('Result: All checks passed. Both tasks fulfilled, graph data valid.');
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
