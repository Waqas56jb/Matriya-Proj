#!/usr/bin/env node
/**
 * Prints consolidated value report (runs, successes, hard stops, violations by type, recoveries).
 * Run with backend up: node scripts/report-value-summary.js
 * BASE_URL=http://localhost:8000 (default). Uses admin/admin123.
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
  const headers = { ...(body && { 'Content-Type': 'application/json' }), ...options.headers };
  if (body && headers['Content-Type']) headers['Content-Length'] = Buffer.byteLength(body);

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
            if (res.statusCode >= 400) reject(new Error(json.error || data || `HTTP ${res.statusCode}`));
            else resolve(json);
          } catch (e) {
            reject(new Error(data || e.message));
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

async function main() {
  let token;
  try {
    const login = await request('POST', '/auth/login', { body: { username: 'admin', password: 'admin123' } });
    token = login.access_token;
    if (!token) throw new Error('No token');
  } catch (e) {
    console.error('Login failed:', e.message);
    process.exit(1);
  }

  const auth = { headers: { Authorization: `Bearer ${token}` } };
  const d = await request('GET', '/admin/reports/value-summary', auth);

  console.log('=== דוח תוצאות מרוכז (Governance) ===\n');
  console.log('ריצות מחקר (Research Loop)');
  console.log('  סה"כ ריצות:              ', d.runs?.total ?? 0);
  console.log('  הסתיימו בהצלחה:           ', d.runs?.successful ?? 0);
  console.log('  נעצרו ב-Hard Stop:         ', d.runs?.stopped_by_violation ?? 0);
  console.log('');
  console.log('Violations – סוגים שכיחים (לפי reason):');
  const byReason = d.violations_by_reason || {};
  if (Object.keys(byReason).length === 0) console.log('  (אין)');
  else Object.entries(byReason).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
  console.log('');
  console.log('Recovery');
  console.log('  סה"כ שחרורים (resolve):    ', d.recoveries?.total_resolved ?? 0);
  console.log('');
  if (d.note_run_duration) console.log('הערה:', d.note_run_duration);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
