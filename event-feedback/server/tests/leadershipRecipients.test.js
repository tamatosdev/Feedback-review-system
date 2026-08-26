const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');

// Force local SQLite + in-memory report storage before anything is required.
process.env.DB_PATH = path.join(os.tmpdir(), `feedback-lead-test-${process.pid}.db`);
process.env.DATABASE_URL = '';
process.env.STORAGE_DRIVER = 'memory';
process.env.SMTP_PASS = 'test-pass';
process.env.ADMIN_EMAIL = 'admin@am.test';
process.env.SYNC_SECRET = 'test-secret';
process.env.GEMINI_API_KEY = '';
// Leadership list includes admin@am.test on purpose to exercise de-duplication.
process.env.LEADERSHIP_EMAILS = 'lead1@x.com, lead2@x.com, lead3@x.com, admin@am.test';

const csvServer = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.end('Name,Email,Service Type,Account Manager Name,Account Manager Email\nCSV AM,csv@sync.com,Retainer,Bob,bob@agency.com\n');
});

// Capture every outbound email so we can assert recipients without a real SMTP.
const captured = [];
const nodemailer = require('nodemailer');
nodemailer.createTransport = () => ({
  sendMail: async (mail) => { captured.push(mail); return { messageId: 'test-message-id' }; }
});

const { db, insertClient, insertFeedbackRequest } = require('../db');
let app;

test.before(async () => {
  await new Promise((resolve) => csvServer.listen(0, resolve));
  process.env.SHEET_CSV_URL = `http://127.0.0.1:${csvServer.address().port}/clients.csv`;
  app = require('../index.js');

  db.exec('DELETE FROM feedback_requests');
  db.exec('DELETE FROM clients');
  db.exec('DELETE FROM feedback_reports');
});

test.after(async () => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch {}
  }
  await new Promise((resolve) => csvServer.close(resolve));
});

function startServer() {
  const server = app.listen(0);
  return new Promise((resolve) => server.on('listening', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}
function stopServer(server) {
  if (server.closeAllConnections) server.closeAllConnections();
  server.close();
}

function feedbackBody(token, overrides = {}) {
  return {
    token,
    attendeeName: 'Tester',
    attendeeEmail: 'tester@example.com',
    accountManagementScore: 5, strategyScore: 5, creativeScore: 5,
    designContentScore: 5, socialContentScore: 5, agencyLeadershipScore: 5,
    comments: 'x', suggestions: '',
    ...overrides
  };
}

function feedbackMails() {
  return captured.filter((m) => m.subject.startsWith('New Client Feedback'));
}

async function submitAndFlush(base, token, overrides) {
  captured.length = 0;
  const res = await fetch(`${base}/api/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(feedbackBody(token, overrides))
  });
  assert.strictEqual(res.status, 201, 'feedback submission should succeed');
  await app.flushBackground();
  return feedbackMails();
}

// ---- Pure unit tests for the new recipients logic ----

test('parseLeadershipEmails is defensive (unset / trailing comma / spaces)', () => {
  const { parseLeadershipEmails, reportExtraRecipients } = require('../email');
  assert.deepStrictEqual(parseLeadershipEmails(''), []);
  assert.deepStrictEqual(parseLeadershipEmails(undefined), []);
  assert.deepStrictEqual(parseLeadershipEmails('a@b.com, , c@d.com ,'), ['a@b.com', 'c@d.com']);
});

test('reportExtraRecipients: healthy score excludes leadership; low score adds it', () => {
  const { reportExtraRecipients } = require('../email');
  // healthy -> only account manager
  assert.deepStrictEqual(
    reportExtraRecipients({ accountManagerEmail: 'am@x.com', leadershipEmails: ['lead@x.com'], lowScore: false }),
    ['am@x.com']
  );
  // low -> account manager + leadership
  assert.deepStrictEqual(
    reportExtraRecipients({ accountManagerEmail: 'am@x.com', leadershipEmails: ['lead1@x.com', 'lead2@x.com'], lowScore: true }),
    ['am@x.com', 'lead1@x.com', 'lead2@x.com']
  );
  // low but leadership unset -> no crash, no leadership
  assert.deepStrictEqual(
    reportExtraRecipients({ accountManagerEmail: 'am@x.com', leadershipEmails: undefined, lowScore: true }),
    ['am@x.com']
  );
});

test('reportExtraRecipients de-duplicates overlapping addresses (case-insensitive)', () => {
  const { reportExtraRecipients } = require('../email');
  const out = reportExtraRecipients({
    accountManagerEmail: 'AM@x.com',
    leadershipEmails: ['am@x.com', 'lead@x.com', 'LEAD@x.com'],
    lowScore: true
  });
  assert.deepStrictEqual(out, ['AM@x.com', 'lead@x.com']);
});

// ---- Integration tests through the real submission flow ----

test('low overall score -> report email goes to ADMIN + AM + all 3 leadership (deduped)', async () => {
  const { server, base } = await startServer();
  try {
    const client = await insertClient({ name: 'LowCo', email: 'low@client.com', accountManagerEmail: 'am@agency.com' });
    const token = crypto.randomUUID();
    await insertFeedbackRequest({ client_id: client.id, month: '2026-08', token });
    const mails = await submitAndFlush(base, token, { agencyLeadershipScore: 1 });
    assert.strictEqual(mails.length, 1, 'exactly one report email');
    const to = mails[0].to;
    for (const addr of ['admin@am.test', 'am@agency.com', 'lead1@x.com', 'lead2@x.com', 'lead3@x.com']) {
      assert.ok(to.includes(addr), `expected recipient ${addr} in ${JSON.stringify(to)}`);
    }
    // admin@am.test also listed in LEADERSHIP_EMAILS -> must appear exactly once
    assert.strictEqual(to.filter((e) => e === 'admin@am.test').length, 1, 'admin de-duplicated');
    assert.strictEqual(to.length, new Set(to.map((e) => e.toLowerCase())).size, 'no duplicate recipients at all');
  } finally { stopServer(server); }
});

test('healthy overall score -> report email goes ONLY to ADMIN + AM (no leadership)', async () => {
  const { server, base } = await startServer();
  try {
    const client = await insertClient({ name: 'HealthyCo', email: 'h@client.com', accountManagerEmail: 'am@agency.com' });
    const token = crypto.randomUUID();
    await insertFeedbackRequest({ client_id: client.id, month: '2026-08', token });
    const mails = await submitAndFlush(base, token, { agencyLeadershipScore: 5 });
    assert.strictEqual(mails.length, 1);
    const to = mails[0].to;
    assert.ok(to.includes('admin@am.test'), 'admin still receives');
    assert.ok(to.includes('am@agency.com'), 'account manager still receives');
    for (const addr of ['lead1@x.com', 'lead2@x.com', 'lead3@x.com']) {
      assert.ok(!to.includes(addr), `leadership ${addr} must NOT receive a healthy-score report`);
    }
  } finally { stopServer(server); }
});

test('leadership overlaps account-manager -> still delivered once, no duplicate', async () => {
  const { server, base } = await startServer();
  try {
    // AM address equals one of the leadership addresses
    const client = await insertClient({ name: 'OverlapCo', email: 'o@client.com', accountManagerEmail: 'lead1@x.com' });
    const token = crypto.randomUUID();
    await insertFeedbackRequest({ client_id: client.id, month: '2026-08', token });
    const mails = await submitAndFlush(base, token, { agencyLeadershipScore: 2 });
    const to = mails[0].to;
    assert.ok(to.includes('admin@am.test'), 'admin present');
    assert.ok(to.includes('lead1@x.com'), 'lead1 present (as AM and leadership)');
    assert.strictEqual(to.filter((e) => e === 'lead1@x.com').length, 1, 'lead1 de-duplicated across AM + leadership');
    assert.strictEqual(to.length, new Set(to.map((e) => e.toLowerCase())).size, 'no duplicates');
  } finally { stopServer(server); }
});
