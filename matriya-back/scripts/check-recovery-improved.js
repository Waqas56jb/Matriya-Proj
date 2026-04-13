#!/usr/bin/env node
/**
 * Checks that Task 5 Improved Recovery works:
 * - Restore with backup_before_restore returns backup_snapshot_id
 * - Rollback restores from backup_snapshot_id
 * - POST /admin/recovery/violations/resolve-all resolves active violations
 * Run from matriya-back with backend up: node scripts/check-recovery-improved.js
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
  console.log('Improved Recovery (Task 5) check');
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

  console.log('1) Create a snapshot to restore from');
  let snapId;
  try {
    const created = await request('POST', '/admin/snapshots', {
      ...auth,
      body: { name: 'task5-check-snap-' + Date.now(), type: 'integrity' }
    });
    snapId = created.id;
    allPass = ok('snapshot created', snapId != null, 'id=' + snapId) && allPass;
  } catch (e) {
    console.log('  [FAIL]', e.message);
    process.exit(1);
  }
  console.log('');

  console.log('2) Restore with backup_before_restore=true');
  let backupId;
  try {
    const restored = await request('POST', `/admin/snapshots/${snapId}/restore?backup_before_restore=true`, auth);
    allPass = ok('restore success', restored.success === true) && allPass;
    allPass = ok('backup_snapshot_id present', restored.backup_snapshot_id != null, 'id=' + restored.backup_snapshot_id) && allPass;
    allPass = ok('restored counts', typeof restored.restored?.integrity_cycle_snapshots === 'number' && typeof restored.restored?.violations === 'number') && allPass;
    backupId = restored.backup_snapshot_id;
  } catch (e) {
    console.log('  [FAIL]', e.message);
    allPass = false;
  }
  console.log('');

  console.log('3) Rollback to backup snapshot');
  try {
    const rollback = await request('POST', '/admin/recovery/rollback', {
      ...auth,
      body: { backup_snapshot_id: backupId }
    });
    allPass = ok('rollback success', rollback.success === true) && allPass;
    allPass = ok('rollback_snapshot_id', rollback.rollback_snapshot_id === backupId) && allPass;
    allPass = ok('restored in rollback', typeof rollback.restored?.integrity_cycle_snapshots === 'number') && allPass;
  } catch (e) {
    console.log('  [FAIL]', e.message);
    allPass = false;
  }
  console.log('');

  console.log('4) resolve-all (no body)');
  try {
    const resolveAll = await request('POST', '/admin/recovery/violations/resolve-all', auth);
    allPass = ok('resolve-all success', resolveAll.success === true) && allPass;
    allPass = ok('resolved is number', typeof resolveAll.resolved === 'number') && allPass;
  } catch (e) {
    console.log('  [FAIL]', e.message);
    allPass = false;
  }
  console.log('');

  console.log('5) rollback without backup_snapshot_id returns 400');
  try {
    await request('POST', '/admin/recovery/rollback', { ...auth, body: {} });
    allPass = ok('expected 400', false) && allPass;
  } catch (e) {
    allPass = ok('returns 400', e.message.includes('400')) && allPass;
  }
  console.log('');

  if (allPass) {
    console.log('All Improved Recovery checks passed.');
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
