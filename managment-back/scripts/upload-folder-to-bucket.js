#!/usr/bin/env node
/**
 * Upload a local folder (and all subfolders/files) to a Supabase Storage bucket.
 * Uses .env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (or NEXT_PUBLIC_SUPABASE_ANON_KEY)
 *
 * Usage:
 *   node scripts/upload-folder-to-bucket.js <path-to-folder> [bucket-name] [prefix]
 *
 * Examples:
 *   node scripts/upload-folder-to-bucket.js C:\Users\chaym\Downloads\MySharePointExport
 *   node scripts/upload-folder-to-bucket.js ./local-files sharepoint-files
 *   node scripts/upload-folder-to-bucket.js ./local-files sharepoint-files project-a
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { readdirSync, statSync, readFileSync } from 'fs';
import { join, relative } from 'path';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const folderPath = process.argv[2];
const bucketName = process.argv[3] || 'sharepoint-files';
const prefix = process.argv[4] || '';

if (!folderPath) {
  console.error('Usage: node scripts/upload-folder-to-bucket.js <path-to-folder> [bucket-name] [prefix]');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function* walkFiles(dir, baseDir = dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      yield* walkFiles(full, baseDir);
    } else {
      yield { fullPath: full, relativePath: relative(baseDir, full) };
    }
  }
}

/** Make a storage key safe for Supabase: ASCII only (Hebrew/special chars -> _). */
function safeStorageKey(relativePath) {
  const parts = relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.map(p => p.replace(/[^\x00-\x7E.a-zA-Z0-9_-]/g, '_').replace(/\s+/g, '_').replace(/[()[\]]/g, '_') || 'file').join('/');
}

async function main() {
  const files = [...walkFiles(folderPath)];
  console.log(`Found ${files.length} files. Bucket: ${bucketName}${prefix ? `, prefix: ${prefix}` : ''}`);
  let ok = 0;
  let err = 0;
  for (const { fullPath, relativePath } of files) {
    const safePath = safeStorageKey(relativePath);
    const storagePath = prefix ? `${prefix.replace(/\\/g, '/').replace(/\/$/, '')}/${safePath}` : safePath;
    try {
      const body = readFileSync(fullPath);
      const { error } = await supabase.storage.from(bucketName).upload(storagePath, body, { upsert: true });
      if (error) throw error;
      ok++;
      if (ok % 50 === 0) console.log(`Uploaded ${ok}/${files.length}...`);
    } catch (e) {
      err++;
      console.error(`Failed: ${storagePath}`, e.message);
    }
  }
  console.log(`Done. Uploaded: ${ok}, Failed: ${err}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
