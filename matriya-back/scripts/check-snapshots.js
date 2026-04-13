#!/usr/bin/env node
/**
 * Checks that Task 3 Snapshots mechanism works:
 * - POST /admin/snapshots (create), GET /admin/snapshots (list), GET /admin/snapshots/:id (get one), POST /admin/snapshots/:id/restore (restore)
 * Run from matriya-back with backend up: node scripts/check-snapshots.js
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
  console.log('Snapshots mechanism check');
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

  console.log('1) Create snapshot (POST /admin/snapshots)');
  let created;
  try {
    created = await request('POST', '/admin/snapshots', {
      ...auth,
      body: { name: 'check-snap-' + Date.now(), description: 'Script test', type: 'integrity' }
    });
    allPass = ok('returns 201 and has id', created.id != null) && allPass;
    allPass = ok('has name and snapshot_type', !!(created.name && created.snapshot_type)) && allPass;
    allPass = ok('has counts', typeof created.counts?.integrity_cycle_snapshots === 'number' && typeof created.counts?.violations === 'number') && allPass;
  } catch (e) {
    console.log('  [FAIL]', e.message);
    process.exit(1);
  }
  console.log('');

  console.log('2) List snapshots (GET /admin/snapshots)');
  try {
    const list = await request('GET', '/admin/snapshots', auth);
    allPass = ok('snapshots is array', Array.isArray(list.snapshots)) && allPass;
    allPass = ok('created snapshot appears in list', list.snapshots.some(s => s.id === created.id)) && allPass;
    const one = list.snapshots.find(s => s.id === created.id);
    allPass = ok('list item has id, name, snapshot_type, created_at', !!(one && one.name && one.snapshot_type != null && one.created_at)) && allPass;
  } catch (e) {
    console.log('  [FAIL]', e.message);
    allPass = false;
  }
  console.log('');

  console.log('3) Get one snapshot (GET /admin/snapshots/:id)');
  try {
    const one = await request('GET', `/admin/snapshots/${created.id}`, auth);
    allPass = ok('same id and name', one.id === created.id && one.name === created.name) && allPass;
    allPass = ok('payload present', one.payload != null && typeof one.payload === 'object') && allPass;
    allPass = ok('payload has integrity_cycle_snapshots and violations arrays', Array.isArray(one.payload?.integrity_cycle_snapshots) && Array.isArray(one.payload?.violations)) && allPass;
  } catch (e) {
    console.log('  [FAIL]', e.message);
    allPass = false;
  }
  console.log('');

  console.log('4) Restore snapshot (POST /admin/snapshots/:id/restore)');
  try {
    const restore = await request('POST', `/admin/snapshots/${created.id}/restore`, auth);
    allPass = ok('success true', restore.success === true) && allPass;
    allPass = ok('restored counts', typeof restore.restored?.integrity_cycle_snapshots === 'number' && typeof restore.restored?.violations === 'number') && allPass;
  } catch (e) {
    console.log('  [FAIL]', e.message);
    allPass = false;
  }
  console.log('');

  console.log('5) Get non-existent snapshot returns 404');
  try {
    await request('GET', '/admin/snapshots/999999', auth);
    allPass = ok('expected 404', false) && allPass;
  } catch (e) {
    allPass = ok('returns 404', e.message.includes('404')) && allPass;
  }
  console.log('');

  if (allPass) {
    console.log('All Snapshots mechanism checks passed.');
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
