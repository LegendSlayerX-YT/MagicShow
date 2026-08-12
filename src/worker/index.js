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

   Config:
     vars    — CALENDAR_ID, CALENDAR_TIME_ZONE,
               YOUTUBE_PLAYLIST_ID, YOUTUBE_MAX_RESULTS,
               CALENDAR_SEND_UPDATES, GOOGLE_SIGNIN_CLIENT_ID,
               GOOGLE_SHEETS_ID, GOOGLE_SHEETS_HOURS_TAB
     secrets — YOUTUBE_API_KEY,
               GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET,
               GOOGLE_OAUTH_REFRESH_TOKEN
   =========================================================== */

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
      return json({ error: 'Method not allowed' }, 405, { Allow: url.pathname === '/api/hours' ? 'GET, HEAD, POST' : 'GET, HEAD' });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      var postOnlyPaths = ['/api/register', '/api/leaders', '/api/hours/decide'];
      var allow = url.pathname === '/api/hours' ? 'GET, HEAD, POST' :
        postOnlyPaths.indexOf(url.pathname) !== -1 ? 'POST' : 'GET, HEAD';
      return json({ error: 'Method not allowed' }, 405, { Allow: allow });
    }

    if (url.pathname === '/api/calendar') return handleCalendar(request, url, env);
    if (url.pathname === '/api/archives') return handleArchives(env);
    if (url.pathname === '/api/hours') return handleViewHours(request, env);
    if (url.pathname === '/api/register') return json({ error: 'Method not allowed' }, 405, { Allow: 'POST' });
    if (url.pathname === '/api/leaders') return json({ error: 'Method not allowed' }, 405, { Allow: 'POST' });
    if (url.pathname === '/api/hours/decide') return json({ error: 'Method not allowed' }, 405, { Allow: 'POST' });

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

  // Organizers (see ORGANIZER_EMAILS) don't register as guests — they pick
  // leaders from the guest list instead. isOrganizer is only ever derived
  // from a verified viewerEmail above, never from anything the client claims.
  var isOrganizer = !!viewerEmail && isOrganizerEmail(viewerEmail, env);

  // Attendee names are only included when the caller asks for them — the
  // past-events slider needs them, but the default (future) request should
  // keep costing nothing extra in exposed data. See trimEvent for why this
  // is otherwise never sent.
  var includeAttendees = url.searchParams.get('attendees') === '1';

  var events = (data.body.items || [])
    .filter(function (event) { return event && event.status !== 'cancelled'; })
    .map(function (event) { return trimEvent(event, viewerEmail, includeAttendees, isOrganizer); });

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

// Lets an organizer mark which registered guests are leading an event. Only
// callable by an email in ORGANIZER_EMAILS — verified the same way as
// /api/register, off a Google-signed credential the client can't forge.
async function handleLeaders(request, env) {
  var oauth = readOauthConfig(env);
  if (!oauth || !env.CALENDAR_ID || !env.GOOGLE_SIGNIN_CLIENT_ID) {
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
  if (!isOrganizerEmail(identity.email, env)) {
    return noStore(json({ error: 'Not authorized.' }, 403));
  }

  var requested = Array.isArray(body.leaders) ? body.leaders : [];
  var leaderEmails = requested
    .map(function (email) { return typeof email === 'string' ? normalizeEmail(email) : ''; })
    .filter(Boolean);

  var token = await getAccessToken(oauth);
  if (token.error) return noStore(json({ error: token.error }, token.status));

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

  // Leaders must be picked from the event's actual guest list — never let
  // the request write an arbitrary email into the description.
  var attendees = Array.isArray(event.attendees) ? event.attendees : [];
  var attendeeEmails = {};
  attendees.forEach(function (attendee) {
    var email = normalizeEmail(attendee && attendee.email);
    if (email) attendeeEmails[email] = true;
  });
  leaderEmails = leaderEmails.filter(function (email) { return attendeeEmails[email]; });

  var visible = splitDescription(event.description || '').visible;
  var payload = { description: buildDescription(visible, leaderEmails) };

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

  // The event name is looked up server-side from the id the client sent,
  // never trusted as free text — same reasoning as leaders only being
  // pickable from an event's actual guest list (see handleLeaders).
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
  }

  var row = [
    crypto.randomUUID(), new Date().toISOString(), identity.email, identity.name || identity.email,
    hours, date, eventSummary, 'pending', '', ''
  ];

  var appended = await sheetsAppendRow(env, token.value, row);
  if (appended.error) return noStore(json({ error: appended.error }, appended.status));

  return noStore(json({ submitted: true }, 200));
}

// Always requires a credential — unlike /api/calendar, there's no anonymous
// case here since every response is either "your own hours" or (for an
// organizer) other people's pending submissions.
async function handleViewHours(request, env) {
  var oauth = readOauthConfig(env);
  if (!oauth || !env.GOOGLE_SIGNIN_CLIENT_ID || !env.GOOGLE_SHEETS_ID) {
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

  var result = await sheetsGetRows(env, token.value);
  if (result.error) return noStore(json({ error: result.error }, result.status));

  // Organizers verify everyone's pending submissions; everyone else only
  // ever sees their own rows — an organizer's email is verified server-side
  // above, never claimed by the client (same pattern as isOrganizer on
  // /api/calendar).
  if (isOrganizerEmail(identity.email, env)) {
    var pending = result.rows
      .filter(function (row) { return row[7] === 'pending'; })
      .map(function (row) {
        return { id: row[0], submittedAt: row[1], email: row[2], name: row[3], hours: row[4], date: row[5], event: row[6] };
      })
      .sort(function (a, b) { return Date.parse(a.submittedAt) - Date.parse(b.submittedAt); });

    // Every volunteer who has ever submitted, deduped by email, so the
    // organizer's person picker only ever lists real submitters — same
    // "options come from real data, never free text" posture as the event
    // dropdown and the leader picker.
    var seenVolunteers = {};
    var volunteers = [];
    result.rows.forEach(function (row) {
      var rowEmail = normalizeEmail(row[2]);
      if (!rowEmail || seenVolunteers[rowEmail]) return;
      seenVolunteers[rowEmail] = true;
      volunteers.push({ email: rowEmail, name: row[3] || rowEmail });
    });
    volunteers.sort(function (a, b) { return a.name.localeCompare(b.name); });

    var personParam = normalizeEmail(new URL(request.url).searchParams.get('person') || '');
    if (personParam) {
      var personEntry = volunteers.filter(function (v) { return v.email === personParam; })[0];
      if (!personEntry) {
        return noStore(json({ error: 'Unknown volunteer.' }, 404));
      }
      var personRows = result.rows.filter(function (row) { return normalizeEmail(row[2]) === personParam; });
      var personTotal = personRows.reduce(function (sum, row) {
        return row[7] === 'verified' ? sum + (Number(row[4]) || 0) : sum;
      }, 0);
      var personSubmissions = personRows
        .map(function (row) {
          return { id: row[0], submittedAt: row[1], hours: row[4], date: row[5], event: row[6], status: row[7] };
        })
        .sort(function (a, b) { return Date.parse(b.submittedAt) - Date.parse(a.submittedAt); });

      return noStore(json({
        isOrganizer: true,
        volunteers: volunteers,
        person: personEntry,
        totalHours: Math.round(personTotal * 100) / 100,
        submissions: personSubmissions
      }, 200));
    }

    return noStore(json({ isOrganizer: true, pending: pending, volunteers: volunteers }, 200));
  }

  var mine = result.rows.filter(function (row) { return normalizeEmail(row[2]) === identity.email; });
  var totalHours = mine.reduce(function (sum, row) {
    return row[7] === 'verified' ? sum + (Number(row[4]) || 0) : sum;
  }, 0);
  var submissions = mine
    .map(function (row) {
      return { id: row[0], submittedAt: row[1], hours: row[4], date: row[5], event: row[6], status: row[7] };
    })
    .sort(function (a, b) { return Date.parse(b.submittedAt) - Date.parse(a.submittedAt); });

  return noStore(json({
    isOrganizer: false,
    totalHours: Math.round(totalHours * 100) / 100,
    submissions: submissions
  }, 200));
}

// Lets an organizer verify or deny one pending submission. Only callable by
// an email in ORGANIZER_EMAILS, verified the same way as /api/leaders.
async function handleDecideHours(request, env) {
  var oauth = readOauthConfig(env);
  if (!oauth || !env.GOOGLE_SIGNIN_CLIENT_ID || !env.GOOGLE_SHEETS_ID) {
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
  if (!isOrganizerEmail(identity.email, env)) {
    return noStore(json({ error: 'Not authorized.' }, 403));
  }

  var id = typeof body.id === 'string' ? body.id.trim() : '';
  var decision = body.decision === 'verify' ? 'verified' : body.decision === 'deny' ? 'denied' : '';
  if (!id || !decision) {
    return noStore(json({ error: 'Invalid request.' }, 400));
  }

  var token = await getAccessToken(oauth);
  if (token.error) return noStore(json({ error: token.error }, token.status));

  var result = await sheetsGetRows(env, token.value);
  if (result.error) return noStore(json({ error: result.error }, result.status));

  var index = result.rows.findIndex(function (row) { return row[0] === id; });
  if (index === -1) {
    return noStore(json({ error: 'Unknown submission.' }, 404));
  }
  if (result.rows[index][7] !== 'pending') {
    return noStore(json({ error: 'That submission was already decided.' }, 409));
  }

  var rowNumber = index + 2; // row 1 is the header; data starts at row 2
  var updated = await sheetsUpdateRange(
    env, token.value, 'H' + rowNumber + ':J' + rowNumber,
    [decision, identity.email, new Date().toISOString()]
  );
  if (updated.error) return noStore(json({ error: updated.error }, updated.status));

  return noStore(json({ decided: true, decision: decision }, 200));
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

function normalizeEmail(value) {
  if (typeof value !== 'string') return '';
  var email = value.trim().toLowerCase();
  if (email.length > 254) return '';
  return /^[^\s@,;:<>"]+@[^\s@.,;:<>"]+(\.[^\s@.,;:<>"]+)+$/.test(email) ? email : '';
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

/* ---------- volunteer hours (Google Sheets) ----------

   There's no database in this project — the volunteer-hours Sheet plays the
   same role Calendar plays for events. Same OAuth access token as
   getAccessToken above (the refresh token now also carries the spreadsheets
   scope; see scripts/google-oauth.mjs), just pointed at the Sheets API
   instead of the Calendar API.
   ------------------------------------------------------ */

var SHEETS_VALUES_BASE = 'https://sheets.googleapis.com/v4/spreadsheets/';

function sheetsTab(env) {
  return env.GOOGLE_SHEETS_HOURS_TAB || 'Volunteer Hours';
}

async function sheetsRequest(method, url, accessToken, body) {
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

// Skips the header row (row 1) — every row here is row index + 2 in the
// actual sheet. UNFORMATTED_VALUE keeps `hours` a JS number instead of a
// locale-formatted string.
async function sheetsGetRows(env, accessToken) {
  var range = encodeURIComponent(sheetsTab(env) + '!A2:J');
  var url = SHEETS_VALUES_BASE + encodeURIComponent(env.GOOGLE_SHEETS_ID) +
    '/values/' + range + '?valueRenderOption=UNFORMATTED_VALUE';
  var result = await sheetsRequest('GET', url, accessToken, null);
  if (result.error) return result;
  return { rows: result.body.values || [] };
}

async function sheetsAppendRow(env, accessToken, row) {
  var range = encodeURIComponent(sheetsTab(env) + '!A:J');
  var url = SHEETS_VALUES_BASE + encodeURIComponent(env.GOOGLE_SHEETS_ID) +
    '/values/' + range + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS';
  return sheetsRequest('POST', url, accessToken, { values: [row] });
}

async function sheetsUpdateRange(env, accessToken, a1Range, row) {
  var range = encodeURIComponent(sheetsTab(env) + '!' + a1Range);
  var url = SHEETS_VALUES_BASE + encodeURIComponent(env.GOOGLE_SHEETS_ID) +
    '/values/' + range + '?valueInputOption=RAW';
  return sheetsRequest('PUT', url, accessToken, { values: [row] });
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
function trimEvent(event, viewerEmail, includeAttendees, isOrganizer) {
  // Leader picks live as a JSON tail on the event description (see
  // splitDescription) so no extra Calendar field/permission is needed. The
  // visible part is all that ever reaches the browser as `description` —
  // for every viewer, organizer included — so the tail never shows up in
  // page content or a fetch() response body.
  var parsedDescription = splitDescription(event.description || '');
  var trimmed = {
    // The page sends this back to /api/register. Not a secret — Google
    // event ids aren't guessable-but-sensitive, just opaque identifiers.
    id: event.id || '',
    summary: event.summary || '',
    location: event.location || '',
    description: parsedDescription.visible,
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
  // is the organizer when Google also lists them as an attendee.
  if (includeAttendees) {
    var guests = Array.isArray(event.attendees) ? event.attendees : [];
    var leaderEmails = {};
    parsedDescription.leaders.forEach(function (email) { leaderEmails[email] = true; });
    trimmed.leads = [];
    trimmed.volunteers = [];
    guests.forEach(function (attendee) {
      if (!attendee || attendee.resource || attendee.organizer || attendee.responseStatus === 'declined') return;
      var name = attendee.displayName || 'Guest';
      var email = normalizeEmail(attendee.email);
      (email && leaderEmails[email] ? trimmed.leads : trimmed.volunteers).push(name);
    });
  }
  // Organizers pick leaders from the guest list, so — unlike the public
  // leads/volunteers names above — they need enough to tell guests apart
  // (email) plus which ones are already marked as leaders.
  if (isOrganizer) {
    var candidates = Array.isArray(event.attendees) ? event.attendees : [];
    trimmed.attendeeDetails = candidates
      .filter(function (attendee) {
        return attendee && !attendee.resource && !attendee.organizer && attendee.responseStatus !== 'declined';
      })
      .map(function (attendee) {
        return { email: normalizeEmail(attendee.email), name: attendee.displayName || attendee.email || 'Guest' };
      })
      .filter(function (attendee) { return attendee.email; });
    trimmed.leaders = parsedDescription.leaders;
  }
  return trimmed;
}

/* ---------- leader picks (stored in the event description) ----------

   Organizers mark which registered guests are leading a given event. That
   pick has no field of its own on a Calendar event, so it's kept as a JSON
   line appended after the human-written description — plain visible text,
   not hidden markup, so it survives an organizer editing the description in
   the Google Calendar UI (rather than risk the UI's rich-text editor
   silently stripping something it treats as inert markup on save) and so
   the pick is visible/auditable directly on the event if anyone goes
   looking. trimEvent always strips it back out before `description` reaches
   any client on this site — the public gets it back out as the leads/
   volunteers split, organizers additionally get the raw parsed `leaders`
   field — so it never shows up in this site's own pages or responses.
   ----------------------------------------------------------------- */

var LEADER_MARKER = '\n\nLeaders (auto-managed by the website, do not edit): ';

function splitDescription(raw) {
  var idx = raw.lastIndexOf(LEADER_MARKER);
  if (idx === -1) return { visible: raw, leaders: [] };

  var tail = raw.slice(idx + LEADER_MARKER.length).trim();
  var parsed;
  try {
    parsed = JSON.parse(tail);
  } catch (err) {
    return { visible: raw, leaders: [] };
  }

  var emails = Array.isArray(parsed && parsed.emails) ?
    parsed.emails.filter(function (email) { return typeof email === 'string'; }) : [];
  return { visible: raw.slice(0, idx), leaders: emails };
}

function buildDescription(visible, leaderEmails) {
  var base = visible.replace(/\s+$/, '');
  if (!leaderEmails.length) return base;
  return base + LEADER_MARKER + JSON.stringify({ emails: leaderEmails });
}

function isOrganizerEmail(email, env) {
  var list = (env.ORGANIZER_EMAILS || '').split(',')
    .map(function (raw) { return normalizeEmail(raw); })
    .filter(Boolean);
  return list.indexOf(email) !== -1;
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
