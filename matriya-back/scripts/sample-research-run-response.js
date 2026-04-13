#!/usr/bin/env node
/**
 * Prints a real JSON response from POST /api/research/run and (if possible) Hard Stop from GET /search.
 * Run with backend up: node scripts/sample-research-run-response.js
 * BASE_URL defaults to http://localhost:8000
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
            resolve({ statusCode: res.statusCode, data: json, raw: data });
          } catch (e) {
            resolve({ statusCode: res.statusCode, data: null, raw: data });
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

async function main() {
  console.log('BASE_URL:', BASE_URL);
  console.log('');

  // 1) Create session
  let sessionId;
  try {
    const sessionRes = await request('POST', '/research/session', { body: {} });
    sessionId = sessionRes.data?.session_id;
    if (!sessionId) {
      console.error('Could not create session:', sessionRes.raw || sessionRes.data);
      process.exit(1);
    }
    console.log('Session created:', sessionId);
  } catch (e) {
    console.error('Session creation failed:', e.message);
    process.exit(1);
  }

  // 2) POST /api/research/run – real response
  console.log('\n--- POST /api/research/run (real response) ---\n');
  try {
    const runRes = await request('POST', '/api/research/run', {
      body: { session_id: sessionId, query: 'מהי ההשפעה של טמפרטורה על צמיחת צמחים?', use_4_agents: true }
    });
    console.log(JSON.stringify(runRes.data, null, 2));
    if (runRes.statusCode >= 400) {
      console.error('Run failed with status', runRes.statusCode);
      process.exit(1);
    }
  } catch (e) {
    console.error('Research run request failed:', e.message);
    process.exit(1);
  }

  // 3) Hard Stop (violation) – login as admin, create violation via DB not exposed; show expected shape
  console.log('\n--- Hard Stop (violation) – expected GET /search response when gate locked ---\n');
  console.log(JSON.stringify({
    error: 'Session locked due to B-Integrity violation (growth). Use Recovery API to resolve.',
    research_stage_error: true,
    research_gate_locked: true,
    violation_id: 42
  }, null, 2));
  console.log('\n(See docs/RESEARCH_RUN_AND_HARD_STOP_EXAMPLES.md for full details.)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
