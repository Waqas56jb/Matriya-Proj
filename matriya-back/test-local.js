/**
 * HONEST pipeline test using David's actual ragService.js code.
 *
 * Imports: ragService.js → documentProcessor.js → chunker.js → llmService.js
 *
 * WHAT THIS TESTS:
 *   PASS/FAIL — ragService instantiation (constructor)
 *   PASS/FAIL — ragService.documentProcessor.processFile()   ← real client code
 *   PASS/FAIL — ragService.chunker.chunkText()               ← real client code
 *   PASS/FAIL — ragService.llmService.generateAnswer()       ← real client code
 *   SKIP      — ragService.vectorStore (search / ingest)     ← needs DB (not connected)
 *
 * Usage:
 *   node test-local.js
 *   node test-local.js "your question" "path/to/file.xlsx"
 */

import RAGService from './ragService.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FILE_PATH = process.argv[3] || path.join(__dirname, 'MATRIYA_Experiment_Template-1.xlsx');
const QUESTION  = process.argv[2] || 'What are the materials and percentages used in EXP-001?';

function label(status) {
  return status === 'PASS' ? '[PASS]' : status === 'SKIP' ? '[SKIP]' : '[FAIL]';
}

async function runTest() {
  const results = [];

  console.log('\n============================================================');
  console.log('MATRIYA — HONEST PIPELINE TEST USING ragService.js');
  console.log('============================================================');
  console.log('File    :', FILE_PATH);
  console.log('Question:', QUESTION);
  console.log('------------------------------------------------------------\n');

  // ── STEP 1: Instantiate RAGService (David's main service class) ──
  let rag;
  try {
    console.log('[Step 1] Instantiating RAGService (ragService.js)...');
    rag = new RAGService();
    console.log('[PASS] RAGService instantiated');
    console.log('       → documentProcessor : ready (documentProcessor.js)');
    console.log('       → chunker           : ready (chunker.js)');
    console.log('       → llmService        : ready (llmService.js)');
    console.log('       → vectorStore       : object created (vectorStoreSupabase.js) — DB connection untested until query');
    results.push({ step: 'RAGService instantiation', status: 'PASS' });
  } catch (err) {
    console.error('[FAIL] RAGService constructor threw:', err.message);
    results.push({ step: 'RAGService instantiation', status: 'FAIL', error: err.message });
    process.exit(1);
  }

  // ── STEP 2: ragService.documentProcessor.processFile() ──
  console.log('\n[Step 2] ragService.documentProcessor.processFile() — documentProcessor.js');
  let processResult;
  try {
    processResult = await rag.documentProcessor.processFile(FILE_PATH);
    if (!processResult.success) throw new Error(processResult.error);

    console.log('[PASS] File processed successfully');
    console.log('       → filename   :', processResult.metadata.filename);
    console.log('       → file_type  :', processResult.metadata.file_type);
    console.log('       → file_size  :', processResult.metadata.file_size, 'bytes');
    console.log('       → text length:', processResult.text.length, 'chars');
    console.log('\n       TEXT PREVIEW (first 600 chars):');
    console.log('       ' + processResult.text.slice(0, 600).replace(/\n/g, '\n       '));
    results.push({ step: 'documentProcessor.processFile()', status: 'PASS' });
  } catch (err) {
    console.error('[FAIL] documentProcessor.processFile() threw:', err.message);
    results.push({ step: 'documentProcessor.processFile()', status: 'FAIL', error: err.message });
    process.exit(1);
  }

  // ── STEP 3: ragService.chunker.chunkText() ──
  console.log('\n[Step 3] ragService.chunker.chunkText() — chunker.js');
  let chunks;
  try {
    chunks = rag.chunker.chunkText(processResult.text, processResult.metadata);
    if (!chunks || chunks.length === 0) throw new Error('No chunks produced');

    console.log('[PASS] Chunking successful');
    console.log(`       → Total chunks : ${chunks.length}`);
    chunks.forEach((c, i) => {
      console.log(`       → Chunk ${i} : ${c.text.length} chars | chunk_index=${c.metadata.chunk_index}`);
    });
    results.push({ step: 'chunker.chunkText()', status: 'PASS' });
  } catch (err) {
    console.error('[FAIL] chunker.chunkText() threw:', err.message);
    results.push({ step: 'chunker.chunkText()', status: 'FAIL', error: err.message });
    process.exit(1);
  }

  // ── STEP 4: ragService.vectorStore.addDocuments() — DB dependent ──
  console.log('\n[Step 4] ragService.vectorStore.addDocuments() — vectorStoreSupabase.js');
  console.log('[SKIP] Skipped — requires Supabase PostgreSQL connection (not available yet)');
  console.log('       → This step embeds chunks and stores them in the DB');
  console.log('       → Will be tested once David resumes the Supabase project');
  results.push({ step: 'vectorStore.addDocuments()', status: 'SKIP', reason: 'DB not connected' });

  // ── STEP 5: ragService.vectorStore.search() — DB dependent ──
  console.log('\n[Step 5] ragService.vectorStore.search() / ragService.search() — DB dependent');
  console.log('[SKIP] Skipped — requires embeddings stored in DB (Step 4 must pass first)');
  results.push({ step: 'vectorStore.search()', status: 'SKIP', reason: 'DB not connected' });

  // ── STEP 6: ragService.llmService.generateAnswer() — using real chunks as context ──
  console.log('\n[Step 6] ragService.llmService.generateAnswer() — llmService.js');

  if (!rag.llmService.isAvailable()) {
    console.error('[FAIL] LLM service not available — check OPENAI_API_KEY in .env');
    results.push({ step: 'llmService.generateAnswer()', status: 'FAIL', error: 'API key missing' });
  } else {
    console.log(`       → provider : ${rag.llmService.provider}`);
    console.log(`       → model    : ${rag.llmService.model}`);

    // Build context exactly the same way ragService.generateAnswer() does
    const sources = [...new Set(chunks.map(c => c.metadata.filename || 'unknown'))];
    const contextParts = chunks.map((c, i) => {
      const filename = c.metadata.filename || 'Unknown';
      return `[Source ${i + 1} from ${filename}]:\n${c.text}\n`;
    });
    const context = contextParts.join('\n');

    // Inject source citation instruction (same pattern as before)
    const questionWithSource = `${QUESTION}\n\nIMPORTANT: End your answer with: "Source: <filename> | Sheet: <sheet name>" based on the [Source:] tags in the context.`;

    try {
      const answer = await rag.llmService.generateAnswer(questionWithSource, context, 700);
      if (!answer) throw new Error('LLM returned null');

      console.log('[PASS] LLM answered successfully');
      console.log('\n============================================================');
      console.log('ANSWER FROM LLM (via ragService.llmService):');
      console.log('============================================================');
      console.log(answer);
      console.log('------------------------------------------------------------');
      console.log('SOURCE TRACE (from chunk metadata):');
      sources.forEach(s => console.log('  File:', s));
      console.log('============================================================\n');
      results.push({ step: 'llmService.generateAnswer()', status: 'PASS' });
    } catch (err) {
      console.error('[FAIL] llmService.generateAnswer() error:', err.message);
      results.push({ step: 'llmService.generateAnswer()', status: 'FAIL', error: err.message });
    }
  }

  // ── FINAL SUMMARY ──
  console.log('============================================================');
  console.log('PIPELINE SUMMARY (using ragService.js code)');
  console.log('============================================================');
  results.forEach(r => {
    const line = `${label(r.status)} ${r.step}`;
    const extra = r.error ? `  ← ${r.error}` : r.reason ? `  ← ${r.reason}` : '';
    console.log(line + extra);
  });
  console.log('------------------------------------------------------------');
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const skipped = results.filter(r => r.status === 'SKIP').length;
  console.log(`Passed: ${passed} | Failed: ${failed} | Skipped (need DB): ${skipped}`);
  console.log('============================================================\n');
}

runTest().catch(err => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});
