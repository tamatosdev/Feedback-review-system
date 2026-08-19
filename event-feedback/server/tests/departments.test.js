const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Force local SQLite + in-memory report storage before anything is required
// (dotenv must not flip us into Postgres/Supabase mode).
process.env.DB_PATH = path.join(os.tmpdir(), `feedback-departments-test-${process.pid}.db`);
process.env.DATABASE_URL = '';
process.env.STORAGE_DRIVER = 'memory';

const { db, insertFeedback, getFeedbackReport, queryFeedback, insertClient, updateClientAccountManager, upsertClientByEmail, getClient } = require('../db');
const { reportHTML, combinedHTML } = require('../report');
const { buildPdf } = require('../pdf');
const { feedbackEmailBody } = require('../email');
const app = require('../index.js');

const SCORES = {
  accountManagementScore: 5,
  strategyScore: 4,
  creativeScore: 3,
  designContentScore: 2,
  socialContentScore: 4,
  agencyLeadershipScore: 5
};

function makeRow(overrides = {}) {
  return {
    submissionId: 'FB-DEPT1',
    timestamp: new Date().toISOString(),
    serviceType: 'Branding Package',
    month: '2026-08',
    client_id: null,
    attendeeName: 'Anonymous',
    attendeeEmail: '',
    hasValidEmail: 0,
    companyName: 'Acme',
    rating: 5,
    comments: 'Great work',
    suggestions: 'Keep it up',
    sentiment: 'Positive',
    summary: 's',
    urgency: 'Low',
    highlights: [],
    improvementSuggestions: [],
    pdfUrl: '',
    emailSent: 0,
    ...SCORES,
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
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch {}
  }
});

test('insertFeedback stores all six department scores; rating equals agencyLeadershipScore', async () => {
  await insertFeedback(makeRow({ submissionId: 'FB-DEPT1' }));
  const row = await getFeedbackReport('FB-DEPT1');
  assert.ok(row, 'row should be found');
  assert.strictEqual(row.accountManagementScore, 5);
  assert.strictEqual(row.strategyScore, 4);
  assert.strictEqual(row.creativeScore, 3);
  assert.strictEqual(row.designContentScore, 2);
  assert.strictEqual(row.socialContentScore, 4);
  assert.strictEqual(row.agencyLeadershipScore, 5);
  assert.strictEqual(row.rating, row.agencyLeadershipScore);
});

test('legacy rows (rating only) store null department scores without crashing', async () => {
  await insertFeedback({
    submissionId: 'FB-OLD9',
    timestamp: new Date().toISOString(),
    serviceType: 'Legacy Service',
    month: '2025-01',
    client_id: null,
    attendeeName: 'Old Client',
    attendeeEmail: '',
    hasValidEmail: 0,
    companyName: '',
    rating: 3,
    comments: 'old comment',
    suggestions: 'none',
    sentiment: 'Neutral',
    summary: 'old',
    urgency: 'Medium',
    highlights: [],
    improvementSuggestions: [],
    pdfUrl: '',
    emailSent: 0
  });
  const rows = await queryFeedback();
  const old = rows.find((r) => r.submissionId === 'FB-OLD9');
  assert.ok(old, 'legacy row present');
  assert.strictEqual(old.rating, 3);
  for (const key of Object.keys(SCORES)) {
    assert.strictEqual(old[key], null);
  }
});

test('reportHTML lists all six department scores and shows N/A for legacy rows', () => {
  const html = reportHTML(makeRow({ submissionId: 'FB-DEPT1' }), null);
  for (const [key, label] of [['accountManagementScore', 'Account Management'], ['strategyScore', 'Strategy'], ['creativeScore', 'Creative'], ['designContentScore', 'Design &amp; Content Production'], ['socialContentScore', 'Social &amp; Content'], ['agencyLeadershipScore', 'Agency Leadership (Overall)']]) {
    assert.ok(html.includes(label), `report should include ${label}`);
  }
  assert.ok(html.includes('5 / 5'), 'scores shown as n / 5');
  assert.ok(html.includes('4 / 5'));
  assert.ok(html.includes('2 / 5'));
  assert.ok(html.includes('Agency Leadership (Overall)') && html.includes('5 / 5'));

  const oldHtml = reportHTML(makeRow({ submissionId: 'FB-OLD9', ...Object.fromEntries(Object.keys(SCORES).map((k) => [k, null])) }), null);
  assert.strictEqual((oldHtml.match(/N\/A/g) || []).length, 6, 'legacy row shows N/A for all six departments');
});

test('combinedHTML includes department scores line for new rows only', () => {
  const meta = { from: '2026-08', to: '2026-08', generatedAt: new Date().toISOString(), overallSummary: 's', overallSentimentBreakdown: { positive: 1, neutral: 0, negative: 0 }, keyHighlights: ['h'], topImprovementSuggestions: ['i'] };
  const newRow = makeRow({ submissionId: 'FB-DEPT1' });
  const oldRow = makeRow({ submissionId: 'FB-OLD9', ...Object.fromEntries(Object.keys(SCORES).map((k) => [k, null])) });
  const html = combinedHTML(meta, [newRow, oldRow], null);
  assert.ok(html.includes('Account Management: 5 / 5'));
  assert.ok(html.includes('Social &amp; Content: 4 / 5'));
  assert.strictEqual((html.match(/Account Management: 5 \/ 5/g) || []).length, 1, 'only the new row gets a scores line');
  assert.ok(!html.includes('N/A'), 'legacy rows simply omit the scores line');
});

test('buildPdf renders both new and legacy records', async () => {
  const newBuf = await buildPdf(makeRow({ submissionId: 'FB-DEPT1' }));
  assert.ok(newBuf.length > 1000, 'new record PDF should be non-trivial');
  const oldBuf = await buildPdf(makeRow({ submissionId: 'FB-OLD9', ...Object.fromEntries(Object.keys(SCORES).map((k) => [k, null])) }));
  assert.ok(oldBuf.length > 1000, 'legacy record PDF should render without crashing');
});

test('feedbackEmailBody includes all six department scores', () => {
  const body = feedbackEmailBody(makeRow({ submissionId: 'FB-DEPT1' }), 'http://x/pdf');
  assert.ok(body.includes('  Account Management: 5 / 5'));
  assert.ok(body.includes('  Strategy: 4 / 5'));
  assert.ok(body.includes('  Agency Leadership (Overall): 5 / 5'));
  const oldBody = feedbackEmailBody(makeRow({ submissionId: 'FB-OLD9', ...Object.fromEntries(Object.keys(SCORES).map((k) => [k, null])) }), 'http://x/pdf');
  assert.strictEqual((oldBody.match(/N\/A/g) || []).length, 6, 'legacy scores show N/A in email');
});

test('client account_manager: insert, update, and sync upsert preserve values', async () => {
  const client = await insertClient({ name: 'AM Corp', email: 'am@corp.com', account_manager: 'Tahir Raza' });
  assert.strictEqual(client.account_manager, 'Tahir Raza');

  const updated = await updateClientAccountManager(client.id, 'Jane Doe');
  assert.strictEqual(updated.account_manager, 'Jane Doe');

  const fromDb = await getClient(client.id);
  assert.strictEqual(fromDb.account_manager, 'Jane Doe');

  const { action } = await upsertClientByEmail({ name: 'AM Corp', email: 'am@corp.com', account_manager: '' });
  assert.strictEqual(action, 'updated');
  assert.strictEqual((await getClient(client.id)).account_manager, 'Jane Doe', 'empty value must not wipe existing account manager');

  const first = await upsertClientByEmail({ name: 'New Co', email: 'new@co.com', account_manager: 'Bob' });
  assert.strictEqual(first.action, 'inserted');
  assert.strictEqual(first.row.account_manager, 'Bob');
});

test('POST /api/feedback stores all six scores and returns them; missing score -> 400', async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const okRes = await fetch(`${base}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        attendeeName: 'API Tester',
        attendeeEmail: 'tester@example.com',
        ...SCORES,
        comments: 'nice',
        suggestions: ''
      })
    });
    assert.strictEqual(okRes.status, 201);
    const okJson = await okRes.json();
    assert.strictEqual(okJson.ok, true);
    assert.deepStrictEqual(okJson.departmentScores, SCORES);
    assert.strictEqual(okJson.rating, SCORES.agencyLeadershipScore);

    const listRes = await fetch(`${base}/api/feedback`);
    const listJson = await listRes.json();
    const submitted = listJson.data.find((r) => r.submissionId === okJson.submissionId);
    assert.ok(submitted, 'submission stored');
    assert.strictEqual(submitted.accountManagementScore, 5);
    assert.strictEqual(submitted.strategyScore, 4);
    assert.strictEqual(submitted.creativeScore, 3);
    assert.strictEqual(submitted.designContentScore, 2);
    assert.strictEqual(submitted.socialContentScore, 4);
    assert.strictEqual(submitted.agencyLeadershipScore, 5);
    assert.strictEqual(submitted.rating, submitted.agencyLeadershipScore);

    const badRes = await fetch(`${base}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...SCORES,
        agencyLeadershipScore: undefined,
        comments: 'x'
      })
    });
    assert.strictEqual(badRes.status, 400, 'missing score must be a 400, not a crash');
    const badJson = await badRes.json();
    assert.strictEqual(badJson.ok, false);
    assert.match(badJson.error, /Agency Leadership/);
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    server.close();
  }
});

test('POST /api/clients + PATCH save account_manager', async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const created = await (await fetch(`${base}/api/clients`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'API Client', email: 'api@client.com', account_manager: 'Tahir Raza' })
    })).json();
    assert.strictEqual(created.ok, true);
    assert.strictEqual(created.data.account_manager, 'Tahir Raza');

    const patched = await (await fetch(`${base}/api/clients/${created.data.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_manager: 'Zain Qureshi' })
    })).json();
    assert.strictEqual(patched.ok, true);
    assert.strictEqual(patched.data.account_manager, 'Zain Qureshi');
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    server.close();
  }
});
