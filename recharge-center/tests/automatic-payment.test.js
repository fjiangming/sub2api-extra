'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { OrderService } = require('../src/order-service');
const { createTestContext } = require('./helpers');

const recipientId = '2088123456789012';
const collectorId = 'alipay-ledger-collector';
const baseTime = new Date('2026-10-03T00:00:00.000Z');

function autoContext(overrides = {}) {
  return createTestContext({
    paymentMode: 'personal_transfer_auto',
    automaticPersonalMode: true,
    orderTtlMinutes: 3,
    autoReservationLimit: 100,
    alipayRecipientId: recipientId,
    listenerCollectorId: collectorId,
    listenerSignatureToleranceSeconds: 60,
    listenerMaxEventAgeSeconds: 600,
    maxActiveOrders: 1,
    ...overrides
  });
}

function user(id) {
  return { id, emailMasked: `u${id}***@example.com`, role: 'user' };
}

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

function paymentEvent(order, memo, overrides = {}) {
  return {
    eventId: `evt-${String(overrides.sequence || 1).padStart(8, '0')}`,
    source: 'browser',
    evidenceType: 'ledger_detail',
    tradeNo: `20261003${String(overrides.sequence || 1).padStart(20, '0')}`,
    amount: order.payableAmount,
    paidAt: order.createdAt,
    memo,
    recipientId,
    direction: 'income',
    status: 'success',
    ...overrides
  };
}

test('automatic orders keep exact amounts until a collision requires a globally reserved cent value', (t) => {
  const context = autoContext();
  t.after(() => context.cleanup());
  const service = new OrderService({ db: context.db, config: context.config, sub2api: {}, clock: () => baseTime });

  const first = service.create(user(1), '50.00');
  const second = service.create(user(2), '50.00');
  assert.equal(first.requestedAmount, '50.00');
  assert.equal(first.payableAmount, '50.00');
  assert.equal(first.amountAdjusted, false);
  assert.equal(second.requestedAmount, '50.00');
  assert.equal(second.payableAmount, '50.01');
  assert.equal(second.creditAmount, '50.01');
  assert.equal(second.amountAdjusted, true);

  const reservations = context.db.prepare(`
    SELECT payable_amount_minor FROM amount_reservations ORDER BY payable_amount_minor
  `).all().map((row) => row.payable_amount_minor);
  assert.deepEqual(reservations, [5000, 5001]);

  const memo = service.paymentQrData(first.id, user(1)).memo;
  const stored = context.db.prepare('SELECT * FROM recharge_orders WHERE id = ?').get(first.id);
  assert.match(memo, /^S2-[A-Za-z0-9_-]{16}$/);
  assert.notEqual(stored.payment_memo_hash, memo);
  assert.equal(stored.payment_memo_ciphertext.includes(memo), false);
  assert.equal(JSON.stringify(first).includes(memo), false);
});

test('automatic order capacity is capped at 100 live reservations', (t) => {
  const context = autoContext({ maxActiveOrders: 2 });
  t.after(() => context.cleanup());
  const service = new OrderService({ db: context.db, config: context.config, sub2api: {}, clock: () => baseTime });
  for (let index = 1; index <= 100; index += 1) {
    service.create(user(index), '10.00');
  }
  assert.throws(() => service.create(user(101), '10.00'), { code: 'AUTO_ORDER_CAPACITY_REACHED' });
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM amount_reservations').get().count, 100);
  service.cancel(service.listForUser(50)[0].id, user(50));
  const replacement = service.create(user(50), '10.00');
  assert.equal(replacement.payableAmount, '10.49');
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM amount_reservations').get().count, 100);
  assert.throws(() => service.create(user(101), '10.00'), { code: 'AUTO_ORDER_CAPACITY_REACHED' });
});

test('replacing a cancelled transfer order keeps its amount and rejects the old memo', async (t) => {
  const context = autoContext();
  t.after(() => context.cleanup());
  let now = baseTime;
  const calls = [];
  const service = new OrderService({
    db: context.db, config: context.config, clock: () => now,
    sub2api: { async createAndRedeemWithAdminKey(input) { calls.push(input); return successRedeem(input); } }
  });
  const first = service.create(user(1), '1.00');
  const firstMemo = service.paymentQrData(first.id, user(1)).memo;
  now = new Date(baseTime.getTime() + 10000);
  service.cancel(first.id, user(1));
  const replacement = service.create(user(1), '1.00');
  assert.equal(replacement.payableAmount, '1.00');
  const newMemo = service.paymentQrData(replacement.id, user(1)).memo;
  assert.notEqual(firstMemo, newMemo);
  assert.throws(() => service.paymentQrData(first.id, user(1)), { code: 'PAYMENT_QR_UNAVAILABLE' });
  const oldPayment = await service.acceptAutomaticPayment(paymentEvent(first, firstMemo));
  assert.equal(oldPayment.accepted, false);
  assert.equal(oldPayment.anomalyCode, 'ORDER_STATE_INVALID');
  assert.equal(calls.length, 0);
  const newPayment = await service.acceptAutomaticPayment(paymentEvent(replacement, newMemo, { sequence: 2 }));
  assert.equal(newPayment.status, 'completed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].userId, 1);
  assert.equal(calls[0].value, 1);
});

test('full transaction-detail evidence fulfills exactly once without storing the trade number or memo', async (t) => {
  const context = autoContext();
  t.after(() => context.cleanup());
  const calls = [];
  const alerts = [];
  const service = new OrderService({
    db: context.db,
    config: context.config,
    clock: () => baseTime,
    alerts: { async send(event) { alerts.push(event); } },
    sub2api: {
      async createAndRedeemWithAdminKey(input) {
        calls.push(input);
        return successRedeem(input);
      }
    }
  });
  const order = service.create(user(42), '37.25');
  const memo = service.paymentQrData(order.id, user(42)).memo;
  const event = paymentEvent(order, memo);
  const completed = await service.acceptAutomaticPayment(event);
  assert.deepEqual(completed, {
    accepted: true,
    duplicate: false,
    status: 'completed',
    orderId: order.id,
    orderNo: order.orderNo
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].value, 37.25);
  assert.equal(alerts.length, 0);

  const replay = await service.acceptAutomaticPayment({ ...event, eventId: 'evt-duplicate-0001' });
  assert.equal(replay.accepted, true);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.status, 'completed');
  assert.equal(calls.length, 1);

  const ledger = context.db.prepare('SELECT * FROM payment_events').get();
  assert.notEqual(ledger.trade_hash, event.tradeNo);
  assert.notEqual(ledger.memo_hash, memo);
  assert.equal(JSON.stringify(ledger).includes(event.tradeNo), false);
  assert.equal(JSON.stringify(ledger).includes(memo), false);
});

test('amount or recipient mismatches stop fulfillment, enter manual review, and emit a redacted alert', async (t) => {
  for (const mismatch of [
    { amount: '20.01', expected: 'PAYMENT_AMOUNT_MISMATCH' },
    { recipientId: 'different-recipient', expected: 'RECIPIENT_MISMATCH' }
  ]) {
    const context = autoContext();
    const calls = [];
    const alerts = [];
    try {
      const service = new OrderService({
        db: context.db,
        config: context.config,
        clock: () => baseTime,
        alerts: { async send(event) { alerts.push(event); } },
        sub2api: { async createAndRedeemWithAdminKey() { calls.push(true); } }
      });
      const order = service.create(user(42), '20.00');
      const memo = service.paymentQrData(order.id, user(42)).memo;
      const result = await service.acceptAutomaticPayment(paymentEvent(order, memo, mismatch));
      assert.equal(result.accepted, false);
      assert.equal(result.status, 'needs_attention');
      assert.equal(result.anomalyCode, mismatch.expected);
      assert.equal(calls.length, 0);
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0].anomalyCode, mismatch.expected);
      assert.equal(JSON.stringify(alerts[0]).includes(memo), false);
      const stored = context.db.prepare('SELECT status, auto_match_status FROM recharge_orders WHERE id = ?').get(order.id);
      assert.deepEqual(stored, { status: 'payment_reported', auto_match_status: 'needs_attention' });
    } finally {
      context.cleanup();
    }
  }
});

test('a delayed listener may fulfill an expired order only when Alipay paidAt is inside its original window', async (t) => {
  const context = autoContext();
  t.after(() => context.cleanup());
  let now = baseTime;
  let calls = 0;
  const service = new OrderService({
    db: context.db,
    config: context.config,
    clock: () => now,
    alerts: { async send() {} },
    sub2api: {
      async createAndRedeemWithAdminKey(input) {
        calls += 1;
        return successRedeem(input);
      }
    }
  });
  const order = service.create(user(42), '10.00');
  const memo = service.paymentQrData(order.id, user(42)).memo;
  now = new Date(baseTime.getTime() + 4 * 60000);
  const insideWindow = new Date(baseTime.getTime() + 2 * 60000).toISOString();
  const result = await service.acceptAutomaticPayment(paymentEvent(order, memo, { paidAt: insideWindow }));
  assert.equal(result.status, 'completed');
  assert.equal(calls, 1);
});

test('an excessively delayed event requires manual review even when its claimed payment time is in the order window', async (t) => {
  const context = autoContext({ listenerMaxEventAgeSeconds: 600 });
  t.after(() => context.cleanup());
  let now = baseTime;
  let calls = 0;
  const alerts = [];
  const service = new OrderService({
    db: context.db,
    config: context.config,
    clock: () => now,
    alerts: { async send(event) { alerts.push(event); } },
    sub2api: { async createAndRedeemWithAdminKey() { calls += 1; } }
  });
  const order = service.create(user(42), '10.00');
  const memo = service.paymentQrData(order.id, user(42)).memo;
  now = new Date(baseTime.getTime() + 13 * 60000);
  const result = await service.acceptAutomaticPayment(paymentEvent(order, memo, {
    paidAt: new Date(baseTime.getTime() + 2 * 60000).toISOString()
  }));
  assert.equal(result.accepted, false);
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.anomalyCode, 'PAYMENT_EVENT_TOO_OLD');
  assert.equal(calls, 0);
  assert.equal(alerts.at(-1).anomalyCode, 'PAYMENT_EVENT_TOO_OLD');
});

test('an unknown automatic fulfillment result is never reported as success', async (t) => {
  const context = autoContext();
  t.after(() => context.cleanup());
  const alerts = [];
  const service = new OrderService({
    db: context.db,
    config: context.config,
    clock: () => baseTime,
    alerts: { async send(event) { alerts.push(event); } },
    sub2api: {
      async createAndRedeemWithAdminKey() {
        const error = new Error('upstream timeout');
        error.code = 'SUB2API_TIMEOUT';
        throw error;
      }
    }
  });
  const order = service.create(user(42), '10.00');
  const memo = service.paymentQrData(order.id, user(42)).memo;
  const result = await service.acceptAutomaticPayment(paymentEvent(order, memo));
  assert.equal(result.accepted, false);
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.anomalyCode, 'FULFILLMENT_RESULT_UNKNOWN');
  assert.equal(alerts.at(-1).anomalyCode, 'FULFILLMENT_RESULT_UNKNOWN');
  assert.equal(context.db.prepare('SELECT status FROM recharge_orders WHERE id = ?').get(order.id).status, 'needs_attention');
});
