/**
 * Delete files with garbled/mojibake names from the RAG vector store.
 * Run from matriya-back: node scripts/delete-garbled-files.js
 * Optionally pass exact filenames: node scripts/delete-garbled-files.js "bad name.pdf" "other.txt"
 */
import dotenv from 'dotenv';
dotenv.config();

function looksGarbled(name) {
  // Common mojibake when UTF-8 is read as Latin-1
  return /Ã|ª|/.test(name) || (name.includes('.') && /[\x80-\xff]{2,}/.test(name));
}

async function main() {
  if (!process.env.POSTGRES_URL && !process.env.POSTGRES_PRISMA_URL) {
    console.error('Missing POSTGRES_URL or POSTGRES_PRISMA_URL in .env');
    process.exit(1);
  }

  const { default: RAGService } = await import('../ragService.js');
  const rag = new RAGService();
  const explicitNames = process.argv.slice(2).filter(Boolean);

  if (explicitNames.length > 0) {
    console.log('Deleting by exact filename:', explicitNames);
    for (const name of explicitNames) {
      const deleted = await rag.deleteDocumentsByFilename(name);
      console.log(`  "${name}" -> deleted ${deleted} chunks`);
    }
    return;
  }

  const filenames = await rag.getAllFilenames();
  const toDelete = filenames.filter(looksGarbled);
  if (toDelete.length === 0) {
    console.log('No garbled filenames found.');
    return;
  }
  console.log('Garbled filenames to delete:', toDelete.length);
  for (const name of toDelete) {
    const deleted = await rag.deleteDocumentsByFilename(name);
    console.log(`  "${name}" -> deleted ${deleted} chunks`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
