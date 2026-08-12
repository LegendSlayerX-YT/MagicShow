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
  var ORGANIZER_STORAGE_KEY = 'gaspmachine:google-organizer';
  var rootCfg = window.CONFIG || {};
  var clientId = rootCfg.googleSignInClientId || '';
  var hoursEndpoint = (rootCfg.api && rootCfg.api.hours) || '/api/hours';

  var state = { credential: null, email: null, name: null, picture: null, isOrganizer: false };

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

  // Organizers approve hours instead of submitting their own — same split
  // as the two pages themselves (hours.html vs. hours-approval.html), so
  // the dropdown always points at whichever one applies to this visitor.
  function hoursMenuLinkMarkup() {
    return state.isOrganizer ?
      '<a href="hours-approval.html">Volunteer Hour Approval</a>' :
      '<a href="hours.html">Volunteer Hour Submission</a>';
  }

  function renderSignedIn() {
    var avatarHtml = state.picture
      ? '<img class="nav__avatar" src="' + escapeHtml(state.picture) + '" alt="' + escapeHtml(state.name) + '" referrerpolicy="no-referrer">'
      : '<span class="nav__avatar nav__avatar--fallback">' + escapeHtml((state.name || '?').charAt(0).toUpperCase()) + '</span>';

    container.innerHTML =
      '<div class="nav__auth-signed-in">' +
        '<button type="button" class="nav__account-toggle" aria-haspopup="true" aria-expanded="false">' +
          avatarHtml +
        '</button>' +
        '<ul class="nav__account-menu">' +
          '<li id="nav-hours-link">' + hoursMenuLinkMarkup() + '</li>' +
          '<li><button type="button" class="nav__auth-signout">Sign out</button></li>' +
        '</ul>' +
      '</div>';

    var toggleBtn = container.querySelector('.nav__account-toggle');
    var menu = container.querySelector('.nav__account-menu');
    var avatarImg = toggleBtn.querySelector('img.nav__avatar');
    if (avatarImg) {
      avatarImg.addEventListener('error', function () {
        avatarImg.outerHTML = '<span class="nav__avatar nav__avatar--fallback">' +
          escapeHtml((state.name || '?').charAt(0).toUpperCase()) + '</span>';
      });
    }

    function closeMenu() {
      menu.classList.remove('open');
      toggleBtn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('click', onDocClick);
    }
    function onDocClick(e) {
      if (!container.contains(e.target)) closeMenu();
    }
    toggleBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var isOpen = menu.classList.toggle('open');
      toggleBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      if (isOpen) document.addEventListener('click', onDocClick);
      else document.removeEventListener('click', onDocClick);
    });

    container.querySelector('.nav__auth-signout').addEventListener('click', signOut);
  }

  // Whether this visitor is an organizer is only ever what the Worker
  // verifies server-side (same posture as isOrganizer on /api/calendar and
  // /api/hours) — cached per tab so every page doesn't need to ask again,
  // since it's only used to pick which dropdown link to show, not to gate
  // anything: both hours pages re-check with the server on their own.
  function updateHoursMenuLink() {
    var link = document.getElementById('nav-hours-link');
    if (link) link.innerHTML = hoursMenuLinkMarkup();
  }

  function loadOrganizerStatus() {
    var cached;
    try { cached = sessionStorage.getItem(ORGANIZER_STORAGE_KEY); } catch (err) { cached = null; }
    if (cached !== null) {
      state.isOrganizer = cached === '1';
      updateHoursMenuLink();
      return;
    }
    fetch(hoursEndpoint, { headers: { Authorization: 'Bearer ' + state.credential } })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (data) {
        state.isOrganizer = !!data.isOrganizer;
        try { sessionStorage.setItem(ORGANIZER_STORAGE_KEY, state.isOrganizer ? '1' : '0'); } catch (err) { /* private browsing */ }
        updateHoursMenuLink();
      })
      .catch(function () { /* leave the default (volunteer) link */ });
  }

  function setSignedIn(credential, claims) {
    state.credential = credential;
    state.email = claims.email;
    state.name = claims.name || claims.email;
    state.picture = claims.picture || null;
    try { sessionStorage.setItem(STORAGE_KEY, credential); } catch (err) { /* private browsing */ }
    renderSignedIn();
    loadOrganizerStatus();
    window.dispatchEvent(new CustomEvent('googleauth:signin', { detail: { email: state.email } }));
  }

  function signOut() {
    state.credential = null;
    state.email = null;
    state.name = null;
    state.picture = null;
    state.isOrganizer = false;
    try {
      sessionStorage.removeItem(STORAGE_KEY);
      sessionStorage.removeItem(ORGANIZER_STORAGE_KEY);
    } catch (err) { /* private browsing */ }
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
    getEmail: function () { return state.email; },
    getName: function () { return state.name; }
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
        state.picture = claims.picture || null;
        // Read synchronously so the very first render already picks the
        // right dropdown link instead of flashing the default then swapping.
        state.isOrganizer = sessionStorage.getItem(ORGANIZER_STORAGE_KEY) === '1';
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
    if (state.credential) {
      renderSignedIn();
      loadOrganizerStatus();
    } else {
      renderSignedOut();
    }
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
