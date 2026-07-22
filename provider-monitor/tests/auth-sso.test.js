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

test('step-up protected requests use the explicit SSO token and preserve upstream error codes', async (t) => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (input, options = {}) => {
    const url = new URL(input);
    requests.push({
      path: url.pathname,
      authorization: options.headers.Authorization,
      body: options.body
    });
    if (url.pathname === '/api/v1/admin/accounts/data') {
      return new Response(JSON.stringify({
        code: 'STEP_UP_REQUIRED',
        message: 'This operation requires recent two-factor verification'
      }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/api/v1/user/totp/step-up') {
      if (JSON.parse(options.body).code === '000000') {
        return new Response(JSON.stringify({
          code: 400,
          message: 'invalid totp code',
          reason: 'TOTP_INVALID_CODE'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        code: 0,
        data: { verified: true, expires_in: 900 }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  };
  t.after(() => { global.fetch = originalFetch; });

  const client = new Sub2ApiAdminClient({
    sub2apiBaseUrl: 'https://sub2api.example',
    sub2apiAdminToken: '',
    adminEmail: '',
    adminPassword: '',
    queryTimeoutMs: 1000,
    maxResponseBytes: 1024
  });
  client.setRuntimeToken('another-session-token', Date.now() + 60000);

  await assert.rejects(
    () => client.data('/api/v1/admin/accounts/data', { accessToken: 'current-session-token' }),
    (error) => error.code === 'SUB2API_REQUEST_FAILED' &&
      error.details?.remoteCode === 'STEP_UP_REQUIRED'
  );
  const result = await client.verifyStepUp('current-session-token', '123456');
  await assert.rejects(
    () => client.verifyStepUp('current-session-token', '000000'),
    (error) => error.code === 'SUB2API_TOTP_INVALID_CODE' &&
      error.details?.remoteCode === 'TOTP_INVALID_CODE'
  );

  assert.deepEqual(result, { verified: true, expiresIn: 900 });
  assert.equal(requests.length, 3);
  assert.ok(requests.every((request) => request.authorization === 'Bearer current-session-token'));
  assert.deepEqual(JSON.parse(requests[1].body), { code: '123456' });
  assert.deepEqual(JSON.parse(requests[2].body), { code: '000000' });
  assert.equal(await client.adminToken(), 'another-session-token');
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

test('local authentication completes configured Sub2API administrator 2FA without an SSO session', async (t) => {
  const context = createTestContext({
    PROVIDER_MONITOR_AUTH_MODE: 'local',
    SUB2API_BASE_URL: 'https://sub2api.internal.example',
    SUB2API_PUBLIC_URL: 'https://sub2api.example',
    ADMIN_EMAIL: 'admin@example.com',
    ADMIN_PASSWORD: 'configured-password',
    SUB2API_ADMIN_TOKEN: ''
  });
  const originalFetch = global.fetch;
  const upstreamRequests = [];
  global.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.hostname !== 'sub2api.internal.example') return originalFetch(input, options);
    upstreamRequests.push({
      path: url.pathname,
      authorization: options.headers?.Authorization || null,
      body: options.body ? JSON.parse(options.body) : null
    });
    if (url.pathname === '/api/v1/auth/login') {
      return new Response(JSON.stringify({
        code: 0,
        data: { requires_2fa: true, temp_token: 'configured-login-temp-token' }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/api/v1/auth/login/2fa') {
      assert.deepEqual(JSON.parse(options.body), {
        temp_token: 'configured-login-temp-token',
        totp_code: '654321'
      });
      return new Response(JSON.stringify({
        code: 0,
        data: {
          access_token: 'configured-session-token',
          refresh_token: 'configured-refresh-token',
          expires_in: 3600,
          user: { id: 1, role: 'admin' }
        }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/api/v1/auth/refresh') {
      assert.deepEqual(JSON.parse(options.body), { refresh_token: 'configured-refresh-token' });
      return new Response(JSON.stringify({
        code: 0,
        data: {
          access_token: 'refreshed-configured-session-token',
          refresh_token: 'rotated-configured-refresh-token',
          expires_in: 3600
        }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/api/v1/admin/channels') {
      if (options.headers.Authorization === 'Bearer configured-session-token') {
        return new Response(JSON.stringify({ code: 'TOKEN_EXPIRED', message: 'expired' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      assert.equal(options.headers.Authorization, 'Bearer refreshed-configured-session-token');
      return new Response(JSON.stringify({
        code: 0,
        data: { items: [{ id: 11, name: 'Configured channel' }], total: 1 }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`Unexpected Sub2API endpoint: ${url.pathname}`);
  };

  const app = createApplication({ config: context.config, db: context.db, startBackground: false });
  const enqueued = [];
  app.locals.services.mappings.list = () => [{ enabled: true }];
  app.locals.services.queue.enqueue = (type, options) => {
    enqueued.push({ type, options });
    return 'queued-test-job';
  };
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    global.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
    await app.locals.close();
    context.cleanup();
  });

  const loginResponse = await originalFetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-password' })
  });
  assert.equal(loginResponse.status, 200);
  const session = await loginResponse.json();
  assert.equal(session.authentication.mode, 'local');
  assert.equal(enqueued.filter((job) => job.type === 'sub2api_mapping_sync').length, 1);

  const firstChannels = await originalFetch(`${base}/api/sub2api/channels`, {
    headers: { Authorization: `Session ${session.sessionToken}` }
  });
  assert.equal(firstChannels.status, 403);
  assert.equal((await firstChannels.json()).error.code, 'SUB2API_LOGIN_2FA_REQUIRED');
  assert.deepEqual(app.locals.services.sub2api.authenticationStatus(), {
    available: false,
    source: 'configured_credentials',
    error: 'two_factor_required',
    requiresTwoFactor: true
  });

  const twoFactorResponse = await originalFetch(`${base}/api/sub2api/step-up`, {
    method: 'POST',
    headers: {
      Authorization: `Session ${session.sessionToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': session.csrfToken
    },
    body: JSON.stringify({ code: '654321' })
  });
  assert.equal(twoFactorResponse.status, 200);
  assert.deepEqual(await twoFactorResponse.json(), { verified: true, expiresIn: 3600 });

  const channelsResponse = await originalFetch(`${base}/api/sub2api/channels`, {
    headers: { Authorization: `Session ${session.sessionToken}` }
  });
  assert.equal(channelsResponse.status, 200);
  assert.equal((await channelsResponse.json()).items[0].name, 'Configured channel');
  assert.deepEqual(app.locals.services.sub2api.authenticationStatus(), {
    available: true,
    source: 'configured_credentials'
  });
  assert.equal(upstreamRequests.filter((request) => request.path === '/api/v1/auth/login').length, 1);
  assert.equal(upstreamRequests.filter((request) => request.path === '/api/v1/auth/login/2fa').length, 1);
  assert.equal(upstreamRequests.filter((request) => request.path === '/api/v1/auth/refresh').length, 1);
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
  const boundToken = accessToken({
    sub: 7,
    username: 'operator',
    role: 'admin',
    bnd: 'browser-network-fingerprint',
    exp: Math.floor(Date.now() / 1000) + 3600
  });
  global.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.hostname === 'sub2api.internal.example') {
      const suppliedToken = String(options.headers.Authorization || '').replace(/^Bearer /, '');
      if (url.pathname === '/api/v1/auth/me') {
        if (suppliedToken === boundToken) {
          return new Response(JSON.stringify({
            code: 'SESSION_BINDING_MISMATCH',
            message: 'Session network fingerprint changed, please login again'
          }), { status: 401, headers: { 'Content-Type': 'application/json' } });
        }
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
      if (url.pathname === '/api/v1/user/totp/step-up') {
        assert.deepEqual(JSON.parse(options.body), { code: '654321' });
        return new Response(JSON.stringify({
          code: 0,
          data: { verified: true, expires_in: 900 }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
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

  const stepUpResponse = await originalFetch(`${base}/api/sub2api/step-up`, {
    method: 'POST',
    headers: {
      Authorization: `Session ${sessionToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': session.csrfToken
    },
    body: JSON.stringify({ code: '654321' })
  });
  assert.equal(stepUpResponse.status, 200);
  assert.deepEqual(await stepUpResponse.json(), { verified: true, expiresIn: 900 });
  const stepUpAudit = context.db.prepare(`
    SELECT details_json FROM audit_logs WHERE action = 'sub2api.step_up.verify'
  `).get();
  assert.deepEqual(JSON.parse(stepUpAudit.details_json), { expiresIn: 900 });

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

  const boundSession = await originalFetch(`${base}/api/auth/sso`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${boundToken}` }
  });
  assert.equal(boundSession.status, 409);
  assert.equal((await boundSession.json()).error.code, 'SUB2API_SESSION_BINDING_INCOMPATIBLE');

  const boundEntry = await originalFetch(`${base}/?token=${encodeURIComponent(boundToken)}`, {
    redirect: 'manual'
  });
  assert.equal(boundEntry.status, 303);
  assert.equal(
    new URL(boundEntry.headers.get('location'), base).searchParams.get('sso_error'),
    'SUB2API_SESSION_BINDING_INCOMPATIBLE'
  );

  const expired = await originalFetch(`${base}/?token=expired-token`, { redirect: 'manual' });
  assert.equal(expired.status, 303);
  assert.equal(new URL(expired.headers.get('location'), base).searchParams.get('sso_error'), 'AUTH_FAILED');

  const index = await originalFetch(base);
  assert.equal(index.headers.get('x-frame-options'), null);
  assert.match(index.headers.get('content-security-policy'), /frame-ancestors 'self' https:\/\/sub2api\.example/);
});
