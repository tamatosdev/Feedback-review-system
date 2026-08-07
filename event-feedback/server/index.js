require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cron = require('node-cron');
const { cleanData } = require('./cleanData');
const { analyzeFeedback, analyzeCombined, sentimentColor } = require('./gemini');
const { reportHTML, combinedHTML, esc } = require('./report');
const { buildPdf, buildCombinedPdf } = require('./pdf');
const { sendFeedbackEmail, sendCombinedEmail } = require('./email');
const { insertFeedback, queryFeedback, stats, getClient, findFeedbackRequestByToken, markFeedbackRequestSubmitted, insertClient, listClients, listClientEmails, updateClientStatus, upsertClientByEmail, deleteClient, dbMode, pingDb } = require('./db');
const { sendMonthlyFeedbackForms } = require('./jobs/monthlySend');
const { generateSixMonthReport } = require('./jobs/sixMonthReport');

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const APP_BASE_URL = (process.env.APP_BASE_URL || PUBLIC_URL).replace(/\/$/, '');

const reportsDir = path.join(__dirname, '..', 'reports');
try {
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
} catch (err) {
  console.warn('[Vercel] reports dir not writable, generated files will be skipped:', err.message);
}

const smtpConfig = {
  smtpHost: process.env.SMTP_HOST || 'smtp.hostinger.com',
  smtpPort: Number(process.env.SMTP_PORT) || 465,
  smtpUser: process.env.SMTP_USER || 'tahir@puredesigners.com',
  smtpPass: process.env.SMTP_PASS || '',
  adminEmail: process.env.ADMIN_EMAIL || 'tahir@puredesigners.com'
};
const geminiApiKey = process.env.GEMINI_API_KEY || '';

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
app.use('/api/reports/combined', requireAdminSession);
app.use('/api/cron', requireAdminSession);
app.get('/api/feedback', requireAdminSession);

function reportUrl(fileName) {
  return `${PUBLIC_URL}/reports/${encodeURIComponent(fileName)}`;
}

function savePdf(buffer, fileName) {
  const filePath = path.join(reportsDir, fileName);
  fs.writeFileSync(filePath, buffer);
  return { fileName, filePath, size: buffer.length };
}

function saveHtml(html, fileName) {
  const filePath = path.join(reportsDir, fileName);
  fs.writeFileSync(filePath, html);
  return filePath;
}

// ---------- 1. Submit feedback: clean -> AI -> report -> PDF -> email -> DB ----------
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
      cleaned.eventName = client.service_type || cleaned.eventName;
    }
    if (request) {
      cleaned.eventDate = request.month;
    }

    const { analysis, usedAi } = await analyzeFeedback(cleaned, { apiKey: geminiApiKey });
    const color = sentimentColor(analysis.sentiment);

    const record = {
      ...cleaned,
      ...analysis,
      sentimentColor: color,
      pdfUrl: '',
      emailSent: false
    };

    const html = reportHTML(record, '/assets/logo.png');
    saveHtml(html, `${record.submissionId}.html`);

    const pdfBuffer = await buildPdf(record);
    const pdfFileName = `${record.submissionId}.pdf`;
    const saved = savePdf(pdfBuffer, pdfFileName);
    record.pdfUrl = reportUrl(pdfFileName);

    let emailError = null;
    try {
      if (smtpConfig.smtpPass) {
        await sendFeedbackEmail(smtpConfig, record, pdfBuffer, record.pdfUrl);
        record.emailSent = true;
      } else {
        emailError = 'SMTP_PASS not set; email skipped.';
      }
    } catch (err) {
      emailError = err.message;
      console.error('[Email] send failed:', err.message);
    }

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
      comments: record.comments,
      suggestions: record.suggestions,
      sentiment: record.sentiment,
      summary: record.summary,
      urgency: record.urgency,
      highlights: record.highlights,
      improvementSuggestions: record.improvementSuggestions,
      pdfUrl: record.pdfUrl,
      emailSent: record.emailSent
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
      sentiment: record.sentiment,
      sentimentColor: color,
      urgency: record.urgency,
      summary: record.summary,
      usedAi,
      emailSent: record.emailSent,
      emailError,
      pdfUrl: record.pdfUrl,
      pdfFileName,
      pdfSize: saved.size
    });
  } catch (err) {
    console.error('[POST /api/feedback]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

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

// ---------- 4. Client management (internal admin) ----------
const CLIENT_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_UPLOAD_ROWS = 500;

const multer = require('multer');
const XLSX = require('xlsx');
const clientUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES }
});

function normalizeHeaderKey(key) {
  return String(key).toLowerCase().replace(/[\s_]+/g, '');
}

const BULK_COLUMNS = { name: 'name', email: 'email', companyname: 'company_name', servicetype: 'service_type', status: 'status' };

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
  return null;
}

function parseClientSheet(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: '' });
}

app.post('/api/clients/bulk-upload', async (req, res) => {
  clientUpload.single('file')(req, res, async (uploadErr) => {
    if (uploadErr) {
      if (uploadErr.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ ok: false, error: `File too large (max ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB).` });
      }
      return res.status(400).json({ ok: false, error: `Upload failed: ${uploadErr.message}` });
    }
    try {
      if (!req.file) {
        return res.status(400).json({ ok: false, error: 'No file provided.' });
      }
      const ext = path.extname(req.file.originalname).toLowerCase();
      if (!['.csv', '.xlsx'].includes(ext)) {
        return res.status(400).json({ ok: false, error: `Unsupported file type "${ext || 'unknown'}". Upload a .csv or .xlsx file.` });
      }

      let rows;
      try {
        rows = parseClientSheet(req.file.buffer);
      } catch (err) {
        return res.status(400).json({ ok: false, error: `Could not parse the file as ${ext === '.csv' ? 'CSV' : 'Excel'}: ${err.message}` });
      }
      if (!rows.length) {
        return res.status(400).json({ ok: false, error: 'The file has no data rows (header row required).' });
      }
      if (rows.length > MAX_UPLOAD_ROWS) {
        return res.status(400).json({ ok: false, error: `Too many rows (${rows.length}). Max ${MAX_UPLOAD_ROWS} clients per upload.` });
      }

      const existingEmails = new Set(await listClientEmails());
      const batchEmails = new Set();
      const added = [];
      const skipped = [];
      let rowNum = 1;

      for (const raw of rows) {
        rowNum += 1;
        const mapped = mapClientRow(raw);
        const reason = clientRowValidationError(mapped);
        if (reason) {
          skipped.push({ row: rowNum, reason });
          continue;
        }
        const emailKey = mapped.email.toLowerCase();
        if (existingEmails.has(emailKey) || batchEmails.has(emailKey)) {
          skipped.push({ row: rowNum, reason: 'duplicate email' });
          continue;
        }

        const client = await insertClient({
          name: mapped.name,
          email: mapped.email,
          company_name: mapped.company_name,
          service_type: mapped.service_type,
          status: (mapped.status || 'active').toLowerCase()
        });
        added.push(client);
        existingEmails.add(emailKey);
        batchEmails.add(emailKey);
      }

      console.log(`[BulkUpload] ${req.file.originalname}: ${added.length} added, ${skipped.length} skipped`);
      res.status(201).json({ ok: true, added: added.length, skipped, total: added.length + skipped.length });
    } catch (err) {
      console.error('[POST /api/clients/bulk-upload]', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });
});

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

    const batchEmails = new Set();
    const skipped = [];
    let inserted = 0;
    let updated = 0;

    for (const raw of clients) {
      const mapped = mapClientRow(raw);
      const reason = clientRowValidationError(mapped);
      if (reason) {
        skipped.push({ row: clients.indexOf(raw) + 1, reason });
        continue;
      }
      const emailKey = mapped.email.toLowerCase();
      if (batchEmails.has(emailKey)) {
        skipped.push({ row: clients.indexOf(raw) + 1, reason: 'duplicate email' });
        continue;
      }
      batchEmails.add(emailKey);
      const { action } = await upsertClientByEmail({
        name: mapped.name,
        email: mapped.email,
        company_name: mapped.company_name,
        service_type: mapped.service_type,
        status: (mapped.status || 'active').toLowerCase()
      });
      if (action === 'inserted') inserted += 1;
      else updated += 1;
    }

    console.log(`[ClientSync] ${clients.length} rows: ${inserted} inserted, ${updated} updated, ${skipped.length} skipped`);
    res.json({ ok: true, inserted, updated, skipped, total: clients.length });
  } catch (err) {
    console.error('[POST /api/clients/sync]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/clients', async (req, res) => {
  try {
    const { name, email, company_name, service_type, status } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ ok: false, error: 'Name is required.' });
    }
    if (!email || !CLIENT_EMAIL_RE.test(String(email).trim())) {
      return res.status(400).json({ ok: false, error: 'A valid email is required.' });
    }
    if (status && !['active', 'inactive'].includes(status)) {
      return res.status(400).json({ ok: false, error: "Status must be 'active' or 'inactive'." });
    }
    const client = await insertClient({
      name,
      email,
      company_name,
      service_type,
      status
    });
    res.status(201).json({ ok: true, data: client });
  } catch (err) {
    console.error('[POST /api/clients]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/clients', async (req, res) => {
  try {
    const rows = await listClients();
    res.json({ ok: true, count: rows.length, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.patch('/api/clients/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { status } = req.body || {};
    if (!['active', 'inactive'].includes(status)) {
      return res.status(400).json({ ok: false, error: "Status must be 'active' or 'inactive'." });
    }
    const client = await updateClientStatus(id, status);
    if (!client) {
      return res.status(404).json({ ok: false, error: 'Client not found.' });
    }
    res.json({ ok: true, data: client });
  } catch (err) {
    console.error('[PATCH /api/clients/:id]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/clients/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
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
    saveHtml(html, `combined-${from}-to-${to}.html`);

    const pdfBuffer = await buildCombinedPdf(meta, rows);
    const pdfFileName = `combined-${from}-to-${to}.pdf`;
    const saved = savePdf(pdfBuffer, pdfFileName);
    const pdfUrl = reportUrl(pdfFileName);

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

// ---------- Static: generated reports + frontend ----------
app.use('/reports', express.static(reportsDir));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- Token-based feedback form (Phase 2) ----------
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
  </style>
</head>
<body class="min-h-screen bg-white text-ink antialiased">
  <main id="formView" class="max-w-xl mx-auto px-4 py-10">
    <div class="flex flex-col items-center mb-8">
      <img src="/assets/logo.png" alt="Logo" class="w-[150px] h-[150px] object-contain drop-shadow-sm" />
      <h1 class="mt-4 text-2xl font-extrabold tracking-tight">Client Feedback</h1>
      <p class="text-sm text-gray-500 mt-1">We value your feedback and appreciate your time.</p>
      <p class="text-xs text-gray-400 mt-2">${linkNotice}</p>
    </div>

    <form id="feedbackForm" class="bg-white border-2 border-brand rounded-3xl shadow-lg p-6 sm:p-8 space-y-5">
      <input type="hidden" name="token" value="${esc(request.token)}" />
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-5">
        <div>
          <label for="eventName" class="block text-sm font-bold mb-1.5">Service</label>
          <input id="eventName" name="eventName" type="text" value="${esc(client.service_type || '')}" readonly
            class="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm focus:outline-none" />
        </div>
        <div>
          <label for="companyName" class="block text-sm font-bold mb-1.5">Company Name <span class="text-gray-400 font-normal">(Optional)</span></label>
          <input id="companyName" name="companyName" type="text" value="${esc(client.company_name || '')}" placeholder="Enter company name"
            class="w-full rounded-xl border border-gray-200 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand focus:border-brand" />
        </div>
        <div>
          <label for="attendeeName" class="block text-sm font-bold mb-1.5">Name</label>
          <input id="attendeeName" name="attendeeName" type="text" value="${esc(client.name || '')}" placeholder="Enter your name"
            class="w-full rounded-xl border border-gray-200 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand focus:border-brand" />
        </div>
        <div>
          <label for="attendeeEmail" class="block text-sm font-bold mb-1.5">Email</label>
          <input id="attendeeEmail" name="attendeeEmail" type="email" value="${esc(client.email || '')}" placeholder="Enter your email"
            class="w-full rounded-xl border border-gray-200 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand focus:border-brand" />
        </div>
      </div>

      <div>
        <span class="block text-sm font-bold mb-2">Overall Rating *</span>
        <div id="starRow" class="flex items-center gap-1">
          <input type="hidden" name="rating" id="rating" value="5" />
          <button type="button" data-star="1" aria-label="1 star" class="star text-4xl leading-none text-gray-200 transition hover:scale-110">★</button>
          <button type="button" data-star="2" aria-label="2 stars" class="star text-4xl leading-none text-gray-200 transition hover:scale-110">★</button>
          <button type="button" data-star="3" aria-label="3 stars" class="star text-4xl leading-none text-gray-200 transition hover:scale-110">★</button>
          <button type="button" data-star="4" aria-label="4 stars" class="star text-4xl leading-none text-gray-200 transition hover:scale-110">★</button>
          <button type="button" data-star="5" aria-label="5 stars" class="star text-4xl leading-none text-gray-200 transition hover:scale-110">★</button>
          <span id="ratingLabel" class="ml-3 text-sm font-bold text-gray-600">5 / 5</span>
        </div>
      </div>

      <div>
        <label for="comments" class="block text-sm font-bold mb-1.5">Client Feedback </label>
        <textarea id="comments" name="comments" rows="4" required placeholder="Share your feedback"
          class="w-full rounded-xl border border-gray-200 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand focus:border-brand"></textarea>
      </div>

      <div>
        <label for="suggestions" class="block text-sm font-bold mb-1.5">Suggestions</label>
        <textarea id="suggestions" name="suggestions" rows="3" placeholder="Share your suggestions"
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
      <p class="mt-2 text-gray-500 text-sm">Your response has been recorded and sent to our team.</p>
    </div>
  </main>

  <script>
    const starButtons = document.querySelectorAll('.star');
    const ratingInput = document.getElementById('rating');
    const ratingLabel = document.getElementById('ratingLabel');

    function paintStars(n) {
      starButtons.forEach((b, i) => {
        b.classList.toggle('text-brand', i < n);
        b.classList.toggle('text-gray-200', i >= n);
      });
      ratingInput.value = n;
      ratingLabel.textContent = n + ' / 5';
    }
    starButtons.forEach((b) => {
      b.addEventListener('click', () => paintStars(Number(b.dataset.star)));
      b.addEventListener('mouseenter', () => paintStars(Number(b.dataset.star)));
    });
    document.getElementById('starRow').addEventListener('mouseleave', () => paintStars(Number(ratingInput.value)));
    paintStars(5);

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
    <img src="/assets/logo.png" alt="Logo" class="w-24 h-24 object-contain mx-auto mb-6" />
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
const MONTHLY_SEND_CRON = process.env.MONTHLY_SEND_CRON || '0 9 1 * *';
const SIX_MONTH_REPORT_CRON = process.env.SIX_MONTH_REPORT_CRON || '0 9 1 1,7 *';

function runMonthlySend() {
  return sendMonthlyFeedbackForms({ smtpConfig, appBaseUrl: APP_BASE_URL })
    .catch((err) => console.error('[Cron] monthly send failed:', err));
}

function runSixMonthReport() {
  return generateSixMonthReport({ smtpConfig, geminiApiKey, reportUrl, savePdf, saveHtml })
    .catch((err) => console.error('[Cron] six-month report failed:', err));
}

cron.schedule(MONTHLY_SEND_CRON, () => runMonthlySend());
cron.schedule(SIX_MONTH_REPORT_CRON, () => runSixMonthReport());

const CRON_SECRET = process.env.CRON_SECRET || '';

function requireCronSecret(req, res, next) {
  if (CRON_SECRET && req.headers['x-cron-secret'] !== CRON_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

app.post('/api/cron/monthly-send', requireCronSecret, async (req, res) => {
  try {
    const result = await runMonthlySend();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/cron/six-month-report', requireCronSecret, async (req, res) => {
  try {
    const result = await runSixMonthReport();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/health', async (req, res) => {
  try {
    const db = await pingDb();
    res.json({ ok: true, geminiConfigured: !!geminiApiKey, smtpConfigured: !!smtpConfig.smtpPass, db });
  } catch (err) {
    res.json({ ok: true, geminiConfigured: !!geminiApiKey, smtpConfigured: !!smtpConfig.smtpPass, db: { mode: dbMode(), ok: false, error: err.message } });
  }
});

// Vercel serverless: the app is exported and never started here; the
// /api/cron/* endpoints can still be triggered externally (cron scheduling
// via Vercel Cron jobs instead of node-cron).
if (require.main === module) {
  cron.schedule(MONTHLY_SEND_CRON, () => runMonthlySend());
  cron.schedule(SIX_MONTH_REPORT_CRON, () => runSixMonthReport());

  app.listen(PORT, () => {
    console.log(`Client Feedback System running at ${PUBLIC_URL}`);
    console.log(`  Gemini: ${geminiApiKey ? 'configured' : 'NOT configured (fallback analysis used)'}`);
    console.log(`  SMTP:   ${smtpConfig.smtpPass ? 'configured' : 'NOT configured (emails skipped)'}`);
    console.log(`  Cron monthly send:     "${MONTHLY_SEND_CRON}" (sendMonthlyFeedbackForms)`);
    console.log(`  Cron 6-month report:   "${SIX_MONTH_REPORT_CRON}" (generateSixMonthReport)`);
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
