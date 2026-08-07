const crypto = require('crypto');
const { listActiveClients, insertFeedbackRequest } = require('../db');
const { sendClientFeedbackRequest } = require('../email');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function currentMonth(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Cron job (default: 09:00 on the 1st of every month).
 * Emails a unique tokenized feedback-form link to every active client.
 * Idempotent per (client, month) via the feedback_requests table.
 */
async function sendMonthlyFeedbackForms({ smtpConfig, appBaseUrl } = {}) {
  const month = currentMonth();
  const base = String(appBaseUrl || 'http://localhost:3000').replace(/\/$/, '');
  const clients = await listActiveClients();

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const client of clients) {
    if (!client.email || !EMAIL_RE.test(client.email)) {
      skipped++;
      console.warn(`[MonthlySend] Skipped client ${client.id} (${client.name || 'unknown'}): missing/invalid email "${client.email}"`);
      continue;
    }

    const token = crypto.randomUUID();
    const { created } = await insertFeedbackRequest({ client_id: client.id, month, token });
    if (!created) {
      skipped++;
      console.log(`[MonthlySend] Skipped client ${client.id}: feedback request for ${month} already sent`);
      continue;
    }

    const link = `${base}/feedback/${token}`;
    try {
      await sendClientFeedbackRequest(smtpConfig, client, link);
      sent++;
      console.log(`[MonthlySend] Sent feedback request to ${client.email}`);
    } catch (err) {
      failed++;
      console.error(`[MonthlySend] Failed to email client ${client.id} (${client.email}):`, err.message);
    }
  }

  const summary = { month, total: clients.length, sent, skipped, failed };
  console.log(`[MonthlySend] Done for ${month}: ${sent} sent, ${skipped} skipped, ${failed} failed (of ${clients.length} active clients)`);
  return summary;
}

module.exports = { sendMonthlyFeedbackForms, currentMonth };
