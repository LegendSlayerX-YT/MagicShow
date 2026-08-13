/* ===========================================================
   Calendar Manager — leader adjustment + event creation for
   whoever can manage an event: a top-level manager, an Area
   Head, or anyone that Head reports up to (see canUseArea in
   the Worker's org-chart.js). Fetches the same /api/calendar
   relay as the public calendar page, but only ever renders
   events where the Worker's verified event.canManage says so —
   there is no register control anywhere in this file.
   =========================================================== */
(function () {
  var list = document.getElementById('calendar-list');
  if (!list) return;

  var addEventContainer = document.getElementById('calendar-add-event');

  var rootCfg = window.CONFIG || {};
  var endpoint = (rootCfg.api && rootCfg.api.calendar) || '/api/calendar';
  var leadersEndpoint = (rootCfg.api && rootCfg.api.leaders) || '/api/leaders';
  var areasEndpoint = (rootCfg.api && rootCfg.api.areas) || '/api/areas';
  var eventsEndpoint = (rootCfg.api && rootCfg.api.events) || '/api/events';
  var timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  var rangeEl = document.getElementById('calendar-range');

  // Which Areas the signed-in visitor may create events for, and whether
  // they're a top-level manager — both come from /api/areas (see
  // handleListAreas). Used only to pick the right empty-state message when
  // the event list itself comes back with nothing to manage.
  var usableAreas = [];
  var isOrganizerFlag = false;

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

  // A person pill a manager can drag between the Leads and Volunteers
  // zones. `data-original` records which zone this pill started in (the
  // last-saved state), so isDirty() can tell a staged move apart from the
  // persisted pick without a separate state object.
  function pillMarkup(attendee, zone) {
    return '' +
      '<span class="calendar-pill" draggable="true" data-email="' + escapeHtml(attendee.email) + '" data-original="' + zone + '">' +
        escapeHtml(attendee.name) +
      '</span>';
  }

  // This event's registered guests as draggable pills, split into the
  // Leads/Volunteers zones a manager can drag between. attendeeDetails/
  // leaders only ever arrive when event.canManage is true — see trimEvent
  // in the Worker.
  function leaderBoardMarkup(event) {
    var attendees = Array.isArray(event.attendeeDetails) ? event.attendeeDetails : [];
    if (!attendees.length) {
      return '<p class="calendar-leaders__hint">No registered guests yet.</p>';
    }

    var currentLeaders = Array.isArray(event.leaders) ? event.leaders : [];
    var leaderSet = {};
    currentLeaders.forEach(function (email) { leaderSet[email] = true; });

    var leadPills = '';
    var volunteerPills = '';
    attendees.forEach(function (attendee) {
      if (leaderSet[attendee.email]) {
        leadPills += pillMarkup(attendee, 'leads');
      } else {
        volunteerPills += pillMarkup(attendee, 'volunteers');
      }
    });

    return '' +
      '<div class="calendar-leaders__board">' +
        '<div class="calendar-leaders__row">' +
          '<span class="calendar-leaders__row-label">Leads:</span>' +
          '<div class="calendar-leaders__pills" data-role="leads">' + leadPills + '</div>' +
        '</div>' +
        '<div class="calendar-leaders__row">' +
          '<span class="calendar-leaders__row-label">Volunteers:</span>' +
          '<div class="calendar-leaders__pills" data-role="volunteers">' + volunteerPills + '</div>' +
        '</div>' +
      '</div>';
  }

  // The Save control that appears on the right once a drag has staged a
  // change (see refreshLeaderState/isDirty). Kept separate from the pill
  // board so it can sit in the article's right-hand column while the board
  // sits in the body on the left.
  function leaderSaveMarkup(event) {
    var attendees = Array.isArray(event.attendeeDetails) ? event.attendeeDetails : [];
    if (!attendees.length) return '';
    var id = escapeHtml(event.id);
    return '' +
      '<div class="calendar-leaders" data-event-id="' + id + '">' +
        '<button type="button" class="btn btn--solid calendar-leaders__save" hidden>Save</button>' +
        '<p class="calendar-leaders__status" role="status"></p>' +
      '</div>';
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
        var area = event.area ?
          '<p class="calendar-event__meta calendar-event__area">Area: ' + escapeHtml(event.area) + '</p>' : '';
        var description = event.description ?
          '<p class="calendar-event__meta">' + escapeHtml(event.description.split('\n')[0]) + '</p>' : '';
        var summary = event.summary || 'Untitled event';

        return '' +
          '<article class="calendar-event">' +
            '<div class="calendar-event__body">' +
              '<p class="calendar-event__time">' + escapeHtml(timeLabel(event)) + '</p>' +
              '<h3 class="calendar-event__title">' + escapeHtml(summary) + '</h3>' +
              location +
              area +
              description +
              leaderBoardMarkup(event) +
            '</div>' +
            leaderSaveMarkup(event) +
          '</article>';
      }).join('') : '<p class="calendar-day__empty">Nothing to manage this day.</p>';

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

  /* ---------- leader pill drag/drop ---------- */

  list.addEventListener('click', function (evt) {
    // Tap-to-move: a plain click (no drag) swaps a pill to the other zone.
    // Kept alongside native drag/drop so the board still works on touch
    // devices, which don't fire HTML5 drag events.
    var pill = evt.target.closest('.calendar-pill');
    if (pill) {
      var currentZone = pill.closest('.calendar-leaders__pills');
      var board = pill.closest('.calendar-leaders__board');
      if (currentZone && board) {
        var otherRole = currentZone.dataset.role === 'leads' ? 'volunteers' : 'leads';
        var otherZone = board.querySelector('.calendar-leaders__pills[data-role="' + otherRole + '"]');
        if (otherZone) {
          otherZone.appendChild(pill);
          refreshLeaderState(pill.closest('.calendar-event'));
        }
      }
      return;
    }
    var save = evt.target.closest('.calendar-leaders__save');
    if (save) submitLeaders(save.closest('.calendar-leaders'));
  });

  var draggedPill = null;

  list.addEventListener('dragstart', function (evt) {
    var pill = evt.target.closest('.calendar-pill');
    if (!pill) return;
    draggedPill = pill;
    pill.classList.add('calendar-pill--dragging');
    evt.dataTransfer.effectAllowed = 'move';
    evt.dataTransfer.setData('text/plain', pill.dataset.email || '');
  });

  list.addEventListener('dragend', function () {
    if (draggedPill) draggedPill.classList.remove('calendar-pill--dragging');
    draggedPill = null;
  });

  list.addEventListener('dragover', function (evt) {
    var zone = evt.target.closest('.calendar-leaders__pills');
    if (!zone || !draggedPill) return;
    evt.preventDefault();
    zone.classList.add('calendar-leaders__pills--over');
  });

  list.addEventListener('dragleave', function (evt) {
    var zone = evt.target.closest('.calendar-leaders__pills');
    if (zone) zone.classList.remove('calendar-leaders__pills--over');
  });

  list.addEventListener('drop', function (evt) {
    var zone = evt.target.closest('.calendar-leaders__pills');
    if (!zone || !draggedPill) return;
    evt.preventDefault();
    zone.classList.remove('calendar-leaders__pills--over');
    zone.appendChild(draggedPill);
    refreshLeaderState(zone.closest('.calendar-event'));
  });

  // A pill is "dirty" once its current zone no longer matches the zone it
  // started in (data-original, set at render time / reset on save) — that
  // in-DOM comparison is the staged-in-memory leader list, with no separate
  // state object to keep in sync.
  function isDirty(article) {
    var pills = article.querySelectorAll('.calendar-pill');
    for (var i = 0; i < pills.length; i++) {
      var pill = pills[i];
      var zone = pill.closest('.calendar-leaders__pills');
      if (!zone || zone.dataset.role !== pill.dataset.original) return true;
    }
    return false;
  }

  // Shows/hides the right-hand Save button to match whether the board has
  // any staged (unsaved) moves.
  function refreshLeaderState(article) {
    if (!article) return;
    var wrap = article.querySelector('.calendar-leaders');
    if (!wrap) return;
    var button = wrap.querySelector('.calendar-leaders__save');
    var statusEl = wrap.querySelector('.calendar-leaders__status');
    var dirty = isDirty(article);
    button.hidden = !dirty;
    if (!dirty && statusEl) statusEl.textContent = '';
  }

  function submitLeaders(card) {
    var auth = window.GoogleAuth;
    var statusEl = card.querySelector('.calendar-leaders__status');
    var button = card.querySelector('.calendar-leaders__save');
    var article = card.closest('.calendar-event');

    if (!auth || !auth.isSignedIn()) {
      statusEl.textContent = 'Sign in with Google (top right) to save.';
      statusEl.className = 'calendar-leaders__status calendar-leaders__status--error';
      return;
    }

    var leadsZone = article.querySelector('.calendar-leaders__pills[data-role="leads"]');
    var emails = Array.prototype.map.call(
      leadsZone ? leadsZone.querySelectorAll('.calendar-pill') : [],
      function (pill) { return pill.dataset.email; }
    );

    button.disabled = true;
    statusEl.textContent = 'Saving…';
    statusEl.className = 'calendar-leaders__status';

    fetch(leadersEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId: card.dataset.eventId, leaders: emails, credential: auth.getCredential() })
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
          statusEl.className = 'calendar-leaders__status calendar-leaders__status--error';
          return;
        }
        // Persisted — the current zone assignment is the new baseline, so
        // the board reads as clean again until the next drag.
        Array.prototype.forEach.call(article.querySelectorAll('.calendar-pill'), function (pill) {
          var zone = pill.closest('.calendar-leaders__pills');
          if (zone) pill.dataset.original = zone.dataset.role;
        });
        button.hidden = true;
        statusEl.textContent = 'Saved.';
        statusEl.className = 'calendar-leaders__status calendar-leaders__status--success';
      })
      .catch(function (error) {
        console.warn('Saving leaders failed:', error);
        button.disabled = false;
        statusEl.textContent = 'Could not reach the server. Please try again.';
        statusEl.className = 'calendar-leaders__status calendar-leaders__status--error';
      });
  }

  /* ---------- add event ---------- */

  function areaOptionsMarkup(areas) {
    return areas.map(function (area) {
      return '<option value="' + escapeHtml(area) + '">' + escapeHtml(area) + '</option>';
    }).join('');
  }

  function addEventMarkup(areas) {
    return '' +
      '<button type="button" class="btn btn--solid calendar-add-event__toggle">+ Add Event</button>' +
      '<form class="contact__form calendar-add-event__form" id="calendar-add-event-form" hidden>' +
        '<label class="contact__field"><span>Area</span>' +
          '<select class="contact__input" name="area" required>' +
            '<option value="">— select an Area —</option>' + areaOptionsMarkup(areas) +
          '</select></label>' +
        '<label class="contact__field"><span>Title</span>' +
          '<input class="contact__input" type="text" name="title" maxlength="200" required></label>' +
        '<label class="contact__field"><span>Location</span>' +
          '<input class="contact__input" type="text" name="location" maxlength="200"></label>' +
        '<label class="contact__field"><span>Description</span>' +
          '<textarea class="contact__input contact__input--message" name="description" maxlength="4000"></textarea></label>' +
        '<label class="contact__field calendar-add-event__allday">' +
          '<input type="checkbox" name="allDay"> <span>All day</span>' +
        '</label>' +
        '<div class="calendar-add-event__when calendar-add-event__when--timed">' +
          '<label class="contact__field"><span>Starts</span>' +
            '<input class="contact__input" type="datetime-local" name="startDateTime"></label>' +
          '<label class="contact__field"><span>Ends</span>' +
            '<input class="contact__input" type="datetime-local" name="endDateTime"></label>' +
        '</div>' +
        '<div class="calendar-add-event__when calendar-add-event__when--allday" hidden>' +
          '<label class="contact__field"><span>Starts</span>' +
            '<input class="contact__input" type="date" name="startDate"></label>' +
          '<label class="contact__field"><span>Ends</span>' +
            '<input class="contact__input" type="date" name="endDate"></label>' +
        '</div>' +
        '<div class="contact__actions">' +
          '<button type="submit" class="btn btn--solid">Create Event</button>' +
          '<button type="button" class="btn calendar-add-event__cancel">Cancel</button>' +
          '<p class="contact__status contact__status--inline" id="calendar-add-event-status" role="status"></p>' +
        '</div>' +
      '</form>';
  }

  function renderAddEvent() {
    if (!addEventContainer) return;
    if (!usableAreas.length) {
      addEventContainer.innerHTML = '';
      return;
    }

    addEventContainer.innerHTML = addEventMarkup(usableAreas);

    var form = document.getElementById('calendar-add-event-form');
    var toggleButton = addEventContainer.querySelector('.calendar-add-event__toggle');
    toggleButton.addEventListener('click', function () {
      form.hidden = !form.hidden;
      toggleButton.hidden = !form.hidden;
    });
    form.querySelector('.calendar-add-event__cancel').addEventListener('click', function () {
      form.reset();
      form.hidden = true;
      toggleButton.hidden = false;
    });

    var timedWrap = form.querySelector('.calendar-add-event__when--timed');
    var allDayWrap = form.querySelector('.calendar-add-event__when--allday');
    form.allDay.addEventListener('change', function () {
      timedWrap.hidden = form.allDay.checked;
      allDayWrap.hidden = !form.allDay.checked;
    });

    form.addEventListener('submit', function (evt) {
      evt.preventDefault();
      submitNewEvent(form);
    });
  }

  function submitNewEvent(form) {
    var auth = window.GoogleAuth;
    var statusEl = document.getElementById('calendar-add-event-status');
    var button = form.querySelector('button[type="submit"]');
    if (!auth || !auth.isSignedIn()) {
      statusEl.textContent = 'Sign in with Google (top right) to create an event.';
      statusEl.setAttribute('data-state', 'error');
      return;
    }

    var allDay = form.allDay.checked;
    var payload = {
      area: form.area.value,
      title: form.title.value,
      location: form.location.value,
      description: form.description.value,
      allDay: allDay,
      credential: auth.getCredential()
    };
    if (allDay) {
      payload.startDate = form.startDate.value;
      payload.endDate = form.endDate.value;
    } else {
      // datetime-local has no timezone of its own — new Date() reads it as
      // the visitor's local time, and toISOString() below converts that to
      // an absolute instant the Worker can trust regardless of the
      // visitor's clock/zone.
      payload.start = form.startDateTime.value ? new Date(form.startDateTime.value).toISOString() : '';
      payload.end = form.endDateTime.value ? new Date(form.endDateTime.value).toISOString() : '';
    }

    button.disabled = true;
    statusEl.textContent = 'Creating…';
    statusEl.removeAttribute('data-state');

    fetch(eventsEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
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
        statusEl.textContent = 'Event created.';
        statusEl.setAttribute('data-state', 'success');
        form.reset();
        form.hidden = true;
        var toggleButton = form.parentNode.querySelector('.calendar-add-event__toggle');
        if (toggleButton) toggleButton.hidden = false;
        loadCalendar();
      })
      .catch(function (error) {
        console.warn('Creating event failed:', error);
        button.disabled = false;
        statusEl.textContent = 'Could not reach the server. Please try again.';
        statusEl.setAttribute('data-state', 'error');
      });
  }

  function loadAreas() {
    var auth = window.GoogleAuth;
    if (!auth || !auth.isSignedIn()) {
      usableAreas = [];
      isOrganizerFlag = false;
      renderAddEvent();
      return;
    }
    fetch(areasEndpoint, { headers: { Authorization: 'Bearer ' + auth.getCredential() } })
      .then(function (response) { return response.ok ? response.json() : { areas: [] }; })
      .then(function (data) {
        usableAreas = Array.isArray(data.areas) ? data.areas : [];
        isOrganizerFlag = !!data.isOrganizer;
        renderAddEvent();
      })
      .catch(function () {
        usableAreas = [];
        isOrganizerFlag = false;
        renderAddEvent();
      });
  }

  window.addEventListener('googleauth:signin', loadCalendar);
  window.addEventListener('googleauth:signout', loadCalendar);
  window.addEventListener('googleauth:signin', loadAreas);
  window.addEventListener('googleauth:signout', loadAreas);

  function fetchUrl(start, endExclusive) {
    var params = new URLSearchParams({
      timeMin: start.toISOString(),
      timeMax: endExclusive.toISOString()
    });
    return endpoint + '?' + params.toString();
  }

  var today = new Date();
  var futureStart = startOfDay(today);
  var futureEndInclusive = startOfDay(addDays(today, 7));
  var futureEndExclusive = startOfDay(addDays(today, 8));
  var days = buildDays(futureStart, futureEndInclusive);

  if (rangeEl) {
    rangeEl.textContent = 'Showing ' + formatRangeDate(futureStart) + ' through ' + formatRangeDate(futureEndInclusive) + '.';
  }

  function loadCalendar() {
    var auth = window.GoogleAuth;
    if (!auth || !auth.isSignedIn()) {
      status('Sign in as an Area Head or manager to use this page.');
      return;
    }

    fetch(fetchUrl(futureStart, futureEndExclusive), { headers: { Authorization: 'Bearer ' + auth.getCredential() } })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(function (data) {
        if (data.timeZone) timeZone = data.timeZone;

        var manageable = (data.events || []).filter(function (event) { return event.canManage; });
        if (!manageable.length) {
          status(isOrganizerFlag || usableAreas.length
            ? "You don't manage any events in this window."
            : 'Sign in as an Area Head or manager to use this page.');
          return;
        }

        var eventsByDay = {};
        manageable.forEach(function (event) {
          var key = dayKeyForEvent(event);
          if (!key) return;
          if (!eventsByDay[key]) eventsByDay[key] = [];
          eventsByDay[key].push(event);
        });

        render(days, eventsByDay);
      })
      .catch(function (error) {
        console.warn('Calendar fetch failed:', error);
        status('Unable to load calendar events right now.');
      });
  }

  loadCalendar();
  loadAreas();
})();
