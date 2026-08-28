const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Force local SQLite + in-memory storage, and UNSET admin/alert emails BEFORE
// any module is required, so we exercise the ADMIN_EMAIL-optional paths.
process.env.DB_PATH = path.join(os.tmpdir(), `feedback-adminopt-${process.pid}.db`);
process.env.DATABASE_URL = '';
process.env.STORAGE_DRIVER = 'memory';
process.env.SMTP_PASS = 'test-pass';
process.env.ADMIN_EMAIL = '';
process.env.ALERT_EMAIL = '';
process.env.LEADERSHIP_EMAILS = 'lead1@x.com, lead2@x.com';
process.env.GEMINI_API_KEY = '';

// Capture every outbound email so we can assert recipients without a real SMTP.
const captured = [];
const nodemailer = require('nodemailer');
nodemailer.createTransport = () => ({
  sendMail: async (mail) => { captured.push(mail); return { messageId: 'test-message-id' }; }
});

const { db, insertClient, insertFeedbackRequest, insertFeedback } = require('../db');
const { sendFeedbackEmail, sendCombinedEmail, sendNoFeedbackEmail, sendAlertEmail } = require('../email');
const alerts = require('../alerts');

const BASE_CONFIG = { smtpUser: 'u@x.com', smtpHost: 'smtp', smtpPass: 'p', adminEmail: '' };
function sampleRecord(over = {}) {
  return {
    submissionId: 'FB-OPT', timestamp: new Date().toISOString(), rating: 1,
    accountManagementScore: 1, strategyScore: 1, creativeScore: 1,
    designContentScore: 1, socialContentScore: 1, agencyLeadershipScore: 1,
    sentiment: 'Negative', urgency: 'High', summary: 's', ...over
  };
}

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

// ---------- email.js: ADMIN_EMAIL unset ----------

test('sendFeedbackEmail (ADMIN_EMAIL unset, AM + leadership present) sends only to AM + leadership, not admin', async () => {
  captured.length = 0;
  const info = await sendFeedbackEmail(BASE_CONFIG, sampleRecord(), Buffer.from('x'), 'http://x/pdf', ['am@agency.com', 'lead1@x.com']);
  assert.ok(info, 'mail was sent');
  assert.strictEqual(captured.length, 1);
  const to = captured[0].to;
  assert.ok(to.includes('am@agency.com'), 'account manager receives');
  assert.ok(to.includes('lead1@x.com'), 'leadership receives');
  assert.ok(!to.includes('admin@x.com'), 'no admin recipient');
  assert.strictEqual(captured[0].attachments.length, 1, 'PDF attached');
});

test('sendFeedbackEmail (ADMIN_EMAIL unset, no other recipient) is skipped, no mail, no crash', async () => {
  captured.length = 0;
  const info = await sendFeedbackEmail(BASE_CONFIG, sampleRecord(), Buffer.from('x'), 'http://x/pdf', []);
  assert.strictEqual(info, null, 'returns null when no recipient');
  assert.strictEqual(captured.length, 0, 'nothing sent');
});

test('sendCombinedEmail (ADMIN_EMAIL unset) is skipped, no mail', async () => {
  captured.length = 0;
  const info = await sendCombinedEmail(BASE_CONFIG, { from: '2026-01', to: '2026-06', overallSummary: 's', overallSentimentBreakdown: { positive: 1, neutral: 0, negative: 0 }, keyHighlights: [], topImprovementSuggestions: [] }, Buffer.from('x'), 'http://x/pdf', 3);
  assert.strictEqual(info, null);
  assert.strictEqual(captured.length, 0);
});

test('sendNoFeedbackEmail (ADMIN_EMAIL unset) is skipped, no mail', async () => {
  captured.length = 0;
  const info = await sendNoFeedbackEmail(BASE_CONFIG, '2026-01', '2026-06');
  assert.strictEqual(info, null);
  assert.strictEqual(captured.length, 0);
});

test('sendAlertEmail with empty recipient is skipped, no mail', async () => {
  captured.length = 0;
  const info = await sendAlertEmail(BASE_CONFIG, { to: '', subject: 's', text: 't' });
  assert.strictEqual(info, null);
  assert.strictEqual(captured.length, 0);
});

test('sendAlertEmail with valid recipient still sends', async () => {
  captured.length = 0;
  const info = await sendAlertEmail(BASE_CONFIG, { to: 'someone@x.com', subject: 's', text: 't' });
  assert.ok(info);
  assert.strictEqual(captured.length, 1);
});

// ---------- alerts.js: ALERT_EMAIL + ADMIN_EMAIL both unset ----------

test('alerts.ALERT_EMAIL is empty when both ADMIN_EMAIL and ALERT_EMAIL are unset', () => {
  assert.strictEqual(alerts.ALERT_EMAIL, '');
});

test('evaluateSubmissionAlerts low-score with no ALERT_EMAIL/ADMIN_EMAIL routes internal alert to LEADERSHIP_EMAILS fallback', async () => {
  captured.length = 0;
  const client = await insertClient({ name: 'LowNoAdmin', email: 'low@client.com', accountManagerEmail: 'am@agency.com' });
  const token = require('crypto').randomUUID();
  await insertFeedbackRequest({ client_id: client.id, month: '2026-08', token });
  const rec = { submissionId: 'FB-ALERT', timestamp: new Date().toISOString(), client_id: client.id, serviceType: 'Retainer', month: '2026-08',
    attendeeName: 'A', attendeeEmail: 'a@b.com', rating: 1, accountManagementScore: 1, strategyScore: 1,
    creativeScore: 1, designContentScore: 1, socialContentScore: 1, agencyLeadershipScore: 1,
    sentiment: 'Negative', urgency: 'High', summary: 's' };
  await insertFeedback({ ...rec, companyName: '', comments: 'c', suggestions: null, hasValidEmail: true });
  // Should not throw; alert must go to leadership fallback, not be skipped.
  await assert.doesNotReject(
    alerts.evaluateSubmissionAlerts({ client, record: rec, smtpConfig: BASE_CONFIG, appBaseUrl: 'http://app' })
  );
  const alertMails = captured.filter((m) => /ALERT/i.test(m.subject || ''));
  assert.ok(alertMails.length >= 1, 'at least one internal alert routed to leadership fallback');
  for (const m of alertMails) {
    assert.ok(m.to.includes('lead1@x.com'), 'leadership fallback recipient receives alert');
    assert.ok(m.to.includes('lead2@x.com'), 'all leadership addresses receive alert');
    assert.ok(!m.to.some((a) => a.includes('admin@')), 'no admin address used as fallback');
  }
});

test('runNoResponseCheck with no admin recipient sends client reminder AND routes internal alert to LEADERSHIP_EMAILS', async () => {
  captured.length = 0;
  // Seed a client + request aged past the no-response window.
  const client = await insertClient({ name: 'NoResp', email: 'noresp@client.com', accountManagerEmail: 'am@agency.com' });
  const token = require('crypto').randomUUID();
  await insertFeedbackRequest({ client_id: client.id, month: '2026-08', token });
  db.prepare('UPDATE feedback_requests SET sent_at = ? WHERE id = (SELECT id FROM feedback_requests WHERE token=?)').run('2026-08-01T00:00:00Z', token);
  const summary = await alerts.runNoResponseCheck({ smtpConfig: BASE_CONFIG, appBaseUrl: 'http://app' });
  const clientMails = captured.filter((m) => m.to === 'noresp@client.com');
  const internalMails = captured.filter((m) => /No response/i.test(m.subject || ''));
  assert.ok(clientMails.length >= 1, 'client reminder was sent');
  assert.strictEqual(internalMails.length, 1, 'internal no-response alert routed to leadership fallback');
  assert.ok(internalMails[0].to.includes('lead1@x.com'), 'leadership receives internal alert');
  assert.strictEqual(summary.reminded, 1);
  assert.strictEqual(summary.internalSent, 1);
});
