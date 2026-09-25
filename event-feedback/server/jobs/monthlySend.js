const crypto = require('crypto');
const { listActiveClients, insertFeedbackRequest, findFeedbackRequestByClientMonth } = require('../db');
const { sendClientFeedbackRequest, sendAccountManagerNotification } = require('../email');

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
 * are processed in ordered batches. The `offset` (passed via the self-call
 * query string) advances through the full client list in a single pass; when
 * clients remain, the next batch is triggered in a fresh invocation via a
 * self-call (chaining). The HTTP response is returned immediately and the work
 * runs in the background, so the request never hits FUNCTION_INVOCATION_TIMEOUT.
 */
async function sendMonthlyFeedbackForms({ smtpConfig, appBaseUrl, cronSecret, selfUrl, batchSize = MONTHLY_BATCH_SIZE, offset = 0 } = {}) {
  const month = currentMonth();
  const base = String(appBaseUrl || 'http://localhost:3000').replace(/\/$/, '');
  const clients = await listActiveClients();

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let processed = 0;
  let amNotified = 0;
  let amSkipped = 0;
  let amFailed = 0;

  const slice = clients.slice(offset, offset + batchSize);
  const amNotifications = [];
  for (const client of slice) {
    processed++;

    if (!client.email || !EMAIL_RE.test(client.email)) {
      skipped++;
      console.warn(`[MonthlySend] Skipped client ${client.id} (${client.name || 'unknown'}): missing/invalid email "${client.email}"`);
      continue;
    }

    // Idempotency pre-check: if a row already exists, the email was sent in a
    // prior (successful) run — skip. Safe because rows are only ever written
    // after a successful send (see below).
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
      // Best-effort Account Manager notification. Fired after the client send
      // is confirmed (and the row is written) so the AM is only notified when
      // the client was actually emailed. Runs in PARALLEL with the rest of the
      // batch and is awaited (allSettled) after the loop, so it never blocks
      // the client send or adds a serial SMTP round-trip per client. Failures
      // are caught here so they can't affect the client send or the batch.
      if (client.accountManagerEmail && EMAIL_RE.test(client.accountManagerEmail)) {
        amNotifications.push(
          sendAccountManagerNotification(smtpConfig, client)
            .then(() => { amNotified++; console.log(`[MonthlySend] AM notification sent for client ${client.id} (${client.accountManagerEmail})`); })
            .catch((err) => {
              amFailed++;
              console.error(`[MonthlySend] AM notification failed for client ${client.id} (${client.email}):`, err.message);
            })
        );
      } else {
        amSkipped++;
        console.log(`[MonthlySend] No account_manager_email for client ${client.id}; skipping AM notification`);
      }
    } catch (err) {
      failed++;
      console.error(`[MonthlySend] Failed to email client ${client.id} (${client.email}):`, err.message);
    }
  }

  // Let in-flight AM notifications settle before reporting (parallel, so this
  // is ~one SMTP round-trip, not one per client). allSettled keeps a single
  // AM failure from ever breaking the batch.
  if (amNotifications.length) await Promise.allSettled(amNotifications);

  const nextOffset = offset + processed;
  const moreRemaining = nextOffset < clients.length;

  // Chain to a fresh invocation so we never exceed the function duration limit,
  // regardless of how many clients there are. Single pass (offset advances to
  // the end of the list) so permanently-failing recipients are attempted once
  // and the job terminates instead of looping forever.
  if (moreRemaining && selfUrl && cronSecret) {
    const sep = selfUrl.includes('?') ? '&' : '?';
    const nextUrl = `${selfUrl}${sep}offset=${nextOffset}`;
    console.log(`[MonthlySend] ${clients.length - nextOffset} client(s) remain; chaining next batch (offset ${nextOffset}).`);
    fetch(nextUrl, { method: 'POST', headers: { 'x-cron-secret': cronSecret } })
      .catch((e) => console.error('[MonthlySend] chain fetch failed:', e.message));
  }

  const summary = { month, sent, skipped, failed, processed, offset, nextOffset, moreRemaining, amNotified, amSkipped, amFailed };
  console.log(`[MonthlySend] batch done for ${month}: offset ${offset}, ${sent} sent, ${skipped} skipped, ${failed} failed, nextOffset ${nextOffset}, AM notified ${amNotified}, AM skipped ${amSkipped}, AM failed ${amFailed}`);
  return summary;
}

module.exports = { sendMonthlyFeedbackForms, currentMonth };
