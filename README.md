# Gasp Machine — Magic Club Website

A fully static website for the Gasp Machine magic club. It can be hosted on
Cloudflare and uses plain HTML, CSS, and frontend JavaScript.

- **Home** (`index.html`) — welcome page with an animated "magic" background (drifting card suits + sparkles) and contact info.
- **About Us** (`about.html`) — club member cards (currently Henry Chen).
- **Archives** (`archives.html`) — previous shows, pulled **live** from your public YouTube playlist in the browser, with a local fallback list.

---

## Project structure

```
MagicShow/
├── wrangler.jsonc          # Cloudflare Workers static assets config
└── src/
    └── client/             # The static website
        ├── index.html      # Home
        ├── about.html      # About Us
        ├── archives.html   # Archives (videos)
        ├── css/styles.css  # All styles
        └── js/
            ├── main.js     # Nav toggle + footer year
            ├── magic-bg.js # Home animated background
            ├── config.js   # ← EDIT THIS: YouTube key, playlist ID, overrides, fallback
            └── archives.js # Calls YouTube Data API + renders the shows
```

## Running locally

```bash
cd MagicShow
python3 -m http.server 8000 --directory src/client
```

Then open `http://localhost:8000`.

---

## Managing the Archives videos

Live playlist settings, custom titles, and the fallback list all live in
**`src/client/js/config.js`**.

### Showing videos live
The Archives page fetches your playlist through the **YouTube Data API v3** so
new videos appear automatically. Set these in `src/client/js/config.js`:

```js
youtube: {
  apiKey: 'your-key-here',
  playlistId: 'PLKcHew3eLgPd94aYmo-0KwZ8wSR3HJ_RC',
  maxResults: 50
}
```

Restrict the key in Google Cloud to your domain, for example
`https://magician.chen-henry.org/*`, and restrict it to **YouTube Data API v3**
only.

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
If `youtube.apiKey` is blank or the request fails, the page renders the
`fallback` list in `config.js`. Keep that list current and the site always
shows your shows.

---

## Editing content

- **Contact email** — `src/client/index.html`, in the `.contact` section.
- **Club members** — `src/client/about.html`. Copy a `<article class="member">` block to add
  someone. Swap the letter avatar for a photo with
  `<img class="member__avatar" src="path/to/photo.jpg" alt="Name">`.
- **Colors / fonts** — the `:root` variables at the top of `src/client/css/styles.css`.

---

## Deploying

This project is ready for static hosting on Cloudflare Workers static assets.

1. Install Wrangler if needed: `npm install -g wrangler`
2. Log in: `wrangler login`
3. Deploy from the repo root: `wrangler deploy`

The provided `wrangler.jsonc` publishes `src/client` as the site's asset
directory. After the first deploy, attach your custom domain in Cloudflare.
