const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Both ADMIN_EMAIL and LEADERSHIP_EMAILS unset -> internal alerts must be skipped.
process.env.DB_PATH = path.join(os.tmpdir(), `feedback-norecip-${process.pid}.db`);
process.env.DATABASE_URL = '';
process.env.STORAGE_DRIVER = 'memory';
process.env.SMTP_PASS = 'test-pass';
process.env.ADMIN_EMAIL = '';
process.env.ALERT_EMAIL = '';
process.env.LEADERSHIP_EMAILS = '';
process.env.GEMINI_API_KEY = '';

const captured = [];
const nodemailer = require('nodemailer');
nodemailer.createTransport = () => ({
  sendMail: async (mail) => { captured.push(mail); return { messageId: 'test-message-id' }; }
});

const { db, insertClient, insertFeedbackRequest, insertFeedback } = require('../db');
const alerts = require('../alerts');
const BASE_CONFIG = { smtpUser: 'u@x.com', smtpHost: 'smtp', smtpPass: 'p', adminEmail: '' };

test.before(async () => {
  db.exec('DELETE FROM feedback_requests');
  db.exec('DELETE FROM clients');
  db.exec('DELETE FROM feedback_reports');
  db.exec('DELETE FROM alert_log');
});
test.after(async () => {
  db.close();
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch {} }
});

test('no ADMIN_EMAIL and no LEADERSHIP_EMAILS -> low-score internal alert is skipped (no crash)', async () => {
  captured.length = 0;
  const client = await insertClient({ name: 'LowNoOne', email: 'low@client.com', accountManagerEmail: 'am@agency.com' });
  const token = require('crypto').randomUUID();
  await insertFeedbackRequest({ client_id: client.id, month: '2026-08', token });
  const rec = { submissionId: 'FB-NR', timestamp: new Date().toISOString(), client_id: client.id, serviceType: 'Retainer', month: '2026-08',
    attendeeName: 'A', attendeeEmail: 'a@b.com', rating: 1, accountManagementScore: 1, strategyScore: 1,
    creativeScore: 1, designContentScore: 1, socialContentScore: 1, agencyLeadershipScore: 1,
    sentiment: 'Negative', urgency: 'High', summary: 's' };
  await insertFeedback({ ...rec, companyName: '', comments: 'c', suggestions: null, hasValidEmail: true });
  await assert.doesNotReject(
    alerts.evaluateSubmissionAlerts({ client, record: rec, smtpConfig: BASE_CONFIG, appBaseUrl: 'http://app' })
  );
  const alertMails = captured.filter((m) => /ALERT/i.test(m.subject || ''));
  assert.strictEqual(alertMails.length, 0, 'no alert email when no recipient configured anywhere');
});

test('no ADMIN_EMAIL and no LEADERSHIP_EMAILS -> no-response client reminder sent but internal alert skipped', async () => {
  captured.length = 0;
  const client = await insertClient({ name: 'NoResp2', email: 'nr2@client.com', accountManagerEmail: 'am@agency.com' });
  const token = require('crypto').randomUUID();
  await insertFeedbackRequest({ client_id: client.id, month: '2026-08', token });
  db.prepare('UPDATE feedback_requests SET sent_at = ? WHERE id = (SELECT id FROM feedback_requests WHERE token=?)').run('2026-08-01T00:00:00Z', token);
  const summary = await alerts.runNoResponseCheck({ smtpConfig: BASE_CONFIG, appBaseUrl: 'http://app' });
  const clientMails = captured.filter((m) => m.to === 'nr2@client.com');
  const internalMails = captured.filter((m) => /No response/i.test(m.subject || ''));
  assert.ok(clientMails.length >= 1, 'client reminder was sent');
  assert.strictEqual(internalMails.length, 0, 'internal alert skipped when no recipient configured');
  assert.strictEqual(summary.reminded, 1);
  assert.strictEqual(summary.internalSent, 0);
});
