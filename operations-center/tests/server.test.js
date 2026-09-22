'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../src/app');
const { AuthService } = require('../src/auth');

test('HTTP contract enforces login and CSRF on previews', async (t) => {
  const config = {
    env: 'test', trustProxy: false, adminUser: 'admin', adminPassword: 'test-password-123',
    sessionTtlMinutes: 30, cookieSecure: false, sub2apiTimezone: 'Asia/Shanghai',
    financeTimezone: 'Asia/Shanghai', cleanupEnabled: false
  };
  const auth = new AuthService(config);
  t.after(() => auth.close());
  let previewCalls = 0;
  const app = createApp({
    config,
    database: { ping: async () => ({ database: 'test', latencyMs: 1 }), maintenance: null },
    auth,
    inspector: { inspect: async () => ({ compatible: true, tables: {}, missingRequired: [] }) },
    metrics: {
      getOverview: async () => ({}), getUsage: async () => ({}), getUsageDimensions: async () => ({}),
      getUsers: async () => ({}), getFinance: async () => ({})
    },
    storage: { getStorage: async () => ({}) },
    retention: {
      getPolicy: () => ({}), getBackupStatus: async () => ({}), startNativeBackup: async () => ({}),
      createPreview: async () => { previewCalls += 1; return { id: 'preview' }; },
      getPreview: () => ({}), execute: async () => ({}), listRuns: () => [], getRun: () => ({}), cancelRun: () => ({})
    },
    sub2api: { configured: () => false }
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const unauthorized = await fetch(`${base}/api/retention/policy`);
  assert.equal(unauthorized.status, 401);

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-password-123' })
  });
  assert.equal(login.status, 200);
  const session = await login.json();
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const withoutCsrf = await fetch(`${base}/api/retention/previews`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}'
  });
  assert.equal(withoutCsrf.status, 403);
  assert.equal(previewCalls, 0);

  const withCsrf = await fetch(`${base}/api/retention/previews`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': session.csrfToken }, body: '{}'
  });
  assert.equal(withCsrf.status, 201);
  assert.equal(previewCalls, 1);
});
