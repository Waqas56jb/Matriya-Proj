#!/usr/bin/env node
/**
 * Idempotent lab-chain seed: BASE-003 formulations 003.1 + 003.2 with REAL runs,
 * measurements, and viscosity outcomes (v6/v12) so version_comparison returns
 * non-empty source_run_ids and a computable delta_summary.
 *
 * Prerequisites (Postgres):
 *   - POSTGRES_URL or DATABASE_URL in env (same as management / matriya lab DB)
 *   - Migrations v2, v3 applied; recommended before first seed:
 *       sql/lab_chain_schema_migration_v4_outcomes_viscosity_columns.sql
 *       sql/lab_chain_schema_migration_v4b_production_steps_order.sql
 *       sql/lab_chain_schema_migration_v4c_outcomes_test_date.sql
 *       sql/lab_chain_schema_migration_v4d_production_runs_batch_size.sql
 *
 * Usage:
 *   node --env-file=.env scripts/seedBase003RealValidation.js
 *   node --env-file=.env scripts/seedBase003RealValidation.js --clean   # remove seed rows only
 */

import 'dotenv/config';
import pg from 'pg';
import crypto from 'crypto';

const SOURCE_FILE = 'DAVID_M2_REAL_DATA_SEED';
const BASE_ID = 'BASE-003';
const V_A = '003.1';
const V_B = '003.2';

const CAPACITY_RATINGS = {
  A: { value: 1, scale: 'raw', unit: 'N/A' },
  D: { value: 1, scale: 'raw', unit: 'N/A' },
  G: { value: 1, scale: 'raw', unit: 'N/A' },
  R: { value: 1, scale: 'raw', unit: 'N/A' },
  T: { value: 1, scale: 'raw', unit: 'N/A' },
};

const CLEAN = process.argv.includes('--clean');

function shortId() {
  return crypto.randomBytes(4).toString('hex');
}

/** Minimal DDL so seed works on older DB snapshots (idempotent). */
async function ensureLabSeedSchema(client) {
  const alters = [
    'ALTER TABLE outcomes ADD COLUMN IF NOT EXISTS v6 INTEGER NULL',
    'ALTER TABLE outcomes ADD COLUMN IF NOT EXISTS v12 INTEGER NULL',
    'ALTER TABLE outcomes ADD COLUMN IF NOT EXISTS v30 INTEGER NULL',
    'ALTER TABLE outcomes ADD COLUMN IF NOT EXISTS v60 INTEGER NULL',
    'ALTER TABLE outcomes ADD COLUMN IF NOT EXISTS test_date DATE NULL',
    'ALTER TABLE measurements ADD COLUMN IF NOT EXISTS raw_test_notes TEXT NULL',
  ];
  for (const sql of alters) {
    try {
      await client.query(sql);
    } catch (_) {}
  }
  const backfills = [
    'UPDATE outcomes SET v6 = COALESCE(v6, viscosity_6rpm_cps) WHERE v6 IS NULL AND viscosity_6rpm_cps IS NOT NULL',
    'UPDATE outcomes SET v12 = COALESCE(v12, viscosity_12rpm_cps) WHERE v12 IS NULL AND viscosity_12rpm_cps IS NOT NULL',
    'UPDATE outcomes SET v30 = COALESCE(v30, viscosity_30rpm_cps) WHERE v30 IS NULL AND viscosity_30rpm_cps IS NOT NULL',
    'UPDATE outcomes SET v60 = COALESCE(v60, viscosity_60rpm_cps) WHERE v60 IS NULL AND viscosity_60rpm_cps IS NOT NULL',
  ];
  for (const sql of backfills) {
    try {
      await client.query(sql);
    } catch (_) {}
  }
}

async function removeSeed(client) {
  const { rows: forms } = await client.query(
    `SELECT id FROM formulations WHERE source_file = $1`,
    [SOURCE_FILE]
  );
  const formIds = forms.map((r) => r.id);
  if (formIds.length === 0) return;

  const { rows: runs } = await client.query(
    `SELECT id FROM production_runs WHERE formulation_id = ANY($1::uuid[])`,
    [formIds]
  );
  const runIds = runs.map((r) => r.id);
  if (runIds.length > 0) {
    // Clear OVAT self-FK and any external pointer to these runs before DELETE
    await client.query(
      `UPDATE production_runs SET baseline_run_id = NULL WHERE baseline_run_id = ANY($1::uuid[])`,
      [runIds]
    );
  }
  for (const { id: rid } of runs) {
    await client.query(`DELETE FROM outcomes WHERE measurement_id IN (
      SELECT id FROM measurements WHERE production_run_id = $1
    )`, [rid]);
    await client.query(`DELETE FROM measurements WHERE production_run_id = $1`, [rid]);
    await client.query(`DELETE FROM production_steps WHERE production_run_id = $1`, [rid]);
    await client.query(`DELETE FROM production_runs WHERE id = $1`, [rid]);
  }
  for (const fid of formIds) {
    await client.query(`DELETE FROM formulation_materials WHERE formulation_id = $1`, [fid]);
    await client.query(`DELETE FROM formulations WHERE id = $1`, [fid]);
  }
}

async function main() {
  const conn = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (!conn) {
    console.error('POSTGRES_URL or DATABASE_URL is required');
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: conn, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    if (CLEAN) {
      await removeSeed(client);
      await client.query('COMMIT');
      console.log('[OK] Removed seed formulations (source_file=%s)', SOURCE_FILE);
      return;
    }

    await removeSeed(client);
    await ensureLabSeedSchema(client);

    const sid1 = `DAVID-SEED-${V_A}`;
    const sid2 = `DAVID-SEED-${V_B}`;

    const { rows: [f1] } = await client.query(
      `INSERT INTO formulations (
        source_id, id_suffix, raw_source_id, base_id, version, product_name,
        source_file, source_sheet, raw_formula_notes, composition_scale
      ) VALUES ($1, NULL, $1, $2, $3, $4, $5, 'seed', 'David M2 real-data validation seed', 2.0)
      RETURNING id`,
      [sid1, BASE_ID, V_A, `Seed ${V_A}`, SOURCE_FILE]
    );

    const { rows: [f2] } = await client.query(
      `INSERT INTO formulations (
        source_id, id_suffix, raw_source_id, base_id, version, product_name,
        source_file, source_sheet, raw_formula_notes, composition_scale
      ) VALUES ($1, NULL, $1, $2, $3, $4, $5, 'seed', 'David M2 real-data validation seed', 2.0)
      RETURNING id`,
      [sid2, BASE_ID, V_B, `Seed ${V_B}`, SOURCE_FILE]
    );

    for (const fid of [f1.id, f2.id]) {
      await client.query(
        `INSERT INTO formulation_materials (formulation_id, material_name, fraction, functional_group, col_index)
         VALUES ($1, 'SeedBinder', 2.0, NULL, 0)`,
        [fid]
      );
    }

    const b1 = `DAVID-B003-${V_A}-${shortId()}`;
    const b2 = `DAVID-B003-${V_B}-${shortId()}`;

    const { rows: [run1] } = await client.query(
      `INSERT INTO production_runs (
        batch_id, batch_id_is_synthetic, formulation_id, production_date,
        operator, run_origin, workflow_state, operator_name, prep_location,
        production_temperature_c, baseline_run_id, declared_changed_variable,
        hypothesis, run_type, load_type, load_conditions
      ) VALUES (
        $1, FALSE, $2, '2026-04-10',
        'Seed', 'REAL', 'APPROVED', 'David Validation', 'Lab',
        25.0, NULL, NULL, NULL, 'REPLICATION', 'THERMAL', NULL
      ) RETURNING id`,
      [b1, f1.id]
    );

    const { rows: [run2] } = await client.query(
      `INSERT INTO production_runs (
        batch_id, batch_id_is_synthetic, formulation_id, production_date,
        operator, run_origin, workflow_state, operator_name, prep_location,
        production_temperature_c, baseline_run_id, declared_changed_variable,
        hypothesis, run_type, load_type, load_conditions
      ) VALUES (
        $1, FALSE, $2, '2026-04-11',
        'Seed', 'REAL', 'APPROVED', 'David Validation', 'Lab',
        25.0, $3, 'mixing_speed_rpm', NULL, 'CONTROLLED_OVAT', 'THERMAL', NULL
      ) RETURNING id`,
      [b2, f2.id, run1.id]
    );

    for (const [rid, rpm] of [[run1.id, 500], [run2.id, 550]]) {
      await client.query(
        `INSERT INTO production_steps (
          production_run_id, step_sequence, material_name,
          mixing_duration_min, mixing_speed_rpm, raw_step_instruction
        ) VALUES ($1, 1, 'SeedBinder', 10, $2, 'seed step')`,
        [rid, rpm]
      );
    }

    const testDate = '2026-04-12';

    const { rows: [m1] } = await client.query(
      `INSERT INTO measurements (
        production_run_id, test_date, days_since_production,
        linkage_confidence
      ) VALUES ($1, $2, 2, 'EXACT') RETURNING id`,
      [run1.id, testDate]
    );

    const { rows: [m2] } = await client.query(
      `INSERT INTO measurements (
        production_run_id, test_date, days_since_production,
        linkage_confidence
      ) VALUES ($1, $2, 1, 'EXACT') RETURNING id`,
      [run2.id, testDate]
    );

    await client.query(
      `INSERT INTO outcomes (
        measurement_id, test_date, ph, v6, v12, v30, v60,
        capacity_ratings, failure_signature, stability_classification,
        mechanism_tag, conclusion_status
      ) VALUES ($1, $2, 7.0, 10000, 9000, 8000, 7000, $3::jsonb,
        'NONE', 'STABLE', NULL, 'INCONCLUSIVE')`,
      [m1.id, testDate, JSON.stringify(CAPACITY_RATINGS)]
    );

    await client.query(
      `INSERT INTO outcomes (
        measurement_id, test_date, ph, v6, v12, v30, v60,
        capacity_ratings, failure_signature, stability_classification,
        mechanism_tag, conclusion_status
      ) VALUES ($1, $2, 7.1, 12000, 9000, 8000, 7000, $3::jsonb,
        'NONE', 'STABLE', NULL, 'VALID_CONCLUSION')`,
      [m2.id, testDate, JSON.stringify(CAPACITY_RATINGS)]
    );

    await client.query('COMMIT');

    console.log('[OK] BASE-003 real validation seed applied.');
    console.log('  formulations:', f1.id, f2.id);
    console.log('  production_runs:', run1.id, '(003.1)', run2.id, '(003.2 baseline→003.1)');
    console.log('  batch_ids:', b1, b2);
    console.log('\nNext: start matriya + lab bridge, then:');
    console.log('  node --env-file=.env scripts/realDataLabValidation.js');
    console.log('  node --env-file=.env scripts/milestone1PassProof.js --db-sensitivity');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[FAIL]', e.message);
    if (/column/.test(e.message) || /does not exist/.test(e.message)) {
      console.error('\nHint: apply sql/lab_chain_schema_migration_v4*.sql files, then retry.');
    }
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
