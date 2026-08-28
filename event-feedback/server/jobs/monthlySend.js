const crypto = require('crypto');
const { listActiveClients, insertFeedbackRequest, findFeedbackRequestByClientMonth, countActiveClientsWithoutRequest } = require('../db');
const { sendClientFeedbackRequest } = require('../email');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MONTHLY_BATCH_SIZE = Number(process.env.MONTHLY_BATCH_SIZE || 10);

function currentMonth(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Cron job (default: 09:00 on the 28th of every month).
 * Emails a unique tokenized feedback-form link to every active client.
 *
 * Idempotent per (client, month): a feedback_requests row is inserted ONLY
 * AFTER the email is sent successfully. Therefore "a row exists" is equivalent
 * to "the email was sent". A failed or interrupted send leaves no row, so a
 * retry will attempt it again instead of silently skipping it.
 *
 * To stay within Vercel's function duration limit (Hobby = 60s max), clients
 * are processed in batches. When clients remain after a batch, the next batch
 * is triggered in a fresh invocation via a self-call (chaining). The HTTP
 * response is returned immediately and the work runs in the background, so the
 * request never hits FUNCTION_INVOCATION_TIMEOUT.
 */
async function sendMonthlyFeedbackForms({ smtpConfig, appBaseUrl, cronSecret, selfUrl, batchSize = MONTHLY_BATCH_SIZE } = {}) {
  const month = currentMonth();
  const base = String(appBaseUrl || 'http://localhost:3000').replace(/\/$/, '');
  const clients = await listActiveClients();

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let processed = 0;

  for (const client of clients) {
    if (processed >= batchSize) break;
    processed++;

    if (!client.email || !EMAIL_RE.test(client.email)) {
      skipped++;
      console.warn(`[MonthlySend] Skipped client ${client.id} (${client.name || 'unknown'}): missing/invalid email "${client.email}"`);
      continue;
    }

    // Idempotency pre-check: if a row already exists, the email was sent in a
    // prior (successful) run — skip. This is safe because rows are only ever
    // written after a successful send (see below).
    const existing = await findFeedbackRequestByClientMonth(client.id, month);
    if (existing) {
      skipped++;
      console.log(`[MonthlySend] Skipped client ${client.id}: feedback request for ${month} already sent`);
      continue;
    }

    const token = crypto.randomUUID();
    const link = `${base}/feedback/${token}`;
    try {
      await sendClientFeedbackRequest(smtpConfig, client, link);
      sent++;
      console.log(`[MonthlySend] Sent feedback request to ${client.email}`);
      // Persist ONLY after the email succeeded, so a crash/timeout before this
      // point leaves no row and the client is retried next time.
      await insertFeedbackRequest({ client_id: client.id, month, token });
    } catch (err) {
      failed++;
      console.error(`[MonthlySend] Failed to email client ${client.id} (${client.email}):`, err.message);
    }
  }

  const remaining = await countActiveClientsWithoutRequest(month);
  const moreRemaining = remaining > 0;

  // Chain to a fresh invocation so we never exceed the function duration limit,
  // regardless of how many clients there are. Only chain when we made progress
  // (sent > 0) to avoid an infinite loop on permanently-failing recipients.
  if (moreRemaining && sent > 0 && selfUrl && cronSecret) {
    console.log(`[MonthlySend] ${remaining} client(s) remain; chaining next batch.`);
    fetch(selfUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cron-secret': cronSecret },
      body: '{}'
    }).catch((e) => console.error('[MonthlySend] chain fetch failed:', e.message));
  }

  const summary = { month, sent, skipped, failed, processed, moreRemaining, remaining };
  console.log(`[MonthlySend] batch done for ${month}: ${sent} sent, ${skipped} skipped, ${failed} failed, remaining ${remaining}`);
  return summary;
}

module.exports = { sendMonthlyFeedbackForms, currentMonth };
