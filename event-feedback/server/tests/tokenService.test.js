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

test.after(async () => {
  await app.flushBackground();
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

test('tokenized form page has no service/project input, no eventName field, and no company name field', async () => {
  const client = await insertClient({ name: 'Form Client', email: 'form@client.com' });
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
    assert.ok(!html.includes('name="companyName"'), 'no company name field rendered');
    assert.ok(!html.includes('id="companyName"'), 'no company name input rendered');
    assert.ok(html.includes('value="Form Client"'), 'Name field is pre-filled from the client name');
    assert.ok(html.includes('name="token"'), 'hidden token still present');
    assert.ok(html.includes('ratingQuestions'), 'rating questions still rendered');
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    server.close();
  }
});

test('tokenized submission does not copy a client service name (falls back to "General")', async () => {
  const client = await insertClient({ name: 'Auto Service Co', email: 'auto@co.com' });
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
    assert.strictEqual(json.serviceType, 'General', 'tokenized submissions fall back to "General" (no client Service Type field)');
    assert.strictEqual(json.month, '2026-09', 'month comes from the feedback request');

    const rows = await queryFeedback();
    const row = rows.find((r) => r.submissionId === json.submissionId);
    assert.ok(row, 'submission stored');
    assert.strictEqual(row.serviceType, 'General');
    assert.strictEqual(row.month, '2026-09');
    assert.strictEqual(row.client_id, client.id);
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    server.close();
  }
});

test('tokenized submission ignores a tampered/typed eventName from the client', async () => {
  const client = await insertClient({ name: 'Tamper Co', email: 'tamper@co.com' });
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
    assert.strictEqual(json.serviceType, 'General', 'client-submitted eventName must never override and no client service is copied');

    const row = (await queryFeedback()).find((r) => r.submissionId === json.submissionId);
    assert.strictEqual(row.serviceType, 'General');
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    server.close();
  }
});

test('tokenized submission falls back to "General" (no client Service Type field) and logs no warning', async () => {
  const client = await insertClient({ name: 'No Service Co', email: 'noservice@co.com' });
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
    assert.strictEqual(json.serviceType, 'General', 'fallback is "General"');

    const row = (await queryFeedback()).find((r) => r.submissionId === json.submissionId);
    assert.strictEqual(row.serviceType, 'General');

    const relevant = warnings.filter((w) => w.includes('no service_type'));
    assert.strictEqual(relevant.length, 0, 'no service_type warning is logged');
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