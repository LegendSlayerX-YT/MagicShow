/* ===========================================================
   Sign in with Google — top-right nav control. calendar.js reads
   window.GoogleAuth to register visitors with their verified
   Google email instead of a typed-in one. The ID token itself is
   only trusted after the Worker verifies it server-side.
   =========================================================== */
(function () {
  var container = document.getElementById('google-signin');
  if (!container) return;

  var STORAGE_KEY = 'gaspmachine:google-credential';
  var rootCfg = window.CONFIG || {};
  var clientId = rootCfg.googleSignInClientId || '';

  var state = { credential: null, email: null, name: null };

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function decodeJwt(token) {
    try {
      var payload = token.split('.')[1];
      var json = decodeURIComponent(
        atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
          .split('')
          .map(function (c) { return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2); })
          .join('')
      );
      return JSON.parse(json);
    } catch (err) {
      return null;
    }
  }

  function isExpired(claims) {
    return !claims || !claims.exp || claims.exp * 1000 <= Date.now();
  }

  // Google's own rendered button can't be recolored to match the site —
  // theme/shape/size are the whole customization surface. Pill + dark gets
  // it as close to the site's rounded crimson buttons as their API allows.
  function renderSignedOut() {
    container.innerHTML = '<div id="google-signin-button"></div>';
    window.google.accounts.id.renderButton(
      document.getElementById('google-signin-button'),
      { theme: 'filled_black', size: 'medium', shape: 'pill', text: 'signin', logo_alignment: 'left' }
    );
  }

  function renderSignedIn() {
    container.innerHTML =
      '<div class="nav__auth-signed-in">' +
        '<span class="nav__auth-email">' + escapeHtml(state.name) + '</span>' +
        '<button type="button" class="nav__auth-signout">Sign out</button>' +
      '</div>';
    container.querySelector('.nav__auth-signout').addEventListener('click', signOut);
  }

  function setSignedIn(credential, claims) {
    state.credential = credential;
    state.email = claims.email;
    state.name = claims.name || claims.email;
    try { sessionStorage.setItem(STORAGE_KEY, credential); } catch (err) { /* private browsing */ }
    renderSignedIn();
    window.dispatchEvent(new CustomEvent('googleauth:signin', { detail: { email: state.email } }));
  }

  function signOut() {
    state.credential = null;
    state.email = null;
    state.name = null;
    try { sessionStorage.removeItem(STORAGE_KEY); } catch (err) { /* private browsing */ }
    if (window.google && window.google.accounts && window.google.accounts.id) {
      window.google.accounts.id.disableAutoSelect();
    }
    renderSignedOut();
    window.dispatchEvent(new CustomEvent('googleauth:signout'));
  }

  function handleCredentialResponse(response) {
    var claims = decodeJwt(response.credential);
    if (!claims || isExpired(claims)) return;
    setSignedIn(response.credential, claims);
  }

  window.GoogleAuth = {
    isSignedIn: function () { return !!state.credential; },
    getCredential: function () { return state.credential; },
    getEmail: function () { return state.email; }
  };

  if (!clientId) {
    // Not configured yet — leave the corner empty rather than show a button
    // that can only fail. See README "Sign in with Google".
    container.innerHTML = '';
    return;
  }

  // Resume a still-valid session from earlier in this tab.
  try {
    var stored = sessionStorage.getItem(STORAGE_KEY);
    if (stored) {
      var claims = decodeJwt(stored);
      if (claims && !isExpired(claims)) {
        state.credential = stored;
        state.email = claims.email;
        state.name = claims.name || claims.email;
      } else {
        sessionStorage.removeItem(STORAGE_KEY);
      }
    }
  } catch (err) { /* private browsing */ }

  function init() {
    window.google.accounts.id.initialize({
      client_id: clientId,
      callback: handleCredentialResponse,
      auto_select: false
    });
    if (state.credential) renderSignedIn();
    else renderSignedOut();
  }

  if (window.google && window.google.accounts && window.google.accounts.id) {
    init();
  } else {
    // The GIS script (loaded in <head>) is async — poll briefly for it
    // rather than depend on load-order between the two <script> tags.
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      if (window.google && window.google.accounts && window.google.accounts.id) {
        clearInterval(timer);
        init();
      } else if (tries > 50) {
        clearInterval(timer); // ~5s — give up quietly, corner stays empty
      }
    }, 100);
  }
})();
