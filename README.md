# Gasp Machine — Magic Club Website

A website for the Gasp Machine magic club, hosted on Cloudflare. The pages are
plain HTML, CSS, and frontend JavaScript; a small Worker relays the two Google
API calls so the API keys never reach the browser.

- **Home** (`index.html`) — welcome page with an animated "magic" background (drifting card suits + sparkles) and a contact form.
- **About Us** (`about.html`) — club member cards (currently Henry Chen).
- **Calendar** (`calendar.html`) — public Google Calendar events fetched and rendered in a themed list for the rolling window from 3 days ago through 7 days ahead. Upcoming events have a **Register** button that adds the visitor's email to the event's guest list. Signed-in visitors with standing in the [org chart](#org-chart) also get an **Add Event** button, for creating a new event tagged with a functional Area.
- **Archives** (`archives.html`) — previous shows, pulled **live** from your public YouTube playlist, with a local fallback list.
- **Volunteer Hour Submission** (`hours.html`) — signed-in visitors log hours (amount, date, and optionally which event, or a free-text title when no event applies) to a Google Sheet, and see their own submission history plus a running total of verified hours.
- **Volunteer Hour Approval** (`hours-approval.html`) — whoever the [org chart](#org-chart) authorizes for a given submission (the event's leader, its Area's Head or manager chain, or a top-level organizer for hours with no event attached) sees a pending queue with Verify/Deny buttons; top-level organizers additionally get a volunteer picker to look up any submitter's total verified hours and full submission history. The dropdown under the account avatar links to whichever of these two pages applies to the signed-in visitor.

---

## Project structure

```
MagicShow/
├── wrangler.jsonc          # Cloudflare Workers config (assets + Worker + vars)
├── .dev.vars.example       # Template for local API keys — copy to .dev.vars
├── scripts/
│   ├── google-oauth.mjs             # One-time consent → refresh token (calendar + sheets)
│   ├── create-hours-sheet.mjs       # One-time: creates the volunteer-hours Google Sheet
│   ├── create-org-chart-tabs.mjs    # One-time: creates the Areas + Org Chart tabs
│   └── migrate-hours-to-tabs.mjs    # One-time: splits old shared rows into per-volunteer tabs
└── src/
    ├── worker/
    │   ├── index.js         # /api/* relay; holds the Google API keys
    │   ├── org-chart.js     # Areas + Org Chart tabs → manager-chain permission checks
    │   ├── hours-sheet.js   # Volunteer-hours Sheets helpers
    │   └── util.js          # Shared helpers
    └── client/             # The static website
        ├── index.html      # Home
        ├── about.html      # About Us
        ├── calendar.html   # Calendar (public Google Calendar events + Add Event)
        ├── archives.html   # Archives (videos)
        ├── hours.html          # Volunteer Hour Submission (log hours)
        ├── hours-approval.html # Volunteer Hour Approval (verify queue)
        ├── css/styles.css      # All styles
        └── js/
            ├── calendar.js      # Calls /api/calendar(+/events,/areas) + renders the rolling date range
            ├── main.js          # Nav toggle + footer year
            ├── magic-bg.js      # Home animated background
            ├── config.js        # ← EDIT THIS: video overrides + fallback list
            ├── archives.js      # Calls /api/archives + renders the shows
            ├── hours-common.js  # Shared helpers for the two hours pages
            ├── hours.js         # Calls /api/hours + renders the log form
            └── hours-approval.js # Calls /api/hours(+/decide) + renders the verify queue
```

## The API relay

The browser used to call Google directly with an API key embedded in
`config.js`, which meant anyone could read the key from the page source. Now
the pages call their own origin and the Worker adds the key server-side:

| Endpoint | Returns |
| --- | --- |
| `GET /api/calendar?timeMin=…&timeMax=…` | `{ timeZone, events[] }` — public events, trimmed to the fields the page renders (each event includes its tagged `area`, if any) |
| `GET /api/archives` | `{ videos[] }` — playlist items, filtered and newest-first |
| `POST /api/register` | `{ registered, alreadyRegistered }` — adds one email to one event's guest list |
| `GET /api/areas` | Requires `Authorization: Bearer <Google ID token>`. `{ areas[] }` — the functional Areas the signed-in visitor may create/lead events for (see [Org chart](#org-chart)) |
| `POST /api/events` | Requires a matching Area authorization (see [Org chart](#org-chart)). `{ created: true, eventId }` — creates a new Calendar event tagged with the given Area |
| `GET /api/hours` | Requires `Authorization: Bearer <Google ID token>`. Top-level organizers get `{ isOrganizer: true, pending[], volunteers[] }`; anyone with narrower standing (an event leader, or an Area's Head/manager chain) gets `{ isOrganizer: false, isLeader: true, totalHours, submissions[], pending[] }` scoped to what they may decide; everyone else gets `{ isOrganizer: false, totalHours, submissions[] }` for just their own rows |
| `GET /api/hours?person=<email>` | Top-level-organizer-only. `{ isOrganizer: true, volunteers[], person, totalHours, submissions[] }` — one volunteer's full history and verified-hours total, for the organizer's person picker |
| `POST /api/hours` | `{ submitted: true }` — appends one volunteer-hours row (`pending`) to the Google Sheet |
| `POST /api/hours/decide` | Requires standing over that submission (see [Org chart](#org-chart)). `{ decided: true, decision }` — marks one row `verified` or `denied` |

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
| `CALENDAR_SEND_UPDATES` | `all` emails the guest their invitation; `none` adds them silently |
| `GOOGLE_SIGNIN_CLIENT_ID` | OAuth Client ID for Sign in with Google — see [below](#sign-in-with-google) |
| `GOOGLE_SHEETS_ID` | Spreadsheet ID backing Volunteer Hours **and** the [org chart](#org-chart) (`Areas` + `Org Chart` tabs) |

Calendar reads authenticate as the calendar's owner over OAuth — see
"Event registration" below for how that credential is set up; it backs both
`/api/calendar` and `/api/register`. The YouTube key is the one API-key
secret left:

```bash
wrangler secret put YOUTUBE_API_KEY
```

### About `API_REFERRER`

The YouTube key was created as a browser key, restricted in Google Cloud to
the referrer `https://magician.chen-henry.org/*`. A Worker sends no referrer,
so Google rejects the call with `API_KEY_HTTP_REFERRER_BLOCKED`.
`API_REFERRER` makes the Worker send that domain as the `Referer` so the
existing key keeps working.

Now that the key is server-side, referrer restriction no longer protects
anything. The cleaner setup is to switch the key's application restriction to
**None**, keep the **API restriction** (YouTube Data API v3), and delete
`API_REFERRER` from `wrangler.jsonc`.

---

## Org chart

Two tabs in the same spreadsheet as Volunteer Hours (`GOOGLE_SHEETS_ID`) hold
the club's people hierarchy, read by `src/worker/org-chart.js`. This is the
sole source of who may create a Calendar event for a given functional Area,
who may approve volunteer hours tied to it, and who counts as a top-level
organizer — it replaced the old hardcoded `ORGANIZER_EMAILS` var.

| Tab | Columns | Meaning |
| --- | --- | --- |
| `Areas` | `Area`, `Head` | One row per functional area (e.g. "Cooking", "Environment", "Science") — `Head` is that area's leader. |
| `Org Chart` | `Employee`, `Manager` | One row per person — `Manager` is blank for a top-level organizer. More than one top-level organizer is fine (e.g. one per Area tree, or a shared handful for the whole club). |

`Head`, `Employee`, and `Manager` each accept either a bare email or `Name
(email)` — the same convention already used elsewhere in this spreadsheet
(volunteer tabs, `decidedBy`), parsed the same way. A cell that's neither
(or that just names someone with no `(email)`) doesn't match anyone: an
unparseable `Head`/`Employee` drops that row, and — this is the one to get
right — an unparseable or blank `Manager` is read as "no manager," i.e. a
top-level organizer, so a typo there can silently over-grant, not
under-grant.

**A person may act for an Area** — create events tagged with it (see "Event
registration" below) and approve volunteer hours tied to it (see "Volunteer
hours" below) — **if they're that Area's Head, or if the Head reports up to
them**, directly or transitively, per `Org Chart`. Someone listed in `Org
Chart` with a blank `Manager` is a **top-level organizer**: no Register
button on the Calendar page (they get the leader-picking control instead),
the full volunteer picker on the Approval page, and the sole approver for
volunteer hours that have no Calendar event attached (the free-text case —
there's no Area to check standing against).

### One-time setup

```bash
node scripts/create-org-chart-tabs.mjs
```

Creates the `Areas` and `Org Chart` tabs (with header rows) in the
spreadsheet at `GOOGLE_SHEETS_ID` — safe to re-run, a tab that already exists
is left untouched. Then fill in the rows by hand directly in Google Sheets:

- `Areas` — one row per functional area, `Head` is that person (`Name
  (email)` or a bare email).
- `Org Chart` — one row per person, `Manager` is their manager (same
  format), blank for a top-level organizer.

Both tabs are read by every `/api/*` endpoint that checks authorization
(`getOrgChart` in `org-chart.js`), cached in the Worker for a minute so one
page load's several calls don't each re-read both tabs from Sheets. A change
to either tab takes effect within that minute, no redeploy needed.

---

## Event registration

Each upcoming event on the Calendar page has a **Register** button. Visitors
sign in with the **Sign in with Google** control in the top-right of the nav;
clicking Register then POSTs their Google ID token (not a typed-in email) to
`/api/register`, and the Worker verifies it with Google before adding that
verified address to the event's Google Calendar guest list. With
`CALENDAR_SEND_UPDATES: "all"` Google emails them the invitation, so they can
RSVP and get the event on their own calendar. Clicking Register while signed
out just prompts them to sign in — there's no manual-email fallback, by
design (see [`GOOGLE_SIGNIN_CLIENT_ID` setup](#sign-in-with-google) below).

`/api/calendar` reads authenticate with this same OAuth credential rather
than a separate API key — one Google credential to manage instead of two.

### Why this needs OAuth and not an API key

API keys are read-only, so the write needs real credentials. The obvious choice —
a service account — **does not work here.** Google rejects any attendee change
made by a service account:

```
403 forbiddenForServiceAccounts
Service accounts cannot invite attendees without Domain-Wide Delegation of Authority.
```

Domain-Wide Delegation is a Google Workspace feature and can't be enabled for a
personal `gmail.com` calendar. So the Worker acts as the **calendar's owner**
instead: the owner grants consent once, and the Worker keeps the resulting
refresh token.

### One-time setup

1. In the [Google Cloud console](https://console.cloud.google.com/apis/credentials),
   create an **OAuth 2.0 Client ID** of type **Web application** with the
   authorized redirect URI:
   ```
   http://localhost:8976/callback
   ```
2. On the **OAuth consent screen**, add the calendar owner
   (`chenhenrybunny@gmail.com`) as a test user, then **publish the app**.
   While the app is still in *Testing*, Google expires refresh tokens after
   7 days and registrations start failing.
3. Run the consent flow and sign in **as the calendar owner**:
   ```bash
   node scripts/google-oauth.mjs <client-id> <client-secret>
   ```
4. Paste the three values it prints into `.dev.vars`, then `./deploy.sh`.

The scope requested is `calendar.events` — enough to edit events, not enough to
touch calendar settings or any other Google data.

### Sign in with Google

This is a **separate** OAuth Client ID from the one above — that one is the
calendar owner's consent for writing to the calendar; this one just lets a
visitor prove which Google account they're clicking Register with. It uses
[Google Identity Services](https://developers.google.com/identity/gsi/web)
(`src/client/js/auth.js`), which hands the browser a signed ID token; the
Worker re-verifies that token with Google (`verifyGoogleIdToken` in
`src/worker/index.js`) before trusting the email — a visitor can't just edit
the page to submit an arbitrary address.

1. In the [Google Cloud console](https://console.cloud.google.com/apis/credentials),
   reuse the same OAuth Client ID from the section above, or create a new
   **Web application** Client ID — either works, since Client IDs aren't
   secret and can serve more than one purpose. Add your site's origin under
   **Authorized JavaScript origins**:
   ```
   https://magician.chen-henry.org
   ```
   (and `http://localhost:8788` or whichever port `wrangler dev` prints, for
   local testing).
2. Set the Client ID in **two** places — they must match, since the Worker
   checks it as the token's `aud`:
   - `GOOGLE_SIGNIN_CLIENT_ID` in `wrangler.jsonc` (`vars`, not a secret).
   - `googleSignInClientId` in `src/client/js/config.js`.
3. Deploy. Until both are set, `/api/calendar` reports `registrationOpen:
   false` and the Register button doesn't render at all — same "don't show a
   button that can only fail" logic as the rest of the site.

### Guarding the endpoint

`/api/register` is unauthenticated by necessity, so the Worker limits what it
can be used for:

- 5 requests per minute per IP (per isolate — add a Cloudflare rate-limit rule
  on the path if that isn't enough).
- Only events that haven't ended and start within 92 days, so a guessed event
  id can't be used to edit older or far-future entries.
- 200 guests per event, and a repeat email is a no-op rather than a duplicate.
- Requests must be `application/json` and same-origin, which blocks a
  cross-site `<form>` POST.
- The email comes from a Google ID token the Worker verifies server-side, not
  a client-supplied string, so a visitor can't register an address they don't
  control.
- Guest lists themselves are never returned to the browser — `/api/calendar`
  still strips `attendees` from every event. The one deliberate exception: a
  signed-in visitor gets a `registered: true/false` flag for their *own*
  status per event (so Register can show "Registered" without a click),
  computed server-side from the same data and never exposing who else is on
  the list.

If Google ever rejects the refresh token (`invalid_grant` in `wrangler tail`),
re-run step 3 and set the secret again.

### Creating events (Add Event)

Signed-in visitors with standing over at least one Area (see
[Org chart](#org-chart)) get an **Add Event** button above the Calendar list.
The form asks for a Title, an Area (only the ones that visitor may use), an
optional Location/Description, and either a timed start/end or an all-day
date range. Submitting POSTs to `/api/events`, which re-checks that Area
authorization server-side — never trusts anything the client claims — before
creating the event on the configured `CALENDAR_ID` and tagging it with the
picked Area (stored the same way leader picks are — see "Leader picks" tail
format in `src/worker/index.js`). Newly created events start with no
leaders; an organizer picks those afterward from the guest list the same way
as any other event, once people have registered.

---

## Volunteer hours

The **Volunteer Hour Submission** page (`hours.html`) lets any signed-in
visitor log hours — amount, date, and either an event picked from a dropdown
of real Calendar events (so names can't be typo'd or made up) or, when no
event applies, a free-text title. There's no database in this project, so
submissions are appended as rows to a **Google Sheet**, the same way Calendar
is the datastore for events. Anyone with decide authority over at least one
pending submission (see below) gets a separate **Volunteer Hour Approval**
page (`hours-approval.html`) instead: a pending queue with
**Verify**/**Deny** buttons, scoped to just the submissions they're allowed
to decide. A verified row counts toward that volunteer's running total,
shown back to them on the Submission page. The dropdown under the account
avatar always links to whichever page applies to the signed-in visitor.

**Who can decide a pending submission** (`canDecideSubmission` in
`src/worker/index.js`) — checked fresh on every decide, never against a
cached list:

- **The event's leader** — the guests a top-level organizer marks as leading
  a given event (see "Event registration" → leader picks above): authorized
  for submissions tied to that event, regardless of its Area.
- **The event's Area Head, or anyone that Head reports up to** — per the
  [org chart](#org-chart), same relation that authorizes creating the event
  in the first place.
- **A top-level organizer** — the sole fallback for a submission with no
  event attached (the free-text case, with no Area to check standing
  against) or whose event has no Area tagged (e.g. one created before this
  feature existed).

Nobody can approve/deny hours they submitted themselves, even a top-level
organizer — someone else with standing has to sign off instead. Anyone with
narrower-than-top-level standing (an event leader, or an Area's Head/manager
chain) still lands on the Submission page to log their own hours too — it
just shows a link over to the Approval page for what they can review. Only
top-level organizers get the additional volunteer picker (browse anyone's
full history) on the Approval page.

Each volunteer gets their **own tab** in the spreadsheet, titled `Name
(email)` — created automatically the first time they submit. That means the
organizer's volunteer picker just reads the spreadsheet's tab titles (one
cheap metadata call), and a volunteer's own history is just their one tab
instead of a filter over every row anyone has ever submitted.

### Why this needs the same OAuth credential as Calendar

Same reasoning as event registration: writing to a Sheet the club owns needs
real credentials, not a read-only API key, and a service account can't act as
a personal-account owner without Workspace-only Domain-Wide Delegation. So
`/api/hours` reuses the calendar-owner's OAuth refresh token — just with the
Sheets scope added alongside the Calendar one.

### One-time setup

1. **Widen the OAuth scope.** If you already set up event registration before
   volunteer hours existed, your refresh token only carries `calendar.events`
   and will fail on Sheets calls. Re-run the consent flow to get a token that
   also carries `spreadsheets`:
   ```bash
   node scripts/google-oauth.mjs <client-id> <client-secret>
   ```
   Paste the refreshed values into `.dev.vars` (same three keys as before).
2. **Create the spreadsheet.** Using that same refresh token (already in
   `.dev.vars` from step 1):
   ```bash
   node scripts/create-hours-sheet.mjs
   ```
   This creates an empty spreadsheet titled "Gasp Machine — Volunteer Hours"
   and prints the spreadsheet ID — no tabs to set up by hand, since the
   Worker creates one per volunteer on demand.
3. Paste that ID into `wrangler.jsonc` → `vars.GOOGLE_SHEETS_ID`, then
   `./deploy.sh`.

### Migrating from the old shared-tab layout

Earlier versions of this site kept every volunteer's rows in that one shared
`Volunteer Hours` tab. If you already have data there, split it into
per-volunteer tabs once with:

```bash
node scripts/migrate-hours-to-tabs.mjs
```

It reads every row out of `Volunteer Hours`, groups them by volunteer, and
creates each volunteer's tab with their history already in it — using the
same naming logic the Worker itself uses, so the result is identical to what
you'd get if they'd submitted those hours fresh under the new layout. The old
`Volunteer Hours` tab is left in place untouched (the Worker no longer reads
it — see `parseTabTitle` in `src/worker/index.js`); once you've spot-checked
the new tabs you can archive or delete it by hand. Safe to re-run — a
volunteer who already has a tab is skipped rather than getting duplicate
rows.

### Sheet layout

One tab per volunteer, titled `Name (email)` (built by `buildTabTitle` in
`src/worker/index.js` — the email keeps the title unique even if two
volunteers share a name). Header row 1, data from row 2 in each tab — so it's
readable directly in Sheets, not just through the site:

| Column | Meaning |
| --- | --- |
| `id` | UUID the Worker generates on submit — how `/api/hours/decide` finds the row |
| `submittedAt` | ISO timestamp of the submission |
| `hours` | 0–24, entered by the volunteer |
| `date` | The date they volunteered, `YYYY-MM-DD` |
| `event` | Resolved server-side from the picked Calendar event's real `summary` — never trusted as free text from the client |
| `eventId` | The picked Calendar event's id, blank when the volunteer typed a free-text title instead — what `/api/hours/decide` checks event leaders against |
| `status` | `pending` \| `verified` \| `denied` |
| `decidedBy` / `decidedAt` | The organizer's email + when, filled in on verify/deny |

There's no `email`/`name` column — the tab itself is the volunteer.

---

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
3. Set the secrets (once per environment):
   ```bash
   wrangler secret put YOUTUBE_API_KEY
   # Calendar reads + registrations — see "Event registration" above
   wrangler secret put GOOGLE_OAUTH_CLIENT_ID
   wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET
   wrangler secret put GOOGLE_OAUTH_REFRESH_TOKEN
   ```
4. Deploy from the repo root: `wrangler deploy`

`./deploy.sh` does steps 3 and 4 in one go, reading every key from `.dev.vars`.

To keep the site static while still hiding your email address, the homepage
contact form is set up for Formspree. Create a form in Formspree, then replace
`YOUR_FORM_ID` in `src/client/index.html` with the form ID from your Formspree
dashboard. After that, submissions can go through Formspree without showing
your email in the page HTML.

The provided `wrangler.jsonc` publishes `src/client` as the site's asset
directory. After the first deploy, attach your custom domain in Cloudflare.
