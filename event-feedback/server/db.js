const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = process.env.DB_PATH
  ? path.isAbsolute(process.env.DB_PATH)
    ? process.env.DB_PATH
    : path.resolve(__dirname, '..', process.env.DB_PATH)
  : path.join(dataDir, 'feedback.db');
if (!fs.existsSync(path.dirname(dbPath))) fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS feedback_reports (
    submissionId          TEXT PRIMARY KEY,
    timestamp             TEXT NOT NULL,
    serviceType           TEXT NOT NULL,
    month                 TEXT,
    client_id             INTEGER REFERENCES clients(id),
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

  CREATE TABLE IF NOT EXISTS clients (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT NOT NULL,
    email          TEXT NOT NULL,
    company_name   TEXT,
    service_type   TEXT,
    status         TEXT NOT NULL DEFAULT 'active',
    created_at     TEXT
  );

  CREATE TABLE IF NOT EXISTS feedback_requests (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id  INTEGER NOT NULL REFERENCES clients(id),
    month      TEXT NOT NULL,
    token      TEXT NOT NULL UNIQUE,
    sent_at    TEXT,
    submitted  INTEGER DEFAULT 0,
    UNIQUE (client_id, month)
  );
`);

/**
 * Phase 2 migration: renames legacy eventName/eventDate columns to
 * serviceType/month and adds client_id. Idempotent — runs against old
 * schemas only; fresh databases already use the new column names.
 */
function migrateFeedbackReports(dbHandle = db) {
  const cols = dbHandle.prepare('PRAGMA table_info(feedback_reports)').all().map((c) => c.name);
  if (cols.includes('eventName') && !cols.includes('serviceType')) {
    dbHandle.exec('ALTER TABLE feedback_reports RENAME COLUMN eventName TO serviceType');
  }
  if (cols.includes('eventDate') && !cols.includes('month')) {
    dbHandle.exec('ALTER TABLE feedback_reports RENAME COLUMN eventDate TO month');
  }
  const finalCols = dbHandle.prepare('PRAGMA table_info(feedback_reports)').all().map((c) => c.name);
  if (!finalCols.includes('client_id')) {
    dbHandle.exec('ALTER TABLE feedback_reports ADD COLUMN client_id INTEGER REFERENCES clients(id)');
  }
}

migrateFeedbackReports();

function insertFeedback(row) {
  const stmt = db.prepare(`
    INSERT INTO feedback_reports (
      submissionId, timestamp, serviceType, month, client_id, attendeeName, attendeeEmail,
      hasValidEmail, companyName, rating, comments, suggestions,
      sentiment, summary, urgency, highlights, improvementSuggestions, pdfUrl, emailSent
    ) VALUES (
      @submissionId, @timestamp, @serviceType, @month, @client_id, @attendeeName, @attendeeEmail,
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

function queryFeedback({ from, to, sentiment, serviceType, eventName } = {}) {
  const where = [];
  const params = {};
  if (from) {
    where.push('substr(month,1,10) >= @from');
    params.from = String(from).slice(0, 10);
  }
  if (to) {
    where.push('substr(month,1,10) <= @to');
    params.to = String(to).slice(0, 10);
  }
  if (sentiment) {
    where.push('sentiment = @sentiment');
    params.sentiment = sentiment;
  }
  const service = serviceType || eventName;
  if (service) {
    where.push('serviceType = @service');
    params.service = service;
  }
  const sql = `SELECT * FROM feedback_reports ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY timestamp DESC`;
  return db.prepare(sql).all(params).map(rowToRecord);
}

function queryFeedbackByMonth({ fromMonth, toMonth } = {}) {
  const where = [];
  const params = {};
  if (fromMonth) {
    where.push('substr(month,1,7) >= @fromMonth');
    params.fromMonth = String(fromMonth).slice(0, 7);
  }
  if (toMonth) {
    where.push('substr(month,1,7) <= @toMonth');
    params.toMonth = String(toMonth).slice(0, 7);
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
    events.add(r.serviceType);
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

// ---------- Clients ----------

function insertClient({ name, email, company_name = '', service_type = '', status = 'active' }) {
  const stmt = db.prepare(`
    INSERT INTO clients (name, email, company_name, service_type, status, created_at)
    VALUES (@name, @email, @company_name, @service_type, @status, @created_at)
  `);
  const info = stmt.run({
    name: String(name || '').trim(),
    email: String(email || '').trim(),
    company_name: String(company_name || '').trim(),
    service_type: String(service_type || '').trim(),
    status: status === 'inactive' ? 'inactive' : 'active',
    created_at: new Date().toISOString()
  });
  return db.prepare('SELECT * FROM clients WHERE id = ?').get(info.lastInsertRowid);
}

function getClient(id) {
  return db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
}

function listActiveClients() {
  return db.prepare("SELECT * FROM clients WHERE status = 'active' ORDER BY id").all();
}

function listClients() {
  return db.prepare('SELECT * FROM clients ORDER BY id DESC').all();
}

function listClientEmails() {
  return db.prepare('SELECT lower(email) AS email FROM clients').all().map((r) => r.email);
}

function updateClientStatus(id, status) {
  const info = db.prepare('UPDATE clients SET status = @status WHERE id = @id').run({ id, status });
  if (!info.changes) return null;
  return getClient(id);
}

function upsertClientByEmail({ name, email, company_name = '', service_type = '', status = 'active' }) {
  const existing = db.prepare('SELECT * FROM clients WHERE lower(email) = lower(?)').get(email);
  if (existing) {
    db.prepare('UPDATE clients SET name = @name, company_name = @company_name, service_type = @service_type, status = @status WHERE id = @id')
      .run({ id: existing.id, name, email, company_name, service_type, status });
    return { action: 'updated', row: getClient(existing.id) };
  }
  return { action: 'inserted', row: insertClient({ name, email, company_name, service_type, status }) };
}

function deleteClient(id) {
  const removedRequests = db.prepare('DELETE FROM feedback_requests WHERE client_id = ?').run(id).changes;
  const info = db.prepare('DELETE FROM clients WHERE id = ?').run(id);
  return { deleted: info.changes > 0, removedRequests };
}

// ---------- Feedback requests (monthly token sends) ----------

function insertFeedbackRequest({ client_id, month, token }) {
  const existing = db.prepare('SELECT * FROM feedback_requests WHERE client_id = ? AND month = ?')
    .get(client_id, String(month).slice(0, 7));
  if (existing) return { created: false, row: existing };

  const stmt = db.prepare(`
    INSERT INTO feedback_requests (client_id, month, token, sent_at, submitted)
    VALUES (@client_id, @month, @token, @sent_at, 0)
  `);
  const info = stmt.run({
    client_id,
    month: String(month).slice(0, 7),
    token: String(token),
    sent_at: new Date().toISOString()
  });
  return { created: true, row: db.prepare('SELECT * FROM feedback_requests WHERE id = ?').get(info.lastInsertRowid) };
}

function findFeedbackRequestByToken(token) {
  return db.prepare('SELECT * FROM feedback_requests WHERE token = ?').get(String(token || ''));
}

function markFeedbackRequestSubmitted(id) {
  return db.prepare('UPDATE feedback_requests SET submitted = 1 WHERE id = ?').run(id).changes > 0;
}

module.exports = {
  db,
  migrateFeedbackReports,
  insertFeedback,
  queryFeedback,
  queryFeedbackByMonth,
  stats,
  rowToRecord,
  insertClient,
  getClient,
  listActiveClients,
  listClients,
  listClientEmails,
  updateClientStatus,
  upsertClientByEmail,
  deleteClient,
  insertFeedbackRequest,
  findFeedbackRequestByToken,
  markFeedbackRequestSubmitted
};
