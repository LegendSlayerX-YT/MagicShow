#!/usr/bin/env node
/* ===========================================================
   One-time Google Sheets setup: Areas + Org Chart tabs
   -----------------------------------------------------------
   Adds two tabs to the same spreadsheet volunteer hours already
   uses (GOOGLE_SHEETS_ID) — the people hierarchy that replaced
   the old ORGANIZER_EMAILS var (see README "Org chart" and
   src/worker/org-chart.js):

     Areas     | Area | Head
     Org Chart | Employee | Manager

   "Areas" says who heads each functional area (Cooking,
   Environment, Science, ...) — one row per area, Head is that
   person's email. "Org Chart" is the manager chain: one row per
   person, Manager blank for a top-level organizer (more than one
   is fine). A person may create events for, or approve volunteer
   hours tied to, any Area whose Head reports up to them.

   This script only creates the two tabs with their header row —
   fill in the actual rows afterward directly in Google Sheets.
   Safe to re-run: a tab that already exists is left untouched.

   Usage:
     node scripts/create-org-chart-tabs.mjs [spreadsheet-id]

   Reads GOOGLE_OAUTH_CLIENT_ID / _SECRET / _REFRESH_TOKEN out of
   .dev.vars (same as create-hours-sheet.mjs) and GOOGLE_SHEETS_ID
   out of wrangler.jsonc unless passed as an argument. That refresh
   token must already cover the spreadsheets scope (re-run
   scripts/google-oauth.mjs first if it doesn't).
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

function loadSheetsIdFromWrangler() {
  let text;
  try {
    text = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  } catch (err) {
    return '';
  }
  const match = text.match(/"GOOGLE_SHEETS_ID"\s*:\s*"([^"]+)"/);
  return match ? match[1] : '';
}

const vars = loadDevVars();
const clientId = vars.GOOGLE_OAUTH_CLIENT_ID;
const clientSecret = vars.GOOGLE_OAUTH_CLIENT_SECRET;
const refreshToken = vars.GOOGLE_OAUTH_REFRESH_TOKEN;
const spreadsheetId = process.argv[2] || loadSheetsIdFromWrangler();

if (!clientId || !clientSecret || !refreshToken) {
  console.error('Missing GOOGLE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN in .dev.vars.');
  console.error('Run scripts/google-oauth.mjs first.');
  process.exit(1);
}
if (!spreadsheetId) {
  console.error('No spreadsheet id — pass one, or set GOOGLE_SHEETS_ID in wrangler.jsonc first');
  console.error('(run scripts/create-hours-sheet.mjs if you have not created that sheet yet).');
  console.error('\nUsage: node scripts/create-org-chart-tabs.mjs [spreadsheet-id]');
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

const metaResponse = await fetch(
  `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=${encodeURIComponent('sheets.properties(title)')}`,
  { headers: { Authorization: `Bearer ${accessToken}` } }
);
const meta = await metaResponse.json();
if (!metaResponse.ok) {
  console.error('\nCould not read the spreadsheet:', metaResponse.status, JSON.stringify(meta, null, 2));
  process.exit(1);
}
const existingTitles = (meta.sheets || []).map((s) => s.properties.title);

const TABS = [
  { title: 'Areas', header: ['Area', 'Head'] },
  { title: 'Org Chart', header: ['Employee', 'Manager'] }
];

for (const tab of TABS) {
  if (existingTitles.includes(tab.title)) {
    console.log(`"${tab.title}" already exists — skipped.`);
    continue;
  }

  const createResponse = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tab.title } } }] })
    }
  );
  const created = await createResponse.json();
  if (!createResponse.ok) {
    console.error(`\nCould not create "${tab.title}":`, createResponse.status, JSON.stringify(created, null, 2));
    process.exit(1);
  }

  const headerRange = encodeURIComponent(`'${tab.title}'!A1:B1`);
  const headerResponse = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${headerRange}?valueInputOption=RAW`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [tab.header] })
    }
  );
  const headerResult = await headerResponse.json();
  if (!headerResponse.ok) {
    console.error(`\nCould not write the header row for "${tab.title}":`, headerResponse.status, JSON.stringify(headerResult, null, 2));
    process.exit(1);
  }
  console.log(`Created "${tab.title}".`);
}

console.log(`
Done: https://docs.google.com/spreadsheets/d/${spreadsheetId}

Fill in "Areas" with one row per functional area (Area | Head), and "Org
Chart" with one row per person (Employee | Manager) — leave Manager blank
for a top-level organizer; more than one is fine. Head/Employee/Manager
each accept "Name (email)" or a bare email — same as the volunteer tabs in
this same spreadsheet. Careful with Manager: blank (or anything that
doesn't parse) means top-level organizer, so a typo there over-grants
rather than under-grants.
`);
