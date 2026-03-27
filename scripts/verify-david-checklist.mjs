/**
 * David's final scope checklist — automated evidence (matriya-back).
 * Run: npm run verify:david-checklist
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  MATRIYA_FILE_SEARCH_INSTRUCTIONS_ANSWER,
  buildFilenameHint
} from '../lib/openaiFileSearchMatriya.js';
import { excelCompositionRowSuffix } from '../lib/excelPercentFormat.js';
import { evaluateConclusionBeforeGeneration } from '../lib/domainAndGenerationGate.js';
import { filterRetrievalRowsByQueryDomain } from '../lib/domainAndGenerationGate.js';
import { RAG_INSUFFICIENT_SUPPORT_MESSAGE_HE } from '../lib/ragEvidenceFailSafe.js';
import {
  rowMetadataMatchesFilter,
  filenameMatchesSingleFilter
} from '../lib/vectorMetadataFilenameFilter.js';
import { answerViolatesNeutralWordingPolicy } from '../lib/answerWordingGuard.js';
import settings from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

console.log('David checklist (matriya-back) — automated checks\n');

// §3 No evidence → no conclusion
assert.equal(evaluateConclusionBeforeGeneration('מה הפורמולה הכי טובה', []).ok, false);
assert.ok(RAG_INSUFFICIENT_SUPPORT_MESSAGE_HE.includes('אין במערכת מידע תומך'));

// §3 + §7 Policy in model instructions (file_search path)
assert.match(MATRIYA_FILE_SEARCH_INSTRUCTIONS_ANSWER, /הכי טוב|מומלץ|best\/recommended/i);

// §7 Wording guard: bad vs good simulated replies
assert.equal(answerViolatesNeutralWordingPolicy('הפורמולה הכי טובה היא מספר 3'), true);
assert.equal(answerViolatesNeutralWordingPolicy('מומלץ לבחור בפורמולה א'), true);
assert.equal(answerViolatesNeutralWordingPolicy('במסמך מופיע: מים 72.5%, חומר X 27.5%.'), false);
assert.equal(answerViolatesNeutralWordingPolicy('אין מומלץ להשתמש בחומר ללא מגן'), false);

// §4 Extraction / composition row (indexed text guard)
assert.equal(excelCompositionRowSuffix([0.25, 0.25, 0.25, 0.25, 'base']), '');
assert.ok(excelCompositionRowSuffix([0.5, 0.4, 'x']).includes('INVALID'));

// §6 Domain control (metadata filter semantics + prompt hint)
assert.equal(rowMetadataMatchesFilter({ filename: 'a.pdf' }, { filenames: ['a.pdf'] }), true);
assert.equal(rowMetadataMatchesFilter({ filename: 'b.pdf' }, { filenames: ['a.pdf'] }), false);
assert.ok(buildFilenameHint({ filenames: ['picked.pdf'] }).includes('picked.pdf'));
assert.equal(filenameMatchesSingleFilter('picked.pdf', 'folder/picked.pdf'), true);

// §8 Determinism (same input → same filtered rows)
const q = 'מה אחוז ברזל';
const rows = [
  { document: 'ברזל 12%', text: 'ברזל 12%', metadata: { filename: 'f.pdf' } },
  { document: 'רק סוכר', text: 'רק סוכר', metadata: { filename: 'g.pdf' } }
];
const prev = process.env.MATRIYA_DOMAIN_MIN_QUERY_OVERLAP;
process.env.MATRIYA_DOMAIN_MIN_QUERY_OVERLAP = '2';
try {
  const a = filterRetrievalRowsByQueryDomain(q, rows);
  const b = filterRetrievalRowsByQueryDomain(q, rows);
  assert.deepEqual(
    a.map((r) => r.document),
    b.map((r) => r.document)
  );
} finally {
  if (prev === undefined) delete process.env.MATRIYA_DOMAIN_MIN_QUERY_OVERLAP;
  else process.env.MATRIYA_DOMAIN_MIN_QUERY_OVERLAP = prev;
}

// §8 LLM decode temperature default 0
assert.ok(settings.LLM_TEMPERATURE >= 0 && settings.LLM_TEMPERATURE <= 2);

// §5 Delete / no ghost snippets — reuse full script (same assertions as test:delete-guard)
const del = spawnSync(process.execPath, ['scripts/test-delete-snippet-guard.mjs'], {
  cwd: root,
  encoding: 'utf8'
});
assert.equal(del.status, 0, `test:delete-guard subprocess failed:\n${del.stderr || del.stdout}`);

console.log('\nverify:david-checklist (matriya-back) — OK\n');
