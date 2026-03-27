/**
 * Pure checks: does an indexed row's metadata match search filterMetadata?
 * Mirrors vectorStoreSupabase.search WHERE logic (no DB).
 */
import path from 'path';

/**
 * @param {string} filterVal - user-selected path or basename
 * @param {string} indexedFilename - metadata.filename from DB
 */
export function filenameMatchesSingleFilter(filterVal, indexedFilename) {
  const f = String(filterVal || '').trim();
  const idx = String(indexedFilename || '').trim();
  if (!f || !idx) return false;
  if (idx === f) return true;
  if (idx.endsWith(f) || idx.includes(f)) return true;
  const base = path.basename(f);
  const idxBase = path.basename(idx);
  if (base && (idx === base || idx.endsWith('/' + base) || idxBase === base)) return true;
  return false;
}

/**
 * @param {Record<string, unknown>|null|undefined} metadata
 * @param {Record<string, unknown>|null|undefined} filterMetadata
 * @returns {boolean}
 */
export function rowMetadataMatchesFilter(metadata, filterMetadata) {
  if (!filterMetadata || typeof filterMetadata !== 'object') return true;
  const fn = metadata?.filename != null ? String(metadata.filename) : '';
  const files = filterMetadata.filenames;
  if (Array.isArray(files) && files.length > 0) {
    return files.some((f) => typeof f === 'string' && filenameMatchesSingleFilter(f, fn));
  }
  const one = filterMetadata.filename;
  if (typeof one === 'string' && one.trim()) {
    return filenameMatchesSingleFilter(one, fn);
  }
  return true;
}
