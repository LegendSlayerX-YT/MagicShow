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

   Config:
     vars    — CALENDAR_ID, CALENDAR_TIME_ZONE,
               YOUTUBE_PLAYLIST_ID, YOUTUBE_MAX_RESULTS,
               CALENDAR_SEND_UPDATES, GOOGLE_SIGNIN_CLIENT_ID
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
      return json({ error: 'Method not allowed' }, 405, { Allow: 'GET, HEAD' });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      var allow = url.pathname === '/api/register' ? 'POST' : 'GET, HEAD';
      return json({ error: 'Method not allowed' }, 405, { Allow: allow });
    }

    if (url.pathname === '/api/calendar') return handleCalendar(request, url, env);
    if (url.pathname === '/api/archives') return handleArchives(env);
    if (url.pathname === '/api/register') return json({ error: 'Method not allowed' }, 405, { Allow: 'POST' });

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
  if (authHeader.indexOf('Bearer ') === 0 && env.GOOGLE_SIGNIN_CLIENT_ID) {
    var identity = await verifyGoogleIdToken(authHeader.slice(7), env.GOOGLE_SIGNIN_CLIENT_ID);
    if (!identity.error) viewerEmail = identity.email;
  }

  var events = (data.body.items || [])
    .filter(function (event) { return event && event.status !== 'cancelled'; })
    .map(function (event) { return trimEvent(event, viewerEmail); });

  return json({
    timeZone: timeZone,
    // Reaching here already proved the calendar-owner OAuth credentials
    // work; registration also needs the Sign in with Google client id.
    registrationOpen: !!env.GOOGLE_SIGNIN_CLIENT_ID,
    events: events
  }, 200, viewerEmail ? { 'Cache-Control': 'private, no-store' } : null);
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

    var payload = {
      attendees: attendees.concat([{ email: email, responseStatus: 'needsAction' }]),
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
  return { email: email };
}

/* ---------- helpers ---------- */

// Only forward the fields the calendar page renders. Google returns
// attendees, organizer emails, and conferencing links we don't want public.
function trimEvent(event, viewerEmail) {
  var trimmed = {
    // The page sends this back to /api/register. Not a secret — it's the
    // same id already encoded in htmlLink's `eid` parameter.
    id: event.id || '',
    summary: event.summary || '',
    location: event.location || '',
    description: event.description || '',
    htmlLink: event.htmlLink || '',
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
  return trimmed;
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
