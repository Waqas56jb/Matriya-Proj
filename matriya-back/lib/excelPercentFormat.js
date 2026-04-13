/**
 * Excel often stores component shares as decimals (0.14528 = 14.528%).
 * Normalize for RAG / Ask Matriya text: display as percent (×100) and validate composition rows.
 */

const SUM_LOW = 0.999; // sum of fractions ≥ this → OK (100% − 0.1 pp)
const SUM_HIGH = 1.001; // sum of fractions ≤ this → OK (100% + 0.1 pp)
const INVALID_MARK = ' [INVALID OUTPUT: row sum not 100%±0.1]';

export function parseExcelCellNumber(cell) {
  if (cell === '' || cell == null) return null;
  if (cell instanceof Date) return null;
  if (typeof cell === 'number' && Number.isFinite(cell)) return cell;
  const sRaw = String(cell).trim().replace(/,/g, '');
  if (!sRaw) return null;
  if (/^[\d.+-eE]+\s*%$/.test(sRaw)) {
    const n = Number(sRaw.replace('%', '').trim());
    if (!Number.isFinite(n)) return null;
    return n / 100;
  }
  const n = Number(sRaw);
  return Number.isFinite(n) ? n : null;
}

/** User-facing cell text for indexed Excel (fractions → N.NN%). */
export function formatExcelCellForRAG(cell) {
  if (cell === '' || cell == null) return '';
  if (cell instanceof Date) {
    try {
      return cell.toISOString().slice(0, 10);
    } catch (_) {
      return '';
    }
  }
  const sRaw = String(cell).trim();
  if (!sRaw) return '';
  if (/^[\d.,]+\s*%$/i.test(sRaw)) {
    const n = Number(sRaw.replace(/%/gi, '').replace(/,/g, '').trim());
    if (Number.isFinite(n)) return `${n.toFixed(2)}%`;
  }
  const n = typeof cell === 'number' && Number.isFinite(cell) ? cell : Number(sRaw.replace(/,/g, ''));
  if (!Number.isFinite(n)) return sRaw.replace(/\0/g, '');
  if (n === 0) return '0%';
  if (n > 0 && n < 1) return `${(n * 100).toFixed(2)}%`;
  if (n === 1) return '100%';
  if (n > 1 && n <= 100) return `${n.toFixed(2)}%`;
  return String(n);
}

/**
 * If row has 2+ values in [0,1] (composition-like), sum must be in [SUM_LOW, SUM_HIGH].
 * Rows mixing (0,1) with (1,100] magnitudes skip validation.
 */
export function excelCompositionRowSuffix(row) {
  if (!Array.isArray(row) || row.length === 0) return '';
  const inUnitInterval = [];
  for (const cell of row) {
    const n = parseExcelCellNumber(cell);
    if (n === null) continue;
    if (n < 0) return '';
    if (n > 1 && n <= 100) return '';
    if (n > 100) return '';
    if (n >= 0 && n <= 1) inUnitInterval.push(n);
  }
  if (inUnitInterval.length < 2) return '';
  const sum = inUnitInterval.reduce((a, b) => a + b, 0);
  if (sum >= SUM_LOW && sum <= SUM_HIGH) return '';
  return INVALID_MARK;
}
