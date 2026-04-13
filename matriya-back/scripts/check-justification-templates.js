#!/usr/bin/env node
/**
 * Checks that Task 6 Justification templates system works:
 * - GET /admin/justification-templates (list)
 * - POST /admin/justification-templates (create)
 * - PATCH /admin/justification-templates/:id (update)
 * - DELETE /admin/justification-templates/:id (delete)
 * Run from matriya-back with backend up: node scripts/check-justification-templates.js
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
  console.log('Justification templates (Task 6) check');
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

  console.log('1) GET /admin/justification-templates');
  let list;
  try {
    list = await request('GET', '/admin/justification-templates', auth);
    allPass = ok('templates is array', Array.isArray(list.templates)) && allPass;
    allPass = ok('count is number', typeof list.count === 'number') && allPass;
  } catch (e) {
    console.log('  [FAIL]', e.message);
    process.exit(1);
  }
  console.log('');

  console.log('2) POST /admin/justification-templates (create)');
  const reasonCode = 'task6_check_' + Date.now();
  let createdId;
  try {
    const created = await request('POST', '/admin/justification-templates', {
      ...auth,
      body: {
        name: 'Task6 check template',
        reason_code: reasonCode,
        label: 'Check label for {{agent}}',
        template_text: 'Output changed in {{agent}}'
      }
    });
    createdId = created.id;
    allPass = ok('returns 201 and has id', created.id != null) && allPass;
    allPass = ok('reason_code matches', created.reason_code === reasonCode) && allPass;
    allPass = ok('label present', created.label != null) && allPass;
  } catch (e) {
    console.log('  [FAIL]', e.message);
    allPass = false;
  }
  console.log('');

  console.log('3) GET list again – template appears');
  try {
    const list2 = await request('GET', '/admin/justification-templates', auth);
    const found = (list2.templates || []).find(t => t.id === createdId);
    allPass = ok('created template in list', !!found) && allPass;
    allPass = ok('template has reason_code, label', !!(found && found.reason_code && found.label)) && allPass;
  } catch (e) {
    console.log('  [FAIL]', e.message);
    allPass = false;
  }
  console.log('');

  console.log('4) PATCH /admin/justification-templates/:id');
  try {
    const updated = await request('PATCH', `/admin/justification-templates/${createdId}`, {
      ...auth,
      body: { label: 'Updated label' }
    });
    allPass = ok('update success', updated.id === createdId && updated.label === 'Updated label') && allPass;
  } catch (e) {
    console.log('  [FAIL]', e.message);
    allPass = false;
  }
  console.log('');

  console.log('5) DELETE /admin/justification-templates/:id');
  try {
    const deleted = await request('DELETE', `/admin/justification-templates/${createdId}`, auth);
    allPass = ok('delete success', deleted.success === true && deleted.id === createdId) && allPass;
  } catch (e) {
    console.log('  [FAIL]', e.message);
    allPass = false;
  }
  console.log('');

  console.log('6) Create with duplicate reason_code returns 409');
  const dupCode = 'task6_dup_' + Date.now();
  try {
    await request('POST', '/admin/justification-templates', {
      ...auth,
      body: { name: 'First', reason_code: dupCode }
    });
    await request('POST', '/admin/justification-templates', {
      ...auth,
      body: { name: 'Second', reason_code: dupCode }
    });
    allPass = ok('expected 409 for duplicate reason_code', false) && allPass;
  } catch (e) {
    allPass = ok('returns 409 for duplicate reason_code', e.message.includes('409')) && allPass;
  }
  const listClean = await request('GET', '/admin/justification-templates', auth).catch(() => ({ templates: [] }));
  const dupTemplate = (listClean.templates || []).find(t => t.reason_code === dupCode);
  if (dupTemplate) {
    try { await request('DELETE', `/admin/justification-templates/${dupTemplate.id}`, auth); } catch (_) {}
  }
  console.log('');

  if (allPass) {
    console.log('All Justification templates checks passed.');
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
