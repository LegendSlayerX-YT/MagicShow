/* ===========================================================
   Shared between hours.js (volunteer submission page) and
   hours-approval.js (organizer approval page) — the bits both
   need to render a row of submitted hours the same way.
   =========================================================== */
window.HoursCommon = (function () {
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
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

  // Who can still decide a pending submission, or who already did for a
  // verified/denied one (see `approvers`/`decidedBy` on the item, set
  // server-side in handleViewHours). Rendered as a custom floating tooltip
  // (see setupTooltip below) rather than a native `title`, so it can be
  // styled to match the site instead of the browser's plain OS tooltip.
  function statusTooltip(item) {
    if (item.status === 'pending') {
      return item.approvers && item.approvers.length ?
        'Can be approved by: ' + item.approvers.join(', ') : '';
    }
    if (item.decidedBy) {
      return (item.status === 'verified' ? 'Verified' : 'Denied') + ' by ' + item.decidedBy;
    }
    return '';
  }

  function statusBadge(item) {
    var tooltip = statusTooltip(item);
    return '<span class="hours-status hours-status--' + escapeHtml(item.status) + '"' +
      (tooltip ? ' data-tooltip="' + escapeHtml(tooltip) + '" tabindex="0"' : '') +
      '>' + statusLabel(item.status) + '</span>';
  }

  // A single floating div, positioned over whichever `[data-tooltip]`
  // element is hovered/focused — shared across the page rather than one
  // element per badge, since only one tooltip is ever shown at a time.
  // Delegated on `document` (mouseover/mouseout, not mouseenter/mouseleave,
  // since those don't bubble) so it keeps working as hours.js/hours-approval.js
  // re-render the list's innerHTML wholesale on every refresh.
  function setupTooltip() {
    var tip = null;

    function ensureTip() {
      if (!tip) {
        tip = document.createElement('div');
        tip.className = 'hours-tooltip';
        tip.setAttribute('role', 'tooltip');
        tip.hidden = true;
        document.body.appendChild(tip);
      }
      return tip;
    }

    function place(target) {
      var el = ensureTip();
      var rect = target.getBoundingClientRect();
      // Measure after making it visible (but off-screen) so offsetWidth/
      // Height reflect the actual text before it's positioned for real.
      el.style.left = '0px';
      el.style.top = '0px';
      var left = rect.left + rect.width / 2 - el.offsetWidth / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - el.offsetWidth - 8));
      var above = rect.top - el.offsetHeight - 8;
      var top = above >= 8 ? above : rect.bottom + 8;
      el.style.left = left + 'px';
      el.style.top = top + 'px';
    }

    function show(target) {
      var text = target.getAttribute('data-tooltip');
      if (!text) return;
      var el = ensureTip();
      el.textContent = text;
      el.hidden = false;
      place(target);
    }

    function hide() {
      if (tip) tip.hidden = true;
    }

    document.addEventListener('mouseover', function (evt) {
      var target = evt.target.closest && evt.target.closest('[data-tooltip]');
      if (target) show(target);
    });
    document.addEventListener('mouseout', function (evt) {
      var target = evt.target.closest && evt.target.closest('[data-tooltip]');
      if (target) hide();
    });
    // Keyboard/touch users tabbing onto the badge (it's focusable — see
    // statusBadge) get the same tooltip.
    document.addEventListener('focusin', function (evt) {
      var target = evt.target.closest && evt.target.closest('[data-tooltip]');
      if (target) show(target);
    });
    document.addEventListener('focusout', function (evt) {
      var target = evt.target.closest && evt.target.closest('[data-tooltip]');
      if (target) hide();
    });
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
  }

  setupTooltip();

  function submissionMarkup(item) {
    return '' +
      '<li class="hours-item">' +
        '<span class="hours-item__date">' + escapeHtml(formatDate(item.date)) + '</span>' +
        '<span class="hours-item__hours">' + escapeHtml(item.hours) + ' hrs</span>' +
        '<span class="hours-item__event">' + escapeHtml(item.event || '—') + '</span>' +
        statusBadge(item) +
      '</li>';
  }

  return {
    escapeHtml: escapeHtml,
    formatDate: formatDate,
    statusLabel: statusLabel,
    statusBadge: statusBadge,
    submissionMarkup: submissionMarkup
  };
})();
