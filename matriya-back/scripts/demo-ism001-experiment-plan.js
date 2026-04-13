#!/usr/bin/env node
/**
 * David deliverable: ISM-001 — Rule → Experiment plan (sample output).
 * Run: npm run demo:ism001-experiment-plan
 */
import { experimentPlanFromRule, formatExperimentPlanText } from '../services/ruleToExperimentPlan.js';

const plan = experimentPlanFromRule('ISM-001');
console.log('--- JSON (sample) ---');
console.log(JSON.stringify(plan, null, 2));
console.log('\n--- Text (sample) ---');
console.log(formatExperimentPlanText(plan));
