const nodemailer = require('nodemailer');

function createTransport(config) {
  return nodemailer.createTransport({
    host: config.smtpHost,
    port: Number(config.smtpPort) || 465,
    secure: true,
    auth: {
      user: config.smtpUser,
      pass: config.smtpPass
    }
  });
}

function feedbackEmailBody(record, pdfUrl) {
  return [
    `New event feedback received.`,
    ``,
    `Event Name: ${record.eventName}`,
    `Rating: ${record.rating}/5`,
    `Sentiment: ${record.sentiment}`,
    `Urgency: ${record.urgency}`,
    ``,
    `AI Summary:`,
    record.summary,
    ``,
    `PDF Report: ${pdfUrl}`,
    `Submission ID: ${record.submissionId}`,
    `Timestamp: ${record.timestamp}`,
    ``
  ].join('\n');
}

function combinedEmailBody(meta, pdfUrl, count) {
  const b = meta.overallSentimentBreakdown;
  return [
    `Combined event feedback report for ${meta.from} → ${meta.to}.`,
    `Submissions included: ${count}`,
    ``,
    `Overall Summary:`,
    meta.overallSummary,
    ``,
    `Sentiment Breakdown:`,
    `  Positive: ${b.positive}`,
    `  Neutral: ${b.neutral}`,
    `  Negative: ${b.negative}`,
    ``,
    `Key Highlights:`,
    meta.keyHighlights.map((h) => `  - ${h}`).join('\n'),
    ``,
    `Top Improvement Suggestions:`,
    meta.topImprovementSuggestions.map((s) => `  - ${s}`).join('\n'),
    ``,
    `PDF Report: ${pdfUrl}`,
    `Generated: ${meta.generatedAt}`,
    ``
  ].join('\n');
}

async function sendFeedbackEmail(config, record, pdfBuffer, pdfUrl) {
  const mailer = createTransport(config);
  const info = await mailer.sendMail({
    from: `"Event Feedback" <${config.smtpUser}>`,
    to: config.adminEmail,
    subject: `New Event Feedback – ${record.eventName} (${record.rating}/5)`,
    text: feedbackEmailBody(record, pdfUrl),
    attachments: pdfBuffer
      ? [{ filename: `${record.submissionId}.pdf`, content: pdfBuffer, contentType: 'application/pdf' }]
      : []
  });
  return info;
}

async function sendCombinedEmail(config, meta, pdfBuffer, pdfUrl, count) {
  const mailer = createTransport(config);
  const info = await mailer.sendMail({
    from: `"Event Feedback" <${config.smtpUser}>`,
    to: config.adminEmail,
    subject: `Combined Feedback Report ${meta.from} to ${meta.to} (${count} submissions)`,
    text: combinedEmailBody(meta, pdfUrl, count),
    attachments: pdfBuffer
      ? [{ filename: `combined-feedback-${meta.from}-to-${meta.to}.pdf`, content: pdfBuffer, contentType: 'application/pdf' }]
      : []
  });
  return info;
}

module.exports = { sendFeedbackEmail, sendCombinedEmail };
