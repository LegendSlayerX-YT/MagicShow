# Gasp Machine — Magic Club Website

A small website for the Gasp Machine magic club: a static frontend plus a tiny
Node/Express backend that fetches the YouTube playlist so the API key never
reaches the browser.

- **Home** (`index.html`) — welcome page with an animated "magic" background (drifting card suits + sparkles) and contact info.
- **About Us** (`about.html`) — club member cards (currently Henry Chen).
- **Archives** (`archives.html`) — previous shows, pulled **live** from your YouTube playlist via the backend.

---

## Project structure

```
MagicShow/
├── package.json            # Backend deps (express, dotenv) + start scripts
├── .env                    # ← SECRETS: API key, playlist ID (gitignored)
├── .env.example            # Template for .env
└── src/
    ├── server/
    │   └── server.js       # Express backend: serves the site + /api/playlist
    └── client/             # The static website
        ├── index.html      # Home
        ├── about.html      # About Us
        ├── archives.html   # Archives (videos)
        ├── css/styles.css  # All styles
        └── js/
            ├── main.js     # Nav toggle + footer year
            ├── magic-bg.js # Home animated background
            ├── config.js   # ← EDIT THIS: video captions + fallback list
            └── archives.js # Calls /api/playlist + renders the shows
```

## Running locally

```bash
cd MagicShow
npm install
cp .env.example .env     # then put your real key in .env
npm start                # → http://localhost:3000
```

Use `npm run dev` to auto-restart on changes. The Archives page calls the
backend's `/api/playlist`, so you must run through `npm start` (not a bare
static server) to get live data.

---

## Managing the Archives videos

The API key and playlist ID live in **`.env`** (server-side). Presentation —
custom titles and the offline fallback list — lives in **`src/client/js/config.js`**.

### Showing videos live (recommended)
The backend fetches your playlist through the **YouTube Data API v3** so new
videos appear automatically. Set these in `.env`:

```bash
YOUTUBE_API_KEY=your-key-here
PLAYLIST_ID=PLKcHew3eLgPd94aYmo-0KwZ8wSR3HJ_RC
```

**Getting a YouTube API key**
1. Go to <https://console.cloud.google.com/> and create (or pick) a project.
2. **APIs & Services → Library →** search **"YouTube Data API v3" → Enable**.
3. **APIs & Services → Credentials → Create credentials → API key.**
4. Click the key → **API restrictions → Restrict key → YouTube Data API v3**.
5. **Application restrictions:** since the key is now used from the *server*
   (not the browser), choose **None** for local dev, or **IP addresses** and add
   your server's public IP in production. Do **not** use the *Websites/HTTP
   referrers* restriction — that only works for browser calls and will return
   `403 ... referer blocked` from the backend.
6. Put the key in `.env`.

> The key now stays on the server and is never sent to the browser, so it can't
> be scraped from the page source.

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
If `YOUTUBE_API_KEY` is unset (or the request fails), `/api/playlist` returns an
error and the page renders the `fallback` list in `config.js`. Keep that list
current and the site always shows your shows.

---

## Editing content

- **Contact email** — `src/client/index.html`, in the `.contact` section.
- **Club members** — `src/client/about.html`. Copy a `<article class="member">` block to add
  someone. Swap the letter avatar for a photo with
  `<img class="member__avatar" src="path/to/photo.jpg" alt="Name">`.
- **Colors / fonts** — the `:root` variables at the top of `src/client/css/styles.css`.

---

## Deploying

This is now a Node app (it needs a running process for `/api/playlist`), so a
static-only host like GitHub Pages won't run the backend. Use a Node host:

- **Render / Railway / Fly.io** — point at this repo, build `npm install`,
  start `npm start`. Set `YOUTUBE_API_KEY` and `PLAYLIST_ID` as environment
  variables in the host's dashboard (don't commit `.env`).
- Set the key's **Application restriction** to your server's IP (or None) — the
  *Websites/HTTP referrers* restriction does not work for server-side calls.
