/**
 * Runs test:unit then test:integration with BASE_URL defaulting to http://127.0.0.1:8000.
 * If MATRIYA_TEST_JWT is set, also runs test:ask-matriya-david.
 */
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');

const env = { ...process.env, BASE_URL: baseUrl };

function run(label, cmd) {
  console.log(`\n[run-test-live] ${label}\n`);
  execSync(cmd, { cwd: root, stdio: 'inherit', env });
}

console.log(`[run-test-live] BASE_URL=${baseUrl}`);

try {
  run('test:unit', 'npm run test:unit');
  run('test:integration', 'npm run test:integration');
  if ((process.env.MATRIYA_TEST_JWT || '').trim()) {
    run('test:ask-matriya-david', 'npm run test:ask-matriya-david');
  } else {
    console.log(
      '\n[run-test-live] Optional: set MATRIYA_TEST_JWT to also run test:ask-matriya-david'
    );
  }
  console.log('\n[run-test-live] All requested checks passed.');
} catch (e) {
  console.error(
    '\n[run-test-live] Failed. For integration: start API with `npm run dev` in matriya-back.\n'
  );
  process.exit(e.status ?? 1);
}
