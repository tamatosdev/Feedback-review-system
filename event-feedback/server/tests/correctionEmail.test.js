const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.DB_PATH = path.join(os.tmpdir(), `feedback-correct-${process.pid}.db`);
process.env.DATABASE_URL = '';
process.env.STORAGE_DRIVER = 'memory';
process.env.SMTP_PASS = 'p';
process.env.ADMIN_EMAIL = 'a@x.com';
process.env.GEMINI_API_KEY = '';

const captured = [];
const nodemailer = require('nodemailer');
nodemailer.createTransport = () => ({ sendMail: async (m) => { captured.push(m); return { messageId: 't', accepted: [m.to] }; } });

const { sendClientFeedbackRequest } = require('../email');
const CFG = { smtpUser: 'u@x.com', smtpHost: 'smtp', smtpPass: 'p', adminEmail: 'a@x.com' };

test.before(() => { captured.length = 0; });
test.after(() => {
  const { db } = require('../db');
  db.close();
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch {} }
});

test('default subject and no intro (unchanged behaviour)', async () => {
  await sendClientFeedbackRequest(CFG, { name: 'Acme', email: 'a@c.com' }, 'https://x.test/feedback/tok');
  const m = captured.at(-1);
  assert.strictEqual(m.subject, 'Client Feedback | Craftsmen Media');
  assert.ok(!m.text.startsWith('Apologies'));
  assert.ok(!m.html.includes('Apologies'));
});

test('correction options override the subject and prepend an intro', async () => {
  await sendClientFeedbackRequest(CFG, { name: 'Acme', email: 'a@c.com' }, 'https://x.test/feedback/tok', {
    subject: 'Corrected: Client Feedback Link | Craftsmen Media',
    intro: 'Apologies - the earlier link was incorrect.'
  });
  const m = captured.at(-1);
  assert.strictEqual(m.subject, 'Corrected: Client Feedback Link | Craftsmen Media');
  assert.ok(m.text.startsWith('Apologies - the earlier link was incorrect.'));
  assert.ok(m.html.includes('Apologies - the earlier link was incorrect.'));
  assert.ok(m.text.includes('https://x.test/feedback/tok'), 'link still present after intro');
});

test('the link is passed through verbatim, never rewritten', async () => {
  const link = 'https://feedback.craftsmenmedia.com/feedback/abc-123';
  await sendClientFeedbackRequest(CFG, { name: 'Acme', email: 'a@c.com' }, link, { intro: 'Corrected link below.' });
  const m = captured.at(-1);
  assert.ok(m.text.includes(link));
  assert.ok(m.html.includes(link));
});

test('intro is HTML-escaped', async () => {
  await sendClientFeedbackRequest(CFG, { name: 'Acme', email: 'a@c.com' }, 'https://x.test/f/t', {
    intro: 'Bad <script>alert(1)</script> & "quoted"'
  });
  const m = captured.at(-1);
  assert.ok(!m.html.includes('<script>'), 'script tag must be escaped');
  assert.ok(m.html.includes('&lt;script&gt;'));
});
