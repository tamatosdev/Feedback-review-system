const crypto = require('crypto');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanString(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const trimmed = String(value).trim();
  return trimmed.length ? trimmed : fallback;
}

function cleanRating(value) {
  const n = Number(value);
  if (Number.isInteger(n) && n >= 1 && n <= 5) return n;
  return 3;
}

function makeSubmissionId() {
  const stamp = Date.now().toString(36).toUpperCase();
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
  return 'FB-' + stamp + rand;
}

/**
 * Cleans and normalizes raw form data per spec:
 * - trims strings
 * - default attendee name -> "Anonymous"
 * - invalid email -> hasValidEmail = false
 * - empty comments/suggestions -> defaults
 * - adds submissionId + timestamp (ISO)
 */
function cleanData(raw = {}) {
  const attendeeEmail = cleanString(raw.attendeeEmail, '');
  const hasValidEmail = EMAIL_RE.test(attendeeEmail);

  return {
    submissionId: makeSubmissionId(),
    timestamp: new Date().toISOString(),
    eventName: cleanString(raw.eventName, 'Unnamed Event'),
    eventDate: cleanString(raw.eventDate, ''),
    attendeeName: cleanString(raw.attendeeName, 'Anonymous'),
    attendeeEmail,
    hasValidEmail,
    companyName: cleanString(raw.companyName, ''),
    rating: cleanRating(raw.rating),
    comments: cleanString(raw.comments, 'No comments provided'),
    suggestions: cleanString(raw.suggestions, 'No suggestions provided')
  };
}

module.exports = { cleanData, cleanString, cleanRating, makeSubmissionId, EMAIL_RE };
