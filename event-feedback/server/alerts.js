const { allRows, getRow, insertAlertLog, deleteAlertLog } = require('./db');
const { DEPARTMENTS } = require('./dashboard');
const email = require('./email');

// Phase 3 automated alerts — all thresholds env-configurable:
const ALERT_EMAIL = (process.env.ALERT_EMAIL || '').trim() || (process.env.ADMIN_EMAIL || '').trim() || 'tahir@puredesigners.com';
const LOW_SCORE_THRESHOLD = Number(process.env.ALERT_LOW_SCORE_THRESHOLD || 3.0);
const MOM_DROP_THRESHOLD = Number(process.env.ALERT_MOM_DROP_THRESHOLD || 1.0);
const CONSECUTIVE_LOW_MONTHS = Number(process.env.ALERT_CONSECUTIVE_LOW_MONTHS || 2);
const NO_RESPONSE_DAYS = Number(process.env.ALERT_NO_RESPONSE_DAYS || 7);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function nextYm(ym) {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

function trailingConsecutiveLow(history, threshold) {
  const months = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    const score = num(entry.agencyLeadershipScore);
    if (score === null || score >= threshold) break;
    const ym = String(entry.month).slice(0, 7);
    if (months.length && nextYm(ym) !== months[months.length - 1]) break;
    months.push(ym);
  }
  return months.reverse();
}

function dashboardUrl(base, clientId) {
  const root = String(base || 'http://localhost:3000').replace(/\/$/, '');
  return clientId ? `${root}/dashboard.html?client=${clientId}` : `${root}/dashboard.html`;
}

// Reserve the event in alert_log first (atomic dedup); send the email; if the
// send fails, release the reservation so the next trigger retries. A send
// that succeeds is never repeated.
async function sendOnce({ alertType, clientId = null, department = '', period, smtpConfig, content, out }) {
  let dedupKey = null;
  try {
    const reserved = await insertAlertLog({ alertType, clientId, department, period });
    if (!reserved.created) return false;
    dedupKey = reserved.dedupKey;
    await email.sendAlertEmail(smtpConfig, { to: ALERT_EMAIL, ...content });
    return true;
  } catch (err) {
    if (dedupKey) {
      try { await deleteAlertLog(dedupKey); } catch {}
    }
    console.error(`[Alerts] ${alertType} (client ${clientId || '—'}, ${period}) send failed:`, err.message);
    if (out) out.skipped.push({ type: alertType, period, error: err.message });
    return false;
  }
}

// Submission-triggered alerts (#1–#4). Runs after the row is saved; never
// throws into the submission flow — send failures are logged and isolated.
async function evaluateSubmissionAlerts({ client, record, smtpConfig, appBaseUrl = 'http://localhost:3000' }) {
  const out = { evaluated: false, sent: [], skipped: [] };
  if (!client || !record) return out;
  const month = String(record.month || record.eventDate || '').slice(0, 7);
  const score = num(record.agencyLeadershipScore);
  if (!month || score === null) return out;
  out.evaluated = true;

  const history = await allRows(`
    SELECT substr(month, 1, 7) AS month, agency_leadership_score
    FROM feedback_reports
    WHERE client_id = ? AND month IS NOT NULL AND agency_leadership_score IS NOT NULL
    ORDER BY substr(month, 1, 7)
  `, [client.id]);

  const lowMonths = trailingConsecutiveLow(history, LOW_SCORE_THRESHOLD);
  const escalated = lowMonths.length >= CONSECUTIVE_LOW_MONTHS;

  // #4 Repeated low scores. Subsumes #1 for the same client+month: the
  // escalation is the strictly more urgent signal, so no separate low-score
  // email is sent for that month (avoids two emails for one situation).
  if (escalated) {
    if (await sendOnce({
      alertType: 'escalation',
      clientId: client.id,
      period: month,
      smtpConfig,
      out,
      content: email.escalationAlertContent({
        client,
        score,
        month,
        streak: lowMonths.length,
        months: lowMonths,
        threshold: LOW_SCORE_THRESHOLD,
        dashboardUrl: dashboardUrl(appBaseUrl, client.id)
      })
    })) out.sent.push('escalation');
  } else if (score < LOW_SCORE_THRESHOLD) {
    // #1 Low overall client score.
    if (await sendOnce({
      alertType: 'low_score',
      clientId: client.id,
      period: month,
      smtpConfig,
      out,
      content: email.lowScoreAlertContent({
        client,
        score,
        month,
        threshold: LOW_SCORE_THRESHOLD,
        dashboardUrl: dashboardUrl(appBaseUrl, client.id)
      })
    })) out.sent.push('low_score');
  }

  // #3 Month-over-month drop for a client (previous submission by month).
  if (history.length >= 2) {
    const previous = history[history.length - 2];
    const previousScore = num(previous.agencyLeadershipScore);
    const previousMonth = String(previous.month).slice(0, 7);
    if (previousScore !== null && previousScore - score >= MOM_DROP_THRESHOLD) {
      if (await sendOnce({
        alertType: 'mom_drop',
        clientId: client.id,
        period: month,
        smtpConfig,
        out,
        content: email.momDropAlertContent({
          client,
          month,
          previousScore,
          previousMonth,
          currentScore: score,
          drop: previousScore - score,
          threshold: MOM_DROP_THRESHOLD,
          dashboardUrl: dashboardUrl(appBaseUrl, client.id)
        })
      })) out.sent.push('mom_drop');
    }
  }

  // #2 Low department average for the submission's month (same per-column
  // averaging as the dashboard; once per department per month).
  const deptAggs = DEPARTMENTS.map((d) => `CAST(AVG(${d.column}) AS REAL) AS ${d.column}`).join(', ');
  const avgRow = await getRow(
    `SELECT ${deptAggs} FROM feedback_reports WHERE substr(month, 1, 7) = ? AND month IS NOT NULL`,
    [month]
  );
  for (const d of DEPARTMENTS) {
    const avg = num(avgRow && avgRow[d.key]);
    if (avg !== null && avg < LOW_SCORE_THRESHOLD) {
      if (await sendOnce({
        alertType: 'dept_low',
        department: d.key,
        period: month,
        smtpConfig,
        out,
        content: email.lowDepartmentAlertContent({
          departmentLabel: d.label,
          avg,
          month,
          threshold: LOW_SCORE_THRESHOLD,
          dashboardUrl: dashboardUrl(appBaseUrl, null)
        })
      })) out.sent.push(`dept_low:${d.key}`);
    }
  }

  return out;
}

// Time-triggered check (#5): outstanding monthly feedback requests older than
// ALERT_NO_RESPONSE_DAYS get a client reminder + an internal alert. One event
// per (client, month) — the alert_log dedup prevents repeat reminders.
async function runNoResponseCheck({ smtpConfig, appBaseUrl = 'http://localhost:3000', adminEmail } = {}) {
  const summary = { checked: 0, reminded: 0, internalSent: 0, alreadyAlerted: 0, skipped: 0, failed: 0, errors: [] };
  const base = String(appBaseUrl).replace(/\/$/, '');
  const internalRecipient = adminEmail || (process.env.ADMIN_EMAIL || '').trim() || (smtpConfig && smtpConfig.adminEmail) || 'tahir@puredesigners.com';
  const now = new Date();
  const currentYm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const rows = await allRows(`
    SELECT fr.id AS request_id, fr.client_id, fr.month, fr.token, fr.sent_at,
           c.name, c.email, c.company_name, c.service_type
    FROM feedback_requests fr
    JOIN clients c ON c.id = fr.client_id
    WHERE fr.submitted = 0 AND c.status = 'active' AND substr(fr.month, 1, 7) = ?
  `, [currentYm]);

  const nowMs = Date.now();
  for (const r of rows) {
    summary.checked++;
    const month = String(r.month).slice(0, 7);
    const sentAt = Date.parse(r.sent_at || '');
    const days = Number.isFinite(sentAt) ? Math.floor((nowMs - sentAt) / 86400000) : 0;
    if (days < NO_RESPONSE_DAYS) {
      summary.skipped++;
      continue;
    }

    let dedupKey = null;
    try {
      const reserved = await insertAlertLog({ alertType: 'no_response', clientId: r.client_id, period: month });
      if (!reserved.created) {
        summary.alreadyAlerted++;
        continue;
      }
      dedupKey = reserved.dedupKey;
      const hasClientEmail = r.email && EMAIL_RE.test(r.email);
      if (hasClientEmail) {
        await email.sendAlertEmail(smtpConfig, {
          to: r.email,
          ...email.noResponseClientReminderContent(
            { name: r.name, company_name: r.company_name, service_type: r.service_type },
            month,
            days,
            `${base}/feedback/${r.token}`
          )
        });
        summary.reminded++;
      }
      await email.sendAlertEmail(smtpConfig, {
        to: internalRecipient,
        ...email.noResponseInternalAlertContent({ name: r.name, email: r.email }, month, days, dashboardUrl(base, r.client_id))
      });
      summary.internalSent++;
    } catch (err) {
      summary.failed++;
      summary.errors.push(`${r.name || r.client_id}: ${err.message}`);
      if (dedupKey) {
        try { await deleteAlertLog(dedupKey); } catch {}
      }
      console.error('[Alerts] no-response send failed (will retry next run):', err.message);
    }
  }

  return summary;
}

module.exports = {
  evaluateSubmissionAlerts,
  runNoResponseCheck,
  trailingConsecutiveLow,
  ALERT_EMAIL,
  LOW_SCORE_THRESHOLD,
  MOM_DROP_THRESHOLD,
  CONSECUTIVE_LOW_MONTHS,
  NO_RESPONSE_DAYS
};