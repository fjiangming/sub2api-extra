'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime } = require('../src/server');

test('large-recharge settings and Bark tests require admin, origin and CSRF without revealing the device key', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recharge-bark-http-'));
  const origin = 'https://pay.example.test';
  let sent = 0;
  const runtime = createRuntime({ NODE_ENV: 'test', RECHARGE_CENTER_PAYMENT_MODE: 'personal_manual',
    RECHARGE_CENTER_SECRET: 'test-secret-0123456789abcdef0123456789abcdef', RECHARGE_CENTER_DATA_DIR: directory,
    RECHARGE_CENTER_PUBLIC_URL: origin, SUB2API_BASE_URL: 'http://127.0.0.1:8080' }, {
    sub2api: { async getCurrentUser(token) { return { id: token.includes('admin') ? 1 : 2,
      email: 'operator@example.test', role: token.includes('admin') ? 'admin' : 'user', status: 'active' }; } },
    barkFetch: async () => { sent++; return Response.json({ code: 200 }); }
  });
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve)); runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const endpoint = `${base}/api/admin/large-recharge-alert`;
  const call = (url, method = 'GET', body, headers = {}) => fetch(url, { method,
    headers: { 'user-agent': 'bark-test-browser', 'content-type': 'application/json', origin, ...headers },
    ...(body == null ? {} : { body: JSON.stringify(body) }) });
  async function login(role) {
    const res = await call(`${base}/api/auth/sso`, 'POST', { token: `test-${role}-token-1234567890123456` });
    assert.equal(res.status, 200);
    const session = await res.json();
    return { cookie: res.headers.get('set-cookie').match(/rc_session=[^;]+/)[0], 'x-csrf-token': session.csrfToken };
  }
  const ordinary = await login('user');
  const admin = await login('admin');
  assert.equal((await call(endpoint)).status, 401);
  for (const [url, method, body] of [[endpoint, 'GET'], [endpoint, 'PUT', { enabled: false, threshold: '1000' }],
    [`${endpoint}/test`, 'POST', {}]]) {
    assert.equal((await call(url, method, body, ordinary)).status, 403);
  }
  assert.equal((await call(endpoint, 'PUT', { enabled: false, threshold: '1000' }, { cookie: admin.cookie })).status, 403);
  assert.equal((await call(endpoint, 'PUT', { enabled: false, threshold: '1000' }, { ...admin, origin: 'https://evil.example.test' })).status, 403);
  const key = 'http-test-bark-device-key-1234';
  const saved = await call(endpoint, 'PUT', { enabled: true, threshold: '800', deviceKey: key }, admin);
  assert.equal(saved.status, 200);
  const settings = await saved.json();
  assert.equal(settings.threshold, '800.00');
  assert.equal(settings.bark.configured, true);
  assert.equal(JSON.stringify(settings).includes(key), false);
  assert.equal((await call(endpoint, 'PUT', { enabled: true, threshold: '800', endpoint: 'http://169.254.169.254/push' }, admin)).status, 400);
  const tested = await call(`${endpoint}/test`, 'POST', {}, admin);
  assert.equal(tested.status, 200);
  assert.equal((await tested.json()).sent, true);
  assert.equal(sent, 1);
  const config = await call(`${base}/api/config`);
  assert.equal(JSON.stringify(await config.json()).includes('bark'), false);
  assert.equal(JSON.stringify(await (await call(endpoint, 'GET', undefined, admin)).json()).includes(key), false);
  for (let i = 0; i < 5; i++) await call(`${endpoint}/test`, 'POST', {}, admin);
  assert.equal((await call(`${endpoint}/test`, 'POST', {}, admin)).status, 429);
  assert.equal(sent, 5);
});
