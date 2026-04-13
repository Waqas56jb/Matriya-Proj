#!/usr/bin/env node
/**
 * Milestone 2 — real-data gate (David sequence, single command).
 *
 * Runs in order:
 *   1. scripts/seedBase003RealValidation.js  (POSTGRES_URL / DATABASE_URL)
 *   2. scripts/realDataLabValidation.js       (MANAGEMENT_BACK_URL — lab bridge)
 *   3. scripts/milestone1PassProof.js --db-sensitivity
 *      (MATRIYA_BASE_URL + MANAGEMENT_BACK_URL + POSTGRES_URL)
 *
 * Prerequisites:
 *   - .env with POSTGRES_URL (same DB as bridge)
 *   - Before steps 2–3: matriya-back + lab bridge listening
 *
 * Usage:
 *   node --env-file=.env scripts/milestone2RealDataGate.js
 *   node --env-file=.env scripts/milestone2RealDataGate.js --skip-seed
 */

import 'dotenv/config';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SKIP_SEED = process.argv.includes('--skip-seed');

function runStep(name, args) {
  console.log(`\n${'='.repeat(72)}\n${name}\n${'='.repeat(72)}\n`);
  const r = spawnSync(process.execPath, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
    shell: false,
  });
  if (r.status !== 0) {
    console.error(`\n[FAIL] ${name} exited with code ${r.status ?? r.signal}\n`);
    process.exit(r.status ?? 1);
  }
}

function main() {
  const envFile = path.join(ROOT, '.env');
  const nodeArgsBase = fs.existsSync(envFile) ? ['--env-file=' + envFile] : [];
  if (!fs.existsSync(envFile)) {
    console.warn('[WARN] .env not found at repo root; child processes use current environment only.\n');
  }

  if (!process.env.POSTGRES_URL && !process.env.DATABASE_URL) {
    console.error('POSTGRES_URL or DATABASE_URL must be set (e.g. via --env-file=.env)');
    process.exit(1);
  }

  if (!SKIP_SEED) {
    runStep('Step 1/3 — BASE-003 seed (003.1 + 003.2 REAL)', [
      ...nodeArgsBase,
      path.join(ROOT, 'scripts', 'seedBase003RealValidation.js'),
    ]);
  } else {
    console.log('\n[INFO] --skip-seed: not running seedBase003RealValidation.js\n');
  }

  if (!process.env.MANAGEMENT_BACK_URL) {
    process.env.MANAGEMENT_BACK_URL = 'http://127.0.0.1:8001';
  }

  runStep('Step 2/3 — realDataLabValidation.js (non-empty source_run_ids + delta)', [
    ...nodeArgsBase,
    path.join(ROOT, 'scripts', 'realDataLabValidation.js'),
  ]);

  if (!process.env.MATRIYA_BASE_URL) {
    process.env.MATRIYA_BASE_URL = 'http://127.0.0.1:8000';
  }

  runStep('Step 3/3 — milestone1PassProof.js --db-sensitivity (full suite + DB)', [
    ...nodeArgsBase,
    path.join(ROOT, 'scripts', 'milestone1PassProof.js'),
    '--db-sensitivity',
  ]);

  console.log(`\n${'='.repeat(72)}\n[PASS] Milestone 2 real-data gate — all three steps succeeded.\n${'='.repeat(72)}\n`);
}

main();
