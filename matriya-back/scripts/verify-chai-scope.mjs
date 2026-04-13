/**
 * Chai scope — deterministic PASS checks (no HTTP, no JWT, no corpus).
 * Covers: gate chunks when file_search returns multi-snippet zero-overlap, Conclusion True,
 * Latin token overlap for formulation % questions, domain filter, canonical insufficient text.
 *
 * Run: npm run verify:chai-scope
 */
import assert from 'assert';
import { buildAskMatriyaGateChunksFromSnippets } from '../lib/openaiFileSearchMatriya.js';
import {
  filterRetrievalRowsByQueryDomain,
  evaluateConclusionBeforeGeneration
} from '../lib/domainAndGenerationGate.js';
import { retrievalSimilarityForGate } from '../researchGate.js';
import { RAG_INSUFFICIENT_SUPPORT_MESSAGE_HE } from '../lib/ragEvidenceFailSafe.js';

const THR = 0.7;

function assertConclusionTrue(label, query, chunks) {
  const filtered = filterRetrievalRowsByQueryDomain(query, chunks);
  assert.ok(filtered.length >= 1, `${label}: domain filter should keep >=1 chunk`);
  const gate = evaluateConclusionBeforeGeneration(query, filtered);
  assert.strictEqual(gate.ok, true, `${label}: Conclusion should be True (ok), got ${JSON.stringify(gate)}`);
}

function assertNumericReplyShape(reply, sources, label) {
  assert.ok(reply && typeof reply === 'string' && reply.trim(), `${label}: non-empty reply`);
  assert.ok(/\d/.test(reply), `${label}: reply should contain a digit`);
  assert.ok(!/אין במערכת מידע תומך/i.test(reply), `${label}: should not be insufficient message`);
  assert.ok(Array.isArray(sources) && sources.length >= 1, `${label}: >=1 source`);
  const prev = (sources[0].preview || '').toString();
  assert.ok(prev.length > 5, `${label}: source preview`);
}

console.log('--- Chai scope verify: canonical insufficient message ---');
{
  assert.ok(RAG_INSUFFICIENT_SUPPORT_MESSAGE_HE.includes('אין במערכת מידע תומך'));
  assert.ok(RAG_INSUFFICIENT_SUPPORT_MESSAGE_HE.endsWith('.'));
}

console.log('--- 1) Multi-snippet file_search, zero Hebrew overlap (regression: was []) ---');
{
  const q = 'שאילתה שלא מופיעה בשום קטע uniquemarkerxyz';
  const chunks = buildAskMatriyaGateChunksFromSnippets(
    [
      { filename: 'doc-a.pdf', text: 'טקסט ארוך מספיק אבל בלי המילה המיוחדת למעלה כלל' },
      { filename: 'doc-b.pdf', text: 'עוד טקסט ארוך שונה לחלוטין גם בלי המילה המיוחדת' }
    ],
    q,
    ''
  );
  assert.ok(chunks.length >= 2, 'expected fallback rows for each snippet');
  for (const c of chunks) {
    const sim = retrievalSimilarityForGate(c);
    assert.ok(sim >= THR, `similarity ${sim} >= ${THR}`);
  }
  assertConclusionTrue('multi-snippet fallback', q, chunks);
}

console.log('--- 2) Latin ingredients in Hebrew query (XANTHAN / formula) ---');
{
  const q = 'מה אחוז ה-XANTHAN GUM בפורמולציה';
  const chunks = buildAskMatriyaGateChunksFromSnippets(
    [
      { filename: 'formula.pdf', text: 'Ingredient: XANTHAN GUM — 0.42 % w/w; water q.s.' }
    ],
    q,
    ''
  );
  assert.strictEqual(chunks.length, 1);
  assert.ok(retrievalSimilarityForGate(chunks[0]) >= THR);
  assertConclusionTrue('xanthan overlap', q, chunks);
}

console.log('--- 3) Domain: chunk with no query-token hits is dropped ---');
{
  const prevDom = process.env.MATRIYA_DOMAIN_MIN_QUERY_OVERLAP;
  process.env.MATRIYA_DOMAIN_MIN_QUERY_OVERLAP = '2';
  try {
    const q = 'מה אחוז ברזל בתוסף';
    const rows = [
      {
        document: 'מידע על סוכר וגלוקוז בלבד ללא מתכות',
        text: 'מידע על סוכר וגלוקוז בלבד ללא מתכות',
        metadata: { filename: 'a.pdf' }
      },
      { document: 'ברזל 5% בתוסף', text: 'ברזל 5% בתוסף', metadata: { filename: 'b.pdf' } }
    ];
    const onlyA = filterRetrievalRowsByQueryDomain(q, [rows[0]]);
    assert.strictEqual(onlyA.length, 0, 'chunk without query terms should be dropped');
    const onlyB = filterRetrievalRowsByQueryDomain(q, [rows[1]]);
    assert.ok(onlyB.length >= 1);
  } finally {
    if (prevDom === undefined) delete process.env.MATRIYA_DOMAIN_MIN_QUERY_OVERLAP;
    else process.env.MATRIYA_DOMAIN_MIN_QUERY_OVERLAP = prevDom;
  }
}

console.log('--- 4) Delete / no-evidence: empty chunks => Conclusion False ---');
{
  const gate = evaluateConclusionBeforeGeneration('מה זה TEST-DELETE-991', []);
  assert.strictEqual(gate.ok, false);
}

console.log('--- 5) Simulated “True” answer from snippet (deterministic string check) ---');
{
  const snippetText = 'מים מזוקקים — 72.5% ממסה הכוללת';
  const reply = 'במסמך מופיע: מים מזוקקים בריכוז 72.5%.';
  const sources = [{ source_id: 's1', document_name: 'F.pdf', preview: snippetText }];
  assertNumericReplyShape(reply, sources, 'distilled water');
}

console.log('\nverify:chai-scope — all PASS');
