const path = require('path');
const fs = require('fs');

const DATABASE_URL = process.env.DATABASE_URL || '';
const PG_MODE = !!DATABASE_URL;

let db = null;
let pool = null;
let schemaReady = null;

// Column-name normalization: Postgres folds unquoted identifiers to lowercase,
// SQLite preserves them. Map lowercase -> canonical camelCase so both modes
// return identical row objects to the rest of the app.
const COLUMN_ALIASES = {
  id: 'id',
  name: 'name',
  email: 'email',
  status: 'status',
  month: 'month',
  token: 'token',
  timestamp: 'timestamp',
  rating: 'rating',
  comments: 'comments',
  suggestions: 'suggestions',
  sentiment: 'sentiment',
  summary: 'summary',
  urgency: 'urgency',
  highlights: 'highlights',
  count: 'count',
  submissionid: 'submissionId',
  servicetype: 'serviceType',
  client_id: 'client_id',
  attendeename: 'attendeeName',
  attendeemail: 'attendeeEmail',
  hasvalidemail: 'hasValidEmail',
  companyname: 'companyName',
  improvementsuggestions: 'improvementSuggestions',
  pdfurl: 'pdfUrl',
  emailsent: 'emailSent',
  created_at: 'created_at',
  company_name: 'company_name',
  service_type: 'service_type',
  sent_at: 'sent_at',
  submitted: 'submitted'
};

function normalizeRow(row) {
  if (!row) return row;
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[COLUMN_ALIASES[key.toLowerCase()] || key] = value;
  }
  return out;
}

// ---------- Local mode: better-sqlite3 ----------
if (!PG_MODE) {
  const Database = require('better-sqlite3');
  const dataDir = path.join(__dirname, '..', 'data');
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  } catch (err) {
    // Read-only FS (e.g. Vercel serverless) — only matters when DB_PATH
    // points somewhere writable; the /tmp fallback below is used instead.
  }

  // Vercel serverless: default DB_PATH is unwritable -> fall back to /tmp
  // (ephemeral! use DATABASE_URL for persistence on Vercel).
  const dbPath = process.env.DB_PATH
    ? path.isAbsolute(process.env.DB_PATH)
      ? process.env.DB_PATH
      : path.resolve(__dirname, '..', process.env.DB_PATH)
    : process.env.VERCEL
      ? '/tmp/feedback.db'
      : path.join(dataDir, 'feedback.db');
  try {
    if (!fs.existsSync(path.dirname(dbPath))) fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  } catch (err) {
    console.warn('[db] could not create DB directory:', err.message);
  }

  db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
  } catch (err) {
    console.warn('[db] WAL pragma failed:', err.message);
  }
}

// ---------- Remote mode: Postgres (Neon / Supabase / RDS) ----------
if (PG_MODE) {
  const { Pool } = require('pg');
  const sslMode = /sslmode=([^&]+)/.exec(DATABASE_URL)?.[1];
  const isLocalHost = /localhost|127\.0\.0\.1/.test(DATABASE_URL);
  const ssl = sslMode ? sslMode === 'disable' ? false : { rejectUnauthorized: false }
    : isLocalHost ? false : { rejectUnauthorized: false };
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl,
    max: 5,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000
  });
  pool.on('error', (err) => console.error('[db] Postgres pool error:', err.message));
}

const ID_TYPE = PG_MODE ? 'SERIAL' : 'INTEGER PRIMARY KEY AUTOINCREMENT';

const SCHEMA_SQL = `
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
    created_at            TEXT
  );

  CREATE TABLE IF NOT EXISTS clients (
    id             ${ID_TYPE},
    name           TEXT NOT NULL,
    email          TEXT NOT NULL,
    company_name   TEXT,
    service_type   TEXT,
    status         TEXT NOT NULL DEFAULT 'active',
    created_at     TEXT
  );

  CREATE TABLE IF NOT EXISTS feedback_requests (
    id         ${ID_TYPE},
    client_id  INTEGER NOT NULL REFERENCES clients(id),
    month      TEXT NOT NULL,
    token      TEXT NOT NULL UNIQUE,
    sent_at    TEXT,
    submitted  INTEGER DEFAULT 0,
    UNIQUE (client_id, month)
  );
`;

async function migrateRemote() {
  const tables = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
  const names = new Set(tables.rows.map((t) => String(t.table_name || '').toLowerCase()));
  if (!names.has('feedback_reports')) return;

  const cols = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'feedback_reports'");
  const colNames = new Set(cols.rows.map((c) => String(c.column_name || '').toLowerCase()));
  if (colNames.has('eventname') && !colNames.has('servicetype')) {
    await pool.query('ALTER TABLE feedback_reports RENAME COLUMN eventname TO servicetype');
  }
  if (colNames.has('eventdate') && !colNames.has('month')) {
    await pool.query('ALTER TABLE feedback_reports RENAME COLUMN eventdate TO month');
  }
  const finalCols = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'feedback_reports'");
  if (!finalCols.rows.some((c) => String(c.column_name || '').toLowerCase() === 'client_id')) {
    await pool.query('ALTER TABLE feedback_reports ADD COLUMN client_id INTEGER REFERENCES clients(id)');
  }
}

function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      if (PG_MODE) {
        // Schema init talks to the pool directly — never through run()/
        // allRows(), which await ensureSchema() (that would be a circular
        // await on the in-flight promise).
        await pool.query(SCHEMA_SQL);
        await migrateRemote();
      } else {
        db.exec(SCHEMA_SQL);
        migrateFeedbackReports(db);
      }
    })();
    schemaReady.catch((err) => {
      // Never let an async schema failure crash the process (unhandled
      // rejection kills the function on Vercel); reset so the next request
      // retries and returns a proper JSON error instead of a crash page.
      console.error('[db] schema init failed:', err.code || err.message || err);
      schemaReady = null;
    });
  }
  return schemaReady;
}

function dbMode() {
  return PG_MODE ? 'postgres' : 'sqlite';
}

function dbHost() {
  if (!PG_MODE) return null;
  try {
    return new URL(DATABASE_URL).hostname;
  } catch {
    return 'unparsable';
  }
}

async function pingDb() {
  try {
    await ensureSchema();
    if (PG_MODE) {
      await pool.query('SELECT 1');
      return { mode: 'postgres', ok: true, host: dbHost() };
    }
    db.prepare('SELECT 1').get();
    return { mode: 'sqlite', ok: true };
  } catch (err) {
    throw new Error(`Database error (${err.code || 'unknown'}): ${err.message || 'see server logs'} (host: ${dbHost() || 'n/a'})`);
  }
}

// Convert ? placeholders to pg's $1..$n (sqlite accepts ? natively).
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function allRows(sql, args = []) {
  await ensureSchema();
  if (PG_MODE) {
    const result = await pool.query(toPg(sql), args);
    return result.rows.map(normalizeRow);
  }
  return db.prepare(sql).all(...args).map(normalizeRow);
}

async function getRow(sql, args = []) {
  await ensureSchema();
  if (PG_MODE) {
    const result = await pool.query(toPg(sql), args);
    return normalizeRow(result.rows[0]);
  }
  return normalizeRow(db.prepare(sql).get(...args));
}

async function run(sql, args = []) {
  await ensureSchema();
  if (PG_MODE) {
    const result = await pool.query(toPg(sql), args);
    return { changes: result.rowCount };
  }
  return db.prepare(sql).run(...args);
}

async function runReturning(sql, args = []) {
  await ensureSchema();
  if (PG_MODE) {
    const result = await pool.query(toPg(sql), args);
    return normalizeRow(result.rows[0]);
  }
  return normalizeRow(db.prepare(sql).get(...args));
}

/**
 * Legacy-schema migration for local SQLite databases: renames eventName/
 * eventDate columns to serviceType/month and adds client_id. Idempotent.
 * Accepts a better-sqlite3 handle for tests; defaults to the local db.
 */
function migrateFeedbackReports(dbHandle = db) {
  if (!dbHandle || PG_MODE) return;  const cols = dbHandle.prepare('PRAGMA table_info(feedback_reports)').all().map((c) => c.name);
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

async function insertFeedback(row) {
  await run(`
    INSERT INTO feedback_reports (
      submissionId, timestamp, serviceType, month, client_id, attendeeName, attendeeEmail,
      hasValidEmail, companyName, rating, comments, suggestions,
      sentiment, summary, urgency, highlights, improvementSuggestions, pdfUrl, emailSent, created_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `, [
    row.submissionId, row.timestamp, row.serviceType, row.month ?? null, row.client_id ?? null,
    row.attendeeName, row.attendeeEmail, row.hasValidEmail ? 1 : 0, row.companyName, row.rating,
    row.comments, row.suggestions, row.sentiment, row.summary, row.urgency,
    JSON.stringify(row.highlights || []), JSON.stringify(row.improvementSuggestions || []),
    row.pdfUrl ?? '', row.emailSent ? 1 : 0, new Date().toISOString()
  ]);
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

async function queryFeedback({ from, to, sentiment, serviceType, eventName } = {}) {
  const where = [];
  const params = [];
  if (from) {
    where.push('substr(month,1,10) >= ?');
    params.push(String(from).slice(0, 10));
  }
  if (to) {
    where.push('substr(month,1,10) <= ?');
    params.push(String(to).slice(0, 10));
  }
  if (sentiment) {
    where.push('sentiment = ?');
    params.push(sentiment);
  }
  const service = serviceType || eventName;
  if (service) {
    where.push('serviceType = ?');
    params.push(service);
  }
  const sql = `SELECT * FROM feedback_reports ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY timestamp DESC`;
  const rows = await allRows(sql, params);
  return rows.map(rowToRecord);
}

async function queryFeedbackByMonth({ fromMonth, toMonth } = {}) {
  const where = [];
  const params = [];
  if (fromMonth) {
    where.push('substr(month,1,7) >= ?');
    params.push(String(fromMonth).slice(0, 7));
  }
  if (toMonth) {
    where.push('substr(month,1,7) <= ?');
    params.push(String(toMonth).slice(0, 7));
  }
  const sql = `SELECT * FROM feedback_reports ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY timestamp DESC`;
  const rows = await allRows(sql, params);
  return rows.map(rowToRecord);
}

async function stats({ from, to } = {}) {
  const rows = await queryFeedback({ from, to });
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

async function insertClient({ name, email, company_name = '', service_type = '', status = 'active' }) {
  return runReturning(`
    INSERT INTO clients (name, email, company_name, service_type, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    RETURNING *
  `, [
    String(name || '').trim(),
    String(email || '').trim(),
    String(company_name || '').trim(),
    String(service_type || '').trim(),
    status === 'inactive' ? 'inactive' : 'active',
    new Date().toISOString()
  ]);
}

async function getClient(id) {
  return getRow('SELECT * FROM clients WHERE id = ?', [id]);
}

async function listActiveClients() {
  return allRows("SELECT * FROM clients WHERE status = 'active' ORDER BY id", []);
}

async function listClients() {
  return allRows('SELECT * FROM clients ORDER BY id DESC', []);
}

async function listClientEmails() {
  const rows = await allRows('SELECT lower(email) AS email FROM clients', []);
  return rows.map((r) => r.email);
}

async function updateClientStatus(id, status) {
  const row = await runReturning('UPDATE clients SET status = ? WHERE id = ? RETURNING *', [status, id]);
  return row || null;
}

async function upsertClientByEmail({ name, email, company_name = '', service_type = '', status = 'active' }) {
  const existing = await getRow('SELECT * FROM clients WHERE lower(email) = lower(?)', [email]);
  if (existing) {
    const row = await runReturning(
      'UPDATE clients SET name = ?, company_name = ?, service_type = ?, status = ? WHERE id = ? RETURNING *',
      [name, company_name, service_type, status, existing.id]
    );
    return { action: 'updated', row };
  }
  return { action: 'inserted', row: await insertClient({ name, email, company_name, service_type, status }) };
}

async function deleteClient(id) {
  const info = await run('DELETE FROM feedback_requests WHERE client_id = ?', [id]);
  const removedRequests = info.changes;
  const deletedInfo = await run('DELETE FROM clients WHERE id = ?', [id]);
  return { deleted: deletedInfo.changes > 0, removedRequests };
}

// ---------- Feedback requests (monthly token sends) ----------

async function insertFeedbackRequest({ client_id, month, token }) {
  const monthKey = String(month).slice(0, 7);
  const existing = await getRow('SELECT * FROM feedback_requests WHERE client_id = ? AND month = ?', [client_id, monthKey]);
  if (existing) return { created: false, row: existing };

  const row = await runReturning(`
    INSERT INTO feedback_requests (client_id, month, token, sent_at, submitted)
    VALUES (?, ?, ?, ?, 0)
    RETURNING *
  `, [client_id, monthKey, String(token), new Date().toISOString()]);
  return { created: true, row };
}

async function findFeedbackRequestByToken(token) {
  return getRow('SELECT * FROM feedback_requests WHERE token = ?', [String(token || '')]);
}

async function markFeedbackRequestSubmitted(id) {
  const info = await run('UPDATE feedback_requests SET submitted = 1 WHERE id = ?', [id]);
  return info.changes > 0;
}

// Eager schema setup at module load (synchronous for local SQLite; the
// resolved promise is shared with every subsequent query). Failures are
// caught and retried per-request — they never crash the process.
ensureSchema();

module.exports = {
  db,
  dbMode,
  dbHost,
  pingDb,
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
