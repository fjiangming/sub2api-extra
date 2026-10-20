'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AuthService } = require('../src/auth');
const { Sub2ApiClient } = require('../src/sub2api-client');
const { loadConfig } = require('../src/config');
const { AppError } = require('../src/errors');

function request(headers = {}) {
  return { ip: '::ffff:127.0.0.1', headers, get: (name) => headers[name.toLowerCase()] };
}
function response() { return { headers: {}, setHeader(name, value) { this.headers[name] = value; } }; }
function middleware(auth, req, res = response()) {
  return new Promise((resolve, reject) => auth.middleware()(req, res, (error) => error ? reject(error) : resolve(req.auth)));
}
function token(claims) { return `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.unsigned`; }

test('only the upstream exact admin role enables leaderboard management', async () => {
  for (const role of ['admin', 'user', 'root', 'Admin', undefined, 1]) {
    const client = new Sub2ApiClient(loadConfig({ NODE_ENV: 'test' }), { fetchImpl: async () =>
      Response.json({ code: 0, data: { id: 7, role, status: 'active', email: 'admin@example.com' } }) });
    const user = await client.me(token({ role: 'admin' }), {});
    assert.equal(user.role, role === 'admin' ? 'admin' : 'user');
  }
});

test('identity comes only from upstream; forged JWT claims and query user IDs are ignored', async (t) => {
  const config = loadConfig({ NODE_ENV: 'test' });
  let called;
  const client = new Sub2ApiClient(config, { fetchImpl: async (url, options) => {
    called = { url, options };
    return Response.json({ code: 0, data: { id: 7, username: '真实昵称', role: 'user', status: 'active', email: 'private@example.com' } });
  } });
  const auth = new AuthService(config, client);
  t.after(() => auth.close());
  const res = response();
  const jwt = token({ user_id: 1, role: 'admin', exp: Math.floor(Date.now() / 1000) + 3600 });
  const data = await auth.sso(request({ 'user-agent': 'test-browser' }), res, jwt);
  assert.equal(called.url, 'http://127.0.0.1:8080/api/v1/auth/me');
  assert.equal(called.options.headers.authorization, `Bearer ${jwt}`);
  assert.equal(called.options.redirect, 'error');
  const session = await middleware(auth, request({ 'user-agent': 'test-browser', authorization: `Session ${data.sessionToken}` }));
  assert.equal(session.user.id, '7');
  assert.equal(data.user.name, 'pr***@example.com');
  assert.equal(data.capabilities, undefined);
  assert.equal(data.csrfToken, undefined);
  assert.equal(auth.publicSession(session).user.name, 'pr***@example.com');
  assert.ok(!JSON.stringify(data).includes('真实昵称'));
  assert.ok(!JSON.stringify(data).includes('private@example.com'));
  assert.ok(!JSON.stringify(data).includes(jwt));
  assert.match(res.headers['Set-Cookie'], /HttpOnly; SameSite=Lax/);
  await assert.rejects(middleware(auth, request({ 'user-agent': 'different', authorization: `Session ${data.sessionToken}` })), { code: 'AUTH_REQUIRED' });
});

test('upstream expiry caps sessions, cleanup releases memory, and revoked users fail revalidation', async (t) => {
  let clock = 100000;
  let valid = true;
  let calls = 0;
  const auth = new AuthService(loadConfig({ NODE_ENV: 'test' }), { async me() {
    calls++;
    if (!valid) throw new AppError('AUTH_FAILED', 'expired', 401);
    return { id: '2', email: 'user@example.com' };
  } }, { now: () => clock });
  t.after(() => auth.close());
  const data = await auth.sso(request(), response(), token({ exp: 300 }));
  assert.equal(new Date(data.expiresAt).getTime(), 300000);
  const req = request({ authorization: `Session ${data.sessionToken}` });
  await middleware(auth, req);
  assert.equal(calls, 1);
  clock += 61000;
  await Promise.all([middleware(auth, req), middleware(auth, req)]);
  assert.equal(calls, 2);
  clock += 61000;
  valid = false;
  await assert.rejects(middleware(auth, req), { code: 'AUTH_FAILED' });
  assert.equal(auth.sessions.size, 0);
  valid = true;
  await assert.rejects(auth.sso(request(), response(), token({ exp: 1 })), { code: 'AUTH_FAILED' });
  const next = await auth.sso(request(), response(), 'opaque-token');
  clock = new Date(next.expiresAt).getTime();
  auth.cleanup();
  assert.equal(auth.sessions.size, 0);
});

test('successful revalidation rolls active sessions past their original deadline and renews cookie-only access', async (t) => {
  let clock = 100000;
  let calls = 0;
  const config = loadConfig({ NODE_ENV: 'test', USAGE_LEADERBOARD_SESSION_MINUTES: '5' });
  const auth = new AuthService(config, { async me() {
    calls++;
    return { id: '2', email: 'reader@gmail.com' };
  } }, { now: () => clock });
  t.after(() => auth.close());
  const login = await auth.sso(request(), response(), 'opaque-token');
  const originalDeadline = Date.parse(login.expiresAt);
  const req = request({ authorization: `Session ${login.sessionToken}` });
  clock += 59000;
  const cached = response();
  const session = await middleware(auth, req, cached);
  assert.equal(calls, 1);
  assert.equal(session.expiresAt, originalDeadline);
  assert.equal(cached.headers['Set-Cookie'], undefined);

  clock += 2000;
  const first = response();
  const second = response();
  await Promise.all([middleware(auth, req, first), middleware(auth, req, second)]);
  assert.equal(calls, 2);
  for (const res of [first, second]) {
    assert.match(res.headers['Set-Cookie'], /HttpOnly; SameSite=Lax; Max-Age=300$/);
    assert.ok(!res.headers['Set-Cookie'].includes('opaque-token'));
  }
  assert.equal(session.expiresAt, clock + config.sessionTtlMs);
  assert.equal(auth.sessions.size, 1);
  assert.equal(auth.publicSession(session).sessionToken, login.sessionToken);

  clock = originalDeadline + 1;
  const cookieRequest = request({ cookie: first.headers['Set-Cookie'].split(';')[0] });
  const renewed = response();
  assert.equal(await middleware(auth, cookieRequest, renewed), session);
  assert.equal(session.expiresAt, clock + config.sessionTtlMs);
  assert.equal(Date.parse(auth.publicSession(session).expiresAt), session.expiresAt);
  assert.match(renewed.headers['Set-Cookie'], /Max-Age=300$/);

  clock = session.expiresAt;
  await assert.rejects(middleware(auth, cookieRequest), { code: 'AUTH_REQUIRED' });
  assert.equal(calls, 3);
  assert.equal(auth.sessions.size, 0);
});

test('rolling sessions and both secure cookies remain capped by the original upstream token expiry', async (t) => {
  let clock = 100000;
  let calls = 0;
  const config = { ...loadConfig({ NODE_ENV: 'test', USAGE_LEADERBOARD_SESSION_MINUTES: '5' }), cookieSecure: true };
  const auth = new AuthService(config, { async me() {
    calls++;
    return { id: '2', email: 'reader@gmail.com' };
  } }, { now: () => clock });
  t.after(() => auth.close());
  const jwt = token({ exp: 900 });
  const login = await auth.sso(request(), response(), jwt);
  const req = request({ authorization: `Session ${login.sessionToken}` });
  for (const now of [300000, 550000, 800000]) {
    clock = now;
    const res = response();
    const session = await middleware(auth, req, res);
    assert.equal(session.expiresAt, Math.min(clock + config.sessionTtlMs, 900000));
    const cookies = res.headers['Set-Cookie'];
    assert.equal(cookies.length, 2);
    assert.match(cookies[0], /^__Host-ul_session=.*Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
    assert.match(cookies[1], /^__Host-ul_session_partitioned=.*HttpOnly; SameSite=None; Secure; Partitioned; Max-Age=\d+$/);
    for (const cookie of cookies) {
      assert.equal(Number(/Max-Age=(\d+)/.exec(cookie)[1]), Math.min(300, (900000 - clock) / 1000));
      assert.ok(!cookie.includes(jwt));
    }
  }
  clock = 900000;
  const expired = response();
  await assert.rejects(middleware(auth, req, expired), { code: 'AUTH_REQUIRED' });
  assert.equal(expired.headers['Set-Cookie'], undefined);
  assert.equal(auth.sessions.size, 0);
  assert.equal(calls, 4);
});

test('authentication rejection, disabled users and changed identities cannot renew a session', async (t) => {
  for (const failure of [new AppError('AUTH_FAILED', 'revoked', 401), new AppError('ACCOUNT_UNAVAILABLE', 'disabled', 403), null]) {
    let clock = 100000;
    let calls = 0;
    const config = loadConfig({ NODE_ENV: 'test', USAGE_LEADERBOARD_SESSION_MINUTES: '5' });
    const auth = new AuthService(config, { async me() {
      calls++;
      if (calls > 1 && failure) throw failure;
      return { id: calls > 1 ? '3' : '2', email: 'reader@gmail.com' };
    } }, { now: () => clock });
    t.after(() => auth.close());
    const login = await auth.sso(request(), response(), 'opaque-token');
    const session = auth.sessions.get(login.sessionToken);
    clock += 61000;
    const res = response();
    await assert.rejects(middleware(auth, request({ authorization: `Session ${login.sessionToken}` }), res),
      { code: failure?.code || 'AUTH_REQUIRED' });
    assert.equal(session.expiresAt, Date.parse(login.expiresAt));
    assert.equal(res.headers['Set-Cookie'], undefined);
    assert.equal(auth.sessions.size, 0);
  }
});

test('temporary upstream failures do not renew sessions and recovery requires an unexpired session', async (t) => {
  let clock = 100000;
  let failure;
  let calls = 0;
  const config = loadConfig({ NODE_ENV: 'test', USAGE_LEADERBOARD_SESSION_MINUTES: '5' });
  const auth = new AuthService(config, { async me() {
    calls++;
    if (failure) throw failure;
    return { id: '2', email: 'reader@gmail.com' };
  } }, { now: () => clock });
  t.after(() => auth.close());
  const login = await auth.sso(request(), response(), 'opaque-token');
  const session = auth.sessions.get(login.sessionToken);
  const req = request({ authorization: `Session ${login.sessionToken}` });
  clock += 61000;
  failure = new AppError('AUTH_UPSTREAM_UNAVAILABLE', 'temporarily unavailable', 503);
  const unavailable = response();
  await assert.rejects(middleware(auth, req, unavailable), { status: 503 });
  assert.equal(unavailable.headers['Set-Cookie'], undefined);
  assert.equal(session.expiresAt, Date.parse(login.expiresAt));
  assert.equal(auth.sessions.get(session.id), session);

  failure = null;
  await middleware(auth, req);
  assert.equal(session.expiresAt, clock + config.sessionTtlMs);
  clock += 61000;
  failure = new AppError('AUTH_UPSTREAM_TIMEOUT', 'timed out', 504);
  await assert.rejects(middleware(auth, req), { status: 504 });
  assert.equal(session.expiresAt, Date.parse(login.expiresAt) + 61000);
  clock = session.expiresAt;
  failure = null;
  await assert.rejects(middleware(auth, req), { code: 'AUTH_REQUIRED' });
  assert.equal(calls, 4);
  assert.equal(auth.sessions.size, 0);
});

for (const invalidation of ['expiry', 'logout', 'replacement', 'shutdown']) {
  test(`in-flight revalidation cannot revive a session after ${invalidation}`, async (t) => {
    let clock = 100000;
    const user = { id: '2', email: 'reader@gmail.com' };
    const pending = Promise.withResolvers();
    const started = Promise.withResolvers();
    let calls = 0;
    const auth = new AuthService(loadConfig({ NODE_ENV: 'test' }), { async me(value) {
      calls++;
      if (value === 'original' && calls > 1) { started.resolve(); return pending.promise; }
      return user;
    } }, { now: () => clock });
    t.after(() => auth.close());
    const login = await auth.sso(request(), response(), 'original');
    const req = request({ authorization: `Session ${login.sessionToken}` });
    clock += 61000;
    const res = response();
    const rejected = assert.rejects(middleware(auth, req, res), { code: 'AUTH_REQUIRED' });
    await started.promise;
    let replacement;
    if (invalidation === 'expiry') clock = Date.parse(login.expiresAt);
    else if (invalidation === 'logout') {
      const loggedOut = response();
      auth.logout(req, loggedOut);
      assert.match(loggedOut.headers['Set-Cookie'], /Max-Age=0$/);
    } else if (invalidation === 'replacement') replacement = await auth.sso(req, response(), 'replacement');
    else auth.close();
    pending.resolve(user);
    await rejected;
    assert.equal(res.headers['Set-Cookie'], undefined);
    assert.equal(auth.sessions.has(login.sessionToken), false);
    assert.equal(auth.sessions.size, replacement ? 1 : 0);
    if (replacement) assert.ok(auth.sessions.has(replacement.sessionToken));
  });
}

test('concurrent logins obey the memory cap and secure iframe cookies have a Session-header fallback', async (t) => {
  const auth = new AuthService({ ...loadConfig({ NODE_ENV: 'test' }), maxSessions: 1, cookieSecure: true },
    { async me() { await new Promise((resolve) => setImmediate(resolve)); return { id: '2', email: 'user@example.com' }; } });
  t.after(() => auth.close());
  const res = response();
  const outcomes = await Promise.allSettled([
    auth.sso(request(), res, 'first'), auth.sso(request(), response(), 'second')
  ]);
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(auth.sessions.size, 1);
  assert.equal(outcomes.find((result) => result.status === 'rejected').reason.code, 'SESSION_CAPACITY');
  assert.match(res.headers['Set-Cookie'][0], /^__Host-ul_session=.*Secure/);
  assert.match(res.headers['Set-Cookie'][1], /SameSite=None; Secure; Partitioned/);
  const id = outcomes.find((result) => result.status === 'fulfilled').value.sessionToken;
  const session = await middleware(auth, request({ authorization: `Session ${id}` }));
  assert.equal(session.user.id, '2');
  auth.logout(request({ authorization: `Session ${id}` }), response());
  await assert.rejects(middleware(auth, request({ authorization: `Session ${id}` })), { code: 'AUTH_REQUIRED' });
});

test('upstream errors, disabled users and oversized responses never create a session', async () => {
  const config = loadConfig({ NODE_ENV: 'test' });
  for (const [responseValue, code] of [
    [Response.json({ reason: 'SESSION_BINDING_MISMATCH' }, { status: 401 }), 'SESSION_BINDING_MISMATCH'],
    [Response.json({ data: { id: 1, status: 'disabled' } }), 'ACCOUNT_UNAVAILABLE'],
    [Response.json({ code: 123, data: { id: 1 } }), 'AUTH_FAILED'],
    [Response.json({ data: { user_id: Number.MAX_SAFE_INTEGER + 2 } }), 'AUTH_UPSTREAM_INVALID'],
    [new Response('bad json'), 'AUTH_UPSTREAM_INVALID'],
    [Response.json({ large: 'x'.repeat(300000) }), 'AUTH_UPSTREAM_INVALID']
  ]) {
    const client = new Sub2ApiClient(config, { fetchImpl: async () => responseValue });
    await assert.rejects(client.me('token', { ip: '127.0.0.1', userAgent: '' }), { code });
  }
});

test('client fingerprint forwarding requires explicit configuration and valid IP', async () => {
  for (const [enabled, ip, expected] of [[false, '127.0.0.1', undefined], [true, '127.0.0.1', '127.0.0.1'], [true, 'bad\r\nheader', undefined]]) {
    let headers;
    const client = new Sub2ApiClient({ ...loadConfig({ NODE_ENV: 'test' }), forwardClientFingerprint: enabled },
      { fetchImpl: async (_url, options) => { headers = options.headers; return Response.json({ id: 1 }); } });
    await client.me('token', { ip, userAgent: 'browser' });
    assert.equal(headers['x-forwarded-for'], expected);
  }
});
