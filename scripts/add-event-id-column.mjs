#!/usr/bin/env node
/* ===========================================================
   One-time migration: insert the `eventId` column into
   existing per-volunteer tabs
   -----------------------------------------------------------
   The per-volunteer tab layout (see hours-sheet.js) originally
   had no `eventId` column: id | submittedAt | hours | date |
   event | status | decidedBy | decidedAt. A later change added
   `eventId` between `event` and `status` (see HOURS_HEADER_ROW)
   so /api/hours/decide can authorize event leaders, not just
   organizers, against the actual Calendar event a submission
   names.

   Any volunteer tab created before that change is still on the
   old 8-column layout, which the new code misreads — it treats
   the old `status` value as `eventId` and the old `decidedBy`
   email as `status`. This script fixes every such tab in place:
   it inserts a blank `eventId` value at column F for each
   existing row, shifting status/decidedBy/decidedAt one column
   right, and rewrites the header to match. Every existing value
   is preserved, just shifted — nothing is deleted.

   Safe to re-run: a tab whose header already has `eventId` in
   the right place is left untouched.

   Usage:
     node scripts/add-event-id-column.mjs

   Reads GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET /
   GOOGLE_OAUTH_REFRESH_TOKEN out of .dev.vars and
   GOOGLE_SHEETS_ID out of wrangler.jsonc (same as
   migrate-hours-to-tabs.mjs).
   =========================================================== */

import { readFileSync } from 'node:fs';
import {
  SHEETS_BASE, HOURS_HEADER_ROW,
  parseTabTitle, quoteSheetTitle,
  sheetsRequest, sheetsGetSpreadsheetMeta
} from '../src/worker/hours-sheet.js';

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

function loadSheetsId() {
  const text = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const match = text.match(/"GOOGLE_SHEETS_ID"\s*:\s*"([^"]+)"/);
  if (!match) {
    console.error('Could not find GOOGLE_SHEETS_ID in wrangler.jsonc.');
    process.exit(1);
  }
  return match[1];
}

const devVars = loadDevVars();
const clientId = devVars.GOOGLE_OAUTH_CLIENT_ID;
const clientSecret = devVars.GOOGLE_OAUTH_CLIENT_SECRET;
const refreshToken = devVars.GOOGLE_OAUTH_REFRESH_TOKEN;
if (!clientId || !clientSecret || !refreshToken) {
  console.error('Missing GOOGLE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN in .dev.vars.');
  process.exit(1);
}

const spreadsheetId = loadSheetsId();
const env = { GOOGLE_SHEETS_ID: spreadsheetId };

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
  process.exit(1);
}
const accessToken = tokenPayload.access_token;

const meta = await sheetsGetSpreadsheetMeta(env, accessToken);
if (meta.error) {
  console.error('\nCould not read the spreadsheet tab list:', meta.error);
  process.exit(1);
}

const volunteerTitles = meta.titles.filter((title) => parseTabTitle(title));
if (!volunteerTitles.length) {
  console.log('No per-volunteer tabs found — nothing to migrate.');
  process.exit(0);
}

let migrated = 0;
let skipped = 0;

for (const title of volunteerTitles) {
  const headerRange = encodeURIComponent(`${quoteSheetTitle(title)}!A1:I1`);
  const headerResult = await sheetsRequest(
    'GET',
    `${SHEETS_BASE}${encodeURIComponent(spreadsheetId)}/values/${headerRange}?valueRenderOption=UNFORMATTED_VALUE`,
    accessToken, null
  );
  if (headerResult.error) {
    console.error(`  Failed to read header for "${title}": ${headerResult.error}`);
    continue;
  }
  const header = (headerResult.body.values || [[]])[0] || [];
  if (header[5] === 'eventId') {
    console.log(`Skipping "${title}" — already has the eventId column.`);
    skipped++;
    continue;
  }

  const dataRange = encodeURIComponent(`${quoteSheetTitle(title)}!A2:H`);
  const dataResult = await sheetsRequest(
    'GET',
    `${SHEETS_BASE}${encodeURIComponent(spreadsheetId)}/values/${dataRange}?valueRenderOption=UNFORMATTED_VALUE`,
    accessToken, null
  );
  if (dataResult.error) {
    console.error(`  Failed to read rows for "${title}": ${dataResult.error}`);
    continue;
  }
  const oldRows = dataResult.body.values || [];
  // Insert a blank eventId between event (index 4) and status (index 5).
  const newRows = oldRows.map((row) => [row[0], row[1], row[2], row[3], row[4], '', row[5], row[6], row[7]]);

  console.log(`Migrating "${title}" (${newRows.length} row${newRows.length === 1 ? '' : 's'})…`);

  const writeRange = encodeURIComponent(`${quoteSheetTitle(title)}!A1:I${newRows.length + 1}`);
  const writeResult = await sheetsRequest(
    'PUT',
    `${SHEETS_BASE}${encodeURIComponent(spreadsheetId)}/values/${writeRange}?valueInputOption=RAW`,
    accessToken, { values: [HOURS_HEADER_ROW, ...newRows] }
  );
  if (writeResult.error) {
    console.error(`  Failed to write "${title}": ${writeResult.error}`);
    continue;
  }

  migrated++;
}

console.log(`\nDone. ${migrated} tab(s) migrated, ${skipped} already up to date.`);
