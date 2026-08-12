// Shared between the Worker entry (index.js) and the volunteer-hours Sheets
// helpers (hours-sheet.js) — split out only because both need it and Workers'
// module runtime requires every named export of the entry module to be a
// handler, so shared helpers/constants can't live there.

export function normalizeEmail(value) {
  if (typeof value !== 'string') return '';
  var email = value.trim().toLowerCase();
  if (email.length > 254) return '';
  return /^[^\s@,;:<>"]+@[^\s@.,;:<>"]+(\.[^\s@.,;:<>"]+)+$/.test(email) ? email : '';
}
