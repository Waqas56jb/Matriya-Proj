#!/usr/bin/env node
/**
 * David isolation mandate: External Layer must not appear in scientific decision paths.
 * Violation = exit 1 (treat as SYSTEM ERROR in CI), not a warning.
 *
 * Scans selected modules for references to external_ctx pool/router or /api/external.
 * server.js is checked separately (exactly one mount + import allowed).
 *
 * Usage: node scripts/verifyExternalLayerIsolation.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const BANNED = /external_ctx|getExternalLayerPool|externalLayerRouter|\/api\/external\/v1/;

const FILES_MUST_NOT_REFERENCE = [
  'researchGate.js',
  'researchLoop.js',
  'stateMachine.js',
  'kernelV16.js',
  'database.js',
  'integrityMonitor.js',
  'ragService.js',
  path.join('lib', 'matriyaLabBridgeFlow.js'),
  path.join('lib', 'answerAttribution.js'),
  path.join('lib', 'answerSourceBindingFilter.js'),
  path.join('..', 'managment-back', 'server.js'),
];

function read(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

function main() {
  const violations = [];

  for (const rel of FILES_MUST_NOT_REFERENCE) {
    const text = read(rel);
    if (text == null) continue;
    if (BANNED.test(text)) {
      violations.push(rel);
    }
  }

  // lib/*.js except externalLayer*
  const libDir = path.join(ROOT, 'lib');
  if (fs.existsSync(libDir)) {
    for (const name of fs.readdirSync(libDir)) {
      if (!name.endsWith('.js')) continue;
      if (name.startsWith('externalLayer')) continue;
      const rel = path.join('lib', name);
      const text = read(rel);
      if (text && BANNED.test(text)) violations.push(rel);
    }
  }

  if (violations.length) {
    console.error('[SYSTEM ERROR] External Layer isolation violated — banned pattern in:\n  ' + violations.join('\n  '));
    console.error('External data must not influence conclusion_status or FSCTM decision logic.');
    process.exit(1);
  }

  const serverSrc = read('server.js');
  if (!serverSrc) {
    console.error('[FAIL] server.js missing');
    process.exit(2);
  }
  const importCount = (serverSrc.match(/from\s+['"]\.\/lib\/externalLayerRouter\.js['"]/g) || []).length;
  const useCount = (serverSrc.match(/app\.use\(['"]\/api\/external\/v1['"]/g) || []).length;
  if (importCount !== 1 || useCount !== 1) {
    console.error('[FAIL] server.js must have exactly one externalLayerRouter import and one app.use mount.');
    process.exit(3);
  }
  // server.js must not call getExternalLayerPool in handleMatriyaSearch path — crude check: no getExternalLayerPool in server
  if (/getExternalLayerPool/.test(serverSrc)) {
    console.error('[SYSTEM ERROR] server.js must not reference getExternalLayerPool (keep pool inside external router only).');
    process.exit(4);
  }

  console.log('[PASS] External Layer isolation — no decision-path references; server mount singular.');
}

main();
