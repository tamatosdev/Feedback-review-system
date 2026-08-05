const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'feedback.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS feedback_reports (
    submissionId          TEXT PRIMARY KEY,
    timestamp             TEXT NOT NULL,
    eventName             TEXT NOT NULL,
    eventDate             TEXT,
    attendeeName          TEXT,
    attendeeEmail         TEXT,
    hasValidEmail         INTEGER DEFAULT 0,
    companyName           TEXT,
    rating                INTEGER NOT NULL,
    comments              TEXT,
    suggestions           TEXT,
    sentiment             TEXT,
    summary               TEXT,
    urgency               TEXT,
    highlights            TEXT,
    improvementSuggestions TEXT,
    pdfUrl                TEXT,
    emailSent             INTEGER DEFAULT 0,
    created_at            TEXT DEFAULT (datetime('now'))
  );
`);

function insertFeedback(row) {
  const stmt = db.prepare(`
    INSERT INTO feedback_reports (
      submissionId, timestamp, eventName, eventDate, attendeeName, attendeeEmail,
      hasValidEmail, companyName, rating, comments, suggestions,
      sentiment, summary, urgency, highlights, improvementSuggestions, pdfUrl, emailSent
    ) VALUES (
      @submissionId, @timestamp, @eventName, @eventDate, @attendeeName, @attendeeEmail,
      @hasValidEmail, @companyName, @rating, @comments, @suggestions,
      @sentiment, @summary, @urgency, @highlights, @improvementSuggestions, @pdfUrl, @emailSent
    )
  `);
  stmt.run({
    ...row,
    hasValidEmail: row.hasValidEmail ? 1 : 0,
    emailSent: row.emailSent ? 1 : 0,
    highlights: JSON.stringify(row.highlights || []),
    improvementSuggestions: JSON.stringify(row.improvementSuggestions || [])
  });
}

function rowToRecord(r) {
  return {
    ...r,
    hasValidEmail: !!r.hasValidEmail,
    emailSent: !!r.emailSent,
    highlights: safeJson(r.highlights, []),
    improvementSuggestions: safeJson(r.improvementSuggestions, [])
  };
}

function safeJson(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function queryFeedback({ from, to, sentiment, eventName } = {}) {
  const where = [];
  const params = {};
  if (from) {
    where.push('substr(eventDate,1,10) >= @from');
    params.from = String(from).slice(0, 10);
  }
  if (to) {
    where.push('substr(eventDate,1,10) <= @to');
    params.to = String(to).slice(0, 10);
  }
  if (sentiment) {
    where.push('sentiment = @sentiment');
    params.sentiment = sentiment;
  }
  if (eventName) {
    where.push('eventName = @eventName');
    params.eventName = eventName;
  }
  const sql = `SELECT * FROM feedback_reports ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY timestamp DESC`;
  return db.prepare(sql).all(params).map(rowToRecord);
}

function stats({ from, to } = {}) {
  const rows = queryFeedback({ from, to });
  const total = rows.length;
  const avgRating = total ? rows.reduce((s, r) => s + r.rating, 0) / total : 0;
  const sentimentCounts = { Positive: 0, Neutral: 0, Negative: 0 };
  let highUrgency = 0;
  const events = new Set();
  for (const r of rows) {
    if (sentimentCounts[r.sentiment] !== undefined) sentimentCounts[r.sentiment]++;
    if (r.urgency === 'High') highUrgency++;
    events.add(r.eventName);
  }
  return {
    total,
    avgRating: Math.round(avgRating * 100) / 100,
    sentimentCounts,
    highUrgency,
    events: [...events].sort(),
    from: from || null,
    to: to || null
  };
}

module.exports = { db, insertFeedback, queryFeedback, stats, rowToRecord };
