require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cron = require('node-cron');
const { cleanData } = require('./cleanData');
const { analyzeFeedback, analyzeCombined, sentimentColor, fallbackAnalysis } = require('./gemini');
const { reportHTML, combinedHTML, esc } = require('./report');
const { buildPdf, buildCombinedPdf } = require('./pdf');
const { sendFeedbackEmail, sendCombinedEmail, parseLeadershipEmails, reportExtraRecipients } = require('./email');
const { insertFeedback, updateFeedbackAnalysis, queryFeedback, getFeedbackReport, stats, getClient, findFeedbackRequestByToken, markFeedbackRequestSubmitted, insertClient, listClients, listClientEmails, updateClientStatus,   updateClient, upsertClientByEmail, deleteClient, clientFeedbackReportCount, dbMode, dbHost, pingDb, listTables } = require('./db');
const { saveReport, getReport, reportUrl, fallbackReportUrl } = require('./storage');
const { dashboardKpis, dashboardDepartment, dashboardMeta, STATUS_LEVELS } = require('./dashboard');
const { sendMonthlyFeedbackForms } = require('./jobs/monthlySend');
const { generateSixMonthReport } = require('./jobs/sixMonthReport');
const { evaluateSubmissionAlerts, runNoResponseCheck } = require('./alerts');

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const APP_BASE_URL = (process.env.APP_BASE_URL || PUBLIC_URL).replace(/\/$/, '');

const smtpConfig = {
  smtpHost: process.env.SMTP_HOST || 'smtp.hostinger.com',
  smtpPort: Number(process.env.SMTP_PORT) || 465,
  smtpUser: process.env.SMTP_USER || 'tahir@puredesigners.com',
  smtpPass: process.env.SMTP_PASS || '',
  adminEmail: process.env.ADMIN_EMAIL || '',
  smtpSecure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE.toLowerCase() === 'true' : true,
  leadershipEmails: parseLeadershipEmails(process.env.LEADERSHIP_EMAILS)
};
const LOW_SCORE_THRESHOLD = Number(process.env.ALERT_LOW_SCORE_THRESHOLD || 3.0);
const geminiApiKey = process.env.GEMINI_API_KEY || '';

// ---------- Background processing (response-first submissions) ----------
// On Vercel, @vercel/functions' waitUntil() keeps the function alive until the
// queued work completes; outside Vercel it no-ops and the promise still runs.
let scheduleBackground;
try {
  const { waitUntil } = require('@vercel/functions');
  scheduleBackground = (fn) => {
    const p = Promise.resolve().then(fn);
    return waitUntil(p) ?? p;
  };
} catch {
  scheduleBackground = (fn) => Promise.resolve().then(fn);
}
const backgroundJobs = [];
function runInBackground(fn) {
  let job;
  try {
    job = Promise.resolve(scheduleBackground(() => Promise.resolve(fn())));
  } catch (err) {
    console.error('[Background job] scheduler unavailable, running inline:', err.message);
    job = Promise.resolve(fn());
  }
  job = job.catch((err) => console.error('[Background job] failed:', err));
  backgroundJobs.push(job);
  job.finally(() => {
    const i = backgroundJobs.indexOf(job);
    if (i !== -1) backgroundJobs.splice(i, 1);
  });
  return job;
}
app.flushBackground = () => Promise.allSettled(backgroundJobs.slice());

// ---------- Admin session auth (single fixed login, signed httpOnly cookie) ----------
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const ADMIN_AUTH_ENABLED = !!(ADMIN_USERNAME && ADMIN_PASSWORD && SESSION_SECRET);
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_COOKIE = 'admin_session';
const revokedSessions = new Set();

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function signSession(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const hmac = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  return `${data}.${hmac}`;
}

function verifySession(token) {
  if (!token) return false;
  if (revokedSessions.has(token)) return false;
  const parts = String(token).split('.');
  if (parts.length !== 2) return false;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(parts[0]).digest('base64url');
  const a = Buffer.from(parts[1]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (payload.u !== ADMIN_USERNAME) return false;
    if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return false;
    return true;
  } catch {
    return false;
  }
}

function requireAdminSession(req, res, next) {
  if (!ADMIN_AUTH_ENABLED) return next();
  // Public-but-secret-gated endpoints that must not be shadowed by the
  // admin session gate:
  //  - /api/clients/sync: Google Sheets automation (X-Sync-Secret)
  //  - /api/cron/*: Vercel Cron jobs have no session cookie (CRON_SECRET)
  if (req.path === '/sync' || req.baseUrl === '/api/cron') return next();
  if (verifySession(parseCookies(req)[SESSION_COOKIE])) return next();
  if (req.originalUrl.split('?')[0].endsWith('.html')) {
    return res.redirect('/login.html');
  }
  return res.status(401).json({ ok: false, error: 'Not authenticated.' });
}

app.post('/api/login', (req, res) => {
  if (!ADMIN_AUTH_ENABLED) {
    return res.status(503).json({ ok: false, error: 'Admin authentication is not configured on this server.' });
  }
  const { username, password } = req.body || {};
  const userOk = username && safeEqual(username, ADMIN_USERNAME);
  const passOk = password && safeEqual(password, ADMIN_PASSWORD);
  if (!userOk || !passOk) {
    return res.status(401).json({ ok: false, error: 'Invalid credentials.' });
  }
  const token = signSession({ u: String(username), exp: Date.now() + SESSION_TTL_MS });
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: SESSION_TTL_MS });
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) revokedSessions.add(token);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

app.use('/dashboard.html', requireAdminSession);
app.use('/admin-clients.html', requireAdminSession);
app.use('/api/clients', requireAdminSession);
app.use('/api/stats', requireAdminSession);
app.use('/api/dashboard', requireAdminSession);
app.use('/api/reports/combined', requireAdminSession);
app.use('/api/cron', requireAdminSession);
app.get('/api/feedback', requireAdminSession);

function reportUrlFor(fileName) {
  return reportUrl(fileName);
}

async function savePdf(buffer, fileName) {
  try {
    return await saveReport(fileName, buffer, 'application/pdf');
  } catch (err) {
    console.error('[storage] PDF save failed, using on-demand /reports fallback:', err.message);
    return { size: buffer.length, fallback: true };
  }
}

async function saveHtml(html, fileName) {
  try {
    return await saveReport(fileName, Buffer.from(html), 'text/html; charset=utf-8');
  } catch (err) {
    console.error('[storage] HTML save failed, using on-demand /reports fallback:', err.message);
    return { size: Buffer.byteLength(html), fallback: true };
  }
}

// ---------- 1. Submit feedback: save + respond fast, then AI -> report -> PDF -> email -> alerts in the background ----------
app.post('/api/feedback', async (req, res) => {
  try {
    const body = req.body || {};
    const token = body.token ? String(body.token).trim() : '';

    let clientId = null;
    let request = null;
    if (token) {
      request = await findFeedbackRequestByToken(token);
      if (!request) {
        return res.status(400).json({ ok: false, error: 'This feedback link is invalid or has expired.' });
      }
      if (request.submitted) {
        return res.status(409).json({ ok: false, error: 'This feedback link has already been used.' });
      }
      clientId = request.client_id;
    }

    const client = clientId ? await getClient(clientId) : null;
    const cleaned = cleanData(body);

    if (client) {
      // Tokenized submissions no longer carry a client Service Type; fall back to "General".
      cleaned.eventName = 'General';
    }
    if (request) {
      cleaned.eventDate = request.month;
    }

    const fallback = fallbackAnalysis(cleaned);

    const record = {
      ...cleaned,
      ...fallback,
      sentimentColor: sentimentColor(fallback.sentiment),
      pdfUrl: '',
      emailSent: false
    };

    await insertFeedback({
      submissionId: record.submissionId,
      timestamp: record.timestamp,
      serviceType: record.eventName,
      month: record.eventDate || null,
      client_id: clientId,
      attendeeName: record.attendeeName,
      attendeeEmail: record.attendeeEmail,
      hasValidEmail: record.hasValidEmail,
      companyName: record.companyName,
      rating: record.rating,
      accountManagementScore: record.accountManagementScore,
      strategyScore: record.strategyScore,
      creativeScore: record.creativeScore,
      designContentScore: record.designContentScore,
      socialContentScore: record.socialContentScore,
      agencyLeadershipScore: record.agencyLeadershipScore,
      comments: record.comments,
      suggestions: null,
      sentiment: record.sentiment,
      summary: record.summary,
      urgency: record.urgency,
      highlights: record.highlights,
      improvementSuggestions: record.improvementSuggestions,
      pdfUrl: '',
      emailSent: false
    });

    if (request) {
      await markFeedbackRequestSubmitted(request.id);
    }

    res.status(201).json({
      ok: true,
      submissionId: record.submissionId,
      timestamp: record.timestamp,
      eventName: record.eventName,
      serviceType: record.eventName,
      month: record.eventDate || null,
      tokenUsed: !!request,
      rating: record.rating,
      departmentScores: {
        accountManagementScore: record.accountManagementScore,
        strategyScore: record.strategyScore,
        creativeScore: record.creativeScore,
        designContentScore: record.designContentScore,
        socialContentScore: record.socialContentScore,
        agencyLeadershipScore: record.agencyLeadershipScore
      },
      sentiment: record.sentiment,
      sentimentColor: record.sentimentColor,
      urgency: record.urgency,
      summary: record.summary,
      usedAi: false,
      emailSent: false,
      emailError: smtpConfig.smtpPass ? null : 'SMTP_PASS not set; email skipped.',
      alerts: { evaluated: false, sent: [], skipped: [], note: 'Evaluated in the background after the response.' },
      pdfUrl: '',
      pdfFileName: null,
      pdfSize: 0
    });

    runInBackground(() => processSubmissionBackground(record, client));
  } catch (err) {
    console.error('[POST /api/feedback]', err);
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

async function processSubmissionBackground(initialRecord, client) {
  try {
    let record = initialRecord;
    const { analysis } = await analyzeFeedback(initialRecord, { apiKey: geminiApiKey });
    record = { ...initialRecord, ...analysis, sentimentColor: sentimentColor(analysis.sentiment) };

    // Surface the client's own email (entered when the client was added) so the
    // generated HTML/PDF report shows it under CLIENT INFORMATION.
    if (client) {
      record.clientEmail = client.email ? String(client.email).trim() : '';
      record.clientName = client.name ? String(client.name).trim() : '';
    }

    const html = reportHTML(record, '/assets/logo.png');
    await saveHtml(html, `${record.submissionId}.html`);

    const pdfBuffer = await buildPdf(record);
    const pdfFileName = `${record.submissionId}.pdf`;
    const saved = await savePdf(pdfBuffer, pdfFileName);
    record.pdfUrl = saved.fallback ? fallbackReportUrl(pdfFileName) : reportUrl(pdfFileName);

    if (smtpConfig.smtpPass) {
      try {
        // Copy the client's Account Manager (if configured) on the same
        // notification email so they hear about their client's feedback.
        // When the overall score (agency_leadership_score) is below the
        // low-score threshold, also CC the leadership addresses — same full
        // report email with the PDF, not the separate short alert.
        const score = Number(record.agencyLeadershipScore);
        const lowScore = Number.isFinite(score) && score < LOW_SCORE_THRESHOLD;
        const extraRecipients = reportExtraRecipients({
          accountManagerEmail: client && client.accountManagerEmail,
          leadershipEmails: smtpConfig.leadershipEmails,
          lowScore
        });
        await sendFeedbackEmail(smtpConfig, record, pdfBuffer, record.pdfUrl, extraRecipients);
        record.emailSent = true;
      } catch (err) {
        console.error('[Email] send failed:', err.message);
      }
    } else {
      console.log('[Email] SMTP_PASS not set; email skipped.');
    }

    await updateFeedbackAnalysis({
      submissionId: record.submissionId,
      sentiment: record.sentiment,
      summary: record.summary,
      urgency: record.urgency,
      highlights: record.highlights,
      improvementSuggestions: record.improvementSuggestions,
      pdfUrl: record.pdfUrl,
      emailSent: record.emailSent
    });

    if (client) {
      try {
        await evaluateSubmissionAlerts({ client, record, smtpConfig, appBaseUrl: APP_BASE_URL });
      } catch (err) {
        console.error('[Alerts] evaluation failed (submission unaffected):', err.message);
      }
    }
  } catch (err) {
    console.error('[Background processing] failed for submission:', err.message);
  }
}

// ---------- 2. List feedback with filters ----------
app.get('/api/feedback', async (req, res) => {
  try {
    const rows = await queryFeedback({
      from: req.query.from,
      to: req.query.to,
      sentiment: req.query.sentiment,
      serviceType: req.query.serviceType,
      eventName: req.query.eventName
    });
    res.json({ ok: true, count: rows.length, data: rows.map((r) => ({ ...r, sentimentColor: sentimentColor(r.sentiment), htmlUrl: reportUrl(`${r.submissionId}.html`) })) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- 3. Dashboard stats ----------
app.get('/api/stats', async (req, res) => {
  try {
    res.json({ ok: true, data: await stats({ from: req.query.from, to: req.query.to }) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- 3b. Management dashboard aggregations (Phase 2) ----------
function dashboardQueryParams(req) {
  const client = String(req.query.client || '').trim();
  if (client && !Number.isFinite(Number(client))) {
    const err = new Error(`Invalid client filter "${client}" — must be a client id.`);
    err.status = 400;
    throw err;
  }
  const status = String(req.query.status || '').trim().toLowerCase();
  if (status && !STATUS_LEVELS.includes(status)) {
    const err = new Error(`Invalid status filter "${status}" — use ${STATUS_LEVELS.join(', ')}.`);
    err.status = 400;
    throw err;
  }
  return {
    from: String(req.query.from || '').slice(0, 10),
    to: String(req.query.to || '').slice(0, 10),
    client: client || '',
    status: status || ''
  };
}

app.get('/api/dashboard/meta', async (req, res) => {
  try {
    res.json({ ok: true, data: await dashboardMeta() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/dashboard/kpis', async (req, res) => {
  try {
    const p = dashboardQueryParams(req);
    res.json({ ok: true, data: await dashboardKpis(p) });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

app.get('/api/dashboard/department/:name', async (req, res) => {
  try {
    const p = dashboardQueryParams(req);
    res.json({ ok: true, data: await dashboardDepartment(req.params.name, p) });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// ---------- 4. Client management (internal admin) ----------
const CLIENT_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_UPLOAD_ROWS = 500;

function normalizeHeaderKey(key) {
  return String(key).toLowerCase().replace(/[\s_]+/g, '');
}

const BULK_COLUMNS = { name: 'name', clientname: 'name', email: 'email', status: 'status', accountmanageremail: 'accountManagerEmail' };

function mapClientRow(raw) {
  const mapped = {};
  for (const [key, value] of Object.entries(raw)) {
    const canonical = normalizeHeaderKey(key);
    if (BULK_COLUMNS[canonical]) mapped[BULK_COLUMNS[canonical]] = String(value ?? '').trim();
  }
  return mapped;
}

function clientRowValidationError(mapped) {
  if (!mapped.name) return 'missing name';
  if (!mapped.email) return 'missing email';
  if (!CLIENT_EMAIL_RE.test(mapped.email)) return 'invalid email format';
  const status = mapped.status ? mapped.status.toLowerCase() : 'active';
  if (status !== 'active' && status !== 'inactive') {
    return `invalid status "${mapped.status || ''}" (must be active or inactive)`;
  }
  // Account Manager Email is optional, but when present must be a valid address.
  if (mapped.accountManagerEmail && !CLIENT_EMAIL_RE.test(mapped.accountManagerEmail)) {
    return 'invalid account manager email format';
  }
  return null;
}

// Minimal RFC-4180-ish CSV parser (quoted fields, escaped quotes, CRLF). Returns
// an array of row arrays. Used for the published Google Sheet CSV — no xlsx
// dependency needed since the sheet is published as plain CSV.
function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return rows;
}

// CSV text -> array of row objects keyed by the header row (same shape the old
// xlsx sheet_to_json produced: first row is the header, missing cells -> '').
function parseClientCsv(text) {
  const rows = parseCsvRows(String(text).replace(/^\uFEFF/, ''));
  if (!rows.length) return [];
  const headers = rows[0].map((h) => String(h ?? '').trim());
  return rows
    .slice(1)
    .filter((r) => r.some((v) => String(v ?? '').trim() !== ''))
    .map((r) => {
      const obj = {};
      headers.forEach((h, i) => {
        obj[h] = r[i] ?? '';
      });
      return obj;
    });
}

// Shared upsert-by-email loop for both sync endpoints. Returns
// { inserted, updated, skipped: [{ row, reason }] } with 1-based row numbers.
async function syncClientRows(rows) {
  const batchEmails = new Set();
  const skipped = [];
  let inserted = 0;
  let updated = 0;
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    const mapped = mapClientRow(raw);
    const reason = clientRowValidationError(mapped);
    if (reason) {
      skipped.push({ row: i + 1, reason });
      continue;
    }
    const emailKey = mapped.email.toLowerCase();
    if (batchEmails.has(emailKey)) {
      skipped.push({ row: i + 1, reason: 'duplicate email' });
      continue;
    }
    batchEmails.add(emailKey);
    const { action } = await upsertClientByEmail({
      name: mapped.name,
      email: mapped.email,
      status: (mapped.status || 'active').toLowerCase(),
      accountManagerEmail: mapped.accountManagerEmail
    });
    if (action === 'inserted') inserted += 1;
    else updated += 1;
  }
  return { inserted, updated, skipped };
}

// ---------- Google Sheets sync (upsert by email, X-Sync-Secret guarded) ----------
const SYNC_SECRET = process.env.SYNC_SECRET || '';

function requireSyncSecret(req, res, next) {
  if (!SYNC_SECRET || !safeEqual(req.headers['x-sync-secret'] || '', SYNC_SECRET)) {
    return res.status(401).json({ ok: false, error: 'Invalid or missing X-Sync-Secret.' });
  }
  next();
}

app.post('/api/clients/sync', requireSyncSecret, async (req, res) => {
  try {
    const contentLength = Number(req.headers['content-length'] || 0);
    if (contentLength > MAX_UPLOAD_BYTES) {
      return res.status(400).json({ ok: false, error: `Payload too large (max ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB).` });
    }
    const clients = req.body?.clients;
    if (!Array.isArray(clients)) {
      return res.status(400).json({ ok: false, error: 'Body must include a "clients" array.' });
    }
    if (clients.length > MAX_UPLOAD_ROWS) {
      return res.status(400).json({ ok: false, error: `Too many rows (${clients.length}). Max ${MAX_UPLOAD_ROWS} clients per sync.` });
    }

    const { inserted, updated, skipped } = await syncClientRows(clients);

    console.log(`[ClientSync] ${clients.length} rows: ${inserted} inserted, ${updated} updated, ${skipped.length} skipped`);
    res.json({ ok: true, inserted, updated, skipped, total: clients.length });
  } catch (err) {
    console.error('[POST /api/clients/sync]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Sync from published Google Sheet CSV (admin session, button on the admin page) ----------
const SHEET_CSV_URL = (process.env.SHEET_CSV_URL || '').trim();
const SHEET_EDIT_URL = (process.env.SHEET_EDIT_URL || '').trim();

// Admin-page config: the edit URL is delivered via a session-protected
// endpoint (the static admin page has no server-side templating; /api/health
// is open, so it must not leak the sheet link).
app.get('/api/config/sheet', requireAdminSession, (req, res) => {
  res.json({ ok: true, sheetEditUrl: SHEET_EDIT_URL });
});

app.post('/api/clients/sync-from-sheet', async (req, res) => {
  try {
    if (!SHEET_CSV_URL) {
      return res.status(400).json({
        ok: false,
        error: 'SHEET_CSV_URL is not configured. Set it to the published CSV link of your Google Sheet (File → Share → Publish to web → CSV).'
      });
    }
    let sheetRes;
    try {
      sheetRes = await fetch(SHEET_CSV_URL, {
        signal: AbortSignal.timeout(20000),
        headers: { Accept: 'text/csv,text/plain,*/*' }
      });
    } catch (err) {
      return res.status(502).json({
        ok: false,
        error: `Could not reach the published sheet CSV (${err.message}). Is the sheet published to the web as CSV (File → Share → Publish to web)?`
      });
    }
    if (!sheetRes.ok) {
      return res.status(502).json({
        ok: false,
        error: `Could not fetch the sheet CSV (HTTP ${sheetRes.status} ${sheetRes.statusText}). Make sure the sheet is published to the web as CSV (File → Share → Publish to web).`
      });
    }
    const csvText = await sheetRes.text();
    if (csvText.length > MAX_UPLOAD_BYTES) {
      return res.status(400).json({ ok: false, error: 'The published sheet CSV is too large.' });
    }
    if (!csvText.trim()) {
      return res.status(400).json({ ok: false, error: 'The published sheet is empty.' });
    }
    const rows = parseClientCsv(csvText);
    if (!rows.length) {
      return res.status(400).json({ ok: false, error: 'The sheet has no data rows (header row required).' });
    }
    if (rows.length > MAX_UPLOAD_ROWS) {
      return res.status(400).json({ ok: false, error: `Too many rows (${rows.length}). Max ${MAX_UPLOAD_ROWS} clients per sync.` });
    }

    const { inserted, updated, skipped } = await syncClientRows(rows);

    console.log(`[SheetSync] ${rows.length} rows: ${inserted} inserted, ${updated} updated, ${skipped.length} skipped`);
    res.json({ ok: true, inserted, updated, skipped, total: rows.length });
  } catch (err) {
    console.error('[POST /api/clients/sync-from-sheet]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/clients', async (req, res) => {
  try {
    const { name, email, status, accountManagerEmail } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ ok: false, error: 'Client name is required.' });
    }
    if (!email || !CLIENT_EMAIL_RE.test(String(email).trim())) {
      return res.status(400).json({ ok: false, error: 'A valid email is required.' });
    }
    if (status && !['active', 'inactive'].includes(status)) {
      return res.status(400).json({ ok: false, error: "Status must be 'active' or 'inactive'." });
    }
    const amEmail = accountManagerEmail ? String(accountManagerEmail).trim() : '';
    if (amEmail && !CLIENT_EMAIL_RE.test(amEmail)) {
      return res.status(400).json({ ok: false, error: 'Account Manager Email must be a valid email address.' });
    }
    const client = await insertClient({
      name,
      email,
      status,
      accountManagerEmail: amEmail
    });
    delete client.service_type;
    res.status(201).json({ ok: true, data: client });
  } catch (err) {
    console.error('[POST /api/clients]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/clients', async (req, res) => {
  try {
    const rows = await listClients();
    rows.forEach((r) => delete r.service_type);
    res.json({ ok: true, count: rows.length, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.patch('/api/clients/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const body = req.body || {};
    const fields = {};
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) {
        return res.status(400).json({ ok: false, error: 'Client name is required.' });
      }
      fields.name = name;
    }
    if (body.email !== undefined) {
      const email = String(body.email).trim();
      if (!email || !CLIENT_EMAIL_RE.test(email)) {
        return res.status(400).json({ ok: false, error: 'A valid email is required.' });
      }
      fields.email = email;
    }
    if (body.status !== undefined) {
      if (!['active', 'inactive'].includes(body.status)) {
        return res.status(400).json({ ok: false, error: "Status must be 'active' or 'inactive'." });
      }
      fields.status = body.status;
    }
    if (body.accountManagerEmail !== undefined) {
      const amEmail = String(body.accountManagerEmail).trim();
      if (amEmail && !CLIENT_EMAIL_RE.test(amEmail)) {
        return res.status(400).json({ ok: false, error: 'Account Manager Email must be a valid email address.' });
      }
      fields.accountManagerEmail = amEmail;
    }
    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ ok: false, error: 'Nothing to update — send name, email, status and/or accountManagerEmail.' });
    }
    const client = await updateClient(id, fields);
    if (!client) {
      return res.status(404).json({ ok: false, error: 'Client not found.' });
    }
    delete client.service_type;
    res.json({ ok: true, data: client });
  } catch (err) {
    console.error('[PATCH /api/clients/:id]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/clients/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const reportCount = await clientFeedbackReportCount(id);
    if (reportCount > 0) {
      return res.status(400).json({
        ok: false,
        error: 'Cannot delete this client — they have existing feedback reports. Set them to inactive instead.'
      });
    }
    const { deleted, removedRequests } = await deleteClient(id);
    if (!deleted) {
      return res.status(404).json({ ok: false, error: 'Client not found.' });
    }
    res.json({ ok: true, data: { id, removedFeedbackRequests: removedRequests } });
  } catch (err) {
    console.error('[DELETE /api/clients/:id]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- 5. Date-range combined report: fetch -> Gemini -> PDF -> email ----------
app.post('/api/reports/combined', async (req, res) => {
  try {
    const from = String(req.body?.from || '').slice(0, 10);
    const to = String(req.body?.to || '').slice(0, 10);
    if (!from || !to) {
      return res.status(400).json({ ok: false, error: 'Both from and to dates are required.' });
    }

    const rows = await queryFeedback({ from, to });
    if (!rows.length) {
      return res.status(404).json({ ok: false, error: `No feedback found between ${from} and ${to}.` });
    }

    const overall = await analyzeCombined(rows, { apiKey: geminiApiKey });
    const meta = { from, to, generatedAt: new Date().toISOString(), ...overall };

    const html = combinedHTML(meta, rows, '/assets/logo.png');
    await saveHtml(html, `combined-${from}-to-${to}.html`);

    const pdfBuffer = await buildCombinedPdf(meta, rows);
    const pdfFileName = `combined-${from}-to-${to}.pdf`;
    const saved = await savePdf(pdfBuffer, pdfFileName);
    const pdfUrl = saved.fallback ? fallbackReportUrl(pdfFileName) : reportUrl(pdfFileName);

    let emailSent = false;
    let emailError = null;
    try {
      if (smtpConfig.smtpPass) {
        await sendCombinedEmail(smtpConfig, meta, pdfBuffer, pdfUrl, rows.length);
        emailSent = true;
      } else {
        emailError = 'SMTP_PASS not set; email skipped.';
      }
    } catch (err) {
      emailError = err.message;
      console.error('[Email] combined send failed:', err.message);
    }

    res.json({
      ok: true,
      count: rows.length,
      from,
      to,
      emailSent,
      emailError,
      pdfUrl,
      pdfFileName,
      pdfSize: saved.size,
      overallAnalysis: {
        overallSummary: meta.overallSummary,
        overallSentimentBreakdown: meta.overallSentimentBreakdown,
        keyHighlights: meta.keyHighlights,
        topImprovementSuggestions: meta.topImprovementSuggestions
      }
    });
  } catch (err) {
    console.error('[POST /api/reports/combined]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Report downloads: disk -> storage -> regenerate on demand ----------
const REPORT_FILE_RE = /^([A-Za-z0-9._-]+)\.(html|pdf)$/;
const COMBINED_FILE_RE = /^combined-(\d{4}-\d{2})-to-(\d{4}-\d{2})\.(html|pdf)$/;

async function renderReportOnDemand(fileName) {
  const single = REPORT_FILE_RE.exec(fileName);
  if (single && !fileName.startsWith('combined-')) {
    const record = await getFeedbackReport(single[1]);
    if (!record) return null;
    if (single[2] === 'pdf') {
      return { buffer: await buildPdf(record), contentType: 'application/pdf' };
    }
    return { buffer: Buffer.from(reportHTML(record, '/assets/logo.png')), contentType: 'text/html; charset=utf-8' };
  }
  const combined = COMBINED_FILE_RE.exec(fileName);
  if (combined) {
    const rows = await queryFeedback({ from: `${combined[1]}-01`, to: `${combined[2]}-28` });
    if (!rows.length) return null;
    const overall = await analyzeCombined(rows, { apiKey: geminiApiKey });
    const meta = { from: combined[1], to: combined[2], generatedAt: new Date().toISOString(), ...overall };
    if (combined[3] === 'pdf') {
      return { buffer: await buildCombinedPdf(meta, rows), contentType: 'application/pdf' };
    }
    return { buffer: Buffer.from(combinedHTML(meta, rows, '/assets/logo.png')), contentType: 'text/html; charset=utf-8' };
  }
  return null;
}

app.get('/reports/:file', async (req, res) => {
  const fileName = decodeURIComponent(req.params.file || '');
  if (!REPORT_FILE_RE.test(fileName)) {
    return res.status(400).send('Bad request');
  }
  try {
    const found = await getReport(fileName);
    if (found) {
      res.set('Content-Type', found.contentType);
      res.set('Content-Length', found.buffer.length);
      res.set('Cache-Control', 'public, max-age=3600');
      return res.send(found.buffer);
    }
    const rendered = await renderReportOnDemand(fileName);
    if (!rendered) {
      return res.status(404).send('Report not found');
    }
    res.set('Content-Type', rendered.contentType);
    res.set('Cache-Control', 'public, max-age=3600');
    return res.send(rendered.buffer);
  } catch (err) {
    console.error('[GET /reports/:file]', err);
    res.status(500).send('Report generation failed');
  }
});

// ---------- Static: frontend ----------
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- Token-based feedback form (Phase 2) ----------
const RATING_QUESTIONS = [
  { key: 'accountManagementScore', department: 'Account Management', question: 'How satisfied are you with the responsiveness, communication, and overall management of your account?' },
  { key: 'strategyScore', department: 'Strategy', question: 'How satisfied are you with the quality of strategic thinking, recommendations, and direction provided for your brand?' },
  { key: 'creativeScore', department: 'Creative', question: 'How satisfied are you with the quality, relevance, and originality of the creative ideas developed for your brand?' },
  { key: 'designContentScore', department: 'Design & Content Production', question: 'How satisfied are you with the quality, consistency, and timeliness of our design and content production?' },
  { key: 'socialContentScore', department: 'Social & Content', question: 'How satisfied are you with the management of your social media platforms, including content publishing, community management, and overall engagement?' },
  { key: 'agencyLeadershipScore', department: 'Agency Leadership', question: "Overall, how satisfied are you with Craftsmen Media's performance and the value we deliver to your business?" }
];

const SCALE_LABELS = ['Very Poor', 'Poor', 'Satisfactory', 'Good', 'Excellent'];

function ratingQuestionsScript() {
  return `
    const RATING_QUESTIONS = ${JSON.stringify(RATING_QUESTIONS)};
    const SCALE_LABELS = ${JSON.stringify(SCALE_LABELS)};

    function ratingOption(n, key) {
      return '<label class="flex-1 cursor-pointer">' +
        '<input type="radio" name="' + key + '" value="' + n + '" required class="peer sr-only" />' +
        '<span class="rating-box flex flex-col items-center gap-0.5 rounded-xl border-2 border-gray-200 py-2.5 px-1 text-sm font-bold text-gray-500 transition hover:border-brandDark hover:text-ink peer-checked:border-brand peer-checked:bg-brand/15 peer-checked:text-ink peer-checked:font-extrabold">' +
          '<svg class="rating-star shrink-0" viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="M10 1.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L10 14.9l-5.2 2.7 1-5.8L1.5 7.7l5.9-.9z"/></svg>' +
          '<span class="text-lg leading-none">' + n + '</span>' +
          '<span class="text-[9px] font-semibold leading-tight text-center text-gray-400 peer-checked:text-gray-600">' + SCALE_LABELS[n - 1] + '</span>' +
        '</span>' +
      '</label>';
    }

    function ratingQuestionHtml(q) {
      const options = [1, 2, 3, 4, 5].map((n) => ratingOption(n, q.key)).join('');
      return '<div>' +
        '<p class="text-sm font-extrabold">' + q.department + ' *</p>' +
        '<p class="text-xs text-gray-500 mb-2">' + q.question + '</p>' +
        '<div class="flex gap-2">' + options + '</div>' +
      '</div>';
    }

    RATING_QUESTIONS.forEach((q) => {
      document.getElementById('ratingQuestions').insertAdjacentHTML('beforeend', ratingQuestionHtml(q));
    });
  `;
}

function feedbackFormPage(client, request, logoPath) {
  const linkNotice = request ? esc(`Requested for ${request.month}`) : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Client Feedback</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
  <script>
    tailwind.config = {
      theme: {
        extend: {
          colors: { brand: '#FFF000', brandDark: '#CCBF00', ink: '#111827' }
        }
      }
    };
  </script>
  <style>
    body { font-family: 'Inter', 'Segoe UI', Arial, sans-serif; }
    .rating-star { fill: none; stroke: currentColor; stroke-width: 1.6; transition: fill .15s ease; }
    .rating-box:hover .rating-star { fill: #FFF000; }
    .peer:checked ~ .rating-box .rating-star { fill: #FFF000; stroke: #111827; }
  </style>
</head>
<body class="min-h-screen bg-white text-ink antialiased">
  <main id="formView" class="max-w-xl mx-auto px-4 py-10">
    <div class="flex flex-col items-center mb-8">
      <img src="/assets/logo.png" alt="Logo" class="w-[170px] h-[60px] object-contain drop-shadow-sm" />
      <h1 class="mt-4 text-2xl font-extrabold tracking-tight">Client Feedback</h1>
      <p class="text-sm text-gray-500 mt-1">We value your feedback and appreciate your time.</p>
      <p class="text-xs text-gray-400 mt-2">${linkNotice}</p>
    </div>

    <form id="feedbackForm" class="bg-white border-2 border-brand rounded-3xl shadow-lg p-6 sm:p-8 space-y-5">
      <input type="hidden" name="token" value="${esc(request.token)}" />
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-5">
        <div>
          <label for="attendeeName" class="block text-sm font-bold mb-1.5">Name</label>
          <input id="attendeeName" name="attendeeName" type="text" value="${esc(client.name || '')}" placeholder="Enter your name"
            class="w-full rounded-xl border border-gray-200 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand focus:border-brand" />
        </div>
        <div>
          <label for="attendeeEmail" class="block text-sm font-bold mb-1.5">Email Address</label>
          <input id="attendeeEmail" name="attendeeEmail" type="email" value="${esc(client.email || '')}" placeholder="Enter your email"
            class="w-full rounded-xl border border-gray-200 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand focus:border-brand" />
        </div>
      </div>

      <div id="ratingQuestions" class="space-y-5"></div>

      <div>
        <label for="comments" class="block text-sm font-bold mb-1.5">Client Feedback </label>
        <textarea id="comments" name="comments" rows="4" placeholder="Share your feedback"
          class="w-full rounded-xl border border-gray-200 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand focus:border-brand"></textarea>
      </div>

      <button type="submit" id="submitBtn"
        class="w-full bg-brand hover:bg-brandDark text-ink font-extrabold rounded-xl py-3.5 text-base transition shadow-sm active:scale-[.99] disabled:opacity-60 disabled:cursor-not-allowed">
        Submit Feedback
      </button>
      <p id="formError" class="hidden text-sm font-semibold text-red-600 text-center"></p>
    </form>
  </main>

  <main id="successView" class="hidden max-w-xl mx-auto px-4 py-10">
    <div class="bg-white border-2 border-brand rounded-3xl shadow-lg p-10 text-center">
      <div class="mx-auto w-20 h-20 rounded-full bg-brand flex items-center justify-center shadow-sm">
        <svg class="w-11 h-11 text-ink" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      </div>
      <h2 class="mt-6 text-2xl font-extrabold tracking-tight">Thank you for your feedback!</h2>
      <p class="mt-2 text-gray-500 text-sm">Your response has been received and sent to our team for evaluation.</p>
    </div>
  </main>

  <script>
    ${ratingQuestionsScript()}

    const form = document.getElementById('feedbackForm');
    const errorEl = document.getElementById('formError');
    const submitBtn = document.getElementById('submitBtn');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorEl.classList.add('hidden');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitting…';
      const payload = Object.fromEntries(new FormData(form).entries());
      try {
        const res = await fetch('/api/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const json = await res.json();
        if (!res.ok || !json.ok) throw new Error(json.error || 'Submission failed.');
        document.getElementById('formView').classList.add('hidden');
        document.getElementById('successView').classList.remove('hidden');
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.classList.remove('hidden');
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Feedback';
      }
    });
  </script>
</body>
</html>`;
}

const linkInvalidPage = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Link Invalid — Client Feedback</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
  <script>
    tailwind.config = {
      theme: {
        extend: { colors: { brand: '#FFF000', brandDark: '#CCBF00', ink: '#111827' } }
      }
    };
  </script>
  <style>
    body { font-family: 'Inter', 'Segoe UI', Arial, sans-serif; }
  </style>
</head>
<body class="min-h-screen bg-white text-ink antialiased flex items-center justify-center px-4">
  <main class="max-w-md w-full text-center">
    <img src="/assets/logo.png" alt="Logo" class="w-[170px] h-[60px] object-contain mx-auto mb-6" />
    <div class="bg-white border-2 border-brand rounded-3xl shadow-lg p-10">
      <div class="mx-auto w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center mb-4">
        <svg class="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
        </svg>
      </div>
      <h1 class="text-xl font-extrabold tracking-tight">Link invalid or already used</h1>
      <p class="mt-2 text-sm text-gray-500">This feedback link is either invalid, expired, or has already been submitted. If you believe this is a mistake, please contact us directly.</p>
    </div>
  </main>
</body>
</html>`;

app.get('/feedback/:token', async (req, res) => {
  try {
    const request = await findFeedbackRequestByToken(req.params.token);
    if (!request || request.submitted) {
      return res.status(200).send(linkInvalidPage);
    }
    const client = await getClient(request.client_id);
    if (!client) {
      return res.status(200).send(linkInvalidPage);
    }
    res.send(feedbackFormPage(client, request, '/assets/logo.png'));
  } catch (err) {
    console.error('[GET /feedback/:token]', err);
    res.status(500).send('Something went wrong. Please try again later.');
  }
});

// ---------- Cron: monthly send + 6-month report (Phase 2) ----------
const MONTHLY_SEND_CRON = process.env.MONTHLY_SEND_CRON || '0 9 28 * *';
const SIX_MONTH_REPORT_CRON = process.env.SIX_MONTH_REPORT_CRON || '0 9 1 1,7 *';
const NO_RESPONSE_CHECK_CRON = process.env.NO_RESPONSE_CHECK_CRON || '0 10 * * *';

function runMonthlySend(offset = 0) {
  return sendMonthlyFeedbackForms({
    smtpConfig,
    appBaseUrl: APP_BASE_URL,
    cronSecret: CRON_SECRET,
    selfUrl: `${APP_BASE_URL}/api/cron/monthly-send`,
    offset
  });
}

function runSixMonthReport() {
  return generateSixMonthReport({ smtpConfig, geminiApiKey, reportUrl, savePdf, saveHtml, fallbackReportUrl })
    .catch((err) => console.error('[Cron] six-month report failed:', err));
}

function runNoResponseCheckJob() {
  return runNoResponseCheck({ smtpConfig, appBaseUrl: APP_BASE_URL })
    .catch((err) => console.error('[Cron] no-response check failed:', err));
}

// NOTE: node-cron is scheduled below, only when running as a long-lived
// server (require.main === module). On Vercel, scheduling is done via
// vercel.json "crons" hitting the /api/cron/* endpoints below.

const CRON_SECRET = process.env.CRON_SECRET || '';

function requireCronSecret(req, res, next) {
  if (CRON_SECRET) {
    const supplied = req.headers['x-cron-secret'] ||
      (req.headers.authorization && req.headers.authorization.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '');
    if (supplied !== CRON_SECRET) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
  }
  next();
}

app.post('/api/cron/monthly-send', requireCronSecret, async (req, res) => {
  // Respond immediately; the send loop runs in the background (and chains
  // across fresh invocations until the whole client list is covered) so the
  // request never exceeds Vercel's function duration limit. `offset` (from the
  // query string) advances the batches across invocations.
  const offset = Number(req.query.offset) || 0;
  res.status(202).json({ ok: true, processing: true, offset, note: 'Sending feedback requests in the background; rows appear as each email is sent.' });
  runInBackground(() => runMonthlySend(offset))
    .catch((err) => console.error('[Cron] monthly send failed:', err));
});

app.post('/api/cron/six-month-report', requireCronSecret, async (req, res) => {
  try {
    const result = await runSixMonthReport();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/cron/no-response-check', requireCronSecret, async (req, res) => {
  try {
    const result = await runNoResponseCheckJob();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/health', async (req, res) => {
  try {
    const db = await pingDb();
    let tables = null;
    if (db.ok) {
      try { tables = await listTables(); } catch (err) { tables = `unavailable (${err.code || err.message})`; }
    }
    res.json({ ok: true, geminiConfigured: !!geminiApiKey, smtpConfigured: !!smtpConfig.smtpPass, db: { ...db, tables } });
  } catch (err) {
    res.json({ ok: true, geminiConfigured: !!geminiApiKey, smtpConfigured: !!smtpConfig.smtpPass, db: { mode: dbMode(), ok: false, host: dbHost(), error: err.message, tables: null } });
  }
});

// Vercel serverless: the app is exported and never started here; the
// /api/cron/* endpoints can still be triggered externally (cron scheduling
// via Vercel Cron jobs instead of node-cron).
if (require.main === module) {
  cron.schedule(MONTHLY_SEND_CRON, () => runMonthlySend());
  cron.schedule(SIX_MONTH_REPORT_CRON, () => runSixMonthReport());
  cron.schedule(NO_RESPONSE_CHECK_CRON, () => runNoResponseCheckJob());

  app.listen(PORT, () => {
    console.log(`Client Feedback System running at ${PUBLIC_URL}`);
    console.log(`  Gemini: ${geminiApiKey ? 'configured' : 'NOT configured (fallback analysis used)'}`);
    console.log(`  SMTP:   ${smtpConfig.smtpPass ? 'configured' : 'NOT configured (emails skipped)'}`);
    console.log(`  Cron monthly send:     "${MONTHLY_SEND_CRON}" (sendMonthlyFeedbackForms)`);
    console.log(`  Cron 6-month report:   "${SIX_MONTH_REPORT_CRON}" (generateSixMonthReport)`);
    console.log(`  Cron no-response:      "${NO_RESPONSE_CHECK_CRON}" (runNoResponseCheck)`);
    if (ADMIN_AUTH_ENABLED) {
      console.log('  Admin auth:           Session login ENABLED (ADMIN_USERNAME / ADMIN_PASSWORD / SESSION_SECRET)');
    } else {
      console.warn('  Admin auth:           DISABLED — ADMIN_USERNAME / ADMIN_PASSWORD / SESSION_SECRET not fully set. Admin pages and admin API endpoints are NOT password protected! Set them before deploying publicly.');
    }
    if (SYNC_SECRET) {
      console.log('  Client sync:          X-Sync-Secret ENABLED (POST /api/clients/sync accepts requests)');
    } else {
      console.warn('  Client sync:          DISABLED — SYNC_SECRET not set. POST /api/clients/sync rejects all requests (fail closed).');
    }
  });
}

module.exports = app;
