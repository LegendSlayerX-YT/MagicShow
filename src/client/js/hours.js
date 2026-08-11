/* ===========================================================
   Volunteer Hours — signed-in visitors log hours through the
   site's own /api/hours relay; organizers see a pending queue
   with Verify/Deny instead (mirrors the Register vs.
   pick-leaders split on the Calendar page — see calendar.js).
   Every response here comes from a verified Google sign-in, so
   there's no anonymous state beyond "please sign in".
   =========================================================== */
(function () {
  var panel = document.getElementById('hours-panel');
  if (!panel) return;

  var rootCfg = window.CONFIG || {};
  var calendarEndpoint = (rootCfg.api && rootCfg.api.calendar) || '/api/calendar';
  var hoursEndpoint = (rootCfg.api && rootCfg.api.hours) || '/api/hours';
  var decideEndpoint = (rootCfg.api && rootCfg.api.hoursDecide) || '/api/hours/decide';

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function status(message) {
    panel.innerHTML = '<p class="archive-status">' + message + '</p>';
  }

  function todayIso() {
    var d = new Date();
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  // `date` on a submission is the plain "YYYY-MM-DD" the volunteer typed —
  // parsed as local time (not UTC) so it always displays as the same day.
  function formatDate(iso) {
    var parts = String(iso || '').split('-');
    if (parts.length !== 3) return iso || '';
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    if (isNaN(d.getTime())) return iso;
    return new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).format(d);
  }

  function statusLabel(s) {
    if (s === 'verified') return 'Verified';
    if (s === 'denied') return 'Denied';
    return 'Pending';
  }

  function statusBadge(s) {
    return '<span class="hours-status hours-status--' + escapeHtml(s) + '">' + statusLabel(s) + '</span>';
  }

  /* ---------- event dropdown (real calendar events, id + display name) ---------- */

  function addDays(date, days) {
    var next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
  }

  function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  function eventStartMs(event) {
    var start = event.start || {};
    if (start.dateTime) return Date.parse(start.dateTime);
    if (start.date) return Date.parse(start.date + 'T00:00:00');
    return NaN;
  }

  function eventOptionLabel(event) {
    var ms = eventStartMs(event);
    var when = isNaN(ms) ? '' :
      new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(ms));
    var summary = event.summary || 'Untitled event';
    return when ? when + ' — ' + summary : summary;
  }

  // Same two-window split as calendar.js (today+7 days ahead, 90 days back)
  // — the Worker caps any single request's range at 92 days.
  var PAST_DAYS = 90;

  function loadEventOptions(callback) {
    var today = new Date();
    var futureStart = startOfDay(today);
    var futureEndExclusive = startOfDay(addDays(today, 8));
    var pastStart = startOfDay(addDays(today, -PAST_DAYS));
    var pastEndExclusive = futureStart;

    function fetchRange(start, endExclusive) {
      var params = new URLSearchParams({ timeMin: start.toISOString(), timeMax: endExclusive.toISOString() });
      return fetch(calendarEndpoint + '?' + params.toString())
        .then(function (r) { return r.ok ? r.json() : { events: [] }; })
        .then(function (data) { return data.events || []; })
        .catch(function () { return []; });
    }

    Promise.all([fetchRange(futureStart, futureEndExclusive), fetchRange(pastStart, pastEndExclusive)])
      .then(function (results) {
        var events = results[0].concat(results[1]);
        events.sort(function (a, b) { return eventStartMs(b) - eventStartMs(a); });
        callback(events);
      });
  }

  function eventOptionsMarkup(events) {
    var markup = '<option value="">— none —</option>';
    events.forEach(function (event) {
      if (!event.id) return;
      markup += '<option value="' + escapeHtml(event.id) + '">' + escapeHtml(eventOptionLabel(event)) + '</option>';
    });
    return markup;
  }

  /* ---------- volunteer view: log form + own submissions ---------- */

  function submissionMarkup(item) {
    return '' +
      '<li class="hours-item">' +
        '<span class="hours-item__date">' + escapeHtml(formatDate(item.date)) + '</span>' +
        '<span class="hours-item__hours">' + escapeHtml(item.hours) + ' hrs</span>' +
        '<span class="hours-item__event">' + escapeHtml(item.event || '—') + '</span>' +
        statusBadge(item.status) +
      '</li>';
  }

  // Range filtering compares "YYYY-MM-DD" strings directly (lexicographic
  // order matches date order for this format), so no Date parsing is needed.
  function filterByDateRange(submissions, start, end) {
    return submissions.filter(function (item) {
      if (start && item.date < start) return false;
      if (end && item.date > end) return false;
      return true;
    });
  }

  function sumVerifiedHours(submissions) {
    var sum = submissions.reduce(function (total, item) {
      return item.status === 'verified' ? total + (Number(item.hours) || 0) : total;
    }, 0);
    return Math.round(sum * 100) / 100;
  }

  function renderSubmissionsView(allSubmissions, start, end) {
    var filtered = filterByDateRange(allSubmissions, start, end);
    var emptyMessage = allSubmissions.length ? 'No submissions in range.' : 'No submissions yet.';
    var rows = filtered.length ?
      filtered.map(submissionMarkup).join('') :
      '<li class="hours-item hours-item--empty">' + escapeHtml(emptyMessage) + '</li>';
    document.getElementById('hours-list').innerHTML = rows;

    var rangeEl = document.getElementById('hours-range-total');
    if (start || end) {
      rangeEl.hidden = false;
      rangeEl.innerHTML = 'Verified hours in range: <strong>' + escapeHtml(sumVerifiedHours(filtered)) + '</strong>';
    } else {
      rangeEl.hidden = true;
      rangeEl.innerHTML = '';
    }
  }

  function volunteerMarkup(totalHours, events) {
    return '' +
      '<form class="hours-form contact__form" id="hours-form">' +
        '<label class="contact__field"><span>Hours</span>' +
          '<input class="contact__input" type="number" name="hours" min="0.25" max="24" step="0.25" required></label>' +
        '<label class="contact__field"><span>Date</span>' +
          '<input class="contact__input" type="date" name="date" max="' + todayIso() + '" required></label>' +
        '<label class="contact__field"><span>Event (optional)</span>' +
          '<select class="contact__input" name="eventId">' + eventOptionsMarkup(events) + '</select></label>' +
        '<div class="contact__actions">' +
          '<button type="submit" class="btn btn--solid">Submit</button>' +
          '<p class="contact__status contact__status--inline" id="hours-form-status" role="status"></p>' +
        '</div>' +
      '</form>' +
      '<div class="hours-summary">' +
        '<p class="hours-summary__total">Total verified hours: <strong>' + escapeHtml(totalHours) + '</strong></p>' +
        '<p class="hours-summary__range" id="hours-range-total" hidden></p>' +
        '<div class="hours-filter">' +
          '<label class="hours-filter__field"><span>From</span>' +
            '<input class="contact__input" type="date" id="hours-filter-start"></label>' +
          '<label class="hours-filter__field"><span>To</span>' +
            '<input class="contact__input" type="date" id="hours-filter-end"></label>' +
          '<button type="button" class="btn hours-filter__clear" id="hours-filter-clear">Clear</button>' +
        '</div>' +
        '<ul class="hours-list" id="hours-list"></ul>' +
      '</div>';
  }

  function renderVolunteer(data, events) {
    var submissions = Array.isArray(data.submissions) ? data.submissions : [];
    var totalHours = typeof data.totalHours === 'number' ? data.totalHours : 0;
    panel.innerHTML = volunteerMarkup(totalHours, events);

    document.getElementById('hours-form').addEventListener('submit', function (evt) {
      evt.preventDefault();
      submitHours(evt.target);
    });

    var startInput = document.getElementById('hours-filter-start');
    var endInput = document.getElementById('hours-filter-end');
    var clearBtn = document.getElementById('hours-filter-clear');

    function refresh() {
      renderSubmissionsView(submissions, startInput.value, endInput.value);
    }

    startInput.addEventListener('change', refresh);
    endInput.addEventListener('change', refresh);
    clearBtn.addEventListener('click', function () {
      startInput.value = '';
      endInput.value = '';
      refresh();
    });

    refresh();
  }

  function submitHours(form) {
    var auth = window.GoogleAuth;
    var statusEl = document.getElementById('hours-form-status');
    var button = form.querySelector('button[type="submit"]');
    if (!auth || !auth.isSignedIn()) {
      statusEl.textContent = 'Sign in with Google (top right) to submit.';
      statusEl.setAttribute('data-state', 'error');
      return;
    }

    button.disabled = true;
    statusEl.textContent = 'Submitting…';
    statusEl.removeAttribute('data-state');

    fetch(hoursEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hours: form.hours.value,
        date: form.date.value,
        eventId: form.eventId.value,
        credential: auth.getCredential()
      })
    })
      .then(function (response) {
        return response.json()
          .catch(function () { return {}; })
          .then(function (data) { return { ok: response.ok, data: data }; });
      })
      .then(function (result) {
        button.disabled = false;
        if (!result.ok) {
          statusEl.textContent = result.data.error || 'Something went wrong. Please try again.';
          statusEl.setAttribute('data-state', 'error');
          return;
        }
        statusEl.textContent = 'Submitted — waiting on verification.';
        statusEl.setAttribute('data-state', 'success');
        loadPanel();
      })
      .catch(function (error) {
        console.warn('Submitting hours failed:', error);
        button.disabled = false;
        statusEl.textContent = 'Could not reach the server. Please try again.';
        statusEl.setAttribute('data-state', 'error');
      });
  }

  /* ---------- organizer view: pending queue ---------- */

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

  function renderOrganizer(pending) {
    var items = pending.length ?
      pending.map(organizerItemMarkup).join('') :
      '<li class="hours-item hours-item--empty">No pending submissions.</li>';
    panel.innerHTML = '<ul class="hours-list hours-list--organizer">' + items + '</ul>';
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
    buttons.forEach(function (b) { b.disabled = true; });
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
          buttons.forEach(function (b) { b.disabled = false; });
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
        buttons.forEach(function (b) { b.disabled = false; });
        statusEl.textContent = 'Could not reach the server. Please try again.';
      });
  }

  /* ---------- boot ---------- */

  function loadPanel() {
    var auth = window.GoogleAuth;
    if (!auth || !auth.isSignedIn()) {
      status('Sign in with Google (top right) to log volunteer hours.');
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
        if (result.data.isOrganizer) {
          renderOrganizer(result.data.pending || []);
        } else {
          loadEventOptions(function (events) { renderVolunteer(result.data, events); });
        }
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
