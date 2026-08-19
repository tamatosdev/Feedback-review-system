const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

process.env.DB_PATH = path.join(os.tmpdir(), `feedback-token-service-test-${process.pid}.db`);
process.env.DATABASE_URL = '';
process.env.STORAGE_DRIVER = 'memory';

const { db, insertClient, insertFeedbackRequest, queryFeedback } = require('../db');
const app = require('../index.js');

test.before(async () => {
  db.exec('DELETE FROM feedback_requests');
  db.exec('DELETE FROM clients');
  db.exec('DELETE FROM feedback_reports');
});

test.after(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch {}
  }
});

function submitBody(overrides = {}) {
  return {
    attendeeName: 'Tester',
    attendeeEmail: 'tester@example.com',
    accountManagementScore: 5,
    strategyScore: 4,
    creativeScore: 3,
    designContentScore: 4,
    socialContentScore: 5,
    agencyLeadershipScore: 4,
    comments: 'nice',
    suggestions: '',
    ...overrides
  };
}

test('tokenized form page has no service/project input and no eventName field', async () => {
  const client = await insertClient({ name: 'Form Client', email: 'form@client.com', service_type: 'Branding Package' });
  const token = crypto.randomUUID();
  await insertFeedbackRequest({ client_id: client.id, month: '2026-09', token });

  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/feedback/${token}`);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(!html.includes('name="eventName"'), 'form must not submit an eventName field');
    assert.ok(!html.includes('id="eventName"'), 'no service input rendered');
    assert.ok(!html.includes('>Service</label>') && !html.includes('for="eventName"'), 'no Service label rendered');
    assert.ok(html.includes('name="token"'), 'hidden token still present');
    assert.ok(html.includes('ratingQuestions'), 'rating questions still rendered');
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    server.close();
  }
});

test('tokenized submission stores the client service_type server-side (no service field submitted)', async () => {
  const client = await insertClient({ name: 'Auto Service Co', email: 'auto@co.com', service_type: 'Website Revamp' });
  const token = crypto.randomUUID();
  await insertFeedbackRequest({ client_id: client.id, month: '2026-09', token });

  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(submitBody({ token }))
    });
    assert.strictEqual(res.status, 201);
    const json = await res.json();
    assert.strictEqual(json.ok, true);
    assert.strictEqual(json.serviceType, 'Website Revamp', 'service comes from the client record');
    assert.strictEqual(json.month, '2026-09', 'month comes from the feedback request');

    const rows = await queryFeedback();
    const row = rows.find((r) => r.submissionId === json.submissionId);
    assert.ok(row, 'submission stored');
    assert.strictEqual(row.serviceType, 'Website Revamp');
    assert.strictEqual(row.month, '2026-09');
    assert.strictEqual(row.client_id, client.id);
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    server.close();
  }
});

test('tokenized submission ignores a tampered/typed eventName from the client', async () => {
  const client = await insertClient({ name: 'Tamper Co', email: 'tamper@co.com', service_type: 'Social Retainer' });
  const token = crypto.randomUUID();
  await insertFeedbackRequest({ client_id: client.id, month: '2026-09', token });

  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(submitBody({ token, eventName: 'Hacked Project Name' }))
    });
    const json = await res.json();
    assert.strictEqual(json.ok, true);
    assert.strictEqual(json.serviceType, 'Social Retainer', 'client-submitted eventName must never override the client record');

    const row = (await queryFeedback()).find((r) => r.submissionId === json.submissionId);
    assert.strictEqual(row.serviceType, 'Social Retainer');
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    server.close();
  }
});

test('tokenized submission with blank client service_type falls back to "General" and logs a warning', async () => {
  const client = await insertClient({ name: 'No Service Co', email: 'noservice@co.com', service_type: '' });
  const token = crypto.randomUUID();
  await insertFeedbackRequest({ client_id: client.id, month: '2026-09', token });

  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));

  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(submitBody({ token }))
    });
    const json = await res.json();
    assert.strictEqual(json.ok, true);
    assert.strictEqual(json.serviceType, 'General', 'fallback is "General", not "Unnamed Event"');

    const row = (await queryFeedback()).find((r) => r.submissionId === json.submissionId);
    assert.strictEqual(row.serviceType, 'General');

    const relevant = warnings.filter((w) => w.includes('no service_type'));
    assert.strictEqual(relevant.length, 1, 'a warning is logged for the missing service_type');
    assert.ok(relevant[0].includes('No Service Co') || relevant[0].includes('noservice@co.com'));
  } finally {
    console.warn = originalWarn;
    if (server.closeAllConnections) server.closeAllConnections();
    server.close();
  }
});

test('untokened path keeps manual service/project name behavior', async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const withName = await (await fetch(`${base}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(submitBody({ eventName: 'Custom Project 2026' }))
    })).json();
    assert.strictEqual(withName.ok, true);
    assert.strictEqual(withName.serviceType, 'Custom Project 2026');

    const noName = await (await fetch(`${base}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(submitBody({}))
    })).json();
    assert.strictEqual(noName.ok, true);
    assert.strictEqual(noName.serviceType, 'Unnamed Event', 'untokened blank service keeps the existing default');

    const rows = await queryFeedback();
    assert.ok(rows.some((r) => r.submissionId === withName.submissionId && r.serviceType === 'Custom Project 2026'));
    assert.ok(rows.some((r) => r.submissionId === noName.submissionId && r.serviceType === 'Unnamed Event'));
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    server.close();
  }
});