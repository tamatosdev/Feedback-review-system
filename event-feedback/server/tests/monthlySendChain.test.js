const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Local SQLite + stubbed SMTP, never touches the real DB or SMTP.
process.env.DB_PATH = path.join(os.tmpdir(), `feedback-chain-${process.pid}.db`);
process.env.DATABASE_URL = '';
process.env.STORAGE_DRIVER = 'memory';
process.env.SMTP_PASS = 'test-pass';
process.env.ADMIN_EMAIL = 'admin@x.com';
process.env.LEADERSHIP_EMAILS = '';
process.env.GEMINI_API_KEY = '';

const nodemailer = require('nodemailer');
nodemailer.createTransport = () => ({ sendMail: async () => ({ messageId: 'test' }) });

const { db, insertClient } = require('../db');
const { sendMonthlyFeedbackForms } = require('../jobs/monthlySend');

const BASE_CONFIG = { smtpUser: 'u@x.com', smtpHost: 'smtp', smtpPass: 'p', adminEmail: 'admin@x.com' };

function wipe() {
  db.exec('DELETE FROM feedback_requests');
  db.exec('DELETE FROM clients');
}

function seedActive(n) {
  for (let i = 0; i < n; i++) {
    insertClient({ name: `C${i}`, email: `c${i}@client.com`, accountManagerEmail: 'am@agency.com' });
  }
}

// A real HTTP server stands in for the next Vercel invocation, so the chain is
// exercised over real HTTP (no global.fetch monkey-patching, which other tests
// in the suite interfere with).
function startChainServer({ delayMs = 0 } = {}) {
  const received = [];
  let responded = false;
  const server = http.createServer((req, res) => {
    received.push({ method: req.method, url: req.url, headers: req.headers });
    setTimeout(() => {
      responded = true;
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, processing: true }));
    }, delayMs);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        received,
        isResponded: () => responded,
        url: `http://127.0.0.1:${server.address().port}/api/cron/monthly-send`,
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

test.before(() => wipe());
test.after(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch {}
  }
});

// Regression: the chain fetch used to be fire-and-forget. The function returned,
// Vercel's waitUntil() settled, the runtime froze the instance and the request
// for the next batch was killed - the run silently stopped after batch 1.
// The chain must therefore be awaited: the next invocation must have completed
// its response BEFORE sendMonthlyFeedbackForms resolves.
test('awaits the chain: the next batch responds before the function returns', async () => {
  wipe();
  seedActive(11); // 10 in batch 1, 1 left over -> must chain
  const chain = await startChainServer({ delayMs: 150 });
  try {
    await sendMonthlyFeedbackForms({
      smtpConfig: BASE_CONFIG,
      appBaseUrl: chain.url,
      cronSecret: 'secret',
      selfUrl: chain.url,
      offset: 0
    });
  } finally {
    await chain.close();
  }
  assert.strictEqual(chain.received.length, 1, 'exactly one chained request');
  assert.strictEqual(chain.isResponded(), true,
    'chain fetch must have COMPLETED before the function returned (was fire-and-forget)');
});

test('chain uses the configured base URL, POSTs, and carries the cron secret', async () => {
  wipe();
  seedActive(11);
  const chain = await startChainServer();
  try {
    await sendMonthlyFeedbackForms({
      smtpConfig: BASE_CONFIG,
      appBaseUrl: chain.url,
      cronSecret: 'sekret',
      selfUrl: chain.url,
      offset: 0
    });
  } finally {
    await chain.close();
  }
  const req = chain.received[0];
  assert.ok(req, 'chain request was made');
  assert.strictEqual(req.method, 'POST');
  assert.strictEqual(req.url, '/api/cron/monthly-send?offset=10');
  assert.strictEqual(req.headers['x-cron-secret'], 'sekret');
});

test('an unset CRON_SECRET still chains (must not silently disable the chain)', async () => {
  wipe();
  seedActive(11);
  const chain = await startChainServer();
  try {
    await sendMonthlyFeedbackForms({
      smtpConfig: BASE_CONFIG,
      appBaseUrl: chain.url,
      cronSecret: '',
      selfUrl: chain.url,
      offset: 0
    });
  } finally {
    await chain.close();
  }
  assert.strictEqual(chain.received.length, 1,
    'chain must fire even when cronSecret is empty');
});

test('no chain is attempted when the batch covers the whole list', async () => {
  wipe();
  seedActive(3);
  const chain = await startChainServer();
  try {
    const summary = await sendMonthlyFeedbackForms({
      smtpConfig: BASE_CONFIG,
      appBaseUrl: chain.url,
      cronSecret: 'secret',
      selfUrl: chain.url,
      offset: 0
    });
    assert.strictEqual(summary.moreRemaining, false);
  } finally {
    await chain.close();
  }
  assert.strictEqual(chain.received.length, 0, 'must not chain when nothing remains');
});
