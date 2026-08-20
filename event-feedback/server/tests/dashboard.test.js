const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.DB_PATH = path.join(os.tmpdir(), `feedback-dashboard-test-${process.pid}.db`);
process.env.DATABASE_URL = '';
process.env.STORAGE_DRIVER = 'memory';

const { db, insertFeedback, insertClient, insertFeedbackRequest, markFeedbackRequestSubmitted } = require('../db');
const {
  statusForScore,
  dashboardKpis,
  dashboardDepartment,
  dashboardMeta,
  resolveDepartment,
  addMonths,
  lastSixMonths
} = require('../dashboard');
const app = require('../index.js');

let clientA;
let clientB;

function makeRow(overrides = {}) {
  return {
    submissionId: 'FB-DASH-' + Math.random().toString(36).slice(2, 10),
    timestamp: new Date().toISOString(),
    serviceType: 'Retainer',
    month: '2026-08',
    client_id: null,
    attendeeName: 'Anonymous',
    attendeeEmail: '',
    hasValidEmail: 0,
    companyName: '',
    rating: 3,
    comments: 'c',
    suggestions: 's',
    sentiment: 'Neutral',
    summary: 'sum',
    urgency: 'Low',
    highlights: [],
    improvementSuggestions: [],
    pdfUrl: '',
    emailSent: 0,
    ...overrides
  };
}

async function seed() {
  db.exec('DELETE FROM feedback_requests');
  db.exec('DELETE FROM clients');
  db.exec('DELETE FROM feedback_reports');

  clientA = await insertClient({ name: 'Acme A', email: 'a@acme.com' });
  clientB = await insertClient({ name: 'Beta B', email: 'b@beta.com' });

  await insertFeedback(makeRow({
    submissionId: 'FB-A-JUL', month: '2026-07', timestamp: '2026-07-15T10:00:00.000Z', client_id: clientA.id,
    accountManagementScore: 5, strategyScore: 4, creativeScore: 3, designContentScore: 2, socialContentScore: 4, agencyLeadershipScore: 5, rating: 5
  }));
  await insertFeedback(makeRow({
    submissionId: 'FB-A-AUG', month: '2026-08', timestamp: '2026-08-15T10:00:00.000Z', client_id: clientA.id,
    accountManagementScore: 4, strategyScore: 4, creativeScore: 3, designContentScore: 3, socialContentScore: 3, agencyLeadershipScore: 2, rating: 2
  }));
  await insertFeedback(makeRow({
    submissionId: 'FB-B-AUG', month: '2026-08', timestamp: '2026-08-20T10:00:00.000Z', client_id: clientB.id,
    accountManagementScore: 3, strategyScore: 2, creativeScore: 2, designContentScore: 4, socialContentScore: 5, agencyLeadershipScore: 4, rating: 4
  }));
  await insertFeedback(makeRow({
    submissionId: 'FB-LEGACY', month: '2026-08', timestamp: '2026-08-25T10:00:00.000Z', client_id: null, rating: 3
  }));

  const reqA = await insertFeedbackRequest({ client_id: clientA.id, month: '2026-08', token: 'tok-a-1' });
  await markFeedbackRequestSubmitted(reqA.row.id);
  await insertFeedbackRequest({ client_id: clientB.id, month: '2026-08', token: 'tok-b-1' });
  await insertFeedbackRequest({ client_id: clientA.id, month: '2026-05', token: 'tok-a-may' });
}

test.before(async () => seed());
test.after(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch {}
  }
});

test('statusForScore bands, including edge values', () => {
  assert.strictEqual(statusForScore(5).level, 'healthy');
  assert.strictEqual(statusForScore(4).level, 'healthy', 'exactly 4.0 is Healthy');
  assert.strictEqual(statusForScore(4.0).label, 'Healthy');
  assert.strictEqual(statusForScore(3.9).level, 'attention');
  assert.strictEqual(statusForScore(3.0).level, 'attention', 'exactly 3.0 is Attention Required');
  assert.strictEqual(statusForScore(2.9).level, 'corrective');
  assert.strictEqual(statusForScore(1).level, 'corrective');
  assert.strictEqual(statusForScore('3.5').level, 'attention', 'string scores are coerced');
  assert.strictEqual(statusForScore(null).level, 'noData');
  assert.strictEqual(statusForScore(undefined).level, 'noData');
});

test('addMonths and lastSixMonths helpers', () => {
  assert.strictEqual(addMonths('2026-08', -1), '2026-07');
  assert.strictEqual(addMonths('2026-01', -1), '2025-12');
  assert.strictEqual(addMonths('2026-12', 1), '2027-01');
  assert.deepStrictEqual(lastSixMonths('2026-08'), ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08']);
});

test('resolveDepartment accepts label and key, rejects unknown', () => {
  assert.strictEqual(resolveDepartment('Agency Leadership').key, 'agencyLeadershipScore');
  assert.strictEqual(resolveDepartment('agencyLeadershipScore').key, 'agencyLeadershipScore');
  assert.strictEqual(resolveDepartment('design & content production').key, 'designContentScore');
  assert.strictEqual(resolveDepartment('Nonsense'), undefined);
});

test('dashboardKpis computes known expected values for Aug 2026', async () => {
  const data = await dashboardKpis({ from: '2026-08-01', to: '2026-08-31' });

  assert.strictEqual(data.range.fromYm, '2026-08');
  assert.strictEqual(data.range.toYm, '2026-08');

  const byKey = Object.fromEntries(data.kpis.slice(0, 6).map((k) => [k.key, k]));
  assert.strictEqual(byKey.agencyLeadershipScore.score, 3);
  assert.strictEqual(byKey.agencyLeadershipScore.status.level, 'attention');
  assert.strictEqual(byKey.agencyLeadershipScore.count, 2);
  assert.strictEqual(byKey.accountManagementScore.score, 3.5);
  assert.strictEqual(byKey.strategyScore.score, 3);
  assert.strictEqual(byKey.creativeScore.score, 2.5);
  assert.strictEqual(byKey.creativeScore.status.level, 'corrective');
  assert.strictEqual(byKey.designContentScore.score, 3.5);
  assert.strictEqual(byKey.socialContentScore.score, 4);
  assert.strictEqual(byKey.socialContentScore.status.level, 'healthy');
  assert.strictEqual(byKey.agencyLeadershipScore.history[4], 5, 'history Jul = 5');
  assert.strictEqual(byKey.agencyLeadershipScore.history[5], 3, 'history Aug = 3');

  const rate = data.kpis[6];
  assert.strictEqual(rate.percent, 50);
  assert.strictEqual(rate.submitted, 1);
  assert.strictEqual(rate.total, 2);

  const attention = data.kpis[7];
  assert.strictEqual(attention.count, 1);
  assert.deepStrictEqual(attention.clients, ['Acme A']);
});

test('dashboardKpis MoM comparisons are correct', async () => {
  const data = await dashboardKpis({ from: '2026-08-01', to: '2026-08-31' });
  const m = data.comparisons.month;
  assert.strictEqual(m.overall.current, 3);
  assert.strictEqual(m.overall.previous, 5);
  assert.strictEqual(m.overall.change, -2);
  assert.strictEqual(m.departments.creativeScore.change, -0.5, 'creative Jul 3 vs Aug 2.5 = -0.5');
});

test('dashboardKpis client filter narrows the data', async () => {
  const byClient = await dashboardKpis({ from: '2026-08-01', to: '2026-08-31', client: String(clientA.id) });
  const agency = byClient.kpis.find((k) => k.key === 'agencyLeadershipScore');
  assert.strictEqual(agency.score, 2, 'client A only: Aug agency score is 2');
  assert.strictEqual(agency.count, 1);
  assert.strictEqual(byClient.comparisons.clientAverage.score, 2);
  assert.strictEqual(byClient.comparisons.agencyAverage.score, 3, 'agency-wide average for the same period');
  assert.strictEqual(byClient.comparisons.agencyAverage.count, 2, 'legacy row without agency score is not counted');
});

test('dashboardDepartment Agency Leadership: current, previous, MoM, 3-month, trend', async () => {
  const d = await dashboardDepartment('Agency Leadership', { from: '2026-08-01', to: '2026-08-31' });
  assert.strictEqual(d.department.label, 'Agency Leadership');
  assert.strictEqual(d.currentMonth.score, 3);
  assert.strictEqual(d.currentMonth.count, 2);
  assert.strictEqual(d.currentMonth.status.level, 'attention');
  assert.strictEqual(d.previousMonth.score, 5);
  assert.strictEqual(d.previousMonth.status.level, 'healthy');
  assert.strictEqual(d.momChange, -2);
  assert.strictEqual(d.threeMonth.score, 3.67);
  assert.deepStrictEqual(d.trend.scores, [null, null, null, null, 5, 3]);
  assert.deepStrictEqual(d.trend.statuses.map((s) => s.level), ['noData', 'noData', 'noData', 'noData', 'healthy', 'attention']);
});

test('dashboardDepartment client-wise rows, top/bottom and status filter', async () => {
  const d = await dashboardDepartment('Agency Leadership', { from: '2026-08-01', to: '2026-08-31' });
  assert.strictEqual(d.clients.length, 2);
  const a = d.clients.find((c) => c.name === 'Acme A');
  const b = d.clients.find((c) => c.name === 'Beta B');
  assert.strictEqual(a.avg, 2, 'client-wise list is scoped to the selected range (Aug only)');
  assert.strictEqual(a.count, 1);
  assert.strictEqual(a.latest, 2);
  assert.strictEqual(a.clientStatus.level, 'corrective');
  assert.strictEqual(a.avgStatus.level, 'corrective');
  assert.strictEqual(b.avg, 4);
  assert.strictEqual(b.latest, 4);
  assert.strictEqual(b.clientStatus.level, 'healthy');
  assert.deepStrictEqual(d.topClients.map((c) => c.name), ['Beta B', 'Acme A']);
  assert.deepStrictEqual(d.bottomClients.map((c) => c.name), ['Acme A', 'Beta B']);

  const healthyOnly = await dashboardDepartment('Agency Leadership', { from: '2026-08-01', to: '2026-08-31', status: 'healthy' });
  assert.deepStrictEqual(healthyOnly.clients.map((c) => c.name), ['Beta B']);
  const correctiveOnly = await dashboardDepartment('Agency Leadership', { from: '2026-08-01', to: '2026-08-31', status: 'corrective' });
  assert.deepStrictEqual(correctiveOnly.clients.map((c) => c.name), ['Acme A']);
  assert.deepStrictEqual(correctiveOnly.topClients.map((c) => c.name), ['Acme A']);
});

test('dashboardDepartment Creative: department average vs agency average', async () => {
  const d = await dashboardDepartment('Creative', { from: '2026-08-01', to: '2026-08-31' });
  assert.strictEqual(d.departmentAverage.score, 2.5);
  assert.strictEqual(d.agencyAverage.score, 3);
  assert.strictEqual(d.currentMonth.score, 2.5);
  assert.strictEqual(d.currentMonth.status.level, 'corrective');
  const a = d.clients.find((c) => c.name === 'Acme A');
  assert.strictEqual(a.avg, 3);
  assert.strictEqual(a.avgStatus.level, 'attention');
});

test('dashboardDepartment rejects unknown department and invalid filters', async () => {
  await assert.rejects(() => dashboardDepartment('Bogus', {}), (err) => {
    assert.strictEqual(err.status, 400);
    return true;
  });
  await assert.rejects(() => dashboardKpis({ client: 'not-a-number' }), (err) => err.status === 400);
  await assert.rejects(() => dashboardDepartment('Creative', { status: 'bogus' }), (err) => err.status === 400);
});

test('empty range returns nulls and empty arrays without crashing', async () => {
  const k = await dashboardKpis({ from: '2026-01-01', to: '2026-01-31' });
  for (const kpi of k.kpis.slice(0, 6)) {
    assert.strictEqual(kpi.score, null);
    assert.strictEqual(kpi.status.level, 'noData');
  }
  assert.strictEqual(k.kpis[6].percent, null);
  assert.strictEqual(k.kpis[6].total, 0);
  assert.strictEqual(k.kpis[7].count, 0);
  assert.strictEqual(k.comparisons.month.overall.current, null);
  assert.strictEqual(k.comparisons.month.overall.change, null);
  assert.strictEqual(k.comparisons.agencyAverage.score, null);

  const d = await dashboardDepartment('Agency Leadership', { from: '2026-01-01', to: '2026-01-31' });
  assert.strictEqual(d.currentMonth.score, null);
  assert.strictEqual(d.currentMonth.status.level, 'noData');
  assert.strictEqual(d.momChange, null);
  assert.deepStrictEqual(d.clients, []);
  assert.deepStrictEqual(d.topClients, []);
  assert.deepStrictEqual(d.bottomClients, []);
  assert.ok(d.trend.scores.every((s) => s === null));
});

test('no range params: from is open-ended, to defaults to current month', async () => {
  const k = await dashboardKpis({});
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  assert.strictEqual(k.range.toYm, ym);
  assert.strictEqual(k.range.fromYm, '0000-01', 'no lower bound when from is absent');
});

test('dashboardMeta lists departments and clients without account managers', async () => {
  const m = await dashboardMeta();
  assert.strictEqual(m.departments.length, 6);
  assert.strictEqual(m.accountManagers, undefined, 'account managers must no longer be returned');
  assert.ok(m.clients.some((c) => c.id === clientA.id && c.name === 'Acme A'));
});

test('GET /api/dashboard endpoints return aggregates', async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const metaRes = await fetch(`${base}/api/dashboard/meta`);
    const metaJson = await metaRes.json();
    assert.strictEqual(metaJson.ok, true);
    assert.strictEqual(metaJson.data.departments.length, 6);

    const kpiRes = await fetch(`${base}/api/dashboard/kpis?from=2026-08-01&to=2026-08-31`);
    const kpiJson = await kpiRes.json();
    assert.strictEqual(kpiJson.ok, true);
    assert.strictEqual(kpiJson.data.kpis[0].score, 3.5);

    const deptRes = await fetch(`${base}/api/dashboard/department/${encodeURIComponent('Agency Leadership')}?from=2026-08-01&to=2026-08-31&status=healthy`);
    const deptJson = await deptRes.json();
    assert.strictEqual(deptJson.ok, true);
    assert.strictEqual(deptJson.data.currentMonth.score, 3);
    assert.deepStrictEqual(deptJson.data.clients.map((c) => c.name), ['Beta B']);

    const badRes = await fetch(`${base}/api/dashboard/department/Nope`);
    assert.strictEqual(badRes.status, 400);
    const badJson = await badRes.json();
    assert.strictEqual(badJson.ok, false);
    assert.match(badJson.error, /Unknown department/);

    const badClientRes = await fetch(`${base}/api/dashboard/kpis?client=abc`);
    assert.strictEqual(badClientRes.status, 400);
    const badStatusRes = await fetch(`${base}/api/dashboard/kpis?status=bogus`);
    assert.strictEqual(badStatusRes.status, 400);
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    server.close();
  }
});