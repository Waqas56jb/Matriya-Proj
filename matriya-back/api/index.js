/**
 * Vercel serverless function - Express app
 */
import './vercel-env.js';
import app from '../server.js';

// Vercel expects a default export
export default app;
