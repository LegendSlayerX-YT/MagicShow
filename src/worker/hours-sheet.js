/* ===========================================================
   Volunteer hours (Google Sheets) — one tab per volunteer
   -----------------------------------------------------------
   There's no database in this project — the volunteer-hours Sheet plays the
   same role Calendar plays for events. Calls here use the same OAuth access
   token as calendar-owner auth in index.js (the refresh token also carries
   the spreadsheets scope; see scripts/google-oauth.mjs), just pointed at the
   Sheets API instead of the Calendar API.

   One tab per volunteer, titled "Name (email)" (see buildTabTitle) — the
   email makes the title a stable, collision-proof lookup key even if two
   volunteers share a display name, while still reading as a name in the
   Sheets UI and the organizer's picker. Columns within a tab:

     id | submittedAt | hours | date | event | eventId | status | decidedBy | decidedAt

   (No email/name columns — the tab itself is the volunteer.)

   This is its own module, imported by both index.js and
   scripts/migrate-hours-to-tabs.mjs, rather than living in index.js: the
   Workers module runtime requires every named export of the entry module to
   be a function/ExportedHandler (it treats them as named entrypoints for
   service bindings), so plain constants/helpers can't be exported from
   there — see the "Uncaught TypeError: Incorrect type for map entry" error
   this caused when they briefly lived there.
   =========================================================== */

import { normalizeEmail } from './util.js';

export var SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets/';

export var HOURS_HEADER_ROW = ['id', 'submittedAt', 'hours', 'date', 'event', 'eventId', 'status', 'decidedBy', 'decidedAt'];

// Sheets tab titles can't contain [ ] * ? / \ : , can't start/end with an
// apostrophe, and cap out at 100 characters. The email is what makes the
// title a reliable lookup key, so on an oversized name it's the name that
// gets trimmed, never the email.
var TAB_TITLE_FORBIDDEN = /[[\]*?/\\:]/g;

export function buildTabTitle(name, email) {
  var displayName = String(name || email).replace(TAB_TITLE_FORBIDDEN, ' ').replace(/\s+/g, ' ').trim();
  if (!displayName) displayName = email;
  var suffix = ' (' + email + ')';
  var maxNameLen = 100 - suffix.length;
  if (maxNameLen < 1) return email.slice(0, 100).replace(/^'+|'+$/g, '');
  if (displayName.length > maxNameLen) displayName = displayName.slice(0, maxNameLen).trim();
  return (displayName + suffix).replace(/^'+|'+$/g, '');
}

// The inverse of buildTabTitle. Returns null for tabs that don't match the
// pattern (e.g. a pre-migration archive tab) — callers treat those as "not a
// volunteer" rather than erroring.
export function parseTabTitle(title) {
  var match = /^(.*) \(([^()]+@[^()]+)\)$/.exec(String(title || ''));
  if (!match) return null;
  var email = normalizeEmail(match[2]);
  if (!email) return null;
  return { name: match[1].trim(), email: email };
}

export function findVolunteerTab(titles, email) {
  var match = titles.filter(function (title) {
    var parsed = parseTabTitle(title);
    return parsed && parsed.email === email;
  })[0];
  return match || null;
}

// A1 notation needs a sheet title single-quoted whenever it's not a bare
// word — every volunteer tab has at least a space, so this always applies.
export function quoteSheetTitle(title) {
  return "'" + String(title).replace(/'/g, "''") + "'";
}

export async function sheetsRequest(method, url, accessToken, body) {
  var init = { method: method, headers: { Authorization: 'Bearer ' + accessToken } };
  if (body) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  var response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    return { error: 'Sheets request failed.', status: 502 };
  }

  if (!response.ok) {
    // Google's body can echo the request; log it, don't return it.
    var detail = await response.text().catch(function () { return ''; });
    console.warn('Sheets ' + method + ' failed: ' + response.status + ' ' + detail.slice(0, 500));
    if (response.status === 404) return { error: 'Volunteer hours sheet not found.', status: 502 };
    if (response.status === 401 || response.status === 403) {
      return { error: 'The calendar account cannot edit the volunteer hours sheet.', status: 502 };
    }
    return { error: 'Sheets returned ' + response.status + '.', status: 502 };
  }

  try {
    return { body: await response.json() };
  } catch (err) {
    return { error: 'Sheets returned an unreadable response.', status: 502 };
  }
}

// Every tab title in the spreadsheet — the organizer's volunteer list reads
// straight off this, no row data needed.
export async function sheetsGetSpreadsheetMeta(env, accessToken) {
  var url = SHEETS_BASE + encodeURIComponent(env.GOOGLE_SHEETS_ID) + '?fields=' + encodeURIComponent('sheets.properties(title)');
  var result = await sheetsRequest('GET', url, accessToken, null);
  if (result.error) return result;
  var titles = (result.body.sheets || []).map(function (s) { return s.properties.title; });
  return { titles: titles };
}

export async function sheetsCreateVolunteerTab(env, accessToken, title) {
  var createUrl = SHEETS_BASE + encodeURIComponent(env.GOOGLE_SHEETS_ID) + ':batchUpdate';
  var created = await sheetsRequest('POST', createUrl, accessToken, { requests: [{ addSheet: { properties: { title: title } } }] });
  if (created.error) return created;

  var headerRange = encodeURIComponent(quoteSheetTitle(title) + '!A1:I1');
  var headerUrl = SHEETS_BASE + encodeURIComponent(env.GOOGLE_SHEETS_ID) + '/values/' + headerRange + '?valueInputOption=RAW';
  return sheetsRequest('PUT', headerUrl, accessToken, { values: [HOURS_HEADER_ROW] });
}

// Skips the header row (row 1) — every row here is row index + 2 in the
// actual tab. UNFORMATTED_VALUE keeps `hours` a JS number instead of a
// locale-formatted string.
export async function sheetsGetTabRows(env, accessToken, title) {
  var range = encodeURIComponent(quoteSheetTitle(title) + '!A2:I');
  var url = SHEETS_BASE + encodeURIComponent(env.GOOGLE_SHEETS_ID) + '/values/' + range + '?valueRenderOption=UNFORMATTED_VALUE';
  var result = await sheetsRequest('GET', url, accessToken, null);
  if (result.error) return result;
  return { rows: result.body.values || [] };
}

// One batchGet across every volunteer tab, instead of one request per tab —
// used by the pending queue and the decide lookup, the two places that
// genuinely need to search across everyone's rows.
export async function sheetsBatchGetTabRows(env, accessToken, titles) {
  if (!titles.length) return { byTitle: {} };
  var params = new URLSearchParams({ valueRenderOption: 'UNFORMATTED_VALUE' });
  titles.forEach(function (title) { params.append('ranges', quoteSheetTitle(title) + '!A2:I'); });
  var url = SHEETS_BASE + encodeURIComponent(env.GOOGLE_SHEETS_ID) + '/values:batchGet?' + params.toString();
  var result = await sheetsRequest('GET', url, accessToken, null);
  if (result.error) return result;
  var byTitle = {};
  (result.body.valueRanges || []).forEach(function (valueRange, i) {
    byTitle[titles[i]] = valueRange.values || [];
  });
  return { byTitle: byTitle };
}

export async function sheetsAppendRowToTab(env, accessToken, title, row) {
  var range = encodeURIComponent(quoteSheetTitle(title) + '!A:I');
  var url = SHEETS_BASE + encodeURIComponent(env.GOOGLE_SHEETS_ID) + '/values/' + range + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS';
  return sheetsRequest('POST', url, accessToken, { values: [row] });
}

export async function sheetsUpdateTabRange(env, accessToken, title, a1Range, row) {
  var range = encodeURIComponent(quoteSheetTitle(title) + '!' + a1Range);
  var url = SHEETS_BASE + encodeURIComponent(env.GOOGLE_SHEETS_ID) + '/values/' + range + '?valueInputOption=RAW';
  return sheetsRequest('PUT', url, accessToken, { values: [row] });
}
