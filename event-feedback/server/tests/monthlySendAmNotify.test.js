const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Force local SQLite, in-memory storage, and stub SMTP creds BEFORE any module
// is required (DATABASE_URL must be empty so we never touch the real DB).
process.env.DB_PATH = path.join(os.tmpdir(), `feedback-amnotify-${process.pid}.db`);
process.env.DATABASE_URL = '';
process.env.STORAGE_DRIVER = 'memory';
process.env.SMTP_PASS = 'test-pass';
process.env.ADMIN_EMAIL = 'admin@x.com';
process.env.LEADERSHIP_EMAILS = 'lead1@x.com';
process.env.GEMINI_API_KEY = '';

// Capture every outbound email so we can assert recipients without a real SMTP.
// Hooked through the transport so each test can install its own behavior.
let mockSendMail = null;
const captured = [];
const nodemailer = require('nodemailer');
nodemailer.createTransport = () => ({
  sendMail: async (mail) => {
    captured.push(mail);
    if (mockSendMail) return mockSendMail(mail);
    return { messageId: 'test-message-id' };
  }
});

const { db, insertClient } = require('../db');
const { sendMonthlyFeedbackForms } = require('../jobs/monthlySend');
const { accountManagerRequestSentContent } = require('../email');

const BASE_CONFIG = { smtpUser: 'u@x.com', smtpHost: 'smtp', smtpPass: 'p', adminEmail: 'admin@x.com' };

function wipe() {
  db.exec('DELETE FROM feedback_requests');
  db.exec('DELETE FROM clients');
  db.exec('DELETE FROM feedback_reports');
  db.exec('DELETE FROM alert_log');
}

test.before(() => wipe());
test.after(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch {}
  }
});

test('accountManagerRequestSentContent includes client name, email, and today’s date', () => {
  const client = { name: 'Acme', email: 'acme@client.com', accountManagerEmail: 'am@agency.com' };
  const fixed = new Date(2026, 8, 14); // 14 Sep 2026
  const { subject, text, html } = accountManagerRequestSentContent(client, fixed);
  assert.strictEqual(subject, 'Feedback request sent to Acme');
  assert.ok(text.includes('Acme'), 'client name in text');
  assert.ok(text.includes('acme@client.com'), 'client email in text');
  assert.ok(text.includes('14 Sep 2026'), 'formatted date in text');
  assert.ok(html.includes('Acme'), 'client name in html');
  assert.ok(html.includes('Craftsmen Media'), 'branded footer in html');
});

test('monthly send notifies the account manager alongside the client', async () => {
  captured.length = 0;
  const amEmail = 'jane@am.test';
  const client = await insertClient({ name: 'NotifyCorp', email: 'client@nc.test', accountManagerEmail: amEmail });

  const summary = await sendMonthlyFeedbackForms({ smtpConfig: BASE_CONFIG, appBaseUrl: 'http://app.test', batchSize: 10 });

  assert.strictEqual(summary.sent, 1);
  assert.strictEqual(summary.skipped, 0);
  assert.strictEqual(summary.failed, 0);
  assert.strictEqual(summary.amNotified, 1);
  assert.strictEqual(summary.amSkipped, 0);
  assert.strictEqual(summary.amFailed, 0);

  const clientMail = captured.find((m) => m.to === 'client@nc.test');
  assert.ok(clientMail, 'client got the feedback request email');
  assert.ok(clientMail.html, 'client email is HTML');

  const amMail = captured.find((m) => m.to === amEmail);
  assert.ok(amMail, 'account manager got the notification');
  assert.strictEqual(amMail.subject, 'Feedback request sent to NotifyCorp');
  assert.ok(amMail.text.includes('NotifyCorp'), 'AM text names the client');
  assert.ok(amMail.text.includes('client@nc.test'), 'AM text includes client email');
  assert.ok(amMail.html, 'AM email is HTML');
  assert.ok(!amMail.html.includes('http://'), 'AM email does NOT leak the client tokenized link');

  const rows = db.prepare('SELECT * FROM feedback_requests WHERE client_id = ?').all(client.id);
  assert.strictEqual(rows.length, 1, 'exactly one feedback request row written');
});

test('monthly send skips the AM notification silently when account_manager_email is blank', async () => {
  captured.length = 0;
  const client = await insertClient({ name: 'NoAmCorp', email: 'fam@nc.test' });

  const summary = await sendMonthlyFeedbackForms({ smtpConfig: BASE_CONFIG, appBaseUrl: 'http://app.test', batchSize: 10 });

  assert.strictEqual(summary.sent, 1);
  assert.strictEqual(summary.amNotified, 0);
  assert.strictEqual(summary.amSkipped, 1);
  assert.strictEqual(summary.amFailed, 0);

  const clientMail = captured.find((m) => m.to === 'fam@nc.test');
  assert.ok(clientMail, 'client got the feedback request email');
  assert.ok(!captured.some((m) => /Feedback request sent to/.test(m.subject || '')), 'no AM notification email was attempted');
});

test('a failing AM notification does not affect the client send or the batch', async () => {
  captured.length = 0;
  const amEmail = 'boom@am.test';
  const client = await insertClient({ name: 'FailAmCorp', email: 'fclient@fc.test', accountManagerEmail: amEmail });

  mockSendMail = (mail) => {
    if (mail.to === amEmail) throw new Error('SMTP refused');
    return { messageId: 'test-message-id' };
  };

  let summary;
  try {
    await assert.doesNotReject(async () => {
      summary = await sendMonthlyFeedbackForms({ smtpConfig: BASE_CONFIG, appBaseUrl: 'http://app.test', batchSize: 10 });
    });
  } finally {
    mockSendMail = null;
  }

  assert.strictEqual(summary.sent, 1, 'client email still counted as sent');
  assert.strictEqual(summary.failed, 0, 'client failure counter is untouched by AM failure');
  assert.strictEqual(summary.amFailed, 1, 'AM failure is counted separately');
  assert.strictEqual(summary.amNotified, 0);
  assert.strictEqual(summary.amSkipped, 0);

  const rows = db.prepare('SELECT * FROM feedback_requests WHERE client_id = ?').all(client.id);
  assert.strictEqual(rows.length, 1, 'request row still persisted despite AM failure');
});