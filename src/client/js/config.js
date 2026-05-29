/* ===========================================================
   SITE CONFIG  — edit this file to manage the Archives page
   -----------------------------------------------------------
   The YouTube API key and playlist ID now live server-side in
   .env (see server.js). The page fetches live data from our own
   /api/playlist endpoint, so no secrets are exposed in the browser.
   =========================================================== */
window.CONFIG = {
  // ---- Backend endpoint that returns the playlist ----
  // Served by server.js. Change only if you mount the API elsewhere.
  apiUrl: '/api/playlist',

  // ---- Optional per-video overrides ----
  // Key = YouTube video ID. Use this to show a custom title/caption instead of
  // the raw YouTube title/description (e.g. nice show names + where you performed).
  overrides: {
  },

  // ---- Fallback list ----
  // Shown when the backend is unreachable or returns no videos.
  // Keep this updated so the site always works even without the API.
  fallback: [
    { id: 'SY8CQuHmOJw', title: 'Polka Dot Handkerchief', caption: 'Volunteer Magic Show on Lunar New Year Celebration' },
  ]
};
