const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

process.env.DB_PATH = path.join(os.tmpdir(), `feedback-nr-cross-month-${process.pid}.db`);
process.env.DATABASE_URL = '';
process.env.STORAGE_DRIVER = 'memory';
process.env.SMTP_PASS = 'test-pass';
process.env.ADMIN_EMAIL = 'admin@nr.test';
process.env.GEMINI_API_KEY = '';
delete process.env.ALERT_EMAIL;

const captured = [];
const nodemailer = require('nodemailer');
nodemailer.createTransport = () => ({
  sendMail: async (mail) => { captured.push(mail); return { messageId: 'test-message-id' }; }
});

const { db, insertClient, insertFeedbackRequest, alertDedupKey } = require('../db');
const { runNoResponseCheck } = require('../alerts');

const SMTP = { smtpHost: 'smtp.test', smtpPort: 465, smtpUser: 'u@nr.test', smtpPass: 'test-pass', adminEmail: 'admin@nr.test' };

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString();
}

// A month that is definitely NOT the current calendar month, so the old
// `substr(fr.month,1,7) = currentYm` filter would have excluded it.
function previousYm() {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function pendingClient(name, email, month, ageDays) {
  const client = await insertClient({ name, email });
  const req = (await insertFeedbackRequest({ client_id: client.id, month, token: crypto.randomUUID() })).row;
  db.prepare('UPDATE feedback_requests SET sent_at = ? WHERE id = ?').run(daysAgo(ageDays), req.id);
  return { client, req };
}

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

test('a pending request from a PREVIOUS month, past threshold, is now caught', async () => {
  captured.length = 0;
  const prev = previousYm();
  assert.notStrictEqual(prev, `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`);

  const { client, req } = await pendingClient('CrossMonth Client', 'crossmonth@nr.test', prev, 10);

  const res = await runNoResponseCheck({ smtpConfig: SMTP, appBaseUrl: 'https://app.nr.test' });

  assert.ok(res.checked >= 1, 'the previous-month row was scanned at all');
  assert.strictEqual(res.reminded, 1, 'the previous-month request got its reminder');
  assert.strictEqual(res.internalSent, 1, 'internal alert too');

  const reminder = captured.find((m) => m.to === 'crossmonth@nr.test' && m.subject.startsWith('Gentle Reminder'));
  assert.ok(reminder, 'client reminder email sent to a previous-month request');
  assert.ok(reminder.text.includes(`https://app.nr.test/feedback/${req.token}`), 'reminder carries the real link');
  assert.ok(client.id > 0);
});

test('dedup: the same previous-month request is reminded ONCE, not daily', async () => {
  // continues from the previous test's seeded client, which now has a dedup row
  const before = captured.length;
  const second = await runNoResponseCheck({ smtpConfig: SMTP, appBaseUrl: 'https://app.nr.test' });
  assert.ok(second.alreadyAlerted >= 1, 'already-alerted counted on the second run');
  assert.strictEqual(captured.length, before, 'no repeat email on the second run');

  const third = await runNoResponseCheck({ smtpConfig: SMTP, appBaseUrl: 'https://app.nr.test' });
  assert.strictEqual(third.reminded, 0, 'still nothing on a third consecutive run');
  assert.strictEqual(captured.length, before, 'still no duplicate emails');
});

test('dedup key is scoped to the row period, not the current calendar month', () => {
  const k1 = alertDedupKey({ alertType: 'no_response', clientId: 51, period: '2026-09' });
  const k2 = alertDedupKey({ alertType: 'no_response', clientId: 51, period: '2026-10' });
  const k3 = alertDedupKey({ alertType: 'no_response', clientId: 52, period: '2026-09' });
  assert.strictEqual(k1, 'no_response|51||2026-09');
  assert.notStrictEqual(k1, k2, 'a new cycle month is a distinct dedup slot');
  assert.notStrictEqual(k1, k3, 'different clients are distinct dedup slots');

  // The key must be byte-identical to what insertAlertLog writes, otherwise the
  // dry-run check would disagree with the real insert.
  const rows = db.prepare('SELECT dedup_key FROM alert_log WHERE alert_type = ?').all('no_response');
  assert.ok(rows.length >= 1, 'a real dedup row exists from the earlier real run');
  assert.ok(rows.some((r) => r.dedup_key === alertDedupKey({ alertType: 'no_response', clientId: 0, period: '' }) || /^\S+\|\d+\|\|/.test(r.dedup_key)), 'stored keys use the same format');
});

test('a fresh request (under threshold) is still skipped even in another month', async () => {
  captured.length = 0;
  const prev = previousYm();
  await pendingClient('Fresh PrevMonth Client', 'fresh-prev@nr.test', prev, 1);

  const res = await runNoResponseCheck({ smtpConfig: SMTP, appBaseUrl: 'https://app.nr.test' });
  assert.ok(res.skipped >= 1, 'the 1-day-old request is skipped as too recent');
  assert.strictEqual(captured.filter((m) => m.to === 'fresh-prev@nr.test').length, 0, 'no email to a too-recent request');
});

test('submitted requests are never reminded, in any month', async () => {
  captured.length = 0;
  const prev = previousYm();
  const { req } = await pendingClient('Already Submitted', 'done@nr.test', prev, 30);
  db.prepare('UPDATE feedback_requests SET submitted = 1 WHERE id = ?').run(req.id);

  const res = await runNoResponseCheck({ smtpConfig: SMTP, appBaseUrl: 'https://app.nr.test' });
  assert.strictEqual(captured.filter((m) => m.to === 'done@nr.test').length, 0, 'submitted client gets nothing');
  assert.ok(res.checked >= 0);
});

test('dryRun reports the same set a real run would act on, sends nothing, and reserves no dedup rows', async () => {
  captured.length = 0;
  const prev = previousYm();
  const { req } = await pendingClient('DryRun Target', 'dryrun@nr.test', prev, 12);
  const key = alertDedupKey({ alertType: 'no_response', clientId: (await db.prepare('SELECT id FROM clients WHERE email = ?').get('dryrun@nr.test')).id, period: prev });

  const before = captured.length;
  const dry = await runNoResponseCheck({ smtpConfig: SMTP, appBaseUrl: 'https://app.nr.test', dryRun: true });

  assert.strictEqual(dry.dryRun, true);
  assert.strictEqual(dry.reminded, 0, 'dry run reminded nobody');
  assert.strictEqual(dry.internalSent, 0, 'dry run sent no internal alert');
  assert.strictEqual(captured.length, before, 'dry run sent zero emails');
  assert.ok(dry.wouldRemind.some((w) => w.email === 'dryrun@nr.test'), 'dry run lists the target client');
  const listed = dry.wouldRemind.find((w) => w.email === 'dryrun@nr.test');
  assert.strictEqual(listed.link, `https://app.nr.test/feedback/${req.token}`, 'dry run reports the exact link');
  assert.ok(listed.days >= 5, 'dry run reports the age');

  // The important part: a dry run must NOT consume the dedup slot, or the real
  // scheduled run would silently skip this client forever.
  const stored = db.prepare('SELECT COUNT(*) n FROM alert_log WHERE dedup_key = ?').get(key);
  assert.strictEqual(stored.n, 0, 'dry run did NOT reserve the dedup row');

  const real = await runNoResponseCheck({ smtpConfig: SMTP, appBaseUrl: 'https://app.nr.test' });
  assert.strictEqual(real.reminded, 1, 'the real run afterwards still sends the reminder');
  const stored2 = db.prepare('SELECT COUNT(*) n FROM alert_log WHERE dedup_key = ?').get(key);
  assert.strictEqual(stored2.n, 1, 'the real run reserved the dedup row');
});

test('dryRun surfaces requests that an existing dedup row would block', async () => {
  const dry = await runNoResponseCheck({ smtpConfig: SMTP, appBaseUrl: 'https://app.nr.test', dryRun: true });
  assert.ok(dry.alreadyAlerted >= 1, 'previously-reminded requests are reported as already alerted');
  const blockedEmails = new Set(['crossmonth@nr.test']);
  for (const w of dry.wouldRemind) assert.ok(!blockedEmails.has(w.email), 'already-alerted client is not listed again');
});
