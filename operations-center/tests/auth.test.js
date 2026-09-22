'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AuthService, parseCookies } = require('../src/auth');

const config = {
  env: 'production',
  adminUser: 'admin',
  adminPassword: 'a-strong-local-password',
  sessionTtlMinutes: 30,
  cookieSecure: true
};

test('local sessions use opaque ids and independent CSRF tokens', () => {
  const auth = new AuthService(config);
  try {
    const first = auth.login('admin', 'a-strong-local-password');
    const second = auth.login('admin', 'a-strong-local-password');
    assert.notEqual(first.id, second.id);
    assert.notEqual(first.csrfToken, second.csrfToken);
    assert.ok(first.id.length >= 40);
  } finally {
    auth.close();
  }
});

test('invalid credentials fail without revealing which field mismatched', () => {
  const auth = new AuthService(config);
  try {
    assert.throws(() => auth.login('someone', 'a-strong-local-password'), /用户名或密码错误/);
    assert.throws(() => auth.login('admin', 'wrong'), /用户名或密码错误/);
  } finally {
    auth.close();
  }
});

test('cookie parser tolerates malformed encodings', () => {
  assert.deepEqual(parseCookies('a=1; broken=%E0%A4%A; oc_session=abc'), {
    a: '1', broken: '%E0%A4%A', oc_session: 'abc'
  });
});
