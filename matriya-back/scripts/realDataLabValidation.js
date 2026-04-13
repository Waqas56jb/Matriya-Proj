#!/usr/bin/env node
/**
 * David parallel real-data check: version_comparison for BASE-003 / 003.1 / 003.2
 * must return non-empty source_run_ids and a viscosity delta with at least one
 * COMPARED channel (finite delta_pct).
 *
 * Prerequisites:
 *   - node --env-file=.env scripts/seedBase003RealValidation.js
 *   - Lab bridge listening on MANAGEMENT_BACK_URL (e.g. 8001)
 *
 * Usage:
 *   node --env-file=.env scripts/realDataLabValidation.js
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import axios from 'axios';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const MANAGEMENT = (process.env.MANAGEMENT_BACK_URL || 'http://127.0.0.1:8001').replace(/\/$/, '');

const PARAMS = {
  type: 'version_comparison',
  base_id: 'BASE-003',
  version_a: '003.1',
  version_b: '003.2',
};

function hasComparedDelta(deltaSummary) {
  if (!deltaSummary || !Array.isArray(deltaSummary.channels)) return false;
  return deltaSummary.channels.some(
    (c) => c.status === 'COMPARED' && c.delta_pct != null && Number.isFinite(c.delta_pct)
  );
}

async function main() {
  const { data, status } = await axios.get(`${MANAGEMENT}/api/lab/query`, {
    params: PARAMS,
    timeout: 60000,
    validateStatus: () => true,
  });

  console.log('HTTP', status);
  console.log(JSON.stringify(data, null, 2));

  if (status !== 200) {
    console.error('\n[FAIL] Non-200 from bridge');
    process.exit(1);
  }

  const ids = data?.source_run_ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    console.error('\n[FAIL] source_run_ids is empty — run seedBase003RealValidation.js against this DB.');
    process.exit(1);
  }

  if (!hasComparedDelta(data.delta_summary)) {
    console.error('\n[FAIL] delta_summary missing COMPARED channel with finite delta_pct.');
    process.exit(1);
  }

  console.log('\n[PASS] Real-data version_comparison: source_run_ids populated and delta computable.');
  process.exit(0);
}

main().catch((e) => {
  const refused =
    e?.code === 'ECONNREFUSED' ||
    e?.cause?.code === 'ECONNREFUSED' ||
    (e?.cause?.errors && e.cause.errors.some((x) => x?.code === 'ECONNREFUSED'));
  if (refused) {
    console.error('\n[FAIL] ECONNREFUSED — nothing is listening on the lab API URL.');
    console.error('Expected:', MANAGEMENT, '(from MANAGEMENT_BACK_URL in matriya-back/.env)');
    console.error('Fix: open a second terminal, cd to matriya-back/managment-back (sibling of inner matriya-back API folder), run npm start');
    console.error('     Default PORT is 8001. Wait until you see "listening" / no exit.');
    console.error(
      'Quick check (PowerShell):',
      `Invoke-WebRequest -UseBasicParsing "${MANAGEMENT}/api/lab/query?type=version_comparison&base_id=BASE-003&version_a=003.1&version_b=003.2"`
    );
  } else {
    console.error(e);
  }
  process.exit(1);
});
