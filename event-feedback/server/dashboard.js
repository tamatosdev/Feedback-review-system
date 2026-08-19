const { allRows, getRow, listClients } = require('./db');

const DEPARTMENTS = [
  { key: 'accountManagementScore', column: 'account_management_score', label: 'Account Management' },
  { key: 'strategyScore', column: 'strategy_score', label: 'Strategy' },
  { key: 'creativeScore', column: 'creative_score', label: 'Creative' },
  { key: 'designContentScore', column: 'design_content_score', label: 'Design & Content Production' },
  { key: 'socialContentScore', column: 'social_content_score', label: 'Social & Content' },
  { key: 'agencyLeadershipScore', column: 'agency_leadership_score', label: 'Agency Leadership' }
];

const SCORE_KEYS = DEPARTMENTS.map((d) => d.key);

const STATUS_LEVELS = ['healthy', 'attention', 'corrective'];

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round2(value) {
  return value === null ? null : Math.round(value * 100) / 100;
}

function statusForScore(score) {
  const n = num(score);
  if (n === null) return { level: 'noData', label: 'No data', color: 'gray' };
  if (n >= 4) return { level: 'healthy', label: 'Healthy', color: 'green' };
  if (n >= 3) return { level: 'attention', label: 'Attention Required', color: 'amber' };
  return { level: 'corrective', label: 'Corrective Action Required', color: 'red' };
}

function ymOf(year, monthIndex) {
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
}

function currentYm(now = new Date()) {
  return ymOf(now.getFullYear(), now.getMonth());
}

function addMonths(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return ymOf(d.getUTCFullYear(), d.getUTCMonth());
}

function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function rangeYm(from, to, now = new Date()) {
  return {
    fromYm: String(from || '').slice(0, 7) || '0000-01',
    toYm: String(to || '').slice(0, 7) || currentYm(now)
  };
}

function resolveDepartment(name) {
  const raw = String(name || '').trim().toLowerCase();
  return DEPARTMENTS.find(
    (d) => d.key.toLowerCase() === raw || d.label.toLowerCase() === raw
  );
}

function filterClauses({ client, accountManager }, alias) {
  const where = [];
  const params = [];
  if (client) {
    where.push(`${alias}.client_id = ?`);
    params.push(Number(client));
  }
  if (accountManager) {
    where.push(`${alias}.client_id IN (SELECT id FROM clients WHERE account_manager = ?)`);
    params.push(accountManager);
  }
  return { where, params };
}

function validateFilters({ client, accountManager, status }) {
  if (client && !Number.isFinite(Number(client))) {
    const err = new Error(`Invalid client filter "${client}" — must be a client id.`);
    err.status = 400;
    throw err;
  }
  if (status && !STATUS_LEVELS.includes(status)) {
    const err = new Error(`Invalid status filter "${status}" — use ${STATUS_LEVELS.join(', ')}.`);
    err.status = 400;
    throw err;
  }
}

async function loadSeries({ fromYm, toYm, client, accountManager }) {
  const where = ['substr(fr.month, 1, 7) BETWEEN ? AND ?'];
  const params = [fromYm, toYm];
  const fc = filterClauses({ client, accountManager }, 'fr');
  where.push(...fc.where);
  params.push(...fc.params);
  const scoreAggs = DEPARTMENTS.map(
    (d) => `CAST(AVG(fr.${d.column}) AS REAL) AS ${d.column}, CAST(COUNT(fr.${d.column}) AS INTEGER) AS cnt_${d.column}`
  ).join(',\n      ');
  const rows = await allRows(`
    SELECT substr(fr.month, 1, 7) AS ym,
      ${scoreAggs},
      CAST(COUNT(*) AS INTEGER) AS cnt
    FROM feedback_reports fr
    WHERE ${where.join(' AND ')}
    GROUP BY substr(fr.month, 1, 7)
    ORDER BY ym
  `, params);
  const byMonth = {};
  for (const r of rows) {
    byMonth[r.ym] = { ...r, cnt: num(r.cnt) };
  }
  return { rows, byMonth };
}

async function rangeAverages({ fromYm, toYm, client, accountManager }) {
  const where = ['substr(fr.month, 1, 7) BETWEEN ? AND ?'];
  const params = [fromYm, toYm];
  const fc = filterClauses({ client, accountManager }, 'fr');
  where.push(...fc.where);
  params.push(...fc.params);
  const scoreAggs = DEPARTMENTS.map(
    (d) => `CAST(AVG(fr.${d.column}) AS REAL) AS ${d.column}, CAST(COUNT(fr.${d.column}) AS INTEGER) AS cnt_${d.column}`
  ).join(',\n      ');
  const row = await getRow(`
    SELECT ${scoreAggs},
      CAST(COUNT(*) AS INTEGER) AS cnt
    FROM feedback_reports fr
    WHERE ${where.join(' AND ')}
  `, params);
  const out = { cnt: num(row && row.cnt) || 0 };
  for (const d of DEPARTMENTS) {
    out[d.key] = num(row && row[d.key]);
    out[`cnt_${d.column}`] = num(row && row[`cnt_${d.column}`]) || 0;
  }
  return out;
}

async function responseRate({ fromYm, toYm, client, accountManager }) {
  const where = ['substr(fr.month, 1, 7) BETWEEN ? AND ?'];
  const params = [fromYm, toYm];
  const fc = filterClauses({ client, accountManager }, 'fr');
  where.push(...fc.where);
  params.push(...fc.params);
  const row = await getRow(`
    SELECT
      CAST(COUNT(*) AS INTEGER) AS total,
      CAST(SUM(CASE WHEN fr.submitted = 1 THEN 1 ELSE 0 END) AS INTEGER) AS submitted
    FROM feedback_requests fr
    WHERE ${where.join(' AND ')}
  `, params);
  const total = num(row && row.total) || 0;
  const submitted = num(row && row.submitted) || 0;
  return { total, submitted, percent: total ? Math.round((submitted / total) * 1000) / 10 : null };
}

async function latestAgencyScores({ fromYm, toYm, client, accountManager }) {
  const where = ['substr(fr.month, 1, 7) BETWEEN ? AND ?', 'fr.agency_leadership_score IS NOT NULL'];
  const params = [fromYm, toYm];
  const fc = filterClauses({ client, accountManager }, 'fr');
  where.push(...fc.where);
  params.push(...fc.params);
  const rows = await allRows(`
    SELECT fr.client_id, c.name, CAST(fr.agency_leadership_score AS REAL) AS score
    FROM feedback_reports fr
    JOIN clients c ON c.id = fr.client_id
    WHERE ${where.join(' AND ')}
      AND fr.timestamp = (
        SELECT MAX(fr2.timestamp) FROM feedback_reports fr2
        WHERE fr2.client_id = fr.client_id
          AND substr(fr2.month, 1, 7) BETWEEN ? AND ?
          AND fr2.agency_leadership_score IS NOT NULL
      )
  `, [...params, fromYm, toYm]);
  return rows.map((r) => ({ clientId: r.client_id, name: r.name, score: num(r.score) }));
}

function monthBucketAvg(byMonth, ym, key) {
  const b = byMonth[ym];
  if (!b) return null;
  return num(b[key]);
}

function weightedAvg(byMonth, fromYm, toYm, key, column) {
  const cntKey = `cnt_${column}`;
  let sum = 0;
  let total = 0;
  let month = fromYm;
  while (month <= toYm) {
    const b = byMonth[month];
    const cnt = b ? num(b[cntKey]) : 0;
    if (b && b[key] !== null && b[key] !== undefined && cnt > 0) {
      sum += num(b[key]) * cnt;
      total += cnt;
    }
    month = addMonths(month, 1);
  }
  return total ? round2(sum / total) : null;
}

function changePair(current, previous) {
  return {
    current: round2(current),
    previous: round2(previous),
    change: current !== null && previous !== null ? round2(current - previous) : null
  };
}

function lastSixMonths(toYm) {
  const months = [];
  for (let i = 5; i >= 0; i--) months.push(addMonths(toYm, -i));
  return months;
}

function historySeries(byMonth, key, toYm) {
  return lastSixMonths(toYm).map((ym) => {
    const b = byMonth[ym];
    return b ? num(b[key]) : null;
  });
}

async function dashboardKpis({ from, to, client, accountManager } = {}) {
  validateFilters({ client, accountManager });
  const { fromYm, toYm } = rangeYm(from, to);
  const wideFrom = [fromYm, addMonths(toYm, -5)].sort()[0];
  const hasFilters = !!(client || accountManager);

  const [series, agencySeries, rangeAvg, agencyRangeAvg, rate, latest] = await Promise.all([
    loadSeries({ fromYm: wideFrom, toYm, client, accountManager }),
    hasFilters ? loadSeries({ fromYm: wideFrom, toYm }) : null,
    rangeAverages({ fromYm, toYm, client, accountManager }),
    hasFilters ? rangeAverages({ fromYm, toYm }) : null,
    responseRate({ fromYm, toYm, client, accountManager }),
    latestAgencyScores({ fromYm, toYm, client, accountManager })
  ]);
  const agency = agencySeries || series;
  const agencyAvg = agencyRangeAvg || rangeAvg;

  const prevYm = addMonths(toYm, -1);

  const kpis = DEPARTMENTS.map((d) => {
    const score = rangeAvg[d.key];
    return {
      key: d.key,
      label: d.label,
      score: round2(score),
      count: rangeAvg[`cnt_${d.column}`] || 0,
      status: statusForScore(score),
      history: historySeries(series.byMonth, d.key, toYm)
    };
  });

  const monthDepartments = {};
  for (const d of DEPARTMENTS) {
    monthDepartments[d.key] = changePair(
      monthBucketAvg(series.byMonth, toYm, d.key),
      monthBucketAvg(series.byMonth, prevYm, d.key)
    );
  }

  const requiringAttention = latest.filter((r) => r.score < 3);

  return {
    range: { from: from || null, to: to || null, fromYm, toYm },
    kpis: [
      ...kpis,
      { key: 'responseRate', label: 'Response Rate', percent: rate.percent, submitted: rate.submitted, total: rate.total },
      { key: 'clientsRequiringAttention', label: 'Clients Requiring Attention', count: requiringAttention.length, clients: requiringAttention.map((r) => r.name) }
    ],
    history: { months: lastSixMonths(toYm) },
    comparisons: {
      month: {
        current: toYm,
        previous: prevYm,
        overall: changePair(
          monthBucketAvg(series.byMonth, toYm, 'agencyLeadershipScore'),
          monthBucketAvg(series.byMonth, prevYm, 'agencyLeadershipScore')
        ),
        departments: monthDepartments
      },
      agencyAverage: { score: round2(agencyAvg.agencyLeadershipScore), count: agencyAvg.cnt_agency_leadership_score || 0 },
      clientAverage: hasFilters ? { score: round2(rangeAvg.agencyLeadershipScore), count: rangeAvg.cnt_agency_leadership_score || 0 } : null
    }
  };
}

async function clientDepartmentRows({ column, fromYm, toYm, client, accountManager }) {
  const where = ['substr(fr.month, 1, 7) BETWEEN ? AND ?', `fr.${column} IS NOT NULL`];
  const params = [fromYm, toYm];
  const fc = filterClauses({ client, accountManager }, 'fr');
  where.push(...fc.where);
  params.push(...fc.params);
  return allRows(`
    SELECT fr.client_id, c.name, c.account_manager,
      CAST(AVG(fr.${column}) AS REAL) AS avg,
      CAST(COUNT(*) AS INTEGER) AS cnt,
      MAX(fr.timestamp) AS latest_ts
    FROM feedback_reports fr
    JOIN clients c ON c.id = fr.client_id
    WHERE ${where.join(' AND ')}
    GROUP BY fr.client_id, c.name, c.account_manager
  `, params);
}

async function latestDepartmentScores({ column, fromYm, toYm, client, accountManager }) {
  const where = ['substr(fr.month, 1, 7) BETWEEN ? AND ?', `fr.${column} IS NOT NULL`];
  const params = [fromYm, toYm];
  const fc = filterClauses({ client, accountManager }, 'fr');
  where.push(...fc.where);
  params.push(...fc.params);
  const rows = await allRows(`
    SELECT fr.client_id, CAST(fr.${column} AS REAL) AS score
    FROM feedback_reports fr
    JOIN clients c ON c.id = fr.client_id
    WHERE ${where.join(' AND ')}
      AND fr.timestamp = (
        SELECT MAX(fr2.timestamp) FROM feedback_reports fr2
        WHERE fr2.client_id = fr.client_id
          AND substr(fr2.month, 1, 7) BETWEEN ? AND ?
          AND fr2.${column} IS NOT NULL
      )
  `, [...params, fromYm, toYm]);
  const byClient = {};
  for (const r of rows) byClient[r.client_id] = num(r.score);
  return byClient;
}

async function dashboardDepartment(name, { from, to, client, accountManager, status } = {}) {
  validateFilters({ client, accountManager, status });
  const dept = resolveDepartment(name);
  if (!dept) {
    const err = new Error(`Unknown department "${name}". Use one of: ${DEPARTMENTS.map((d) => d.label).join(', ')}.`);
    err.status = 400;
    throw err;
  }
  const { fromYm, toYm } = rangeYm(from, to);
  const wideFrom = [fromYm, addMonths(toYm, -5)].sort()[0];
  const hasFilters = !!(client || accountManager);

  const [series, agencyRangeAvg, clientRows, latestDept, latestAgency, rangeAvg] = await Promise.all([
    loadSeries({ fromYm: wideFrom, toYm, client, accountManager }),
    rangeAverages({ fromYm, toYm }),
    clientDepartmentRows({ column: dept.column, fromYm, toYm, client, accountManager }),
    latestDepartmentScores({ column: dept.column, fromYm, toYm, client, accountManager }),
    latestAgencyScores({ fromYm, toYm, client, accountManager }),
    rangeAverages({ fromYm, toYm, client, accountManager })
  ]);

  const agencyStatus = {};
  for (const r of latestAgency) agencyStatus[r.clientId] = statusForScore(r.score);

  let clients = clientRows
    .map((r) => {
      const avg = num(r.avg);
      const latest = num(latestDept[r.client_id]);
      const cs = agencyStatus[r.client_id] || statusForScore(null);
      return {
        clientId: r.client_id,
        name: r.name,
        accountManager: r.account_manager,
        avg: round2(avg),
        latest,
        count: r.cnt,
        avgStatus: statusForScore(avg),
        latestStatus: statusForScore(latest),
        clientStatus: cs
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  if (status && STATUS_LEVELS.includes(status)) {
    clients = clients.filter((c) => c.clientStatus.level === status);
  }

  const byScore = (a, b) => b.avg - a.avg;
  const topClients = [...clients].sort(byScore).slice(0, 5);
  const bottomClients = [...clients].sort(byScore).reverse().slice(0, 5);

  const prevYm = addMonths(toYm, -1);
  const currentScore = monthBucketAvg(series.byMonth, toYm, dept.key);
  const previousScore = monthBucketAvg(series.byMonth, prevYm, dept.key);
  const threeFrom = addMonths(toYm, -2);
  const threeMonthScore = weightedAvg(series.byMonth, threeFrom, toYm, dept.key, dept.column);
  const trendMonths = lastSixMonths(toYm);
  const monthCount = (ym) => (series.byMonth[ym] && num(series.byMonth[ym][`cnt_${dept.column}`])) || 0;

  return {
    department: { key: dept.key, label: dept.label },
    range: { from: from || null, to: to || null, fromYm, toYm },
    currentMonth: {
      month: toYm,
      monthLabel: monthLabel(toYm),
      score: round2(currentScore),
      count: monthCount(toYm),
      status: statusForScore(currentScore)
    },
    previousMonth: {
      month: prevYm,
      monthLabel: monthLabel(prevYm),
      score: round2(previousScore),
      count: monthCount(prevYm),
      status: statusForScore(previousScore)
    },
    momChange: currentScore !== null && previousScore !== null ? round2(currentScore - previousScore) : null,
    threeMonth: {
      fromMonth: threeFrom,
      toMonth: toYm,
      score: threeMonthScore,
      count: trendMonths.slice(2).reduce((s, ym) => s + monthCount(ym), 0),
      status: statusForScore(threeMonthScore)
    },
    trend: {
      months: trendMonths,
      scores: trendMonths.map((ym) => monthBucketAvg(series.byMonth, ym, dept.key)),
      statuses: trendMonths.map((ym) => statusForScore(monthBucketAvg(series.byMonth, ym, dept.key))),
      counts: trendMonths.map((ym) => monthCount(ym))
    },
    departmentAverage: { score: round2(rangeAvg[dept.key]), count: rangeAvg[`cnt_${dept.column}`] || 0 },
    agencyAverage: { score: round2(agencyRangeAvg.agencyLeadershipScore), count: agencyRangeAvg.cnt_agency_leadership_score || 0 },
    clients,
    topClients,
    bottomClients
  };
}

async function dashboardMeta() {
  const clients = (await listClients()).map((c) => ({
    id: c.id,
    name: c.name,
    company_name: c.company_name,
    account_manager: c.account_manager
  }));
  const accountManagers = [...new Set(clients.map((c) => c.account_manager).filter(Boolean))].sort();
  return {
    departments: DEPARTMENTS.map((d) => ({ key: d.key, label: d.label })),
    clients,
    accountManagers
  };
}

module.exports = {
  DEPARTMENTS,
  SCORE_KEYS,
  STATUS_LEVELS,
  statusForScore,
  addMonths,
  currentYm,
  monthLabel,
  rangeYm,
  lastSixMonths,
  resolveDepartment,
  dashboardKpis,
  dashboardDepartment,
  dashboardMeta
};