/**
 * Constraint engine — elimination-only evaluation (no DB, no suppliers).
 * Rules loaded from data/elimination_rules.json
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RULES_PATH = join(__dirname, '..', 'data', 'elimination_rules.json');

let _cache = null;

function loadRules() {
  if (_cache) return _cache;
  const raw = readFileSync(RULES_PATH, 'utf8');
  const doc = JSON.parse(raw);
  const rules = Array.isArray(doc.rules) ? doc.rules : [];
  _cache = { doc, rules };
  return _cache;
}

function getField(obj, path) {
  if (!path) return undefined;
  const parts = String(path).split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

function cmp(op, left, right) {
  switch (op) {
    case '>':
      return left > right;
    case '>=':
      return left >= right;
    case '<':
      return left < right;
    case '<=':
      return left <= right;
    case '==':
    case 'eq':
      return left === right;
    case '!=':
    case 'ne':
      return left !== right;
    default:
      return false;
  }
}

function evalClause(ctx, clause) {
  if (!clause || typeof clause !== 'object') return false;
  if (clause.all && Array.isArray(clause.all)) {
    return clause.all.every((c) => evalClause(ctx, c));
  }
  if (clause.any && Array.isArray(clause.any)) {
    return clause.any.some((c) => evalClause(ctx, c));
  }
  const field = clause.field;
  const op = clause.op || '==';
  const value = clause.value;
  const got = getField(ctx, field);
  if (got === undefined || got === null) return false;
  if (typeof value === 'number' && typeof got !== 'number') {
    const n = Number(got);
    if (!Number.isFinite(n)) return false;
    return cmp(op, n, value);
  }
  if (typeof value === 'boolean') {
    return Boolean(got) === value;
  }
  return cmp(op, got, value);
}

/**
 * @param {object} input — may be `{ material_conditions: { ... } }` or flat conditions object
 * @returns {{ eliminated: boolean, reasoning: string[], observable_expectations: string[], rules_evaluated: number }}
 */
export function evaluate(input) {
  const { rules } = loadRules();
  const body = input && typeof input === 'object' ? input : {};
  const ctx =
    body.material_conditions && typeof body.material_conditions === 'object'
      ? { ...body.material_conditions }
      : { ...body };

  const reasoning = [];
  const observable_expectations = [];
  let eliminated = false;

  for (const rule of rules) {
    if (!rule || !rule.when) continue;
    if (!evalClause(ctx, rule.when)) continue;
    if (rule.reasoning) reasoning.push(String(rule.reasoning));
    if (Array.isArray(rule.observable_expectations)) {
      for (const o of rule.observable_expectations) {
        if (typeof o === 'string' && o.trim()) observable_expectations.push(o.trim());
      }
    }
    if (rule.eliminates === true) eliminated = true;
  }

  return {
    eliminated,
    reasoning,
    observable_expectations,
    rules_evaluated: rules.length,
  };
}

export function getRuleCount() {
  return loadRules().rules.length;
}
