/**
 * inspectNewExcel.js
 * Read-only structural inspection of the updated lab Excel file.
 * No DB writes. No ingest. Analysis only.
 */

import XLSX from 'xlsx';
import path from 'path';

const FILE = path.resolve('test/INTUMESCENT_NEW_FORMULATIONS_2026-04-05 (1) (2).xlsx');

const wb = XLSX.readFile(FILE, { cellDates: true, raw: false });

console.log('\n═══════════════════════════════════════════════════════════════════════');
console.log('  STRUCTURAL INSPECTION — ' + path.basename(FILE));
console.log('  Mode: READ ONLY. No ingest. No DB writes.');
console.log('═══════════════════════════════════════════════════════════════════════\n');

console.log(`Sheets (${wb.SheetNames.length}): ${wb.SheetNames.join(' | ')}\n`);

for (const sheetName of wb.SheetNames) {
  const ws   = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false });

  const nonEmpty = rows.filter(r => r.some(c => c !== null && String(c).trim() !== ''));
  const maxCols  = Math.max(...nonEmpty.map(r => r.length), 0);

  console.log(`────────────────────────────────────────────────────────────`);
  console.log(`SHEET: "${sheetName}"`);
  console.log(`  Total rows (incl blanks): ${rows.length}`);
  console.log(`  Non-empty rows          : ${nonEmpty.length}`);
  console.log(`  Max columns             : ${maxCols}`);

  // Print first 6 non-empty rows as preview
  console.log(`\n  First 6 non-empty rows (preview):`);
  let shown = 0;
  for (const row of rows) {
    if (shown >= 6) break;
    const cells = row.filter(c => c !== null && String(c).trim() !== '');
    if (cells.length === 0) continue;
    const preview = row.slice(0, Math.min(row.length, 12))
      .map(c => (c === null || String(c).trim() === '') ? '—' : String(c).slice(0, 20))
      .join(' | ');
    console.log(`    [${rows.indexOf(row).toString().padStart(3)}] ${preview}`);
    shown++;
  }

  // Detect header row (longest non-empty row in first 10)
  const headerCandidates = rows.slice(0, 15).filter(r =>
    r.filter(c => c !== null && String(c).trim() !== '').length > 3
  );
  const headerRow = headerCandidates.sort((a,b) =>
    b.filter(c => c !== null).length - a.filter(c => c !== null).length
  )[0];

  if (headerRow) {
    const headers = headerRow
      .map((c, i) => ({ i, v: c }))
      .filter(x => x.v !== null && String(x.v).trim() !== '');
    console.log(`\n  Detected header row (${headers.length} columns):`);
    for (const h of headers.slice(0, 40)) {
      console.log(`    col ${String(h.i).padStart(2)}: ${String(h.v).slice(0, 50)}`);
    }
    if (headers.length > 40) console.log(`    ... (${headers.length - 40} more columns)`);
  }

  // Detect ID-like column (first column with date-number pattern)
  const idCol = [];
  for (const row of rows.slice(1, 50)) {
    const v = row[0];
    if (v && String(v).match(/\d{1,2}\.\d{1,2}\.\d{2,4}-\d+/)) {
      idCol.push(String(v).trim());
    }
  }
  if (idCol.length > 0) {
    console.log(`\n  Sample source IDs found in col 0 (first ${Math.min(idCol.length, 8)}):`);
    for (const id of idCol.slice(0, 8)) console.log(`    ${id}`);
  }

  // Detect numeric data density
  let numericCells = 0, nullCells = 0, totalDataCells = 0;
  for (const row of nonEmpty) {
    for (const cell of row) {
      totalDataCells++;
      if (cell === null || String(cell).trim() === '') nullCells++;
      else if (!isNaN(parseFloat(String(cell).replace(',', '.')))) numericCells++;
    }
  }
  const nullPct = totalDataCells > 0 ? ((nullCells / totalDataCells) * 100).toFixed(1) : 'N/A';
  const numPct  = totalDataCells > 0 ? ((numericCells / totalDataCells) * 100).toFixed(1) : 'N/A';
  console.log(`\n  Data density:`);
  console.log(`    Total cells    : ${totalDataCells}`);
  console.log(`    NULL / empty   : ${nullCells} (${nullPct}%)`);
  console.log(`    Numeric values : ${numericCells} (${numPct}%)`);

  // Detect merged/label rows (rows with 1–2 non-null cells only — likely headers/labels)
  const labelRows = nonEmpty.filter(r =>
    r.filter(c => c !== null && String(c).trim() !== '').length <= 2
  );
  console.log(`    Label/header rows (≤2 cells): ${labelRows.length}`);
  if (labelRows.length > 0 && labelRows.length <= 5) {
    for (const r of labelRows) {
      const cells = r.filter(c => c !== null && String(c).trim() !== '');
      console.log(`      → "${cells.map(c => String(c).slice(0,40)).join(' | ')}"`);
    }
  }

  console.log();
}

console.log('═══════════════════════════════════════════════════════════════════════');
console.log('  END OF INSPECTION. No data was written or modified.');
console.log('═══════════════════════════════════════════════════════════════════════\n');
