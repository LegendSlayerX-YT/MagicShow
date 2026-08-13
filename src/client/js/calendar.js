/* ===========================================================
   Calendar — fetch public Google Calendar events through the
   site's own /api/calendar relay (the Worker holds the API
   key). Renders two independent windows:
     - today through 7 days ahead, as the themed daily list
     - up to the last 90 days (10 most recent), as a horizontal
       slider of compact cards
   =========================================================== */
(function () {
  var list = document.getElementById('calendar-list');
  if (!list) return;

  var pastSection = document.getElementById('calendar-past');
  var pastRow = document.getElementById('calendar-past-row');

  var rootCfg = window.CONFIG || {};
  var endpoint = (rootCfg.api && rootCfg.api.calendar) || '/api/calendar';
  var registerEndpoint = (rootCfg.api && rootCfg.api.register) || '/api/register';
  // Replaced by the relay's time zone once the response lands.
  var timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  var rangeEl = document.getElementById('calendar-range');
  // Set from the relay's response before render() runs — see the fetch
  // below.
  var registrationOpen = false;

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function addDays(date, days) {
    var next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
  }

  function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  function isoDateKey(date) {
    return date.getFullYear() + '-' +
      String(date.getMonth() + 1).padStart(2, '0') + '-' +
      String(date.getDate()).padStart(2, '0');
  }

  function formatRangeDate(date) {
    return new Intl.DateTimeFormat('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric'
    }).format(date);
  }

  function dayLabel(date) {
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric'
    }).format(date);
  }

  function timeLabel(event) {
    if (event.start && event.start.date) return 'All day';

    var start = event.start && event.start.dateTime ? new Date(event.start.dateTime) : null;
    var end = event.end && event.end.dateTime ? new Date(event.end.dateTime) : null;
    if (!start) return 'Time unavailable';

    var formatter = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: timeZone
    });

    if (!end) return formatter.format(start);
    return formatter.format(start) + ' - ' + formatter.format(end);
  }

  function dayKeyForEvent(event) {
    if (event.start && event.start.date) return event.start.date;

    var dt = event.start && event.start.dateTime ? new Date(event.start.dateTime) : null;
    if (!dt) return '';

    var parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(dt);
    var map = {};
    parts.forEach(function (part) {
      map[part.type] = part.value;
    });
    return map.year + '-' + map.month + '-' + map.day;
  }

  function status(message) {
    list.innerHTML = '<p class="archive-status">' + message + '</p>';
  }

  // No point offering a seat at something that's already over. The Worker
  // enforces the same rule; this just keeps the button from lying.
  function hasEnded(event) {
    var end = event.end || {};
    if (end.dateTime) return Date.parse(end.dateTime) < Date.now();
    if (end.date) return Date.parse(end.date + 'T23:59:59') < Date.now();
    return true;
  }

  function registerMarkup(event) {
    var id = escapeHtml(event.id);
    // `registered` only ever arrives when the visitor is signed in — see
    // the Authorization header on the fetch below.
    if (event.registered) {
      return '' +
        '<div class="calendar-register" data-event-id="' + id + '">' +
          '<p class="calendar-register__badge">Registered</p>' +
        '</div>';
    }
    // Signed-out visitors can't complete registration at all — show it as
    // a plain label, not a button that would just error on click.
    if (!window.GoogleAuth || !window.GoogleAuth.isSignedIn()) {
      return '' +
        '<div class="calendar-register" data-event-id="' + id + '">' +
          '<p class="calendar-register__hint">Google Sign in to Register</p>' +
        '</div>';
    }
    return '' +
      '<div class="calendar-register" data-event-id="' + id + '">' +
        '<button type="button" class="btn btn--solid calendar-register__open">Register</button>' +
        '<p class="calendar-register__status" role="status"></p>' +
      '</div>';
  }

  // Shared by the daily list and the past-events slider. `leads` are the
  // guests an organizer picked (see leaderBoardMarkup); everyone else who
  // registered shows up as a volunteer. Emails never reach this file — the
  // Worker already split guests into these two name-only lists server-side.
  function attendeesMarkup(event) {
    var leads = Array.isArray(event.leads) ? event.leads : [];
    var volunteers = Array.isArray(event.volunteers) ? event.volunteers : [];
    var markup = '';
    if (leads.length) {
      markup += '<p class="calendar-event__meta calendar-event__attendees calendar-event__leads">Leads: ' +
        escapeHtml(leads.join(', ')) + '</p>';
    }
    if (volunteers.length) {
      markup += '<p class="calendar-event__meta calendar-event__attendees calendar-event__volunteers">Volunteers: ' +
        escapeHtml(volunteers.join(', ')) + '</p>';
    }
    return markup;
  }

  function render(days, eventsByDay) {
    list.innerHTML = '';

    days.forEach(function (date) {
      var key = isoDateKey(date);
      var events = eventsByDay[key] || [];
      var section = document.createElement('section');
      section.className = 'calendar-day';

      var items = events.length ? events.map(function (event) {
        var location = event.location ?
          '<p class="calendar-event__meta">' + escapeHtml(event.location) + '</p>' : '';
        // Blank for events created before the Area feature existed (see
        // handleCreateEvent in the Worker) — those just show no Area line.
        var area = event.area ?
          '<p class="calendar-event__meta calendar-event__area">Area: ' + escapeHtml(event.area) + '</p>' : '';
        var description = event.description ?
          '<p class="calendar-event__meta">' + escapeHtml(event.description.split('\n')[0]) + '</p>' : '';
        var attendeesLine = attendeesMarkup(event);
        var summary = event.summary || 'Untitled event';
        var register = registrationOpen && event.id && !hasEnded(event) ?
          registerMarkup(event) : '';

        return '' +
          '<article class="calendar-event">' +
            '<div class="calendar-event__body">' +
              '<p class="calendar-event__time">' + escapeHtml(timeLabel(event)) + '</p>' +
              '<h3 class="calendar-event__title">' + escapeHtml(summary) + '</h3>' +
              location +
              area +
              description +
              attendeesLine +
            '</div>' +
            register +
          '</article>';
      }).join('') : '<p class="calendar-day__empty">No public events.</p>';

      section.innerHTML =
        '<div class="calendar-day__header">' +
          '<p class="calendar-day__weekday">' + escapeHtml(dayLabel(date)) + '</p>' +
          '<p class="calendar-day__date">' + escapeHtml(formatRangeDate(date)) + '</p>' +
        '</div>' +
        '<div class="calendar-day__events">' + items + '</div>';

      list.appendChild(section);
    });
  }

  function buildDays(start, endInclusive) {
    var days = [];
    for (var d = new Date(start); d <= endInclusive; d = addDays(d, 1)) {
      days.push(new Date(d));
    }
    return days;
  }

  /* ---------- past events (horizontal slider) ---------- */

  var PAST_DAYS = 90;
  var MAX_PAST_EVENTS = 10;

  function eventStartMs(event) {
    var start = event.start || {};
    if (start.dateTime) return Date.parse(start.dateTime);
    if (start.date) return Date.parse(start.date + 'T00:00:00');
    return NaN;
  }

  function eventDateLabel(event) {
    var ms = eventStartMs(event);
    if (isNaN(ms)) return '';
    // Explicit timeZone so the date shown here always agrees with
    // timeLabel()'s time, regardless of the browser's own zone.
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      timeZone: timeZone
    }).format(new Date(ms));
  }

  function pastAttendeesMarkup(event) {
    var leads = Array.isArray(event.leads) ? event.leads : [];
    var volunteers = Array.isArray(event.volunteers) ? event.volunteers : [];
    if (!leads.length && !volunteers.length) {
      return '<p class="calendar-past-card__attendees">No attendees yet.</p>';
    }
    var markup = '';
    if (leads.length) {
      markup += '<p class="calendar-past-card__attendees">Leads: ' + escapeHtml(leads.join(', ')) + '</p>';
    }
    if (volunteers.length) {
      markup += '<p class="calendar-past-card__attendees">Volunteers: ' + escapeHtml(volunteers.join(', ')) + '</p>';
    }
    return markup;
  }

  function renderPast(events) {
    if (!pastSection || !pastRow) return;

    if (!events.length) {
      pastSection.hidden = true;
      pastRow.innerHTML = '';
      return;
    }

    pastSection.hidden = false;
    pastRow.innerHTML = events.map(function (event) {
      var summary = event.summary || 'Untitled event';
      return '' +
        '<article class="calendar-past-card">' +
          '<p class="calendar-past-card__time">' + escapeHtml(eventDateLabel(event)) +
            ' · ' + escapeHtml(timeLabel(event)) + '</p>' +
          '<h3 class="calendar-past-card__title">' + escapeHtml(summary) + '</h3>' +
          pastAttendeesMarkup(event) +
        '</article>';
    }).join('');
  }

  /* ---------- registration ---------- */

  // Reflects a fresh registration into the "Volunteers: ..." line right
  // away, so the guest count is right without a reload — a new registrant
  // is always a volunteer; only an organizer promotes someone to a lead,
  // after the fact, from the guest list. Skipped when the visitor was
  // already on the list — nothing to add.
  function addAttendee(card, name) {
    var article = card.closest('.calendar-event');
    if (!article) return;
    var meta = article.querySelector('.calendar-event__volunteers');
    if (meta) {
      meta.textContent = meta.textContent + ', ' + name;
      return;
    }
    var body = article.querySelector('.calendar-event__body');
    if (!body) return;
    meta = document.createElement('p');
    meta.className = 'calendar-event__meta calendar-event__attendees calendar-event__volunteers';
    meta.textContent = 'Volunteers: ' + name;
    body.appendChild(meta);
  }

  function setStatus(card, message, state) {
    var el = card.querySelector('.calendar-register__status');
    el.textContent = message;
    el.className = 'calendar-register__status' +
      (state ? ' calendar-register__status--' + state : '');
  }

  function submitRegistration(card) {
    var auth = window.GoogleAuth;
    if (!auth || !auth.isSignedIn()) {
      setStatus(card, 'Sign in with Google (top right) to register.', 'error');
      return;
    }

    var button = card.querySelector('.calendar-register__open');
    button.disabled = true;
    setStatus(card, 'Sending…');

    fetch(registerEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId: card.dataset.eventId, credential: auth.getCredential() })
    })
      .then(function (response) {
        return response.json()
          .catch(function () { return {}; })
          .then(function (data) { return { ok: response.ok, data: data }; });
      })
      .then(function (result) {
        if (!result.ok) {
          setStatus(card, result.data.error || 'Something went wrong. Please try again.', 'error');
          button.disabled = false;
          return;
        }

        setStatus(card, '');
        button.textContent = 'Registered';
        button.disabled = true;
        button.classList.remove('btn', 'btn--solid', 'calendar-register__open');
        button.classList.add('calendar-register__badge');

        if (!result.data.alreadyRegistered) {
          addAttendee(card, auth.getName() || auth.getEmail());
        }
      })
      .catch(function (error) {
        console.warn('Registration failed:', error);
        setStatus(card, 'Could not reach the server. Please try again.', 'error');
        button.disabled = false;
      });
  }

  // The button only ever renders while signed in (see registerMarkup), so
  // there's no signed-out case to handle here.
  list.addEventListener('click', function (evt) {
    var open = evt.target.closest('.calendar-register__open');
    if (!open) return;
    submitRegistration(open.closest('.calendar-register'));
  });

  // Reload on sign-in/out so the register button/hint/badge for every
  // event reflects the new auth state, and signed-in visitors pick up
  // "Registered" badges for events they're already on.
  window.addEventListener('googleauth:signin', loadCalendar);
  window.addEventListener('googleauth:signout', loadCalendar);

  function fetchUrl(start, endExclusive, includeAttendees) {
    var params = new URLSearchParams({
      timeMin: start.toISOString(),
      timeMax: endExclusive.toISOString()
    });
    if (includeAttendees) params.set('attendees', '1');
    return endpoint + '?' + params.toString();
  }

  var today = new Date();

  // Future window: today through 7 days ahead, unchanged from before.
  var futureStart = startOfDay(today);
  var futureEndInclusive = startOfDay(addDays(today, 7));
  var futureEndExclusive = startOfDay(addDays(today, 8));
  var days = buildDays(futureStart, futureEndInclusive);

  // Past window: everything before today, back up to PAST_DAYS — fetched
  // separately so it stays under the Worker's per-request range cap and so
  // attendee names (see fetchUrl above) are only requested/exposed here.
  var pastStart = startOfDay(addDays(today, -PAST_DAYS));
  var pastEndExclusive = futureStart;

  if (rangeEl) {
    rangeEl.textContent = 'Showing ' + formatRangeDate(futureStart) + ' through ' + formatRangeDate(futureEndInclusive) + '.';
  }

  function loadCalendar() {
    var auth = window.GoogleAuth;
    var headers = {};
    // Signed in → the Worker can mark which events this visitor is already
    // registered for, using attendee data it already fetched from Google
    // for this same request (see trimEvent in the Worker) — no extra cost.
    if (auth && auth.isSignedIn()) headers.Authorization = 'Bearer ' + auth.getCredential();

    fetch(fetchUrl(futureStart, futureEndExclusive, true), { headers: headers })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(function (data) {
        // The relay reports the calendar's configured time zone; use it so
        // event times read the same for every visitor.
        if (data.timeZone) timeZone = data.timeZone;
        registrationOpen = !!data.registrationOpen;

        var eventsByDay = {};

        (data.events || []).forEach(function (event) {
          var key = dayKeyForEvent(event);
          if (!key) return;
          if (!eventsByDay[key]) eventsByDay[key] = [];
          eventsByDay[key].push(event);
        });

        render(days, eventsByDay);
      })
      .catch(function (error) {
        console.warn('Calendar fetch failed:', error);
        status('Unable to load calendar events right now. Make sure the calendar is public and the Google Calendar API is enabled for the configured API key.');
      });

    fetch(fetchUrl(pastStart, pastEndExclusive, true))
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(function (data) {
        if (data.timeZone) timeZone = data.timeZone;
        var events = (data.events || [])
          .slice()
          .sort(function (a, b) { return eventStartMs(b) - eventStartMs(a); })
          .slice(0, MAX_PAST_EVENTS);
        renderPast(events);
      })
      .catch(function (error) {
        console.warn('Past calendar fetch failed:', error);
        if (pastSection) pastSection.hidden = true;
      });
  }

  loadCalendar();
})();
