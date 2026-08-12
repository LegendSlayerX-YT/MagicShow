/* ===========================================================
   Volunteer Hour Submission — signed-in visitors log hours
   through the site's own /api/hours relay. Organizers review
   submissions on the separate Volunteer Hour Approval page
   (hours-approval.html / hours-approval.js) instead — mirrors
   the Register vs. pick-leaders split on the Calendar page.
   Every response here comes from a verified Google sign-in, so
   there's no anonymous state beyond "please sign in".
   =========================================================== */
(function () {
  var panel = document.getElementById('hours-panel');
  if (!panel) return;

  var common = window.HoursCommon;
  var escapeHtml = common.escapeHtml;

  var rootCfg = window.CONFIG || {};
  var calendarEndpoint = (rootCfg.api && rootCfg.api.calendar) || '/api/calendar';
  var hoursEndpoint = (rootCfg.api && rootCfg.api.hours) || '/api/hours';

  function status(message) {
    panel.innerHTML = '<p class="archive-status">' + message + '</p>';
  }

  function todayIso() {
    var d = new Date();
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
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

  // Only events that have already happened — no one claims volunteer hours
  // for an event that hasn't occurred yet. Includes today, since an event
  // earlier today may already be over. 90-day lookback mirrors calendar.js
  // and stays under the Worker's 92-day range cap.
  var PAST_DAYS = 90;

  // credential is required here (unlike calendar.js's anonymous-friendly
  // fetch) — without it the Worker never sets `registered`, and every event
  // would fail the attendee filter below.
  function loadEventOptions(credential, callback) {
    var today = new Date();
    var start = startOfDay(addDays(today, -PAST_DAYS));
    var endExclusive = startOfDay(addDays(today, 1));
    var params = new URLSearchParams({ timeMin: start.toISOString(), timeMax: endExclusive.toISOString() });

    fetch(calendarEndpoint + '?' + params.toString(), { headers: { Authorization: 'Bearer ' + credential } })
      .then(function (r) { return r.ok ? r.json() : { events: [] }; })
      .then(function (data) { return data.events || []; })
      .catch(function () { return []; })
      .then(function (events) {
        // Only events the signed-in volunteer actually attended — logging
        // hours for someone else's event isn't meaningful, and `registered`
        // (set by the Worker from the Calendar guest list) is exactly that
        // check already made server-side.
        events = events.filter(function (event) { return event.registered; });
        events.sort(function (a, b) { return eventStartMs(b) - eventStartMs(a); });
        callback(events);
      });
  }

  // "YYYY-MM-DD" for the date <input>, from the event's start — local
  // calendar date, matching how the date field itself is interpreted.
  function eventDateIso(event) {
    var start = event.start || {};
    if (start.date) return start.date;
    var ms = eventStartMs(event);
    if (isNaN(ms)) return '';
    var d = new Date(ms);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  // Hours between a timed event's start/end, rounded to the nearest quarter
  // hour (matches the hours input's step). Null for all-day events, where
  // there's no meaningful duration to infer.
  function eventDurationHours(event) {
    var start = event.start || {};
    var end = event.end || {};
    if (!start.dateTime || !end.dateTime) return null;
    var startMs = Date.parse(start.dateTime);
    var endMs = Date.parse(end.dateTime);
    if (isNaN(startMs) || isNaN(endMs) || endMs <= startMs) return null;
    return Math.round((endMs - startMs) / 3600000 * 4) / 4;
  }

  function eventOptionsMarkup(events) {
    var markup = '<option value="">— enter it myself —</option>';
    events.forEach(function (event) {
      if (!event.id) return;
      markup += '<option value="' + escapeHtml(event.id) + '">' + escapeHtml(eventOptionLabel(event)) + '</option>';
    });
    return markup;
  }

  /* ---------- log form + own submissions ---------- */

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
      filtered.map(common.submissionMarkup).join('') :
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
        '<label class="contact__field" id="hours-event-title-field"><span>Event title</span>' +
          '<input class="contact__input" type="text" name="eventTitle" maxlength="200" placeholder="What was this for?"></label>' +
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
    // Leading an event doesn't make someone an organizer, so they still land
    // here to log their own hours — this is just a pointer to where they
    // approve submissions for the event(s) they lead.
    var leaderNote = data.isLeader ?
      '<p class="archive-status hours-leader-note">You lead an event — <a href="hours-approval.html">review its pending hours</a>.</p>' : '';
    panel.innerHTML = leaderNote + volunteerMarkup(totalHours, events);

    var eventsById = {};
    events.forEach(function (event) { if (event.id) eventsById[event.id] = event; });

    var form = document.getElementById('hours-form');
    form.addEventListener('submit', function (evt) {
      evt.preventDefault();
      submitHours(evt.target);
    });

    // No event selected from the calendar dropdown ("— enter it myself —")
    // means there's no server-verifiable title to fall back on, so ask for
    // one as free text instead — required only in that case. Toggled via
    // inline style rather than the `hidden` attribute: .contact__field's
    // own `display: block` is an author rule and outranks the UA
    // stylesheet's `[hidden] { display: none }` regardless of specificity.
    var titleField = document.getElementById('hours-event-title-field');
    function syncEventTitleField() {
      var noEventSelected = !form.eventId.value;
      titleField.style.display = noEventSelected ? '' : 'none';
      form.eventTitle.required = noEventSelected;
      if (!noEventSelected) form.eventTitle.value = '';
    }
    syncEventTitleField();

    // Pre-fill date/hours from the picked event as a convenience — the
    // volunteer can still edit either field afterward.
    form.eventId.addEventListener('change', function () {
      syncEventTitleField();
      var event = eventsById[form.eventId.value];
      if (!event) return;
      var dateIso = eventDateIso(event);
      if (dateIso) form.date.value = dateIso;
      var hours = eventDurationHours(event);
      if (hours) form.hours.value = hours;
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
        eventTitle: form.eventTitle.value,
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
          status('Organizers review submissions from <a href="hours-approval.html">Volunteer Hour Approval</a> instead.');
          return;
        }
        loadEventOptions(auth.getCredential(), function (events) { renderVolunteer(result.data, events); });
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
