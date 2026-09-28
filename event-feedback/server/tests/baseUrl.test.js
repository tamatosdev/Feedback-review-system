const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.DB_PATH = path.join(os.tmpdir(), `feedback-baseurl-${process.pid}.db`);
process.env.DATABASE_URL = '';
process.env.STORAGE_DRIVER = 'memory';
process.env.SMTP_PASS = 'test-pass';
process.env.ADMIN_EMAIL = 'admin@x.com';
process.env.LEADERSHIP_EMAILS = '';
process.env.GEMINI_API_KEY = '';

const { resolveBaseUrl, coerceBaseUrl, isLoopback, CANONICAL_BASE_URL } = require('../baseUrl');
const { dashboardUrl } = (() => {
  const alerts = require('../alerts');
  return { dashboardUrl: (b, id) => alerts.dashboardUrl ? alerts.dashboardUrl(b, id) : null };
})();

test.before(() => {
  const { db } = require('../db');
  db.exec('DELETE FROM feedback_requests');
  db.exec('DELETE FROM clients');
});
test.after(() => {
  const { db } = require('../db');
  db.close();
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch {} }
});

const PROD = { VERCEL: '1', NODE_ENV: 'production' };
const DEV = { NODE_ENV: 'development' };

test('isLoopback catches every loopback spelling', () => {
  for (const v of ['http://localhost:3000', 'localhost', 'https://127.0.0.1', 'http://127.0.0.1:8080/x', 'http://[::1]:3000', '0.0.0.0:3000']) {
    assert.strictEqual(isLoopback(v), true, `${v} should be loopback`);
  }
  for (const v of ['https://feedback.craftsmenmedia.com', 'http://app.test', 'https://example.com']) {
    assert.strictEqual(isLoopback(v), false, `${v} should not be loopback`);
  }
});

test('production: APP_BASE_URL wins', () => {
  assert.strictEqual(resolveBaseUrl({ ...PROD, APP_BASE_URL: 'https://feedback.craftsmenmedia.com', PUBLIC_URL: 'https://other.test' }),
    'https://feedback.craftsmenmedia.com');
});

test('production: PUBLIC_URL used when APP_BASE_URL unset', () => {
  assert.strictEqual(resolveBaseUrl({ ...PROD, PUBLIC_URL: 'https://other.test' }), 'https://other.test');
});

test('production: loopback APP_BASE_URL is refused in favour of the canonical domain', () => {
  assert.strictEqual(resolveBaseUrl({ ...PROD, APP_BASE_URL: 'http://localhost:3000' }), CANONICAL_BASE_URL);
});

test('production: nothing configured falls back to the canonical domain (never localhost)', () => {
  assert.strictEqual(resolveBaseUrl(PROD), CANONICAL_BASE_URL);
  assert.strictEqual(resolveBaseUrl({ ...PROD, APP_BASE_URL: '', PUBLIC_URL: '' }), CANONICAL_BASE_URL);
});

test('dev: no config still yields localhost so local development works', () => {
  assert.strictEqual(resolveBaseUrl(DEV), 'http://localhost:3000');
  assert.strictEqual(resolveBaseUrl({ ...DEV, PORT: '4000' }), 'http://localhost:4000');
});

test('coerceBaseUrl: an explicit public value always wins', () => {
  assert.strictEqual(coerceBaseUrl('https://app.test', PROD), 'https://app.test');
  assert.strictEqual(coerceBaseUrl('https://app.test/', PROD), 'https://app.test', 'trailing slash stripped');
});

test('coerceBaseUrl: production never returns a loopback value', () => {
  for (const v of ['', undefined, null, 'http://localhost:3000', 'http://127.0.0.1:8080', 'localhost:3000']) {
    const out = coerceBaseUrl(v, PROD);
    assert.strictEqual(isLoopback(out), false, `production coerceBaseUrl(${v}) returned loopback: ${out}`);
    assert.strictEqual(out, CANONICAL_BASE_URL);
  }
});

test('coerceBaseUrl: dev still honours an explicit loopback value (tests/dev servers)', () => {
  assert.strictEqual(coerceBaseUrl('http://127.0.0.1:1234', DEV), 'http://127.0.0.1:1234');
});

// End-to-end: the exact reported failure. A localhost appBaseUrl reaching the
// monthly send in production must still produce a clickable public link.
test('monthly send in production never emails a localhost link', async () => {
  const { db, insertClient } = require('../db');
  const { sendMonthlyFeedbackForms } = require('../jobs/monthlySend');
  const captured = [];
  const nodemailer = require('nodemailer');
  const realCreate = nodemailer.createTransport;
  nodemailer.createTransport = () => ({ sendMail: async (m) => { captured.push(m); return { messageId: 'x' }; } });

  db.exec('DELETE FROM feedback_requests');
  db.exec('DELETE FROM clients');
  insertClient({ name: 'LinkCheck', email: 'lc@client.com', accountManagerEmail: 'am@agency.com' });

  const prevVercel = process.env.VERCEL;
  const prevNode = process.env.NODE_ENV;
  process.env.VERCEL = '1';
  process.env.NODE_ENV = 'production';
  try {
    await sendMonthlyFeedbackForms({
      smtpConfig: { smtpUser: 'u@x.com', smtpHost: 'smtp', smtpPass: 'p', adminEmail: 'admin@x.com' },
      appBaseUrl: 'http://localhost:3000', // the misconfiguration being defended against
      cronSecret: 's',
      offset: 0
    });
  } finally {
    if (prevVercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = prevVercel;
    if (prevNode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevNode;
    nodemailer.createTransport = realCreate;
  }

  const clientMail = captured.find((m) => m.to === 'lc@client.com');
  assert.ok(clientMail, 'client feedback email was sent');
  const link = (clientMail.text.match(/https?:\/\/\S+/) || [])[0];
  assert.ok(link, 'email contains a link');
  assert.ok(link.startsWith('https://feedback.craftsmenmedia.com/feedback/'),
    'link must be the public domain in production, got: ' + link);
  assert.ok(!clientMail.text.includes('localhost'), 'no localhost anywhere in the client email');
});
