const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

process.env.DB_PATH = path.join(os.tmpdir(), `feedback-alerts-test-${process.pid}.db`);
process.env.DATABASE_URL = '';
process.env.STORAGE_DRIVER = 'memory';
process.env.SMTP_PASS = 'test-pass';
process.env.ADMIN_EMAIL = 'admin@alerts.test';
process.env.GEMINI_API_KEY = '';
delete process.env.ALERT_EMAIL;

const captured = [];
const nodemailer = require('nodemailer');
nodemailer.createTransport = () => ({
  sendMail: async (mail) => { captured.push(mail); return { messageId: 'test-message-id' }; }
});

const { db, insertClient, insertFeedbackRequest, insertFeedback } = require('../db');
const app = require('../index.js');
const { evaluateSubmissionAlerts, runNoResponseCheck } = require('../alerts');

const SMTP = { smtpHost: 'smtp.test', smtpPort: 465, smtpUser: 'u@alerts.test', smtpPass: 'test-pass', adminEmail: 'admin@alerts.test' };

test.before(async () => {
  db.exec('DELETE FROM alert_log');
  db.exec('DELETE FROM feedback_requests');
  db.exec('DELETE FROM feedback_reports');
  db.exec('DELETE FROM clients');
});

test.after(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch {}
  }
});

function body(overrides = {}) {
  return {
    attendeeName: 'Tester',
    attendeeEmail: 'tester@example.com',
    accountManagementScore: 5,
    strategyScore: 5,
    creativeScore: 5,
    designContentScore: 5,
    socialContentScore: 5,
    agencyLeadershipScore: 5,
    comments: 'x',
    suggestions: '',
    ...overrides
  };
}

function seedSubmission(clientId, month, s) {
  return insertFeedback({
    submissionId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    serviceType: 'Test Service',
    month,
    client_id: clientId,
    attendeeName: 'Seed',
    attendeeEmail: 'seed@test.com',
    hasValidEmail: 1,
    companyName: 'Seed Co',
    rating: s.agencyLeadershipScore,
    accountManagementScore: s.accountManagementScore,
    strategyScore: s.strategyScore,
    creativeScore: s.creativeScore,
    designContentScore: s.designContentScore,
    socialContentScore: s.socialContentScore,
    agencyLeadershipScore: s.agencyLeadershipScore,
    comments: '',
    suggestions: '',
    sentiment: 'Neutral',
    summary: 'seeded',
    urgency: 'Low',
    highlights: [],
    improvementSuggestions: [],
    pdfUrl: '',
    emailSent: 0
  });
}

function alertMails() {
  return captured.filter((m) => m.subject.startsWith('ALERT:') || m.subject.startsWith('ESCALATION:') || m.subject.startsWith('Gentle Reminder'));
}

async function startServer() {
  const server = app.listen(0);
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

function stopServer(server) {
  if (server.closeAllConnections) server.closeAllConnections();
  server.close();
}

async function postFeedback(base, token, overrides) {
  const res = await fetch(`${base}/api/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body({ token, ...overrides }))
  });
  const json = await res.json();
  await app.flushBackground();
  return { status: res.status, json };
}

test('low score submission fires one leadership alert; dedup blocks repeats', async () => {
  captured.length = 0;
  const client = await insertClient({ name: 'Low Client', email: 'low@alerts.test' });
  const token = crypto.randomUUID();
  await insertFeedbackRequest({ client_id: client.id, month: '2026-06', token });

  const { server, base } = await startServer();
  try {
    const r = await postFeedback(base, token, { agencyLeadershipScore: 2 });
    assert.strictEqual(r.status, 201);

    const mails = alertMails();
    const low = mails.find((m) => m.subject.startsWith('ALERT: Low overall score'));
    assert.ok(low, 'low-score alert email sent');
    assert.strictEqual(low.to, 'admin@alerts.test', 'leadership recipient defaults to ADMIN_EMAIL when ALERT_EMAIL is unset');
    assert.ok(low.subject.includes('Low Client') && low.subject.includes('2/5'));
    assert.ok(low.text.includes('2/5') && low.text.includes('2026-06'));
    assert.ok(low.text.includes(`dashboard.html?client=${client.id}`), 'dashboard link present');
    assert.ok(low.html.includes('Low Client'), 'html alternative present');

    const dept = mails.find((m) => m.subject.startsWith('ALERT: Agency Leadership average'));
    assert.ok(dept, 'department-average alert also sent');
    assert.ok(dept.subject.includes('2.00'));

    const before = captured.length;
    const again = await evaluateSubmissionAlerts({ client, record: { month: '2026-06', agencyLeadershipScore: 2 }, smtpConfig: SMTP, appBaseUrl: 'http://app.test' });
    assert.deepStrictEqual(again.sent, [], 'no repeat alerts for the same client+month');
    assert.strictEqual(captured.length, before, 'no duplicate emails');
  } finally {
    stopServer(server);
  }
});

test('two consecutive low months escalate; plain low-score alert is subsumed', async () => {
  captured.length = 0;
  const client = await insertClient({ name: 'Escalation Client', email: 'esc@alerts.test' });
  await seedSubmission(client.id, '2026-06', { agencyLeadershipScore: 2, creativeScore: 5, strategyScore: 5, accountManagementScore: 5, designContentScore: 5, socialContentScore: 5 });
  const token = crypto.randomUUID();
  await insertFeedbackRequest({ client_id: client.id, month: '2026-07', token });

  const { server, base } = await startServer();
  try {
    const r = await postFeedback(base, token, { agencyLeadershipScore: 2 });
    assert.strictEqual(r.status, 201);

    const mails = alertMails();
    const esc = mails.find((m) => m.subject.startsWith('ESCALATION:'));
    assert.ok(esc, 'escalation email sent');
    assert.ok(esc.subject.includes('2 consecutive months'));
    assert.ok(esc.text.includes('2026-06') && esc.text.includes('2026-07'), 'both low months listed');
    assert.ok(esc.text.includes(`dashboard.html?client=${client.id}`));
    assert.ok(!mails.some((m) => m.subject.startsWith('ALERT: Low overall score')), 'no separate low-score email');
  } finally {
    stopServer(server);
  }
});

test('a single low month is a low-score alert, not an escalation', async () => {
  captured.length = 0;
  const client = await insertClient({ name: 'Single Low', email: 'single@alerts.test' });
  await seedSubmission(client.id, '2026-06', { agencyLeadershipScore: 5, creativeScore: 5, strategyScore: 5, accountManagementScore: 5, designContentScore: 5, socialContentScore: 5 });
  const token = crypto.randomUUID();
  await insertFeedbackRequest({ client_id: client.id, month: '2026-07', token });

  const { server, base } = await startServer();
  try {
    const r = await postFeedback(base, token, { agencyLeadershipScore: 2 });
    const mails = alertMails();
    assert.ok(mails.some((m) => m.subject.startsWith('ALERT: Low overall score')), 'low-score alert email sent');
    assert.ok(!mails.some((m) => m.subject.startsWith('ESCALATION:')), 'no escalation email for a single low month');
  } finally {
    stopServer(server);
  }
});

test('month-over-month drop of >= 1.0 fires; small or no drop does not', async () => {
  captured.length = 0;
  const dropper = await insertClient({ name: 'Dropper', email: 'drop@alerts.test' });
  await seedSubmission(dropper.id, '2026-06', { agencyLeadershipScore: 5, creativeScore: 5, strategyScore: 5, accountManagementScore: 5, designContentScore: 5, socialContentScore: 5 });
  const token = crypto.randomUUID();
  await insertFeedbackRequest({ client_id: dropper.id, month: '2026-07', token });

  const steady = await insertClient({ name: 'Steady', email: 'steady@alerts.test' });
  await seedSubmission(steady.id, '2026-06', { agencyLeadershipScore: 5, creativeScore: 5, strategyScore: 5, accountManagementScore: 5, designContentScore: 5, socialContentScore: 5 });
  const token2 = crypto.randomUUID();
  await insertFeedbackRequest({ client_id: steady.id, month: '2026-07', token: token2 });

  const small = await insertClient({ name: 'Small Drop', email: 'small@alerts.test' });
  await seedSubmission(small.id, '2026-06', { agencyLeadershipScore: 4, creativeScore: 4, strategyScore: 4, accountManagementScore: 4, designContentScore: 4, socialContentScore: 4 });
  const token3 = crypto.randomUUID();
  await insertFeedbackRequest({ client_id: small.id, month: '2026-07', token: token3 });

  const { server, base } = await startServer();
  try {
    const r1 = await postFeedback(base, token, { agencyLeadershipScore: 4 });
    const dropMail = alertMails().find((m) => m.subject.startsWith('ALERT: Score drop'));
    assert.ok(dropMail, 'score-drop alert email sent');
    assert.ok(dropMail.text.includes('5/5') && dropMail.text.includes('4/5') && dropMail.text.includes('1 point'));
    captured.length = 0;

    const r2 = await postFeedback(base, token2, { agencyLeadershipScore: 5 });
    assert.strictEqual(alertMails().length, 0, '5 -> 5 is no drop; steady client fires nothing');
    captured.length = 0;

    const r3 = await postFeedback(base, token3, { agencyLeadershipScore: 4 });
    assert.strictEqual(alertMails().length, 0, '4 -> 4 is no drop');
  } finally {
    stopServer(server);
  }
});

test('low department average fires per department without a low overall score', async () => {
  captured.length = 0;
  const client = await insertClient({ name: 'Dept Client', email: 'dept@alerts.test' });
  const token = crypto.randomUUID();
  await insertFeedbackRequest({ client_id: client.id, month: '2026-08', token });

  const { server, base } = await startServer();
  try {
    const r = await postFeedback(base, token, { creativeScore: 2, agencyLeadershipScore: 4 });
    const mails = alertMails();
    assert.ok(mails.some((m) => m.subject.startsWith('ALERT: Creative average')), 'creative dept alert email sent');
    assert.ok(!mails.some((m) => m.subject.startsWith('ALERT: Low overall score')), 'overall score 4 is fine');
    const mail = alertMails().find((m) => m.subject.startsWith('ALERT: Creative average'));
    assert.ok(mail && mail.subject.includes('2.00'));
  } finally {
    stopServer(server);
  }
});

test('healthy submission fires no alerts', async () => {
  captured.length = 0;
  const client = await insertClient({ name: 'Healthy Client', email: 'healthy@alerts.test' });
  await seedSubmission(client.id, '2026-06', { agencyLeadershipScore: 5, creativeScore: 5, strategyScore: 5, accountManagementScore: 5, designContentScore: 5, socialContentScore: 5 });
  const token = crypto.randomUUID();
  await insertFeedbackRequest({ client_id: client.id, month: '2026-07', token });

  const { server, base } = await startServer();
  try {
    const r = await postFeedback(base, token, { agencyLeadershipScore: 5 });
    assert.deepStrictEqual(alertMails(), [], 'no alert emails at all');
  } finally {
    stopServer(server);
  }
});

test('no-response check: old request -> client reminder + internal alert, once only; recent request untouched', async () => {
  captured.length = 0;
  const now = new Date();
  const currentYm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const tenDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString();

  const oldClient = await insertClient({ name: 'Silent Client', email: 'silent@alerts.test' });
  const oldReq = (await insertFeedbackRequest({ client_id: oldClient.id, month: currentYm, token: crypto.randomUUID() })).row;
  db.prepare('UPDATE feedback_requests SET sent_at = ? WHERE id = ?').run(tenDaysAgo, oldReq.id);

  const recentClient = await insertClient({ name: 'Recent Client', email: 'recent@alerts.test' });
  const recentReq = (await insertFeedbackRequest({ client_id: recentClient.id, month: currentYm, token: crypto.randomUUID() })).row;

  const first = await runNoResponseCheck({ smtpConfig: SMTP, appBaseUrl: 'http://app.test' });
  assert.strictEqual(first.checked, 2);
  assert.strictEqual(first.reminded, 1, 'client reminder for the old request');
  assert.strictEqual(first.internalSent, 1, 'internal alert for the old request');
  assert.strictEqual(first.skipped, 1, 'recent request is not due yet');

  const reminder = alertMails().find((m) => m.subject.startsWith('Gentle Reminder') && m.to === 'silent@alerts.test');
  assert.ok(reminder, 'client reminder sent to the client');
  assert.strictEqual(reminder.subject, 'Gentle Reminder | Client Feedback', 'updated reminder subject');
  assert.ok(reminder.text.includes(`http://app.test/feedback/${oldReq.token}`), 'reminder re-includes the feedback link');
  assert.ok(reminder.text.includes('gentle reminder'), 'updated reminder body copy (plain text)');
  assert.ok(reminder.text.includes('The Craftsmen Media Support Team'), 'new sign-off present');
  assert.ok(reminder.html.includes(`http://app.test/feedback/${oldReq.token}`), 'html alternative includes the feedback link');
  assert.ok(reminder.html.includes('Craftsmen Media Support Team'), 'html alternative present');

  const internal = alertMails().find((m) => m.subject.startsWith('ALERT: No response') && m.to === 'admin@alerts.test');
  assert.ok(internal, 'internal no-response alert to ADMIN_EMAIL');
  assert.ok(internal.text.includes('Silent Client'));
  assert.ok(internal.text.includes(`dashboard.html?client=${oldClient.id}`));

  const before = captured.length;
  const second = await runNoResponseCheck({ smtpConfig: SMTP, appBaseUrl: 'http://app.test' });
  assert.strictEqual(second.alreadyAlerted, 1, 'dedup: no repeat for the old request');
  assert.strictEqual(second.reminded, 0);
  assert.strictEqual(second.internalSent, 0);
  assert.strictEqual(captured.length, before, 'no duplicate emails');

  assert.strictEqual(recentReq.submitted, 0);
});

test('no-response check fires at the 5-day default threshold (was 7)', async () => {
  captured.length = 0;
  const now = new Date();
  const currentYm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const fiveDaysAgo = new Date(Date.now() - 5 * 86400000).toISOString();

  const client = await insertClient({ name: 'FiveDay Client', email: 'five@alerts.test' });
  const req = (await insertFeedbackRequest({ client_id: client.id, month: currentYm, token: crypto.randomUUID() })).row;
  db.prepare('UPDATE feedback_requests SET sent_at = ? WHERE id = ?').run(fiveDaysAgo, req.id);

  const res = await runNoResponseCheck({ smtpConfig: SMTP, appBaseUrl: 'http://app.test' });
  assert.ok(res.reminded >= 1, 'at least the 5-day-old request is reminded');
  const reminder = captured.find((m) => m.to === 'five@alerts.test' && m.subject.startsWith('Gentle Reminder'));
  assert.ok(reminder, 'the 5-day-old client received a reminder');
  assert.ok(reminder.text.includes(`http://app.test/feedback/${req.token}`), 'reminder includes the feedback link');
  assert.ok(reminder.html.includes(`http://app.test/feedback/${req.token}`), 'html reminder includes the feedback link');
});

test('no-response check does NOT fire before the 5-day threshold (4 days)', async () => {
  captured.length = 0;
  const now = new Date();
  const currentYm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const fourDaysAgo = new Date(Date.now() - 4 * 86400000).toISOString();

  const client = await insertClient({ name: 'FourDay Client', email: 'four@alerts.test' });
  const req = (await insertFeedbackRequest({ client_id: client.id, month: currentYm, token: crypto.randomUUID() })).row;
  db.prepare('UPDATE feedback_requests SET sent_at = ? WHERE id = ?').run(fourDaysAgo, req.id);

  const res = await runNoResponseCheck({ smtpConfig: SMTP, appBaseUrl: 'http://app.test' });
  assert.ok(res.skipped >= 1, 'at least the 4-day-old request is skipped');
  const reminder = captured.find((m) => m.to === 'four@alerts.test' && m.subject.startsWith('Gentle Reminder'));
  assert.strictEqual(reminder, undefined, 'no reminder for the 4-day-old client (below the 5-day default)');
});

test('POST /api/cron/no-response-check endpoint runs the check', async () => {
  captured.length = 0;
  const now = new Date();
  const currentYm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const tenDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString();

  const client = await insertClient({ name: 'Cron Client', email: 'cron@alerts.test' });
  const req = (await insertFeedbackRequest({ client_id: client.id, month: currentYm, token: crypto.randomUUID() })).row;
  db.prepare('UPDATE feedback_requests SET sent_at = ? WHERE id = ?').run(tenDaysAgo, req.id);

  const { server, base } = await startServer();
  try {
    const res = await fetch(`${base}/api/cron/no-response-check`, {
      method: 'POST',
      headers: { 'x-cron-secret': process.env.CRON_SECRET || '' }
    });
    const json = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(json.ok, true);
    assert.strictEqual(json.reminded, 1);
    assert.strictEqual(json.internalSent, 1);
  } finally {
    stopServer(server);
  }
});