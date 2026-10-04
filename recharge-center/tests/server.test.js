'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime } = require('../src/server');
const { listenerSignature } = require('../src/listener-service');

test('HTTP surface enforces authentication, CSRF, and security headers', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recharge-http-test-'));
  const env = {
    NODE_ENV: 'test',
    RECHARGE_CENTER_PAYMENT_MODE: 'personal_manual',
    RECHARGE_CENTER_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
    RECHARGE_CENTER_DATA_DIR: directory,
    RECHARGE_CENTER_DATABASE: path.join(directory, 'http.db'),
    RECHARGE_CENTER_PASSWORD_LOGIN_ENABLED: 'false',
    SUB2API_BASE_URL: 'http://127.0.0.1:8080'
  };
  const sub2api = {
    async getCurrentUser() {
      return { id: 42, email: 'alice@example.com', username: 'alice', role: 'user', status: 'active' };
    }
  };
  const runtime = createRuntime(env, { sub2api, projectRoot: path.resolve(__dirname, '..') });
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.match(health.headers.get('content-security-policy'), /object-src 'none'/);
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');

  const unauthorized = await fetch(`${baseUrl}/api/orders`);
  assert.equal(unauthorized.status, 401);

  const passwordLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'alice@example.com', password: 'not-sent-upstream' })
  });
  assert.equal(passwordLogin.status, 403);
  assert.equal((await passwordLogin.json()).error.code, 'PASSWORD_LOGIN_DISABLED');

  const login = await fetch(`${baseUrl}/api/auth/sso`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'test-browser' },
    body: JSON.stringify({ token: 'valid-user-token-1234567890' })
  });
  assert.equal(login.status, 200);
  const session = await login.json();
  assert.equal('sessionToken' in session, false);
  const cookie = login.headers.get('set-cookie').match(/rc_session=[^;]+/)[0];

  const noCsrf = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', 'user-agent': 'test-browser' },
    body: JSON.stringify({ amount: 10 })
  });
  assert.equal(noCsrf.status, 403);

  const created = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/json',
      'user-agent': 'test-browser',
      'x-csrf-token': session.csrfToken
    },
    body: JSON.stringify({ amount: 10 })
  });
  assert.equal(created.status, 201);
  const order = await created.json();
  assert.equal(order.status, 'awaiting_payment');

  const redirect = await fetch(`${baseUrl}/?token=valid-user-token-1234567890&theme=dark&src_url=https%3A%2F%2Fexample.invalid`, {
    redirect: 'manual',
    headers: { 'user-agent': 'test-browser' }
  });
  assert.equal(redirect.status, 303);
  assert.equal(redirect.headers.get('location'), '/?theme=dark');
  assert.equal(redirect.headers.get('location').includes('token'), false);
});

test('official HTTP mode serves dynamic QR orders and disables manual review', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recharge-official-http-test-'));
  const expiresAt = new Date(Date.now() + 20 * 60000).toISOString();
  const env = {
    NODE_ENV: 'test',
    RECHARGE_CENTER_PAYMENT_MODE: 'sub2api_official',
    RECHARGE_CENTER_OFFICIAL_ALIPAY_INSTANCE_IDS: '7',
    RECHARGE_CENTER_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
    RECHARGE_CENTER_DATA_DIR: directory,
    RECHARGE_CENTER_DATABASE: path.join(directory, 'http.db'),
    RECHARGE_CENTER_PASSWORD_LOGIN_ENABLED: 'false',
    SUB2API_BASE_URL: 'http://127.0.0.1:8080'
  };
  const sub2api = {
    async getCurrentUser() {
      return { id: 42, email: 'alice@example.com', username: 'alice', role: 'user', status: 'active' };
    },
    async getPaymentCheckoutInfo() {
      return {
        methods: { alipay: { currency: 'CNY', single_min: 1, single_max: 1000 } },
        balance_disabled: false,
        balance_recharge_multiplier: 1,
        recharge_fee_rate: 0
      };
    },
    async getPaymentOrders() { return { items: [] }; },
    async getPaymentOrder() {
      return {
        id: 101,
        user_id: 42,
        amount: 12.34,
        pay_amount: 12.34,
        fee_rate: 0,
        currency: 'CNY',
        payment_type: 'alipay',
        out_trade_no: 'sub2_20261002AbCd1234',
        status: 'PENDING',
        order_type: 'balance',
        provider_instance_id: '7',
        created_at: new Date().toISOString(),
        expires_at: expiresAt
      };
    },
    async createPaymentOrder(_token, input) {
      assert.equal(input.amount, 12.34);
      return {
        order_id: 101,
        amount: 12.34,
        pay_amount: 12.34,
        fee_rate: 0,
        currency: 'CNY',
        payment_type: 'alipay',
        out_trade_no: 'sub2_20261002AbCd1234',
        status: 'PENDING',
        expires_at: expiresAt,
        qr_code: 'https://qr.alipay.com/precreate-token'
      };
    }
  };
  const runtime = createRuntime(env, { sub2api, projectRoot: path.resolve(__dirname, '..') });
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const ready = await fetch(`${baseUrl}/readyz`);
  assert.equal(ready.status, 200);
  assert.equal((await ready.json()).paymentQr, 'dynamic');

  const login = await fetch(`${baseUrl}/api/auth/sso`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'test-browser' },
    body: JSON.stringify({ token: 'valid-user-token-1234567890' })
  });
  const session = await login.json();
  const cookie = login.headers.get('set-cookie').match(/rc_session=[^;]+/)[0];

  const checkoutResponse = await fetch(`${baseUrl}/api/checkout`, {
    headers: { cookie, 'user-agent': 'test-browser' }
  });
  const checkoutBody = await checkoutResponse.json();
  assert.equal(checkoutBody.automaticConfirmation, true);
  assert.equal(checkoutBody.balanceRechargeMultiplier, 1);

  const created = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/json',
      'user-agent': 'test-browser',
      'x-csrf-token': session.csrfToken
    },
    body: JSON.stringify({ amount: '12.34' })
  });
  assert.equal(created.status, 201);
  const order = await created.json();
  assert.equal(order.payableAmount, '12.34');
  assert.equal(order.creditAmount, '12.34');
  assert.equal(order.qrAvailable, true);
  assert.equal(JSON.stringify(order).includes('precreate-token'), false);

  const qr = await fetch(`${baseUrl}/api/orders/${order.id}/qr`, {
    headers: { cookie, 'user-agent': 'test-browser' }
  });
  assert.equal(qr.status, 200);
  assert.equal(qr.headers.get('content-type'), 'image/png');

  const manualReview = await fetch(`${baseUrl}/api/orders/${order.id}/report-payment`, {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/json',
      'user-agent': 'test-browser',
      'x-csrf-token': session.csrfToken
    },
    body: JSON.stringify({ tradeNo: '20261002123456789012345678' })
  });
  assert.equal(manualReview.status, 404);
  assert.equal((await manualReview.json()).error.code, 'MANUAL_PAYMENT_DISABLED');
});

test('personal transfer auto HTTP mode is heartbeat-gated and never exposes the automatic memo', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recharge-auto-http-test-'));
  const listenerSecret = 'listener-secret-0123456789abcdef0123456789';
  const env = {
    NODE_ENV: 'test',
    RECHARGE_CENTER_PAYMENT_MODE: 'personal_transfer_auto',
    RECHARGE_CENTER_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
    RECHARGE_CENTER_DATA_DIR: directory,
    RECHARGE_CENTER_DATABASE: path.join(directory, 'http.db'),
    RECHARGE_CENTER_PASSWORD_LOGIN_ENABLED: 'false',
    RECHARGE_CENTER_TRANSFER_QR_TEMPLATE: 'alipays://platformapi/startapp?appId=20000123&amount={amount}&memo={memo}',
    RECHARGE_CENTER_LISTENER_SECRET: listenerSecret,
    RECHARGE_CENTER_LISTENER_COLLECTOR_ID: 'collector-one',
    RECHARGE_CENTER_LISTENER_MAX_STALE_SECONDS: '30',
    RECHARGE_CENTER_ALIPAY_RECIPIENT_ID: '2088123456789012',
    SUB2API_BASE_URL: 'http://127.0.0.1:8080',
    SUB2API_ADMIN_API_KEY: 'admin-api-key-0123456789',
    RECHARGE_CENTER_ALERT_CHANNELS: 'email',
    RECHARGE_CENTER_SMTP_HOST: 'smtp.mail.test',
    RECHARGE_CENTER_SMTP_USER: 'recharge-alerts',
    RECHARGE_CENTER_SMTP_PASSWORD: 'smtp-password-0123456789abcdef',
    RECHARGE_CENTER_SMTP_FROM: 'recharge-alerts@mail.test',
    RECHARGE_CENTER_ALERT_EMAIL_TO: 'ops@mail.test'
  };
  const sub2api = {
    async getCurrentUser() {
      return { id: 42, email: 'alice@example.com', username: 'alice', role: 'user', status: 'active' };
    },
    async createAndRedeemWithAdminKey(input) {
      return {
        redeem_code: {
          code: input.code, type: 'balance', value: input.value, status: 'used', used_by: input.userId
        }
      };
    }
  };
  const runtime = createRuntime(env, {
    sub2api,
    alerts: { async send() {} },
    projectRoot: path.resolve(__dirname, '..')
  });
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let nonceCounter = 0;
  const signedPost = (pathname, payload, nonce = null) => {
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const requestNonce = nonce || `nonce-${String(++nonceCounter).padStart(20, '0')}`;
    return fetch(`${baseUrl}${pathname}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-recharge-timestamp': timestamp,
        'x-recharge-nonce': requestNonce,
        'x-recharge-signature': listenerSignature(listenerSecret, timestamp, requestNonce, Buffer.from(body))
      },
      body
    });
  };

  assert.equal((await fetch(`${baseUrl}/readyz`)).status, 503);
  const unsignedHeartbeat = await fetch(`${baseUrl}/api/listener/alipay/heartbeat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
  });
  assert.equal(unsignedHeartbeat.status, 401);
  const degradedHeartbeat = await signedPost('/api/listener/alipay/heartbeat', {
    collectorId: 'collector-one', version: 'test-1', ready: false, observedAt: new Date().toISOString()
  });
  assert.equal(degradedHeartbeat.status, 200);
  assert.equal((await fetch(`${baseUrl}/readyz`)).status, 503);
  const heartbeat = await signedPost('/api/listener/alipay/heartbeat', {
    collectorId: 'collector-one', version: 'test-1', ready: true, observedAt: new Date().toISOString()
  });
  assert.equal(heartbeat.status, 200);
  assert.equal((await fetch(`${baseUrl}/readyz`)).status, 200);

  const login = await fetch(`${baseUrl}/api/auth/sso`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'test-browser' },
    body: JSON.stringify({ token: 'valid-user-token-1234567890' })
  });
  const session = await login.json();
  const cookie = login.headers.get('set-cookie').match(/rc_session=[^;]+/)[0];
  const created = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/json',
      'user-agent': 'test-browser',
      'x-csrf-token': session.csrfToken
    },
    body: JSON.stringify({ amount: '12.34' })
  });
  assert.equal(created.status, 201);
  const order = await created.json();
  assert.equal(order.requestedAmount, '12.34');
  assert.equal(order.payableAmount, '12.34');
  assert.equal(JSON.stringify(order).includes('S2-'), false);

  const qr = await fetch(`${baseUrl}/api/orders/${order.id}/qr`, {
    headers: { cookie, 'user-agent': 'test-browser' }
  });
  assert.equal(qr.status, 200);
  assert.equal(qr.headers.get('content-type'), 'image/png');
  assert.ok((await qr.arrayBuffer()).byteLength > 500);

  const memo = runtime.orders.paymentQrData(order.id, { id: 42, role: 'user' }).memo;
  const eventBody = {
    collectorId: 'collector-one',
    eventId: 'evt-http-00000001',
    source: 'browser',
    evidenceType: 'ledger_detail',
    tradeNo: '2026100312345678901234567890',
    amount: order.payableAmount,
    paidAt: order.createdAt,
    memo,
    recipientId: '2088123456789012',
    direction: 'income',
    status: 'success'
  };
  const paid = await signedPost('/api/listener/alipay/events', eventBody);
  assert.equal(paid.status, 200);
  assert.equal((await paid.json()).status, 'completed');

  const finalOrder = await fetch(`${baseUrl}/api/orders/${order.id}`, {
    headers: { cookie, 'user-agent': 'test-browser' }
  });
  assert.equal((await finalOrder.json()).status, 'completed');
});
