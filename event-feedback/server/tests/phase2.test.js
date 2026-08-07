const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const tmpDb = path.join(os.tmpdir(), `feedback-phase2-test-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const Database = require('better-sqlite3');
const { migrateFeedbackReports, db, insertFeedback, insertClient, listActiveClients, insertFeedbackRequest, findFeedbackRequestByToken, markFeedbackRequestSubmitted, queryFeedbackByMonth } = require('../db');
const { sixMonthRange } = require('../jobs/sixMonthReport');

function wipe() {
  db.exec('DELETE FROM feedback_requests');
  db.exec('DELETE FROM clients');
  db.exec('DELETE FROM feedback_reports');
}

test.before(async () => wipe());
test.after(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch {}
  }
});

test('insertFeedbackRequest stores a token and findFeedbackRequestByToken looks it up', async () => {
  const client = await insertClient({ name: 'Acme Corp', email: 'billing@acme.com', service_type: 'Branding Package' });
  const token = crypto.randomUUID();

  const { created, row } = await insertFeedbackRequest({ client_id: client.id, month: '2026-08', token });
  assert.strictEqual(created, true);
  assert.strictEqual(row.submitted, 0);
  assert.strictEqual(row.month, '2026-08');

  const found = await findFeedbackRequestByToken(token);
  assert.ok(found, 'token should be found');
  assert.strictEqual(found.id, row.id);
  assert.strictEqual(found.client_id, client.id);

  assert.strictEqual(await findFeedbackRequestByToken('no-such-token'), undefined);

  const marked = await markFeedbackRequestSubmitted(row.id);
  assert.strictEqual(marked, true);
  assert.strictEqual((await findFeedbackRequestByToken(token)).submitted, 1);
});

test('feedback_requests is idempotent per (client, month) — no duplicate row', async () => {
  const client = await insertClient({ name: 'Beta Ltd', email: 'hello@beta.com' });
  const firstToken = crypto.randomUUID();
  const secondToken = crypto.randomUUID();

  const first = await insertFeedbackRequest({ client_id: client.id, month: '2026-09', token: firstToken });
  assert.strictEqual(first.created, true);

  const second = await insertFeedbackRequest({ client_id: client.id, month: '2026-09', token: secondToken });
  assert.strictEqual(second.created, false, 'second insert for same client+month must be skipped');
  assert.strictEqual(second.row.id, first.row.id, 'must return the existing row');

  const rows = db.prepare('SELECT * FROM feedback_requests WHERE client_id = ? AND month = ?').all(client.id, '2026-09');
  assert.strictEqual(rows.length, 1, 'only one row may exist for the same client+month');
  assert.strictEqual(await findFeedbackRequestByToken(secondToken), undefined, 'second token must never be stored');
});

test('listActiveClients returns only active clients', async () => {
  await insertClient({ name: 'Active One', email: 'a@one.com' });
  await insertClient({ name: 'Inactive One', email: 'i@one.com', status: 'inactive' });
  const active = await listActiveClients();
  assert.ok(active.every((c) => c.status === 'active'));
  assert.ok(active.some((c) => c.name === 'Active One'));
  assert.ok(!active.some((c) => c.name === 'Inactive One'));
});

test('sixMonthRange covers the last 6 months including the current month', () => {
  const mid = sixMonthRange(new Date(2026, 7, 15)); // Aug 2026
  assert.strictEqual(mid.fromMonth, '2026-03');
  assert.strictEqual(mid.toMonth, '2026-08');

  const jan = sixMonthRange(new Date(2026, 0, 1)); // Jan 2026 -> Aug 2025
  assert.strictEqual(jan.fromMonth, '2025-08');
  assert.strictEqual(jan.toMonth, '2026-01');

  const dec = sixMonthRange(new Date(2025, 11, 31)); // Dec 2025 -> Jul 2025
  assert.strictEqual(dec.fromMonth, '2025-07');
  assert.strictEqual(dec.toMonth, '2025-12');
});

test('queryFeedbackByMonth filters by YYYY-MM range', async () => {
  const client = await insertClient({ name: 'Gamma Co', email: 'g@co.com' });
  await insertFeedback({
    submissionId: 'FB-TEST1', timestamp: new Date().toISOString(), serviceType: 'Website Revamp',
    month: '2026-04', client_id: client.id, attendeeName: 'Anonymous', attendeeEmail: '', hasValidEmail: 0,
    companyName: '', rating: 4, comments: 'good', suggestions: 'none', sentiment: 'Positive',
    summary: 's', urgency: 'Low', highlights: [], improvementSuggestions: [], pdfUrl: '', emailSent: 0
  });
  await insertFeedback({
    submissionId: 'FB-TEST2', timestamp: new Date().toISOString(), serviceType: 'Website Revamp',
    month: '2026-08', client_id: client.id, attendeeName: 'Anonymous', attendeeEmail: '', hasValidEmail: 0,
    companyName: '', rating: 3, comments: 'ok', suggestions: 'none', sentiment: 'Neutral',
    summary: 's', urgency: 'Low', highlights: [], improvementSuggestions: [], pdfUrl: '', emailSent: 0
  });

  const inRange = await queryFeedbackByMonth({ fromMonth: '2026-03', toMonth: '2026-06' });
  assert.strictEqual(inRange.length, 1);
  assert.strictEqual(inRange[0].submissionId, 'FB-TEST1');
});

test('migrateFeedbackReports renames legacy columns on an old-schema database', () => {
  const oldDb = new Database(':memory:');
  oldDb.exec(`
    CREATE TABLE feedback_reports (
      submissionId TEXT PRIMARY KEY, timestamp TEXT NOT NULL, eventName TEXT NOT NULL,
      eventDate TEXT, attendeeName TEXT, rating INTEGER NOT NULL
    );
    INSERT INTO feedback_reports (submissionId, timestamp, eventName, eventDate, attendeeName, rating)
      VALUES ('FB-OLD1', '2026-08-01T00:00:00.000Z', 'Product Launch 2026', '2026-08-10', 'Jane', 5);
  `);
  migrateFeedbackReports(oldDb);
  const cols = oldDb.prepare('PRAGMA table_info(feedback_reports)').all().map((c) => c.name);
  assert.ok(cols.includes('serviceType'));
  assert.ok(cols.includes('month'));
  assert.ok(cols.includes('client_id'));
  assert.ok(!cols.includes('eventName'));
  assert.ok(!cols.includes('eventDate'));

  const row = oldDb.prepare('SELECT * FROM feedback_reports').get();
  assert.strictEqual(row.serviceType, 'Product Launch 2026');
  assert.strictEqual(row.month, '2026-08-10');
  assert.strictEqual(row.client_id, null);
  oldDb.close();
});

test('analyzeLarge chunks rows and reduces chunk summaries into one result', async () => {
  const gemini = require('../gemini');
  const original = gemini.analyzeCombined;
  gemini.analyzeCombined = async (rows) => ({
    overallSentimentBreakdown: { positive: rows.length, neutral: 0, negative: 0 },
    overallSummary: `summary of ${rows.length} rows`,
    keyHighlights: ['h'],
    topImprovementSuggestions: ['s']
  });
  try {
    delete require.cache[require.resolve('../jobs/sixMonthReport')];
    const { analyzeLarge } = require('../jobs/sixMonthReport');

    const rows = Array.from({ length: 67 }, (_, i) => ({
      eventName: `Svc ${i}`, rating: 5, comments: `comment ${i}`, suggestions: '', sentiment: 'Positive'
    }));

    const result = await analyzeLarge(rows, { apiKey: 'stub-key' });
    assert.ok(result.overallSummary.includes('summary of'));
    assert.strictEqual(result.overallSentimentBreakdown.positive, 67, 'chunk counts must be summed across chunks');
    assert.deepStrictEqual(Object.keys(result).sort(), ['keyHighlights', 'overallSentimentBreakdown', 'overallSummary', 'topImprovementSuggestions'].sort());
  } finally {
    gemini.analyzeCombined = original;
  }
});
