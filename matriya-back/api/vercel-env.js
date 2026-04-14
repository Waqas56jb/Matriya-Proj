/**
 * Vercel serverless shim.
 *
 * `api/index.js` imports this file. In some deployments it was missing, causing the
 * function to crash at import-time (Vercel returns 502 Bad Gateway).
 *
 * We intentionally keep this minimal: Vercel already injects env vars; we only
 * normalize `process.env.VERCEL` when running in a Vercel environment.
 */
if ((process.env.VERCEL_ENV || process.env.VERCEL_URL) && !process.env.VERCEL) {
  process.env.VERCEL = '1';
}

/**
 * Import this module before `server.js` so `config.js` sees a Vercel deploy
 * (upload dir under /tmp) even if `VERCEL` is not injected yet during module init.
 */
if (!process.env.VERCEL && !process.env.VERCEL_ENV) {
  process.env.VERCEL = '1';
}
