/**
 * One-time script: insert 23.11.2022-003.3 into the INTUMESCENT summary sheet.
 * Composition sourced directly from the detail block (פורמולציות sheet, rows 93-106).
 * Run once before live ingest, then can be deleted.
 *
 * Usage: node scripts/addFormulation003_3.js <path-to-excel>
 */

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const requireModule = createRequire(import.meta.url);
const XLSX = requireModule('xlsx');

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node scripts/addFormulation003_3.js <path-to-excel-file>');
  process.exit(1);
}
const resolved = path.resolve(filePath);
console.log(`\nReading: ${resolved}`);

const wb = XLSX.readFile(resolved, { cellStyles: true, cellDates: true, sheetStubs: true });

const SHEET_NAME = '\u05E4\u05D5\u05E8\u05DE\u05D5\u05DC\u05E6\u05D9\u05D5\u05EA -\u05E1\u05D9\u05DB\u05D5\u05DD'; // פורמולציות -סיכום
if (!wb.Sheets[SHEET_NAME]) {
  console.error(`Sheet "${SHEET_NAME}" not found. Available sheets:`, Object.keys(wb.Sheets));
  process.exit(1);
}

const ws   = wb.Sheets[SHEET_NAME];
const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });

// Verify 003.2 is at row 6 and 004 follows
const id_003_2 = String(rows[6]?.[0] || '').trim();
const id_004   = String(rows[7]?.[0] || '').trim();
console.log(`Row 6 (expected 003.2): "${id_003_2}"`);
console.log(`Row 7 (expected 004):   "${id_004}"`);

// Check 003.3 is not already present
const alreadyExists = rows.some(r => String(r?.[0] || '').includes('003.3'));
if (alreadyExists) {
  console.log('\n003.3 row already exists in summary sheet — nothing to do.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 003.3 composition (from detail block rows 93-106 of פורמולציות sheet):
//
// Col  Material name     Fraction (rounded to 4dp to match existing rows)
//  0   ID                23.11.2022-003.3
//  1   water             0.188
//  2   OROTAN 731        0.0016
//  6   COMBIZELL         0.001   (detail: 0.000988)
//  7   RM-825            0.003   (detail: 0.002994)
// 10   AGITAN 80         0.003   (detail: 0.002994)
// 14   TIONA 595         0.1058  (detail: 0.10578)
// 16   CHARMOR PM 40     0.1058  (detail: 0.10578)
// 19   MELAFINE          0.1058  (detail: 0.10578)
// 22   EXOLIT AP435      0.2746  (detail: 0.27455 — differs from 003–003.2=0.2745)
// 29   ENCOR 367         0.2116  (detail: 0.21157)
// 35   total (computed)
// ---------------------------------------------------------------------------
const TOTAL_COLS = 36; // 0..35

const newRow = new Array(TOTAL_COLS).fill(0);
newRow[0]  = '23.11.2022-003.3';
newRow[1]  = 0.188;
newRow[2]  = 0.0016;
newRow[6]  = 0.001;
newRow[7]  = 0.003;
newRow[10] = 0.003;
newRow[14] = 0.1058;
newRow[16] = 0.1058;
newRow[19] = 0.1058;
newRow[22] = 0.2746;
newRow[29] = 0.2116;

// Compute total for the last column
const computedTotal = newRow.slice(1, 35).reduce((acc, v) => acc + (v || 0), 0);
newRow[35] = Math.round(computedTotal * 10000) / 10000;

console.log(`\n003.3 row to insert:`);
console.log(`  ID:    ${newRow[0]}`);
console.log(`  water: ${newRow[1]}  OROTAN: ${newRow[2]}  COMBIZELL: ${newRow[6]}`);
console.log(`  RM-825: ${newRow[7]}  AGITAN80: ${newRow[10]}`);
console.log(`  TIONA595: ${newRow[14]}  CHARMOR: ${newRow[16]}  MELAFINE: ${newRow[19]}`);
console.log(`  EXOLIT: ${newRow[22]}  ENCOR367: ${newRow[29]}`);
console.log(`  total (col 35): ${newRow[35]}`);

// Insert after row 6 (003.2), before row 7 (004)
rows.splice(7, 0, newRow);

console.log(`\nAfter insert:`);
console.log(`  Row 6: ${String(rows[6][0]).trim()} (003.2)`);
console.log(`  Row 7: ${String(rows[7][0]).trim()} (003.3 — NEW)`);
console.log(`  Row 8: ${String(rows[8][0]).trim()} (004)`);

// Rebuild sheet from modified row array
const lastColLetter = XLSX.utils.encode_col(TOTAL_COLS - 1);
const newWs = XLSX.utils.aoa_to_sheet(rows, { raw: true });
newWs['!ref'] = `A1:${lastColLetter}${rows.length}`;
wb.Sheets[SHEET_NAME] = newWs;

// Write back to same file
XLSX.writeFile(wb, resolved);
console.log(`\n✓ File updated: ${resolved}`);
console.log(`  Total rows now: ${rows.length}`);
