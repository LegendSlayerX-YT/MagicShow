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

  // A native `title` attribute is enough for a hover tooltip — who can still
  // decide a pending submission, or who already did for a verified/denied
  // one (see `approvers`/`decidedBy` on the item, set server-side in
  // handleViewHours).
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
    var title = statusTooltip(item);
    return '<span class="hours-status hours-status--' + escapeHtml(item.status) + '"' +
      (title ? ' title="' + escapeHtml(title) + '"' : '') + '>' + statusLabel(item.status) + '</span>';
  }

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
