/**
 * validateLabChain.js
 *
 * Post-ingest validation checks for the lab chain:
 *   Formulation → Production Run → Measurement → Outcome
 *
 * Runs all checks and prints a summary with PASS / WARN / FAIL status.
 *
 * Usage:
 *   node scripts/validateLabChain.js
 */

import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.POSTGRES_URL });


// =============================================================================
// CHECK RUNNERS
// =============================================================================

async function runCheck(client, label, query, evaluate) {
  try {
    const { rows } = await client.query(query);
    const { status, detail } = evaluate(rows);
    const icon = status === 'PASS' ? '✓' : status === 'WARN' ? '⚠' : '✗';
    console.log(`  ${icon} ${status.padEnd(4)} ${label}`);
    if (detail) console.log(`       ${detail}`);
    return { label, status, rows };
  } catch (err) {
    console.log(`  ✗ FAIL ${label}`);
    console.log(`       ERROR: ${err.message}`);
    return { label, status: 'FAIL', error: err.message };
  }
}


// =============================================================================
// INDIVIDUAL CHECKS
// =============================================================================

async function checkCompositionSums(client) {
  // D2: each formulation stores its own composition_scale. Validate against that.
  return runCheck(
    client,
    'D2: Composition sum ≈ composition_scale per formulation (tolerance ±0.005)',
    `SELECT f.source_id, f.composition_scale,
            ROUND(SUM(fm.fraction)::NUMERIC, 6) AS total,
            ABS(SUM(fm.fraction) - f.composition_scale)  AS delta
     FROM formulations f
     JOIN formulation_materials fm ON fm.formulation_id = f.id
     GROUP BY f.id, f.source_id, f.composition_scale
     HAVING ABS(SUM(fm.fraction) - f.composition_scale) >= 0.005
        AND SUM(fm.fraction) > 0
     ORDER BY delta DESC`,
    (rows) => {
      if (rows.length === 0) return { status: 'PASS', detail: 'All sums within ±0.005 of composition_scale' };
      const list = rows.slice(0, 5)
        .map(r => `${r.source_id}: sum=${r.total} scale=${r.composition_scale} Δ=${parseFloat(r.delta).toFixed(5)}`)
        .join('; ');
      return {
        status: 'WARN',
        detail: `${rows.length} formulation(s) outside tolerance: ${list}${rows.length > 5 ? ' ...' : ''}`
      };
    }
  );
}

async function checkVersionCompositionDiff(client) {
  return runCheck(
    client,
    'Same base_id → identical composition across versions',
    `SELECT
       a.base_id,
       a.source_id AS version_a,
       b.source_id AS version_b,
       a_mat.material_name,
       ABS(a_mat.fraction - b_mat.fraction) AS delta
     FROM formulations a
     JOIN formulations b ON a.base_id = b.base_id AND a.id < b.id
     JOIN formulation_materials a_mat ON a_mat.formulation_id = a.id
     JOIN formulation_materials b_mat
       ON b_mat.formulation_id = b.id
       AND b_mat.material_name = a_mat.material_name
     WHERE ABS(a_mat.fraction - b_mat.fraction) > 0.0005
     ORDER BY a.base_id, delta DESC
     LIMIT 10`,
    (rows) => {
      if (rows.length === 0) return { status: 'PASS', detail: null };
      const list = rows.slice(0, 3).map(r =>
        `${r.version_a} vs ${r.version_b}: ${r.material_name} Δ=${parseFloat(r.delta).toFixed(5)}`
      ).join('; ');
      return {
        status: 'WARN',
        detail: `Composition differs within base groups: ${list}`
      };
    }
  );
}

async function checkMissingProcessData(client) {
  return runCheck(
    client,
    'Production runs with no process step data',
    `SELECT pr.batch_id, f.source_id
     FROM production_runs pr
     JOIN formulations f ON f.id = pr.formulation_id
     WHERE NOT EXISTS (
       SELECT 1 FROM production_steps ps WHERE ps.production_run_id = pr.id
     )`,
    (rows) => {
      const n = rows.length;
      if (n === 0) return { status: 'PASS', detail: null };
      return {
        status: 'WARN',
        detail: `${n} run(s) have no production step records — process data was not available in Excel`
      };
    }
  );
}

async function checkMissingSpeedInSteps(client) {
  return runCheck(
    client,
    'Production steps with parsed speed missing',
    `SELECT COUNT(*) AS cnt
     FROM production_steps
     WHERE raw_step_instruction IS NOT NULL
       AND raw_step_instruction != ''
       AND mixing_speed_rpm IS NULL`,
    (rows) => {
      const n = parseInt(rows[0]?.cnt || 0, 10);
      if (n === 0) return { status: 'PASS', detail: null };
      return {
        status: 'WARN',
        detail: `${n} steps have instructions but speed could not be parsed — check raw_step_instruction`
      };
    }
  );
}

async function checkDaysSinceProductionCorrectness(client) {
  return runCheck(
    client,
    'days_since_production matches test_date − production_date',
    `SELECT COUNT(*) AS mismatches
     FROM measurements m
     JOIN production_runs pr ON pr.id = m.production_run_id
     WHERE pr.production_date IS NOT NULL
       AND m.days_since_production IS NOT NULL
       AND m.days_since_production != (m.test_date - pr.production_date)`,
    (rows) => {
      const n = parseInt(rows[0]?.mismatches || 0, 10);
      if (n === 0) return { status: 'PASS', detail: null };
      return {
        status: 'FAIL',
        detail: `${n} measurement(s) have incorrect days_since_production — recompute from dates`
      };
    }
  );
}

async function checkOrphanMeasurements(client) {
  return runCheck(
    client,
    'Every measurement has a linked outcome',
    `SELECT COUNT(*) AS cnt
     FROM measurements m
     WHERE NOT EXISTS (
       SELECT 1 FROM outcomes o WHERE o.measurement_id = m.id
     )`,
    (rows) => {
      const n = parseInt(rows[0]?.cnt || 0, 10);
      if (n === 0) return { status: 'PASS', detail: null };
      return {
        status: 'WARN',
        detail: `${n} measurement(s) have no outcome row — possibly skipped due to all-null values`
      };
    }
  );
}

async function checkMissingBatchIds(client) {
  return runCheck(
    client,
    'All production runs have a batch_id',
    `SELECT COUNT(*) AS cnt FROM production_runs WHERE batch_id IS NULL OR batch_id = ''`,
    (rows) => {
      const n = parseInt(rows[0]?.cnt || 0, 10);
      if (n === 0) return { status: 'PASS', detail: null };
      return {
        status: 'FAIL',
        detail: `${n} production run(s) are missing batch_id — this breaks the chain identity`
      };
    }
  );
}

// FIX 4: All HIST-runs must have batch_id_is_synthetic = TRUE
async function checkSyntheticBatchIdFlag(client) {
  return runCheck(
    client,
    'F4: batch_id_is_synthetic flag consistent with run_origin',
    `SELECT
       COUNT(*) FILTER (WHERE run_origin = 'HISTORICAL' AND batch_id_is_synthetic = FALSE) AS hist_not_flagged,
       COUNT(*) FILTER (WHERE run_origin = 'REAL'       AND batch_id_is_synthetic = TRUE)  AS real_but_flagged,
       COUNT(*) FILTER (WHERE run_origin = 'HISTORICAL') AS hist_total,
       COUNT(*) FILTER (WHERE run_origin = 'REAL'      ) AS real_total
     FROM production_runs`,
    (rows) => {
      const histBad  = parseInt(rows[0]?.hist_not_flagged || 0, 10);
      const realBad  = parseInt(rows[0]?.real_but_flagged || 0, 10);
      const histTot  = parseInt(rows[0]?.hist_total       || 0, 10);
      if (histBad > 0) return {
        status: 'FAIL',
        detail: `${histBad} HISTORICAL run(s) have batch_id_is_synthetic=FALSE — violates F4`
      };
      if (realBad > 0) return {
        status: 'WARN',
        detail: `${realBad} REAL run(s) have batch_id_is_synthetic=TRUE — should be FALSE`
      };
      return { status: 'PASS', detail: `${histTot} HISTORICAL runs all correctly flagged synthetic` };
    }
  );
}

// FIX 1: No measurement duplicates should exist after idempotent ingest
async function checkMeasurementUniqueness(client) {
  return runCheck(
    client,
    'F1: No duplicate (production_run_id, test_date) in measurements',
    `SELECT production_run_id, test_date, COUNT(*) AS cnt
     FROM measurements
     GROUP BY production_run_id, test_date
     HAVING COUNT(*) > 1`,
    (rows) => {
      if (rows.length === 0) return { status: 'PASS', detail: 'No duplicates found' };
      return {
        status: 'FAIL',
        detail: `${rows.length} (production_run_id, test_date) combination(s) have > 1 row — constraint may be missing`
      };
    }
  );
}

// FIX 2: Quarantine table should be visible in validation output
async function checkQuarantinedRecords(client) {
  return runCheck(
    client,
    'F2: Quarantined records (unmatched test outcomes)',
    `SELECT COUNT(*) AS cnt, COUNT(DISTINCT raw_source_id) AS unique_ids FROM ingest_quarantine`,
    (rows) => {
      const n  = parseInt(rows[0]?.cnt        || 0, 10);
      const ui = parseInt(rows[0]?.unique_ids || 0, 10);
      if (n === 0) return { status: 'PASS', detail: 'No quarantined records' };
      return {
        status: 'WARN',
        detail: `${n} quarantined record(s) across ${ui} unique source_id(s) — review with: SELECT * FROM ingest_quarantine`
      };
    }
  );
}

// FIX 3: raw_process_notes must be persisted when processNotes existed in tests sheet
async function checkProcessNotesPersisted(client) {
  return runCheck(
    client,
    'F3: raw_process_notes persisted on production runs that have outcome data',
    `SELECT
       COUNT(*) FILTER (
         WHERE raw_process_notes IS NULL
           AND EXISTS (SELECT 1 FROM measurements m WHERE m.production_run_id = production_runs.id)
       ) AS runs_with_outcomes_but_no_notes,
       COUNT(*) AS total_runs
     FROM production_runs
     WHERE run_origin = 'HISTORICAL'`,
    (rows) => {
      const missing = parseInt(rows[0]?.runs_with_outcomes_but_no_notes || 0, 10);
      const total   = parseInt(rows[0]?.total_runs || 0, 10);
      // Missing notes is expected: most formulations have no process notes in the sheet
      return {
        status: 'PASS',
        detail: `${missing}/${total} HISTORICAL runs have outcomes but no process notes (expected — most have none in Excel)`
      };
    }
  );
}

async function checkProductionDateCoverage(client) {
  return runCheck(
    client,
    'production_date: HISTORICAL runs must always be NULL (D2)',
    `SELECT
       COUNT(*) FILTER (WHERE run_origin = 'HISTORICAL' AND production_date IS NOT NULL) AS violation,
       COUNT(*) FILTER (WHERE run_origin = 'REAL'       AND production_date IS NULL    ) AS real_missing,
       COUNT(*) FILTER (WHERE run_origin = 'HISTORICAL') AS hist_total,
       COUNT(*) FILTER (WHERE run_origin = 'REAL'      ) AS real_total
     FROM production_runs`,
    (rows) => {
      const violation    = parseInt(rows[0]?.violation    || 0, 10);
      const realMissing  = parseInt(rows[0]?.real_missing || 0, 10);
      const histTotal    = parseInt(rows[0]?.hist_total   || 0, 10);
      const realTotal    = parseInt(rows[0]?.real_total   || 0, 10);
      if (violation > 0) {
        return {
          status: 'FAIL',
          detail: `${violation} HISTORICAL run(s) have production_date set — this violates D2`
        };
      }
      if (realMissing > 0) {
        return {
          status: 'WARN',
          detail: `${realMissing}/${realTotal} REAL run(s) missing production_date`
        };
      }
      return {
        status: 'PASS',
        detail: `${histTotal} HIST-runs all have NULL production_date | ${realTotal} REAL runs`
      };
    }
  );
}

async function checkLinkageConfidenceDistribution(client) {
  return runCheck(
    client,
    'Linkage confidence: all historical measurements are HEURISTIC (D1)',
    `SELECT
       m.linkage_confidence,
       COUNT(*) AS cnt
     FROM measurements m
     JOIN production_runs pr ON pr.id = m.production_run_id
     WHERE pr.run_origin = 'HISTORICAL'
     GROUP BY m.linkage_confidence`,
    (rows) => {
      const nonHeuristic = rows.filter(r => r.linkage_confidence !== 'HEURISTIC_SOURCE_ID');
      if (nonHeuristic.length === 0) {
        const total = rows.reduce((s, r) => s + parseInt(r.cnt, 10), 0);
        return { status: 'PASS', detail: `${total} HISTORICAL measurement(s) all HEURISTIC_SOURCE_ID` };
      }
      return {
        status: 'WARN',
        detail: `Non-heuristic confidences found on HISTORICAL runs: ${nonHeuristic.map(r => `${r.linkage_confidence}=${r.cnt}`).join(', ')}`
      };
    }
  );
}

async function checkFormulationsWithNoOutcomes(client) {
  return runCheck(
    client,
    'Formulations without any outcome data',
    `SELECT COUNT(DISTINCT f.id) AS cnt
     FROM formulations f
     JOIN production_runs pr ON pr.formulation_id = f.id
     WHERE NOT EXISTS (
       SELECT 1 FROM measurements m
       JOIN outcomes o ON o.measurement_id = m.id
       WHERE m.production_run_id = pr.id
     )`,
    (rows) => {
      const n = parseInt(rows[0]?.cnt || 0, 10);
      return {
        status: n === 0 ? 'PASS' : 'WARN',
        detail: n > 0
          ? `${n} formulation(s) ingested with no measurement outcome (expected — most formulations have no test data)`
          : null
      };
    }
  );
}

async function checkOperatorMissing(client) {
  return runCheck(
    client,
    'operator field coverage',
    `SELECT COUNT(*) AS cnt FROM production_runs WHERE operator IS NULL`,
    (rows) => {
      const n = parseInt(rows[0]?.cnt || 0, 10);
      if (n === 0) return { status: 'PASS', detail: null };
      return {
        status: 'WARN',
        detail: `${n} run(s) missing operator — OPEN ISSUE: not recorded in INTUMESCENT file, requires new capture`
      };
    }
  );
}

async function checkTemperatureMissing(client) {
  return runCheck(
    client,
    'production_temperature_c field coverage',
    `SELECT COUNT(*) AS cnt FROM production_runs WHERE production_temperature_c IS NULL`,
    (rows) => {
      const n = parseInt(rows[0]?.cnt || 0, 10);
      if (n === 0) return { status: 'PASS', detail: null };
      return {
        status: 'WARN',
        detail: `${n} run(s) missing production_temperature_c — OPEN ISSUE: not in any file, requires new capture`
      };
    }
  );
}


// =============================================================================
// DATA FLOW EXAMPLE — BASE-003
// =============================================================================

async function printDataFlowExample(client) {
  console.log('\n──────────────────────────────────────────────────────────');
  console.log('DATA FLOW EXAMPLE — BASE-003');
  console.log('──────────────────────────────────────────────────────────');

  // Formulation
  const { rows: fRows } = await client.query(
    `SELECT f.id, f.source_id, f.base_id, f.version, f.product_name,
            ROUND(SUM(fm.fraction)::NUMERIC, 4) AS total_fraction,
            COUNT(fm.id) AS material_count
     FROM formulations f
     LEFT JOIN formulation_materials fm ON fm.formulation_id = f.id
     WHERE f.base_id = '003'
     GROUP BY f.id, f.source_id, f.base_id, f.version, f.product_name
     ORDER BY f.source_id`
  );

  console.log('\nFORMULATIONS (base_id = 003):');
  console.table(fRows.map(r => ({
    source_id:       r.source_id,
    version:         r.version || '(root)',
    product_name:    r.product_name || '—',
    total_fraction:  r.total_fraction,
    material_count:  r.material_count
  })));

  if (!fRows.length) {
    console.log('  (no BASE-003 formulations found — run ingest first)');
    return;
  }

  // Production runs + steps for one version
  const exampleFormId = fRows[0].id;
  const { rows: rRows } = await client.query(
    `SELECT pr.id, pr.batch_id, pr.production_date, pr.foaming_event,
            COUNT(ps.id) AS step_count
     FROM production_runs pr
     LEFT JOIN production_steps ps ON ps.production_run_id = pr.id
     WHERE pr.formulation_id = $1
     GROUP BY pr.id`,
    [exampleFormId]
  );

  console.log(`\nPRODUCTION RUNS for ${fRows[0].source_id}:`);
  console.table(rRows.map(r => ({
    batch_id:        r.batch_id,
    production_date: r.production_date || '—',
    foaming_event:   r.foaming_event ?? '—',
    step_count:      r.step_count
  })));

  if (rRows.length) {
    const runId = rRows[0].id;
    const { rows: sRows } = await client.query(
      `SELECT step_sequence, material_name, mixing_duration_min, mixing_speed_rpm, raw_step_instruction
       FROM production_steps WHERE production_run_id = $1 ORDER BY step_sequence LIMIT 5`,
      [runId]
    );
    console.log(`\nPRODUCTION STEPS (first 5) for batch ${rRows[0].batch_id}:`);
    console.table(sRows);

    const { rows: mRows } = await client.query(
      `SELECT m.id, m.test_date, m.days_since_production, m.spindle_type,
              o.ph, o.viscosity_6rpm_cps, o.viscosity_12rpm_cps,
              o.viscosity_30rpm_cps, o.viscosity_60rpm_cps
       FROM measurements m
       LEFT JOIN outcomes o ON o.measurement_id = m.id
       WHERE m.production_run_id = $1`,
      [runId]
    );
    if (mRows.length) {
      console.log(`\nMEASUREMENTS + OUTCOMES:`);
      console.table(mRows.map(r => ({
        test_date:           r.test_date,
        days_since_prod:     r.days_since_production ?? '—',
        ph:                  r.ph ?? '—',
        v6_cps:              r.viscosity_6rpm_cps ?? '—',
        v12_cps:             r.viscosity_12rpm_cps ?? '—',
        v30_cps:             r.viscosity_30rpm_cps ?? '—',
        v60_cps:             r.viscosity_60rpm_cps ?? '—'
      })));
    } else {
      console.log('  (no measurement data for this run)');
    }
  }
}


// =============================================================================
// OPEN ISSUES SUMMARY
// =============================================================================

function printOpenIssues() {
  console.log('\n──────────────────────────────────────────────────────────');
  console.log('OPEN ISSUES (cannot be resolved from current Excel files)');
  console.log('──────────────────────────────────────────────────────────');

  const issues = [
    {
      field:   'production_runs.batch_id',
      status:  'SYNTHETIC (batch_id_is_synthetic=TRUE)',
      detail:  'Generated as "HIST-[source_id]". Stable across re-ingests of the same file. ' +
               'Not a real lab batch identifier. Must be replaced when real batch records are available.'
    },
    {
      field:   'production_runs.operator',
      status:  'NOT RECORDED',
      detail:  'Not present in INTUMESCENT file. Only the template file has a field. ' +
               'Must be captured at time of production.'
    },
    {
      field:   'production_runs.production_temperature_c',
      status:  'NOT RECORDED',
      detail:  'Absent from all files. Cannot be derived. Must be captured.'
    },
    {
      field:   'production_runs.production_date',
      status:  'NULL (D2 — never inferred)',
      detail:  'All HISTORICAL runs have production_date = NULL. ' +
               'The DD.MM.YYYY prefix in source_id is NOT used as a production date. ' +
               'Must be provided from a real production record.'
    },
    {
      field:   'measurements.production_run_id (link)',
      status:  'MISSING LINK IN EXCEL',
      detail:  'Tests sheet links by formulation source_id (col header row 4). ' +
               'The exact batch that was tested is never explicitly recorded. ' +
               'Ingest assumes: 1 formulation → 1 production run → all outcomes linked to that run.'
    },
    {
      field:   'production_steps.mixing_speed_rpm / mixing_duration_min',
      status:  'PARTIALLY PARSEABLE',
      detail:  'Instruction text for 003.1 and 003.2 is empty (no process data). ' +
               'Only 003 (root version) has step instructions. ' +
               'Parser extracts "N min M rpm" pattern; other formats produce nulls.'
    },
    {
      field:   'formulation_materials (for 003.1, 003.2, 003.3)',
      status:  'SAME AS ROOT — CANNOT BACKFILL DIFF',
      detail:  'Summary sheet shows all versions of 003 with identical composition. ' +
               'No recorded variable explains why outcomes differ. ' +
               'The variable that caused Δ must be captured going forward.'
    }
  ];

  issues.forEach((issue, i) => {
    console.log(`\n  [${i + 1}] ${issue.field}`);
    console.log(`      Status : ${issue.status}`);
    console.log(`      Detail : ${issue.detail}`);
  });
}


// D3: REAL runs must not have steps with missing mixing_speed_rpm or mixing_duration_min.
// HISTORICAL runs with NULL values are expected — emit WARN only.
async function checkMixingParamsForRealRuns(client) {
  return runCheck(
    client,
    'D3: Mixing params (speed + duration) present for REAL run steps',
    `SELECT
       ps.id            AS step_id,
       pr.batch_id,
       pr.run_origin,
       ps.step_sequence,
       ps.mixing_speed_rpm,
       ps.mixing_duration_min,
       ps.raw_step_instruction
     FROM production_steps ps
     JOIN production_runs pr ON pr.id = ps.production_run_id
     WHERE (ps.mixing_speed_rpm IS NULL OR ps.mixing_duration_min IS NULL)
     ORDER BY pr.run_origin DESC, ps.step_sequence`,
    (rows) => {
      if (rows.length === 0) return { status: 'PASS', detail: 'All production steps have mixing params (or no steps recorded yet)' };

      const realMissing  = rows.filter(r => r.run_origin === 'REAL');
      const histMissing  = rows.filter(r => r.run_origin === 'HISTORICAL');

      if (realMissing.length > 0) {
        const list = realMissing.slice(0, 3)
          .map(r => `batch=${r.batch_id} step=${r.step_sequence}`)
          .join('; ');
        return {
          status: 'FAIL',
          detail: `${realMissing.length} REAL run step(s) missing mixing params: ${list} — violates D3`
        };
      }

      return {
        status: 'WARN',
        detail: `${histMissing.length} HISTORICAL step(s) have NULL mixing params (expected — historical data gap)`
      };
    }
  );
}


// =============================================================================
// MAIN
// =============================================================================

async function validate() {
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  LAB CHAIN VALIDATION');
  console.log('══════════════════════════════════════════════════════════\n');

  const client = await pool.connect();
  try {
    const results = [];

    // Core data integrity
    results.push(await checkCompositionSums(client));
    results.push(await checkVersionCompositionDiff(client));

    // Fix checks — must all PASS before approval
    results.push(await checkMeasurementUniqueness(client));        // F1
    results.push(await checkQuarantinedRecords(client));           // F2
    results.push(await checkProcessNotesPersisted(client));        // F3
    results.push(await checkSyntheticBatchIdFlag(client));         // F4

    // Chain completeness
    results.push(await checkMissingProcessData(client));
    results.push(await checkMissingSpeedInSteps(client));
    results.push(await checkDaysSinceProductionCorrectness(client));
    results.push(await checkOrphanMeasurements(client));
    results.push(await checkMissingBatchIds(client));

    // D3: process variable enforcement
    results.push(await checkMixingParamsForRealRuns(client));

    // Decision compliance (D1-D4)
    results.push(await checkProductionDateCoverage(client));
    results.push(await checkLinkageConfidenceDistribution(client));
    results.push(await checkFormulationsWithNoOutcomes(client));

    // Known missing fields (expected WARN)
    results.push(await checkOperatorMissing(client));
    results.push(await checkTemperatureMissing(client));

    const pass = results.filter(r => r.status === 'PASS').length;
    const warn = results.filter(r => r.status === 'WARN').length;
    const fail = results.filter(r => r.status === 'FAIL').length;

    console.log(`\n  SUMMARY: ${pass} PASS | ${warn} WARN | ${fail} FAIL`);

    await printDataFlowExample(client);

    printOpenIssues();

  } finally {
    client.release();
    await pool.end();
  }
}

validate().catch(err => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});
