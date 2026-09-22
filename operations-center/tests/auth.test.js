'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AuthService, parseCookies } = require('../src/auth');

const config = {
  env: 'production',
  authMode: 'local',
  adminUser: 'admin',
  adminPassword: 'a-strong-local-password',
  sessionTtlMinutes: 30,
  cookieSecure: true
};

function request(headers = {}) {
  return {
    headers,
    secure: false,
    get(name) { return headers[String(name).toLowerCase()]; }
  };
}

function response() {
  const headers = new Map();
  return {
    headers,
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value); }
  };
}

function jwt(claims) {
  return [
    Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
    Buffer.from(JSON.stringify(claims)).toString('base64url'),
    'signature'
  ].join('.');
}

test('local sessions use opaque ids and independent CSRF tokens', async () => {
  const auth = new AuthService(config);
  try {
    const first = await auth.login(request(), response(), {
      username: 'admin', password: 'a-strong-local-password'
    });
    const second = await auth.login(request(), response(), {
      username: 'admin', password: 'a-strong-local-password'
    });
    assert.notEqual(first.sessionToken, second.sessionToken);
    assert.notEqual(first.csrfToken, second.csrfToken);
    assert.ok(first.sessionToken.length >= 40);
    assert.equal(first.authentication.source, 'local');
  } finally {
    auth.close();
  }
});

test('invalid credentials fail without revealing which field mismatched', async () => {
  const auth = new AuthService(config);
  try {
    await assert.rejects(
      auth.login(request(), response(), { username: 'someone', password: 'a-strong-local-password' }),
      /用户名或密码错误/
    );
    await assert.rejects(
      auth.login(request(), response(), { username: 'admin', password: 'wrong' }),
      /用户名或密码错误/
    );
  } finally {
    auth.close();
  }
});

test('Sub2API SSO verifies an administrator and only retains the exchanged local session', async () => {
  const accessToken = jwt({ sub: '42', role: 'admin', exp: Math.floor(Date.now() / 1000) + 3600 });
  const runtimeTokens = [];
  const auth = new AuthService({
    ...config,
    authMode: 'sub2api',
    sub2apiBaseUrl: 'https://sub2api.example.test',
    sub2apiPublicUrl: 'https://sub2api.example.test',
    sub2apiRequestTimeoutMs: 1000
  }, {
    fetchImpl: async (url, options) => {
      assert.equal(String(url), 'https://sub2api.example.test/api/v1/auth/me');
      assert.equal(options.headers.authorization, `Bearer ${accessToken}`);
      return new Response(JSON.stringify({ code: 0, data: { id: 42, username: 'owner', role: 'admin' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    },
    onAdminToken: (token) => runtimeTokens.push(token)
  });
  try {
    const res = response();
    const session = await auth.sso(request({ 'x-forwarded-proto': 'https' }), res, accessToken);
    assert.equal(session.user.name, 'owner');
    assert.equal(session.authentication.source, 'sso');
    assert.equal(runtimeTokens[0], accessToken);
    assert.ok(!JSON.stringify(session).includes(accessToken));
    assert.match(res.headers.get('set-cookie').join('\n'), /Partitioned/);
  } finally {
    auth.close();
  }
});

test('Sub2API SSO rejects a non-administrator', async () => {
  const auth = new AuthService({
    ...config,
    authMode: 'sub2api',
    sub2apiBaseUrl: 'https://sub2api.example.test',
    sub2apiRequestTimeoutMs: 1000
  }, {
    fetchImpl: async () => new Response(JSON.stringify({
      code: 0, data: { id: 7, username: 'member', role: 'user' }
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  });
  try {
    await assert.rejects(
      auth.sso(request(), response(), jwt({ sub: '7', role: 'user', exp: Math.floor(Date.now() / 1000) + 3600 })),
      (error) => error.code === 'ADMIN_REQUIRED'
    );
  } finally {
    auth.close();
  }
});

test('cookie parser tolerates malformed encodings', () => {
  assert.deepEqual(parseCookies('a=1; broken=%E0%A4%A; oc_session=abc'), {
    a: '1', broken: '%E0%A4%A', oc_session: 'abc'
  });
});
