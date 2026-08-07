/* ===========================================================
   Calendar — embed the public Google Calendar in agenda mode
   for a rolling window from 3 days ago through 7 days ahead.
   =========================================================== */
(function () {
  var frameWrap = document.getElementById('calendar-frame-wrap');
  if (!frameWrap) return;

  var cfg = (window.CONFIG && window.CONFIG.calendar) || {};
  var calendarId = cfg.id || 'chenhenrybunny@gmail.com';
  var timeZone = cfg.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  var rangeEl = document.getElementById('calendar-range');
  var openEl = document.getElementById('calendar-open');

  function addDays(date, days) {
    var next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
  }

  function pad(value) {
    return String(value).padStart(2, '0');
  }

  function formatEmbedDate(date) {
    return date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate());
  }

  function formatRangeDate(date) {
    return new Intl.DateTimeFormat('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric'
    }).format(date);
  }

  var today = new Date();
  var start = addDays(today, -3);
  var endInclusive = addDays(today, 7);
  var endExclusive = addDays(today, 8);

  var params = new URLSearchParams({
    src: calendarId,
    ctz: timeZone,
    mode: 'AGENDA',
    showTitle: '0',
    showNav: '0',
    showDate: '1',
    showTabs: '0',
    showCalendars: '0',
    showPrint: '0',
    wkst: '1',
    dates: formatEmbedDate(start) + '/' + formatEmbedDate(endExclusive)
  });

  var embedUrl = 'https://calendar.google.com/calendar/embed?' + params.toString();

  if (rangeEl) {
    rangeEl.textContent = 'Showing ' + formatRangeDate(start) + ' through ' + formatRangeDate(endInclusive) + '.';
  }

  if (openEl) {
    openEl.href = embedUrl;
  }

  frameWrap.innerHTML = '';

  var iframe = document.createElement('iframe');
  iframe.src = embedUrl;
  iframe.title = 'Gasp Machine calendar';
  iframe.loading = 'lazy';
  frameWrap.appendChild(iframe);
})();
