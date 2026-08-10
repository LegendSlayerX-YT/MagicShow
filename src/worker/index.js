/* ===========================================================
   API relay Worker
   -----------------------------------------------------------
   The browser never sees a Google API key. The site calls
   /api/calendar and /api/archives on its own origin; this
   Worker adds the key server-side, trims the upstream payload
   down to what the pages actually render, and caches at the
   edge so we stay well inside the Google quotas.

   Everything that isn't /api/* is handed back to the static
   asset handler (src/client).

   Config:
     vars    — CALENDAR_ID, CALENDAR_TIME_ZONE,
               YOUTUBE_PLAYLIST_ID, YOUTUBE_MAX_RESULTS
     secrets — GOOGLE_CALENDAR_API_KEY, YOUTUBE_API_KEY
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

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json({ error: 'Method not allowed' }, 405, { Allow: 'GET, HEAD' });
    }

    if (url.pathname === '/api/calendar') return handleCalendar(url, env);
    if (url.pathname === '/api/archives') return handleArchives(env);

    return notFound();
  }
};

/* ---------- routes ---------- */

async function handleCalendar(url, env) {
  var key = env.GOOGLE_CALENDAR_API_KEY || env.YOUTUBE_API_KEY;
  var calendarId = env.CALENDAR_ID;
  if (!key || !calendarId) {
    return json({ error: 'Calendar relay is not configured.' }, 503);
  }

  var timeZone = env.CALENDAR_TIME_ZONE || 'UTC';
  var range = readRange(url);
  if (range.error) return json({ error: range.error }, 400);

  var params = new URLSearchParams({
    key: key,
    singleEvents: 'true',
    orderBy: 'startTime',
    timeMin: range.timeMin,
    timeMax: range.timeMax,
    timeZone: timeZone
  });

  var upstream = 'https://www.googleapis.com/calendar/v3/calendars/' +
    encodeURIComponent(calendarId) + '/events?' + params.toString();

  var data = await fetchUpstream(upstream, env);
  if (data.error) return json({ error: data.error }, data.status);

  var events = (data.body.items || [])
    .filter(function (event) { return event && event.status !== 'cancelled'; })
    .map(trimEvent);

  return json({ timeZone: timeZone, events: events }, 200);
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

/* ---------- helpers ---------- */

// Only forward the fields the calendar page renders. Google returns
// attendees, organizer emails, and conferencing links we don't want public.
function trimEvent(event) {
  var trimmed = {
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

// Never surface the upstream body — it can echo the request URL (and key).
async function fetchUpstream(url, env) {
  var init = { cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true } };

  // Keys created for browser use are often locked to an HTTP referrer, and a
  // Worker subrequest sends none. Set API_REFERRER to that allowed domain and
  // the existing keys keep working; drop the restriction in Google Cloud and
  // this var can go away.
  if (env.API_REFERRER) init.headers = { Referer: env.API_REFERRER };

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

function notFound() {
  return json({ error: 'Not found' }, 404);
}
