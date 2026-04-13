# MATRIYA – Constraint Engine (v2)

Scientific decision stack (overview): **Lab data → Constraint engine → Decision engine → … → UI**

This document describes the **constraint** slice only: **physics-style elimination**, no suppliers, no database.

## Endpoint (matriya-back)

- **POST** `/api/constraint/evaluate`
- **Body:** JSON with **`material_conditions`** (object) or a flat object of numeric/boolean fields referenced by rules.
- **Response:**

```json
{
  "eliminated": false,
  "reasoning": ["…"],
  "observable_expectations": ["…"],
  "rules_evaluated": 5
}
```

- **`rules_evaluated`** is included so harnesses can verify ≥3 rules are loaded (file ships with 5 rules).

## Rule file

- **`data/elimination_rules.json`** — declarative `rules[]` with `when` clauses (`field` / `op` / `value`, or `all` / `any`).

## Core function (server-side)

- **`services/eliminationLogic.js`** — `evaluate(input)` → `{ eliminated, reasoning, observable_expectations, rules_evaluated }`

## PASS criteria (local harness)

Run:

```bash
node scripts/verifyConstraintEngine.js
```

Checks: rule count ≥ 3, median evaluation time &lt; 100ms over repeated calls, golden fixtures meet expected `eliminated` flags.

## Principles

- **Constraint** = eliminate what cannot work (no scoring suppliers).
- **No DB** for this endpoint — rules are file-backed only.
- **Decision** from lab/composer remains separate; constraint evaluation does not mutate lab state.

---

## ISM-001 — Rule → Experiment plan (Constraint → next experiments)

**Goal (David):** One rule drives recommended experiments, measurement methods (from Test_Protocol), and expected failure pattern — file-backed; **lab flow** surfaces matches via Answer Composer only (does not change `decision_status`).

| Item | Location |
|------|-----------|
| Rule data (Observable_Map + Test_Protocol + experiments) | `data/ism001_experiment_plan.json` |
| Pure function | `services/ruleToExperimentPlan.js` — `experimentPlanFromRule('ISM-001')`, `formatExperimentPlanText(plan)` |
| Lab match + API field | `services/labConstraintRules.js` — `evaluateConstraintRulesForLab(lab)`; merged into `composeAnswer` as **`constraint_rules`** (array; empty when no rule matches) |
| Sample output (terminal) | `npm run demo:ism001-experiment-plan` |
| Verification (plan file) | `npm run verify:ism001-experiment-plan` |
| Verification (lab trigger) | `npm run verify:lab-constraint-rules` |
