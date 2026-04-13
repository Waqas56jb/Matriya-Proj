#!/usr/bin/env node
/**
 * Get Microsoft Graph access token (for SharePoint / Graph API).
 * Loads .env from project root. Uses: SHAREPOINT_TENANT_ID, SHAREPOINT_CLIENT_ID, SHAREPOINT_CLIENT_SECRET
 *
 * Run from maneger-back (with .env set):
 *   node scripts/get-graph-token.js
 */
import 'dotenv/config';

const tenantId = process.env.SHAREPOINT_TENANT_ID;
const clientId = process.env.SHAREPOINT_CLIENT_ID;
const clientSecret = process.env.SHAREPOINT_CLIENT_SECRET;

if (!tenantId || !clientId || !clientSecret) {
  console.error('Missing env: SHAREPOINT_TENANT_ID, SHAREPOINT_CLIENT_ID, SHAREPOINT_CLIENT_SECRET');
  process.exit(1);
}

const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
const body = new URLSearchParams({
  grant_type: 'client_credentials',
  client_id: clientId,
  client_secret: clientSecret,
  scope: 'https://graph.microsoft.com/.default'
}).toString();

async function main() {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Token request failed:', res.status, data);
    process.exit(1);
  }
  if (!data.access_token) {
    console.error('No access_token in response:', data);
    process.exit(1);
  }
  console.log('expires_in:', data.expires_in, 'seconds');
  console.log('');
  console.log('Full access token (copy below):');
  console.log(data.access_token);
}

main().catch((e) => { console.error(e); process.exit(1); });
