const { sentimentColor } = require('./gemini');

const ACCENT = '#FFF000';
const BLACK = '#111827';

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stars(rating) {
  const full = '★'.repeat(Math.max(0, Math.min(5, rating)));
  const empty = '☆'.repeat(5 - full.length);
  return `<span style="color:#FFF000;font-size:26px;letter-spacing:2px;text-shadow:0 1px 0 rgba(0,0,0,.15)">${full}</span><span style="color:#d1d5db;font-size:26px;letter-spacing:2px">${empty}</span>`;
}

function badge(sentiment) {
  const c = sentimentColor(sentiment);
  return `<span style="display:inline-block;background:${c.bg};color:${c.badge};font-weight:700;padding:6px 16px;border-radius:999px;font-size:13px;letter-spacing:.4px">${esc(sentiment)}</span>`;
}

function listItems(items) {
  if (!Array.isArray(items) || !items.length) return '<li>—</li>';
  return items.map((i) => `<li>${esc(i)}</li>`).join('');
}

function infoRow(label, value) {
  return `<tr><td style="padding:8px 12px;font-weight:700;color:${BLACK};width:220px;background:#f9fafb">${esc(label)}</td><td style="padding:8px 12px;color:${BLACK}">${value}</td></tr>`;
}

function badgeRow(sentiment) {
  return `<tr><td style="padding:8px 12px;font-weight:700;color:${BLACK};width:220px;background:#f9fafb">Sentiment</td><td style="padding:8px 12px;color:${BLACK}">${badge(sentiment)}</td></tr>`;
}

function reportHTML(record, logoPath) {
  const hasEmail = record.attendeeEmail && record.hasValidEmail !== false;
  const logo = logoPath
    ? `<img src="${logoPath}" alt="Logo" width="64" style="vertical-align:middle;margin-right:12px"/>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>Client Feedback Report – ${esc(record.eventName)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
</head>
<body style="margin:0;padding:32px;background:#ffffff;color:${BLACK};font-family:'Inter',Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:720px;margin:0 auto;border:2px solid ${ACCENT};border-radius:16px;overflow:hidden">
    <tr>
      <td style="padding:28px 32px;background:#ffffff;border-bottom:2px solid ${ACCENT}">
        ${logo}<span style="font-size:20px;font-weight:800;color:${BLACK}">Client Feedback Report</span>
      </td>
    </tr>
    <tr>
      <td style="padding:28px 32px">
        <h2 style="color:${ACCENT};text-shadow:0 1px 0 rgba(0,0,0,.25);font-size:18px;margin:24px 0 10px;letter-spacing:.5px">PROJECT / SERVICE INFORMATION</h2>
        <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden">
          ${infoRow('Project Name / Service Name', record.eventName)}
          ${infoRow('Service Date / Project Completion Date', record.eventDate || 'Not provided')}
          ${infoRow('Overall Rating', `${record.rating} / 5`)}
          ${badgeRow(record.sentiment)}
        </table>

        <h2 style="color:${ACCENT};font-size:18px;margin:30px 0 10px;letter-spacing:.5px">CLIENT INFORMATION</h2>
        <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden">
          ${infoRow('Name', record.attendeeName)}
          ${infoRow('Email', hasEmail ? record.attendeeEmail : 'Not provided')}
          ${infoRow('Company', record.companyName || 'Not provided')}
        </table>

        <h2 style="color:${ACCENT};font-size:18px;margin:30px 0 10px;letter-spacing:.5px">OVERALL RATING</h2>
        <div style="border:1px solid #e5e7eb;border-radius:10px;padding:16px 20px">${stars(record.rating)}</div>

        <h2 style="color:${ACCENT};font-size:18px;margin:30px 0 10px;letter-spacing:.5px">AI ANALYSIS</h2>
        <div style="border:1px solid #e5e7eb;border-radius:10px;padding:18px 20px">
          <p style="margin:0 0 14px"><strong>Summary:</strong> ${esc(record.summary)}</p>
          <p style="margin:0 0 4px"><strong>Highlights:</strong></p>
          <ul>${listItems(record.highlights)}</ul>
          <p style="margin:14px 0 4px"><strong>Improvement Suggestions:</strong></p>
          <ul>${listItems(record.improvementSuggestions)}</ul>
          <p style="margin:14px 0 0"><strong>Urgency:</strong> ${esc(record.urgency)}</p>
        </div>

        <h2 style="color:${ACCENT};font-size:18px;margin:30px 0 10px;letter-spacing:.5px">ORIGINAL CLIENT FEEDBACK</h2>
        <div style="border:1px solid #e5e7eb;border-radius:10px;padding:18px 20px">
          <p style="margin:0 0 10px"><strong>Client Feedback / Comments:</strong> ${esc(record.comments)}</p>
          <p style="margin:0"><strong>Suggestions / Recommendations:</strong> ${esc(record.suggestions)}</p>
        </div>

        <p style="margin:30px 0 0;color:#6b7280;font-size:12px">
          Submission ID: ${esc(record.submissionId)} &nbsp;·&nbsp; Submitted: ${esc(record.timestamp)}
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function combinedHTML(meta, rows, logoPath) {
  const logo = logoPath
    ? `<img src="${logoPath}" alt="Logo" width="64" style="vertical-align:middle;margin-right:12px"/>`
    : '';

  const sections = rows.map((r, i) => `
    <tr><td style="padding:22px 0 6px">
      <h3 style="color:${BLACK};margin:0;font-size:15px">#${i + 1} – ${esc(r.serviceType || r.eventName)}</h3>
      <span style="color:#6b7280;font-size:12px">${esc(r.attendeeName)} · ${esc(r.month || r.eventDate)} · ${esc(r.submissionId)}</span>
      <div style="margin-top:8px">${stars(r.rating)} &nbsp; ${badge(r.sentiment)}</div>
    </td></tr>
    <tr><td style="padding:4px 0;color:${BLACK}"><strong>Summary:</strong> ${esc(r.summary)}</td></tr>
    <tr><td style="padding:4px 0;color:${BLACK}"><strong>Highlights:</strong> ${esc(r.highlights.join('; '))}</td></tr>
    <tr><td style="padding:4px 0;color:${BLACK}"><strong>Improvement Suggestions:</strong> ${esc(r.improvementSuggestions.join('; '))}</td></tr>
    <tr><td style="padding:4px 0 10px;color:${BLACK}"><strong>Original client feedback:</strong> ${esc(r.comments)}</td></tr>`).join('');

  const b = meta.overallSentimentBreakdown;
  const total = Math.max(1, b.positive + b.neutral + b.negative);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>Combined Client Feedback Report – ${esc(meta.from)} to ${esc(meta.to)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
</head>
<body style="margin:0;padding:32px;background:#ffffff;color:${BLACK};font-family:'Inter',Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:760px;margin:0 auto;border:2px solid ${ACCENT};border-radius:16px;overflow:hidden">
    <tr><td style="padding:28px 32px;border-bottom:2px solid ${ACCENT}">
      ${logo}<span style="font-size:20px;font-weight:800;color:${BLACK}">Combined Client Feedback Report</span>
    </td></tr>
    <tr><td style="padding:28px 32px">
      <p style="margin:0;color:#6b7280;font-size:13px">Date range: ${esc(meta.from)} → ${esc(meta.to)} · ${rows.length} submission(s)</p>

      <h2 style="color:${ACCENT};font-size:18px;margin:24px 0 10px;letter-spacing:.5px">OVERALL AI ANALYSIS</h2>
      <div style="border:1px solid #e5e7eb;border-radius:10px;padding:18px 20px">
        <p style="margin:0 0 12px"><strong>Overall summary:</strong> ${esc(meta.overallSummary)}</p>
        <p style="margin:0 0 4px"><strong>Sentiment breakdown:</strong></p>
        <ul>
          <li>Positive: ${b.positive} (${Math.round((b.positive / total) * 100)}%)</li>
          <li>Neutral: ${b.neutral} (${Math.round((b.neutral / total) * 100)}%)</li>
          <li>Negative: ${b.negative} (${Math.round((b.negative / total) * 100)}%)</li>
        </ul>
        <p style="margin:14px 0 4px"><strong>Key highlights:</strong></p>
        <ul>${listItems(meta.keyHighlights)}</ul>
        <p style="margin:14px 0 4px"><strong>Top improvement suggestions:</strong></p>
        <ul>${listItems(meta.topImprovementSuggestions)}</ul>
      </div>

      <h2 style="color:${ACCENT};font-size:18px;margin:30px 0 10px;letter-spacing:.5px">INDIVIDUAL REPORTS</h2>
      <table width="100%" cellpadding="0" cellspacing="0">${sections}</table>

      <p style="margin:30px 0 0;color:#6b7280;font-size:12px">Generated: ${esc(meta.generatedAt)}</p>
    </td></tr>
  </table>
</body>
</html>`;
}

module.exports = { reportHTML, combinedHTML, stars, badge, esc };
