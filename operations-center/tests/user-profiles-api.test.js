'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../src/app');
const { AuthService } = require('../src/auth');
const { profileFixture } = require('./profile-fixture');

test('real profile HTTP API requires administrator auth, validates queries and serves complete CSV', async (t) => {
  const fixture = await profileFixture();
  t.after(() => fixture.database.close());
  const config = { ...fixture.config, env: 'test', authMode: 'local', trustProxy: false,
    adminUser: 'admin', adminPassword: 'local-test-password', sessionTtlMinutes: 30, cookieSecure: false };
  const auth = new AuthService(config);
  t.after(() => auth.close());
  const app = createApp({ config, auth, database: fixture.database, inspector: fixture.inspector, profiles: fixture.profiles });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const route of ['/options', '', '/users', '/users/2', '/export']) {
    assert.equal((await fetch(`${base}/api/user-profiles${route}`)).status, 401);
  }
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'local-test-password' }) });
  const { sessionToken } = await login.json();
  const headers = { authorization: `Session ${sessionToken}` };
  const options = await fetch(`${base}/api/user-profiles/options`, { headers });
  assert.equal(options.status, 200);
  assert.equal(options.headers.get('cache-control'), 'no-store');
  assert.ok((await options.json()).platforms.includes('future-platform'));
  const report = await fetch(`${base}/api/user-profiles`, { headers });
  assert.equal((await report.json()).summary.cost, 123);
  const users = await fetch(`${base}/api/user-profiles/users?pageSize=1&search=2`, { headers });
  assert.equal((await users.json()).items[0].id, '2');
  const detail = await fetch(`${base}/api/user-profiles/users/2?billing=subscription`, { headers });
  assert.equal((await detail.json()).user.cost, 70);
  for (const route of ['/users?sort=malicious', '/users/invalid', '?start=2026-09-01']) {
    assert.equal((await fetch(`${base}/api/user-profiles${route}`, { headers })).status, 400);
  }
  assert.equal((await fetch(`${base}/api/user-profiles/users/1`, { headers })).status, 404);
  const csv = await fetch(`${base}/api/user-profiles/export?pageSize=1&page=3`, { headers });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /attachment; filename="user-profiles-/);
  assert.equal((await csv.text()).trimEnd().split('\r\n').length, 7);
  const html = await fetch(base);
  assert.match(html.headers.get('content-security-policy'), /style-src 'self'/);
});
