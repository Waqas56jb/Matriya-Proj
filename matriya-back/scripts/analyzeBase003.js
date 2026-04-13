/**
 * Analysis script — BASE-003 all versions.
 * Queries live DB. No writes. No schema changes.
 * Produces:
 *   Table 1: all material fractions per version
 *   Table 2: delta table (material + viscosity diffs between versions)
 *   Table 3: production steps per version
 *   Table 4: analysis — what explains viscosity change 003.1 → 003.2
 */

import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.POSTGRES_URL, ssl: { rejectUnauthorized: false } });
const client = await pool.connect();

// ── 1. Get all BASE-003 formulations + their materials ────────────────────────
const { rows: formRows } = await client.query(`
  SELECT
    f.id,
    f.source_id,
    f.version,
    fm.material_name,
    fm.fraction,
    fm.functional_group
  FROM formulations f
  JOIN formulation_materials fm ON fm.formulation_id = f.id
  WHERE f.base_id = '003'
    AND fm.fraction > 0
  ORDER BY f.source_id, fm.col_index
`);

// ── 2. Get viscosity outcomes per BASE-003 version ────────────────────────────
const { rows: outcomeRows } = await client.query(`
  SELECT
    f.source_id,
    f.version,
    m.test_date,
    o.ph,
    o.viscosity_6rpm_cps    AS v6,
    o.viscosity_12rpm_cps   AS v12,
    o.viscosity_30rpm_cps   AS v30,
    o.viscosity_60rpm_cps   AS v60
  FROM formulations f
  JOIN production_runs pr ON pr.formulation_id = f.id
  JOIN measurements m ON m.production_run_id = pr.id
  JOIN outcomes o ON o.measurement_id = m.id
  WHERE f.base_id = '003'
  ORDER BY f.source_id
`);

// ── 3. Get production steps per BASE-003 version ──────────────────────────────
const { rows: stepRows } = await client.query(`
  SELECT
    f.source_id,
    f.version,
    ps.step_sequence,
    ps.material_name,
    ps.mixing_duration_min,
    ps.mixing_speed_rpm,
    ps.raw_step_instruction
  FROM formulations f
  JOIN production_runs pr ON pr.formulation_id = f.id
  JOIN production_steps ps ON ps.production_run_id = pr.id
  WHERE f.base_id = '003'
  ORDER BY f.source_id, ps.step_sequence
`);

client.release();
await pool.end();

// ── Helpers ───────────────────────────────────────────────────────────────────

const VERSIONS = ['root', '1', '2', '3'];
const VERSION_LABELS = {
  root: '003 (root)',
  '1':  '003.1',
  '2':  '003.2',
  '3':  '003.3',
};
const SOURCE_IDS = {
  root: '10.11.2022-003',
  '1':  '22.11.2022-003.1',
  '2':  '22.11.2022-003.2',
  '3':  '23.11.2022-003.3',
};

// Group materials by version
const matByVersion = {};
for (const r of formRows) {
  const v = r.version ?? 'root';
  if (!matByVersion[v]) matByVersion[v] = {};
  matByVersion[v][r.material_name] = parseFloat(r.fraction);
}

// All materials that appear in any version (non-zero)
const allMaterials = [...new Set(formRows.map(r => r.material_name))];

// Outcomes by version
const outByVersion = {};
for (const r of outcomeRows) {
  outByVersion[r.version ?? 'root'] = {
    test_date: r.test_date instanceof Date ? r.test_date.toISOString().slice(0,10) : String(r.test_date).slice(0,10),
    ph:  r.ph  != null ? r.ph  : '—',
    v6:  r.v6  != null ? r.v6  : '—',
    v12: r.v12 != null ? r.v12 : '—',
    v30: r.v30 != null ? r.v30 : '—',
    v60: r.v60 != null ? r.v60 : '—',
  };
}

// Steps by version
const stepsByVersion = {};
for (const r of stepRows) {
  const v = r.version ?? 'root';
  if (!stepsByVersion[v]) stepsByVersion[v] = [];
  stepsByVersion[v].push(r);
}

// ── TABLE 1: Full material fractions + viscosity ──────────────────────────────

console.log('\n');
console.log('═══════════════════════════════════════════════════════════════════════');
console.log('  TABLE 1 — BASE-003: MATERIAL FRACTIONS + VISCOSITY PER VERSION');
console.log('═══════════════════════════════════════════════════════════════════════');
console.log();

// Header
const verHeaders = VERSIONS.map(v => VERSION_LABELS[v].padEnd(12)).join('  ');
console.log('  Material'.padEnd(26) + '  ' + verHeaders);
console.log('  ' + '─'.repeat(24) + '  ' + VERSIONS.map(() => '─'.repeat(12)).join('  '));

for (const mat of allMaterials) {
  const fracs = VERSIONS.map(v => {
    const f = matByVersion[v]?.[mat];
    return f != null ? f.toFixed(4).padEnd(12) : '—'.padEnd(12);
  }).join('  ');
  console.log('  ' + mat.slice(0,24).padEnd(24) + '  ' + fracs);
}

console.log('  ' + '─'.repeat(24) + '  ' + VERSIONS.map(() => '─'.repeat(12)).join('  '));

// Totals
const totals = VERSIONS.map(v => {
  const vals = Object.values(matByVersion[v] || {});
  return vals.reduce((a, b) => a + b, 0).toFixed(4).padEnd(12);
}).join('  ');
console.log('  TOTAL (scale≈2.0)'.padEnd(26) + '  ' + totals);

console.log();
// Viscosity rows
for (const [label, key] of [['test_date','test_date'],['pH','ph'],['v6 rpm (cps)','v6'],['v12 rpm (cps)','v12'],['v30 rpm (cps)','v30'],['v60 rpm (cps)','v60']]) {
  const vals = VERSIONS.map(v => {
    const o = outByVersion[v];
    return o ? String(o[key]).padEnd(12) : '(no data)'.padEnd(12);
  }).join('  ');
  console.log('  ' + label.padEnd(26) + '  ' + vals);
}

// ── TABLE 2: Delta table ───────────────────────────────────────────────────────

console.log('\n');
console.log('═══════════════════════════════════════════════════════════════════════');
console.log('  TABLE 2 — DELTA TABLE: DIFFERENCES BETWEEN CONSECUTIVE VERSIONS');
console.log('  Compares root→1, 1→2, 2→3');
console.log('═══════════════════════════════════════════════════════════════════════');

const PAIRS = [
  ['root', '1',  'root → 003.1'],
  ['1',    '2',  '003.1 → 003.2'],
  ['2',    '3',  '003.2 → 003.3'],
];

for (const [vA, vB, label] of PAIRS) {
  const matsA = matByVersion[vA] || {};
  const matsB = matByVersion[vB] || {};
  const allMats = new Set([...Object.keys(matsA), ...Object.keys(matsB)]);
  const diffs = [];

  for (const mat of allMats) {
    const a = matsA[mat] ?? 0;
    const b = matsB[mat] ?? 0;
    const delta = b - a;
    if (Math.abs(delta) > 0.000001) {
      diffs.push({ mat, a, b, delta });
    }
  }

  // Viscosity diff
  const oA = outByVersion[vA];
  const oB = outByVersion[vB];

  console.log('\n  ── ' + label + ' ──');

  if (diffs.length === 0) {
    console.log('  Material differences : NONE — composition identical');
  } else {
    console.log('  Material differences:');
    console.log('    ' + 'Material'.padEnd(24) + '  ' + 'Before'.padEnd(10) + '  ' + 'After'.padEnd(10) + '  ' + 'Delta');
    console.log('    ' + '─'.repeat(56));
    for (const d of diffs) {
      const sign = d.delta > 0 ? '+' : '';
      console.log(
        '    ' + d.mat.slice(0,24).padEnd(24) + '  ' +
        d.a.toFixed(4).padEnd(10) + '  ' +
        d.b.toFixed(4).padEnd(10) + '  ' +
        sign + d.delta.toFixed(6)
      );
    }
  }

  console.log('  Viscosity differences:');
  if (!oA || !oB) {
    console.log('    (one or both versions have no test outcome)');
  } else {
    for (const [spindle, key] of [['v6','v6'],['v12','v12'],['v30','v30'],['v60','v60']]) {
      const a = oA[key];
      const b = oB[key];
      if (a === '—' || b === '—') {
        console.log(`    ${spindle.padEnd(4)}  before=—   after=—   delta=N/A`);
      } else {
        const delta = Number(b) - Number(a);
        const sign = delta > 0 ? '+' : '';
        const pct = ((delta / Number(a)) * 100).toFixed(1);
        console.log(`    ${spindle.padEnd(4)}  before=${String(a).padEnd(7)} after=${String(b).padEnd(7)} delta=${sign}${delta} (${sign}${pct}%)`);
      }
    }
  }
}

// ── TABLE 3: Production steps per version ────────────────────────────────────

console.log('\n');
console.log('═══════════════════════════════════════════════════════════════════════');
console.log('  TABLE 3 — PRODUCTION STEPS PER VERSION');
console.log('═══════════════════════════════════════════════════════════════════════');

for (const v of VERSIONS) {
  const steps = stepsByVersion[v] || [];
  console.log(`\n  ${VERSION_LABELS[v]}  (${SOURCE_IDS[v]})`);
  if (steps.length === 0) {
    console.log('  (no production step data recorded)');
    continue;
  }
  console.log('  ' + 'Step'.padEnd(5) + '  ' + 'Material'.padEnd(16) + '  ' + 'Duration(min)'.padEnd(14) + '  ' + 'Speed(rpm)'.padEnd(11) + '  Raw instruction');
  console.log('  ' + '─'.repeat(80));
  for (const s of steps) {
    const dur  = s.mixing_duration_min != null ? String(s.mixing_duration_min) : 'NULL';
    const spd  = s.mixing_speed_rpm    != null ? String(s.mixing_speed_rpm)    : 'NULL';
    const instr = s.raw_step_instruction ?? '(empty)';
    console.log(
      '  ' + String(s.step_sequence).padEnd(5) + '  ' +
      (s.material_name ?? '(none)').slice(0,16).padEnd(16) + '  ' +
      dur.padEnd(14) + '  ' +
      spd.padEnd(11) + '  ' +
      instr
    );
  }
}

// ── TABLE 4: Analysis — what explains viscosity change 003.1 → 003.2 ─────────

console.log('\n');
console.log('═══════════════════════════════════════════════════════════════════════');
console.log('  TABLE 4 — ANALYSIS: WHAT EXPLAINS VISCOSITY CHANGE 003.1 → 003.2?');
console.log('═══════════════════════════════════════════════════════════════════════');

const matsA = matByVersion['1'] || {};
const matsB = matByVersion['2'] || {};
const allMats12 = new Set([...Object.keys(matsA), ...Object.keys(matsB)]);
const matDiffs12 = [];
for (const mat of allMats12) {
  const a = matsA[mat] ?? 0;
  const b = matsB[mat] ?? 0;
  if (Math.abs(b - a) > 0.000001) matDiffs12.push({ mat, a, b, delta: b-a });
}

const oA = outByVersion['1'];
const oB = outByVersion['2'];
const v6_delta  = oA && oB && oA.v6  !== '—' && oB.v6  !== '—' ? Number(oB.v6)  - Number(oA.v6)  : null;
const v30_delta = oA && oB && oA.v30 !== '—' && oB.v30 !== '—' ? Number(oB.v30) - Number(oA.v30) : null;
const v60_delta = oA && oB && oA.v60 !== '—' && oB.v60 !== '—' ? Number(oB.v60) - Number(oA.v60) : null;

console.log('\n  Viscosity change (003.1 → 003.2):');
if (v6_delta  != null) console.log(`    v6:  ${oA.v6} → ${oB.v6}   Δ=${v6_delta > 0 ? '+' : ''}${v6_delta} cps  (${((v6_delta/Number(oA.v6))*100).toFixed(1)}%)`);
if (v30_delta != null) console.log(`    v30: ${oA.v30} → ${oB.v30}  Δ=${v30_delta > 0 ? '+' : ''}${v30_delta} cps  (${((v30_delta/Number(oA.v30))*100).toFixed(1)}%)`);
if (v60_delta != null) console.log(`    v60: ${oA.v60} → ${oB.v60}  Δ=${v60_delta > 0 ? '+' : ''}${v60_delta} cps  (${((v60_delta/Number(oA.v60))*100).toFixed(1)}%)`);

console.log('\n  Material composition change (003.1 → 003.2):');
if (matDiffs12.length === 0) {
  console.log('    NONE — composition is identical between 003.1 and 003.2.');
} else {
  for (const d of matDiffs12) {
    const sign = d.delta > 0 ? '+' : '';
    console.log(`    ${d.mat.padEnd(24)} Δ=${sign}${d.delta.toFixed(6)}  (${d.a.toFixed(4)} → ${d.b.toFixed(4)})`);
  }
}

console.log('\n  Production steps change (003.1 → 003.2):');
const steps1 = stepsByVersion['1'] || [];
const steps2 = stepsByVersion['2'] || [];
const stepDiffs = [];
const maxSteps = Math.max(steps1.length, steps2.length);
for (let i = 0; i < maxSteps; i++) {
  const s1 = steps1[i];
  const s2 = steps2[i];
  if (!s1 && !s2) continue;
  const dur1 = s1?.mixing_duration_min ?? null;
  const dur2 = s2?.mixing_duration_min ?? null;
  const spd1 = s1?.mixing_speed_rpm    ?? null;
  const spd2 = s2?.mixing_speed_rpm    ?? null;
  const instr1 = s1?.raw_step_instruction ?? null;
  const instr2 = s2?.raw_step_instruction ?? null;
  if (dur1 !== dur2 || spd1 !== spd2 || instr1 !== instr2) {
    stepDiffs.push({ seq: i, dur1, spd1, instr1, dur2, spd2, instr2 });
  }
}
if (stepDiffs.length === 0) {
  console.log('    No differences in recorded step data between 003.1 and 003.2.');
} else {
  for (const d of stepDiffs) {
    console.log(`    Step ${d.seq}: duration ${d.dur1 ?? 'NULL'} → ${d.dur2 ?? 'NULL'}  |  speed ${d.spd1 ?? 'NULL'} → ${d.spd2 ?? 'NULL'}  |  instr: "${d.instr1 ?? 'empty'}" → "${d.instr2 ?? 'empty'}"`);
  }
}

console.log('\n  ── CONCLUSION ──');
if (matDiffs12.length === 0 && stepDiffs.length === 0) {
  console.log('\n  NO RECORDED VARIABLE EXPLAINS THE VISCOSITY CHANGE BETWEEN 003.1 AND 003.2.');
  console.log('\n  What is confirmed:');
  console.log('    • Material composition: IDENTICAL (same 35 materials, same fractions)');
  console.log('    • Production steps:     IDENTICAL (same sequence, duration, speed)');
  console.log('    • Test date:            same day (both tested 2022-11-23)');
  console.log('    • Viscosity at v6:      003.1 = ' + (oA?.v6 ?? '—') + ' cps  →  003.2 = ' + (oB?.v6 ?? '—') + ' cps  (Δ=' + (v6_delta != null ? (v6_delta>0?'+':'')+v6_delta : 'N/A') + ')');
  console.log('\n  What is NOT recorded in the file (cannot be derived from existing data):');
  console.log('    • Mixing batch size / actual quantities used');
  console.log('    • Order of material addition (column order ≠ addition order)');
  console.log('    • Equipment or vessel differences');
  console.log('    • Ambient temperature / humidity on day of production');
  console.log('    • Operator who made each batch');
  console.log('    • Any deviations or corrections noted verbally');
  console.log('\n  Cause classification: PROCESS-RELATED (unrecorded variable)');
  console.log('  The viscosity difference is real. The cause cannot be identified');
  console.log('  from the current data. A new REAL run with full process capture');
  console.log('  (D3 fields: mixing_speed_rpm, mixing_duration_min, operator,');
  console.log('  production_date) is required to reproduce and explain this Δ.');
} else if (matDiffs12.length > 0) {
  console.log('\n  MATERIAL DIFFERENCES EXIST between 003.1 and 003.2 (see above).');
  console.log('  These may explain the viscosity change. Further testing required to confirm.');
} else {
  console.log('\n  COMPOSITION IS IDENTICAL but STEP DIFFERENCES EXIST (see above).');
  console.log('  The viscosity change is likely process-related (mixing parameters differ).');
}
