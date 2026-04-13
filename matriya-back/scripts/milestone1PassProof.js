#!/usr/bin/env node
/**
 * Milestone 1 — PASS proof harness + David determinism addendum (2026-04-11)
 *
 * Prerequisites:
 *   - management-back on MANAGEMENT_BACK_URL with POSTGRES_URL (lab DB)
 *   - matriya-back on MATRIYA_BASE_URL with MANAGEMENT_BACK_URL set
 *
 * Run:
 *   node scripts/milestone1PassProof.js
 *   node scripts/milestone1PassProof.js
 *   (two shell invocations must both exit 0 and print identical "SUITE_HASH" line)
 *
 * Optional DB sensitivity (controlled UPDATE + rollback):
 *   node scripts/milestone1PassProof.js --db-sensitivity
 *   Requires POSTGRES_URL in env (same DB as management-back lab chain).
 *
 * On any failure: prints full JSON snapshots, selected run_ids, DB delta, exact mismatch.
 * Does not patch the database on failure — only reports.
 */

import 'dotenv/config';
import axios from 'axios';
import pg from 'pg';
import crypto from 'crypto';

const MATRIYA = (process.env.MATRIYA_BASE_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
const MANAGEMENT = (process.env.MANAGEMENT_BACK_URL || 'http://127.0.0.1:8001').replace(/\/$/, '');

const LAB_QUERY_PARAMS = {
  type: 'version_comparison',
  base_id: 'BASE-003',
  version_a: '003.1',
  version_b: '003.2',
};

const labBody = {
  query: 'structured lab: BASE-003 version delta',
  generate_answer: true,
  flow: 'lab',
  lab_query_type: 'version_comparison',
  base_id: LAB_QUERY_PARAMS.base_id,
  version_a: LAB_QUERY_PARAMS.version_a,
  version_b: LAB_QUERY_PARAMS.version_b,
};

const WITH_DB_SENSITIVITY = process.argv.includes('--db-sensitivity');

// Skip HTTP fetches to External Layer during harness (lab decision is unchanged).
if (!process.env.ANSWER_COMPOSER_SKIP_EXTERNAL) {
  process.env.ANSWER_COMPOSER_SKIP_EXTERNAL = '1';
}

function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function normalizeMatriyaLabResponse(body) {
  const o = typeof body === 'object' && body !== null ? { ...body } : body;
  if (o && typeof o === 'object') {
    delete o.user_id;
    // External context is non-lab; strip for repeatability hash ×10 (size/order may vary).
    delete o.external_context;
  }
  return o;
}

function reportFailure(title, payload) {
  console.error('\n========== FAILURE REPORT ==========');
  console.error(title);
  console.error(JSON.stringify(payload, null, 2));
  console.error('====================================\n');
}

async function postMatriyaSearch(body) {
  const { data, status } = await axios.post(`${MATRIYA}/api/research/search`, body, {
    timeout: 120000,
    validateStatus: () => true,
    headers: { 'Content-Type': 'application/json' },
  });
  return { data, status };
}

async function getBridgeVersionComparison() {
  const { data, status } = await axios.get(`${MANAGEMENT}/api/lab/query`, {
    params: LAB_QUERY_PARAMS,
    timeout: 60000,
    validateStatus: () => true,
  });
  return { contract: data, status };
}

function pass(name, ok, detail = '') {
  const s = ok ? 'PASS' : 'FAIL';
  console.log(`[${s}] ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

/**
 * Full lab + routing checks that must be identical across repeatability runs.
 */
async function collectDeterministicSuite() {
  const out = {
    phase: 'suite',
    bridge_ping_status: null,
    matriya_ping_ok: false,
    lab_matriya: null,
    lab_matriya_status: null,
    lab_direct_contract: null,
    lab_direct_status: null,
    selection_triple_run_ids: [],
    invalid_lab: null,
    document_probe: null,
    document_hashes_10: [],
    errors: [],
  };

  try {
    const { status } = await axios.get(`${MANAGEMENT}/api/lab/query`, {
      params: { type: 'missing_variable_detection', base_id: 'BASE-003' },
      timeout: 30000,
      validateStatus: () => true,
    });
    out.bridge_ping_status = status;
  } catch (e) {
    out.errors.push(`bridge_ping: ${e.message}`);
    out.bridge_ping_status = -1;
  }

  try {
    // /health can be slow (vector DB info); /search can be much slower. Use health for liveness only.
    await axios.get(`${MATRIYA}/health`, { timeout: 120000 });
    out.matriya_ping_ok = true;
  } catch (e) {
    out.errors.push(`matriya_ping: ${e.message}`);
  }

  // Direct bridge: whenever management/standalone lab API is up (no MATRIYA required).
  if (out.bridge_ping_status === 200) {
    const { contract, status: dSt } = await getBridgeVersionComparison();
    out.lab_direct_status = dSt;
    out.lab_direct_contract = contract;

    for (let i = 0; i < 3; i++) {
      const { contract: c } = await getBridgeVersionComparison();
      const ids = Array.isArray(c?.source_run_ids) ? [...c.source_run_ids] : [];
      out.selection_triple_run_ids.push(ids);
    }
  }

  // MATRIYA integration: lab flow ×10, invalid lab, document retrieval ×10
  if (out.bridge_ping_status === 200 && out.matriya_ping_ok) {
    const { data: mData, status: mSt } = await postMatriyaSearch(labBody);
    out.lab_matriya_status = mSt;
    // Full composer payload for P2/P3 (do not strip external_context here — P2 requires Array.isArray).
    out.lab_matriya = typeof mData === 'object' && mData !== null ? { ...mData } : mData;

    const hashes = [];
    for (let i = 0; i < 10; i++) {
      const { data } = await postMatriyaSearch(labBody);
      hashes.push(stableStringify(normalizeMatriyaLabResponse(data)));
    }
    out.lab_matriya_10_hashes_unique = new Set(hashes).size;
    out.lab_matriya_10_first_hash = hashes[0] || null;

    const { data: bad } = await postMatriyaSearch({
      query: 'lab',
      flow: 'lab',
      lab_query_type: '__nonexistent_type__',
    });
    out.invalid_lab = normalizeMatriyaLabResponse(bad);

    const { data: doc } = await postMatriyaSearch({
      query: 'formulation viscosity test method',
      generate_answer: false,
      flow: 'document',
      n_results: 3,
    });
    out.document_probe = doc;
    const dh = [];
    for (let i = 0; i < 10; i++) {
      const { data: d } = await postMatriyaSearch({
        query: 'formulation viscosity test method',
        generate_answer: false,
        flow: 'document',
        n_results: 3,
      });
      dh.push(
        stableStringify({
          rc: d.results_count,
          ids: (d.results || []).map((r) => r.id || r.chunk_id || r.metadata?.id).filter(Boolean),
        })
      );
    }
    out.document_hashes_10_unique = new Set(dh).size;
  }

  return out;
}

function assertSelectionStability(suite) {
  const trips = suite.selection_triple_run_ids || [];
  if (trips.length !== 3) {
    return { ok: false, a: trips[0], b: trips[1], c: trips[2], reason: 'expected 3 bridge calls' };
  }
  const [a, b, c] = trips;
  const ok = stableStringify(a) === stableStringify(b) && stableStringify(b) === stableStringify(c);
  return { ok, a, b, c };
}

function evaluateSuite(suite) {
  const checks = [];
  let ok = true;

  if (suite.bridge_ping_status !== 200) {
    checks.push(['Bridge ping', false, `status=${suite.bridge_ping_status}`]);
    ok = false;
  } else checks.push(['Bridge ping', true, '']);

  if (!suite.matriya_ping_ok) {
    checks.push(['MATRIYA ping', false, suite.errors.join('; ')]);
    ok = false;
  } else checks.push(['MATRIYA ping', true, '']);

  if (suite.lab_matriya) {
    const lm = suite.lab_matriya;
    const routingOk =
      lm.routing === 'LAB_BRIDGE_ONLY' &&
      typeof lm.decision_status === 'string' &&
      lm.evidence &&
      typeof lm.evidence === 'object' &&
      Array.isArray(lm.evidence.run_ids) &&
      Array.isArray(lm.external_context) &&
      !('lab_contract' in lm) &&
      !('results' in lm);
    checks.push([
      'P2 Lab composer routing',
      routingOk,
      `routing=${String(lm.routing)} decision_status=${lm.decision_status}`,
    ]);
    ok = ok && routingOk;

    const hallOk =
      lm.evidence &&
      (lm.evidence.data_grade === 'REAL' || lm.evidence.data_grade === 'HISTORICAL_REFERENCE') &&
      typeof lm.answer === 'string' &&
      typeof lm.blocked_reason !== 'undefined' &&
      typeof lm.next_step === 'string';
    checks.push(['P3 Lab composer contract shape', hallOk, '']);
    ok = ok && hallOk;

    const bindOk = Array.isArray(lm.evidence?.run_ids);
    checks.push(['P4 Evidence run_ids', bindOk, JSON.stringify(lm.evidence?.run_ids)]);
    ok = ok && bindOk;

    const detOk = suite.lab_matriya_10_hashes_unique === 1;
    checks.push(['P1 Lab ×10 hash stable', detOk, `unique=${suite.lab_matriya_10_hashes_unique ?? 'n/a'}`]);
    ok = ok && detOk;

    const inv = suite.invalid_lab;
    const invOk =
      inv &&
      inv.decision_status !== 'VALID_CONCLUSION' &&
      typeof inv.blocked_reason === 'string' &&
      inv.blocked_reason.length > 0;
    checks.push(['P3 Invalid lab type', invOk, '']);
    ok = ok && invOk;
  }

  if (suite.document_probe) {
    const dp = suite.document_probe;
    const docRoute =
      dp.routing === 'DOCUMENT_RAG_ONLY' &&
      dp.lab_bridge_invoked === false &&
      dp.document_rag_invoked === true;
    checks.push(['P2 Document routing', docRoute, `routing=${dp.routing}`]);
    ok = ok && docRoute;

    const docDet = suite.document_hashes_10_unique === 1;
    checks.push(['P1 Document retrieval ×10', docDet, `unique=${suite.document_hashes_10_unique ?? 'n/a'}`]);
    ok = ok && docDet;
  }

  const sel = assertSelectionStability(suite);
  checks.push([
    'Selection stability (bridge ×3, DB unchanged)',
    sel.ok,
    `${sel.reason || ''} run_ids: ${JSON.stringify(sel.a)} | ${JSON.stringify(sel.b)} | ${JSON.stringify(sel.c)}`,
  ]);
  ok = ok && sel.ok;

  return { ok, checks };
}

function suiteFingerprint(suite) {
  // Compare only deterministic payload (omit bridge_ping internal noise)
  const fp = {
    lab_matriya: suite.lab_matriya,
    lab_direct_contract: suite.lab_direct_contract,
    selection_triple_run_ids: suite.selection_triple_run_ids,
    lab_matriya_10_first_hash: suite.lab_matriya_10_first_hash,
    lab_matriya_10_hashes_unique: suite.lab_matriya_10_hashes_unique,
    document_hashes_10_unique: suite.document_hashes_10_unique,
    invalid_lab: suite.invalid_lab,
    document_probe: suite.document_probe
      ? {
          routing: suite.document_probe.routing,
          results_count: suite.document_probe.results_count,
          rc: suite.document_probe.results_count,
        }
      : null,
  };
  return stableStringify(fp);
}

async function runDbSensitivity(pool, baselineSuite) {
  const contract = baselineSuite.lab_direct_contract;
  const ids = contract?.source_run_ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    return {
      skipped: true,
      reason: 'No source_run_ids from version_comparison — cannot run DB test',
    };
  }

  const runBId = ids[0];
  const client = await pool.connect();
  let originalState = null;
  let newState = null;

  try {
    const { rows: [row] } = await client.query(
      'SELECT id, workflow_state FROM production_runs WHERE id = $1',
      [runBId]
    );
    if (!row) {
      return { skipped: true, reason: `Run ${runBId} not found in DB` };
    }
    originalState = row.workflow_state;
    if (originalState === 'HISTORICAL') {
      return {
        skipped: true,
        reason:
          'version_b primary run is HISTORICAL — cannot apply workflow_state mutation in this harness. ' +
          'Add a REAL run for 003.2 or run DB test manually.',
      };
    }

    const cycle = {
      APPROVED: 'REVIEWED',
      REVIEWED: 'SUBMITTED',
      SUBMITTED: 'DRAFT',
      DRAFT: 'REVIEWED',
      INGESTED: 'APPROVED',
      LOCKED: 'APPROVED',
    };
    newState = cycle[originalState] || 'REVIEWED';
    if (newState === originalState) newState = 'REVIEWED';

    await client.query('UPDATE production_runs SET workflow_state = $1 WHERE id = $2', [newState, runBId]);

    const { contract: c1 } = await getBridgeVersionComparison();
    const { contract: c2 } = await getBridgeVersionComparison();

    const mutateTwiceOk = stableStringify(c1) === stableStringify(c2);
    const changedFromBaseline = stableStringify(c1) !== stableStringify(contract);

    await client.query('UPDATE production_runs SET workflow_state = $1 WHERE id = $2', [originalState, runBId]);

    const { contract: restored } = await getBridgeVersionComparison();
    const restoreOk = stableStringify(restored) === stableStringify(contract);

    return {
      skipped: false,
      run_id: runBId,
      originalState,
      newState,
      mutateTwiceOk,
      changedFromBaseline,
      restoreOk,
      baseline_contract: contract,
      after_mutate_contract: c1,
      mismatch_notes: {
        mutate_twice_identical: mutateTwiceOk,
        output_reflected_db_change: changedFromBaseline,
        restore_matches_baseline: restoreOk,
      },
    };
  } catch (e) {
    try {
      if (originalState && runBId) {
        await client.query('UPDATE production_runs SET workflow_state = $1 WHERE id = $2', [originalState, runBId]);
      }
    } catch (_) {}
    return { skipped: false, error: e.message, run_id: runBId, originalState, newState };
  } finally {
    try {
      client.release();
    } catch (_) {}
  }
}

async function main() {
  console.log('=== Milestone 1 PASS proof (+ repeatability + selection stability) ===\n');
  if (WITH_DB_SENSITIVITY) console.log('Mode: --db-sensitivity (controlled DB UPDATE with rollback)\n');
  console.log(`MATRIYA_BASE_URL=${MATRIYA}`);
  console.log(`MANAGEMENT_BACK_URL=${MANAGEMENT}\n`);

  const suite1 = await collectDeterministicSuite();

  console.log('=== Selection log — version_comparison source_run_ids (bridge, DB unchanged) ===');
  console.log(JSON.stringify(suite1.lab_direct_contract?.source_run_ids ?? null, null, 2));
  console.log('=== version_b metadata (workflow_state used for DB sensitivity visibility) ===');
  console.log(JSON.stringify(suite1.lab_direct_contract?.source_metadata?.version_b ?? null, null, 2));
  console.log('');

  const suite2 = await collectDeterministicSuite();

  const ev1 = evaluateSuite(suite1);
  let allOk = true;
  for (const [name, ok, d] of ev1.checks) {
    allOk = pass(name, ok, d) && allOk;
  }

  const fp1 = suiteFingerprint(suite1);
  const fp2 = suiteFingerprint(suite2);
  const repeatOk = fp1 === fp2;

  const suiteHash = crypto.createHash('sha256').update(fp1).digest('hex');
  console.log(`SUITE_SHA256=${suiteHash}`);
  console.log(`REPEATABILITY_IDENTICAL=${repeatOk}\n`);

  allOk = pass('Repeatability: two full suite runs produce identical fingerprint', repeatOk, `len=${fp1.length}`) && allOk;

  if (!repeatOk) {
    reportFailure('REPEATABILITY_MISMATCH', {
      selected_run_ids_suite1: suite1.lab_direct_contract?.source_run_ids,
      selected_run_ids_suite2: suite2.lab_direct_contract?.source_run_ids,
      what_changed_in_db: '(none — script did not modify DB between suite1 and suite2)',
      exact_mismatch: 'suiteFingerprint(suite1) !== suiteFingerprint(suite2)',
      diff_lengths: { fp1: fp1.length, fp2: fp2.length },
      first_600_chars_fp1: fp1.slice(0, 600),
      first_600_chars_fp2: fp2.slice(0, 600),
      full_json_suite1: suite1,
      full_json_suite2: suite2,
    });
    console.log('\n=== Overall: FAIL (repeatability) ===');
    process.exit(1);
  }

  // DB sensitivity (optional)
  if (WITH_DB_SENSITIVITY) {
    const conn = process.env.POSTGRES_URL || process.env.DATABASE_URL;
    if (!conn) {
      reportFailure('DB_SENSITIVITY_SKIPPED', {
        reason: 'POSTGRES_URL / DATABASE_URL not set',
      });
      allOk = pass('DB sensitivity', false, 'No POSTGRES_URL') && false;
    } else {
      const pool = new pg.Pool({ connectionString: conn, ssl: { rejectUnauthorized: false } });
      try {
        const dbRes = await runDbSensitivity(pool, suite1);
        if (dbRes.skipped) {
          // No version_comparison rows (empty source_run_ids): cannot mutate — not a logic failure.
          const noRows = String(dbRes.reason || '').includes('source_run_ids');
          if (noRows) {
            console.warn(`[WARN] DB sensitivity skipped (no rows to mutate): ${dbRes.reason}`);
            reportFailure('DB_SENSITIVITY_NOT_APPLICABLE', {
              ...dbRes,
              baseline_contract: suite1.lab_direct_contract,
              note: 'Populate production_runs for BASE-003 versions 003.1 / 003.2 to enable workflow_state mutation test.',
            });
          } else {
            allOk = pass('DB sensitivity (controlled)', false, dbRes.reason) && false;
            reportFailure('DB_SENSITIVITY', { ...dbRes, baseline_contract: suite1.lab_direct_contract });
          }
        } else if (dbRes.error) {
          allOk = pass('DB sensitivity (controlled)', false, dbRes.error) && false;
          reportFailure('DB_SENSITIVITY_ERROR', dbRes);
        } else {
          const subOk = dbRes.mutateTwiceOk && dbRes.changedFromBaseline && dbRes.restoreOk;
          allOk =
            pass(
              'DB sensitivity: mutate → two identical bridge reads; output ≠ baseline; restore = baseline',
              subOk,
              JSON.stringify(dbRes.mismatch_notes)
            ) && allOk;
          if (!subOk) {
            reportFailure('DB_SENSITIVITY_ASSERTION', {
              selected_run_ids: dbRes.baseline_contract?.source_run_ids,
              what_changed_in_db: { run_id: dbRes.run_id, from: dbRes.originalState, to: dbRes.newState, rolled_back: true },
              mutateTwiceOk: dbRes.mutateTwiceOk,
              changedFromBaseline: dbRes.changedFromBaseline,
              restoreOk: dbRes.restoreOk,
              baseline_json: dbRes.baseline_contract,
              after_mutate_json: dbRes.after_mutate_contract,
            });
          }
        }
      } finally {
        await pool.end().catch(() => {});
      }
    }
  } else {
    console.log('[INFO] Run with --db-sensitivity + POSTGRES_URL for controlled DB change test.\n');
  }

  if (!allOk) {
    reportFailure('SUITE_EVALUATION_FAILED', {
      selected_run_ids: suite1.lab_direct_contract?.source_run_ids,
      matriya_evidence_run_ids: suite1.lab_matriya?.evidence?.run_ids,
      what_changed_in_db: WITH_DB_SENSITIVITY ? '(see DB sensitivity section above if run)' : '(script did not apply DB changes)',
      suite1_lab_contract: suite1.lab_direct_contract,
      note: 'Compare SUITE_SHA256 across two shell runs when DB unchanged — must match.',
    });
  }

  console.log(`\n=== Overall: ${allOk ? 'PASS' : 'FAIL'} ===`);
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  reportFailure('UNHANDLED_EXCEPTION', { message: e.message, stack: e.stack });
  process.exit(1);
});
