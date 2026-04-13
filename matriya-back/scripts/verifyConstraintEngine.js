#!/usr/bin/env node
/**
 * Constraint engine harness — rules count, latency, golden fixtures.
 */
import assert from 'assert';
import { evaluate, getRuleCount } from '../services/eliminationLogic.js';

const n = getRuleCount();
assert.ok(n >= 3, `expected at least 3 rules, got ${n}`);

const times = [];
for (let i = 0; i < 200; i++) {
  const t0 = Date.now();
  evaluate({ material_conditions: { temperature_c: 50, ph: 7, relative_humidity_pct: 40, hygroscopic_filler: false } });
  times.push(Date.now() - t0);
}
times.sort((a, b) => a - b);
const median = times[Math.floor(times.length / 2)];
assert.ok(median < 100, `expected median evaluate() < 100ms, got ${median}ms`);

const hot = evaluate({ material_conditions: { temperature_c: 200, ph: 7, relative_humidity_pct: 40, hygroscopic_filler: false } });
assert.strictEqual(hot.eliminated, true, 'high temp should eliminate');

const ok = evaluate({
  material_conditions: { temperature_c: 80, ph: 7, relative_humidity_pct: 50, hygroscopic_filler: false },
});
assert.strictEqual(ok.eliminated, false, 'benign conditions should not eliminate');

const fixtures = [
  { in: { temperature_c: 200 }, out: true },
  { in: { relative_humidity_pct: 90, hygroscopic_filler: true }, out: true },
  { in: { ph: 3 }, out: true },
  { in: { ph: 12 }, out: true },
  { in: { temperature_c: 80, ph: 7, relative_humidity_pct: 50, hygroscopic_filler: false }, out: false },
  { in: { target_particle_d90_um: 3, max_shear_rate_s1: 100 }, out: false },
];
let match = 0;
for (const f of fixtures) {
  const r = evaluate({ material_conditions: f.in });
  if (Boolean(r.eliminated) === f.out) match++;
}
const rate = match / fixtures.length;
assert.ok(rate >= 0.66, `expected >=66% fixture match, got ${(rate * 100).toFixed(0)}%`);

console.log('[PASS] verifyConstraintEngine.js', { rules: n, median_ms: median, fixture_match_pct: (rate * 100).toFixed(0) });
