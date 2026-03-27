/**
 * Final scope checklist — automated evidence (matriya-back).
 * Run: npm run verify:scope-signoff
 *
 * Cross-repo: maneger-back `npm run test:unit` covers email/lab import gate + delete helper.
 */
import assert from 'node:assert/strict';
import {
  MATRIYA_FILE_SEARCH_INSTRUCTIONS_ANSWER,
  buildFilenameHint
} from '../lib/openaiFileSearchMatriya.js';
import { excelCompositionRowSuffix } from '../lib/excelPercentFormat.js';
import { evaluateConclusionBeforeGeneration } from '../lib/domainAndGenerationGate.js';
import settings from '../config.js';
import { RAG_INSUFFICIENT_SUPPORT_MESSAGE_HE } from '../lib/ragEvidenceFailSafe.js';
import {
  rowMetadataMatchesFilter,
  filenameMatchesSingleFilter
} from '../lib/vectorMetadataFilenameFilter.js';

console.log('=== Scope sign-off — automated slice (matriya-back) ===\n');

console.log('§3 No evidence / no conclusion — canonical insufficient (API + gates)');
assert.ok(RAG_INSUFFICIENT_SUPPORT_MESSAGE_HE.includes('אין במערכת מידע תומך'));
assert.equal(evaluateConclusionBeforeGeneration('מה הפורמולה הכי טובה', []).ok, false);

console.log('§3 §7 Ranking / recommendation policy in OpenAI file_search instructions');
assert.match(MATRIYA_FILE_SEARCH_INSTRUCTIONS_ANSWER, /הכי טוב|מומלץ|best\/recommended/i);
assert.match(MATRIYA_FILE_SEARCH_INSTRUCTIONS_ANSWER, /מנצח|never crown|canonical no-data/i);

console.log('§4 Extraction — Excel composition row sum guard (indexed RAG text)');
assert.equal(excelCompositionRowSuffix([0.5, 0.5, 'water']), '');
assert.ok(excelCompositionRowSuffix([0.5, 0.4, 'x']).includes('INVALID OUTPUT'));

console.log('§6 Domain / selected documents — prompt + metadata filter semantics');
const hint = buildFilenameHint({ filenames: ['only-one.pdf'] });
assert.ok(hint.includes('only-one.pdf'));
assert.equal(rowMetadataMatchesFilter({ filename: 'only-one.pdf' }, { filenames: ['only-one.pdf'] }), true);
assert.equal(rowMetadataMatchesFilter({ filename: 'other.pdf' }, { filenames: ['only-one.pdf'] }), false);
assert.equal(filenameMatchesSingleFilter('folder/only-one.pdf', 'x/folder/only-one.pdf'), true);

console.log('§8 Consistency — LLM temperature (default 0; set MATRIYA_LLM_TEMPERATURE for non-zero)');
assert.ok(
  typeof settings.LLM_TEMPERATURE === 'number' &&
    settings.LLM_TEMPERATURE >= 0 &&
    settings.LLM_TEMPERATURE <= 2
);
if (settings.LLM_TEMPERATURE !== 0) {
  console.warn(`  note: LLM_TEMPERATURE=${settings.LLM_TEMPERATURE} (use 0 for strict repeatability)`);
}

console.log(`
=== Optional smoke (real APIs / DB) ===

§1+§2 maneger-back POST .../import-attachment (destination=lab): complete → DB+RAG; incomplete → 422 pending + Resend + lab_import_meta. Apply sql/create_project_emails.sql or sql/alter_project_emails_lab_import_meta.sql on Supabase for that feature (not required for npm test:unit).

§5 matriya-back: npm run test:delete-guard. maneger-back: deleteManagementVectorByFilename in test:unit.

§6 Vector SQL matches rowMetadataMatchesFilter semantics; OpenAI path: filename hint + instructions.

§7–§8 Model output: spot-check; OpenAI Responses uses temperature:0; local LLM MATRIYA_LLM_TEMPERATURE default 0.
`);

console.log('verify:scope-signoff — automated slice OK\n');
