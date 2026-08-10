# Gasp Machine — Magic Club Website

A website for the Gasp Machine magic club, hosted on Cloudflare. The pages are
plain HTML, CSS, and frontend JavaScript; a small Worker relays the two Google
API calls so the API keys never reach the browser.

- **Home** (`index.html`) — welcome page with an animated "magic" background (drifting card suits + sparkles) and a contact form.
- **About Us** (`about.html`) — club member cards (currently Henry Chen).
- **Calendar** (`calendar.html`) — public Google Calendar events fetched and rendered in a themed list for the rolling window from 3 days ago through 7 days ahead.
- **Archives** (`archives.html`) — previous shows, pulled **live** from your public YouTube playlist, with a local fallback list.

---

## Project structure

```
MagicShow/
├── wrangler.jsonc          # Cloudflare Workers config (assets + Worker + vars)
├── .dev.vars.example       # Template for local API keys — copy to .dev.vars
└── src/
    ├── worker/
    │   └── index.js        # /api/* relay; holds the Google API keys
    └── client/             # The static website
        ├── index.html      # Home
        ├── about.html      # About Us
        ├── calendar.html   # Calendar (public Google Calendar events)
        ├── archives.html   # Archives (videos)
        ├── css/styles.css  # All styles
        └── js/
            ├── calendar.js # Calls /api/calendar + renders the rolling date range
            ├── main.js     # Nav toggle + footer year
            ├── magic-bg.js # Home animated background
            ├── config.js   # ← EDIT THIS: video overrides + fallback list
            └── archives.js # Calls /api/archives + renders the shows
```

## The API relay

The browser used to call Google directly with an API key embedded in
`config.js`, which meant anyone could read the key from the page source. Now
the pages call their own origin and the Worker adds the key server-side:

| Endpoint | Returns |
| --- | --- |
| `GET /api/calendar?timeMin=…&timeMax=…` | `{ timeZone, events[] }` — public events, trimmed to the fields the page renders |
| `GET /api/archives` | `{ videos[] }` — playlist items, filtered and newest-first |

The Worker validates the requested date range, caches upstream responses at the
edge for 5 minutes, and never forwards Google's raw error bodies (they can echo
the request URL, key included). Anything that isn't `/api/*` is served from
`src/client` as a static asset.

### Configuration

Non-secret settings live in `wrangler.jsonc` under `vars`:

| Var | Purpose |
| --- | --- |
| `CALENDAR_ID` | Which public Google Calendar to read |
| `CALENDAR_TIME_ZONE` | Time zone used to render event times |
| `YOUTUBE_PLAYLIST_ID` | Playlist behind the Archives page |
| `YOUTUBE_MAX_RESULTS` | Playlist items to request (1–50) |
| `API_REFERRER` | Sent as the `Referer` on Google calls — see below |

The keys are secrets, set once per environment:

```bash
wrangler secret put GOOGLE_CALENDAR_API_KEY
wrangler secret put YOUTUBE_API_KEY
```

If `GOOGLE_CALENDAR_API_KEY` isn't set, the Worker falls back to
`YOUTUBE_API_KEY` for calendar requests, matching the old `config.js` behavior.

### About `API_REFERRER`

These keys were created as browser keys, restricted in Google Cloud to the
referrer `https://magician.chen-henry.org/*`. A Worker sends no referrer, so
Google rejects the call with `API_KEY_HTTP_REFERRER_BLOCKED`. `API_REFERRER`
makes the Worker send that domain as the `Referer` so the existing keys keep
working.

Now that the keys are server-side, referrer restriction no longer protects
anything. The cleaner setup is to switch each key's application restriction to
**None**, keep the **API restriction** (YouTube Data API v3 / Google Calendar
API), and delete `API_REFERRER` from `wrangler.jsonc`.

## Running locally

```bash
cp .dev.vars.example .dev.vars   # then paste your keys in
npx wrangler dev                 # or ./start.sh
```

`.dev.vars` is gitignored. A plain static server (`python3 -m http.server`)
will serve the pages but not `/api/*`, so the Calendar page shows an error and
Archives shows the fallback list.

---

## Managing the Archives videos

Custom titles and the fallback list live in **`src/client/js/config.js`**. The
playlist itself is configured server-side (`YOUTUBE_PLAYLIST_ID` and
`YOUTUBE_MAX_RESULTS` in `wrangler.jsonc`).

### Showing videos live
The Archives page fetches `/api/archives`, which the Worker backs with the
**YouTube Data API v3**, so new videos appear automatically.

### Custom titles & captions
YouTube's raw titles aren't always what you want on the page. Add an entry to
`overrides` (keyed by the video's ID — the part after `watch?v=`):

```js
overrides: {
  'SY8CQuHmOJw': {
    title: 'Polka Dot Handkerchief',
    caption: 'Volunteer Magic Show on Lunar New Year Celebration'
  }
}
```

### No API key? It still works.
If the relay isn't configured or the request fails, the page renders the
`fallback` list in `config.js`. Keep that list current and the site always
shows your shows.

---

## Editing content

- **Contact form** — `src/client/index.html`, in the `.contact` section.
- **Club members** — `src/client/about.html`. Copy a `<article class="member">` block to add
  someone. Swap the letter avatar for a photo with
  `<img class="member__avatar" src="path/to/photo.jpg" alt="Name">`.
- **Colors / fonts** — the `:root` variables at the top of `src/client/css/styles.css`.

---

## Deploying

The site deploys as one Cloudflare Worker: static assets from `src/client`
plus the `/api/*` relay.

1. Install Wrangler if needed: `npm install -g wrangler`
2. Log in: `wrangler login`
3. Set the two secrets (once per environment):
   ```bash
   wrangler secret put GOOGLE_CALENDAR_API_KEY
   wrangler secret put YOUTUBE_API_KEY
   ```
4. Deploy from the repo root: `wrangler deploy`

To keep the site static while still hiding your email address, the homepage
contact form is set up for Formspree. Create a form in Formspree, then replace
`YOUR_FORM_ID` in `src/client/index.html` with the form ID from your Formspree
dashboard. After that, submissions can go through Formspree without showing
your email in the page HTML.

The provided `wrangler.jsonc` publishes `src/client` as the site's asset
directory. After the first deploy, attach your custom domain in Cloudflare.
