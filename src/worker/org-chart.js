/* ===========================================================
   Org chart (Google Sheets) — replaces the old ORGANIZER_EMAILS
   var. Two tabs live in the same spreadsheet as volunteer hours
   (GOOGLE_SHEETS_ID) — see scripts/create-org-chart-tabs.mjs:

     Areas     | Area | Head
     Org Chart | Employee | Manager

   "Areas" says who heads each functional area (Cooking,
   Environment, Science, ...). "Org Chart" is the manager chain:
   Manager is blank for a top-level organizer — there can be more
   than one. Everything that used to be gated on ORGANIZER_EMAILS
   is now gated on "has no manager" — see isTopManager.

   A person may act for an Area if they're its Head, or if the
   Head reports up to them (directly or transitively) per Org
   Chart — see canUseArea. The same relation authorizes both
   creating an event for that Area (handleCreateEvent in index.js)
   and approving volunteer hours tied to it (canDecideSubmission).

   Cached per-isolate for a minute so one page load's several
   /api/* calls don't each re-read both tabs from Sheets.
   =========================================================== */

import { normalizeEmail } from './util.js';
import { SHEETS_BASE, quoteSheetTitle, parseDecider } from './hours-sheet.js';

var AREAS_TAB = 'Areas';
var ORG_CHART_TAB = 'Org Chart';
var CACHE_MS = 60000;
var cache = { data: null, expiresAt: 0 };

// Deliberately not sheetsRequest from hours-sheet.js — that helper's error
// text is worded for the volunteer-hours sheet ("Volunteer hours sheet not
// found"), which would be a confusing message here.
async function fetchRange(env, accessToken, title, a1) {
  var range = encodeURIComponent(quoteSheetTitle(title) + '!' + a1);
  var url = SHEETS_BASE + encodeURIComponent(env.GOOGLE_SHEETS_ID) + '/values/' + range + '?valueRenderOption=UNFORMATTED_VALUE';
  var response;
  try {
    response = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken } });
  } catch (err) {
    return { error: 'Could not reach Google Sheets.', status: 502 };
  }
  if (!response.ok) {
    var detail = await response.text().catch(function () { return ''; });
    console.warn('Sheets GET "' + title + '" failed: ' + response.status + ' ' + detail.slice(0, 500));
    if (response.status === 400 || response.status === 404) {
      return { error: 'The "' + title + '" tab is missing — see scripts/create-org-chart-tabs.mjs.', status: 503 };
    }
    return { error: 'Could not read the "' + title + '" tab.', status: 502 };
  }
  var body = await response.json().catch(function () { return null; });
  return { rows: (body && body.values) || [] };
}

function normalizeArea(name) {
  return String(name || '').trim();
}

function buildChart(areaRows, orgRows) {
  var areaHeads = {};
  areaRows.forEach(function (row) {
    var area = normalizeArea(row[0]);
    var head = normalizeEmail(row[1]);
    if (area && head) areaHeads[area] = head;
  });

  var managerOf = {};
  orgRows.forEach(function (row) {
    var employee = normalizeEmail(row[0]);
    if (!employee) return;
    managerOf[employee] = normalizeEmail(row[1]); // '' = top-level (no manager)
  });

  return { areaHeads: areaHeads, managerOf: managerOf };
}

// Fetches + parses both tabs, cached per-isolate. Returns { error, status }
// on failure — the same shape every other Sheets/Calendar helper in this
// project uses, so callers can bubble it straight into a JSON response.
export async function getOrgChart(env, accessToken) {
  var now = Date.now();
  if (cache.data && cache.expiresAt > now) return cache.data;

  var areas = await fetchRange(env, accessToken, AREAS_TAB, 'A2:B');
  if (areas.error) return areas;
  var org = await fetchRange(env, accessToken, ORG_CHART_TAB, 'A2:B');
  if (org.error) return org;

  var chart = buildChart(areas.rows, org.rows);
  cache = { data: chart, expiresAt: now + CACHE_MS };
  return chart;
}

function isEmployee(email, chart) {
  return Object.prototype.hasOwnProperty.call(chart.managerOf, email);
}

// Root of a manager chain: listed in Org Chart with a blank Manager. There
// can be more than one — every Area's tree can have its own top, or the
// whole club can share one. This is the sole replacement for the old
// ORGANIZER_EMAILS: no Register button, leader-picking, the full volunteer
// picker, and the sole approver for hours with no event attached.
export function isTopManager(email, chart) {
  return isEmployee(email, chart) && !chart.managerOf[email];
}

// Walks up from `email`'s manager to the top: [manager, manager's manager,
// ...]. Guards against a cyclical Org Chart (a data-entry mistake, not
// something the sheet itself prevents) rather than looping forever.
export function getManagerChain(email, chart) {
  var chain = [];
  var seen = {};
  var current = chart.managerOf[email];
  while (current && !seen[current]) {
    chain.push(current);
    seen[current] = true;
    current = chart.managerOf[current];
  }
  return chain;
}

export function isAncestorOf(user, target, chart) {
  return !!target && getManagerChain(target, chart).indexOf(user) !== -1;
}

export function areaHead(area, chart) {
  return chart.areaHeads[normalizeArea(area)] || '';
}

// The permission both event creation and area-based hours approval share:
// the Area's Head themselves, or anyone the Head reports up to.
export function canUseArea(email, area, chart) {
  var head = areaHead(area, chart);
  return !!head && (head === email || isAncestorOf(email, head, chart));
}

export function listUsableAreas(email, chart) {
  return Object.keys(chart.areaHeads)
    .filter(function (area) { return canUseArea(email, area, chart); })
    .sort();
}

export function listTopManagers(chart) {
  return Object.keys(chart.managerOf).filter(function (email) { return !chart.managerOf[email]; });
}
