'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AuthService } = require('../src/auth');

function request(ip = '203.0.113.10', userAgent = 'test-browser') {
  return {
    ip,
    headers: { 'user-agent': userAgent },
    get(name) { return this.headers[String(name).toLowerCase()] || ''; }
  };
}

function response() {
  return { headers: {}, setHeader(name, value) { this.headers[name] = value; } };
}

function sessionIdFromResponse(res) {
  const values = Array.isArray(res.headers['Set-Cookie']) ? res.headers['Set-Cookie'] : [res.headers['Set-Cookie']];
  const match = /(?:^|;\s*)rc_session=([^;]+)/.exec(values[0]);
  return decodeURIComponent(match[1]);
}

function middlewareResult(middleware, req) {
  return new Promise((resolve) => middleware(req, {}, (error) => resolve(error || null)));
}

test('ordinary user tokens are discarded while admin tokens remain memory-only', async (t) => {
  const config = { cookieSecure: false, sessionTtlMinutes: 60 };
  const users = {
    'user-token': { id: 42, email: 'alice@example.com', role: 'user', status: 'active' },
    'admin-token': { id: 1, email: 'admin@example.com', role: 'admin', status: 'active' }
  };
  const auth = new AuthService(config, { getCurrentUser: async (token) => users[token] });
  t.after(() => auth.close());

  const userResponse = response();
  const userSession = await auth.sso(request(), userResponse, 'user-token');
  const storedUser = auth.sessions.get(sessionIdFromResponse(userResponse));
  assert.equal(storedUser.upstreamToken, null);
  assert.equal(userSession.user.emailMasked, 'al***@example.com');
  assert.equal('sessionToken' in userSession, false);

  const adminResponse = response();
  const adminSession = await auth.sso(request(), adminResponse, 'admin-token');
  const storedAdmin = auth.sessions.get(sessionIdFromResponse(adminResponse));
  assert.equal(storedAdmin.upstreamToken, 'admin-token');
  assert.equal(adminSession.user.role, 'admin');
});

test('official payment keeps the ordinary user token in memory without exposing it publicly', async (t) => {
  const auth = new AuthService(
    { cookieSecure: false, sessionTtlMinutes: 60, paymentMode: 'sub2api_official' },
    { getCurrentUser: async () => ({ id: 42, email: 'alice@example.com', role: 'user', status: 'active' }) }
  );
  t.after(() => auth.close());
  const res = response();
  const publicSession = await auth.sso(request(), res, 'user-payment-token');
  const stored = auth.sessions.get(sessionIdFromResponse(res));

  assert.equal(stored.upstreamToken, 'user-payment-token');
  assert.equal(JSON.stringify(publicSession).includes('user-payment-token'), false);
  assert.equal('upstreamToken' in publicSession, false);
});

test('official sessions expose and refresh only the authenticated user balance', async (t) => {
  let balance = 12.5;
  const auth = new AuthService(
    { cookieSecure: false, sessionTtlMinutes: 60, paymentMode: 'sub2api_official' },
    { getCurrentUser: async () => ({ id: 42, email: 'alice@example.com', role: 'user', status: 'active', balance }) }
  );
  t.after(() => auth.close());
  const res = response();
  const initial = await auth.sso(request(), res, 'user-payment-token');
  const stored = auth.sessions.get(sessionIdFromResponse(res));
  assert.equal(initial.user.balance, 12.5);

  balance = 49.75;
  const refreshed = await auth.refresh(stored);
  assert.equal(refreshed.user.balance, 49.75);
  assert.equal('upstreamToken' in refreshed, false);
});

test('center sessions are invalidated when their IP or user agent changes', async (t) => {
  const auth = new AuthService(
    { cookieSecure: false, sessionTtlMinutes: 60 },
    { getCurrentUser: async () => ({ id: 42, email: 'alice@example.com', role: 'user', status: 'active' }) }
  );
  t.after(() => auth.close());
  const res = response();
  await auth.sso(request(), res, 'user-token');
  const sessionId = sessionIdFromResponse(res);
  const req = request('203.0.113.99');
  req.headers.cookie = `rc_session=${encodeURIComponent(sessionId)}`;
  const error = await middlewareResult(auth.middleware(), req);
  assert.equal(error.code, 'SESSION_BINDING_MISMATCH');
  assert.equal(auth.sessions.has(sessionId), false);
});

test('ordinary sessions never outlive the verified upstream token', async (t) => {
  const expirationSeconds = Math.floor(Date.now() / 1000) + 30;
  const token = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ exp: expirationSeconds })).toString('base64url')}.signature`;
  const auth = new AuthService(
    { cookieSecure: false, sessionTtlMinutes: 60 },
    { getCurrentUser: async () => ({ id: 42, email: 'alice@example.com', role: 'user', status: 'active' }) }
  );
  t.after(() => auth.close());
  const res = response();
  await auth.sso(request(), res, token);
  const stored = auth.sessions.get(sessionIdFromResponse(res));
  assert.ok(stored.expiresAt <= expirationSeconds * 1000);
  assert.ok(stored.expiresAt < Date.now() + 60000);
});
