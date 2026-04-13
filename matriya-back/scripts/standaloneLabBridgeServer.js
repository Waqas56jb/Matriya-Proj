#!/usr/bin/env node
/**
 * Previously imported lab routes from a sibling `routes/labChainRoutes.js` tree.
 * Lab routes now live on full **managment-back** (`../managment-back/server.js`).
 *
 * Run the real lab API from monorepo folder:
 *   cd ../managment-back && npm start
 *
 * This file is kept so scripts/README references do not break; it exits with instructions.
 */
import 'dotenv/config';

console.error(
  '[standaloneLabBridgeServer] Obsolete: start management-back instead:\n' +
    '  cd ../managment-back\n' +
    '  npm install && npm start\n' +
    'Then set MANAGEMENT_BACK_URL in matriya-back/.env to that server (e.g. http://127.0.0.1:8001).'
);
process.exit(1);
