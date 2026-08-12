#!/usr/bin/env node
/* ===========================================================
   One-time Google Sheet creation for volunteer hours
   -----------------------------------------------------------
   /api/hours (src/worker/index.js) stores volunteer-hour
   submissions as rows in a Google Sheet — this project has no
   database, so the Sheet is the datastore, same way Calendar is
   the datastore for events/registrations.

   This script creates that spreadsheet using the calendar/sheets-
   owner's refresh token, and prints the spreadsheet ID to paste
   into wrangler.jsonc. It's just the empty spreadsheet with its
   one default tab (Sheets requires at least one) — the Worker
   creates a tab per volunteer on demand as people submit hours
   (see buildTabTitle / handleSubmitHours in src/worker/index.js),
   so there's no header row to write here.

   Usage:
     node scripts/create-hours-sheet.mjs

   Reads GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET /
   GOOGLE_OAUTH_REFRESH_TOKEN out of .dev.vars — the same values
   scripts/google-oauth.mjs prints. That refresh token must
   already cover the spreadsheets scope (re-run google-oauth.mjs
   first if it doesn't — see its header comment).
   =========================================================== */

import { readFileSync } from 'node:fs';

function loadDevVars() {
  let text;
  try {
    text = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
  } catch (err) {
    console.error('Could not read .dev.vars — run scripts/google-oauth.mjs first.');
    process.exit(1);
  }
  const vars = {};
  for (const line of text.split('\n')) {
    const match = line.match(/^([A-Z_]+)="?(.*?)"?$/);
    if (match) vars[match[1]] = match[2];
  }
  return vars;
}

const vars = loadDevVars();
const clientId = vars.GOOGLE_OAUTH_CLIENT_ID;
const clientSecret = vars.GOOGLE_OAUTH_CLIENT_SECRET;
const refreshToken = vars.GOOGLE_OAUTH_REFRESH_TOKEN;

if (!clientId || !clientSecret || !refreshToken) {
  console.error('Missing GOOGLE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN in .dev.vars.');
  console.error('Run scripts/google-oauth.mjs first.');
  process.exit(1);
}

const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken
  })
});
const tokenPayload = await tokenResponse.json();
if (!tokenResponse.ok || !tokenPayload.access_token) {
  console.error('\nCould not get an access token:', tokenResponse.status, JSON.stringify(tokenPayload, null, 2));
  console.error('\nIf this says insufficient scope, re-run scripts/google-oauth.mjs to');
  console.error('get a refresh token that also covers the spreadsheets scope.');
  process.exit(1);
}
const accessToken = tokenPayload.access_token;

const createResponse = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    properties: { title: 'Gasp Machine — Volunteer Hours' }
  })
});
const spreadsheet = await createResponse.json();
if (!createResponse.ok) {
  console.error('\nCould not create the spreadsheet:', createResponse.status, JSON.stringify(spreadsheet, null, 2));
  process.exit(1);
}
const spreadsheetId = spreadsheet.spreadsheetId;

console.log(`
Success. Spreadsheet: https://docs.google.com/spreadsheets/d/${spreadsheetId}

Add this to wrangler.jsonc under "vars":

"GOOGLE_SHEETS_ID": "${spreadsheetId}"
`);
