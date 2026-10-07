'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime } = require('../src/server');

test('static accountlog HTTP mode is poller-gated and exposes only a short-lived relay', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recharge-accountlog-http-'));
  let healthy = false;
  const poller = {
    started: false,
    start() { this.started = true; },
    close() {},
    status() {
      return {
        required: true,
        healthy,
        running: false,
        lastSuccessAt: healthy ? new Date().toISOString() : null,
        lastErrorCode: healthy ? null : 'STARTING',
        consecutiveFailures: healthy ? 0 : 1
      };
    },
    assertReady() {
      if (!healthy) {
        const error = new Error('not ready');
        error.code = 'ACCOUNTLOG_POLLER_NOT_READY';
        error.status = 503;
        throw error;
      }
    }
  };
  const env = {
    NODE_ENV: 'test',
    RECHARGE_CENTER_PAYMENT_MODE: 'personal_accountlog_static',
    RECHARGE_CENTER_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
    RECHARGE_CENTER_DATA_DIR: directory,
    RECHARGE_CENTER_DATABASE: path.join(directory, 'http.db'),
    RECHARGE_CENTER_PUBLIC_URL: 'https://pay.example.test',
    RECHARGE_CENTER_PASSWORD_LOGIN_ENABLED: 'false',
    RECHARGE_CENTER_ALIPAY_STATIC_QR_URL: 'https://qr.alipay.com/fkxSTATICCODE123456',
    RECHARGE_CENTER_ALIPAY_APP_ID: '2026100700000001',
    RECHARGE_CENTER_ALIPAY_APP_PRIVATE_KEY_PATH: path.join(directory, 'unused-private.pem'),
    RECHARGE_CENTER_ALIPAY_PUBLIC_KEY_PATH: path.join(directory, 'unused-public.pem'),
    SUB2API_BASE_URL: 'http://127.0.0.1:8080',
    SUB2API_ADMIN_API_KEY: 'admin-api-key-0123456789',
    RECHARGE_CENTER_ALERT_CHANNELS: 'email',
    RECHARGE_CENTER_SMTP_HOST: 'smtp.mail.test',
    RECHARGE_CENTER_SMTP_USER: 'recharge-alerts',
    RECHARGE_CENTER_SMTP_PASSWORD: 'smtp-password-0123456789abcdef',
    RECHARGE_CENTER_SMTP_FROM: 'recharge-alerts@mail.test',
    RECHARGE_CENTER_ALERT_EMAIL_TO: 'ops@mail.test'
  };
  const runtime = createRuntime(env, {
    projectRoot: path.resolve(__dirname, '..'),
    accountLogClient: {},
    accountLogPoller: poller,
    alerts: { async send() {} },
    sub2api: {
      async getCurrentUser() {
        return { id: 42, email: 'alice@example.com', username: 'alice', role: 'user', status: 'active' };
      }
    }
  });
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const origin = env.RECHARGE_CENTER_PUBLIC_URL;
  assert.equal(poller.started, true);
  assert.equal((await fetch(`${baseUrl}/readyz`)).status, 503);

  healthy = true;
  const ready = await fetch(`${baseUrl}/readyz`);
  assert.equal(ready.status, 200);
  assert.equal((await ready.json()).accountLog.healthy, true);

  const login = await fetch(`${baseUrl}/api/auth/sso`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'test-browser', origin },
    body: JSON.stringify({ token: 'valid-user-token-1234567890' })
  });
  assert.equal(login.status, 200);
  const session = await login.json();
  const cookie = login.headers.get('set-cookie').match(/rc_session=[^;]+/)[0];
  const created = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: {
      cookie,
      origin,
      'content-type': 'application/json',
      'user-agent': 'test-browser',
      'x-csrf-token': session.csrfToken
    },
    body: JSON.stringify({ amount: '12.34' })
  });
  assert.equal(created.status, 201);
  const order = await created.json();
  assert.equal(order.payableAmount, '12.34');
  assert.equal(order.qrAvailable, true);
  assert.equal(order.payUrl, `${origin}/pay/${order.orderNo}`);
  assert.equal(JSON.stringify(order).includes(env.RECHARGE_CENTER_ALIPAY_STATIC_QR_URL), false);

  const qr = await fetch(`${baseUrl}/api/orders/${order.id}/qr`, {
    headers: { cookie, 'user-agent': 'test-browser' }
  });
  assert.equal(qr.status, 200);
  assert.equal(qr.headers.get('content-type'), 'image/png');
  assert.ok((await qr.arrayBuffer()).byteLength > 500);

  const relay = await fetch(`${baseUrl}/pay/${order.orderNo}`, { redirect: 'manual' });
  assert.equal(relay.status, 303);
  assert.equal(relay.headers.get('location'), env.RECHARGE_CENTER_ALIPAY_STATIC_QR_URL);
  assert.equal(relay.headers.get('cache-control').includes('no-store'), true);
  assert.equal(relay.headers.get('referrer-policy'), 'no-referrer');
  const relayBody = await relay.text();
  assert.equal(relayBody.includes(order.userEmailMasked), false);
  assert.equal(relayBody.includes(order.payableAmount), false);

  const unknown = await fetch(`${baseUrl}/pay/RC-261007-${'A'.repeat(32)}`, { redirect: 'manual' });
  assert.equal(unknown.status, 404);
});
