const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');

// Force local SQLite + in-memory report storage before anything is required.
process.env.DB_PATH = path.join(os.tmpdir(), `feedback-am-test-${process.pid}.db`);
process.env.DATABASE_URL = '';
process.env.STORAGE_DRIVER = 'memory';
process.env.SMTP_PASS = 'test-pass';
process.env.ADMIN_EMAIL = 'admin@am.test';
process.env.SYNC_SECRET = 'test-secret';
process.env.GEMINI_API_KEY = '';

const csvServer = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.end('Name,Email,Service Type,Account Manager Name,Account Manager Email\nCSV AM,csv@sync.com,Retainer,Bob,bob@agency.com\nCSV Bad,csvbad@sync.com,,Bob,NotAnEmail\n');
});

// Capture every outbound email so we can assert recipients without a real SMTP.
const captured = [];
const nodemailer = require('nodemailer');
nodemailer.createTransport = () => ({
  sendMail: async (mail) => { captured.push(mail); return { messageId: 'test-message-id' }; }
});

const { db, insertClient, insertFeedbackRequest, getClient, upsertClientByEmail, insertFeedback, clientFeedbackReportCount } = require('../db');
let app;

// The pull sync reads SHEET_CSV_URL at module load, so start the sheet server
// and point at it, then require the app (mirrors departments.test.js).
test.before(async () => {
  await new Promise((resolve) => csvServer.listen(0, resolve));
  process.env.SHEET_CSV_URL = `http://127.0.0.1:${csvServer.address().port}/clients.csv`;
  app = require('../index.js');

  db.exec('DELETE FROM feedback_requests');
  db.exec('DELETE FROM clients');
  db.exec('DELETE FROM feedback_reports');
});

test.after(async () => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch {}
  }
  await new Promise((resolve) => csvServer.close(resolve));
});

function startServer() {
  const server = app.listen(0);
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}
function stopServer(server) {
  if (server.closeAllConnections) server.closeAllConnections();
  server.close();
}

function feedbackBody(token, overrides = {}) {
  return {
    token,
    attendeeName: 'Tester',
    attendeeEmail: 'tester@example.com',
    accountManagementScore: 5,
    strategyScore: 5,
    creativeScore: 5,
    designContentScore: 5,
    socialContentScore: 5,
    agencyLeadershipScore: 5,
    comments: 'x',
    suggestions: '',
    ...overrides
  };
}

function feedbackMails() {
  return captured.filter((m) => m.subject.startsWith('New Client Feedback'));
}

test('POST /api/clients + GET stores Account Manager Email; PATCH updates it', async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const created = await (await fetch(`${base}/api/clients`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'AM Client',
        email: 'am@client.com',
        accountManagerEmail: 'jane@agency.com'
      })
    })).json();
    assert.strictEqual(created.ok, true);
    assert.strictEqual(created.data.accountManagerEmail, 'jane@agency.com');

    const list = await (await fetch(`${base}/api/clients`)).json();
    const row = list.data.find((c) => c.email === 'am@client.com');
    assert.strictEqual(row.accountManagerEmail, 'jane@agency.com');

    const patched = await (await fetch(`${base}/api/clients/${created.data.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountManagerEmail: 'jane.new@agency.com' })
    })).json();
    assert.strictEqual(patched.data.accountManagerEmail, 'jane.new@agency.com');

    const bad = await fetch(`${base}/api/clients/${created.data.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountManagerEmail: 'not-an-email' })
    });
    assert.strictEqual(bad.status, 400, 'invalid manager email rejected by PATCH');
  } finally {
    stopServer(server);
  }
});

test('PATCH /api/clients/:id updates name and email, validates them, and leaves other clients untouched', async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const created = await (await fetch(`${base}/api/clients`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Edit Me', email: 'edit@client.com', status: 'active' })
    })).json();
    assert.strictEqual(created.ok, true);

    // a second client that must NOT change
    const other = await (await fetch(`${base}/api/clients`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Other Co', email: 'other@client.com' })
    })).json();
    assert.strictEqual(other.ok, true);

    // update name + email
    const patched = await (await fetch(`${base}/api/clients/${created.data.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed Client', email: 'renamed@client.com' })
    })).json();
    assert.strictEqual(patched.ok, true);
    assert.strictEqual(patched.data.name, 'Renamed Client');
    assert.strictEqual(patched.data.email, 'renamed@client.com');
    // unchanged fields persist
    assert.strictEqual(patched.data.status, 'active');

    // blank name rejected
    const emptyName = await fetch(`${base}/api/clients/${created.data.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '   ' })
    });
    assert.strictEqual(emptyName.status, 400, 'blank name rejected');

    // invalid email rejected
    const badEmail = await fetch(`${base}/api/clients/${created.data.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nope' })
    });
    assert.strictEqual(badEmail.status, 400, 'invalid email rejected');

    // other client untouched (by email + name)
    const after = await (await fetch(`${base}/api/clients`)).json();
    const otherRow = after.data.find((c) => c.id === other.data.id);
    assert.strictEqual(otherRow.name, 'Other Co', 'other client name unchanged');
    assert.strictEqual(otherRow.email, 'other@client.com', 'other client email unchanged');
  } finally {
    stopServer(server);
  }
});

test('POST /api/clients/sync (push) maps AM columns and skips invalid manager email', async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/clients/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sync-Secret': 'test-secret' },
      body: JSON.stringify({ clients: [
        { Name: 'Good AM', Email: 'good@sync.com', 'Service Type': 'Retainer', 'Account Manager Email': 'sam@agency.com' },
        { Name: 'Bad AM', Email: 'bad@sync.com', 'Account Manager Email': 'garbage' }
      ] })
    });
    const json = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(json.inserted, 1);
    assert.strictEqual(json.skipped.length, 1, 'invalid manager email row skipped');
    assert.strictEqual(json.skipped[0].reason, 'invalid account manager email format');

    const good = db.prepare('SELECT * FROM clients WHERE email = ?').get('good@sync.com');
    assert.strictEqual(good.account_manager_email, 'sam@agency.com');

    const updated = await (await fetch(`${base}/api/clients/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sync-Secret': 'test-secret' },
      body: JSON.stringify({ clients: [{ Name: 'Good AM 2', Email: 'good@sync.com', 'Account Manager Email': 'sam2@agency.com' }] })
    })).json();
    assert.strictEqual(updated.updated, 1, 'same email upserts and updates AM email');
    assert.strictEqual(db.prepare('SELECT * FROM clients WHERE email = ?').get('good@sync.com').account_manager_email, 'sam2@agency.com');
  } finally {
    stopServer(server);
  }
});

test('sync-from-sheet (pull) maps AM columns from CSV and skips bad manager email', async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/clients/sync-from-sheet`, { method: 'POST' });
    const json = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(json.inserted, 1);
    assert.strictEqual(json.skipped.length, 1);
    assert.strictEqual(json.skipped[0].reason, 'invalid account manager email format');

    const row = db.prepare('SELECT * FROM clients WHERE email = ?').get('csv@sync.com');
    assert.strictEqual(row.account_manager_email, 'bob@agency.com');
    assert.strictEqual(row.account_manager, null, 'legacy name column is never written by the app');
  } finally {
    stopServer(server);
  }
});

test('feedback notification copies the Account Manager when set', async () => {
  captured.length = 0;
  const client = await insertClient({ name: 'AM Feedback', email: 'amfb@client.com', accountManagerEmail: 'jane@am.test' });
  const token = crypto.randomUUID();
  await insertFeedbackRequest({ client_id: client.id, month: '2026-06', token });

  const { server, base } = await startServer();
  try {
    const res = await fetch(`${base}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(feedbackBody(token))
    });
    assert.strictEqual(res.status, 201);
    await app.flushBackground();

    const mails = feedbackMails();
    assert.strictEqual(mails.length, 1, 'one feedback notification sent');
    const to = Array.isArray(mails[0].to) ? mails[0].to : [mails[0].to];
    assert.ok(to.includes('admin@am.test'), 'admin always receives it');
    assert.ok(to.includes('jane@am.test'), 'account manager receives a copy');
    assert.strictEqual(to.length, 2, 'no extra recipients');
  } finally {
    stopServer(server);
  }
});

test('feedback notification goes only to admin when no Account Manager email', async () => {
  captured.length = 0;
  const client = await insertClient({ name: 'No AM', email: 'noam@client.com' });
  const token = crypto.randomUUID();
  await insertFeedbackRequest({ client_id: client.id, month: '2026-06', token });

  const { server, base } = await startServer();
  try {
    const res = await fetch(`${base}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(feedbackBody(token))
    });
    assert.strictEqual(res.status, 201);
    await app.flushBackground();

    const mails = feedbackMails();
    assert.strictEqual(mails.length, 1, 'one feedback notification sent');
    const to = Array.isArray(mails[0].to) ? mails[0].to : [mails[0].to];
    assert.deepStrictEqual(to, ['admin@am.test'], 'only admin receives it; no blank-recipient crash');
  } finally {
    stopServer(server);
  }
});

test('upsertClientByEmail preserves existing AM email when omitted and overwrites when provided', async () => {
  const first = await upsertClientByEmail({ name: 'Upsert AM', email: 'ups@am.com', accountManagerEmail: 'kim@am.com' });
  assert.strictEqual(first.action, 'inserted');
  assert.strictEqual(first.row.accountManagerEmail, 'kim@am.com');

  const second = await upsertClientByEmail({ name: 'Upsert AM Renamed', email: 'ups@am.com' });
  assert.strictEqual(second.action, 'updated');
  assert.strictEqual(second.row.accountManagerEmail, 'kim@am.com', 'existing AM email preserved when omitted');

  const third = await upsertClientByEmail({ name: 'Upsert AM Renamed', email: 'ups@am.com', accountManagerEmail: 'new@am.com' });
  assert.strictEqual(third.row.accountManagerEmail, 'new@am.com', 'provided AM email overwrites');
});

test('DELETE /api/clients/:id is blocked when the client has feedback reports', async () => {
  const client = await insertClient({ name: 'Has Reports', email: 'hasreports@test.com' });
  await insertFeedback({
    submissionId: 'FB-DEL-BLOCK',
    timestamp: new Date().toISOString(),
    serviceType: 'General',
    month: '2026-09',
    client_id: client.id,
    attendeeName: 'A', attendeeEmail: 'a@b.com', hasValidEmail: 1, companyName: '',
    rating: 4, comments: 'c', suggestions: null, sentiment: 'positive', summary: 's',
    urgency: 'low', highlights: [], improvementSuggestions: [], pdfUrl: '', emailSent: 0,
    accountManagementScore: 4, strategyScore: 4, creativeScore: 4, designContentScore: 4,
    socialContentScore: 4, agencyLeadershipScore: 4
  });
  assert.strictEqual(await clientFeedbackReportCount(client.id), 1);

  const { server, base } = startServer();
  try {
    const res = await fetch(`${base}/api/clients/${client.id}`, { method: 'DELETE' });
    const json = await res.json();
    assert.strictEqual(res.status, 400);
    assert.strictEqual(json.ok, false);
    assert.match(json.error, /existing feedback reports/);
    const stillThere = await getClient(client.id);
    assert.ok(stillThere, 'client must NOT be deleted when it has feedback reports');
  } finally {
    stopServer(server);
  }
});

test('DELETE /api/clients/:id succeeds when the client has no feedback reports', async () => {
  const client = await insertClient({ name: 'No Reports', email: 'noreports@test.com' });
  assert.strictEqual(await clientFeedbackReportCount(client.id), 0);

  const { server, base } = startServer();
  try {
    const res = await fetch(`${base}/api/clients/${client.id}`, { method: 'DELETE' });
    const json = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(json.ok, true);
    const gone = await getClient(client.id);
    assert.strictEqual(gone, undefined, 'client should be deleted when it has no feedback reports');
  } finally {
    stopServer(server);
  }
});

test('sheet sync updates an existing client when the name header is "Client Name"', async () => {
  const client = await insertClient({ name: 'ebad', email: 'tamatos.dev@gmail.com' });
  assert.strictEqual(client.accountManagerEmail, '', 'precondition: no AM email yet');

  const { server, base } = startServer();
  try {
    const res = await fetch(`${base}/api/clients/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sync-Secret': 'test-secret' },
      body: JSON.stringify({ clients: [{ 'Client Name': 'ebad', Email: 'tamatos.dev@gmail.com', 'Account Manager Email': 'ebadk2570@gmail.com', Status: 'Active' }] })
    });
    const json = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(json.ok, true);
    assert.strictEqual(json.updated, 1, 'existing client should be updated');
    assert.strictEqual(json.skipped.length, 0, 'row must NOT be skipped');
    assert.strictEqual(json.inserted, 0);

    const updated = await getClient(client.id);
    assert.strictEqual(updated.accountManagerEmail, 'ebadk2570@gmail.com', 'AM email should be updated from the sheet');
  } finally {
    stopServer(server);
  }
});
