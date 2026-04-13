/**
 * ingestRealRun.js
 *
 * Ingests REAL production runs from a JSON experiment file into the DB.
 * Enforces D3: every step must have mixing_speed_rpm AND mixing_duration_min.
 * Enforces required run fields: production_date, operator, production_temperature_c.
 * Idempotent: re-running the same file does not create duplicates.
 *
 * Usage:
 *   node scripts/ingestRealRun.js experiments/base003_controlled_experiment.json
 *   node scripts/ingestRealRun.js experiments/base003_controlled_experiment.json --dry-run
 *
 * The JSON file must follow the structure in experiments/base003_controlled_experiment.json.
 * Fill in all FILL_IN values before running live.
 */

import fs   from 'fs';
import path from 'path';
import pg   from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;
const isDryRun = process.argv.includes('--dry-run');
const inputFile = process.argv.find(a => a.endsWith('.json'));

if (!inputFile) {
  console.error('Usage: node scripts/ingestRealRun.js <experiment.json> [--dry-run]');
  process.exit(1);
}

const filePath = path.resolve(inputFile);
if (!fs.existsSync(filePath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
const runs = data.runs;

if (!Array.isArray(runs) || runs.length === 0) {
  console.error('No runs found in JSON file. Expected { runs: [...] }');
  process.exit(1);
}

// ── Validation ──────────────────────────────────────────────────────────────

const REQUIRED_RUN_FIELDS = ['formulation_source_id', 'batch_id', 'production_date', 'operator', 'production_temperature_c'];
const FILL_IN_SENTINEL     = /^FILL_IN/i;

function validateRun(run, idx) {
  const errors = [];

  for (const field of REQUIRED_RUN_FIELDS) {
    const val = run[field];
    if (val == null || String(val).match(FILL_IN_SENTINEL)) {
      errors.push(`  run[${idx}] (${run.batch_id ?? '?'}): field "${field}" is missing or not filled in (value: "${val}")`);
    }
  }

  if (run.run_origin !== 'REAL') {
    errors.push(`  run[${idx}] (${run.batch_id}): run_origin must be "REAL". Got: "${run.run_origin}"`);
  }

  if (!Array.isArray(run.steps) || run.steps.length === 0) {
    errors.push(`  run[${idx}] (${run.batch_id}): steps array is empty or missing.`);
  } else {
    for (const step of run.steps) {
      if (step.mixing_speed_rpm == null || String(step.mixing_speed_rpm).match(FILL_IN_SENTINEL)) {
        errors.push(`  run[${idx}] (${run.batch_id}) step ${step.step_sequence}: mixing_speed_rpm is missing. D3 VIOLATION.`);
      }
      if (step.mixing_duration_min == null || String(step.mixing_duration_min).match(FILL_IN_SENTINEL)) {
        errors.push(`  run[${idx}] (${run.batch_id}) step ${step.step_sequence}: mixing_duration_min is missing. D3 VIOLATION.`);
      }
    }
  }

  const m = run.measurement;
  if (!m || !m.test_date || String(m.test_date).match(FILL_IN_SENTINEL)) {
    errors.push(`  run[${idx}] (${run.batch_id}): measurement.test_date is missing or not filled in.`);
  }

  const o = run.outcome;
  if (!o) {
    errors.push(`  run[${idx}] (${run.batch_id}): outcome block is missing.`);
  } else {
    for (const v of ['viscosity_6rpm_cps', 'viscosity_30rpm_cps', 'viscosity_60rpm_cps']) {
      if (o[v] == null || String(o[v]).match(FILL_IN_SENTINEL)) {
        errors.push(`  run[${idx}] (${run.batch_id}): outcome.${v} is missing or not filled in.`);
      }
    }
  }

  return errors;
}

// ── Pre-flight validation (all runs before any DB writes) ────────────────────

console.log('\n═══════════════════════════════════════════════════════════════════');
console.log(`  ingestRealRun.js${isDryRun ? ' [DRY-RUN — no DB writes]' : ''}`);
console.log(`  File: ${filePath}`);
console.log(`  Runs: ${runs.length}`);
console.log('═══════════════════════════════════════════════════════════════════\n');

const allErrors = [];
for (let i = 0; i < runs.length; i++) {
  const errs = validateRun(runs[i], i);
  allErrors.push(...errs);
}

if (allErrors.length > 0) {
  console.error('PRE-FLIGHT VALIDATION FAILED — fix all issues before running:\n');
  for (const e of allErrors) console.error(e);
  console.error(`\n${allErrors.length} error(s) found. Aborting.`);
  process.exit(1);
}

console.log('PRE-FLIGHT: All runs pass validation.\n');

// ── DB helpers ───────────────────────────────────────────────────────────────

async function findFormulation(client, sourceId) {
  const { rows } = await client.query(
    `SELECT id, source_id, base_id, version, product_name
     FROM formulations
     WHERE source_id = $1
     LIMIT 1`,
    [sourceId]
  );
  if (rows.length === 0) return null;
  return rows[0];
}

async function upsertProductionRun(client, run, formulationId) {
  const { rows } = await client.query(
    `INSERT INTO production_runs
       (formulation_id, batch_id, run_origin, batch_id_is_synthetic,
        production_date, operator, production_temperature_c,
        raw_process_notes, foaming_event)
     VALUES ($1,$2,'REAL',FALSE,$3,$4,$5,$6,$7)
     ON CONFLICT (batch_id) DO UPDATE
       SET production_date          = EXCLUDED.production_date,
           operator                 = EXCLUDED.operator,
           production_temperature_c = EXCLUDED.production_temperature_c,
           raw_process_notes        = EXCLUDED.raw_process_notes,
           foaming_event            = EXCLUDED.foaming_event
     RETURNING id`,
    [
      formulationId,
      run.batch_id,
      run.production_date,
      run.operator,
      Number(run.production_temperature_c),
      run.raw_process_notes ?? null,
      run.foaming_event === true
    ]
  );
  return rows[0].id;
}

async function upsertSteps(client, runId, steps) {
  if (!steps.length) return;

  // Delete and re-insert to allow full replacement on re-ingest
  await client.query(
    `DELETE FROM production_steps WHERE production_run_id = $1`,
    [runId]
  );

  const placeholders = [];
  const params = [runId];
  let pi = 2;
  for (const s of steps) {
    placeholders.push(`($1,$${pi},$${pi+1},$${pi+2},$${pi+3},$${pi+4})`);
    params.push(
      s.step_sequence,
      s.material_name ?? null,
      Number(s.mixing_duration_min),
      Number(s.mixing_speed_rpm),
      s.raw_step_instruction ?? null
    );
    pi += 5;
  }

  await client.query(
    `INSERT INTO production_steps
       (production_run_id, step_sequence, material_name,
        mixing_duration_min, mixing_speed_rpm, raw_step_instruction)
     VALUES ${placeholders.join(',')}`,
    params
  );
}

async function upsertMeasurement(client, runId, meas) {
  const { rows } = await client.query(
    `INSERT INTO measurements
       (production_run_id, test_date, days_since_production, linkage_confidence)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (production_run_id, test_date) DO UPDATE
       SET days_since_production = EXCLUDED.days_since_production,
           linkage_confidence    = EXCLUDED.linkage_confidence
     RETURNING id`,
    [
      runId,
      meas.test_date,
      meas.days_since_production != null && !String(meas.days_since_production).match(FILL_IN_SENTINEL)
        ? Number(meas.days_since_production)
        : null,
      meas.linkage_confidence ?? 'REAL_RUN'
    ]
  );
  return rows[0].id;
}

async function upsertOutcome(client, measurementId, o) {
  await client.query(
    `INSERT INTO outcomes
       (measurement_id, ph,
        viscosity_6rpm_cps, viscosity_12rpm_cps,
        viscosity_30rpm_cps, viscosity_60rpm_cps,
        separation_pct, color_delta_e, raw_outcome_notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (measurement_id) DO UPDATE
       SET ph                  = EXCLUDED.ph,
           viscosity_6rpm_cps  = EXCLUDED.viscosity_6rpm_cps,
           viscosity_12rpm_cps = EXCLUDED.viscosity_12rpm_cps,
           viscosity_30rpm_cps = EXCLUDED.viscosity_30rpm_cps,
           viscosity_60rpm_cps = EXCLUDED.viscosity_60rpm_cps,
           separation_pct      = EXCLUDED.separation_pct,
           color_delta_e       = EXCLUDED.color_delta_e,
           raw_outcome_notes   = EXCLUDED.raw_outcome_notes`,
    [
      measurementId,
      o.ph != null && !String(o.ph).match(FILL_IN_SENTINEL) ? Number(o.ph) : null,
      Number(o.viscosity_6rpm_cps),
      o.viscosity_12rpm_cps != null && !String(o.viscosity_12rpm_cps).match(FILL_IN_SENTINEL)
        ? Number(o.viscosity_12rpm_cps) : null,
      Number(o.viscosity_30rpm_cps),
      Number(o.viscosity_60rpm_cps),
      o.separation_pct != null ? Number(o.separation_pct) : null,
      o.color_delta_e  != null ? Number(o.color_delta_e)  : null,
      o.raw_outcome_notes ?? null
    ]
  );
}

// ── Dry-run summary (no DB) ──────────────────────────────────────────────────

if (isDryRun) {
  console.log('DRY-RUN SUMMARY — what would be written to DB:\n');
  for (const run of runs) {
    console.log(`  Batch: ${run.batch_id}`);
    console.log(`    formulation_source_id : ${run.formulation_source_id}`);
    console.log(`    run_origin            : REAL`);
    console.log(`    production_date       : ${run.production_date}`);
    console.log(`    operator              : ${run.operator}`);
    console.log(`    temperature_c         : ${run.production_temperature_c}`);
    console.log(`    steps                 : ${run.steps.length}`);
    for (const s of run.steps) {
      console.log(`      step ${s.step_sequence}: ${(s.material_name ?? '(none)').padEnd(16)}  ${s.mixing_duration_min} min  ${s.mixing_speed_rpm} rpm`);
    }
    console.log(`    test_date             : ${run.measurement.test_date}`);
    console.log(`    v6/v30/v60 (cps)      : ${run.outcome.viscosity_6rpm_cps} / ${run.outcome.viscosity_30rpm_cps} / ${run.outcome.viscosity_60rpm_cps}`);
    console.log();
  }
  console.log('Dry-run complete. No DB writes performed.');
  process.exit(0);
}

// ── Live ingest ──────────────────────────────────────────────────────────────

const pool   = new Pool({ connectionString: process.env.POSTGRES_URL, ssl: { rejectUnauthorized: false } });
const client = await pool.connect();

let ingested = 0;
let failed   = 0;

for (const run of runs) {
  console.log(`\n── Processing: ${run.batch_id} ──────────────────────────────────────`);

  try {
    await client.query('BEGIN');

    const formulation = await findFormulation(client, run.formulation_source_id);
    if (!formulation) {
      throw new Error(`Formulation not found in DB: "${run.formulation_source_id}". Ensure it is ingested first.`);
    }
    console.log(`  ✓ Formulation found: ${formulation.source_id} (base_id=${formulation.base_id}, version=${formulation.version ?? 'root'})`);

    const runId = await upsertProductionRun(client, run, formulation.id);
    console.log(`  ✓ Production run upserted (id=${runId})`);

    await upsertSteps(client, runId, run.steps);
    console.log(`  ✓ ${run.steps.length} production steps written`);

    const measId = await upsertMeasurement(client, runId, run.measurement);
    console.log(`  ✓ Measurement upserted (id=${measId}, date=${run.measurement.test_date})`);

    await upsertOutcome(client, measId, run.outcome);
    console.log(`  ✓ Outcome written (v6=${run.outcome.viscosity_6rpm_cps} cps)`);

    await client.query('COMMIT');
    console.log(`  ✓ COMMITTED`);
    ingested++;

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`  ✗ FAILED: ${err.message}`);
    failed++;
  }
}

client.release();
await pool.end();

console.log('\n═══════════════════════════════════════════════════════════════════');
console.log(`  INGEST COMPLETE`);
console.log(`  Ingested : ${ingested}`);
console.log(`  Failed   : ${failed}`);
if (failed === 0) {
  console.log('\n  Run validateLabChain.js to confirm full chain integrity.');
  console.log('  Run analyzeBase003.js to compare results with historical data.');
}
console.log('═══════════════════════════════════════════════════════════════════\n');
