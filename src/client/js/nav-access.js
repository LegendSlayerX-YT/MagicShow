/* ===========================================================
   Calendar nav dropdown — turns the plain "Calendar" nav link
   into a dropdown (Find Events to Participate / Manage Events in
   My Area) for whoever can actually manage something: a top-level
   manager, an Area Head, or anyone that Head reports up to (see
   canUseArea/isTopManager in the Worker's org-chart.js). Everyone
   else keeps today's plain link — /api/areas is the source of
   truth either way, never anything guessed client-side.
   =========================================================== */
(function () {
  var trigger = document.querySelector('.nav__links a[href="calendar.html"]');
  var item = trigger ? trigger.closest('li') : null;
  if (!item) return;

  var plainItemHtml = item.innerHTML;
  var plainItemClass = item.className;

  var rootCfg = window.CONFIG || {};
  var areasEndpoint = (rootCfg.api && rootCfg.api.areas) || '/api/areas';

  function showDropdown() {
    var activeClass = trigger.className || '';
    item.className = 'nav__dropdown';
    item.innerHTML =
      '<a href="calendar.html" class="' + activeClass + '">Calendar</a>' +
      '<ul class="nav__menu">' +
        '<li><a href="calendar.html">Find Events to Participate</a></li>' +
        '<li><a href="calendar-manager.html">Manage Events in My Area</a></li>' +
      '</ul>';
  }

  function showPlainLink() {
    item.className = plainItemClass;
    item.innerHTML = plainItemHtml;
  }

  function checkAccess() {
    var auth = window.GoogleAuth;
    if (!auth || !auth.isSignedIn()) return;
    fetch(areasEndpoint, { headers: { Authorization: 'Bearer ' + auth.getCredential() } })
      .then(function (response) { return response.ok ? response.json() : {}; })
      .then(function (data) {
        var areas = Array.isArray(data.areas) ? data.areas : [];
        if (data.isOrganizer || areas.length) showDropdown();
      })
      .catch(function () { /* leave the plain link in place */ });
  }

  checkAccess();
  window.addEventListener('googleauth:signin', checkAccess);
  window.addEventListener('googleauth:signout', showPlainLink);
})();
