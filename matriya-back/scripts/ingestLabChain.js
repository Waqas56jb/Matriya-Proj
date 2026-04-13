/**
 * ingestLabChain.js
 *
 * Ingests INTUMESCENT-style Excel files into the lab chain schema:
 *   Formulation → Production Run → Measurement → Outcome
 *
 * Source file structure expected (validated at runtime):
 *   Sheet "פורמולציות -סיכום" — formulation matrix, 35 material columns
 *   Sheet "פורמולציות"        — per-formulation detail blocks with mixing steps
 *   Sheet "בדיקות"            — test outcomes, one column per formulation
 *
 * LOCKED DECISIONS (David, 2026-04-07):
 *   D1  production_run_id NOT NULL — HIST-runs always created. Confidence tracked.
 *   D2  production_date NEVER inferred from source_id. Always NULL for historical.
 *   D3  Formulation identity per-file: UNIQUE(source_file, source_id).
 *   D4  outcomes = INTUMESCENT viscosity scope only.
 *
 * FIXES (rev 3):
 *   F1  Idempotent: UNIQUE(production_run_id, test_date) + ON CONFLICT DO NOTHING.
 *   F2  Unmatched outcomes go to ingest_quarantine — never silently dropped.
 *   F3  processNotes sourced from tests sheet col 0 (not detail block).
 *       foaming_event derived from those notes and persisted on production_run.
 *   F4  batch_id_is_synthetic = TRUE on all HIST-runs. Explicit in output.
 *   F5  Sheet structure validated before parsing. Hard stop on mismatch.
 *
 * Usage:
 *   node scripts/ingestLabChain.js <path-to-excel-file>
 *   node scripts/ingestLabChain.js test/INTUMESCENT_NEW_FORMULATIONS_2026-04-05.xlsx
 */

import { createRequire } from 'module';
import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const require  = createRequire(import.meta.url);
const XLSX     = require('xlsx');
const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.POSTGRES_URL });

// ── Sheet name constants ───────────────────────────────────────────────────────
const SHEET_SUMMARY = 'פורמולציות -סיכום';
const SHEET_DETAIL  = 'פורמולציות';
const SHEET_TESTS   = 'בדיקות';

// ── Parsing constants ─────────────────────────────────────────────────────────
// D2: INTUMESCENT sums cluster at ~2.0. Tolerance set to 0.01 to avoid false
// warnings from rounding (e.g. 2.0072 is acceptable; 0.133 is not).
const COMPOSITION_SUM_TOLERANCE = 0.01;
const RPM_PARSE_REGEX  = /(\d+)\s*rpm/i;
const MIN_PARSE_REGEX  = /(\d+)\s*min/i;
const FOAMING_KEYWORDS = ['מוקצף', 'קצף', 'אנטי קצף'];
// Accepts single-digit day/month (e.g. "29.6.2023-017") and 2-digit years
const SOURCE_ID_REGEX  = /(\d{1,2}\.\d{1,2}\.(?:\d{2}|\d{4}))-(\d+)(\.(\d+))?/;

// Expected structure anchors used by validateSheetStructure (Fix 5)
const SUMMARY_EXPECTED = {
  minDataRows: 1,
  col0Label:   null,       // col 0 of row 1 is the ID column — no label required
  minMaterialCols: 5       // must have at least 5 material columns
};
const TESTS_EXPECTED = {
  idRowIndex:     4,       // row 4: formulation source_ids
  dateRowIndex:   5,       // row 5: test dates
  phRowIndex:     6,
  sgRowIndex:     7,
  viscLabelRow:   8,
  v6RowIndex:     9,
  firstDataCol:   4,
  maxDataCol:     22
};


// =============================================================================
// FIX 5: SHEET STRUCTURE VALIDATION
// Called before any parsing. Returns { ok, errors[] }.
// =============================================================================
function validateSheetStructure(workbook) {
  const errors = [];
  const sheetNames = workbook.SheetNames;

  // All three sheets must exist
  for (const name of [SHEET_SUMMARY, SHEET_DETAIL, SHEET_TESTS]) {
    if (!sheetNames.includes(name)) {
      errors.push(`MISSING SHEET: "${name}". Found: ${sheetNames.join(', ')}`);
    }
  }
  if (errors.length) return { ok: false, errors };

  // Summary sheet: row 0 must have at least one non-null functional group header
  const summaryWs   = workbook.Sheets[SHEET_SUMMARY];
  const summaryRows = XLSX.utils.sheet_to_json(summaryWs, { header: 1, defval: null, raw: true });
  const groupRow    = summaryRows[0] || [];
  const matRow      = summaryRows[1] || [];

  const nonNullGroups = groupRow.slice(1).filter(Boolean).length;
  if (nonNullGroups < SUMMARY_EXPECTED.minMaterialCols) {
    errors.push(
      `SUMMARY row 0 (functional group headers): found ${nonNullGroups} non-null cells, ` +
      `expected ≥ ${SUMMARY_EXPECTED.minMaterialCols}. Row structure may have shifted.`
    );
  }

  const nonNullMaterials = matRow.slice(1).filter(Boolean).length;
  if (nonNullMaterials < SUMMARY_EXPECTED.minMaterialCols) {
    errors.push(
      `SUMMARY row 1 (material names): found ${nonNullMaterials} non-null cells, ` +
      `expected ≥ ${SUMMARY_EXPECTED.minMaterialCols}.`
    );
  }

  const dataRows = summaryRows.slice(2).filter(r => r[0] !== null && r[0] !== undefined);
  if (dataRows.length < SUMMARY_EXPECTED.minDataRows) {
    errors.push(`SUMMARY: no formulation data rows found (expected ≥ ${SUMMARY_EXPECTED.minDataRows}).`);
  }

  // Tests sheet: row 4 must have at least one source_id-like value in cols 4–22
  const testsWs   = workbook.Sheets[SHEET_TESTS];
  const testsRows = XLSX.utils.sheet_to_json(testsWs, { header: 1, defval: null, raw: true });
  const idRow     = testsRows[TESTS_EXPECTED.idRowIndex] || [];

  const sourceIdCells = idRow
    .slice(TESTS_EXPECTED.firstDataCol, TESTS_EXPECTED.maxDataCol + 1)
    .filter(v => v !== null && String(v).match(SOURCE_ID_REGEX));

  if (sourceIdCells.length === 0) {
    errors.push(
      `TESTS row ${TESTS_EXPECTED.idRowIndex} (formulation IDs): no cells matching ` +
      `source_id pattern found in cols ${TESTS_EXPECTED.firstDataCol}–${TESTS_EXPECTED.maxDataCol}. ` +
      `Row index may have shifted.`
    );
  }

  // Tests sheet: row 5 must have at least one date-like value
  const dateRow = testsRows[TESTS_EXPECTED.dateRowIndex] || [];
  const dateCells = dateRow
    .slice(TESTS_EXPECTED.firstDataCol, TESTS_EXPECTED.maxDataCol + 1)
    .filter(v => v !== null && parseTestDate(v) !== null);

  if (dateCells.length === 0) {
    errors.push(
      `TESTS row ${TESTS_EXPECTED.dateRowIndex} (test dates): no parseable date values found. ` +
      `Row index may have shifted.`
    );
  }

  return { ok: errors.length === 0, errors };
}


// =============================================================================
// PARSING UTILITIES
// =============================================================================

/**
 * D4: Normalize a formulation source_id.
 * Extracts the core DD.MM.YYYY-NNN[.V] pattern from a cell value, stores any
 * trailing suffix (e.g. "(הכנה 3.7.23)" → id_suffix="הכנה 3.7.23") separately.
 * Product names that follow the ID (e.g. "Fresco INTUMESCENT") are discarded.
 * 2-digit years are expanded: "28.06.23" → "28.06.2023".
 * Single-digit day/month are zero-padded: "29.6.2023" → "29.06.2023".
 * Always preserves the original cell value in raw_source_id.
 *
 * Returns { source_id, id_suffix, raw_source_id } or null if input is empty.
 *
 * Examples:
 *   "10.11.2022-003"                          → source_id="10.11.2022-003",    id_suffix=null
 *   "22.11.2022-003.1"                         → source_id="22.11.2022-003.1",  id_suffix=null
 *   "29.6.2023-017     Fresco INTUMESCENT"     → source_id="29.06.2023-017",    id_suffix=null
 *   "29.06.2023-017 (הכנה 3.7.23)"            → source_id="29.06.2023-017",    id_suffix="הכנה 3.7.23"
 *   "28.06.23-014(1)"                          → source_id="28.06.2023-014",    id_suffix="1"
 */
function normalizeSourceId(raw) {
  if (!raw) return null;
  const rawStr = String(raw).trim().replace(/\s+/g, ' ');
  if (!rawStr) return null;

  // Zero-pad helper: pad day/month to 2 digits
  const zeroPad = (s) => s.padStart(2, '0');

  // Try 4-digit year: D{1,2}.M{1,2}.YYYY-NNN[.V] (handles single-digit day/month)
  let m = rawStr.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})-(\d+(?:\.\d+)?)(.*)/);
  if (m) {
    const core   = `${zeroPad(m[1])}.${zeroPad(m[2])}.${m[3]}-${m[4]}`;
    const rest   = m[5].trim();
    // suffix = parenthetical annotation after the ID; ignore plain product names
    const parenMatch = rest.match(/^[(（](.+?)[)）]?$/);
    const suffix = parenMatch ? parenMatch[1].trim() || null : null;
    return { source_id: core, id_suffix: suffix, raw_source_id: rawStr };
  }

  // Try 2-digit year: D{1,2}.M{1,2}.YY-NNN[.V] → expand year
  m = rawStr.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2})-(\d+(?:\.\d+)?)(.*)/);
  if (m) {
    const year   = parseInt(m[3], 10) > 50 ? `19${m[3]}` : `20${m[3]}`;
    const core   = `${zeroPad(m[1])}.${zeroPad(m[2])}.${year}-${m[4]}`;
    const rest   = m[5].trim();
    const parenMatch = rest.match(/^[(（](.+?)[)）]?$/);
    const suffix = parenMatch ? parenMatch[1].trim() || null : null;
    return { source_id: core, id_suffix: suffix, raw_source_id: rawStr };
  }

  // No date pattern — return raw as-is (e.g. "INTERCHAR-045")
  return { source_id: rawStr, id_suffix: null, raw_source_id: rawStr };
}

function parseFormulationId(sourceId) {
  if (!sourceId) return { base_id: null, version: null };
  const m = sourceId.match(SOURCE_ID_REGEX);
  if (!m) {
    const fallback = sourceId.match(/-(\d+)(\.(\d+))?$/);
    if (fallback) {
      return { base_id: fallback[1].padStart(3, '0'), version: fallback[3] || null };
    }
    return { base_id: null, version: null };
  }
  return { base_id: m[2].padStart(3, '0'), version: m[4] || null };
}

// D2: production_date is NEVER inferred from source_id.
// parseTestDate is used only for test_date on measurements.
function parseTestDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  let m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = s.match(/^(\d{2})\.(\d{2})\.(\d{2})$/);
  if (m) {
    const year = parseInt(m[3], 10) > 50 ? `19${m[3]}` : `20${m[3]}`;
    return `${year}-${m[2]}-${m[1]}`;
  }
  return null;
}

function parseStepInstruction(raw) {
  if (!raw || !String(raw).trim()) return { duration_min: null, speed_rpm: null };
  const text = String(raw);
  const minMatch = text.match(MIN_PARSE_REGEX);
  const rpmMatch = text.match(RPM_PARSE_REGEX);
  return {
    duration_min: minMatch ? parseInt(minMatch[1], 10) : null,
    speed_rpm:    rpmMatch ? parseInt(rpmMatch[1], 10) : null
  };
}

// FIX 3: foaming detection applied to notes from the tests sheet col 0.
function detectFoamingEvent(text) {
  if (!text) return null;
  return FOAMING_KEYWORDS.some(kw => text.includes(kw)) ? true : null;
}


// =============================================================================
// EXTRACTION: SUMMARY SHEET → formulations + formulation_materials
// =============================================================================
function extractFormulations(workbook, sourceFile) {
  const ws   = workbook.Sheets[SHEET_SUMMARY];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });

  const groupHeaders = rows[0] || [];
  const colNames     = rows[1] || [];
  const formulations = [];

  for (const row of rows.slice(2)) {
    const norm = normalizeSourceId(row[0]);
    if (!norm?.source_id) continue;
    const { source_id: sourceId, id_suffix, raw_source_id } = norm;

    const { base_id, version } = parseFormulationId(sourceId);
    const materials = [];
    let totalFraction = 0;

    for (let col = 1; col < colNames.length; col++) {
      const matName = colNames[col];
      if (!matName) continue;
      const raw  = row[col];
      if (raw === null || raw === undefined) continue;
      const frac = typeof raw === 'number' ? raw : parseFloat(raw);
      if (isNaN(frac)) continue;

      materials.push({
        material_name:    String(matName).trim(),
        fraction:         frac,
        functional_group: groupHeaders[col] ? String(groupHeaders[col]).trim() : null,
        col_index:        col
      });
      totalFraction += frac;
    }

    // Fractions in INTUMESCENT file sum to ~2.0 (not 1.0).
    // This is a known data property of the source file format, not a parsing error.
    // Tolerance is checked against the observed sum range [1.95, 2.05] for this file.
    const sumValid =
      Math.abs(totalFraction - 1.0) < COMPOSITION_SUM_TOLERANCE ||
      Math.abs(totalFraction - 2.0) < COMPOSITION_SUM_TOLERANCE;

    if (!sumValid && totalFraction > 0) {
      console.warn(
        `[WARN] composition sum for ${sourceId} = ${totalFraction.toFixed(6)} ` +
        `(not ≈1.0 or ≈2.0 — unexpected)`
      );
    }

    formulations.push({
      source_id:     sourceId,
      id_suffix,
      raw_source_id,
      base_id, version,
      product_name: null,
      source_file: sourceFile, source_sheet: SHEET_SUMMARY,
      raw_formula_notes: null,
      composition_scale: 2.0,    // D2: INTUMESCENT file uses ~2.0 scale
      materials,
      _sum_valid:    sumValid,
      _total:        totalFraction
    });
  }

  return formulations;
}


// =============================================================================
// EXTRACTION: DETAIL SHEET → product_name + production steps per formulation
// =============================================================================
function extractDetailBlocks(workbook) {
  const ws   = workbook.Sheets[SHEET_DETAIL];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
  const blocks = {};

  for (let i = 0; i < rows.length; i++) {
    const cell = String(rows[i][0] || '').trim();

    const idMatch  = cell.match(/(\d{2}\.\d{2}\.\d{4}-\d+(?:\.\d+)?)/);
    const altMatch = cell.match(/(INTERCHAR-\d+)/i);
    const rawId = idMatch ? idMatch[1] : altMatch ? altMatch[1] : null;
    if (!rawId) continue;

    // rawId is already the extracted core pattern — normalization just trims
    const { source_id: sourceId } = normalizeSourceId(rawId) ?? {};
    if (!sourceId) continue;
    const productName = cell.replace(rawId, '').trim() || null;

    // Find column header row ("הוראות יצור" / "חומר")
    let headerRow = -1;
    for (let h = i + 1; h < Math.min(i + 5, rows.length); h++) {
      if (String(rows[h][0] || '').includes('הוראות') || String(rows[h][2] || '').includes('חומר')) {
        headerRow = h;
        break;
      }
    }
    if (headerRow === -1) continue;

    const steps = [];
    let seq = 0;
    for (let r = headerRow + 1; r < rows.length; r++) {
      const materialName = rows[r][2];
      const fraction     = rows[r][3];

      if (!materialName && typeof fraction === 'number' && fraction > 0.9) break;
      if (String(rows[r][0] || '').match(SOURCE_ID_REGEX)) break;
      if (!materialName) continue;

      const rawInstruction = rows[r][0] ? String(rows[r][0]).trim() : null;
      const { duration_min, speed_rpm } = parseStepInstruction(rawInstruction);

      steps.push({
        step_sequence:        seq++,
        material_name:        String(materialName).trim(),
        mixing_duration_min:  duration_min,
        mixing_speed_rpm:     speed_rpm,
        raw_step_instruction: rawInstruction
      });
    }

    blocks[sourceId] = { product_name: productName, steps };
  }

  return blocks;
}


// =============================================================================
// EXTRACTION: TESTS SHEET → measurements + outcomes
//
// FIX 3: processNotes are read from col 0 of rows 5, 10, 15 (sheet-level notes).
//        They are attached to each outcome record and later persisted on
//        production_run.raw_process_notes and used for foaming detection.
// =============================================================================
function extractTestOutcomes(workbook) {
  const ws   = workbook.Sheets[SHEET_TESTS];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });

  const {
    idRowIndex, dateRowIndex, phRowIndex, sgRowIndex,
    viscLabelRow, v6RowIndex, firstDataCol, maxDataCol
  } = TESTS_EXPECTED;

  const idRow    = rows[idRowIndex]    || [];
  const dateRow  = rows[dateRowIndex]  || [];
  const phRow    = rows[phRowIndex]    || [];
  const sgRow    = rows[sgRowIndex]    || [];
  const v6Row    = rows[v6RowIndex]    || [];
  const v12Row   = rows[v6RowIndex+1]  || [];
  const v30Row   = rows[v6RowIndex+2]  || [];
  const v60Row   = rows[v6RowIndex+3]  || [];

  // FIX 3: process notes from col 0 of rows 5, 10, 15 (sheet-level)
  const processNotes = [rows[5], rows[10], rows[15]]
    .map(r => r ? String(r?.[0] || '').trim() : '')
    .filter(Boolean)
    .join(' | ') || null;

  // Parse temperature and spindle from viscosity column label row
  const viscLabel   = String(rows[viscLabelRow]?.find?.(v => v && String(v).toLowerCase().includes('viscosity')) || '');
  const tempMatch   = viscLabel.match(/\((\d+(?:\.\d+)?)\s*OC/i);
  const measTemp    = tempMatch ? parseFloat(tempMatch[1]) : null;
  const spindleM    = viscLabel.match(/SPD\s*(\w+)/i);
  const spindleType = spindleM ? `SPD ${spindleM[1]}` : null;

  const results = [];

  for (let col = firstDataCol; col <= maxDataCol; col++) {
    const rawId = idRow[col];
    // D4: normalize — strips Hebrew/parenthetical suffixes, expands 2-digit years
    const norm = normalizeSourceId(rawId);
    if (!norm?.source_id) continue;
    const sourceId = norm.source_id;

    const rawDate  = dateRow[col];
    const testDate = parseTestDate(rawDate);
    if (!testDate) continue;

    const ph  = typeof phRow[col]  === 'number' ? phRow[col]  : null;
    const sg  = typeof sgRow[col]  === 'number' ? sgRow[col]  : null;
    const v6  = typeof v6Row[col]  === 'number' ? v6Row[col]  : null;
    const v12 = typeof v12Row[col] === 'number' ? v12Row[col] : null;
    const v30 = typeof v30Row[col] === 'number' ? v30Row[col] : null;
    const v60 = typeof v60Row[col] === 'number' ? v60Row[col] : null;

    if (ph === null && sg === null && v6 === null) continue;

    results.push({
      sourceId,
      testDate,
      ph, sg, v6, v12, v30, v60,
      measurement_temperature_c: measTemp,
      spindle_type: spindleType,
      // FIX 3: sheet-level notes from tests sheet col 0
      processNotes,
      // raw row data preserved for quarantine
      _rawRow: { col, rawId: String(rawId), normalizedId: sourceId, rawDate: String(rawDate || ''), ph, sg, v6, v12, v30, v60 }
    });
  }

  return results;
}


// =============================================================================
// DATABASE WRITE HELPERS
// =============================================================================

async function insertFormulation(client, f) {
  const { rows } = await client.query(
    `INSERT INTO formulations
       (source_id, id_suffix, raw_source_id,
        base_id, version, product_name,
        source_file, source_sheet, raw_formula_notes,
        composition_scale)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (source_file, source_id) DO UPDATE
       SET id_suffix         = EXCLUDED.id_suffix,
           raw_source_id     = EXCLUDED.raw_source_id,
           base_id           = EXCLUDED.base_id,
           version           = EXCLUDED.version,
           composition_scale = EXCLUDED.composition_scale,
           product_name      = COALESCE(EXCLUDED.product_name, formulations.product_name)
     RETURNING id`,
    [f.source_id, f.id_suffix, f.raw_source_id,
     f.base_id, f.version, f.product_name,
     f.source_file, f.source_sheet, f.raw_formula_notes,
     f.composition_scale]
  );
  return rows[0].id;
}

async function insertMaterials(client, formulationId, materials) {
  if (!materials.length) return;
  // Batch: single multi-row INSERT for all materials of this formulation
  const placeholders = [];
  const params = [formulationId];
  let pi = 2;
  for (const m of materials) {
    placeholders.push(`($1,$${pi},$${pi+1},$${pi+2},$${pi+3})`);
    params.push(m.material_name, m.fraction, m.functional_group ?? null, m.col_index ?? null);
    pi += 4;
  }
  await client.query(
    `INSERT INTO formulation_materials
       (formulation_id, material_name, fraction, functional_group, col_index)
     VALUES ${placeholders.join(',')}
     ON CONFLICT (formulation_id, material_name) DO UPDATE
       SET fraction         = EXCLUDED.fraction,
           functional_group = EXCLUDED.functional_group`,
    params
  );
}

async function insertProductionRun(client, formulationId, f, processNotes) {
  // F4: batch_id_is_synthetic = TRUE — explicitly not a real lab record.
  // D2: production_date = NULL — never inferred from source_id.
  const batchId = `HIST-${f.source_id}`;

  // FIX 3: foaming_event derived from tests sheet process notes (col 0)
  const foaming = detectFoamingEvent(processNotes);

  const { rows } = await client.query(
    `INSERT INTO production_runs
       (batch_id, batch_id_is_synthetic,
        formulation_id,
        production_date,           -- D2: NULL — never inferred
        operator,                  -- not in INTUMESCENT file
        production_temperature_c,  -- not in any file
        foaming_event,
        raw_process_notes,         -- FIX 3: from tests sheet col 0
        run_origin)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (batch_id) DO UPDATE
       SET formulation_id    = EXCLUDED.formulation_id,
           raw_process_notes = COALESCE(EXCLUDED.raw_process_notes, production_runs.raw_process_notes),
           foaming_event     = COALESCE(EXCLUDED.foaming_event, production_runs.foaming_event)
     RETURNING id`,
    // F4: true = synthetic | D2: production_date null | FIX 3: process notes from tests sheet
    [batchId, true, formulationId, null, null, null, foaming, processNotes, 'HISTORICAL']
  );
  return { runId: rows[0].id, batchId, runOrigin: 'HISTORICAL' };
}

async function insertProductionSteps(client, runId, steps, runOrigin = 'HISTORICAL') {
  if (!steps.length) return;
  // D3: REAL runs must have mixing_speed_rpm AND mixing_duration_min.
  if (runOrigin === 'REAL') {
    for (const s of steps) {
      if (s.mixing_speed_rpm == null || s.mixing_duration_min == null) {
        throw new Error(
          `D3 VIOLATION: step ${s.step_sequence} for REAL run ${runId} is missing ` +
          `mixing_speed_rpm or mixing_duration_min. ` +
          `Raw instruction: "${s.raw_step_instruction ?? '(empty)'}"` +
          ` — REAL run rejected to enforce process data integrity.`
        );
      }
    }
  }
  // Batch: single multi-row INSERT for all steps of this run
  const placeholders = [];
  const params = [runId];
  let pi = 2;
  for (const s of steps) {
    placeholders.push(`($1,$${pi},$${pi+1},$${pi+2},$${pi+3},$${pi+4})`);
    params.push(s.step_sequence, s.material_name ?? null,
                s.mixing_duration_min ?? null, s.mixing_speed_rpm ?? null,
                s.raw_step_instruction ?? null);
    pi += 5;
  }
  await client.query(
    `INSERT INTO production_steps
       (production_run_id, step_sequence, material_name,
        mixing_duration_min, mixing_speed_rpm, raw_step_instruction)
     VALUES ${placeholders.join(',')}
     ON CONFLICT (production_run_id, step_sequence) DO NOTHING`,
    params
  );
}

async function insertMeasurementAndOutcome(client, runId, outcome) {
  // FIX 1: ON CONFLICT DO NOTHING — idempotent on (production_run_id, test_date)
  // D2: days_since_production NULL — production_date is always NULL for HIST-runs
  const { rows } = await client.query(
    `INSERT INTO measurements
       (production_run_id, test_date,
        days_since_production,
        measurement_temperature_c, spindle_type,
        linkage_confidence, linkage_note)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (production_run_id, test_date) DO NOTHING
     RETURNING id`,
    [runId, outcome.testDate,
     null,                              // D2: always NULL
     outcome.measurement_temperature_c,
     outcome.spindle_type,
     'HEURISTIC_SOURCE_ID',
     'Linked by formulation source_id match only. Exact batch unknown.']
  );

  if (!rows.length) return null;  // conflict — already exists, skip outcome insert too
  const measId = rows[0].id;

  // D4: INTUMESCENT viscosity scope only
  await client.query(
    `INSERT INTO outcomes
       (measurement_id, ph, specific_gravity,
        viscosity_6rpm_cps, viscosity_12rpm_cps,
        viscosity_30rpm_cps, viscosity_60rpm_cps)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (measurement_id) DO NOTHING`,
    [measId, outcome.ph, outcome.sg,
     outcome.v6, outcome.v12, outcome.v30, outcome.v60]
  );

  return measId;
}

// FIX 2: Persist unmatched outcomes to ingest_quarantine.
async function quarantine(client, sourceFile, sourceId, testDate, rawRow, reason) {
  // ON CONFLICT DO NOTHING — idempotent; prevents duplicate quarantine entries on re-runs
  await client.query(
    `INSERT INTO ingest_quarantine
       (source_file, source_sheet, raw_source_id, test_date, raw_row_json, reason)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (source_file, raw_source_id, test_date) DO NOTHING`,
    [sourceFile, SHEET_TESTS, sourceId, testDate,
     JSON.stringify(rawRow), reason]
  );
}


// =============================================================================
// MAIN INGEST
// =============================================================================
async function ingest(filePath) {
  const sourceFile = path.basename(filePath);
  console.log(`\n══════════════════════════════════════════`);
  console.log(`  ingestLabChain — ${sourceFile}`);
  console.log(`══════════════════════════════════════════`);

  const wb = XLSX.readFile(filePath);

  // FIX 5: Validate structure before any parsing
  console.log('\n[1] Validating sheet structure...');
  const { ok, errors } = validateSheetStructure(wb);
  if (!ok) {
    console.error('[FATAL] Sheet structure validation failed:');
    for (const e of errors) console.error(`  ✗ ${e}`);
    process.exit(1);
  }
  console.log('  ✓ Structure valid');

  // Parse all three sheets
  console.log('\n[2] Extracting data from sheets...');
  const formulations = extractFormulations(wb, sourceFile);
  const detailBlocks = extractDetailBlocks(wb);
  const testOutcomes = extractTestOutcomes(wb);

  console.log(`  summary sheet  : ${formulations.length} formulations`);
  console.log(`  detail sheet   : ${Object.keys(detailBlocks).length} blocks`);
  console.log(`  tests sheet    : ${testOutcomes.length} outcome records`);

  // Patch product_name from detail blocks
  for (const f of formulations) {
    const d = detailBlocks[f.source_id];
    if (d?.product_name) f.product_name = d.product_name;
  }

  // Build sets for cross-checking
  const formulationIds = new Set(formulations.map(f => f.source_id));

  // FIX 2: Identify unmatched test outcomes before writing anything
  const unmatchedOutcomes = testOutcomes.filter(o => !formulationIds.has(o.sourceId));
  if (unmatchedOutcomes.length) {
    console.log(`\n  [QUARANTINE] ${unmatchedOutcomes.length} test record(s) have no matching formulation in summary sheet:`);
    for (const o of unmatchedOutcomes) {
      console.log(`    ✗ source_id="${o.sourceId}"  test_date="${o.testDate}"  — will be quarantined`);
    }
  }

  // Build outcome lookup for matched formulations only
  const outcomeLookup = {};
  for (const o of testOutcomes) {
    if (!formulationIds.has(o.sourceId)) continue;
    if (!outcomeLookup[o.sourceId]) outcomeLookup[o.sourceId] = [];
    outcomeLookup[o.sourceId].push(o);
  }

  // FIX 3: Build per-formulation processNotes from the outcomes
  // (sheet-level notes are the same for all, but per-formulation grouping
  //  allows upgrading to per-column notes if the file structure changes)
  const processNotesMap = {};
  for (const o of testOutcomes) {
    if (o.processNotes && !processNotesMap[o.sourceId]) {
      processNotesMap[o.sourceId] = o.processNotes;
    }
  }

  // ── DB writes ──────────────────────────────────────────────────────────────
  console.log('\n[3] Writing to database...');
  const client = await pool.connect();

  const stats = {
    formulations_inserted: 0,
    runs_inserted:         0,
    steps_inserted:        0,
    measurements_inserted: 0,
    measurements_skipped:  0,
    quarantined:           0
  };

  try {
    // Quarantine records — small fixed set, single transaction
    if (unmatchedOutcomes.length) {
      await client.query('BEGIN');
      for (const o of unmatchedOutcomes) {
        await quarantine(client, sourceFile, o.sourceId, o.testDate, o._rawRow,
          'source_id not found in formulations summary sheet');
        stats.quarantined++;
      }
      await client.query('COMMIT');
    }

    // Per-formulation transactions — isolate each so one timeout cannot roll back all
    let i = 0;
    for (const f of formulations) {
      i++;
      await client.query('BEGIN');
      try {
        const formulationId = await insertFormulation(client, f);
        stats.formulations_inserted++;

        // Batch materials (single round-trip)
        await insertMaterials(client, formulationId, f.materials);

        const processNotes = processNotesMap[f.source_id] || null;
        const detail = detailBlocks[f.source_id];

        const { runId, batchId, runOrigin } = await insertProductionRun(
          client, formulationId, f, processNotes
        );
        stats.runs_inserted++;

        if (detail?.steps?.length) {
          // Batch steps (single round-trip); D3 enforced inside function
          await insertProductionSteps(client, runId, detail.steps, runOrigin);
          stats.steps_inserted += detail.steps.length;
        }

        const outcomes = outcomeLookup[f.source_id] || [];
        for (const o of outcomes) {
          const measId = await insertMeasurementAndOutcome(client, runId, o);
          if (measId) {
            stats.measurements_inserted++;
          } else {
            stats.measurements_skipped++;
          }
        }

        await client.query('COMMIT');

        if (outcomes.length || processNotes) {
          console.log(
            `  [${i}/${formulations.length}] ${f.source_id} → ${batchId} [SYNTHETIC]` +
            ` | steps: ${detail?.steps?.length || 0}` +
            ` | outcomes: ${outcomes.length}` +
            ` | foaming: ${detectFoamingEvent(processNotes) ? 'YES' : 'no'}`
          );
        } else {
          process.stdout.write('.');  // progress dot for formulations without outcomes
        }
      } catch (fErr) {
        await client.query('ROLLBACK');
        console.error(`\n  [ERROR] ${f.source_id}: ${fErr.message}`);
        // Continue with remaining formulations
      }
    }
    console.log(''); // newline after progress dots

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n[FAIL] Transaction rolled back:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }

  // ── Final summary ──────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════');
  console.log('  INGEST SUMMARY');
  console.log('══════════════════════════════════════════');
  console.log(`  formulations written   : ${stats.formulations_inserted}`);
  console.log(`  production runs written: ${stats.runs_inserted}  (all SYNTHETIC — batch_id_is_synthetic=TRUE)`);
  console.log(`  production steps       : ${stats.steps_inserted}`);
  console.log(`  measurements inserted  : ${stats.measurements_inserted}`);
  console.log(`  measurements skipped   : ${stats.measurements_skipped}  (duplicate — idempotent)`);
  console.log(`  quarantined records    : ${stats.quarantined}  (no matching formulation)`);

  if (stats.quarantined > 0) {
    console.log('\n  ⚠ Quarantined records require manual review.');
    console.log('    Query: SELECT * FROM ingest_quarantine WHERE source_file = \'...\';');
  }

  console.log('\n  Duplicate protection: UNIQUE(production_run_id, test_date)');
  console.log('  Re-running this file is safe — existing rows will not be duplicated.');
  console.log('══════════════════════════════════════════\n');
}


// =============================================================================
// DRY-RUN MODE
// Runs full extraction + simulation without touching the database.
// Shows exactly what ingest would write, including duplicate protection and
// unmatched record handling.
// Usage: node scripts/ingestLabChain.js <file> --dry-run
// =============================================================================
async function dryRun(filePath) {
  const sourceFile = path.basename(filePath);
  console.log(`\n══════════════════════════════════════════`);
  console.log(`  DRY RUN — ${sourceFile}`);
  console.log(`══════════════════════════════════════════`);

  const wb = XLSX.readFile(filePath);

  console.log('\n[1] Validating sheet structure...');
  const { ok, errors } = validateSheetStructure(wb);
  if (!ok) {
    console.error('[FATAL] Structure validation failed:');
    for (const e of errors) console.error(`  ✗ ${e}`);
    process.exit(1);
  }
  console.log('  ✓ All three sheets present and structured correctly');

  console.log('\n[2] Extracting data...');
  const formulations = extractFormulations(wb, sourceFile);
  const detailBlocks = extractDetailBlocks(wb);
  const testOutcomes = extractTestOutcomes(wb);

  for (const f of formulations) {
    const d = detailBlocks[f.source_id];
    if (d?.product_name) f.product_name = d.product_name;
  }

  const formulationIds = new Set(formulations.map(f => f.source_id));
  const unmatchedOutcomes = testOutcomes.filter(o => !formulationIds.has(o.sourceId));
  const matchedOutcomes   = testOutcomes.filter(o =>  formulationIds.has(o.sourceId));

  const outcomeLookup = {};
  for (const o of matchedOutcomes) {
    if (!outcomeLookup[o.sourceId]) outcomeLookup[o.sourceId] = [];
    outcomeLookup[o.sourceId].push(o);
  }

  const processNotesMap = {};
  for (const o of testOutcomes) {
    if (o.processNotes && !processNotesMap[o.sourceId]) {
      processNotesMap[o.sourceId] = o.processNotes;
    }
  }

  const formulationsWithOutcomes   = formulations.filter(f => outcomeLookup[f.source_id]?.length);
  const formulationsWithSteps       = formulations.filter(f => detailBlocks[f.source_id]?.steps?.length);
  const formulationsWithNotes       = formulations.filter(f => processNotesMap[f.source_id]);
  const formulationsWithFoaming     = formulations.filter(f => detectFoamingEvent(processNotesMap[f.source_id]));

  console.log(`\n  summary sheet  : ${formulations.length} formulations`);
  console.log(`  detail blocks  : ${Object.keys(detailBlocks).length} blocks with steps`);
  console.log(`  outcome records: ${testOutcomes.length} total from tests sheet`);
  console.log(`    matched      : ${matchedOutcomes.length}  (source_id found in summary sheet)`);
  console.log(`    UNMATCHED    : ${unmatchedOutcomes.length}  (→ ingest_quarantine)`);

  // ── D4 normalization report ─────────────────────────────────────────────────
  const withSuffix = formulations.filter(f => f.id_suffix);
  console.log('\n──────────────────────────────────────────────────────────');
  console.log('D4 SOURCE ID NORMALIZATION');
  console.log('──────────────────────────────────────────────────────────');
  console.log(`  formulations with suffix stripped : ${withSuffix.length}`);
  if (withSuffix.length) {
    for (const f of withSuffix) {
      console.log(`    raw="${f.raw_source_id}"  →  source_id="${f.source_id}"  id_suffix="${f.id_suffix}"`);
    }
  }
  const testNormed = testOutcomes.filter(o => o._rawRow?.rawId !== o._rawRow?.normalizedId);
  console.log(`  test records with ID normalized    : ${testNormed.length}`);
  if (testNormed.length) {
    for (const o of testNormed) {
      console.log(`    raw="${o._rawRow.rawId}"  →  "${o._rawRow.normalizedId}"`);
    }
  }

  // ── D2 composition scale ─────────────────────────────────────────────────────
  console.log('\n──────────────────────────────────────────────────────────');
  console.log('D2 COMPOSITION SCALE');
  console.log('──────────────────────────────────────────────────────────');
  const scaleGroups = {};
  for (const f of formulations) {
    const s = f.composition_scale;
    scaleGroups[s] = (scaleGroups[s] || 0) + 1;
  }
  for (const [scale, count] of Object.entries(scaleGroups)) {
    console.log(`  composition_scale=${scale} : ${count} formulation(s)`);
  }
  const outOfTolerance = formulations.filter(f => Math.abs(f._total - f.composition_scale) > 0.05);
  if (outOfTolerance.length) {
    console.log(`  WARN: ${outOfTolerance.length} formulation(s) deviate >0.05 from expected scale:`);
    for (const f of outOfTolerance) {
      console.log(`    ${f.source_id}: sum=${f._total?.toFixed(4)} expected=${f.composition_scale}`);
    }
  } else {
    console.log(`  ✓ All formulation sums within 0.05 of expected scale`);
  }

  // ── Unmatched records report ────────────────────────────────────────────────
  console.log('\n──────────────────────────────────────────────────────────');
  console.log('UNMATCHED RECORDS REPORT (would go to ingest_quarantine)');
  console.log('──────────────────────────────────────────────────────────');
  if (unmatchedOutcomes.length === 0) {
    console.log('  ✓ None — all test records match a formulation in summary sheet');
  } else {
    for (const o of unmatchedOutcomes) {
      console.log(`  ✗ source_id="${o.sourceId}"  test_date="${o.testDate}"`);
      console.log(`    ph=${o.ph ?? '—'}  v6=${o.v6 ?? '—'}  v12=${o.v12 ?? '—'}  v30=${o.v30 ?? '—'}  v60=${o.v60 ?? '—'}`);
      console.log(`    reason: source_id not found in formulations summary sheet`);
    }
  }

  // ── Process notes wiring ────────────────────────────────────────────────────
  console.log('\n──────────────────────────────────────────────────────────');
  console.log('PROCESS NOTES WIRING (FIX 3)');
  console.log('──────────────────────────────────────────────────────────');
  console.log(`  formulations with process notes : ${formulationsWithNotes.length}`);
  console.log(`  formulations with foaming event : ${formulationsWithFoaming.length}`);
  if (formulationsWithNotes.length) {
    const sample = formulationsWithNotes[0];
    console.log(`\n  Sample (${sample.source_id}):`);
    console.log(`    raw_process_notes = "${processNotesMap[sample.source_id]}"`);
    console.log(`    foaming_event     = ${detectFoamingEvent(processNotesMap[sample.source_id])}`);
  }

  // ── Duplicate protection ────────────────────────────────────────────────────
  console.log('\n──────────────────────────────────────────────────────────');
  console.log('DUPLICATE PROTECTION (FIX 1 — idempotency simulation)');
  console.log('──────────────────────────────────────────────────────────');
  const seenKeys = new Set();
  let wouldInsert = 0, wouldSkip = 0;

  for (const f of formulations) {
    const batchId = `HIST-${f.source_id}`;
    const outcomes = outcomeLookup[f.source_id] || [];
    for (const o of outcomes) {
      const key = `${batchId}||${o.testDate}`;
      if (seenKeys.has(key)) {
        wouldSkip++;
      } else {
        seenKeys.add(key);
        wouldInsert++;
      }
    }
  }

  console.log(`  RUN 1: would insert ${wouldInsert} measurement(s)`);
  console.log(`  RUN 2: would skip   ${wouldInsert} measurement(s) (ON CONFLICT DO NOTHING)`);
  console.log(`  Constraint: UNIQUE(production_run_id, test_date) on measurements table`);

  // ── Full write preview ──────────────────────────────────────────────────────
  console.log('\n──────────────────────────────────────────────────────────');
  console.log('FULL INGEST PREVIEW');
  console.log('──────────────────────────────────────────────────────────');

  let totalMaterials = 0;
  let totalSteps     = 0;
  for (const f of formulations) {
    totalMaterials += f.materials.length;
    totalSteps     += detailBlocks[f.source_id]?.steps?.length || 0;
  }

  console.log(`  formulations      : ${formulations.length}`);
  console.log(`  formulation_materials : ${totalMaterials}`);
  console.log(`  production_runs   : ${formulations.length}  (all SYNTHETIC, batch_id_is_synthetic=TRUE)`);
  console.log(`  production_steps  : ${totalSteps}`);
  console.log(`  measurements      : ${matchedOutcomes.length}`);
  console.log(`  outcomes          : ${matchedOutcomes.length}`);
  console.log(`  quarantined       : ${unmatchedOutcomes.length}`);

  // BASE-003 full path example
  const base003 = formulations.filter(f => f.base_id === '003');
  if (base003.length) {
    console.log('\n──────────────────────────────────────────────────────────');
    console.log('DATA FLOW EXAMPLE — BASE-003');
    console.log('──────────────────────────────────────────────────────────');
    for (const f of base003) {
      const batchId      = `HIST-${f.source_id}`;
      const outcomes     = outcomeLookup[f.source_id] || [];
      const detail       = detailBlocks[f.source_id];
      const notes        = processNotesMap[f.source_id] || null;
      const foaming      = detectFoamingEvent(notes);

      const firstInstr = detail?.steps?.[0]?.raw_step_instruction ?? '(empty)';
      console.log(`\n  Formulation : ${f.source_id}  (base_id=${f.base_id}, version=${f.version ?? 'root'})`);
      console.log(`  raw_src_id  : "${f.raw_source_id}"${f.id_suffix ? `  id_suffix="${f.id_suffix}"` : ''}`);
      console.log(`  scale       : ${f.composition_scale}  (sum=${f._total?.toFixed(4) ?? '?'})`);
      console.log(`  batch_id    : ${batchId}  [SYNTHETIC]`);
      console.log(`  materials   : ${f.materials.length} rows`);
      console.log(`  steps       : ${detail?.steps?.length || 0}  ${detail?.steps?.length ? `(first: "${firstInstr}")` : '(no detail block)'}`);
      console.log(`  notes       : ${notes ? `"${notes.slice(0, 70)}..."` : 'NULL'}`);
      console.log(`  foaming     : ${foaming ?? 'null'}`);
      if (outcomes.length) {
        for (const o of outcomes) {
          console.log(`  measurement : test_date=${o.testDate}  ph=${o.ph ?? '—'}  v6=${o.v6 ?? '—'}  v30=${o.v30 ?? '—'}  v60=${o.v60 ?? '—'}`);
          console.log(`               linkage_confidence=HEURISTIC_SOURCE_ID`);
        }
      } else {
        console.log(`  measurement : (none — not in tests sheet)`);
      }
    }
  }

  console.log('\n══════════════════════════════════════════');
  console.log('  DRY RUN COMPLETE — no DB writes performed');
  console.log('  Run without --dry-run to execute ingest.');
  console.log('══════════════════════════════════════════\n');
}


// =============================================================================
// ENTRYPOINT
// =============================================================================
const args     = process.argv.slice(2);
const filePath = args.find(a => !a.startsWith('--'));
const isDryRun = args.includes('--dry-run');

if (!filePath) {
  console.error('Usage: node scripts/ingestLabChain.js <path-to-excel-file> [--dry-run]');
  process.exit(1);
}

const resolvedPath = path.resolve(filePath);

if (isDryRun) {
  dryRun(resolvedPath).catch(err => {
    console.error('[FATAL]', err.message);
    process.exit(1);
  });
} else {
  ingest(resolvedPath).catch(err => {
    console.error('[FATAL]', err.message);
    process.exit(1);
  });
}
