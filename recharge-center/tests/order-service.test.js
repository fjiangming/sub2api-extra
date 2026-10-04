'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { OrderService } = require('../src/order-service');
const { createTestContext } = require('./helpers');

const user = { id: 42, emailMasked: 'al***@example.com', role: 'user' };
const secondUser = { id: 43, emailMasked: 'bo***@example.com', role: 'user' };
const adminSession = {
  user: { id: 1, role: 'admin' },
  upstreamToken: 'admin-token',
  client: { ip: '203.0.113.10', userAgent: 'test-agent' }
};
const tradeNo = '2026100212345678901234567890';

function successRedeem(input) {
  return {
    redeem_code: {
      code: input.code,
      type: 'balance',
      value: input.value,
      status: 'used',
      used_by: input.userId
    }
  };
}

test('payment evidence is HMAC-only and a matching ledger entry fulfills once', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const calls = [];
  const sub2api = {
    async createAndRedeem(token, input, client) {
      calls.push({ token, input, client });
      return successRedeem(input);
    }
  };
  const service = new OrderService({ db: context.db, config: context.config, sub2api });
  const order = service.create(user, 50, { requestId: 'create-1', ip: '203.0.113.20' });
  assert.equal(order.payableAmount, '50.00');
  assert.equal(order.creditAmount, order.payableAmount);

  const reported = service.reportPayment(order.id, user, tradeNo, { requestId: 'report-1' });
  assert.equal(reported.status, 'payment_reported');
  assert.equal(reported.tradeLast6, tradeNo.slice(-6));
  const stored = context.db.prepare('SELECT * FROM recharge_orders WHERE id = ?').get(order.id);
  assert.notEqual(stored.trade_hash, tradeNo);
  assert.equal(JSON.stringify(stored).includes(tradeNo), false);
  assert.match(stored.redeem_code, /^sealed:v1:/);

  await assert.rejects(
    service.confirm(order.id, adminSession, {
      paidAmount: order.payableAmount,
      paidAt: order.createdAt,
      tradeNo: '2026100299999999999999999999',
      acknowledge: true
    }),
    { code: 'PAYMENT_TRADE_MISMATCH' }
  );
  assert.equal(calls.length, 0);
  const failedAudit = context.db.prepare(`
    SELECT metadata_json FROM audit_events
    WHERE order_id = ? AND event_type = 'PAYMENT_VERIFICATION_FAILED'
  `).get(order.id);
  assert.equal(JSON.parse(failedAudit.metadata_json).reason, 'trade_number_mismatch');

  const completed = await service.confirm(order.id, adminSession, {
    paidAmount: order.payableAmount,
    paidAt: order.createdAt,
    tradeNo,
    acknowledge: true
  });
  assert.equal(completed.status, 'completed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.userId, user.id);
  assert.equal(calls[0].input.value, Number(order.creditAmount));
  assert.equal(stored.redeem_code.includes(calls[0].input.code), false);
  assert.match(calls[0].input.notes, new RegExp(order.orderNo));
  assert.equal(calls[0].input.notes.includes(tradeNo), false);

  const replay = await service.confirm(order.id, adminSession, {
    paidAmount: order.payableAmount,
    paidAt: order.createdAt,
    tradeNo,
    acknowledge: true
  });
  assert.equal(replay.status, 'completed');
  assert.equal(calls.length, 1);
});

test('ambiguous upstream failure stops for attention and retries with the same identity', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const calls = [];
  const sub2api = {
    async createAndRedeem(_token, input) {
      calls.push(input);
      if (calls.length === 1) {
        const error = new Error('timeout carrying 2026100211111111111111111111');
        error.code = 'SUB2API_TIMEOUT';
        throw error;
      }
      return successRedeem(input);
    }
  };
  const service = new OrderService({ db: context.db, config: context.config, sub2api });
  const order = service.create(user, 10);
  service.reportPayment(order.id, user, tradeNo);
  await assert.rejects(service.confirm(order.id, adminSession, {
    paidAmount: order.payableAmount, paidAt: order.createdAt, tradeNo, acknowledge: true
  }), { code: 'FULFILLMENT_NEEDS_ATTENTION' });
  const attention = context.db.prepare('SELECT * FROM recharge_orders WHERE id = ?').get(order.id);
  assert.equal(attention.status, 'needs_attention');
  assert.equal(attention.last_error_message.includes('2026100211111111111111111111'), false);

  const completed = await service.retry(order.id, adminSession);
  assert.equal(completed.status, 'completed');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].code, calls[1].code);
  assert.notEqual(calls[0].idempotencyKey, calls[1].idempotencyKey);
  assert.match(calls[0].idempotencyKey, /-1$/);
  assert.match(calls[1].idempotencyKey, /-2$/);
});

test('a historical payment outside the order window cannot be credited', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  let calls = 0;
  const service = new OrderService({
    db: context.db,
    config: context.config,
    sub2api: { async createAndRedeem() { calls += 1; } }
  });
  const order = service.create(user, 10);
  service.reportPayment(order.id, user, tradeNo);
  const historical = new Date(Date.parse(order.createdAt) - 1000).toISOString();
  await assert.rejects(service.confirm(order.id, adminSession, {
    paidAmount: order.payableAmount,
    paidAt: historical,
    tradeNo,
    acknowledge: true
  }), { code: 'PAYMENT_OUTSIDE_ORDER_WINDOW' });
  assert.equal(calls, 0);
  const row = context.db.prepare('SELECT status, alipay_paid_at FROM recharge_orders WHERE id = ?').get(order.id);
  assert.equal(row.status, 'payment_reported');
  assert.equal(row.alipay_paid_at, null);
  const audit = context.db.prepare(`
    SELECT metadata_json FROM audit_events
    WHERE order_id = ? AND event_type = 'PAYMENT_VERIFICATION_FAILED'
    ORDER BY id DESC LIMIT 1
  `).get(order.id);
  assert.equal(JSON.parse(audit.metadata_json).reason, 'payment_outside_window');
});

test('an unverified Sub2API success response remains in needs_attention', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const service = new OrderService({
    db: context.db,
    config: context.config,
    sub2api: {
      async createAndRedeem(_token, input) {
        return { redeem_code: { ...successRedeem(input).redeem_code, code: 'unexpected-code' } };
      }
    }
  });
  const order = service.create(user, 50);
  service.reportPayment(order.id, user, tradeNo);
  await assert.rejects(service.confirm(order.id, adminSession, {
    paidAmount: order.payableAmount,
    paidAt: order.createdAt,
    tradeNo,
    acknowledge: true
  }), { code: 'FULFILLMENT_NEEDS_ATTENTION' });
  const row = context.db.prepare('SELECT status, last_error_code FROM recharge_orders WHERE id = ?').get(order.id);
  assert.equal(row.status, 'needs_attention');
  assert.equal(row.last_error_code, 'SUB2API_FULFILLMENT_UNVERIFIED');
});

test('a stale fulfillment attempt cannot overwrite a newer retry', async (t) => {
  const context = createTestContext({ fulfillmentLeaseMinutes: 5 });
  t.after(() => context.cleanup());
  let now = new Date('2026-10-02T00:00:00.000Z');
  const calls = [];
  const pending = [];
  const sub2api = {
    createAndRedeem(_token, input) {
      calls.push(input);
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    }
  };
  const service = new OrderService({ db: context.db, config: context.config, sub2api, clock: () => now });
  const order = service.create(user, 10);
  service.reportPayment(order.id, user, tradeNo);
  const first = service.confirm(order.id, adminSession, {
    paidAmount: order.payableAmount,
    paidAt: order.createdAt,
    tradeNo,
    acknowledge: true
  });
  assert.equal(calls.length, 1);

  now = new Date('2026-10-02T00:06:00.000Z');
  const second = service.retry(order.id, adminSession);
  assert.equal(calls.length, 2);
  const timeout = new Error('first request timed out');
  timeout.code = 'SUB2API_TIMEOUT';
  pending[0].reject(timeout);
  await assert.rejects(first, { code: 'FULFILLMENT_ATTEMPT_SUPERSEDED' });
  const duringRetry = context.db.prepare('SELECT status, fulfillment_attempts FROM recharge_orders WHERE id = ?').get(order.id);
  assert.deepEqual(duringRetry, { status: 'fulfilling', fulfillment_attempts: 2 });

  pending[1].resolve(successRedeem(calls[1]));
  const completed = await second;
  assert.equal(completed.status, 'completed');
});

test('one Alipay transaction cannot be reported against two orders', (t) => {
  const context = createTestContext({ maxActiveOrders: 2 });
  t.after(() => context.cleanup());
  const service = new OrderService({ db: context.db, config: context.config, sub2api: {} });
  const first = service.create(user, 10);
  const second = service.create(secondUser, 50);
  service.reportPayment(first.id, user, tradeNo);
  assert.throws(() => service.reportPayment(second.id, secondUser, tradeNo), { code: 'TRADE_ALREADY_REPORTED' });
});

test('different users can hold orders for the same exact amount', (t) => {
  const context = createTestContext({ maxActiveOrders: 2 });
  t.after(() => context.cleanup());
  const service = new OrderService({ db: context.db, config: context.config, sub2api: {} });
  const first = service.create(user, 50);
  const second = service.create(secondUser, 50);
  assert.equal(first.payableAmount, '50.00');
  assert.equal(second.payableAmount, '50.00');
  assert.notEqual(first.id, second.id);
});

test('custom amounts keep two decimal places and credit exactly what was paid', (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const service = new OrderService({ db: context.db, config: context.config, sub2api: {} });
  const order = service.create(user, '37.25');
  assert.equal(order.payableAmount, '37.25');
  assert.equal(order.creditAmount, '37.25');
});

test('expired unpaid orders release the active-order slot and cannot accept evidence', (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  let now = new Date('2026-10-02T00:00:00.000Z');
  const service = new OrderService({ db: context.db, config: context.config, sub2api: {}, clock: () => now });
  const first = service.create(user, 10);
  now = new Date('2026-10-02T00:21:00.000Z');
  assert.throws(() => service.reportPayment(first.id, user, tradeNo), { code: 'ORDER_EXPIRED' });
  const second = service.create(user, 10);
  assert.notEqual(first.id, second.id);
});
