const crypto = require('crypto');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The six rated questionnaire questions, each mapped to a department
// (Internal Owner). Key = form field, label = department shown to clients.
const SCORE_FIELDS = [
  ['accountManagementScore', 'Account Management'],
  ['strategyScore', 'Strategy'],
  ['creativeScore', 'Creative'],
  ['designContentScore', 'Design & Content Production'],
  ['socialContentScore', 'Social & Content'],
  ['agencyLeadershipScore', 'Agency Leadership']
];

function cleanString(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const trimmed = String(value).trim();
  return trimmed.length ? trimmed : fallback;
}

// Strict 1-5 integer score for a required department rating. Returns null
// when missing or invalid (validation rejects those — no silent default).
function cleanScore(value) {
  const n = Number(value);
  if (Number.isInteger(n) && n >= 1 && n <= 5) return n;
  return null;
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
 * - ALL SIX department scores required, each an integer 1-5; throws a clear
 *   ValidationError (err.status = 400) when any is missing or invalid
 * - rating (legacy column) is set equal to agencyLeadershipScore (the
 *   "overall" question) for backward compatibility
 * - adds submissionId + timestamp (ISO)
 */
function cleanData(raw = {}) {
  const attendeeEmail = cleanString(raw.attendeeEmail, '');
  const hasValidEmail = EMAIL_RE.test(attendeeEmail);

  const scores = {};
  const missing = [];
  for (const [key, label] of SCORE_FIELDS) {
    const value = cleanScore(raw[key]);
    if (value === null) missing.push(label);
    scores[key] = value;
  }
  if (missing.length) {
    const err = new Error(
      `Missing or invalid required rating for: ${missing.join(', ')}. ` +
      'All six department ratings are required and each must be a whole number from 1 to 5 (1 = Very Poor, 2 = Poor, 3 = Satisfactory, 4 = Good, 5 = Excellent).'
    );
    err.status = 400;
    err.validation = { missing };
    throw err;
  }

  return {
    submissionId: makeSubmissionId(),
    timestamp: new Date().toISOString(),
    eventName: cleanString(raw.eventName, 'Unnamed Event'),
    eventDate: cleanString(raw.eventDate, ''),
    attendeeName: cleanString(raw.attendeeName, 'Anonymous'),
    attendeeEmail,
    hasValidEmail,
    companyName: cleanString(raw.companyName, ''),
    ...scores,
    rating: scores.agencyLeadershipScore,
    comments: cleanString(raw.comments, 'No comments provided'),
    suggestions: cleanString(raw.suggestions, 'No suggestions provided')
  };
}

module.exports = { cleanData, cleanString, cleanScore, makeSubmissionId, EMAIL_RE, SCORE_FIELDS };
