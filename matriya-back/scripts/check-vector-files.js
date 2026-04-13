/**
 * Check if the 4 project files have vector data in the RAG collection.
 * Run from matriya-back: node scripts/check-vector-files.js
 */
import dotenv from 'dotenv';
dotenv.config();

const EXPECTED_FILES = [
  'מסיר צבע ERL-ONE תוצאות ניסוי.xlsx',
  'ERL-ONE סיכום בדיקה לאחר 24 שעות על קוביות, סגורות.docx',
  'סיכום פרויקט ETL ONE.docx',
  'Etl-one — תיק מוצר טכנולוגי (מו״פ).docx'
];

// Alternate possible names (e.g. leading dash, .doc instead of .docx)
const ALIASES = {
  'סיכום פרויקט ETL ONE.docx': ['-סיכום פרויקט ETL ONE.docx', 'סיכום פרויקט ETL ONE.docx'],
  'Etl-one — תיק מוצר טכנולוגי (מו״פ).docx': ['Etl-one — תיק מוצר טכנולוגי (מו״פ).doc', 'Etl-one — תיק מוצר טכנולוגי (מו״פ).docx']
};

async function main() {
  if (!process.env.POSTGRES_URL && !process.env.POSTGRES_PRISMA_URL) {
    console.error('Missing POSTGRES_URL or POSTGRES_PRISMA_URL in .env');
    process.exit(1);
  }

  const { default: RAGService } = await import('../ragService.js');
  const rag = new RAGService();
  const stored = await rag.getAllFilenames();

  console.log('--- Vector store: unique filenames with embeddings ---');
  console.log('Total files in store:', stored.length);
  if (stored.length) {
    stored.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  }
  console.log('');

  console.log('--- Check expected 4 project files ---');
  const normalizedExpected = [
    'מסיר צבע ERL-ONE תוצאות ניסוי.xlsx',
    'ERL-ONE סיכום בדיקה לאחר 24 שעות על קוביות, סגורות.docx',
    'סיכום פרויקט ETL ONE.docx',
    'Etl-one — תיק מוצר טכנולוגי (מו״פ).docx'
  ];

  let allOk = true;
  for (const name of normalizedExpected) {
    const hasExact = stored.includes(name);
    const altNames = ALIASES[name];
    const hasAlt = Array.isArray(altNames) && altNames.some(alt => stored.includes(alt));
    const found = hasExact || hasAlt;
    if (!found) allOk = false;
    console.log(found ? '  ✓' : '  ✗', name, found ? '(has vector data)' : '(NO vector data)');
  }

  console.log('');
  if (allOk) {
    console.log('Result: All 4 files have vector data.');
  } else {
    console.log('Result: Some files are missing vector data. Re-upload them via the management Files tab to ingest.');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
