'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { OfficialPaymentService, normalizeRemoteOrder } = require('../src/official-payment-service');
const { AppError } = require('../src/errors');
const { createTestContext } = require('./helpers');

const now = new Date('2026-10-02T04:00:00.000Z');

function createService(t, options) {
  const context = createTestContext();
  const service = new OfficialPaymentService({ ...options, db: context.db });
  t.after(() => { service.close(); context.cleanup(); });
  return service;
}

function config(overrides = {}) {
  return {
    minAmount: 1,
    maxAmount: 1000,
    quickAmounts: [10, 20, 50, 100, 200, 500, 1000],
    maxActiveOrders: 1,
    officialPollSeconds: 5,
    officialPollConcurrency: 2,
    officialAlipayInstanceIds: ['7'],
    publicUrl: 'https://pay.example.com',
    ...overrides
  };
}

function auth(overrides = {}) {
  return {
    user: { id: 42 },
    upstreamToken: 'short-lived-user-token',
    client: { ip: '203.0.113.10', userAgent: 'test-browser' },
    expiresAt: now.getTime() + 3600000,
    ...overrides
  };
}

function checkout(overrides = {}) {
  return {
    methods: {
      alipay: { currency: 'CNY', single_min: 1, single_max: 1000 }
    },
    balance_disabled: false,
    balance_recharge_multiplier: 1,
    recharge_fee_rate: 0,
    ...overrides
  };
}

function remoteOrder(overrides = {}) {
  return {
    id: 101,
    user_id: 42,
    amount: 37.25,
    pay_amount: 37.25,
    fee_rate: 0,
    currency: 'CNY',
    payment_type: 'alipay',
    out_trade_no: 'sub2_20261002AbCd1234',
    status: 'PENDING',
    order_type: 'balance',
    provider_instance_id: '7',
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 20 * 60000).toISOString(),
    ...overrides
  };
}

function createdOrder(overrides = {}) {
  return {
    order_id: 101,
    amount: 37.25,
    pay_amount: 37.25,
    fee_rate: 0,
    currency: 'CNY',
    payment_type: 'alipay',
    out_trade_no: 'sub2_20261002AbCd1234',
    status: 'PENDING',
    expires_at: new Date(now.getTime() + 20 * 60000).toISOString(),
    qr_code: 'https://qr.alipay.com/precreate-token',
    ...overrides
  };
}

test('official Alipay creates an exact-value dynamic order and polling completes it', async (t) => {
  const calls = { verify: 0 };
  const sub2api = {
    getPaymentCheckoutInfo: async () => checkout(),
    getPaymentOrders: async () => ({ items: [] }),
    createPaymentOrder: async (token, input, client) => {
      assert.equal(token, 'short-lived-user-token');
      assert.deepEqual(input, { amount: 37.25, returnUrl: '', isMobile: false });
      assert.equal(client.ip, '203.0.113.10');
      return createdOrder();
    },
    getPaymentOrder: async () => remoteOrder(),
    verifyPaymentOrder: async (token, outTradeNo) => {
      calls.verify += 1;
      assert.equal(token, 'short-lived-user-token');
      assert.equal(outTradeNo, 'sub2_20261002AbCd1234');
      return remoteOrder({ status: 'COMPLETED', paid_at: now.toISOString(), completed_at: now.toISOString() });
    }
  };
  const service = createService(t, { config: config(), sub2api, clock: () => now });

  const order = await service.create(auth(), 'session-1', '37.25');
  assert.equal(order.payableAmount, '37.25');
  assert.equal(order.creditAmount, '37.25');
  assert.equal(order.status, 'awaiting_payment');
  assert.equal(order.qrAvailable, true);

  const response = {
    headers: null,
    body: null,
    set(value) { this.headers = value; },
    end(value) { this.body = value; }
  };
  await service.sendQr(response, auth(), order.id);
  assert.equal(response.headers['Content-Type'], 'image/png');
  assert.deepEqual(response.body.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

  await service.pollNow();
  assert.equal(calls.verify, 1);
  assert.equal(service.tracked.size, 0);
  assert.equal(service.paymentDetails.size, 0);
});

test('official mode refuses multiplier or fee settings that would change the target amount', async (t) => {
  let createCalls = 0;
  const service = createService(t, {
    config: config(),
    sub2api: {
      getPaymentCheckoutInfo: async () => checkout({ balance_recharge_multiplier: 0.8, recharge_fee_rate: 1 }),
      createPaymentOrder: async () => { createCalls += 1; }
    },
    clock: () => now
  });

  await assert.rejects(service.create(auth(), 'session-1', 50), { code: 'EXACT_AMOUNT_POLICY_REQUIRED' });
  assert.equal(createCalls, 0);
});

test('a raced amount mismatch is hidden and cancelled before payment details are exposed', async (t) => {
  const cancelled = [];
  const service = createService(t, {
    config: config(),
    sub2api: {
      getPaymentCheckoutInfo: async () => checkout(),
      getPaymentOrders: async () => ({ items: [] }),
      createPaymentOrder: async () => createdOrder({ pay_amount: 37.26 }),
      getPaymentOrder: async () => remoteOrder({ pay_amount: 37.26 }),
      cancelPaymentOrder: async (_token, id) => cancelled.push(id)
    },
    clock: () => now
  });

  await assert.rejects(service.create(auth(), 'session-1', '37.25'), { code: 'PAYMENT_AMOUNT_POLICY_CHANGED' });
  assert.deepEqual(cancelled, [101]);
  assert.equal(service.paymentDetails.size, 0);
});

test('remote order ownership is verified before exposing financial data', () => {
  assert.throws(
    () => normalizeRemoteOrder(remoteOrder({ user_id: 99 }), 42),
    { code: 'SUB2API_PAYMENT_RESPONSE_INVALID' }
  );
});

test('non-Alipay QR payloads are cancelled before reaching the browser', async (t) => {
  const cancelled = [];
  const service = createService(t, {
    config: config(),
    sub2api: {
      getPaymentCheckoutInfo: async () => checkout(),
      getPaymentOrders: async () => ({ items: [] }),
      createPaymentOrder: async () => createdOrder({ qr_code: 'https://payments.example.test/phishing' }),
      getPaymentOrder: async () => remoteOrder(),
      cancelPaymentOrder: async (_token, id) => cancelled.push(id)
    },
    clock: () => now
  });

  await assert.rejects(service.create(auth(), 'session-1', '37.25'), { code: 'SUB2API_PAYMENT_RESPONSE_INVALID' });
  assert.deepEqual(cancelled, [101]);
});

test('official orders stop at ten creations including cancelled orders', async (t) => {
  let sequence = 100;
  const service = createService(t, {
    config: config(), clock: () => now,
    sub2api: {
      getPaymentCheckoutInfo: async () => checkout(),
      getPaymentOrders: async () => ({ items: [] }),
      createPaymentOrder: async () => createdOrder({ order_id: ++sequence }),
      getPaymentOrder: async (_token, id) => remoteOrder({ id, status: 'CANCELLED' }),
      cancelPaymentOrder: async () => {}
    }
  });
  for (let index = 0; index < 10; index += 1) {
    await service.create(auth(), 'session-1', '37.25');
    assert.equal(service.dailyOrderLimit.status(42).remaining, 9 - index);
  }
  await assert.rejects(service.create(auth(), 'session-2', '37.25'), { code: 'DAILY_ORDER_LIMIT_REACHED' });
  assert.equal(sequence, 110);
});

test('official validation and explicit rejections release quota while unknown remote results retain it', async (t) => {
  let failure = new AppError('SUB2API_REQUEST_FAILED', 'rejected', { status: 502, details: { remoteStatus: 400 } });
  const service = createService(t, {
    config: config(), clock: () => now,
    sub2api: {
      getPaymentCheckoutInfo: async () => checkout(),
      getPaymentOrders: async () => ({ items: [] }),
      createPaymentOrder: async () => { throw failure; }
    }
  });
  await assert.rejects(service.create(auth(), 'session-1', '0.01'));
  assert.equal(service.dailyOrderLimit.status(42).used, 0);
  await assert.rejects(service.create(auth(), 'session-1', '37.25'), { code: 'SUB2API_REQUEST_FAILED' });
  assert.equal(service.dailyOrderLimit.status(42).used, 0);
  failure = new AppError('SUB2API_TIMEOUT', 'unknown', { status: 504 });
  await assert.rejects(service.create(auth(), 'session-1', '37.25'), { code: 'SUB2API_TIMEOUT' });
  assert.equal(service.dailyOrderLimit.status(42).used, 1);
  failure = new AppError('SUB2API_REQUEST_FAILED', 'unknown', { status: 502, details: { remoteStatus: 500 } });
  await assert.rejects(service.create(auth(), 'session-1', '37.25'), { code: 'SUB2API_REQUEST_FAILED' });
  assert.equal(service.dailyOrderLimit.status(42).used, 2);
});
