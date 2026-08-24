const nodemailer = require('nodemailer');
const { DEPARTMENT_SCORES, scoreText, esc, serviceNameOf, safeText } = require('./report');

const BRAND_NAME = 'Craftsmen Media';

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
  const departmentLines = DEPARTMENT_SCORES
    .map(([key, label]) => `  ${label}: ${scoreText(record[key])}`)
    .join('\n');
  return [
    `New client feedback received.`,
    ``,
    `Project Name / Service Name: ${safeText(serviceNameOf(record))}`,
    `Overall Rating: ${record.rating}/5`,
    ``,
    `Department Ratings:`,
    departmentLines,
    ``,
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

async function sendFeedbackEmail(config, record, pdfBuffer, pdfUrl, extraRecipients) {
  // Always notify ADMIN_EMAIL; additionally copy any extra recipients (e.g. the
  // client's Account Manager) so they receive the same notification content.
  const to = [config.adminEmail, ...(extraRecipients || []).filter(Boolean)];
  const mailer = createTransport(config);
  const info = await mailer.sendMail({
    from: `"Client Feedback" <${config.smtpUser}>`,
    to,
    subject: `New Client Feedback – ${safeText(serviceNameOf(record))} (${record.rating}/5)`,
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
  const company = client.name || 'your service';
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
    `${BRAND_NAME}`
  ].join('\n');
}

async function sendClientFeedbackRequest(config, client, link) {
  const mailer = createTransport(config);
  const company = client.name || 'Service';
  const info = await mailer.sendMail({
    from: `"${BRAND_NAME}" <${config.smtpUser}>`,
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

// ---------- Phase 3: automated alert emails ----------

function wrapAlertContent(title, lines) {
  const text = [title, '', ...lines, '', `— ${BRAND_NAME} Client Feedback System`].join('\n');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#111827">` +
    `<p style="font-weight:bold;font-size:16px;margin:0 0 10px">${esc(title)}</p>` +
    lines.map((l) => `<p style="margin:0 0 6px">${l ? esc(l) : '&nbsp;'}</p>`).join('') +
    `<p style="margin:16px 0 0;color:#6b7280;font-size:12px">— ${BRAND_NAME} Client Feedback System</p></div>`;
  return { text, html };
}

function lowScoreAlertContent({ client, score, month, threshold, dashboardUrl }) {
  const subject = `ALERT: Low overall score — ${client.name} (${score}/5)`;
  return { subject, ...wrapAlertContent(subject, [
    `Client: ${client.name} (${client.email || 'no email'})`,
    `Overall rating (Agency Leadership): ${score}/5 — below the ${threshold} threshold.`,
    `Month: ${month}`,
    `Service: ${client.service_type || 'General'}`,
    ``,
    `Dashboard: ${dashboardUrl}`
  ]) };
}

function lowDepartmentAlertContent({ departmentLabel, avg, month, threshold, dashboardUrl }) {
  const subject = `ALERT: ${departmentLabel} average below ${threshold} (${avg.toFixed(2)}) — ${month}`;
  return { subject, ...wrapAlertContent(subject, [
    `Department: ${departmentLabel}`,
    `Average rating for ${month}: ${avg.toFixed(2)} — below the ${threshold} threshold.`,
    ``,
    `Dashboard: ${dashboardUrl}`
  ]) };
}

function momDropAlertContent({ client, month, previousScore, previousMonth, currentScore, drop, threshold, dashboardUrl }) {
  const subject = `ALERT: Score drop for ${client.name} (${previousScore} → ${currentScore}) — ${month}`;
  return { subject, ...wrapAlertContent(subject, [
    `Client: ${client.name} (${client.email || 'no email'})`,
    `Agency Leadership score ${previousMonth}: ${previousScore}/5`,
    `Agency Leadership score ${month}: ${currentScore}/5`,
    `Drop: ${drop} point(s) — meets the ${threshold} drop threshold.`,
    ``,
    `Dashboard: ${dashboardUrl}`
  ]) };
}

function escalationAlertContent({ client, score, month, streak, months, threshold, dashboardUrl }) {
  const subject = `ESCALATION: ${client.name} below ${threshold} for ${streak} consecutive months`;
  return { subject, ...wrapAlertContent(subject, [
    `Client: ${client.name} (${client.email || 'no email'})`,
    `Consecutive months below ${threshold}: ${streak}`,
    `Months: ${months.join(', ')}`,
    `Latest Agency Leadership score (${month}): ${score}/5`,
    ``,
    `Dashboard: ${dashboardUrl}`
  ]) };
}

function noResponseClientReminderContent({ name, service_type }, month, days, link) {
  const company = name || 'your service';
  const subject = `Reminder: Monthly feedback for ${company} (${month})`;
  return { subject, ...wrapAlertContent(subject, [
    `Hi ${name},`,
    ``,
    `We sent you a short feedback form for ${service_type || 'our service'} ${days} day${days === 1 ? '' : 's'} ago and haven't heard back yet — your answers help us keep improving.`,
    ``,
    `It only takes about a minute:`,
    link,
    ``,
    `Thanks for your time!`
  ]) };
}

function noResponseInternalAlertContent({ name, email }, month, days, dashboardUrl) {
  const subject = `ALERT: No response — ${name} (${month}, ${days} day${days === 1 ? '' : 's'})`;
  return { subject, ...wrapAlertContent(subject, [
    `Client: ${name} (${email || 'no email'})`,
    `Monthly feedback link sent for ${month}, no submission after ${days} day${days === 1 ? '' : 's'}.`,
    ``,
    `A reminder has been sent to the client.`,
    `Dashboard: ${dashboardUrl}`
  ]) };
}

async function sendAlertEmail(config, { to, subject, text, html }) {
  const mailer = createTransport(config);
  const info = await mailer.sendMail({
    from: `"Client Feedback" <${config.smtpUser}>`,
    to,
    subject,
    text,
    html
  });
  return info;
}

module.exports = {
  sendFeedbackEmail,
  sendCombinedEmail,
  sendClientFeedbackRequest,
  sendNoFeedbackEmail,
  clientFeedbackRequestBody,
  feedbackEmailBody,
  sendAlertEmail,
  lowScoreAlertContent,
  lowDepartmentAlertContent,
  momDropAlertContent,
  escalationAlertContent,
  noResponseClientReminderContent,
  noResponseInternalAlertContent
};
