const test = require('node:test');
const assert = require('node:assert');

// Verifies Vercel Cron's actual request shape can reach the handlers.
// Vercel invokes cron paths with GET (+ `Authorization: Bearer <CRON_SECRET>`
// when CRON_SECRET is set in the project env). These routes were previously
// POST-only, so every scheduled invocation 404'd.
process.env.CRON_SECRET = 'test-cron-secret';
process.env.ADMIN_EMAIL = '';
process.env.LEADERSHIP_EMAILS = '';

const app = require('../index');

function listen() {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

const CRON_ROUTES = ['/api/cron/monthly-send', '/api/cron/six-month-report', '/api/cron/no-response-check'];

test('cron routes reject GET without the secret (auth still enforced)', async () => {
  const server = await listen();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const path of CRON_ROUTES) {
      const res = await fetch(`${base}${path}`, { method: 'GET' });
      assert.strictEqual(res.status, 401, `${path} GET without secret must be 401`);
    }
  } finally {
    server.close();
  }
});

test('cron routes are reachable via GET (no 404/405) - this is what Vercel sends', async () => {
  const server = await listen();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const path of CRON_ROUTES) {
      const res = await fetch(`${base}${path}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer test-cron-secret' }
      });
      assert.notStrictEqual(res.status, 404, `${path} must not 404 on GET`);
      assert.notStrictEqual(res.status, 405, `${path} must not 405 on GET`);
    }
  } finally {
    server.close();
  }
});

test('POST still works for the internal batch chain and manual triggers', async () => {
  const server = await listen();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/cron/monthly-send`, {
      method: 'POST',
      headers: { 'x-cron-secret': 'test-cron-secret' }
    });
    assert.strictEqual(res.status, 202, 'monthly-send POST must still return 202');
    const body = await res.json();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.processing, true);
  } finally {
    server.close();
  }
});
