'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { OrderService } = require('../src/order-service');
const { createTestContext } = require('./helpers');

const baseTime = new Date('2026-10-07T04:00:00.000Z');

function accountLogContext(overrides = {}) {
  return createTestContext({
    paymentMode: 'personal_accountlog_static',
    automaticPersonalMode: true,
    accountLogStaticMode: true,
    orderTtlMinutes: 3,
    accountLogLookbackSeconds: 900,
    accountLogAmountQuarantineSeconds: 900,
    autoReservationLimit: 100,
    publicUrl: 'https://pay.example.test',
    alipayStaticQrUrl: 'https://qr.alipay.com/fkxSTATICCODE123456',
    alipayAppId: '2026100700000001',
    maxActiveOrders: 1,
    ...overrides
  });
}

function user(id) {
  return { id, emailMasked: `u${id}***@example.test`, role: 'user' };
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

function entry(order, overrides = {}) {
  return {
    accountLogId: '117007123456789151',
    alipayOrderNo: '2026100722000000000001',
    merchantOrderNo: null,
    amount: order.payableAmount,
    amountMinor: Math.round(Number(order.payableAmount) * 100),
    paidAt: new Date(Date.parse(order.createdAt) + 60000).toISOString(),
    direction: 'income',
    memo: '个人收钱码收款',
    otherAccount: '付款方私密账号',
    billSource: '支付宝',
    type: '收款',
    ...overrides
  };
}

test('static accountlog orders use a high-entropy relay token and retain amount quarantine', (t) => {
  const context = accountLogContext();
  t.after(() => context.cleanup());
  let now = baseTime;
  const service = new OrderService({ db: context.db, config: context.config, sub2api: {}, clock: () => now });
  const first = service.create(user(1), '50.00');
  assert.match(first.orderNo, /^RC-\d{6}-[A-F0-9]{32}$/);
  assert.equal(first.payUrl, `https://pay.example.test/pay/${first.orderNo}`);
  assert.deepEqual(service.paymentQrData(first.id, user(1)), { relayUrl: first.payUrl });
  assert.equal(service.openPaymentRelay(first.orderNo), context.config.alipayStaticQrUrl);

  const reservation = context.db.prepare('SELECT expires_at FROM amount_reservations WHERE order_id = ?').get(first.id);
  assert.equal(
    Date.parse(reservation.expires_at) - Date.parse(first.expiresAt),
    context.config.accountLogAmountQuarantineSeconds * 1000
  );

  now = new Date(baseTime.getTime() + 4 * 60000);
  const second = service.create(user(2), '50.00');
  assert.equal(second.payableAmount, '50.01');
  assert.throws(() => service.openPaymentRelay(first.orderNo), { code: 'PAYMENT_RELAY_EXPIRED' });
});

test('static QR and accountlog AppID cannot change until orders and amount quarantine are drained', (t) => {
  const context = accountLogContext();
  t.after(() => context.cleanup());
  let now = baseTime;
  const service = new OrderService({ db: context.db, config: context.config, sub2api: {}, clock: () => now });
  service.create(user(1), '50.00');
  const changedConfig = {
    ...context.config,
    alipayStaticQrUrl: 'https://qr.alipay.com/fkxDIFFERENT987654'
  };
  assert.throws(() => new OrderService({
    db: context.db, config: changedConfig, sub2api: {}, clock: () => now
  }), /拒绝切换收款身份/);

  now = new Date(baseTime.getTime() + 20 * 60000);
  assert.doesNotThrow(() => new OrderService({
    db: context.db, config: changedConfig, sub2api: {}, clock: () => now
  }));
});

test('a unique verified income entry credits exactly once without storing raw financial identifiers', async (t) => {
  const context = accountLogContext();
  t.after(() => context.cleanup());
  let now = baseTime;
  const calls = [];
  const alerts = [];
  const service = new OrderService({
    db: context.db,
    config: context.config,
    clock: () => now,
    alerts: { async send(event) { alerts.push(event); } },
    sub2api: {
      async createAndRedeemWithAdminKey(input) {
        calls.push(input);
        return successRedeem(input);
      }
    }
  });
  const order = service.create(user(42), '37.25');
  now = new Date(baseTime.getTime() + 90000);
  const payment = entry(order);
  const completed = await service.acceptAccountLogEntry(payment);
  assert.deepEqual(completed, {
    accepted: true,
    duplicate: false,
    status: 'completed',
    orderId: order.id,
    orderNo: order.orderNo
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].value, 37.25);
  assert.match(calls[0].notes, new RegExp(order.orderNo));
  assert.match(calls[0].notes, /支付宝账务流水尾号 789151/);
  assert.equal(alerts.length, 0);

  const replay = await service.acceptAccountLogEntry(payment);
  assert.equal(replay.accepted, true);
  assert.equal(replay.duplicate, true);
  assert.equal(calls.length, 1);

  const stored = context.db.prepare('SELECT * FROM alipay_accountlog_entries').get();
  const serialized = JSON.stringify(stored);
  assert.equal(serialized.includes(payment.accountLogId), false);
  assert.equal(serialized.includes(payment.alipayOrderNo), false);
  assert.equal(serialized.includes(payment.otherAccount), false);
  assert.equal(stored.account_log_last6, '789151');
  assert.equal(stored.match_status, 'completed');
});

test('a conflicting replay, non-income entry, or payment outside the order window never credits', async (t) => {
  const context = accountLogContext({ maxActiveOrders: 3 });
  t.after(() => context.cleanup());
  let now = baseTime;
  const calls = [];
  const alerts = [];
  const service = new OrderService({
    db: context.db,
    config: context.config,
    clock: () => now,
    alerts: { async send(event) { alerts.push(event); } },
    sub2api: {
      async createAndRedeemWithAdminKey(input) {
        calls.push(input);
        return successRedeem(input);
      }
    }
  });
  const paidOrder = service.create(user(1), '10.00');
  now = new Date(baseTime.getTime() + 90000);
  const original = entry(paidOrder);
  await service.acceptAccountLogEntry(original);
  const conflict = await service.acceptAccountLogEntry({ ...original, memo: '内容被改变' });
  assert.equal(conflict.accepted, false);
  assert.equal(conflict.anomalyCode, 'ACCOUNT_LOG_ID_CONFLICT');
  assert.equal(calls.length, 1);

  const expenseOrder = service.create(user(2), '20.00');
  const expense = await service.acceptAccountLogEntry(entry(expenseOrder, {
    accountLogId: '117007123456789152',
    amountMinor: -2000,
    amount: '-20.00',
    direction: 'expense'
  }));
  assert.equal(expense.accepted, false);
  assert.equal(expense.anomalyCode, 'PAYMENT_DIRECTION_INVALID');

  const lateOrder = service.create(user(3), '30.00');
  const outside = await service.acceptAccountLogEntry(entry(lateOrder, {
    accountLogId: '117007123456789153',
    paidAt: new Date(Date.parse(lateOrder.createdAt) - 1000).toISOString()
  }));
  assert.equal(outside.accepted, false);
  assert.equal(outside.anomalyCode, 'ACCOUNTLOG_ORDER_NOT_FOUND');
  assert.equal(calls.length, 1);
  assert.equal(alerts.length, 3);
});

test('an associated accountlog anomaly can be independently reviewed with its exact ledger id', async (t) => {
  const context = accountLogContext();
  t.after(() => context.cleanup());
  let now = baseTime;
  const calls = [];
  const service = new OrderService({
    db: context.db,
    config: context.config,
    clock: () => now,
    sub2api: {
      async createAndRedeem(_token, input) {
        calls.push(input);
        return successRedeem(input);
      }
    }
  });
  const order = service.create(user(42), '18.88');
  now = new Date(baseTime.getTime() + 90000);
  const evidence = entry(order, { direction: 'unknown' });
  const anomaly = await service.acceptAccountLogEntry(evidence);
  assert.equal(anomaly.accepted, false);
  assert.equal(anomaly.anomalyCode, 'PAYMENT_DIRECTION_INVALID');
  assert.equal(service.getForAdmin(order.id).order.status, 'payment_reported');

  const completed = await service.confirm(order.id, {
    user: { id: 9, role: 'admin' },
    upstreamToken: 'admin-session-token',
    client: {}
  }, {
    paidAmount: order.payableAmount,
    paidAt: evidence.paidAt,
    tradeNo: evidence.accountLogId,
    acknowledge: true
  });
  assert.equal(completed.status, 'completed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].value, 18.88);
});
