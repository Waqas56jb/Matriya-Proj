#!/usr/bin/env node
/**
 * Checks that Task 7 DoE integration works:
 * - GET /admin/doe/export (json + csv)
 * - GET/POST/GET/PATCH/DELETE /admin/doe/designs
 * - POST /admin/doe/designs/:id/execute (optional, can be slow)
 * Run from matriya-back with backend up: node scripts/check-doe-integration.js
 * Env: BASE_URL=http://localhost:8000 (default), SKIP_DOE_EXECUTE=1 to skip execute step
 */
import http from 'http';
import https from 'https';

const BASE_URL = process.env.BASE_URL || 'http://localhost:8000';
const SKIP_EXECUTE = process.env.SKIP_DOE_EXECUTE === '1';

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
          if (res.statusCode >= 400) {
            try {
              const json = data ? JSON.parse(data) : {};
              reject(new Error(`HTTP ${res.statusCode}: ${json.error || data || res.statusMessage}`));
            } catch (e) {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            }
            return;
          }
          if (options.raw) {
            resolve({ data, contentType: res.headers['content-type'] || '' });
            return;
          }
          try {
            resolve(data ? JSON.parse(data) : {});
          } catch (e) {
            resolve(data);
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(options.timeout || 15000);
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
  console.log('DoE integration (Task 7) check');
  console.log('BASE_URL:', BASE_URL);
  if (SKIP_EXECUTE) console.log('SKIP_DOE_EXECUTE=1 – skipping execute step');
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

  console.log('1) GET /admin/doe/export (format=json)');
  try {
    const data = await request('GET', '/admin/doe/export?limit=5', auth);
    allPass = ok('runs is array', Array.isArray(data.runs)) && allPass;
    allPass = ok('count is number', typeof data.count === 'number') && allPass;
    if (data.runs && data.runs.length > 0) {
      const first = data.runs[0];
      allPass = ok('run has run_id, query, synthesis_output', !!(first.run_id != null && first.query != null && first.synthesis_output !== undefined)) && allPass;
    }
  } catch (e) {
    console.log('  [FAIL]', e.message);
    allPass = false;
  }
  console.log('');

  console.log('2) GET /admin/doe/export (format=csv)');
  try {
    const res = await request('GET', '/admin/doe/export?limit=2&format=csv', { ...auth, raw: true });
    const data = res.data != null ? res.data : res;
    const contentType = res.contentType || res.headers?.['content-type'] || '';
    allPass = ok('returns data', data.length > 0) && allPass;
    allPass = ok('CSV has header run_id', data.includes('run_id')) && allPass;
    allPass = ok('content-type csv', (contentType || '').includes('csv')) && allPass;
  } catch (e) {
    console.log('  [FAIL]', e.message);
    allPass = false;
  }
  console.log('');

  console.log('3) POST /admin/doe/designs (create)');
  let designId;
  try {
    const created = await request('POST', '/admin/doe/designs', {
      ...auth,
      body: {
        name: 'Task7-check-design-' + Date.now(),
        description: 'Check script',
        design: [
          { run: 1, factors: { A: 1, B: 2 } },
          { run: 2, factors: { A: 2, B: 1 } }
        ],
        query_template: 'Test A={{A}} B={{B}}'
      }
    });
    designId = created.id;
    allPass = ok('returns 201 and id', created.id != null) && allPass;
    allPass = ok('design array length 2', Array.isArray(created.design) && created.design.length === 2) && allPass;
    allPass = ok('query_template present', created.query_template != null) && allPass;
  } catch (e) {
    console.log('  [FAIL]', e.message);
    allPass = false;
  }
  console.log('');

  if (!designId) {
    console.log('Skipping remaining steps (no design id).');
    process.exit(allPass ? 0 : 1);
  }

  console.log('4) GET /admin/doe/designs (list)');
  try {
    const list = await request('GET', '/admin/doe/designs', auth);
    allPass = ok('designs is array', Array.isArray(list.designs)) && allPass;
    allPass = ok('created design in list', (list.designs || []).some(d => d.id === designId)) && allPass;
  } catch (e) {
    console.log('  [FAIL]', e.message);
    allPass = false;
  }
  console.log('');

  console.log('5) GET /admin/doe/designs/:id');
  try {
    const one = await request('GET', `/admin/doe/designs/${designId}`, auth);
    allPass = ok('same id', one.id === designId) && allPass;
    allPass = ok('design and query_template', Array.isArray(one.design) && one.query_template != null) && allPass;
  } catch (e) {
    console.log('  [FAIL]', e.message);
    allPass = false;
  }
  console.log('');

  console.log('6) PATCH /admin/doe/designs/:id');
  try {
    const updated = await request('PATCH', `/admin/doe/designs/${designId}`, {
      ...auth,
      body: { name: 'Updated DoE design name' }
    });
    allPass = ok('name updated', updated.name === 'Updated DoE design name') && allPass;
  } catch (e) {
    console.log('  [FAIL]', e.message);
    allPass = false;
  }
  console.log('');

  if (!SKIP_EXECUTE) {
    console.log('7) POST /admin/doe/designs/:id/execute (2 runs, may take 30-60s)');
    try {
      const execRes = await request('POST', `/admin/doe/designs/${designId}/execute`, { ...auth, body: {}, timeout: 120000 });
      allPass = ok('execute success', execRes.success === true) && allPass;
      allPass = ok('runs_executed', execRes.runs_executed >= 1, String(execRes.runs_executed)) && allPass;
      allPass = ok('results array', Array.isArray(execRes.results)) && allPass;
    } catch (e) {
      console.log('  [FAIL]', e.message);
      allPass = false;
    }
    console.log('');
  } else {
    console.log('7) POST execute (skipped)');
    console.log('');
  }

  console.log('8) DELETE /admin/doe/designs/:id');
  try {
    const deleted = await request('DELETE', `/admin/doe/designs/${designId}`, auth);
    allPass = ok('delete success', deleted.success === true && deleted.id === designId) && allPass;
  } catch (e) {
    console.log('  [FAIL]', e.message);
    allPass = false;
  }
  console.log('');

  if (allPass) {
    console.log('All DoE integration checks passed.');
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
