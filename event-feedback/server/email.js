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
    `New client feedback received.`,
    ``,
    `Project Name / Service Name: ${record.eventName}`,
    `Overall Rating: ${record.rating}/5`,
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
    `Combined client feedback report for ${meta.from} → ${meta.to}.`,
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
    from: `"Client Feedback" <${config.smtpUser}>`,
    to: config.adminEmail,
    subject: `New Client Feedback – ${record.eventName} (${record.rating}/5)`,
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
    from: `"Client Feedback" <${config.smtpUser}>`,
    to: config.adminEmail,
    subject: `Combined Client Feedback Report ${meta.from} to ${meta.to} (${count} submissions)`,
    text: combinedEmailBody(meta, pdfUrl, count),
    attachments: pdfBuffer
      ? [{ filename: `combined-feedback-${meta.from}-to-${meta.to}.pdf`, content: pdfBuffer, contentType: 'application/pdf' }]
      : []
  });
  return info;
}

function clientFeedbackRequestBody(client, link) {
  const company = client.company_name || client.name || 'your service';
  return [
    `Hi ${client.name},`,
    ``,
    `Thank you for working with us. We'd love to hear how things went with ${client.service_type || 'our service'} so we can keep improving.`,
    ``,
    `Please take a minute to complete our short feedback form:`,
    link,
    ``,
    `Your answers will only take about a minute — thank you for your time.`,
    ``,
    `Best regards,`,
    `PureDesigners`
  ].join('\n');
}

async function sendClientFeedbackRequest(config, client, link) {
  const mailer = createTransport(config);
  const company = client.company_name || client.name || 'Service';
  const info = await mailer.sendMail({
    from: `"PureDesigners" <${config.smtpUser}>`,
    to: client.email,
    subject: `Your feedback matters — ${company} service update`,
    text: clientFeedbackRequestBody(client, link)
  });
  return info;
}

async function sendNoFeedbackEmail(config, from, to) {
  const mailer = createTransport(config);
  const info = await mailer.sendMail({
    from: `"Client Feedback" <${config.smtpUser}>`,
    to: config.adminEmail,
    subject: `No client feedback received ${from} to ${to}`,
    text: [
      `No feedback submissions were received between ${from} and ${to}.`,
      ``,
      `No combined report was generated for this period.`,
      ``
    ].join('\n')
  });
  return info;
}

module.exports = { sendFeedbackEmail, sendCombinedEmail, sendClientFeedbackRequest, sendNoFeedbackEmail, clientFeedbackRequestBody };
