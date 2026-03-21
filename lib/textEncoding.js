/**
 * Repair strings where UTF-8 bytes were decoded as Latin-1 (common with multipart filenames / paths).
 * Safe when the string already contains proper Hebrew — leaves it unchanged.
 */
export function repairUtf8MisdecodedAsLatin1(s) {
  if (s == null) return '';
  const str = typeof s === 'string' ? s : String(s);
  if (!str) return str;
  if (/[\u0590-\u05FF]/.test(str)) return str;
  try {
    const repaired = Buffer.from(str, 'latin1').toString('utf8');
    if (/[\u0590-\u05FF]/.test(repaired)) return repaired;
    if (str.includes('×') && repaired !== str && !/[\uFFFD]/.test(repaired)) return repaired;
  } catch (_) {
    /* ignore */
  }
  return str;
}

/** Strip BOM and decode .txt buffers: UTF-8 first; if invalid UTF-8, try Windows-1255 (common for Hebrew on Windows). */
export function decodeTextFileBuffer(buf) {
  if (!buf || buf.length === 0) return '';
  let start = 0;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) start = 3;
  const slice = Buffer.isBuffer(buf) ? buf.subarray(start) : Buffer.from(buf).subarray(start);
  const utf8 = slice.toString('utf8');
  const hasHigh = slice.some((b) => b >= 0x80);
  if (!hasHigh) return utf8;
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    const alt = new TextDecoder('windows-1255').decode(slice);
    if (/[\u0590-\u05FF]/.test(alt)) return alt;
  } catch (_) {
    /* encoding not supported */
  }
  return utf8;
}
