/* ===========================================================
   Gasp Machine — tiny backend
   -----------------------------------------------------------
   Serves the static site AND a /api/playlist endpoint that
   fetches the YouTube playlist server-side, so the API key
   never reaches the browser. Reads config from .env:

     YOUTUBE_API_KEY   (required for live data)
     PLAYLIST_ID       (the playlist to fetch)
     PORT              (optional, defaults to 3000)
     CACHE_TTL_MS      (optional, defaults to 10 minutes)
   =========================================================== */
require('dotenv').config();

const path = require('path');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 5002;
const API_KEY = process.env.YOUTUBE_API_KEY;
const PLAYLIST_ID = process.env.PLAYLIST_ID || 'PLKcHew3eLgPd94aYmo-0KwZ8wSR3HJ_RC';
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS) || 10 * 60 * 1000;

// ---- Simple in-memory cache so we don't burn YouTube quota ----
let cache = { at: 0, videos: null };

async function fetchPlaylist() {
  if (!API_KEY) {
    const err = new Error('YOUTUBE_API_KEY is not set');
    err.code = 'NO_KEY';
    throw err;
  }

  const url =
    'https://www.googleapis.com/youtube/v3/playlistItems' +
    '?part=snippet,contentDetails&maxResults=50' +
    '&playlistId=' + encodeURIComponent(PLAYLIST_ID) +
    '&key=' + encodeURIComponent(API_KEY);

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error('YouTube API responded ' + res.status + ': ' + body);
    err.code = 'UPSTREAM';
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const items = data.items || [];

  // Normalize to just what the frontend needs, and drop dead entries.
  return items
    .filter(function (it) {
      const t = it.snippet && it.snippet.title;
      return t && t !== 'Private video' && t !== 'Deleted video';
    })
    .map(function (it) {
      const sn = it.snippet;
      const cd = it.contentDetails || {};
      return {
        id: sn.resourceId.videoId,
        title: sn.title,
        caption: (sn.description || '').split('\n')[0], // first line as caption
        publishedAt: cd.videoPublishedAt || sn.publishedAt, // when the video was created
      };
    })
    // Most recent video first, so the top 3 are the latest shows.
    .sort(function (a, b) {
      return new Date(b.publishedAt) - new Date(a.publishedAt);
    });
}

// ---- API: playlist data (cached) ----
app.get('/api/playlist', async function (req, res) {
  const fresh = cache.videos && Date.now() - cache.at < CACHE_TTL_MS;
  if (fresh) {
    return res.json({ videos: cache.videos, cached: true });
  }

  try {
    const videos = await fetchPlaylist();
    cache = { at: Date.now(), videos: videos };
    res.json({ videos: videos, cached: false });
  } catch (err) {
    console.warn('Playlist fetch failed:', err.message);
    // Serve a stale cache if we have one — better than nothing.
    if (cache.videos) {
      return res.json({ videos: cache.videos, cached: true, stale: true });
    }
    const status = err.code === 'NO_KEY' ? 503 : 502;
    res.status(status).json({ error: err.message });
  }
});

// ---- Static site ----
const CLIENT_DIR = path.join(__dirname, '..', 'client');
app.use(express.static(CLIENT_DIR, { extensions: ['html'], index: 'index.html' }));

app.listen(PORT, function () {
  console.log('Gasp Machine running at http://localhost:' + PORT);
  if (!API_KEY) {
    console.warn('⚠  YOUTUBE_API_KEY is not set — Archives will use the fallback list.');
  }
});
