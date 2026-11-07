'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');
const { publicOrigins } = require('../src/public-origins');

const env = {
  NODE_ENV: 'test',
  SUB2API_BASE_URL: 'http://127.0.0.1:8080',
  SUB2API_PUBLIC_URL: 'https://old.example',
  SUB2API_PUBLIC_URLS: 'https://new.example/, https://www.new.example,https://old.example',
  RECHARGE_CENTER_PAYMENT_MODE: 'personal_manual',
  RECHARGE_CENTER_SECRET: 'test-domain-secret-0123456789abcdef0123456789',
  RECHARGE_CENTER_PUBLIC_URL: 'https://pay.old.example',
  RECHARGE_CENTER_PUBLIC_URLS: 'https://pay.new.example',
};

test('public domain aliases preserve the canonical URL and internal API endpoint', () => {
  const config = loadConfig(env);
  assert.equal(config.sub2apiBaseUrl, 'http://127.0.0.1:8080');
  assert.equal(config.sub2apiPublicUrl, 'https://old.example');
  assert.deepEqual(config.sub2apiPublicOrigins, ['https://old.example', 'https://new.example', 'https://www.new.example']);
  assert.deepEqual(loadConfig({ ...env, SUB2API_PUBLIC_URLS: '' }).sub2apiPublicOrigins, ['https://old.example']);
});

test('domain aliases reject wildcard grants, credentials, paths, queries and insecure production origins', () => {
  for (const value of ['https://*.example', 'https://user:pass@example.com', 'https://new.example/path',
    'https://new.example?token=secret', 'https://new.example/#fragment', 'javascript:alert(1)', 'https://new.\nexample']) {
    assert.throws(() => loadConfig({ ...env, SUB2API_PUBLIC_URLS: value }), /SUB2API_PUBLIC_URLS/);
  }
  assert.throws(() => publicOrigins('https://old.example', 'http://new.example', 'SUB2API_PUBLIC_URLS', true), /HTTPS/);
  assert.deepEqual(publicOrigins(null, '', 'SUB2API_PUBLIC_URLS'), []);
});


const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRuntime } = require('../src/server');

test('both recharge domains exchange SSO, retain CSRF protection and reject unlisted origins', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recharge-domains-'));
  let authCalls = 0;
  const runtime = createRuntime({
    ...env, RECHARGE_CENTER_DATA_DIR: directory,
    RECHARGE_CENTER_DATABASE: path.join(directory, 'test.db')
  }, { sub2api: { async getCurrentUser() {
    authCalls++;
    return { id: 42, email: 'reader@example.com', role: 'user', status: 'active' };
  } }, projectRoot: path.resolve(__dirname, '..') });
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const origin of ['https://pay.old.example', 'https://pay.new.example']) {
    const response = await fetch(`${base}/api/auth/sso`, {
      method: 'POST', headers: { origin, host: new URL(origin).host, 'content-type': 'application/json', 'user-agent': 'domain-test' },
      body: JSON.stringify({ token: 'valid-domain-test-token-1234567890' })
    });
    assert.equal(response.status, 200);
    const csp = response.headers.get('content-security-policy');
    assert.match(csp, /frame-ancestors 'self' https:\/\/old\.example https:\/\/new\.example https:\/\/www\.new\.example/);
    assert.doesNotMatch(response.headers.get('set-cookie'), /;\s*Domain=/i);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const session = await response.json();
    const headers = { origin, host: new URL(origin).host, cookie, 'content-type': 'application/json', 'user-agent': 'domain-test' };
    const blocked = await fetch(`${base}/api/orders`, { method: 'POST', headers, body: JSON.stringify({ amount: 10 }) });
    assert.equal(blocked.status, 403);
    const allowed = await fetch(`${base}/api/auth/logout`, {
      method: 'POST', headers: { ...headers, 'x-csrf-token': session.csrfToken }, body: '{}'
    });
    assert.equal(allowed.status, 204);
  }
  const calls = authCalls;
  for (const origin of ['https://pay.new.example.evil.test', 'https://evil.test', 'null', '']) {
    const response = await fetch(`${base}/api/auth/sso`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'valid-domain-test-token-1234567890' })
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'ORIGIN_REJECTED');
  }
  assert.equal(authCalls, calls);
  assert.equal(runtime.db.prepare('SELECT count(*) AS n FROM recharge_orders').get().n, 0);
});

test('recharge aliases validate independently and QR relays only accept listed domains', async () => {
  const { QrService } = require('../src/qr-service');
  assert.throws(() => loadConfig({ ...env, RECHARGE_CENTER_PUBLIC_URLS: 'https://*.example' }), /RECHARGE_CENTER_PUBLIC_URLS/);
  const config = { ...loadConfig(env), accountLogStaticMode: true, automaticPersonalMode: true };
  const qr = new QrService(config);
  const orderPath = `/pay/RC-261107-${'A'.repeat(32)}`;
  for (const origin of config.publicOrigins) {
    let image;
    await qr.send({ set() {}, end(value) { image = value; } }, { relayUrl: origin + orderPath });
    assert.deepEqual([...image.subarray(0, 4)], [137, 80, 78, 71]);
  }
  for (const url of [`https://evil.example${orderPath}`, `https://pay.new.example${orderPath}?token=secret`]) {
    await assert.rejects(qr.send({ set() {}, end() {} }, { relayUrl: url }), { code: 'PAYMENT_QR_UNAVAILABLE' });
  }
});
