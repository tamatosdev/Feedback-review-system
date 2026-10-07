const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

process.env.DB_PATH = path.join(os.tmpdir(), `feedback-combined-${process.pid}.db`);
process.env.DATABASE_URL = '';
process.env.STORAGE_DRIVER = 'disk';
process.env.SMTP_PASS = 'test-pass';
process.env.ADMIN_EMAIL = 'admin@combined.test';
process.env.GEMINI_API_KEY = '';
delete process.env.ALERT_EMAIL;
delete process.env.VERCEL;
// Keep the admin session gate off so the endpoint is reachable in-process.
delete process.env.ADMIN_USERNAME;
delete process.env.ADMIN_PASSWORD;
delete process.env.SESSION_SECRET;
delete process.env.APP_BASE_URL;
delete process.env.PUBLIC_URL;

// email.js calls nodemailer.createTransport() at call time, so stubbing it
// here intercepts every send without touching index.js's destructured imports.
const sent = [];
const nodemailer = require('nodemailer');
nodemailer.createTransport = () => ({
  sendMail: async (mail) => { sent.push(mail); return { messageId: 'm' + sent.length, accepted: [mail.to] }; }
});

const { db, insertClient, insertFeedback } = require('../db');
const app = require('../index');
const { generateSixMonthReport } = require('../jobs/sixMonthReport');
const storage = require('../storage');

// index.js defines savePdf/saveHtml privately (lines 172/181) and injects them
// into generateSixMonthReport; they are not exported. These mirror that exact
// behaviour so the scheduled path under test writes through the same driver.
async function savePdf(buffer, fileName) {
  try { return await storage.saveReport(fileName, buffer, 'application/pdf'); }
  catch (err) { return { size: buffer.length, fallback: true }; }
}
async function saveHtml(html, fileName) {
  try { return await storage.saveReport(fileName, Buffer.from(html), 'text/html; charset=utf-8'); }
  catch (err) { return { size: Buffer.byteLength(html), fallback: true }; }
}

const SMTP = { smtpHost: 'smtp.test', smtpPort: 587, smtpUser: 'u@combined.test', smtpPass: 'test-pass', adminEmail: 'admin@combined.test' };
const RANGE = { from: '2026-01-01', to: '2026-12-31' };

function listen() {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}
function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

let seedClientId = null;

function seed(month, overrides = {}) {
  return insertFeedback({
    submissionId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    serviceType: 'Test Service',
    month,
    client_id: seedClientId,
    attendeeName: 'Seed',
    attendeeEmail: 'seed@test.com',
    hasValidEmail: 1,
    companyName: 'Seed Co',
    rating: 4,
    accountManagementScore: 4,
    strategyScore: 4,
    creativeScore: 4,
    designContentScore: 4,
    socialContentScore: 4,
    agencyLeadershipScore: 4,
    comments: 'Combined report test submission',
    suggestions: '',
    sentiment: 'Positive',
    summary: 'seeded',
    urgency: 'Low',
    highlights: [],
    improvementSuggestions: [],
    pdfUrl: '',
    emailSent: 0,
    ...overrides
  });
}

test.before(async () => {
  db.exec('DELETE FROM alert_log');
  db.exec('DELETE FROM feedback_requests');
  db.exec('DELETE FROM feedback_reports');
  db.exec('DELETE FROM clients');
  // feedback_reports has a FK on clients.id, so a real client must exist
  // before anything can be seeded against it.
  const client = await insertClient({ name: 'Seed Client', email: 'seed@combined.test' });
  seedClientId = client.id;
  await seed('2026-08');
});

// Files written to the (gitignored) reports/ dir during the run, removed after.
const cleanupFiles = [];

function trackReport(pdfFileName) {
  cleanupFiles.push(pdfFileName, pdfFileName.replace(/\.pdf$/, '.html'));
}

test.after(() => {
  db.close();
  for (const name of cleanupFiles) {
    try { fs.unlinkSync(path.join(storage.reportsDir, name)); } catch {}
  }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch {}
  }
});

async function postCombined(base, body) {
  const res = await fetch(`${base}/api/reports/combined`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { res, json: await res.json() };
}

test('dashboard path: sendEmail:false generates the PDF and sends NO email', async () => {
  const server = await listen();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    sent.length = 0;
    const { res, json } = await postCombined(base, { ...RANGE, sendEmail: false });

    assert.strictEqual(res.status, 200, 'endpoint succeeds');
    assert.strictEqual(json.ok, true);
    assert.strictEqual(json.emailSent, false, 'emailSent is false');
    assert.strictEqual(json.emailSkipped, true, 'emailSkipped marks it as not attempted');
    assert.ok(json.pdfFileName, 'a PDF file name is returned');
    trackReport(json.pdfFileName);
    assert.ok(json.count >= 1, 'the report covers the seeded submission');
    assert.strictEqual(sent.length, 0, 'NOT ONE email was handed to the transport');

    // The bytes must actually be downloadable from the same-origin route the
    // browser uses to save the file.
    const dl = await fetch(`${base}/reports/${encodeURIComponent(json.pdfFileName)}`);
    assert.strictEqual(dl.status, 200, 'report route serves the file');
    const buf = Buffer.from(await dl.arrayBuffer());
    assert.ok(buf.length > 0, 'file has bytes');
    assert.strictEqual(buf.subarray(0, 4).toString('latin1'), '%PDF', 'downloaded bytes are a real PDF');
    assert.strictEqual(sent.length, 0, 'still no email after fetching the file');
  } finally {
    await stopServer(server);
  }
});

test('backward compat: omitting sendEmail still sends the email', async () => {
  const server = await listen();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    sent.length = 0;
    const { res, json } = await postCombined(base, { ...RANGE });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(json.ok, true);
    assert.strictEqual(json.emailSent, true, 'default behaviour (no flag) still emails');
    assert.strictEqual(json.emailSent, true);
    assert.strictEqual(json.emailSkipped, false, 'emailSkipped only set when explicitly requested');
    assert.strictEqual(sent.length, 1, 'exactly one email sent by the default path');
    assert.ok(json.pdfFileName, 'the PDF is still produced');
    trackReport(json.pdfFileName);
  } finally {
    await stopServer(server);
  }
});

test('the scheduled 6-month job still emails the report (unaffected by the flag)', async () => {
  const currentYm = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  })();
  await seed(currentYm);

  sent.length = 0;
  const result = await generateSixMonthReport({
    smtpConfig: SMTP,
    geminiApiKey: '',
    reportUrl: storage.reportUrl,
    fallbackReportUrl: storage.fallbackReportUrl,
    savePdf,
    saveHtml
  });

  assert.strictEqual(result.ok, true, 'job succeeds');
  assert.ok(result.count >= 1, 'job produced a report');
  assert.strictEqual(result.emailSent, true, 'SCHEDULED PATH STILL EMAILS');
  assert.strictEqual(sent.length, 1, 'exactly one combined email went out');
  assert.ok(result.pdfFileName, 'it saved a PDF');
  trackReport(result.pdfFileName);
  assert.ok(!result.pdfFileName.includes('client-'),
    'the cron has no client filter, so its file name and behaviour are unchanged');
  assert.strictEqual(result.emailSkipped, undefined, 'the job has no skip concept - it is unchanged');
});

// When STORAGE_DRIVER=memory (Vercel without storage credentials) nothing is
// persisted, so /reports/ has to regenerate from the database. That path used
// to 404 for full-date filenames because COMBINED_FILE_RE only matched the
// cron's month-shaped names.
test('GET /reports regenerates a combined report when nothing is stored', async () => {
  const server = await listen();
  const base = `http://127.0.0.1:${server.address().port}`;
  const shapes = [
    { file: 'combined-2026-01-01-to-2026-12-31.pdf', label: 'full-date shape (dashboard endpoint)' },
    { file: 'combined-2026-04-to-2026-09.pdf', label: 'month shape (6-month cron)' }
  ];
  try {
    for (const { file, label } of shapes) {
      // Force the regeneration branch regardless of what earlier tests wrote.
      try { fs.unlinkSync(path.join(storage.reportsDir, file)); } catch {}

      const res = await fetch(`${base}/reports/${encodeURIComponent(file)}`);
      assert.strictEqual(res.status, 200, `regenerates for ${label}`);
      const buf = Buffer.from(await res.arrayBuffer());
      assert.strictEqual(buf.subarray(0, 4).toString('latin1'), '%PDF',
        `regenerated bytes are a PDF for ${label}`);
    }
  } finally {
    await stopServer(server);
  }
});

// "All Time" sends no dates: computeRange('alltime') returns empty bounds on
// purpose, so the endpoint has to treat empty/empty as "no filter" instead of
// rejecting it as a missing range.
test('sendEmail:false with no dates (All Time) covers every submission', async () => {
  const server = await listen();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    sent.length = 0;
    const total = db.prepare('SELECT COUNT(*) AS n FROM feedback_reports').get().n;

    const { res, json } = await postCombined(base, { from: '', to: '', sendEmail: false });

    assert.strictEqual(res.status, 200, 'an empty range is accepted, not a 400');
    assert.strictEqual(json.ok, true);
    assert.strictEqual(json.allTime, true, 'the response says it was unfiltered');
    assert.strictEqual(json.count, total, 'every row is included - nothing was filtered out');
    assert.strictEqual(json.pdfFileName, 'combined-0000-01-01-to-9999-12-31.pdf',
      'sentinel bounds keep the name inside COMBINED_FILE_RE');
    assert.strictEqual(json.emailSent, false);
    assert.strictEqual(json.emailSkipped, true);
    assert.strictEqual(sent.length, 0, 'still no email');
    trackReport(json.pdfFileName);

    const dl = await fetch(`${base}/reports/${encodeURIComponent(json.pdfFileName)}`);
    assert.strictEqual(dl.status, 200, 'the All Time file downloads');
    const buf = Buffer.from(await dl.arrayBuffer());
    assert.strictEqual(buf.subarray(0, 4).toString('latin1'), '%PDF', 'downloaded bytes are a PDF');
  } finally {
    await stopServer(server);
  }
});

test('only one of from/to is a 400, not a silent half-report', async () => {
  const server = await listen();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    sent.length = 0;
    const half = await postCombined(base, { from: '2026-01-01', to: '', sendEmail: false });
    assert.strictEqual(half.res.status, 400, 'From without To is rejected');
    assert.ok(half.json.error, 'the rejection explains itself');

    const other = await postCombined(base, { from: '', to: '2026-06-30', sendEmail: false });
    assert.strictEqual(other.res.status, 400, 'To without From is rejected');

    assert.strictEqual(sent.length, 0, 'rejected requests never send anything');
  } finally {
    await stopServer(server);
  }
});

test('the All Time file can still be regenerated when nothing is stored', async () => {
  const server = await listen();
  const base = `http://127.0.0.1:${server.address().port}`;
  const file = 'combined-0000-01-01-to-9999-12-31.pdf';
  try {
    try { fs.unlinkSync(path.join(storage.reportsDir, file)); } catch {}
    const res = await fetch(`${base}/reports/${encodeURIComponent(file)}`);
    assert.strictEqual(res.status, 200, 'sentinel bounds regenerate over the whole table');
    const buf = Buffer.from(await res.arrayBuffer());
    assert.strictEqual(buf.subarray(0, 4).toString('latin1'), '%PDF');
  } finally {
    await stopServer(server);
  }
});

// dashboard.html loads the shared validator from /reportRange.js, so the file
// has to survive the same static/fallback chain the page itself goes through.
test('the dashboard validation script is served by the app', async () => {
  const server = await listen();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/reportRange.js`);
    assert.strictEqual(res.status, 200, '/reportRange.js is reachable');
    const body = await res.text();
    assert.ok(body.includes('function validate'), 'the validator is in the served file');
    assert.ok(body.includes('ALL_TIME_RANGE'), 'the All Time key is exported');
  } finally {
    await stopServer(server);
  }
});

// A second client whose rows must never appear in a report scoped to the first.
let otherClientId = null;

async function seedOtherClient() {
  if (otherClientId) return otherClientId;
  const other = await insertClient({ name: 'Other Client Ltd', email: 'other@combined.test' });
  otherClientId = other.id;
  await seed('2026-08', {
    client_id: other.id,
    attendeeName: 'Zed Exclusive Attendee',
    companyName: 'Other Client Ltd'
  });
  return otherClientId;
}

test('the report honours the Client filter, including with All Time', async () => {
  const otherId = await seedOtherClient();
  const server = await listen();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    sent.length = 0;
    const scoped = db.prepare('SELECT COUNT(*) AS n FROM feedback_reports WHERE client_id = ?')
      .get(seedClientId).n;
    assert.ok(scoped >= 1, 'the scoped client has rows to report on');

    // All Time (empty bounds) + a specific client: everything that client ever
    // submitted, and nothing from anyone else.
    const { res, json } = await postCombined(base, {
      from: '', to: '', client: String(seedClientId), sendEmail: false
    });

    assert.strictEqual(res.status, 200, 'client + All Time is a valid combination');
    assert.strictEqual(json.ok, true);
    assert.strictEqual(json.allTime, true, 'the date side is still unfiltered');
    assert.strictEqual(json.clientName, 'Seed Client', 'the response names the client');
    assert.strictEqual(json.count, scoped, 'only that client\'s submissions are counted');
    assert.strictEqual(json.pdfFileName,
      `combined-0000-01-01-to-9999-12-31-client-${seedClientId}.pdf`,
      'the client is encoded so it cannot overwrite the all-clients file');
    assert.strictEqual(sent.length, 0, 'still no email');
    trackReport(json.pdfFileName);

    const htmlRes = await fetch(`${base}/reports/${encodeURIComponent(json.pdfFileName.replace(/\.pdf$/, '.html'))}`);
    assert.strictEqual(htmlRes.status, 200, 'the HTML twin is served');
    const html = await htmlRes.text();
    assert.ok(html.includes('Combined Client Feedback Report — Seed Client'),
      'the report title says who it is for');
    assert.ok(!html.includes('Zed Exclusive Attendee'), 'the other client\'s rows are excluded');

    assert.notStrictEqual(otherId, null, 'a second client exists for contrast');
  } finally {
    await stopServer(server);
  }
});

test('an all-clients report is unchanged when no client is selected', async () => {
  await seedOtherClient();
  const server = await listen();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    sent.length = 0;
    const total = db.prepare('SELECT COUNT(*) AS n FROM feedback_reports').get().n;

    const { res, json } = await postCombined(base, { from: '', to: '', client: '', sendEmail: false });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(json.client, '', 'no client filter was sent');
    assert.strictEqual(json.clientName, '', 'no client in the title');
    assert.strictEqual(json.count, total, 'every submission is included');
    assert.strictEqual(json.pdfFileName, 'combined-0000-01-01-to-9999-12-31.pdf',
      'the all-clients file name keeps its old shape');
    trackReport(json.pdfFileName);

    const htmlRes = await fetch(`${base}/reports/${encodeURIComponent(json.pdfFileName.replace(/\.pdf$/, '.html'))}`);
    const html = await htmlRes.text();
    assert.ok(html.includes('Zed Exclusive Attendee'), 'all clients are present');
    assert.ok(!html.includes('Combined Client Feedback Report —'),
      'the generic title stays generic');
    assert.strictEqual(sent.length, 0);
  } finally {
    await stopServer(server);
  }
});

test('a client-filtered file regenerates with the same rows when nothing is stored', async () => {
  const server = await listen();
  const base = `http://127.0.0.1:${server.address().port}`;
  const file = `combined-0000-01-01-to-9999-12-31-client-${seedClientId}.html`;
  try {
    try { fs.unlinkSync(path.join(storage.reportsDir, file)); } catch {}
    const res = await fetch(`${base}/reports/${encodeURIComponent(file)}`);
    assert.strictEqual(res.status, 200, 'the -client- suffix still matches COMBINED_FILE_RE');
    const html = await res.text();
    assert.ok(html.includes('Seed Client'), 'regeneration restores the client title');
    assert.ok(!html.includes('Zed Exclusive Attendee'), 'regeneration applies the client filter too');
  } finally {
    await stopServer(server);
  }
});

test('a bad client filter is a 400, not an unfiltered report', async () => {
  const server = await listen();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    sent.length = 0;
    const unknown = await postCombined(base, { from: '', to: '', client: '999999', sendEmail: false });
    assert.strictEqual(unknown.res.status, 400, 'unknown client id is rejected');

    const bogus = await postCombined(base, { from: '', to: '', client: 'not-a-number', sendEmail: false });
    assert.strictEqual(bogus.res.status, 400, 'non-numeric client id is rejected');
    assert.ok(bogus.json.error, 'the rejection explains itself');

    assert.strictEqual(sent.length, 0, 'rejected requests never send anything');
  } finally {
    await stopServer(server);
  }
});
