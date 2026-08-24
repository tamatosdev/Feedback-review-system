const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

// Force local SQLite + in-memory report storage before anything is required
// (dotenv must not flip us into Postgres/Supabase mode).
process.env.DB_PATH = path.join(os.tmpdir(), `feedback-departments-test-${process.pid}.db`);
process.env.DATABASE_URL = '';
process.env.STORAGE_DRIVER = 'memory';
process.env.SYNC_SECRET = 'test-secret';

const { db, insertFeedback, getFeedbackReport, queryFeedback, insertClient, upsertClientByEmail, getClient } = require('../db');
const { reportHTML, combinedHTML } = require('../report');
const { buildPdf } = require('../pdf');
const { feedbackEmailBody } = require('../email');
let app;
let csvServer;

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

  // Serve a published-sheet-style CSV with only a Name column (no Company Name)
  // so the pull sync endpoint can be exercised end-to-end.
  csvServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/csv');
    res.end('Name,Email,Status\nSheet Co,sheetentry@test.com,active\n');
  });
  await new Promise((resolve) => csvServer.listen(0, resolve));
  process.env.SHEET_CSV_URL = `http://127.0.0.1:${csvServer.address().port}/clients.csv`;
  app = require('../index.js');
});

test.after(async () => {
  if (csvServer) await new Promise((resolve) => csvServer.close(resolve));
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

test('client upsert by email: updates existing and inserts new without touching account_manager', async () => {
  const client = await insertClient({ name: 'AM Corp', email: 'am@corp.com' });

  const { action } = await upsertClientByEmail({ name: 'AM Corp Renamed', email: 'am@corp.com' });
  assert.strictEqual(action, 'updated');
  const fromDb = await getClient(client.id);
  assert.strictEqual(fromDb.name, 'AM Corp Renamed');

  const first = await upsertClientByEmail({ name: 'New Co', email: 'new@co.com' });
  assert.strictEqual(first.action, 'inserted');
  assert.strictEqual(first.row.name, 'New Co');
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

test('POST /api/clients + PATCH update status', async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const created = await (await fetch(`${base}/api/clients`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'API Client', email: 'api@client.com' })
    })).json();
    assert.strictEqual(created.ok, true);
    assert.strictEqual(created.data.name, 'API Client');
    assert.strictEqual(created.data.status, 'active');

    const patched = await (await fetch(`${base}/api/clients/${created.data.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'inactive' })
    })).json();
    assert.strictEqual(patched.ok, true);
    assert.strictEqual(patched.data.status, 'inactive');
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    server.close();
  }
});

test('POST /api/clients/sync upserts rows with just Name/Email columns (no Company Name required)', async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/clients/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sync-Secret': 'test-secret' },
      body: JSON.stringify({ clients: [{ Name: 'Sync Only', Email: 'only@sync.com', Status: 'active' }] })
    });
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.ok, true);
    assert.strictEqual(json.inserted, 1);
    assert.strictEqual(json.updated, 0);
    assert.deepStrictEqual(json.skipped, []);

    const fromDb = db.prepare('SELECT * FROM clients WHERE email = ?').get('only@sync.com');
    assert.strictEqual(fromDb.name, 'Sync Only');
    assert.strictEqual(fromDb.service_type, null, 'service_type is no longer written by sync');
    assert.strictEqual(fromDb.company_name, null, 'company_name column stays untouched');

    const second = await fetch(`${base}/api/clients/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sync-Secret': 'test-secret' },
      body: JSON.stringify({ clients: [{ Name: 'Sync Only 2', Email: 'only@sync.com' }] })
    });
    const secondJson = await second.json();
    assert.strictEqual(secondJson.updated, 1, 'same email upserts, does not duplicate');
    assert.strictEqual(db.prepare('SELECT * FROM clients WHERE email = ?').get('only@sync.com').name, 'Sync Only 2');
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    server.close();
  }
});

test('POST /api/clients/sync-from-sheet pulls a CSV with only a Name column', async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/clients/sync-from-sheet`, {
      method: 'POST',
      headers: { 'X-Sync-Secret': 'test-secret' }
    });
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.ok, true);
    assert.strictEqual(json.inserted, 1);

    const stored = (await db.prepare('SELECT * FROM clients WHERE email = ?').get('sheetentry@test.com'));
    assert.ok(stored, 'row from CSV stored');
    assert.strictEqual(stored.name, 'Sheet Co');
    assert.strictEqual(stored.service_type, null, 'service_type is no longer written by sheet sync');
    assert.strictEqual(stored.company_name, null, 'company_name stays null without a Company Name column');
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    server.close();
  }
});
