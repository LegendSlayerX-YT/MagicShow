/* ===========================================================
   Volunteer Hour Approval — organizers review the full pending
   queue of volunteer-submitted hours and verify/deny each one,
   plus look up any volunteer's history. Event leaders (picked on
   the Calendar page — see handleLeaders in the Worker) get the
   same verify/deny queue, but scoped to just the events they
   lead, and without the volunteer lookup. Volunteers submit their
   own hours on the separate Volunteer Hour Submission page
   (hours.html / hours.js) instead — mirrors the Register vs.
   pick-leaders split on the Calendar page.
   =========================================================== */
(function () {
  var panel = document.getElementById('hours-panel');
  if (!panel) return;

  var common = window.HoursCommon;
  var escapeHtml = common.escapeHtml;
  var formatDate = common.formatDate;

  var rootCfg = window.CONFIG || {};
  var hoursEndpoint = (rootCfg.api && rootCfg.api.hours) || '/api/hours';
  var decideEndpoint = (rootCfg.api && rootCfg.api.hoursDecide) || '/api/hours/decide';

  function status(message) {
    panel.innerHTML = '<p class="archive-status">' + message + '</p>';
  }

  /* ---------- pending queue + per-volunteer lookup ---------- */

  function organizerItemMarkup(item) {
    var meta = escapeHtml(formatDate(item.date)) + ' · ' + escapeHtml(item.hours) + ' hrs' +
      (item.event ? ' · ' + escapeHtml(item.event) : '');
    return '' +
      '<li class="hours-item hours-item--decide" data-id="' + escapeHtml(item.id) + '">' +
        '<div class="hours-item__body">' +
          '<p class="hours-item__who">' + escapeHtml(item.name || item.email) + '</p>' +
          '<p class="hours-item__meta">' + meta + '</p>' +
        '</div>' +
        '<div class="hours-item__actions">' +
          '<button type="button" class="btn btn--solid hours-item__verify">Verify</button>' +
          '<button type="button" class="btn hours-item__deny">Deny</button>' +
          '<p class="hours-item__status" role="status"></p>' +
        '</div>' +
      '</li>';
  }

  function personOptionsMarkup(volunteers) {
    var markup = '<option value="">— select a volunteer —</option>';
    volunteers.forEach(function (person) {
      markup += '<option value="' + escapeHtml(person.email) + '">' + escapeHtml(person.name) + '</option>';
    });
    return markup;
  }

  function personHoursMarkup(data) {
    var submissions = Array.isArray(data.submissions) ? data.submissions : [];
    var totalHours = typeof data.totalHours === 'number' ? data.totalHours : 0;
    var rows = submissions.length ?
      submissions.map(common.submissionMarkup).join('') :
      '<li class="hours-item hours-item--empty">No submissions yet.</li>';
    return '' +
      '<p class="hours-summary__total">Total verified hours: <strong>' + escapeHtml(totalHours) + '</strong></p>' +
      '<ul class="hours-list">' + rows + '</ul>';
  }

  function loadPersonHours(email, resultEl) {
    var auth = window.GoogleAuth;
    resultEl.innerHTML = '<p class="archive-status">Loading…</p>';
    fetch(hoursEndpoint + '?person=' + encodeURIComponent(email), {
      headers: { Authorization: 'Bearer ' + auth.getCredential() }
    })
      .then(function (response) {
        return response.json()
          .catch(function () { return {}; })
          .then(function (data) { return { ok: response.ok, data: data }; });
      })
      .then(function (result) {
        if (!result.ok) {
          resultEl.innerHTML = '<p class="archive-status">' + escapeHtml(result.data.error || 'Could not load volunteer hours.') + '</p>';
          return;
        }
        resultEl.innerHTML = personHoursMarkup(result.data);
      })
      .catch(function (error) {
        console.warn('Volunteer lookup failed:', error);
        resultEl.innerHTML = '<p class="archive-status">Could not reach the server. Please try again.</p>';
      });
  }

  // The volunteer lookup (browsing anyone's full history) stays
  // organizer-only — a leader only gets the pending queue for events they
  // lead, never a picker over every volunteer.
  function renderQueue(pending, volunteers, showLookup) {
    var items = pending.length ?
      pending.map(organizerItemMarkup).join('') :
      '<li class="hours-item hours-item--empty">No pending submissions.</li>';
    var lookupMarkup = !showLookup ? '' : '' +
      '<div class="hours-lookup">' +
        '<label class="contact__field"><span>View a volunteer’s hours</span>' +
          '<select class="contact__input" id="hours-person-select">' + personOptionsMarkup(volunteers) + '</select>' +
        '</label>' +
        '<div id="hours-person-result"></div>' +
      '</div>';
    panel.innerHTML = '' +
      '<ul class="hours-list hours-list--organizer">' + items + '</ul>' +
      lookupMarkup;

    if (!showLookup) return;
    document.getElementById('hours-person-select').addEventListener('change', function (evt) {
      var resultEl = document.getElementById('hours-person-result');
      if (!evt.target.value) {
        resultEl.innerHTML = '';
        return;
      }
      loadPersonHours(evt.target.value, resultEl);
    });
  }

  panel.addEventListener('click', function (evt) {
    var verify = evt.target.closest('.hours-item__verify');
    var deny = evt.target.closest('.hours-item__deny');
    if (!verify && !deny) return;
    decideHours(evt.target.closest('.hours-item'), verify ? 'verify' : 'deny');
  });

  function decideHours(item, decision) {
    var auth = window.GoogleAuth;
    var statusEl = item.querySelector('.hours-item__status');
    var buttons = item.querySelectorAll('button');
    buttons.forEach(function (b) { b.disabled = true; b.style.display = 'none'; });
    statusEl.textContent = decision === 'verify' ? 'Verifying…' : 'Denying…';

    fetch(decideEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: item.dataset.id, decision: decision, credential: auth.getCredential() })
    })
      .then(function (response) {
        return response.json()
          .catch(function () { return {}; })
          .then(function (data) { return { ok: response.ok, data: data }; });
      })
      .then(function (result) {
        if (!result.ok) {
          buttons.forEach(function (b) { b.disabled = false; b.style.display = ''; });
          statusEl.textContent = result.data.error || 'Something went wrong. Please try again.';
          return;
        }
        item.remove();
        var list = panel.querySelector('.hours-list--organizer');
        if (list && !list.children.length) {
          list.innerHTML = '<li class="hours-item hours-item--empty">No pending submissions.</li>';
        }
      })
      .catch(function (error) {
        console.warn('Deciding submission failed:', error);
        buttons.forEach(function (b) { b.disabled = false; b.style.display = ''; });
        statusEl.textContent = 'Could not reach the server. Please try again.';
      });
  }

  /* ---------- boot ---------- */

  function loadPanel() {
    var auth = window.GoogleAuth;
    if (!auth || !auth.isSignedIn()) {
      status('Sign in with Google (top right) to review volunteer hours.');
      return;
    }

    status('Loading…');

    fetch(hoursEndpoint, { headers: { Authorization: 'Bearer ' + auth.getCredential() } })
      .then(function (response) {
        return response.json()
          .catch(function () { return {}; })
          .then(function (data) { return { ok: response.ok, data: data }; });
      })
      .then(function (result) {
        if (!result.ok) {
          status(escapeHtml(result.data.error || 'Could not load volunteer hours.'));
          return;
        }
        if (!result.data.isOrganizer && !result.data.isLeader) {
          status('This page is for organizers and event leaders. Head to <a href="hours.html">Volunteer Hour Submission</a> to log your own hours.');
          return;
        }
        renderQueue(result.data.pending || [], result.data.volunteers || [], !!result.data.isOrganizer);
      })
      .catch(function (error) {
        console.warn('Volunteer hours fetch failed:', error);
        status('Could not reach the server. Please try again.');
      });
  }

  window.addEventListener('googleauth:signin', loadPanel);
  window.addEventListener('googleauth:signout', loadPanel);

  loadPanel();
})();
