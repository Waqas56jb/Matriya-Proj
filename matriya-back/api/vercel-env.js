/**
 * Import this module before `server.js` so `config.js` sees a Vercel deploy
 * (upload dir under /tmp) even if `VERCEL` is not injected yet during module init.
 */
if (!process.env.VERCEL && !process.env.VERCEL_ENV) {
  process.env.VERCEL = '1';
}
