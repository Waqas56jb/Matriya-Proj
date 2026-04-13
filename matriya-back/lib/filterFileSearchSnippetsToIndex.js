/**
 * Keep file_search snippets tied to filenames still present in pgvector
 * (full path, OpenAI .txt upload name, basename, or logical name from sync header inside snippet text).
 */
import path from 'path';
import { safeUploadName } from './matriyaOpenAiSync.js';

/** Prepended to every OpenAI sync upload — extract logical Matriya path when API filename differs. */
const SNIPPET_LOGICAL_NAME_RE = /מקור מסמך \(שם קובץ במערכת\):\s*([^\n\r]+)/;

function logicalNameFromSnippetText(text) {
  const m = String(text || '').match(SNIPPET_LOGICAL_NAME_RE);
  return m ? m[1].trim() : '';
}

function filenameRowMatchesIndex(fn, exact, uploadNames, basenames) {
  const s = String(fn || '').trim();
  if (!s) return false;
  if (exact.has(s)) return true;
  if (uploadNames.has(s)) return true;
  if (basenames.has(s)) return true;
  const bn = path.basename(s.replace(/\\/g, '/'));
  if (basenames.has(bn)) return true;
  return false;
}

export function filterFileSearchSnippetsToIndex(snippets, indexFilenames) {
  const v = process.env.MATRIYA_SNIPPET_INDEX_FILTER;
  if (v === '0' || v === 'false') {
    return Array.isArray(snippets) ? snippets : [];
  }

  const list = Array.isArray(indexFilenames) ? indexFilenames.filter((x) => typeof x === 'string' && x.trim()) : [];
  const arr = Array.isArray(snippets) ? snippets : [];
  if (list.length === 0) return [];

  const exact = new Set(list);
  const uploadNames = new Set(list.map((f) => safeUploadName(f)));
  const basenames = new Set(list.map((f) => path.basename(String(f).replace(/\\/g, '/'))));

  return arr.filter((row) => {
    const body = String(row?.text ?? row?.excerpt ?? '');
    const fromHeader = logicalNameFromSnippetText(body);
    if (fromHeader) {
      if (exact.has(fromHeader)) return true;
      if (uploadNames.has(safeUploadName(fromHeader))) return true;
      const hBasename = path.basename(fromHeader.replace(/\\/g, '/'));
      if (basenames.has(hBasename)) return true;
    }
    return filenameRowMatchesIndex(row?.filename, exact, uploadNames, basenames);
  });
}
