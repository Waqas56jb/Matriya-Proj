/**
 * Verifies the two shipped features:
 * 1) Deterministic answer ↔ retrieval sources (code-only, not LLM).
 * 2) Document search path: flow=document in server.js skips FSM / pre-LLM research gate / kernel;
 *    plus PARTIAL_EVIDENCE for a single strong chunk (with sources on the body).
 *
 * Run: npm run check:attribution-document-flow
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import assert from 'assert';
import { buildAnswerSourcesFromRetrieval, buildAnswerSourcesFromSnippets } from '../lib/answerAttribution.js';
import { evaluatePreLlmEvidencePhase, getStrongChunksForAttribution } from '../researchGate.js';
import { buildAskMatriyaGateChunksFromSnippets } from '../lib/openaiFileSearchMatriya.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

console.log('--- 1. Attribution: buildAnswerSourcesFromRetrieval ---');
{
  const longText = 'x'.repeat(120);
  const rows = [
    { id: 'chunk-7', document: longText, metadata: { filename: 'INT-TFX-001.pdf' } },
    { id: 'chunk-8', document: '   ', metadata: { filename: 'other.txt' } }
  ];
  const sources = buildAnswerSourcesFromRetrieval(rows, { previewLength: 100, maxItems: 10 });
  assert.strictEqual(sources.length, 1, 'empty-text row skipped');
  assert.strictEqual(sources[0].source_id, 'row:chunk-7');
  assert.strictEqual(sources[0].document_name, 'INT-TFX-001.pdf');
  assert.strictEqual(sources[0].filename, 'INT-TFX-001.pdf');
  assert.strictEqual(sources[0].excerpt, sources[0].preview);
  assert.ok(sources[0].preview.endsWith('…'), 'long text truncated to previewLength');
  assert.strictEqual(sources[0].preview.length, 101, '100 chars + ellipsis');

  const again = buildAnswerSourcesFromRetrieval(rows, { previewLength: 100 });
  assert.deepStrictEqual(sources, again, 'same input → same sources (deterministic)');

  const noId = [{ document: 'y'.repeat(20), metadata: { filename: 'a.doc' } }];
  const s0 = buildAnswerSourcesFromRetrieval(noId)[0];
  const s1 = buildAnswerSourcesFromRetrieval(noId)[0];
  assert.strictEqual(s0.source_id, s1.source_id, 'stable hash when no row id');
  assert.ok(/^retrieval:0:[a-f0-9]{16}$/.test(s0.source_id), 'fallback id shape');
}

console.log('--- 1b. Attribution: buildAnswerSourcesFromSnippets ---');
{
  const snips = [{ filename: 'cloud.pdf', text: 'z'.repeat(50) }];
  const out = buildAnswerSourcesFromSnippets(snips, { previewLength: 40 });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].document_name, 'cloud.pdf');
  assert.ok(out[0].source_id.startsWith('snippet:0:'));
  assert.ok(out[0].preview.length <= 41, 'preview capped (~40 + …)');
}

console.log('--- 2. Document flow: server branches on flow=document (no kernel path) ---');
{
  const serverSrc = readFileSync(join(root, 'server.js'), 'utf8');
  assert.ok(
    serverSrc.includes('documentFlow') && serverSrc.includes("flowRaw === 'document'"),
    'server.js should define documentFlow from flow=document'
  );
  assert.ok(
    serverSrc.includes('kernel_invoked: false') && serverSrc.includes("state_machine: false"),
    'document response should expose kernel_invoked/state_machine false'
  );
  assert.ok(
    /generateAnswer\s*&&\s*documentFlow/.test(serverSrc) || serverSrc.includes('generateAnswer && documentFlow'),
    'document branch should run before full research flow'
  );
  assert.ok(
    serverSrc.includes('buildAnswerSourcesFromRetrieval'),
    'server should attach code-built sources (not LLM-only evidence helper for main paths)'
  );
}

console.log('--- 2b. PARTIAL_EVIDENCE: single strong chunk + sources on body ---');
{
  const oneStrong = [
    {
      document: 'p'.repeat(20),
      evidence_metric: 'openai_rank',
      relevance_score: 0.88,
      distance: 0.12,
      metadata: { filename: 'only-source.pdf' }
    }
  ];
  const ph = evaluatePreLlmEvidencePhase(oneStrong);
  assert.strictEqual(ph.outcome, 'partial');
  assert.strictEqual(ph.body.status, 'PARTIAL_EVIDENCE');
  assert.strictEqual(ph.body.suggestion, null);
  assert.ok(Array.isArray(ph.body.what_exists) && ph.body.what_exists.length >= 1);
  assert.ok(Array.isArray(ph.body.what_missing) && ph.body.what_missing.length >= 1);
  assert.strictEqual(ph.body.gap_type, 'single_strong_source');
  assert.ok(Array.isArray(ph.body.sources) && ph.body.sources.length === 1);
  assert.strictEqual(ph.body.sources[0].document_name, 'only-source.pdf');
  assert.ok(ph.body.sources[0].source_id, 'source_id set from retrieval row');
}

console.log('--- 3. Ask Matriya: gate chunks rank query-related snippet above noise ---');
{
  const snips = [
    { filename: 'good.pdf', text: 'INT-TFX Expansion Ratio 18.5 בניסוי ' + 'x'.repeat(20) },
    { filename: 'noise.pdf', text: 'לוגיסטיקה כללית ומבנה ארגוני ' + 'y'.repeat(25) }
  ];
  const q = 'מאיזה מסמך Expansion Ratio 18.5 בניסוי INT-TFX';
  const draft = 'הערך 18.5 מופיע במסמך הניסוי.';
  const gc = buildAskMatriyaGateChunksFromSnippets(snips, q, draft);
  assert.strictEqual(gc.length, 2, 'both substantive');
  assert.strictEqual(gc[0].metadata.filename, 'good.pdf', 'higher overlap first');
  const strong = getStrongChunksForAttribution(gc);
  assert.ok(strong.length >= 1 && strong.length < gc.length, 'only query-aligned chunk passes similarity bar');
}

console.log('');
console.log('check-attribution-and-document-flow: OK');
