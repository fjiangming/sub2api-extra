'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../src/app');
const { AuthService } = require('../src/auth');

function jwt(claims) {
  return [
    Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
    Buffer.from(JSON.stringify(claims)).toString('base64url'),
    'signature'
  ].join('.');
}

function dependencies(config, auth) {
  return {
    config,
    database: { ping: async () => ({ database: 'test', latencyMs: 1 }), maintenance: null },
    auth,
    inspector: { inspect: async () => ({ compatible: true, tables: {}, missingRequired: [] }) },
    metrics: {
      getOverview: async () => ({}), getUsage: async () => ({}), getUsageDimensions: async () => ({}),
      getUsers: async () => ({}), getFinance: async () => ({})
    },
    storage: { getStorage: async () => ({}) },
    scheduler: { getStatus: () => ({ enabled: false }) },
    retention: {
      getPolicy: () => ({}), getBackupStatus: async () => ({}), startNativeBackup: async () => ({}),
      createPreview: async () => ({ id: 'preview' }), getPreview: () => ({}), execute: async () => ({}),
      listRuns: () => [], getRun: () => ({}), cancelRun: () => ({})
    },
    sub2api: { configured: () => false }
  };
}

test('HTTP contract enforces login and CSRF on previews', async (t) => {
  const config = {
    env: 'test', trustProxy: false, authMode: 'local', adminUser: 'admin', adminPassword: 'test-password-123',
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
    scheduler: { getStatus: () => ({ enabled: false }) },
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

  const automation = await fetch(`${base}/api/retention/automation`, { headers: { cookie } });
  assert.equal(automation.status, 200);
  assert.equal((await automation.json()).enabled, false);

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

test('custom-menu token is exchanged for a local session and removed from the redirect URL', async (t) => {
  const upstreamToken = jwt({ sub: '99', role: 'admin', exp: Math.floor(Date.now() / 1000) + 3600 });
  const config = {
    env: 'test', trustProxy: true, authMode: 'sub2api', adminUser: 'admin', adminPassword: '',
    sessionTtlMinutes: 30, cookieSecure: false, sub2apiTimezone: 'Asia/Shanghai',
    financeTimezone: 'Asia/Shanghai', cleanupEnabled: false,
    sub2apiBaseUrl: 'https://sub2api.example.test', sub2apiPublicUrl: 'https://sub2api.example.test',
    sub2apiRequestTimeoutMs: 1000
  };
  const auth = new AuthService(config, {
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers.authorization, `Bearer ${upstreamToken}`);
      return new Response(JSON.stringify({
        code: 0, data: { id: 99, username: 'sub2api-admin', role: 'admin' }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  t.after(() => auth.close());
  const app = createApp(dependencies(config, auth));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const authConfig = await fetch(`${base}/api/auth/config`);
  assert.deepEqual(await authConfig.json(), {
    mode: 'sub2api', ssoEnabled: true, sub2apiUrl: 'https://sub2api.example.test'
  });
  const entry = await fetch(base);
  assert.equal(entry.headers.get('x-frame-options'), null);
  assert.match(entry.headers.get('content-security-policy'), /frame-ancestors 'self' https:\/\/sub2api\.example\.test/);

  const exchange = await fetch(`${base}/?token=${encodeURIComponent(upstreamToken)}&theme=light`, {
    redirect: 'manual'
  });
  assert.equal(exchange.status, 303);
  const location = exchange.headers.get('location');
  assert.ok(!location.includes(upstreamToken));
  assert.match(location, /^\/?\?theme=light#oc_session=/);
  const sessionToken = new URL(location, base).hash.slice('#oc_session='.length);

  const me = await fetch(`${base}/api/auth/me`, {
    headers: { authorization: `Session ${decodeURIComponent(sessionToken)}` }
  });
  assert.equal(me.status, 200);
  const session = await me.json();
  assert.equal(session.user.name, 'sub2api-admin');
  assert.equal(session.authentication.source, 'sso');

  const preview = await fetch(`${base}/api/retention/previews`, {
    method: 'POST',
    headers: {
      authorization: `Session ${decodeURIComponent(sessionToken)}`,
      'content-type': 'application/json',
      'x-csrf-token': session.csrfToken
    },
    body: '{}'
  });
  assert.equal(preview.status, 201);
});
