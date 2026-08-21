const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

process.env.DB_PATH = path.join(os.tmpdir(), `feedback-report-test-${process.pid}.db`);
process.env.DATABASE_URL = '';
process.env.STORAGE_DRIVER = 'memory';

const {
  db,
  insertClient,
  insertFeedbackRequest,
  insertFeedback,
  getFeedbackReport,
  queryFeedback
} = require('../db');
const { reportHTML, combinedHTML } = require('../report');
const app = require('../index.js');

function submitBody(overrides = {}) {
  return {
    attendeeName: 'Tester',
    attendeeEmail: 'tester@example.com',
    accountManagementScore: 5,
    strategyScore: 4,
    creativeScore: 3,
    designContentScore: 4,
    socialContentScore: 5,
    agencyLeadershipScore: 4,
    comments: 'nice',
    suggestions: '',
    ...overrides
  };
}

function validReportRow(overrides = {}) {
  return {
    submissionId: 'FB-REPORT-' + crypto.randomBytes(3).toString('hex').toUpperCase(),
    timestamp: new Date().toISOString(),
    serviceType: 'Website Revamp',
    month: '2026-08',
    client_id: null,
    attendeeName: 'Tester',
    attendeeEmail: 'tester@example.com',
    hasValidEmail: 1,
    companyName: 'Acme Co',
    rating: 4,
    accountManagementScore: 5,
    strategyScore: 4,
    creativeScore: 3,
    designContentScore: 4,
    socialContentScore: 5,
    agencyLeadershipScore: 4,
    comments: 'good work',
    suggestions: null,
    sentiment: 'Positive',
    summary: 'Solid feedback',
    urgency: 'Low',
    highlights: ['a'],
    improvementSuggestions: ['b'],
    pdfUrl: '',
    emailSent: 0,
    ...overrides
  };
}

test.before(async () => {
  db.exec('DELETE FROM feedback_requests');
  db.exec('DELETE FROM clients');
  db.exec('DELETE FROM feedback_reports');
});

test.after(async () => {
  await app.flushBackground();
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { require('fs').unlinkSync(process.env.DB_PATH + suffix); } catch {}
  }
});

test('reportHTML renders serviceType/month from a DB row (no literal "undefined")', async () => {
  const row = validReportRow();
  await insertFeedback(row);
  const record = await getFeedbackReport(row.submissionId);

  // The stored fields are serviceType / month, NOT eventName / eventDate.
  assert.strictEqual(record.serviceType, 'Website Revamp');
  assert.strictEqual(record.month, '2026-08');
  assert.strictEqual(record.eventName, undefined, 'DB row must NOT carry the legacy eventName field');

  const html = reportHTML(record);
  assert.ok(html.includes('Website Revamp'), 'service name should come from serviceType');
  assert.ok(html.includes('2026-08'), 'service date should come from month');
  assert.ok(!html.includes('undefined'), 'must never render literal "undefined"');
  assert.ok(!html.includes('Not provided'), 'present date must not show "Not provided"');
});

test('reportHTML falls back to N/A for a genuinely missing service name / date', async () => {
  // A DB-row-shaped object with no service name and a null month (month is the
  // one field that can legitimately be null). The template must never render
  // the literal string "undefined" for either.
  const record = {
    submissionId: 'FB-MISSING',
    timestamp: new Date().toISOString(),
    serviceType: undefined,
    month: null,
    attendeeName: 'Tester',
    attendeeEmail: 'tester@example.com',
    hasValidEmail: 1,
    companyName: 'Acme Co',
    rating: 4,
    comments: 'good work',
    sentiment: 'Positive',
    summary: 'Solid feedback',
    urgency: 'Low',
    highlights: ['a'],
    improvementSuggestions: ['b']
  };

  const html = reportHTML(record);
  assert.ok(html.includes('N/A'), 'missing service name / date must fall back to N/A');
  assert.ok(!html.includes('undefined'), 'must never render literal "undefined"');

  // The date column can be truly null in the DB — verify that path too.
  const nullDateRow = validReportRow({ month: null });
  await insertFeedback(nullDateRow);
  const fromDb = await getFeedbackReport(nullDateRow.submissionId);
  const dbHtml = reportHTML(fromDb);
  assert.ok(dbHtml.includes('N/A'), 'null month must fall back to N/A');
  assert.ok(!dbHtml.includes('undefined'));
});

test('combinedHTML shows serviceType from DB rows (no literal "undefined")', async () => {
  const rows = [validReportRow(), validReportRow({ submissionId: 'FB-COMB-2', serviceType: 'SEO Retainer', month: '2026-07' })];
  for (const r of rows) await insertFeedback(r);
  const records = await queryFeedback();
  const meta = {
    from: '2026-07', to: '2026-08', generatedAt: new Date().toISOString(),
    overallSummary: 'summary', overallSentimentBreakdown: { positive: 1, neutral: 1, negative: 0 },
    keyHighlights: [], topImprovementSuggestions: []
  };
  const html = combinedHTML(meta, records, null);
  assert.ok(html.includes('Website Revamp'), 'first service shown');
  assert.ok(html.includes('SEO Retainer'), 'second service shown');
  assert.ok(!html.includes('undefined'), 'combined must never render literal "undefined"');
});

test('on-demand report for a tokenized submission shows client service_type and request month', async () => {
  const client = await insertClient({ name: 'Report Co', email: 'report@co.com', service_type: 'Branding Package' });
  const token = crypto.randomUUID();
  await insertFeedbackRequest({ client_id: client.id, month: '2026-09', token });

  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(submitBody({ token }))
    });
    assert.strictEqual(res.status, 201);
    const json = await res.json();
    await app.flushBackground();

    // Fetch the report on demand (regenerated from the DB row).
    const repRes = await fetch(`${base}/reports/${json.submissionId}.html`);
    assert.strictEqual(repRes.status, 200);
    const repHtml = await repRes.text();
    assert.ok(repHtml.includes('Branding Package'), 'service name should come from the linked client record');
    assert.ok(repHtml.includes('2026-09'), 'service date should come from the feedback request month');
    assert.ok(!repHtml.includes('undefined'), 'must never render literal "undefined"');
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    server.close();
  }
});
