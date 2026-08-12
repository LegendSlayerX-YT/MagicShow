#!/usr/bin/env node
/* ===========================================================
   One-time migration: split "Volunteer Hours" into per-volunteer tabs
   -----------------------------------------------------------
   /api/hours (src/worker/index.js) used to store every volunteer's
   submissions as rows in one shared "Volunteer Hours" tab. It now
   gives each volunteer their own tab, titled "Name (email)", so the
   organizer's volunteer list can come straight from the spreadsheet's
   tab titles instead of a read + dedupe over every row ever
   submitted.

   This script is the one-time backfill: it reads every row out of
   the old shared tab, groups them by volunteer, and writes each
   volunteer's rows into their own new tab (created with the exact
   same naming/header logic the Worker uses — imported from
   src/worker/index.js rather than duplicated here). The old
   "Volunteer Hours" tab is left untouched; the Worker no longer reads
   it (a tab title that isn't "Name (email)" is invisible to it — see
   parseTabTitle), so once you've spot-checked the new tabs you can
   archive or delete it by hand.

   Safe to re-run: a volunteer who already has a tab is skipped
   rather than getting their rows duplicated.

   Usage:
     node scripts/migrate-hours-to-tabs.mjs

   Reads GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET /
   GOOGLE_OAUTH_REFRESH_TOKEN out of .dev.vars (same as
   create-hours-sheet.mjs) and GOOGLE_SHEETS_ID out of wrangler.jsonc.
   =========================================================== */

import { readFileSync } from 'node:fs';
import {
  SHEETS_BASE,
  buildTabTitle, parseTabTitle, quoteSheetTitle,
  sheetsRequest, sheetsGetSpreadsheetMeta, sheetsCreateVolunteerTab
} from '../src/worker/hours-sheet.js';

const OLD_TAB_NAME = 'Volunteer Hours';

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

// Old tab's layout: id, submittedAt, email, name, hours, date, event,
// status, decidedBy, decidedAt (see the pre-migration create-hours-sheet.mjs).
// None of those rows carry an eventId — that column was added later, after
// event picking existed — so the migrated rows just leave it blank.
const oldRange = encodeURIComponent(`${OLD_TAB_NAME}!A2:J`);
const oldRowsResult = await sheetsRequest(
  'GET',
  `${SHEETS_BASE}${encodeURIComponent(spreadsheetId)}/values/${oldRange}?valueRenderOption=UNFORMATTED_VALUE`,
  accessToken, null
);
if (oldRowsResult.error) {
  console.error(`\nCould not read the "${OLD_TAB_NAME}" tab:`, oldRowsResult.error);
  process.exit(1);
}
const oldRows = oldRowsResult.body.values || [];
if (!oldRows.length) {
  console.log(`"${OLD_TAB_NAME}" has no data rows — nothing to migrate.`);
  process.exit(0);
}

// Group by normalized email; the most recent row's name wins (rows are in
// submission order since the old tab was append-only).
const byEmail = new Map();
for (const row of oldRows) {
  const email = String(row[2] || '').trim().toLowerCase();
  if (!email) continue;
  const name = row[3] || email;
  // row[6] (old event name) carries over; the new eventId column between it
  // and status is left blank — the source rows predate event picking.
  const newRow = [row[0], row[1], row[4], row[5], row[6], '', row[7], row[8], row[9]];
  if (!byEmail.has(email)) byEmail.set(email, { name, rows: [] });
  byEmail.get(email).name = name;
  byEmail.get(email).rows.push(newRow);
}

const meta = await sheetsGetSpreadsheetMeta(env, accessToken);
if (meta.error) {
  console.error('\nCould not read the spreadsheet tab list:', meta.error);
  process.exit(1);
}
const existingEmails = new Set(
  meta.titles.map((title) => parseTabTitle(title)).filter(Boolean).map((p) => p.email)
);

let created = 0;
let skipped = 0;
for (const [email, { name, rows }] of byEmail) {
  if (existingEmails.has(email)) {
    console.log(`Skipping ${email} — already has a tab.`);
    skipped++;
    continue;
  }

  const title = buildTabTitle(name, email);
  console.log(`Creating "${title}" (${rows.length} row${rows.length === 1 ? '' : 's'})…`);

  const tabResult = await sheetsCreateVolunteerTab(env, accessToken, title);
  if (tabResult.error) {
    console.error(`  Failed to create tab: ${tabResult.error}`);
    continue;
  }

  const dataRange = encodeURIComponent(`${quoteSheetTitle(title)}!A2:I${rows.length + 1}`);
  const writeResult = await sheetsRequest(
    'PUT',
    `${SHEETS_BASE}${encodeURIComponent(spreadsheetId)}/values/${dataRange}?valueInputOption=RAW`,
    accessToken, { values: rows }
  );
  if (writeResult.error) {
    console.error(`  Created the tab but failed to write its rows: ${writeResult.error}`);
    continue;
  }

  created++;
}

console.log(`\nDone. ${created} tab(s) created, ${skipped} skipped (already migrated).`);
console.log(`"${OLD_TAB_NAME}" was left untouched — the site no longer reads it, so archive or delete it by hand once you've spot-checked the new tabs.`);
