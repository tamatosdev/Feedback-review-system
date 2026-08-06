require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const { cleanData } = require('./cleanData');
const { analyzeFeedback, analyzeCombined, sentimentColor } = require('./gemini');
const { reportHTML, combinedHTML } = require('./report');
const { buildPdf, buildCombinedPdf } = require('./pdf');
const { sendFeedbackEmail, sendCombinedEmail } = require('./email');
const { insertFeedback, queryFeedback, stats } = require('./db');

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

const reportsDir = path.join(__dirname, '..', 'reports');
if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

const smtpConfig = {
  smtpHost: process.env.SMTP_HOST || 'smtp.hostinger.com',
  smtpPort: Number(process.env.SMTP_PORT) || 465,
  smtpUser: process.env.SMTP_USER || 'tahir@puredesigners.com',
  smtpPass: process.env.SMTP_PASS || '',
  adminEmail: process.env.ADMIN_EMAIL || 'tahir@puredesigners.com'
};
const geminiApiKey = process.env.GEMINI_API_KEY || '';

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
    const cleaned = cleanData(req.body || {});

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

    insertFeedback({
      submissionId: record.submissionId,
      timestamp: record.timestamp,
      eventName: record.eventName,
      eventDate: record.eventDate,
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

    res.status(201).json({
      ok: true,
      submissionId: record.submissionId,
      timestamp: record.timestamp,
      eventName: record.eventName,
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
app.get('/api/feedback', (req, res) => {
  try {
    const rows = queryFeedback({
      from: req.query.from,
      to: req.query.to,
      sentiment: req.query.sentiment,
      eventName: req.query.eventName
    });
    res.json({ ok: true, count: rows.length, data: rows.map((r) => ({ ...r, sentimentColor: sentimentColor(r.sentiment), htmlUrl: reportUrl(`${r.submissionId}.html`) })) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- 3. Dashboard stats ----------
app.get('/api/stats', (req, res) => {
  try {
    res.json({ ok: true, data: stats({ from: req.query.from, to: req.query.to }) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- 4. Date-range combined report: fetch -> Gemini -> PDF -> email ----------
app.post('/api/reports/combined', async (req, res) => {
  try {
    const from = String(req.body?.from || '').slice(0, 10);
    const to = String(req.body?.to || '').slice(0, 10);
    if (!from || !to) {
      return res.status(400).json({ ok: false, error: 'Both from and to dates are required.' });
    }

    const rows = queryFeedback({ from, to });
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

app.get('/api/health', (req, res) => res.json({ ok: true, geminiConfigured: !!geminiApiKey, smtpConfigured: !!smtpConfig.smtpPass }));

app.listen(PORT, () => {
  console.log(`Client Feedback System running at ${PUBLIC_URL}`);
  console.log(`  Gemini: ${geminiApiKey ? 'configured' : 'NOT configured (fallback analysis used)'}`);
  console.log(`  SMTP:   ${smtpConfig.smtpPass ? 'configured' : 'NOT configured (emails skipped)'}`);
});
