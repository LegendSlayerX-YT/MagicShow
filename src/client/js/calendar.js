/* ===========================================================
   Calendar — fetch public Google Calendar events and render
   a themed rolling list from 3 days ago through 7 days ahead.
   =========================================================== */
(function () {
  var list = document.getElementById('calendar-list');
  if (!list) return;

  var rootCfg = window.CONFIG || {};
  var cfg = rootCfg.calendar || {};
  var calendarId = cfg.id || 'chenhenrybunny@gmail.com';
  var apiKey = cfg.apiKey || (rootCfg.youtube && rootCfg.youtube.apiKey) || '';
  var timeZone = cfg.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  var rangeEl = document.getElementById('calendar-range');
  var openEl = document.getElementById('calendar-open');

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

        return '' +
          '<article class="calendar-event">' +
            '<p class="calendar-event__time">' + escapeHtml(timeLabel(event)) + '</p>' +
            '<h3 class="calendar-event__title">' + escapeHtml(summary) + '</h3>' +
            location +
            description +
            link +
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

  function fetchUrl(start, endExclusive) {
    var params = new URLSearchParams({
      key: apiKey,
      singleEvents: 'true',
      orderBy: 'startTime',
      timeMin: start.toISOString(),
      timeMax: endExclusive.toISOString(),
      timeZone: timeZone
    });
    return 'https://www.googleapis.com/calendar/v3/calendars/' +
      encodeURIComponent(calendarId) + '/events?' + params.toString();
  }

  var today = new Date();
  var start = startOfDay(addDays(today, -3));
  var endInclusive = startOfDay(addDays(today, 7));
  var endExclusive = startOfDay(addDays(today, 8));
  var days = buildDays(start, endInclusive);

  if (rangeEl) {
    rangeEl.textContent = 'Showing ' + formatRangeDate(start) + ' through ' + formatRangeDate(endInclusive) + '.';
  }

  if (openEl) {
    openEl.href = 'https://calendar.google.com/calendar/u/0/r?cid=' + encodeURIComponent(calendarId);
  }

  if (!apiKey) {
    status('Add <code>calendar.apiKey</code> in <code>js/config.js</code> to load public events here.');
    return;
  }

  fetch(fetchUrl(start, endExclusive))
    .then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    })
    .then(function (data) {
      var eventsByDay = {};

      (data.items || [])
        .filter(function (event) {
          return event.status !== 'cancelled';
        })
        .forEach(function (event) {
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
