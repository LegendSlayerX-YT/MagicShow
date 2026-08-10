/* ===========================================================
   Calendar — fetch public Google Calendar events through the
   site's own /api/calendar relay (the Worker holds the API
   key) and render a themed rolling list from 3 days ago
   through 7 days ahead.
   =========================================================== */
(function () {
  var list = document.getElementById('calendar-list');
  if (!list) return;

  var rootCfg = window.CONFIG || {};
  var endpoint = (rootCfg.api && rootCfg.api.calendar) || '/api/calendar';
  var registerEndpoint = (rootCfg.api && rootCfg.api.register) || '/api/register';
  var EMAIL_STORE_KEY = 'gaspmachine:register-email';
  // Replaced by the relay's time zone once the response lands.
  var timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  var rangeEl = document.getElementById('calendar-range');
  // Set from the relay's response before render() runs — see the fetch below.
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
    return '' +
      '<div class="calendar-register" data-event-id="' + id + '">' +
        '<button type="button" class="btn btn--solid calendar-register__open">Register</button>' +
        '<form class="calendar-register__form" hidden>' +
          '<label class="calendar-register__field">' +
            '<span>Your email</span>' +
            '<input class="contact__input" type="email" name="email" required ' +
              'autocomplete="email" placeholder="you@example.com" />' +
          '</label>' +
          '<div class="calendar-register__actions">' +
            '<button type="submit" class="btn btn--solid">Send invite</button>' +
            '<button type="button" class="btn calendar-register__cancel">Cancel</button>' +
          '</div>' +
        '</form>' +
        '<p class="calendar-register__status" role="status"></p>' +
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
        var description = event.description ?
          '<p class="calendar-event__meta">' + escapeHtml(event.description.split('\n')[0]) + '</p>' : '';
        var summary = event.summary || 'Untitled event';
        var link = event.htmlLink ?
          '<a class="calendar-event__link" href="' + event.htmlLink + '" target="_blank" rel="noopener">View details</a>' : '';
        var register = registrationOpen && event.id && !hasEnded(event) ?
          registerMarkup(event) : '';

        return '' +
          '<article class="calendar-event">' +
            '<p class="calendar-event__time">' + escapeHtml(timeLabel(event)) + '</p>' +
            '<h3 class="calendar-event__title">' + escapeHtml(summary) + '</h3>' +
            location +
            description +
            link +
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

  /* ---------- registration ---------- */

  // Remembering the address means someone signing up for two shows only
  // types it once. Private browsing throws on access, hence the try/catch.
  function readStoredEmail() {
    try {
      return window.localStorage.getItem(EMAIL_STORE_KEY) || '';
    } catch (err) {
      return '';
    }
  }

  function storeEmail(email) {
    try {
      window.localStorage.setItem(EMAIL_STORE_KEY, email);
    } catch (err) {
      /* nothing to do — the prefill is a convenience, not a requirement */
    }
  }

  function setStatus(card, message, state) {
    var el = card.querySelector('.calendar-register__status');
    el.textContent = message;
    el.className = 'calendar-register__status' +
      (state ? ' calendar-register__status--' + state : '');
  }

  function toggleForm(card, open) {
    card.querySelector('.calendar-register__open').hidden = open;
    card.querySelector('.calendar-register__form').hidden = !open;
  }

  list.addEventListener('click', function (evt) {
    var open = evt.target.closest('.calendar-register__open');
    if (open) {
      var card = open.closest('.calendar-register');
      toggleForm(card, true);
      setStatus(card, '');
      var input = card.querySelector('input[name="email"]');
      if (!input.value) input.value = readStoredEmail();
      input.focus();
      return;
    }

    var cancel = evt.target.closest('.calendar-register__cancel');
    if (cancel) {
      var cancelled = cancel.closest('.calendar-register');
      toggleForm(cancelled, false);
      setStatus(cancelled, '');
    }
  });

  list.addEventListener('submit', function (evt) {
    var form = evt.target.closest('.calendar-register__form');
    if (!form) return;
    evt.preventDefault();

    var card = form.closest('.calendar-register');
    var submit = form.querySelector('button[type="submit"]');
    var input = form.querySelector('input[name="email"]');
    var email = input.value.trim();
    if (!email) return;

    submit.disabled = true;
    setStatus(card, 'Sending…');

    fetch(registerEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId: card.dataset.eventId, email: email })
    })
      .then(function (response) {
        return response.json()
          .catch(function () { return {}; })
          .then(function (data) { return { ok: response.ok, data: data }; });
      })
      .then(function (result) {
        if (!result.ok) {
          setStatus(card, result.data.error || 'Something went wrong. Please try again.', 'error');
          submit.disabled = false;
          return;
        }

        storeEmail(email);
        form.hidden = true;
        setStatus(
          card,
          result.data.alreadyRegistered
            ? email + ' is already on the guest list for this event.'
            : 'You\'re on the guest list — ' + email + ' has been added as a guest.',
          'success'
        );
      })
      .catch(function (error) {
        console.warn('Registration failed:', error);
        setStatus(card, 'Could not reach the server. Please try again.', 'error');
        submit.disabled = false;
      });
  });

  function fetchUrl(start, endExclusive) {
    var params = new URLSearchParams({
      timeMin: start.toISOString(),
      timeMax: endExclusive.toISOString()
    });
    return endpoint + '?' + params.toString();
  }

  var today = new Date();
  var start = startOfDay(addDays(today, -3));
  var endInclusive = startOfDay(addDays(today, 7));
  var endExclusive = startOfDay(addDays(today, 8));
  var days = buildDays(start, endInclusive);

  if (rangeEl) {
    rangeEl.textContent = 'Showing ' + formatRangeDate(start) + ' through ' + formatRangeDate(endInclusive) + '.';
  }

  fetch(fetchUrl(start, endExclusive))
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
})();
