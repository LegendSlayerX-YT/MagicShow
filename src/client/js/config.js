/* ===========================================================
   SITE CONFIG  — edit this file to manage the Archives page
   -----------------------------------------------------------
   No API keys live here. The Calendar and Archives pages call
   the site's own /api/* endpoints, and the Worker
   (src/worker/index.js) adds the Google keys server-side.

   Calendar ID, time zone, playlist ID, and result count are
   configured in wrangler.jsonc under "vars".
   =========================================================== */
window.CONFIG = {
  api: {
    calendar: '/api/calendar',
    archives: '/api/archives',
    register: '/api/register'
  },

  // OAuth 2.0 Client ID for "Sign in with Google". Client IDs aren't secret
  // (this is meant to be public — it ends up in the page source either way),
  // but it must match the GOOGLE_SIGNIN_CLIENT_ID var in wrangler.jsonc, or
  // the Worker will reject every sign-in as a token meant for someone else.
  // See README "Sign in with Google" for how to create/configure it.
  googleSignInClientId: '600675471306-546l8m5jl8jlf6dqmmuje7gu6bs8a0ie.apps.googleusercontent.com',

  // ---- Optional per-video overrides ----
  // Key = YouTube video ID. Use this to show a custom title/caption instead of
  // the raw YouTube title/description (e.g. nice show names + where you performed).
  overrides: {
  },

  // ---- Fallback list ----
  // Shown when the Archives request is unavailable or returns no videos.
  // Keep this updated so the site always works even without live fetches.
  fallback: [
    { id: 'SY8CQuHmOJw', title: 'Polka Dot Handkerchief', caption: 'Volunteer Magic Show on Lunar New Year Celebration' },
  ]
};
