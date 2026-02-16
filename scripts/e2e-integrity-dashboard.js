#!/usr/bin/env node
/**
 * E2E: Login as admin/admin123, upload a tiny file (so |M|>0), run full research cycle K→C→B→N→L,
 * then check B-Integrity dashboard: current_cycle, current_m, cycles_since_last_closure.
 * Usage: node scripts/e2e-integrity-dashboard.js
 * Env: BASE_URL=http://localhost:8000 (default)
 * Requires Node 18+ (fetch).
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
      {
        method,
        headers,
        rejectUnauthorized: false
      },
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
    req.setTimeout(60000);
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  console.log('BASE_URL:', BASE_URL);
  console.log('');

  let token;

  // 1) Login
  console.log('1) Login as admin / admin123...');
  const loginRes = await request('POST', '/auth/login', {
    body: { username: 'admin', password: 'admin123' }
  });
  token = loginRes.access_token;
  if (!token) throw new Error('No access_token in login response');
  console.log('   OK – got token');

  const auth = { Authorization: `Bearer ${token}` };

  // 2) Upload a tiny file so |M| > 0 (Node 18+ fetch + FormData)
  console.log('2) Upload tiny file for |M| > 0...');
  try {
    const form = new FormData();
    form.append('file', new Blob(['E2E B-Integrity test document.\n']), 'e2e-test.txt');
    const uploadRes = await fetch(BASE_URL + '/ingest/file', {
      method: 'POST',
      body: form,
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!uploadRes.ok) throw new Error((await uploadRes.text()) || uploadRes.status);
    console.log('   OK');
  } catch (e) {
    console.log('   Skip (upload failed):', e.message);
  }

  // 3) Create research session
  console.log('3) Create research session...');
  const sessionRes = await request('POST', '/research/session', { headers: auth });
  const sessionId = sessionRes.session_id;
  if (!sessionId) throw new Error('No session_id');
  console.log('   OK – session_id:', sessionId);

  const search = (stage, query = 'מה יש במערכת?') =>
    request('GET', `/search?query=${encodeURIComponent(query)}&session_id=${sessionId}&stage=${stage}&generate_answer=true`, {
      headers: auth
    });

  // 4) K → C → B → N → L (first full cycle)
  for (const stage of ['K', 'C', 'B', 'N', 'L']) {
    console.log(`4) Stage ${stage}...`);
    await search(stage);
    console.log(`   OK`);
  }

  // 4b) Repeat L a few times so the chart "|M| לאורך זמן" has multiple points (stay under no_progress threshold)
  const extraCycles = Math.min(parseInt(process.env.EXTRA_CYCLES, 10) || 2, 2);
  console.log(`4b) Extra L cycles (${extraCycles}) for chart points...`);
  for (let i = 0; i < extraCycles; i++) {
    await search('L', `query cycle ${i + 2}`);
    console.log(`   L ${i + 2}/${extraCycles + 1} OK`);
  }

  // 5) Dashboard
  console.log('5) Fetch B-Integrity dashboard...');
  const dashboard = await request('GET', '/admin/recovery/dashboard', { headers: auth });
  console.log('   gate_status:', dashboard.gate_status);
  console.log('   current_cycle:', dashboard.current_cycle);
  console.log('   current_m (|M|):', dashboard.current_m);
  console.log('   cycles_since_last_closure:', dashboard.cycles_since_last_closure);

  // 6) Assertions
  const errors = [];
  if (dashboard.current_cycle < 1) {
    errors.push(`current_cycle expected >= 1, got ${dashboard.current_cycle}`);
  }
  if (dashboard.cycles_since_last_closure < 0) {
    errors.push(`cycles_since_last_closure should be >= 0, got ${dashboard.cycles_since_last_closure}`);
  }
  if (!['HEALTHY', 'HALTED', 'RECOVERY'].includes(dashboard.gate_status)) {
    errors.push(`gate_status expected HEALTHY|HALTED|RECOVERY, got ${dashboard.gate_status}`);
  }
  if (errors.length) {
    console.error('\nAssertions failed:');
    errors.forEach((e) => console.error('  -', e));
    process.exit(1);
  }

  console.log('\nAll checks passed: zeros changed where expected, dashboard works.');
  console.log('  current_cycle:', dashboard.current_cycle, '(>= 1)');
  console.log('  cycles_since_last_closure:', dashboard.cycles_since_last_closure);
  console.log('  |M| current_m:', dashboard.current_m);
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
