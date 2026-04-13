#!/usr/bin/env node
/**
 * Compare local folder file count with Supabase bucket object count.
 * Usage: node scripts/check-bucket-upload.js [path-to-folder] [bucket-name]
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { readdirSync } from 'fs';
import { join } from 'path';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const folderPath = process.argv[2] || 'C:\\Users\\chaym\\Downloads\\sharepoint-files';
const bucketName = process.argv[3] || 'sharepoint-files';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function countLocalFiles(dir) {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) n += countLocalFiles(full);
    else n += 1;
  }
  return n;
}

async function countBucketFiles(prefix = '') {
  const { data, error } = await supabase.storage.from(bucketName).list(prefix, { limit: 1000 });
  if (error) throw error;
  let count = 0;
  for (const item of data || []) {
    if (item.id != null) count += 1;
    if (item.name && item.id == null) {
      const subPath = prefix ? `${prefix}/${item.name}` : item.name;
      count += await countBucketFiles(subPath);
    }
  }
  return count;
}

async function main() {
  let localCount;
  try {
    localCount = countLocalFiles(folderPath);
  } catch (e) {
    console.error('Local folder error:', e.message);
    process.exit(1);
  }
  console.log('Local folder:', folderPath);
  console.log('Local file count:', localCount);

  let bucketCount;
  try {
    bucketCount = await countBucketFiles('');
    console.log('Bucket:', bucketName);
    console.log('Bucket file count:', bucketCount);
  } catch (e) {
    console.error('Bucket error:', e.message);
    process.exit(1);
  }

  console.log('');
  if (bucketCount >= localCount) {
    console.log('Result: All local files are in the bucket.');
  } else {
    console.log('Result: Missing', localCount - bucketCount, 'files in bucket.');
  }
}

main();
