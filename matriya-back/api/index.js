/**
 * Vercel serverless function - Express app
 */
process.env.VERCEL = "1";

import app from '../server.js';

// Vercel expects a default export
export default app;
