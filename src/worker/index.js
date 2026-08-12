/* ===========================================================
   API relay Worker
   -----------------------------------------------------------
   The browser never sees a Google API key. The site calls
   /api/calendar and /api/archives on its own origin; this
   Worker adds the key server-side, trims the upstream payload
   down to what the pages actually render, and caches at the
   edge so we stay well inside the Google quotas.

   /api/register is the one write path: it adds a visitor's
   email to an event's guest list. API keys are read-only, so
   that call runs on an OAuth refresh token for the calendar's
   owner — see "calendar-owner auth" below. The visitor's email
   itself comes from Sign in with Google, not a typed-in field —
   see "visitor sign-in" below — so the Worker knows it's real
   before it ever touches the calendar.

   Everything that isn't /api/* is handed back to the static
   asset handler (src/client).

   Calendar reads go over the same OAuth credentials as the register
   write (see "calendar-owner auth" below) rather than an API key, so
   there's one Google credential to manage instead of two.

   /api/hours is the other write path: it appends a volunteer's
   logged hours as a row in a Google Sheet, and lets organizers
   verify/deny each row. There's no database in this project, so
   the Sheet is the datastore — same role Calendar plays for events.
   It reuses the same calendar-owner OAuth credentials (now also
   scoped for Sheets — see scripts/google-oauth.mjs).

   Each volunteer gets their own tab, titled "Name (email)" — see
   "volunteer hours (Google Sheets)" below. That means the organizer's
   list of volunteers is just the spreadsheet's tab titles (one cheap
   metadata call, no row data read), and a volunteer's own history is
   just their one tab instead of a filter over every row ever
   submitted.

   /api/events is a third write path: it creates a new Calendar event
   tagged with a functional Area. Who may use which Area — and who
   counts as a top-level organizer, replacing the old ORGANIZER_EMAILS
   var — comes from two more tabs in the same spreadsheet ("Areas",
   "Org Chart"), read through org-chart.js. That same permission check
   also gates volunteer-hours approval (see canDecideSubmission below).

   Config:
     vars    — CALENDAR_ID, CALENDAR_TIME_ZONE,
               YOUTUBE_PLAYLIST_ID, YOUTUBE_MAX_RESULTS,
               CALENDAR_SEND_UPDATES, GOOGLE_SIGNIN_CLIENT_ID,
               GOOGLE_SHEETS_ID
     secrets — YOUTUBE_API_KEY,
               GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET,
               GOOGLE_OAUTH_REFRESH_TOKEN
   =========================================================== */

import { normalizeEmail } from './util.js';
import {
  findVolunteerTab, buildTabTitle, parseTabTitle, formatDecider, parseDecider,
  sheetsGetSpreadsheetMeta, sheetsCreateVolunteerTab, sheetsGetTabRows,
  sheetsBatchGetTabRows, sheetsAppendRowToTab, sheetsUpdateTabRange
} from './hours-sheet.js';
import {
  getOrgChart, isTopManager, canUseArea, listUsableAreas, listTopManagers,
  areaHead, getManagerChain
} from './org-chart.js';

var CACHE_SECONDS = 300;
var MAX_RANGE_DAYS = 92;

export default {
  async fetch(request, env) {
    var url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      // Not an API call — let the static assets binding serve it.
      return env.ASSETS ? env.ASSETS.fetch(request) : notFound();
    }

    if (request.method === 'POST') {
      if (url.pathname === '/api/register') return handleRegister(request, env);
      if (url.pathname === '/api/leaders') return handleLeaders(request, env);
      if (url.pathname === '/api/hours') return handleSubmitHours(request, env);
      if (url.pathname === '/api/hours/decide') return handleDecideHours(request, env);
      if (url.pathname === '/api/events') return handleCreateEvent(request, env);
      return json({ error: 'Method not allowed' }, 405, { Allow: url.pathname === '/api/hours' ? 'GET, HEAD, POST' : 'GET, HEAD' });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      var postOnlyPaths = ['/api/register', '/api/leaders', '/api/hours/decide', '/api/events'];
      var allow = url.pathname === '/api/hours' ? 'GET, HEAD, POST' :
        postOnlyPaths.indexOf(url.pathname) !== -1 ? 'POST' : 'GET, HEAD';
      return json({ error: 'Method not allowed' }, 405, { Allow: allow });
    }

    if (url.pathname === '/api/calendar') return handleCalendar(request, url, env);
    if (url.pathname === '/api/archives') return handleArchives(env);
    if (url.pathname === '/api/hours') return handleViewHours(request, env);
    if (url.pathname === '/api/areas') return handleListAreas(request, env);
    if (url.pathname === '/api/register') return json({ error: 'Method not allowed' }, 405, { Allow: 'POST' });
    if (url.pathname === '/api/leaders') return json({ error: 'Method not allowed' }, 405, { Allow: 'POST' });
    if (url.pathname === '/api/hours/decide') return json({ error: 'Method not allowed' }, 405, { Allow: 'POST' });
    if (url.pathname === '/api/events') return json({ error: 'Method not allowed' }, 405, { Allow: 'POST' });

    return notFound();
  }
};

/* ---------- routes ---------- */

async function handleCalendar(request, url, env) {
  var oauth = readOauthConfig(env);
  var calendarId = env.CALENDAR_ID;
  if (!oauth || !calendarId) {
    return json({ error: 'Calendar relay is not configured.' }, 503);
  }

  var timeZone = env.CALENDAR_TIME_ZONE || 'UTC';
  var range = readRange(url);
  if (range.error) return json({ error: range.error }, 400);

  var token = await getAccessToken(oauth);
  if (token.error) return json({ error: token.error }, token.status);

  var params = new URLSearchParams({
    singleEvents: 'true',
    orderBy: 'startTime',
    timeMin: range.timeMin,
    timeMax: range.timeMax,
    timeZone: timeZone
  });

  var upstream = 'https://www.googleapis.com/calendar/v3/calendars/' +
    encodeURIComponent(calendarId) + '/events?' + params.toString();

  var data = await fetchUpstream(upstream, env, token.value);
  if (data.error) return json({ error: data.error }, data.status);

  // If the visitor is signed in, mark which events they're already on the
  // guest list for — using the attendees already in this same upstream
  // response, so this costs no extra Calendar API calls. A bad/expired
  // credential just means no marks, not a failed request.
  var viewerEmail = null;
  var authHeader = request.headers.get('Authorization') || '';
  var presentedCredential = authHeader.indexOf('Bearer ') === 0;
  if (presentedCredential && env.GOOGLE_SIGNIN_CLIENT_ID) {
    var identity = await verifyGoogleIdToken(authHeader.slice(7), env.GOOGLE_SIGNIN_CLIENT_ID);
    if (!identity.error) viewerEmail = identity.email;
  }

  // Top-level managers (see org-chart.js — no Manager in the Org Chart tab)
  // pick leaders from the guest list in addition to registering like anyone
  // else. isOrganizer is only ever derived from a verified viewerEmail
  // above, never from anything the client claims. `chart` is also handed to
  // trimEvent so it can extend the same leader-picking power to an event's
  // Area Head (or anyone that Head reports up to) on a per-event basis —
  // see canManage there — since that's a per-event relation isOrganizer
  // alone can't express.
  var isOrganizer = false;
  var chart = null;
  if (viewerEmail && env.GOOGLE_SHEETS_ID) {
    var viewerChart = await getOrgChart(env, token.value);
    if (!viewerChart.error) {
      chart = viewerChart;
      isOrganizer = isTopManager(viewerEmail, chart);
    }
  }

  // Attendee names are only included when the caller asks for them — the
  // past-events slider needs them, but the default (future) request should
  // keep costing nothing extra in exposed data. See trimEvent for why this
  // is otherwise never sent.
  var includeAttendees = url.searchParams.get('attendees') === '1';

  var events = (data.body.items || [])
    .filter(function (event) { return event && event.status !== 'cancelled'; })
    .map(function (event) { return trimEvent(event, viewerEmail, includeAttendees, isOrganizer, calendarId, chart); });

  return json({
    timeZone: timeZone,
    // Reaching here already proved the calendar-owner OAuth credentials
    // work; registration also needs the Sign in with Google client id.
    registrationOpen: !!env.GOOGLE_SIGNIN_CLIENT_ID,
    isOrganizer: isOrganizer,
    events: events
  // Keyed on whether a credential was *presented*, not whether it verified —
  // a transient tokeninfo hiccup must never get cached as "signed out" for
  // 5 minutes; that would silently hide badges until the cache expired.
  // Vary is required, not decorative: signed-in and anonymous requests hit
  // the exact same URL (timeMin/timeMax don't change per visitor), so
  // without it the browser can't tell the two cache entries apart and may
  // serve a previously-cached anonymous response to a credentialed request
  // without ever reaching the Worker.
  }, 200, Object.assign(
    { Vary: 'Authorization' },
    presentedCredential ? { 'Cache-Control': 'private, no-store' } : null
  ));
}

async function handleArchives(env) {
  var key = env.YOUTUBE_API_KEY;
  var playlistId = env.YOUTUBE_PLAYLIST_ID;
  if (!key || !playlistId) {
    return json({ error: 'Archives relay is not configured.' }, 503);
  }

  var maxResults = clampInt(env.YOUTUBE_MAX_RESULTS, 1, 50, 50);

  var params = new URLSearchParams({
    part: 'snippet,contentDetails',
    maxResults: String(maxResults),
    playlistId: playlistId,
    key: key
  });

  var upstream = 'https://www.googleapis.com/youtube/v3/playlistItems?' + params.toString();

  var data = await fetchUpstream(upstream, env);
  if (data.error) return json({ error: data.error }, data.status);

  var videos = (data.body.items || [])
    .filter(function (item) {
      var sn = item && item.snippet;
      var title = sn && sn.title;
      var videoId = sn && sn.resourceId && sn.resourceId.videoId;
      return videoId && title && title !== 'Private video' && title !== 'Deleted video';
    })
    .map(function (item) {
      var sn = item.snippet;
      var cd = item.contentDetails || {};
      return {
        id: sn.resourceId.videoId,
        title: sn.title,
        caption: (sn.description || '').split('\n')[0],
        publishedAt: cd.videoPublishedAt || sn.publishedAt || ''
      };
    })
    .sort(function (a, b) {
      return Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0);
    });

  return json({ videos: videos }, 200);
}

/* ---------- registration ---------- */

var MAX_ATTENDEES = 200;
var RATE_WINDOW_MS = 60000;
var RATE_MAX_HITS = 5;

// Adds one attendee to one event. Everything here is written defensively:
// the endpoint is unauthenticated, so a visitor could otherwise use it to
// spam arbitrary addresses onto arbitrary events.
async function handleRegister(request, env) {
  var oauth = readOauthConfig(env);
  if (!oauth || !env.CALENDAR_ID || !env.GOOGLE_SIGNIN_CLIENT_ID) {
    return noStore(json({ error: 'Registration is not configured.' }, 503));
  }

  // Requiring JSON forces a CORS preflight for cross-origin callers, which a
  // plain <form> POST from another site can't do.
  var contentType = request.headers.get('Content-Type') || '';
  if (contentType.indexOf('application/json') === -1) {
    return noStore(json({ error: 'Expected application/json.' }, 415));
  }

  var origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) {
    return noStore(json({ error: 'Cross-origin requests are not allowed.' }, 403));
  }

  var ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (rateLimited(ip)) {
    return noStore(json({ error: 'Too many attempts. Try again in a minute.' }, 429, { 'Retry-After': '60' }));
  }

  var body;
  try {
    body = await request.json();
  } catch (err) {
    return noStore(json({ error: 'Invalid request body.' }, 400));
  }

  var eventId = typeof body.eventId === 'string' ? body.eventId.trim() : '';
  // Google event ids are base32hex plus `_` for recurring instances.
  if (!eventId || eventId.length > 1024 || !/^[A-Za-z0-9_@.-]+$/.test(eventId)) {
    return noStore(json({ error: 'Unknown event.' }, 400));
  }

  var credential = typeof body.credential === 'string' ? body.credential : '';
  if (!credential) {
    return noStore(json({ error: 'Sign in with Google to register.' }, 401));
  }
  var identity = await verifyGoogleIdToken(credential, env.GOOGLE_SIGNIN_CLIENT_ID);
  if (identity.error) return noStore(json({ error: identity.error }, identity.status));
  var email = identity.email;
  var name = identity.name;

  var token = await getAccessToken(oauth);
  if (token.error) return noStore(json({ error: token.error }, token.status));

  var path = 'https://www.googleapis.com/calendar/v3/calendars/' +
    encodeURIComponent(env.CALENDAR_ID) + '/events/' + encodeURIComponent(eventId);
  var sendUpdates = env.CALENDAR_SEND_UPDATES || 'none';

  // attendees is a whole-array field, so this is a read-modify-write.
  // If-Match + retry keeps two simultaneous registrations from clobbering
  // each other — but Google sometimes serves this Worker a *weak* ETag for
  // reasons outside our control (an internal routing/serving detail on
  // Google's side, confirmed by testing outside the Worker), and a weak
  // validator can never satisfy If-Match, so it 412s no matter how fresh the
  // read was. Rather than get stuck permanently unable to register, the
  // last attempt drops the condition and writes unconditionally — the
  // "already registered" check just above still catches the common case
  // (the same visitor's retry), so this only risks a genuine lost update in
  // the rare case of two different visitors registering for the same event
  // within the same request.
  var MAX_ATTEMPTS = 4;
  for (var attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(attempt * 400);
    var current = await calendarRequest('GET', path, token.value, null, null);
    if (current.error) {
      return noStore(json({ error: current.status === 404 ? 'Unknown event.' : current.error }, current.status));
    }

    var event = current.body;
    if (event.status === 'cancelled') {
      return noStore(json({ error: 'That event was cancelled.' }, 409));
    }
    if (!eventIsOpen(event)) {
      return noStore(json({ error: 'Registration for that event is closed.' }, 409));
    }

    var attendees = Array.isArray(event.attendees) ? event.attendees : [];
    var already = attendees.some(function (attendee) {
      return normalizeEmail(attendee && attendee.email) === email;
    });
    if (already) {
      return noStore(json({ registered: true, alreadyRegistered: true }, 200));
    }
    if (attendees.length >= MAX_ATTENDEES) {
      return noStore(json({ error: 'That event has reached its guest limit.' }, 409));
    }

    var newAttendee = { email: email, responseStatus: 'needsAction' };
    if (name) newAttendee.displayName = name;
    var payload = {
      attendees: attendees.concat([newAttendee]),
      // Public sign-up form — don't let registrants see each other's emails.
      guestsCanSeeOtherGuests: false
    };
    var conditional = attempt < MAX_ATTEMPTS - 1;
    var saved = await calendarRequest(
      'PATCH', path + '?sendUpdates=' + encodeURIComponent(sendUpdates),
      token.value, payload, conditional ? current.etag : null
    );

    if (saved.status === 412) {
      if (conditional) continue; // someone else registered first — re-read
      // Shouldn't happen — the unconditional attempt sends no If-Match, so
      // Google has nothing to precondition-fail on. Fail loudly if it does.
      return noStore(json({ error: 'Could not save your registration. Please try again.' }, 503));
    }
    if (saved.error) return noStore(json({ error: saved.error }, saved.status));

    return noStore(json({ registered: true, alreadyRegistered: false }, 200));
  }

  return noStore(json({ error: 'Could not save your registration. Please try again.' }, 503));
}

/* ---------- leader picks ---------- */

// Lets a top-level manager (see org-chart.js) mark which registered guests
// are leading an event. Verified the same way as /api/register, off a
// Google-signed credential the client can't forge.
async function handleLeaders(request, env) {
  var oauth = readOauthConfig(env);
  if (!oauth || !env.CALENDAR_ID || !env.GOOGLE_SIGNIN_CLIENT_ID || !env.GOOGLE_SHEETS_ID) {
    return noStore(json({ error: 'Not configured.' }, 503));
  }

  var contentType = request.headers.get('Content-Type') || '';
  if (contentType.indexOf('application/json') === -1) {
    return noStore(json({ error: 'Expected application/json.' }, 415));
  }

  var origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) {
    return noStore(json({ error: 'Cross-origin requests are not allowed.' }, 403));
  }

  var ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (rateLimited(ip)) {
    return noStore(json({ error: 'Too many attempts. Try again in a minute.' }, 429, { 'Retry-After': '60' }));
  }

  var body;
  try {
    body = await request.json();
  } catch (err) {
    return noStore(json({ error: 'Invalid request body.' }, 400));
  }

  var eventId = typeof body.eventId === 'string' ? body.eventId.trim() : '';
  if (!eventId || eventId.length > 1024 || !/^[A-Za-z0-9_@.-]+$/.test(eventId)) {
    return noStore(json({ error: 'Unknown event.' }, 400));
  }

  var credential = typeof body.credential === 'string' ? body.credential : '';
  if (!credential) {
    return noStore(json({ error: 'Sign in with Google first.' }, 401));
  }
  var identity = await verifyGoogleIdToken(credential, env.GOOGLE_SIGNIN_CLIENT_ID);
  if (identity.error) return noStore(json({ error: identity.error }, identity.status));

  var token = await getAccessToken(oauth);
  if (token.error) return noStore(json({ error: token.error }, token.status));

  var chart = await getOrgChart(env, token.value);
  if (chart.error) return noStore(json({ error: chart.error }, chart.status));

  var path = 'https://www.googleapis.com/calendar/v3/calendars/' +
    encodeURIComponent(env.CALENDAR_ID) + '/events/' + encodeURIComponent(eventId);

  var current = await calendarRequest('GET', path, token.value, null, null);
  if (current.error) {
    return noStore(json({ error: current.status === 404 ? 'Unknown event.' : current.error }, current.status));
  }

  var event = current.body;
  if (event.status === 'cancelled') {
    return noStore(json({ error: 'That event was cancelled.' }, 409));
  }

  var parsedDescription = splitDescription(event.description || '');

  // Same rule as canDecideSubmission: a top-level manager, or the Head of
  // this event's Area (or anyone that Head reports up to) — not just
  // top-level managers, so an Area Head participating in their own event
  // can adjust its leaders too.
  var authorized = isTopManager(identity.email, chart) ||
    (parsedDescription.area && canUseArea(identity.email, parsedDescription.area, chart));
  if (!authorized) {
    return noStore(json({ error: 'Not authorized.' }, 403));
  }

  var requested = Array.isArray(body.leaders) ? body.leaders : [];
  var leaderEmails = requested
    .map(function (email) { return typeof email === 'string' ? normalizeEmail(email) : ''; })
    .filter(Boolean);

  // Leaders must be picked from the event's actual guest list — never let
  // the request write an arbitrary email into the description. The Calendar
  // ID's own account isn't a guest — see trimEvent — so it's excluded here
  // too, the same way trimEvent keeps it out of attendeeDetails in the first
  // place.
  var calendarEmail = normalizeEmail(env.CALENDAR_ID);
  var attendees = Array.isArray(event.attendees) ? event.attendees : [];
  var attendeeEmails = {};
  attendees.forEach(function (attendee) {
    var email = normalizeEmail(attendee && attendee.email);
    if (email && email !== calendarEmail) attendeeEmails[email] = true;
  });
  leaderEmails = leaderEmails.filter(function (email) { return attendeeEmails[email]; });

  var payload = { description: buildDescription(parsedDescription.visible, leaderEmails, parsedDescription.area) };

  // No sendUpdates here — this only rewrites the description, and guests
  // shouldn't get an email every time an organizer adjusts the leader list.
  var saved = await calendarRequest('PATCH', path, token.value, payload, current.etag);
  if (saved.status === 412) {
    return noStore(json({ error: 'That event changed while saving. Please try again.' }, 409));
  }
  if (saved.error) return noStore(json({ error: saved.error }, saved.status));

  return noStore(json({ leaders: leaderEmails }, 200));
}

/* ---------- volunteer hours ---------- */

var MAX_LOGGED_HOURS = 24;

// Any signed-in visitor can submit — organizers just don't get a form for it
// in the UI (see hours.js), same way they don't get a Register button.
async function handleSubmitHours(request, env) {
  var oauth = readOauthConfig(env);
  if (!oauth || !env.CALENDAR_ID || !env.GOOGLE_SIGNIN_CLIENT_ID || !env.GOOGLE_SHEETS_ID) {
    return noStore(json({ error: 'Volunteer hours logging is not configured.' }, 503));
  }

  var contentType = request.headers.get('Content-Type') || '';
  if (contentType.indexOf('application/json') === -1) {
    return noStore(json({ error: 'Expected application/json.' }, 415));
  }

  var origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) {
    return noStore(json({ error: 'Cross-origin requests are not allowed.' }, 403));
  }

  var ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (rateLimited(ip)) {
    return noStore(json({ error: 'Too many attempts. Try again in a minute.' }, 429, { 'Retry-After': '60' }));
  }

  var body;
  try {
    body = await request.json();
  } catch (err) {
    return noStore(json({ error: 'Invalid request body.' }, 400));
  }

  var credential = typeof body.credential === 'string' ? body.credential : '';
  if (!credential) {
    return noStore(json({ error: 'Sign in with Google to log hours.' }, 401));
  }
  var identity = await verifyGoogleIdToken(credential, env.GOOGLE_SIGNIN_CLIENT_ID);
  if (identity.error) return noStore(json({ error: identity.error }, identity.status));

  var hours = typeof body.hours === 'number' ? body.hours : parseFloat(body.hours);
  if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_LOGGED_HOURS) {
    return noStore(json({ error: 'Hours must be a number between 0 and ' + MAX_LOGGED_HOURS + '.' }, 400));
  }
  hours = Math.round(hours * 100) / 100;

  var date = typeof body.date === 'string' ? body.date.trim() : '';
  var dateMs = /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(date + 'T00:00:00Z') : NaN;
  if (Number.isNaN(dateMs)) {
    return noStore(json({ error: 'Enter a valid date.' }, 400));
  }
  if (dateMs > Date.now()) {
    return noStore(json({ error: "That date hasn't happened yet." }, 400));
  }

  var token = await getAccessToken(oauth);
  if (token.error) return noStore(json({ error: token.error }, token.status));

  // When a real calendar event is picked, its name is looked up server-side
  // from the id the client sent, never trusted as free text — same
  // reasoning as leaders only being pickable from an event's actual guest
  // list (see handleLeaders). Without a picked event there's nothing to
  // verify against, so a volunteer-typed title is the only option; it's
  // just plain text stored in a Sheet cell and HTML-escaped on display, so
  // there's no injection risk in accepting it as-is.
  var eventId = typeof body.eventId === 'string' ? body.eventId.trim() : '';
  var eventSummary = '';
  if (eventId) {
    if (eventId.length > 1024 || !/^[A-Za-z0-9_@.-]+$/.test(eventId)) {
      return noStore(json({ error: 'Unknown event.' }, 400));
    }
    var eventPath = 'https://www.googleapis.com/calendar/v3/calendars/' +
      encodeURIComponent(env.CALENDAR_ID) + '/events/' + encodeURIComponent(eventId);
    var eventResult = await calendarRequest('GET', eventPath, token.value, null, null);
    if (eventResult.error) {
      return noStore(json({ error: eventResult.status === 404 ? 'Unknown event.' : eventResult.error }, eventResult.status));
    }
    eventSummary = eventResult.body.summary || 'Untitled event';
  } else {
    var eventTitle = typeof body.eventTitle === 'string' ? body.eventTitle.trim() : '';
    if (!eventTitle) {
      return noStore(json({ error: 'Enter what the hours were for.' }, 400));
    }
    if (eventTitle.length > 200) {
      return noStore(json({ error: 'Event title is too long.' }, 400));
    }
    eventSummary = eventTitle;
  }

  var meta = await sheetsGetSpreadsheetMeta(env, token.value);
  if (meta.error) return noStore(json({ error: meta.error }, meta.status));

  var tabTitle = findVolunteerTab(meta.titles, identity.email);
  if (!tabTitle) {
    tabTitle = buildTabTitle(identity.name || identity.email, identity.email);
    var created = await sheetsCreateVolunteerTab(env, token.value, tabTitle);
    if (created.error) return noStore(json({ error: created.error }, created.status));
  }

  var row = [crypto.randomUUID(), new Date().toISOString(), hours, date, eventSummary, eventId, 'pending', '', ''];

  var appended = await sheetsAppendRowToTab(env, token.value, tabTitle, row);
  if (appended.error) return noStore(json({ error: appended.error }, appended.status));

  return noStore(json({ submitted: true }, 200));
}

// Always requires a credential — unlike /api/calendar, there's no anonymous
// case here since every response is either "your own hours" or (for an
// organizer) other people's pending submissions.
async function handleViewHours(request, env) {
  var oauth = readOauthConfig(env);
  if (!oauth || !env.CALENDAR_ID || !env.GOOGLE_SIGNIN_CLIENT_ID || !env.GOOGLE_SHEETS_ID) {
    return noStore(json({ error: 'Volunteer hours is not configured.' }, 503));
  }

  var authHeader = request.headers.get('Authorization') || '';
  if (authHeader.indexOf('Bearer ') !== 0) {
    return noStore(json({ error: 'Sign in with Google to view volunteer hours.' }, 401));
  }
  var identity = await verifyGoogleIdToken(authHeader.slice(7), env.GOOGLE_SIGNIN_CLIENT_ID);
  if (identity.error) return noStore(json({ error: identity.error }, identity.status));

  var token = await getAccessToken(oauth);
  if (token.error) return noStore(json({ error: token.error }, token.status));

  var chart = await getOrgChart(env, token.value);
  if (chart.error) return noStore(json({ error: chart.error }, chart.status));

  var meta = await sheetsGetSpreadsheetMeta(env, token.value);
  if (meta.error) return noStore(json({ error: meta.error }, meta.status));

  // Only tabs that match the "Name (email)" naming this Worker creates are
  // volunteers — anything else (e.g. a leftover archive tab from before this
  // per-volunteer layout) is silently ignored rather than shown as a person.
  var volunteerTabs = meta.titles
    .map(function (title) { var parsed = parseTabTitle(title); return parsed ? { title: title, name: parsed.name, email: parsed.email } : null; })
    .filter(Boolean);

  // Top-level managers (see org-chart.js) verify everyone's pending
  // submissions their authority reaches; everyone else only ever sees their
  // own tab — a viewer's place in the org chart is verified server-side
  // above, never claimed by the client (same pattern as isOrganizer on
  // /api/calendar).
  if (isTopManager(identity.email, chart)) {
    // The list of volunteer names comes straight from the tab titles — no
    // row data needs to be read just to populate the person picker.
    var volunteers = volunteerTabs
      .map(function (v) { return { email: v.email, name: v.name || v.email }; })
      .sort(function (a, b) { return a.name.localeCompare(b.name); });

    var personParam = normalizeEmail(new URL(request.url).searchParams.get('person') || '');
    if (personParam) {
      var personTab = volunteerTabs.filter(function (v) { return v.email === personParam; })[0];
      if (!personTab) {
        return noStore(json({ error: 'Unknown volunteer.' }, 404));
      }
      var personResult = await sheetsGetTabRows(env, token.value, personTab.title);
      if (personResult.error) return noStore(json({ error: personResult.error }, personResult.status));

      var personTotal = personResult.rows.reduce(function (sum, row) {
        return row[6] === 'verified' ? sum + (Number(row[2]) || 0) : sum;
      }, 0);
      var personEventCache = new Map();
      var personSubmissions = await Promise.all(personResult.rows.map(async function (row) {
        var submission = { id: row[0], submittedAt: row[1], hours: row[2], date: row[3], event: row[4], status: row[6] };
        if (row[6] === 'pending') {
          submission.approvers = await resolveApproverNames(env, token.value, row[5] || '', personTab.email, chart, personEventCache);
        } else {
          var decider = row[7] ? parseDecider(row[7]) : null;
          if (decider) submission.decidedBy = decider.name;
        }
        return submission;
      }));
      personSubmissions.sort(function (a, b) { return Date.parse(b.submittedAt) - Date.parse(a.submittedAt); });

      return noStore(json({
        isOrganizer: true,
        volunteers: volunteers,
        person: { email: personTab.email, name: personTab.name || personTab.email },
        totalHours: Math.round(personTotal * 100) / 100,
        submissions: personSubmissions
      }, 200));
    }

    // The pending queue is the one place that genuinely needs every
    // volunteer's rows — batched into a single Sheets call rather than one
    // request per tab.
    var batch = await sheetsBatchGetTabRows(env, token.value, volunteerTabs.map(function (v) { return v.title; }));
    if (batch.error) return noStore(json({ error: batch.error }, batch.status));

    var pending = await buildDecidableQueue(env, token.value, volunteerTabs, batch, identity.email, chart, new Map());

    return noStore(json({ isOrganizer: true, pending: pending, volunteers: volunteers }, 200));
  }

  // Not a top-level manager, but might still lead one or more events, or be
  // an Area's Head (or report up to one) — either grants the same
  // decide-scoped queue below, just naturally narrower (see
  // canDecideSubmission). This costs one extra Calendar list call for every
  // non-top-manager view; acceptable for a small club site.
  var leaderLookup = await fetchLeaderEventIds(env, token.value, identity.email);
  var leaderEventIds = leaderLookup.error ? {} : leaderLookup.ids;
  var manageableAreas = listUsableAreas(identity.email, chart);
  var hasDecideAuthority = Object.keys(leaderEventIds).length > 0 || manageableAreas.length > 0;

  var ownTab = findVolunteerTab(meta.titles, identity.email);
  var ownResult = ownTab ? await sheetsGetTabRows(env, token.value, ownTab) : { rows: [] };
  if (ownResult.error) return noStore(json({ error: ownResult.error }, ownResult.status));

  var totalHours = ownResult.rows.reduce(function (sum, row) {
    return row[6] === 'verified' ? sum + (Number(row[2]) || 0) : sum;
  }, 0);
  var ownEventCache = new Map();
  var submissions = await Promise.all(ownResult.rows.map(async function (row) {
    var submission = { id: row[0], submittedAt: row[1], hours: row[2], date: row[3], event: row[4], eventId: row[5] || '', status: row[6] };
    if (row[6] === 'pending') {
      submission.approvers = await resolveApproverNames(env, token.value, row[5] || '', identity.email, chart, ownEventCache);
    } else {
      var decider = row[7] ? parseDecider(row[7]) : null;
      if (decider) submission.decidedBy = decider.name;
    }
    return submission;
  }));
  submissions.sort(function (a, b) { return Date.parse(b.submittedAt) - Date.parse(a.submittedAt); });

  if (!hasDecideAuthority) {
    return noStore(json({
      isOrganizer: false,
      totalHours: Math.round(totalHours * 100) / 100,
      submissions: submissions
    }, 200));
  }

  // Same batched read + filter the top-manager queue uses above — just
  // naturally scoped down to the event(s) this person leads and/or the
  // Area(s) they head or manage toward (see buildDecidableQueue).
  var leaderBatch = await sheetsBatchGetTabRows(env, token.value, volunteerTabs.map(function (v) { return v.title; }));
  if (leaderBatch.error) return noStore(json({ error: leaderBatch.error }, leaderBatch.status));

  var leaderPending = await buildDecidableQueue(env, token.value, volunteerTabs, leaderBatch, identity.email, chart, new Map());

  return noStore(json({
    isOrganizer: false,
    isLeader: true,
    totalHours: Math.round(totalHours * 100) / 100,
    submissions: submissions,
    pending: leaderPending
  }, 200));
}

// Lets whoever canDecideSubmission authorizes — the event's leader, the
// Area Head (or anyone that Head reports up to), or a top-level manager for
// a submission with no event/Area — verify or deny one pending submission,
// except their own; nobody can approve/deny hours they submitted themselves,
// so someone else with standing has to sign off instead. Authorization is
// checked against the actual event/Area the submission names (see
// handleSubmitHours for the eventId column), not a cached list, so a leader
// or Org Chart change takes effect on the very next decide.
async function handleDecideHours(request, env) {
  var oauth = readOauthConfig(env);
  if (!oauth || !env.CALENDAR_ID || !env.GOOGLE_SIGNIN_CLIENT_ID || !env.GOOGLE_SHEETS_ID) {
    return noStore(json({ error: 'Volunteer hours is not configured.' }, 503));
  }

  var contentType = request.headers.get('Content-Type') || '';
  if (contentType.indexOf('application/json') === -1) {
    return noStore(json({ error: 'Expected application/json.' }, 415));
  }

  var origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) {
    return noStore(json({ error: 'Cross-origin requests are not allowed.' }, 403));
  }

  var ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (rateLimited(ip)) {
    return noStore(json({ error: 'Too many attempts. Try again in a minute.' }, 429, { 'Retry-After': '60' }));
  }

  var body;
  try {
    body = await request.json();
  } catch (err) {
    return noStore(json({ error: 'Invalid request body.' }, 400));
  }

  var credential = typeof body.credential === 'string' ? body.credential : '';
  if (!credential) {
    return noStore(json({ error: 'Sign in with Google first.' }, 401));
  }
  var identity = await verifyGoogleIdToken(credential, env.GOOGLE_SIGNIN_CLIENT_ID);
  if (identity.error) return noStore(json({ error: identity.error }, identity.status));

  var id = typeof body.id === 'string' ? body.id.trim() : '';
  var decision = body.decision === 'verify' ? 'verified' : body.decision === 'deny' ? 'denied' : '';
  if (!id || !decision) {
    return noStore(json({ error: 'Invalid request.' }, 400));
  }

  var token = await getAccessToken(oauth);
  if (token.error) return noStore(json({ error: token.error }, token.status));

  var chart = await getOrgChart(env, token.value);
  if (chart.error) return noStore(json({ error: chart.error }, chart.status));

  var meta = await sheetsGetSpreadsheetMeta(env, token.value);
  if (meta.error) return noStore(json({ error: meta.error }, meta.status));

  var volunteerTitles = meta.titles.filter(function (title) { return parseTabTitle(title); });
  var batch = await sheetsBatchGetTabRows(env, token.value, volunteerTitles);
  if (batch.error) return noStore(json({ error: batch.error }, batch.status));

  var targetTitle = null;
  var rowIndex = -1;
  volunteerTitles.some(function (title) {
    var rows = batch.byTitle[title] || [];
    var i = rows.findIndex(function (row) { return row[0] === id; });
    if (i === -1) return false;
    targetTitle = title;
    rowIndex = i;
    return true;
  });

  if (!targetTitle) {
    return noStore(json({ error: 'Unknown submission.' }, 404));
  }
  var targetRow = batch.byTitle[targetTitle][rowIndex];
  if (targetRow[6] !== 'pending') {
    return noStore(json({ error: 'That submission was already decided.' }, 409));
  }

  // No self-approval, even for an organizer or the event's own leader —
  // the tab title is who the submission belongs to (see buildTabTitle).
  var submitter = parseTabTitle(targetTitle);
  if (submitter && submitter.email === identity.email) {
    return noStore(json({ error: "You can't decide your own submission." }, 403));
  }

  var authorized = await canDecideSubmission(env, token.value, targetRow, identity.email, chart, new Map());
  if (!authorized) {
    return noStore(json({ error: 'Not authorized.' }, 403));
  }

  var rowNumber = rowIndex + 2; // row 1 is the header; data starts at row 2
  var updated = await sheetsUpdateTabRange(
    env, token.value, targetTitle, 'G' + rowNumber + ':I' + rowNumber,
    [decision, formatDecider(identity.name, identity.email), new Date().toISOString()]
  );
  if (updated.error) return noStore(json({ error: updated.error }, updated.status));

  return noStore(json({ decided: true, decision: decision }, 200));
}

/* ---------- event creation ---------- */

var MAX_EVENT_TITLE = 200;
var MAX_EVENT_LOCATION = 200;
var MAX_EVENT_DESCRIPTION = 4000;

// Lets whoever canUseArea authorizes for a given Area — its Head, or anyone
// that Head reports up to (see org-chart.js) — create a new Calendar event
// tagged with that Area. The tag rides in the same JSON tail as leader
// picks (see buildDescription) so it needs no extra Calendar field.
async function handleCreateEvent(request, env) {
  var oauth = readOauthConfig(env);
  if (!oauth || !env.CALENDAR_ID || !env.GOOGLE_SIGNIN_CLIENT_ID || !env.GOOGLE_SHEETS_ID) {
    return noStore(json({ error: 'Event creation is not configured.' }, 503));
  }

  var contentType = request.headers.get('Content-Type') || '';
  if (contentType.indexOf('application/json') === -1) {
    return noStore(json({ error: 'Expected application/json.' }, 415));
  }

  var origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) {
    return noStore(json({ error: 'Cross-origin requests are not allowed.' }, 403));
  }

  var ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (rateLimited(ip)) {
    return noStore(json({ error: 'Too many attempts. Try again in a minute.' }, 429, { 'Retry-After': '60' }));
  }

  var body;
  try {
    body = await request.json();
  } catch (err) {
    return noStore(json({ error: 'Invalid request body.' }, 400));
  }

  var credential = typeof body.credential === 'string' ? body.credential : '';
  if (!credential) {
    return noStore(json({ error: 'Sign in with Google to create an event.' }, 401));
  }
  var identity = await verifyGoogleIdToken(credential, env.GOOGLE_SIGNIN_CLIENT_ID);
  if (identity.error) return noStore(json({ error: identity.error }, identity.status));

  var token = await getAccessToken(oauth);
  if (token.error) return noStore(json({ error: token.error }, token.status));

  var chart = await getOrgChart(env, token.value);
  if (chart.error) return noStore(json({ error: chart.error }, chart.status));

  var area = typeof body.area === 'string' ? body.area.trim() : '';
  if (!area || !canUseArea(identity.email, area, chart)) {
    return noStore(json({ error: 'Pick an Area you can create events for.' }, 403));
  }

  var title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title || title.length > MAX_EVENT_TITLE) {
    return noStore(json({ error: 'Enter a title (up to ' + MAX_EVENT_TITLE + ' characters).' }, 400));
  }

  var location = typeof body.location === 'string' ? body.location.trim() : '';
  if (location.length > MAX_EVENT_LOCATION) {
    return noStore(json({ error: 'Location is too long.' }, 400));
  }

  var description = typeof body.description === 'string' ? body.description.trim() : '';
  if (description.length > MAX_EVENT_DESCRIPTION) {
    return noStore(json({ error: 'Description is too long.' }, 400));
  }

  var start, end;
  if (body.allDay === true) {
    var startDate = typeof body.startDate === 'string' ? body.startDate.trim() : '';
    var endDate = typeof body.endDate === 'string' ? body.endDate.trim() : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      return noStore(json({ error: 'Enter valid start/end dates.' }, 400));
    }
    // Calendar's all-day end.date is exclusive — the form collects the last
    // inclusive day, so a one-day event needs endDate pushed one day later.
    var endExclusive = new Date(endDate + 'T00:00:00Z');
    endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
    if (Date.parse(startDate + 'T00:00:00Z') > endExclusive.getTime()) {
      return noStore(json({ error: 'End date must be on or after the start date.' }, 400));
    }
    start = { date: startDate };
    end = { date: endExclusive.toISOString().slice(0, 10) };
  } else {
    var startDateTime = typeof body.start === 'string' ? body.start.trim() : '';
    var endDateTime = typeof body.end === 'string' ? body.end.trim() : '';
    var startMs = Date.parse(startDateTime);
    var endMs = Date.parse(endDateTime);
    if (!startDateTime || !endDateTime || Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
      return noStore(json({ error: 'Enter a valid start and end time.' }, 400));
    }
    var timeZone = env.CALENDAR_TIME_ZONE || 'UTC';
    start = { dateTime: new Date(startMs).toISOString(), timeZone: timeZone };
    end = { dateTime: new Date(endMs).toISOString(), timeZone: timeZone };
  }

  // The creator leads their own event by default — they're on the guest
  // list (so handleLeaders' guest-list filter doesn't silently drop them
  // from a later leader-list edit) and named as a leader from the start.
  var creatorAttendee = { email: identity.email, responseStatus: 'accepted' };
  if (identity.name) creatorAttendee.displayName = identity.name;

  var payload = {
    summary: title,
    location: location,
    description: buildDescription(description, [identity.email], area),
    start: start,
    end: end,
    attendees: [creatorAttendee]
  };

  var path = 'https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(env.CALENDAR_ID) + '/events';
  var created = await calendarRequest('POST', path, token.value, payload, null);
  if (created.error) return noStore(json({ error: created.error }, created.status));

  return noStore(json({ created: true, eventId: created.body.id }, 200));
}

/* ---------- areas ---------- */

// Which Areas the signed-in visitor may create/lead events for — the same
// relation canDecideSubmission checks for hours approval (see org-chart.js).
async function handleListAreas(request, env) {
  var oauth = readOauthConfig(env);
  if (!oauth || !env.GOOGLE_SIGNIN_CLIENT_ID || !env.GOOGLE_SHEETS_ID) {
    return noStore(json({ error: 'Not configured.' }, 503));
  }

  var authHeader = request.headers.get('Authorization') || '';
  if (authHeader.indexOf('Bearer ') !== 0) {
    return noStore(json({ error: 'Sign in with Google first.' }, 401));
  }
  var identity = await verifyGoogleIdToken(authHeader.slice(7), env.GOOGLE_SIGNIN_CLIENT_ID);
  if (identity.error) return noStore(json({ error: identity.error }, identity.status));

  var token = await getAccessToken(oauth);
  if (token.error) return noStore(json({ error: token.error }, token.status));

  var chart = await getOrgChart(env, token.value);
  if (chart.error) return noStore(json({ error: chart.error }, chart.status));

  return noStore(json({ areas: listUsableAreas(identity.email, chart) }, 200));
}

// Only events the Calendar page actually shows can be registered for, so a
// guessed id can't be used to attach attendees to something older or far out.
function eventIsOpen(event) {
  var now = Date.now();
  var end = event.end || {};
  var start = event.start || {};

  // All-day `date` values are exclusive on the end side.
  var endsAt = end.dateTime ? Date.parse(end.dateTime) :
    end.date ? Date.parse(end.date + 'T23:59:59Z') : NaN;
  var startsAt = start.dateTime ? Date.parse(start.dateTime) :
    start.date ? Date.parse(start.date + 'T00:00:00Z') : NaN;

  if (Number.isNaN(endsAt) || Number.isNaN(startsAt)) return false;
  if (endsAt < now) return false;
  return startsAt <= now + MAX_RANGE_DAYS * 86400000;
}

// Per-isolate, so it's a speed bump rather than a guarantee — Cloudflare
// spreads traffic across isolates. Pair it with a WAF rate-limit rule on
// /api/register if the endpoint ever gets abused in earnest.
var rateBuckets = new Map();

function rateLimited(ip) {
  var now = Date.now();

  if (rateBuckets.size > 5000) {
    rateBuckets.forEach(function (hits, key) {
      if (!hits.some(function (t) { return now - t < RATE_WINDOW_MS; })) rateBuckets.delete(key);
    });
  }

  var recent = (rateBuckets.get(ip) || []).filter(function (t) {
    return now - t < RATE_WINDOW_MS;
  });
  if (recent.length >= RATE_MAX_HITS) {
    rateBuckets.set(ip, recent);
    return true;
  }

  recent.push(now);
  rateBuckets.set(ip, recent);
  return false;
}

async function calendarRequest(method, url, accessToken, body, etag) {
  var init = {
    method: method,
    headers: { Authorization: 'Bearer ' + accessToken }
  };
  if (body) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (etag) init.headers['If-Match'] = etag;

  var response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    return { error: 'Calendar request failed.', status: 502 };
  }

  if (!response.ok) {
    // Google's body can echo the request; log it, don't return it.
    var detail = await response.text().catch(function () { return ''; });
    console.warn('Calendar ' + method + ' failed: ' + response.status + ' ' + detail.slice(0, 500));

    if (response.status === 412) return { status: 412 };
    if (response.status === 404) return { error: 'Unknown event.', status: 404 };
    if (response.status === 401 || response.status === 403) {
      return { error: 'The calendar account cannot edit this event.', status: 502 };
    }
    return { error: 'Calendar returned ' + response.status + '.', status: 502 };
  }

  try {
    return { body: await response.json(), etag: response.headers.get('ETag') };
  } catch (err) {
    return { error: 'Calendar returned an unreadable response.', status: 502 };
  }
}

/* ---------- calendar-owner auth ----------

   Writes happen as the calendar's owner, not as a service account. Google
   refuses `attendees` edits from a service account unless the project has
   Domain-Wide Delegation, and DWD is a Workspace-only feature — it can't be
   turned on for a personal gmail.com calendar. So the owner grants consent
   once (scripts/google-oauth.mjs), and the Worker trades the resulting
   refresh token for an access token as needed.
   ----------------------------------------- */

var GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';
var cachedToken = null;

function readOauthConfig(env) {
  if (!env.GOOGLE_OAUTH_CLIENT_ID ||
      !env.GOOGLE_OAUTH_CLIENT_SECRET ||
      !env.GOOGLE_OAUTH_REFRESH_TOKEN) {
    return null;
  }
  return {
    clientId: env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    refreshToken: env.GOOGLE_OAUTH_REFRESH_TOKEN
  };
}

// Access tokens last an hour; reuse them for the life of the isolate.
async function getAccessToken(oauth) {
  var now = Date.now();
  if (cachedToken &&
      cachedToken.refreshToken === oauth.refreshToken &&
      cachedToken.expiresAt > now + 60000) {
    return { value: cachedToken.value };
  }

  var response;
  try {
    response = await fetch(GOOGLE_TOKEN_URI, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: oauth.clientId,
        client_secret: oauth.clientSecret,
        refresh_token: oauth.refreshToken
      }).toString()
    });
  } catch (err) {
    return { error: 'Could not reach Google.', status: 502 };
  }

  if (!response.ok) {
    // `invalid_grant` here means the refresh token was revoked or expired —
    // re-run scripts/google-oauth.mjs and set the secret again.
    var detail = await response.text().catch(function () { return ''; });
    console.warn('Token refresh failed: ' + response.status + ' ' + detail.slice(0, 500));
    return { error: 'Could not authorize with Google Calendar.', status: 502 };
  }

  var payload = await response.json().catch(function () { return null; });
  if (!payload || !payload.access_token) {
    return { error: 'Could not authorize with Google Calendar.', status: 502 };
  }

  cachedToken = {
    refreshToken: oauth.refreshToken,
    value: payload.access_token,
    expiresAt: now + (payload.expires_in || 3600) * 1000
  };
  return { value: payload.access_token };
}

/* ---------- visitor sign-in (Sign in with Google) ----------

   Separate from the calendar-owner auth above: this identifies whoever
   clicked Register, not the account that owns the calendar. The browser
   gets an ID token from Google Identity Services (src/client/js/auth.js)
   and sends it along with the registration; the Worker can't trust an
   email the client merely claims, so it re-verifies the token with Google
   before touching the guest list. Uses the tokeninfo endpoint rather than
   local JWT/JWKS verification — simpler, and this endpoint sees nowhere
   near the request volume where tokeninfo's soft rate limit would matter.
   ----------------------------------------------------------------- */

async function verifyGoogleIdToken(credential, expectedAudience) {
  var url = 'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential);
  var response;
  try {
    response = await fetch(url);
  } catch (err) {
    return { error: 'Could not verify your Google sign-in.', status: 502 };
  }
  if (!response.ok) {
    return { error: 'Could not verify your Google sign-in — sign in again.', status: 401 };
  }

  var claims = await response.json().catch(function () { return null; });
  if (!claims || claims.aud !== expectedAudience) {
    return { error: 'Could not verify your Google sign-in.', status: 401 };
  }
  if (claims.email_verified !== 'true' && claims.email_verified !== true) {
    return { error: "Your Google account's email isn't verified.", status: 401 };
  }

  var email = normalizeEmail(claims.email);
  if (!email) return { error: 'Could not verify your Google sign-in.', status: 401 };
  // `name` is a normal OIDC profile claim Google Identity Services includes
  // on every ID token (no extra consent scope needed) — capturing it here
  // means new registrations attach a real display name instead of Calendar
  // falling back to a bare email or, once trimEvent hides email addresses
  // from the public site, a generic "Guest".
  var name = typeof claims.name === 'string' ? claims.name.trim() : '';
  return { email: email, name: name };
}

/* ---------- helpers ---------- */

// Only forward the fields the calendar page renders. Google returns
// attendees, organizer emails, and conferencing links we don't want public.
function trimEvent(event, viewerEmail, includeAttendees, isOrganizer, calendarId, chart) {
  // The Calendar ID isn't a person, it's just whose calendar every event
  // lives on — Google lists that account as an attendee (flagged
  // `organizer: true`) on its own events, but it's never someone who
  // "attended" or a candidate to lead one. Trimmed by comparing against
  // CALENDAR_ID directly rather than trusting Google's `organizer` flag,
  // which is a different concept from this app's own top-level managers
  // (real people with approval power — see isTopManager in org-chart.js).
  var calendarEmail = normalizeEmail(calendarId);

  // Leader picks and the Area tag both live as a JSON tail on the event
  // description (see splitDescription) so no extra Calendar field/
  // permission is needed. The visible part is all that ever reaches the
  // browser as `description` — for every viewer, organizer included — so
  // the tail never shows up in page content or a fetch() response body.
  var parsedDescription = splitDescription(event.description || '');
  var trimmed = {
    // The page sends this back to /api/register. Not a secret — Google
    // event ids aren't guessable-but-sensitive, just opaque identifiers.
    id: event.id || '',
    summary: event.summary || '',
    location: event.location || '',
    description: parsedDescription.visible,
    // The functional Area this event was created for (see handleCreateEvent)
    // — blank for events created before this feature existed.
    area: parsedDescription.area || '',
    start: {},
    end: {}
  };
  if (event.start) {
    if (event.start.date) trimmed.start.date = event.start.date;
    if (event.start.dateTime) trimmed.start.dateTime = event.start.dateTime;
  }
  if (event.end) {
    if (event.end.date) trimmed.end.date = event.end.date;
    if (event.end.dateTime) trimmed.end.dateTime = event.end.dateTime;
  }
  // Only set when the visitor is signed in — lets the Register button show
  // "Registered" without a click. Guest lists otherwise never leave the
  // Worker (see the field list above), so this is deliberately the one
  // narrow exception, and only for the signed-in visitor's own status.
  if (viewerEmail) {
    var attendees = Array.isArray(event.attendees) ? event.attendees : [];
    trimmed.registered = attendees.some(function (attendee) {
      return normalizeEmail(attendee && attendee.email) === viewerEmail;
    });
  }
  // The past-events slider and the daily list both show who's coming, split
  // into leads vs. everyone else, but never email addresses — only whatever
  // display name a guest set on their own RSVP. Declined and resource
  // (room/equipment) entries aren't people who are "attending", and neither
  // is the Calendar ID's own account.
  if (includeAttendees) {
    var guests = Array.isArray(event.attendees) ? event.attendees : [];
    var leaderEmails = {};
    parsedDescription.leaders.forEach(function (email) { leaderEmails[email] = true; });
    trimmed.leads = [];
    trimmed.volunteers = [];
    guests.forEach(function (attendee) {
      if (!attendee || attendee.resource || attendee.responseStatus === 'declined') return;
      var email = normalizeEmail(attendee.email);
      if (email && email === calendarEmail) return;
      var name = attendee.displayName || 'Guest';
      (email && leaderEmails[email] ? trimmed.leads : trimmed.volunteers).push(name);
    });
  }
  // Organizers pick leaders from the guest list, so — unlike the public
  // leads/volunteers names above — they need enough to tell guests apart
  // (email) plus which ones are already marked as leaders. Same rule
  // handleLeaders now enforces server-side: a top-level manager, or this
  // event's Area Head (or anyone that Head reports up to) — not just
  // top-level managers, so an Area Head sees the leader-picking UI for
  // events in their own Area even though isOrganizer alone is global.
  var canManage = isOrganizer ||
    !!(viewerEmail && chart && parsedDescription.area && canUseArea(viewerEmail, parsedDescription.area, chart));
  trimmed.canManage = canManage;
  if (canManage) {
    var candidates = Array.isArray(event.attendees) ? event.attendees : [];
    trimmed.attendeeDetails = candidates
      .filter(function (attendee) {
        if (!attendee || attendee.resource || attendee.responseStatus === 'declined') return false;
        return normalizeEmail(attendee.email) !== calendarEmail;
      })
      .map(function (attendee) {
        return { email: normalizeEmail(attendee.email), name: attendee.displayName || attendee.email || 'Guest' };
      })
      .filter(function (attendee) { return attendee.email; });
    trimmed.leaders = parsedDescription.leaders;
  }
  return trimmed;
}

/* ---------- leader picks + Area tag (stored in the event description) ----------

   A top-level manager marks which registered guests are leading a given
   event, and whoever creates an event tags it with a functional Area (see
   handleCreateEvent). Neither has a field of its own on a Calendar event, so
   both ride together as one JSON line appended after the human-written
   description — plain visible text, not hidden markup, so it survives
   someone editing the description in the Google Calendar UI (rather than
   risk the UI's rich-text editor silently stripping something it treats as
   inert markup on save) and so the pick is visible/auditable directly on the
   event if anyone goes looking. trimEvent always strips it back out before
   `description` reaches any client on this site — the public gets it back
   out as the leads/volunteers split and the `area` field, organizers
   additionally get the raw parsed `leaders` field — so it never shows up in
   this site's own pages or responses.

   The JSON key stays `emails` (not renamed to match the marker text) purely
   for backward compatibility — events tagged before the Area feature existed
   already carry this exact marker string with that key.
   ----------------------------------------------------------------- */

var LEADER_MARKER = '\n\nLeaders (auto-managed by the website, do not edit): ';

function splitDescription(raw) {
  var idx = raw.lastIndexOf(LEADER_MARKER);
  if (idx === -1) return { visible: raw, leaders: [], area: '' };

  var tail = raw.slice(idx + LEADER_MARKER.length).trim();
  var parsed;
  try {
    parsed = JSON.parse(tail);
  } catch (err) {
    return { visible: raw, leaders: [], area: '' };
  }

  var emails = Array.isArray(parsed && parsed.emails) ?
    parsed.emails.filter(function (email) { return typeof email === 'string'; }) : [];
  var area = typeof (parsed && parsed.area) === 'string' ? parsed.area.trim() : '';
  return { visible: raw.slice(0, idx), leaders: emails, area: area };
}

// The set of event ids a visitor is a leader of, used to build their leader
// pending queue in handleViewHours. A generous lookback (well beyond the
// 90-day window hours.js offers in the submission dropdown) means a
// submission still shows up here even if a fair amount of time has passed
// since the event happened. Authorization on the actual decide (see
// handleDecideHours) never depends on this list — it re-checks the one
// event a submission names, so a narrower or stale list here only affects
// what a leader is conveniently shown, never what they're allowed to do.
var LEADER_LOOKUP_LOOKBACK_DAYS = 365;

async function fetchLeaderEventIds(env, accessToken, email) {
  var day = 86400000;
  var now = Date.now();
  var params = new URLSearchParams({
    singleEvents: 'true',
    timeMin: new Date(now - LEADER_LOOKUP_LOOKBACK_DAYS * day).toISOString(),
    timeMax: new Date(now + day).toISOString(),
    fields: 'items(id,description)'
  });
  var upstream = 'https://www.googleapis.com/calendar/v3/calendars/' +
    encodeURIComponent(env.CALENDAR_ID) + '/events?' + params.toString();

  var result = await calendarRequest('GET', upstream, accessToken, null, null);
  if (result.error) return { error: result.error, status: result.status };

  var ids = {};
  (result.body.items || []).forEach(function (event) {
    var leaders = splitDescription(event.description || '').leaders;
    if (leaders.indexOf(email) !== -1) ids[event.id] = true;
  });
  return { ids: ids };
}

function buildDescription(visible, leaderEmails, area) {
  var base = visible.replace(/\s+$/, '');
  var payload = {};
  if (leaderEmails && leaderEmails.length) payload.emails = leaderEmails;
  if (area) payload.area = area;
  if (!payload.emails && !payload.area) return base;
  return base + LEADER_MARKER + JSON.stringify(payload);
}

// Fetches one event's leaders/Area/attendee names, cached per-call-chain
// (several pending rows, or several approver lookups, often share the same
// event) — shared by canDecideSubmission and resolveApproverNames below.
async function getEventInfo(env, accessToken, eventId, cache) {
  if (cache.has(eventId)) return cache.get(eventId);

  var eventPath = 'https://www.googleapis.com/calendar/v3/calendars/' +
    encodeURIComponent(env.CALENDAR_ID) + '/events/' + encodeURIComponent(eventId);
  var result = await calendarRequest('GET', eventPath, accessToken, null, null);

  var info;
  if (result.error) {
    info = { leaders: [], area: '', nameByEmail: {} };
  } else {
    var parsed = splitDescription(result.body.description || '');
    var nameByEmail = {};
    (Array.isArray(result.body.attendees) ? result.body.attendees : []).forEach(function (a) {
      var email = normalizeEmail(a && a.email);
      if (email) nameByEmail[email] = a.displayName || email;
    });
    info = { leaders: parsed.leaders, area: parsed.area, nameByEmail: nameByEmail };
  }

  cache.set(eventId, info);
  return info;
}

// Who can decide a pending submission: whoever leads the event it's tied to,
// or the Head of the event's Area (or anyone that Head reports up to — see
// canUseArea in org-chart.js). A submission with no event, or whose event
// has no Area tagged (e.g. one created before this feature existed), can
// only be decided by a top-level manager — see isTopManager.
async function canDecideSubmission(env, accessToken, row, viewerEmail, chart, cache) {
  var eventId = row[5];
  if (!eventId) return isTopManager(viewerEmail, chart);
  var info = await getEventInfo(env, accessToken, eventId, cache);
  if (info.leaders.indexOf(viewerEmail) !== -1) return true;
  if (!info.area) return isTopManager(viewerEmail, chart);
  return canUseArea(viewerEmail, info.area, chart);
}

// Every pending row across every volunteer tab (except the viewer's own)
// that canDecideSubmission authorizes this viewer to decide — the one queue
// both a top-level manager and an Area-scoped manager/leader see in
// handleViewHours, just naturally filtered to what each is allowed to act on.
async function buildDecidableQueue(env, accessToken, volunteerTabs, batch, viewerEmail, chart, cache) {
  var pending = [];
  for (var vi = 0; vi < volunteerTabs.length; vi++) {
    var v = volunteerTabs[vi];
    if (v.email === viewerEmail) continue; // no self-approval — see handleDecideHours
    var rows = batch.byTitle[v.title] || [];
    for (var ri = 0; ri < rows.length; ri++) {
      var row = rows[ri];
      if (row[6] !== 'pending') continue;
      if (!(await canDecideSubmission(env, accessToken, row, viewerEmail, chart, cache))) continue;
      pending.push({ id: row[0], submittedAt: row[1], email: v.email, name: v.name || v.email, hours: row[2], date: row[3], event: row[4] });
    }
  }
  pending.sort(function (a, b) { return Date.parse(a.submittedAt) - Date.parse(b.submittedAt); });
  return pending;
}

// Who could still verify/deny a pending submission, for the "eligible to
// approve" tooltip (see hours-common.js statusTooltip) — mirrors
// canDecideSubmission's rule but returns display names/emails instead of a
// yes/no. Only ever used for that tooltip, so a resolution miss (event fetch
// fails) just means a shorter list, never an error.
async function resolveApproverNames(env, accessToken, eventId, excludeEmail, chart, cache) {
  var addedEmails = {};
  var labels = [];
  function add(email, nameByEmail) {
    email = normalizeEmail(email);
    if (!email || email === excludeEmail || addedEmails[email]) return;
    addedEmails[email] = true;
    labels.push((nameByEmail && nameByEmail[email]) || email);
  }

  if (!eventId) {
    listTopManagers(chart).forEach(function (email) { add(email); });
    return labels;
  }

  var info = await getEventInfo(env, accessToken, eventId, cache);
  info.leaders.forEach(function (email) { add(email, info.nameByEmail); });
  if (info.area) {
    var head = areaHead(info.area, chart);
    add(head, info.nameByEmail);
    getManagerChain(head, chart).forEach(function (email) { add(email, info.nameByEmail); });
  } else {
    listTopManagers(chart).forEach(function (email) { add(email); });
  }
  return labels;
}

// timeMin/timeMax come from the browser so the list lines up with the
// visitor's local days. Validate them instead of trusting them.
function readRange(url) {
  var now = Date.now();
  var day = 86400000;

  var min = parseIso(url.searchParams.get('timeMin'), now - 3 * day);
  var max = parseIso(url.searchParams.get('timeMax'), now + 8 * day);
  if (min === null || max === null) return { error: 'Invalid timeMin/timeMax.' };
  if (max <= min) return { error: 'timeMax must be after timeMin.' };
  if (max - min > MAX_RANGE_DAYS * day) return { error: 'Requested range is too large.' };

  return {
    timeMin: new Date(min).toISOString(),
    timeMax: new Date(max).toISOString()
  };
}

function parseIso(value, fallback) {
  if (!value) return fallback;
  var parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function clampInt(value, min, max, fallback) {
  var n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// Never surface the upstream body — it can echo the request URL (and key).
// accessToken is only set for the OAuth-backed calendar read; the YouTube
// call still authenticates with an API key and needs the Referer instead.
async function fetchUpstream(url, env, accessToken) {
  var init = { cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true } };

  if (accessToken) {
    init.headers = { Authorization: 'Bearer ' + accessToken };
  } else if (env.API_REFERRER) {
    // Keys created for browser use are often locked to an HTTP referrer, and
    // a Worker subrequest sends none. Set API_REFERRER to that allowed domain
    // and the existing key keeps working; drop the restriction in Google
    // Cloud and this var can go away.
    init.headers = { Referer: env.API_REFERRER };
  }

  var response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    return { error: 'Upstream request failed.', status: 502 };
  }

  if (!response.ok) {
    return {
      error: 'Upstream returned ' + response.status + '.',
      status: response.status === 404 ? 404 : 502
    };
  }

  try {
    return { body: await response.json() };
  } catch (err) {
    return { error: 'Upstream returned an unreadable response.', status: 502 };
  }
}

function json(body, status, extraHeaders) {
  var headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': status === 200
      ? 'public, max-age=' + CACHE_SECONDS
      : 'no-store'
  };
  Object.assign(headers, extraHeaders || {});
  return new Response(JSON.stringify(body), { status: status, headers: headers });
}

// json() marks 200s cacheable, which is right for the two read endpoints and
// wrong for every registration response.
function noStore(response) {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

function notFound() {
  return json({ error: 'Not found' }, 404);
}
