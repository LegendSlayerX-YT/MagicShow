/* ===========================================================
   SITE CONFIG  — edit this file to manage the Archives page
   -----------------------------------------------------------
   This is now a fully static site. The Archives page can fetch
   your public YouTube playlist directly from the browser using
   a restricted API key, or fall back to the local list below.
   =========================================================== */
window.CONFIG = {
  youtube: {
    // Restrict this key in Google Cloud to your production domain.
    apiKey: 'AIzaSyDKsMcoMziORDNAQ-5yCbG7BvG_BWMBxgk',
    playlistId: 'PLKcHew3eLgPd94aYmo-0KwZ8wSR3HJ_RC',
    maxResults: 50
  },

  // ---- Optional per-video overrides ----
  // Key = YouTube video ID. Use this to show a custom title/caption instead of
  // the raw YouTube title/description (e.g. nice show names + where you performed).
  overrides: {
  },

  // ---- Fallback list ----
  // Shown when the YouTube request is unavailable or returns no videos.
  // Keep this updated so the site always works even without live fetches.
  fallback: [
    { id: 'SY8CQuHmOJw', title: 'Polka Dot Handkerchief', caption: 'Volunteer Magic Show on Lunar New Year Celebration' },
  ]
};
