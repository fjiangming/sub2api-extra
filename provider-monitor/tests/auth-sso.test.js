const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');
const { createApplication } = require('../src/server');
const { Sub2ApiAdminClient } = require('../src/services/sub2api-admin-client');

function accessToken(claims) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(claims)}.signature`;
}

test('runtime SSO credentials remain usable until their actual expiration', async () => {
  const client = new Sub2ApiAdminClient({
    sub2apiBaseUrl: 'https://sub2api.example',
    sub2apiAdminToken: '',
    adminEmail: '',
    adminPassword: '',
    queryTimeoutMs: 1000,
    maxResponseBytes: 1024
  });
  client.setRuntimeToken('short-lived-token', Date.now() + 30000);
  assert.equal(await client.adminToken(), 'short-lived-token');
  client.setRuntimeToken('expired-token', Date.now() + 500);
  await assert.rejects(() => client.adminToken(), /administrator SSO session/);
});

test('an invalid configured token falls back to administrator credentials', async (t) => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (input, options = {}) => {
    const url = new URL(input);
    const authorization = options.headers.Authorization || '';
    requests.push({ path: url.pathname, authorization });
    if (url.pathname === '/api/v1/auth/login') {
      return new Response(JSON.stringify({
        code: 0,
        data: {
          access_token: 'fresh-login-token',
          expires_in: 3600,
          user: { role: 'admin' }
        }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/api/v1/admin/channels' && authorization === 'Bearer stale-configured-token') {
      return new Response(JSON.stringify({ code: 'INVALID_TOKEN', message: 'Invalid token' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    if (url.pathname === '/api/v1/admin/channels' && authorization === 'Bearer fresh-login-token') {
      return new Response(JSON.stringify({ code: 0, data: { items: [{ id: 1, name: 'Main' }], total: 1 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  };
  t.after(() => { global.fetch = originalFetch; });

  const client = new Sub2ApiAdminClient({
    sub2apiBaseUrl: 'https://sub2api.example',
    sub2apiAdminToken: 'stale-configured-token',
    adminEmail: 'admin@example.com',
    adminPassword: 'secret-password',
    queryTimeoutMs: 1000,
    maxResponseBytes: 1024
  });
  const channels = await client.listAll('/api/v1/admin/channels');

  assert.equal(channels.items[0].name, 'Main');
  assert.equal(requests.filter((request) => request.path === '/api/v1/auth/login').length, 1);
  assert.deepEqual(client.authenticationStatus(), { available: true, source: 'configured_credentials' });
});

test('Sub2API paginated reads reject malformed collection responses', async (t) => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ code: 0, data: { unexpected: [] } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
  t.after(() => { global.fetch = originalFetch; });
  const client = new Sub2ApiAdminClient({
    sub2apiBaseUrl: 'https://sub2api.example',
    sub2apiAdminToken: 'admin-token',
    adminEmail: '',
    adminPassword: '',
    queryTimeoutMs: 1000,
    maxResponseBytes: 1024
  });

  await assert.rejects(
    () => client.listAll('/api/v1/admin/accounts'),
    (error) => error.code === 'SCHEMA_MISMATCH'
  );
});

test('Sub2API custom-menu token is exchanged for a local session without a second login', async (t) => {
  const context = createTestContext({
    PROVIDER_MONITOR_AUTH_MODE: 'sub2api',
    SUB2API_BASE_URL: 'https://sub2api.internal.example',
    SUB2API_PUBLIC_URL: 'https://sub2api.example',
    ADMIN_EMAIL: '',
    ADMIN_PASSWORD: '',
    SUB2API_ADMIN_TOKEN: ''
  });
  const originalFetch = global.fetch;
  const token = accessToken({
    sub: 7,
    username: 'operator',
    role: 'admin',
    exp: Math.floor(Date.now() / 1000) + 3600
  });
  const userToken = accessToken({
    sub: 9,
    username: 'ordinary-user',
    role: 'user',
    exp: Math.floor(Date.now() / 1000) + 3600
  });
  global.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.hostname === 'sub2api.internal.example') {
      const suppliedToken = String(options.headers.Authorization || '').replace(/^Bearer /, '');
      if (url.pathname === '/api/v1/auth/me') {
        if (suppliedToken === userToken) {
          return new Response(JSON.stringify({
            code: 0,
            data: { id: 9, username: 'ordinary-user', role: 'user' }
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (suppliedToken !== token) {
          return new Response(JSON.stringify({ message: 'expired' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        return new Response(JSON.stringify({
          code: 0,
          data: { id: 7, username: 'operator', role: 'admin' }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      assert.equal(suppliedToken, token);
      if (url.pathname === '/api/v1/admin/channels') {
        return new Response(JSON.stringify({
          code: 0,
          data: { items: [{ id: 11, name: 'Main channel', group_ids: [7] }], total: 1 }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.pathname === '/api/v1/admin/groups/all') {
        return new Response(JSON.stringify({
          code: 0,
          data: [{ id: 7, name: 'Retail', rate_multiplier: 1 }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.pathname === '/api/v1/groups/rates') {
        return new Response(JSON.stringify({ code: 0, data: { 7: 1 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      throw new Error(`Unexpected Sub2API endpoint: ${url.pathname}`);
    }
    return originalFetch(input, options);
  };

  const app = createApplication({ config: context.config, db: context.db, startBackground: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    global.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
    await app.locals.close();
    context.cleanup();
  });

  const response = await originalFetch(`${base}/?token=${encodeURIComponent(token)}&theme=dark`, {
    redirect: 'manual',
    headers: { 'X-Forwarded-Proto': 'https' }
  });
  assert.equal(response.status, 303);
  const location = response.headers.get('location');
  assert.doesNotMatch(location, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(location, /^\/?\?theme=dark#pm_session=/);
  assert.match(response.headers.get('set-cookie'), /pm_session_partitioned=.*Partitioned/);
  const redirectUrl = new URL(location, base);
  const sessionToken = new URLSearchParams(redirectUrl.hash.slice(1)).get('pm_session');
  assert.ok(sessionToken);

  const sessionResponse = await originalFetch(`${base}/api/auth/me`, {
    headers: { Authorization: `Session ${sessionToken}` }
  });
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json();
  assert.equal(session.user.name, 'operator');
  assert.equal(session.authentication.source, 'sso');
  assert.equal(app.locals.services.sub2api.authenticationStatus().source, 'sso_session');

  const channelsResponse = await originalFetch(`${base}/api/sub2api/channels`, {
    headers: { Authorization: `Session ${sessionToken}` }
  });
  assert.equal(channelsResponse.status, 200);
  const channels = await channelsResponse.json();
  assert.equal(channels.items[0].name, 'Main channel');

  const exportResponse = await originalFetch(`${base}/api/exports/config`, {
    headers: { Authorization: `Session ${sessionToken}` }
  });
  assert.equal(exportResponse.status, 200);
  assert.match(exportResponse.headers.get('content-disposition'), /provider-monitor-config\.json/);

  const mutation = await originalFetch(`${base}/api/alert-rules`, {
    method: 'POST',
    headers: {
      Authorization: `Session ${sessionToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': session.csrfToken
    },
    body: JSON.stringify({ name: 'SSO mutation', ruleType: 'sync_failed' })
  });
  assert.equal(mutation.status, 201);

  const logout = await originalFetch(`${base}/api/auth/logout`, {
    method: 'POST',
    headers: {
      Authorization: `Session ${sessionToken}`,
      'X-CSRF-Token': session.csrfToken
    }
  });
  assert.equal(logout.status, 204);
  assert.equal(app.locals.services.sub2api.authenticationStatus().source, 'missing');

  const nonAdmin = await originalFetch(`${base}/api/auth/sso`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${userToken}` }
  });
  assert.equal(nonAdmin.status, 403);

  const nonAdminEntry = await originalFetch(`${base}/?token=${encodeURIComponent(userToken)}`, {
    redirect: 'manual'
  });
  assert.equal(nonAdminEntry.status, 303);
  assert.equal(new URL(nonAdminEntry.headers.get('location'), base).searchParams.get('sso_error'), 'ADMIN_REQUIRED');

  const expired = await originalFetch(`${base}/?token=expired-token`, { redirect: 'manual' });
  assert.equal(expired.status, 303);
  assert.equal(new URL(expired.headers.get('location'), base).searchParams.get('sso_error'), 'AUTH_FAILED');

  const index = await originalFetch(base);
  assert.equal(index.headers.get('x-frame-options'), null);
  assert.match(index.headers.get('content-security-policy'), /frame-ancestors 'self' https:\/\/sub2api\.example/);
});
