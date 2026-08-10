#!/usr/bin/env node
/* ===========================================================
   One-time Google consent → refresh token
   -----------------------------------------------------------
   /api/register edits the guest list of events on the club
   calendar. Google only allows that from the calendar's owner,
   so the owner signs in here once and the Worker reuses the
   resulting refresh token forever after.

   Usage:
     node scripts/google-oauth.mjs <client-id> <client-secret>

   The client id/secret come from a Google Cloud OAuth client of
   type "Web application" with this exact redirect URI:
     http://localhost:8976/callback

   Sign in as the calendar owner. The script prints the three
   secrets to paste into .dev.vars.
   =========================================================== */

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const PORT = 8976;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPE = 'https://www.googleapis.com/auth/calendar.events';

const [clientId, clientSecret] = process.argv.slice(2);
if (!clientId || !clientSecret) {
  console.error('Usage: node scripts/google-oauth.mjs <client-id> <client-secret>');
  process.exit(1);
}

const state = randomBytes(16).toString('hex');
const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: clientId,
  redirect_uri: REDIRECT_URI,
  response_type: 'code',
  scope: SCOPE,
  // Together these are what make Google hand back a refresh token.
  access_type: 'offline',
  prompt: 'consent',
  state
});

const code = await new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }

    const error = url.searchParams.get('error');
    const received = url.searchParams.get('code');
    const ok = !error && received && url.searchParams.get('state') === state;

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(ok
      ? '<h1>Done.</h1><p>You can close this tab and go back to the terminal.</p>'
      : '<h1>Something went wrong.</h1><p>Check the terminal.</p>');

    server.close();
    ok ? resolve(received) : reject(new Error(error || 'No code, or the state did not match.'));
  });

  server.listen(PORT, () => {
    console.log('\nOpen this URL and sign in as the calendar owner:\n');
    console.log(authUrl + '\n');
    console.log(`Waiting for the redirect to ${REDIRECT_URI} …`);
  });
});

const response = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code'
  })
});

const token = await response.json();
if (!response.ok || !token.refresh_token) {
  console.error('\nToken exchange failed:', response.status, JSON.stringify(token, null, 2));
  console.error('\nNo refresh_token usually means you already granted this client ' +
    'consent. Revoke it at https://myaccount.google.com/permissions and rerun.');
  process.exit(1);
}

console.log(`
Success. Add these to .dev.vars, then run ./deploy.sh:

GOOGLE_OAUTH_CLIENT_ID="${clientId}"
GOOGLE_OAUTH_CLIENT_SECRET="${clientSecret}"
GOOGLE_OAUTH_REFRESH_TOKEN="${token.refresh_token}"
`);
