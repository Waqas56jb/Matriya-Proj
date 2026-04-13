/**
 * Unit checks for filterFileSearchSnippetsToIndex (delete + ask guard).
 * Run: npm run test:delete-guard
 * No DB or OpenAI required.
 */
import assert from 'assert';
import { filterFileSearchSnippetsToIndex } from '../lib/filterFileSearchSnippetsToIndex.js';
import { safeUploadName } from '../lib/matriyaOpenAiSync.js';

function ok(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    throw e;
  }
}

console.log('test-delete-snippet-guard');

ok('empty index drops all snippets (no ghost answers when DB has no files)', () => {
  const out = filterFileSearchSnippetsToIndex(
    [{ filename: 'report.txt', text: 'secret content' }],
    []
  );
  assert.deepStrictEqual(out, []);
});

ok('full path match keeps snippet', () => {
  const idx = ['BTL/BTL/B2010000.pdf'];
  const snips = [{ filename: 'BTL/BTL/B2010000.pdf', text: 'x' }];
  assert.strictEqual(filterFileSearchSnippetsToIndex(snips, idx).length, 1);
});

ok('OpenAI upload name (.txt) keeps snippet when index has logical path', () => {
  const logical = 'folder/My Report.pdf';
  const upload = safeUploadName(logical);
  assert.ok(upload.endsWith('.txt'));
  const out = filterFileSearchSnippetsToIndex([{ filename: upload, text: 'chunk' }], [logical]);
  assert.strictEqual(out.length, 1);
});

ok('basename match keeps snippet for path in index', () => {
  const out = filterFileSearchSnippetsToIndex(
    [{ filename: 'B2010000.pdf', text: 'x' }],
    ['BTL/BTL/B2010000.pdf']
  );
  assert.strictEqual(out.length, 1);
});

ok('snippet only for removed file: if index no longer lists it, drop by upload name', () => {
  const logical = 'only/one.pdf';
  const upload = safeUploadName(logical);
  const ghost = [{ filename: upload, text: 'still in OpenAI cache' }];
  assert.deepStrictEqual(filterFileSearchSnippetsToIndex(ghost, ['other/kept.pdf']), []);
});

ok('snippet with blank filename is dropped when body has no Matriya header', () => {
  assert.deepStrictEqual(filterFileSearchSnippetsToIndex([{ filename: '', text: 'x' }], ['a.pdf']), []);
});

ok('logical path from sync header keeps snippet when API filename differs', () => {
  const idx = ['Folder/Report.pdf'];
  const body = '---\nמקור מסמך (שם קובץ במערכת): Folder/Report.pdf\n---\n\ntext';
  const out = filterFileSearchSnippetsToIndex(
    [{ filename: 'some_openai_name.txt', text: body }],
    idx
  );
  assert.strictEqual(out.length, 1);
});

console.log('All snippet-guard checks passed.');
