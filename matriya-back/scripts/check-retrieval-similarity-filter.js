/**
 * Retrieval similarity threshold filter (NO RELEVANT CHUNKS → filter empty).
 * Run: node scripts/check-retrieval-similarity-filter.js
 */
import assert from 'assert';
import {
  filterChunksByRetrievalSimilarityThreshold,
  getRetrievalSimilarityThreshold,
  retrievalSimilarityForGate
} from '../researchGate.js';

const prev = process.env.MATRIYA_RETRIEVAL_SIMILARITY_THRESHOLD;
process.env.MATRIYA_RETRIEVAL_SIMILARITY_THRESHOLD = '0.7';

const t = getRetrievalSimilarityThreshold();
assert.strictEqual(t, 0.7);

const weak = [
  { document: 'x'.repeat(20), evidence_metric: 'openai_rank', relevance_score: 0.65, metadata: { filename: 'a' } }
];
const strong = [
  { document: 'y'.repeat(20), evidence_metric: 'openai_rank', relevance_score: 0.85, metadata: { filename: 'b' } }
];

const mix = [...weak, ...strong];
const f = filterChunksByRetrievalSimilarityThreshold(mix);
assert.strictEqual(f.length, 1);
assert.strictEqual(f[0].metadata.filename, 'b');

assert.strictEqual(filterChunksByRetrievalSimilarityThreshold(weak).length, 0);
assert.ok(retrievalSimilarityForGate(weak[0]) < 0.7);

if (prev === undefined) delete process.env.MATRIYA_RETRIEVAL_SIMILARITY_THRESHOLD;
else process.env.MATRIYA_RETRIEVAL_SIMILARITY_THRESHOLD = prev;

console.log('check-retrieval-similarity-filter: OK');
