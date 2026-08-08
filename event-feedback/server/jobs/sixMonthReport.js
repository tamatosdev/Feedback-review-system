const { queryFeedbackByMonth } = require('../db');
const { analyzeCombined } = require('../gemini');
const { combinedHTML } = require('../report');
const { buildCombinedPdf } = require('../pdf');
const { sendCombinedEmail, sendNoFeedbackEmail } = require('../email');

const CHUNK_SIZE = 20;
const SMALL_BATCH_LIMIT = 45;

function fmtMonth(year, monthIndex) {
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
}

/** Last 6 months inclusive (current month back 5). e.g. Aug 2026 -> { fromMonth: '2026-03', toMonth: '2026-08' } */
function sixMonthRange(now = new Date()) {
  const endYear = now.getFullYear();
  const endMonth = now.getMonth();
  let startYear = endYear;
  let startMonth = endMonth - 5;
  if (startMonth < 0) {
    startYear -= 1;
    startMonth += 12;
  }
  return { fromMonth: fmtMonth(startYear, startMonth), toMonth: fmtMonth(endYear, endMonth) };
}

/**
 * Chunked map-reduce for large volumes: summarize each chunk of ~20 rows
 * with Gemini, then feed all chunk summaries into one final Gemini call to
 * produce a result in the same shape analyzeCombined() returns.
 */
async function analyzeLarge(feedbackRows, { apiKey } = {}) {
  if (!apiKey) return analyzeCombined(feedbackRows, { apiKey: '' });

  const chunks = [];
  for (let i = 0; i < feedbackRows.length; i += CHUNK_SIZE) {
    chunks.push(feedbackRows.slice(i, i + CHUNK_SIZE));
  }

  const summaries = [];
  for (const chunk of chunks) {
    summaries.push(await analyzeCombined(chunk, { apiKey }));
  }
  if (summaries.length === 1) return summaries[0];

  const combinedBreakdown = summaries.reduce(
    (acc, s) => {
      acc.positive += Number(s.overallSentimentBreakdown?.positive) || 0;
      acc.neutral += Number(s.overallSentimentBreakdown?.neutral) || 0;
      acc.negative += Number(s.overallSentimentBreakdown?.negative) || 0;
      return acc;
    },
    { positive: 0, neutral: 0, negative: 0 }
  );

  const pseudoRows = summaries.map((s, i) => ({
    eventName: `Chunk ${i + 1}`,
    rating: 0,
    comments: s.overallSummary || '(no summary)',
    suggestions: Array.isArray(s.topImprovementSuggestions) ? s.topImprovementSuggestions.join('; ') : ''
  }));

  const final = await analyzeCombined(pseudoRows, { apiKey });
  return { ...final, overallSentimentBreakdown: combinedBreakdown };
}

/**
 * Cron job (default: 09:00 on Jan 1 and Jul 1). Summarizes all feedback
 * from the last 6 months into a combined trend report and emails the admin.
 */
async function generateSixMonthReport({ smtpConfig, geminiApiKey, reportUrl, savePdf, saveHtml, fallbackReportUrl } = {}) {
  const { fromMonth, toMonth } = sixMonthRange();
  const rows = await queryFeedbackByMonth({ fromMonth, toMonth });

  if (!rows.length) {
    console.log(`[SixMonthReport] No feedback received ${fromMonth} to ${toMonth}; sending notice`);
    let emailSent = false;
    let emailError = null;
    try {
      if (smtpConfig?.smtpPass) {
        await sendNoFeedbackEmail(smtpConfig, fromMonth, toMonth);
        emailSent = true;
      } else {
        emailError = 'SMTP_PASS not set; email skipped.';
      }
    } catch (err) {
      emailError = err.message;
      console.error('[Email] no-feedback notice send failed:', err.message);
    }
    return { ok: true, count: 0, fromMonth, toMonth, emailSent, emailError, noFeedback: true };
  }

  const overall = rows.length > SMALL_BATCH_LIMIT
    ? await analyzeLarge(rows, { apiKey: geminiApiKey })
    : await analyzeCombined(rows, { apiKey: geminiApiKey });

  const meta = { from: fromMonth, to: toMonth, generatedAt: new Date().toISOString(), ...overall };

  const html = combinedHTML(meta, rows, '/assets/logo.png');
  await saveHtml(html, `combined-${fromMonth}-to-${toMonth}.html`);

  const pdfBuffer = await buildCombinedPdf(meta, rows);
  const pdfFileName = `combined-${fromMonth}-to-${toMonth}.pdf`;
  const saved = await savePdf(pdfBuffer, pdfFileName);
  const pdfUrl = saved.fallback ? fallbackReportUrl(pdfFileName) : reportUrl(pdfFileName);

  let emailSent = false;
  let emailError = null;
  try {
    if (smtpConfig?.smtpPass) {
      await sendCombinedEmail(smtpConfig, meta, pdfBuffer, pdfUrl, rows.length);
      emailSent = true;
    } else {
      emailError = 'SMTP_PASS not set; email skipped.';
    }
  } catch (err) {
    emailError = err.message;
    console.error('[Email] six-month combined send failed:', err.message);
  }

  console.log(`[SixMonthReport] Combined report for ${fromMonth} to ${toMonth}: ${rows.length} submissions, email ${emailSent ? 'sent' : 'not sent'}`);
  return { ok: true, count: rows.length, fromMonth, toMonth, emailSent, emailError, pdfUrl, pdfFileName, pdfSize: saved.size };
}

module.exports = { generateSixMonthReport, sixMonthRange, analyzeLarge, CHUNK_SIZE, SMALL_BATCH_LIMIT };
