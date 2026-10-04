'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Sub2ApiClient, readJsonLimited } = require('../src/sub2api-client');

test('Sub2API fulfillment forwards the verified client context and idempotency key', async () => {
  let captured;
  const config = {
    sub2apiBaseUrl: 'https://api.example.com',
    sub2apiRequestTimeoutMs: 1000,
    forwardClientFingerprint: true
  };
  const client = new Sub2ApiClient(config, {
    fetch: async (url, options) => {
      captured = { url: String(url), options };
      return new Response(JSON.stringify({ code: 0, data: { redeem_code: { code: 'fixed-code' } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });
  const result = await client.createAndRedeem('admin-token', {
    idempotencyKey: 'recharge-center-order-1-1',
    code: 'fixed-code',
    value: 50.37,
    userId: 42,
    notes: 'test order'
  }, { ip: '203.0.113.10', userAgent: 'verified-browser' });

  assert.equal(captured.url, 'https://api.example.com/api/v1/admin/redeem-codes/create-and-redeem');
  assert.equal(captured.options.headers.Authorization, 'Bearer admin-token');
  assert.equal(captured.options.headers['Idempotency-Key'], 'recharge-center-order-1-1');
  assert.equal(captured.options.headers['X-Forwarded-For'], '203.0.113.10');
  assert.equal(captured.options.headers['X-Real-IP'], '203.0.113.10');
  assert.equal(captured.options.headers['User-Agent'], 'verified-browser');
  assert.deepEqual(JSON.parse(captured.options.body), {
    code: 'fixed-code', type: 'balance', value: 50.37, user_id: 42, notes: 'test order'
  });
  assert.deepEqual(result, { redeem_code: { code: 'fixed-code' } });
});

test('Sub2API responses are rejected before reading an oversized body', async () => {
  const response = new Response('{"data":{}}', {
    headers: { 'content-length': String(1024 * 1024 + 1), 'content-type': 'application/json' }
  });
  await assert.rejects(readJsonLimited(response), { code: 'SUB2API_RESPONSE_TOO_LARGE' });
});

test('automatic fulfillment uses only the dedicated Admin API key', async () => {
  let headers;
  const client = new Sub2ApiClient({
    sub2apiBaseUrl: 'https://api.example.com',
    sub2apiRequestTimeoutMs: 1000,
    sub2apiAdminApiKey: 'admin-api-key-0123456789',
    forwardClientFingerprint: true
  }, {
    fetch: async (_url, options) => {
      headers = options.headers;
      return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
    }
  });
  await client.createAndRedeemWithAdminKey({
    idempotencyKey: 'automatic-order-1', code: 'fixed-code', value: 10, userId: 42, notes: 'auto'
  });
  assert.equal(headers['X-API-Key'], 'admin-api-key-0123456789');
  assert.equal(headers.Authorization, undefined);
  assert.equal(headers['X-Forwarded-For'], undefined);
});

test('official payment client uses only authenticated native payment endpoints', async () => {
  const requests = [];
  const client = new Sub2ApiClient({
    sub2apiBaseUrl: 'https://api.example.com',
    sub2apiRequestTimeoutMs: 1000,
    forwardClientFingerprint: false
  }, {
    fetch: async (url, options) => {
      requests.push({ url: String(url), options });
      return new Response(JSON.stringify({ code: 0, data: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  await client.createPaymentOrder('user-token', { amount: 25.5, returnUrl: 'https://pay.example.com' }, {});
  await client.verifyPaymentOrder('user-token', 'sub2_20261002AbCd1234', {});
  await client.cancelPaymentOrder('user-token', 101, {});

  assert.equal(requests[0].url, 'https://api.example.com/api/v1/payment/orders');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    amount: 25.5,
    payment_type: 'alipay',
    payment_source: 'official_alipay',
    order_type: 'balance',
    return_url: 'https://pay.example.com',
    is_mobile: false
  });
  assert.equal(requests[1].url, 'https://api.example.com/api/v1/payment/orders/verify');
  assert.deepEqual(JSON.parse(requests[1].options.body), { out_trade_no: 'sub2_20261002AbCd1234' });
  assert.equal(requests[2].url, 'https://api.example.com/api/v1/payment/orders/101/cancel');
  assert.ok(requests.every((request) => request.options.headers.Authorization === 'Bearer user-token'));
});
