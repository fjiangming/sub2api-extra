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

for (const [scenario, offsets] of [
  ['identical creation times', [0, 0, 0, 0]],
  ['overlapping three-minute windows', [0, 60000, 130000, 170000]]
]) {
  test(`same and adjacent requested amounts with ${scenario} credit their owners despite reversed arrivals`, async (t) => {
    const context = accountLogContext();
    t.after(() => context.cleanup());
    let now = baseTime;
    const calls = [];
    const balances = new Map();
    const alerts = [];
    const service = new OrderService({
      db: context.db, config: context.config, clock: () => now,
      alerts: { async send(event) { alerts.push(event); } },
      sub2api: {
        async createAndRedeemWithAdminKey(input) {
          calls.push(input);
          await new Promise((resolve) => setImmediate(resolve));
          balances.set(input.userId, (balances.get(input.userId) || 0) + input.value);
          return successRedeem(input);
        }
      }
    });
    const requested = ['1.00', '1.00', '1.01', '1.00'];
    const orders = offsets.map((offset, index) => {
      now = new Date(baseTime.getTime() + offset);
      return service.create(user(index + 1), requested[index]);
    });
    assert.deepEqual(orders.map((order) => order.payableAmount), ['1.00', '1.01', '1.02', '1.03']);
    const payments = orders.map((order, index) => entry(order, {
      accountLogId: `11700712345678916${index}`,
      alipayOrderNo: `202610072200000000001${index}`,
      paidAt: new Date(Date.parse(order.createdAt) + 120000).toISOString()
    }));
    now = new Date(baseTime.getTime() + offsets.at(-1) + 185000);
    const arrivalOrder = [3, 0, 2, 1];
    const results = await Promise.all(arrivalOrder.map((index) => service.acceptAccountLogEntry(payments[index])));
    for (const [position, index] of arrivalOrder.entries()) {
      assert.equal(results[position].status, 'completed');
      assert.equal(results[position].orderId, orders[index].id);
      const input = calls.find((call) => call.userId === index + 1);
      assert.equal(input.value, Number(orders[index].payableAmount));
      assert.match(input.notes, new RegExp(orders[index].orderNo));
      const ledger = context.db.prepare('SELECT order_id FROM alipay_accountlog_entries WHERE account_log_last6 = ?')
        .get(payments[index].accountLogId.slice(-6));
      assert.equal(ledger.order_id, orders[index].id);
    }
    assert.deepEqual([...balances.entries()].sort((a, b) => a[0] - b[0]), [[1, 1], [2, 1.01], [3, 1.02], [4, 1.03]]);
    assert.equal(new Set(calls.map((input) => input.code)).size, 4);
    assert.equal(alerts.length, 0);
    const replays = await Promise.all(payments.map((payment) => service.acceptAccountLogEntry(payment)));
    assert.ok(replays.every((result) => result.duplicate && result.status === 'completed'));
    assert.equal(calls.length, 4);
  });
}

test('one user cancelling and rebuilding among competing orders cannot take another user amount or credit', async (t) => {
  const context = accountLogContext();
  t.after(() => context.cleanup());
  let now = baseTime;
  const calls = [];
  const alerts = [];
  const service = new OrderService({
    db: context.db, config: context.config, clock: () => now,
    alerts: { async send(event) { alerts.push(event); } },
    sub2api: { async createAndRedeemWithAdminKey(input) { calls.push(input); return successRedeem(input); } }
  });
  const first = service.create(user(1), '1.00');
  const cancelled = service.create(user(2), '1.00');
  const third = service.create(user(3), '1.00');
  now = new Date(baseTime.getTime() + 60000);
  service.cancel(cancelled.id, user(2));
  now = new Date(baseTime.getTime() + 61000);
  const replacement = service.create(user(2), '1.00');
  now = new Date(baseTime.getTime() + 62000);
  const fourth = service.create(user(4), '1.00');
  const orders = [first, replacement, third, fourth];
  assert.deepEqual(orders.map((order) => order.payableAmount), ['1.00', '1.01', '1.02', '1.03']);
  now = new Date(baseTime.getTime() + 160000);
  const oldPayment = await service.acceptAccountLogEntry(entry(cancelled, {
    accountLogId: '117007123456789169',
    paidAt: new Date(baseTime.getTime() + 40000).toISOString()
  }));
  assert.equal(oldPayment.accepted, false);
  assert.equal(oldPayment.orderId, cancelled.id);
  assert.equal(calls.length, 0);
  const arrivals = [3, 2, 0, 1];
  const results = await Promise.all(arrivals.map((index) => service.acceptAccountLogEntry(entry(orders[index], {
    accountLogId: `11700712345678917${index}`,
    paidAt: new Date(baseTime.getTime() + 120000).toISOString()
  }))));
  for (const [position, index] of arrivals.entries()) {
    assert.equal(results[position].orderId, orders[index].id);
    assert.equal(results[position].status, 'completed');
    const input = calls.find((call) => call.userId === index + 1);
    assert.equal(input.value, Number(orders[index].payableAmount));
    assert.match(input.notes, new RegExp(orders[index].orderNo));
  }
  assert.equal(calls.length, 4);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].orderNo, cancelled.orderNo);
});

test('concurrent duplicate receipts for competing orders call fulfillment once per owner', async (t) => {
  const context = accountLogContext();
  t.after(() => context.cleanup());
  let now = baseTime;
  const calls = [];
  const service = new OrderService({
    db: context.db, config: context.config, clock: () => now,
    sub2api: {
      async createAndRedeemWithAdminKey(input) {
        calls.push(input);
        await new Promise((resolve) => setImmediate(resolve));
        return successRedeem(input);
      }
    }
  });
  const first = service.create(user(1), '1.00');
  const second = service.create(user(2), '1.00');
  assert.equal(second.payableAmount, '1.01');
  now = new Date(baseTime.getTime() + 90000);
  const payments = [entry(first), entry(second, { accountLogId: '117007123456789152' })];
  const indexes = [1, 0, 1, 0, 0, 1];
  const results = await Promise.all(indexes.map((index) => service.acceptAccountLogEntry(payments[index])));
  assert.equal(results.filter((result) => !result.duplicate).length, 2);
  assert.equal(results.filter((result) => result.duplicate).length, 4);
  for (const [position, index] of indexes.entries()) {
    assert.equal(results[position].accepted, true);
    assert.equal(results[position].orderId, [first, second][index].id);
  }
  assert.deepEqual(calls.map((call) => [call.userId, call.value]).sort((a, b) => a[0] - b[0]), [[1, 1], [2, 1.01]]);
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM alipay_accountlog_entries').get().count, 2);
  assert.equal(service.getForUser(first.id, 1).status, 'completed');
  assert.equal(service.getForUser(second.id, 2).status, 'completed');
});

test('repeated cancellation reuses the same user amount without consuming more slots', (t) => {
  const context = accountLogContext();
  t.after(() => context.cleanup());
  let now = baseTime;
  let service = new OrderService({ db: context.db, config: context.config, sub2api: {}, clock: () => now });
  let previous = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const order = service.create(user(1), '1.00');
    assert.equal(order.payableAmount, '1.00');
    assert.equal(order.creditAmount, '1.00');
    assert.equal(order.amountAdjusted, false);
    const reservation = context.db.prepare('SELECT * FROM amount_reservations').get();
    assert.equal(reservation.order_id, order.id);
    assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM amount_reservations').get().count, 1);
    assert.equal(Date.parse(reservation.expires_at) - Date.parse(order.expiresAt), 900000);
    if (previous) {
      assert.notEqual(order.id, previous.id);
      assert.equal(service.getForUser(previous.id, '1').status, 'cancelled');
      assert.throws(() => service.openPaymentRelay(previous.orderNo), { code: 'PAYMENT_RELAY_EXPIRED' });
      const audit = context.db.prepare(`
        SELECT metadata_json FROM audit_events
        WHERE order_id = ? AND event_type = 'AMOUNT_RESERVATION_REUSED'
      `).get(previous.id);
      assert.equal(JSON.parse(audit.metadata_json).replacementOrderNo, order.orderNo);
    }
    now = new Date(now.getTime() + 10000);
    service.cancel(order.id, user(1));
    previous = order;
    now = new Date(now.getTime() + 1000);
    // The reuse decision must survive service restart and a string-valued authenticated user ID.
    service = new OrderService({ db: context.db, config: context.config, sub2api: {}, clock: () => now });
  }
  const replacement = service.create(user('1'), '1.00');
  assert.equal(replacement.payableAmount, '1.00');
});

test('cancellation preserves other users isolation while reusing an already adjusted amount for its owner', (t) => {
  const context = accountLogContext();
  t.after(() => context.cleanup());
  let now = baseTime;
  const service = new OrderService({ db: context.db, config: context.config, sub2api: {}, clock: () => now });
  const first = service.create(user(1), '1.00');
  const second = service.create(user(2), '1.00');
  assert.equal(second.payableAmount, '1.01');
  now = new Date(baseTime.getTime() + 10000);
  service.cancel(second.id, user(2));
  const replacement = service.create(user(2), '1.00');
  assert.equal(replacement.payableAmount, '1.01');
  assert.equal(replacement.creditAmount, '1.01');
  service.cancel(first.id, user(1));
  const third = service.create(user(3), '1.00');
  assert.equal(third.payableAmount, '1.02');
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM amount_reservations').get().count, 3);

  now = new Date(baseTime.getTime() + 20 * 60000);
  assert.equal(service.create(user(4), '1.00').payableAmount, '1.00');
});

test('a replacement order accepts its later payment once and excludes all earlier cancelled windows', async (t) => {
  const context = accountLogContext();
  t.after(() => context.cleanup());
  let now = baseTime;
  const calls = [];
  const alerts = [];
  const service = new OrderService({
    db: context.db, config: context.config, clock: () => now,
    alerts: { async send(event) { alerts.push(event); } },
    sub2api: { async createAndRedeemWithAdminKey(input) { calls.push(input); return successRedeem(input); } }
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const cancelled = service.create(user(1), '1.00');
    now = new Date(now.getTime() + 10000);
    service.cancel(cancelled.id, user(1));
    now = new Date(now.getTime() + 1000);
  }
  const replacement = service.create(user(1), '1.00');
  now = new Date(now.getTime() + 90000);
  const payment = entry(replacement);
  const result = await service.acceptAccountLogEntry(payment);
  assert.equal(result.status, 'completed');
  assert.equal(result.orderId, replacement.id);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].userId, 1);
  assert.equal(calls[0].value, 1);
  assert.match(calls[0].notes, new RegExp(replacement.orderNo));
  assert.equal(alerts.length, 0);
  const replay = await service.acceptAccountLogEntry(payment);
  assert.equal(replay.duplicate, true);
  assert.equal(calls.length, 1);
});

test('a delayed pre-cancellation payment enters review on the old order without crediting its replacement', async (t) => {
  const context = accountLogContext();
  t.after(() => context.cleanup());
  let now = baseTime;
  let calls = 0;
  const alerts = [];
  const service = new OrderService({
    db: context.db, config: context.config, clock: () => now,
    alerts: { async send(event) { alerts.push(event); } },
    sub2api: {
      async createAndRedeemWithAdminKey() { calls += 1; },
      async createAndRedeem(_token, input) { calls += 1; return successRedeem(input); }
    }
  });
  const first = service.create(user(1), '1.00');
  now = new Date(baseTime.getTime() + 20000);
  const cancelled = service.cancel(first.id, user(1));
  now = new Date(baseTime.getTime() + 30000);
  const replacement = service.create(user(1), '1.00');
  assert.equal(service.getForAdmin(first.id).order.paymentMatchUntil, cancelled.cancelledAt);
  now = new Date(baseTime.getTime() + 90000);
  const result = await service.acceptAccountLogEntry(entry(first, {
    paidAt: new Date(baseTime.getTime() + 10000).toISOString()
  }));
  assert.equal(result.accepted, false);
  assert.equal(result.anomalyCode, 'ORDER_STATE_INVALID');
  assert.equal(result.orderId, first.id);
  assert.equal(calls, 0);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].orderNo, first.orderNo);
  assert.equal(service.getForUser(first.id, 1).status, 'payment_reported');
  assert.equal(service.getForUser(replacement.id, 1).status, 'awaiting_payment');
  const adminSession = { user: { id: 9, role: 'admin' }, upstreamToken: 'admin-session-token', client: {} };
  await assert.rejects(service.confirm(first.id, adminSession, {
    paidAmount: '1.00', paidAt: replacement.createdAt,
    tradeNo: '117007123456789151', acknowledge: true
  }), { code: 'PAYMENT_OUTSIDE_ORDER_WINDOW' });
  assert.equal(calls, 0);
  const reviewed = await service.confirm(first.id, adminSession, {
    paidAmount: '1.00', paidAt: new Date(baseTime.getTime() + 10000).toISOString(),
    tradeNo: '117007123456789151', acknowledge: true
  });
  assert.equal(reviewed.status, 'completed');
  assert.equal(calls, 1);
  assert.equal(service.getForUser(replacement.id, 1).status, 'awaiting_payment');
});

test('cancellation within a ledger second cannot choose either order at the ambiguous boundary', async (t) => {
  const context = accountLogContext();
  t.after(() => context.cleanup());
  let now = baseTime;
  let calls = 0;
  const alerts = [];
  const service = new OrderService({
    db: context.db, config: context.config, clock: () => now,
    alerts: { async send(event) { alerts.push(event); } },
    sub2api: { async createAndRedeemWithAdminKey() { calls += 1; } }
  });
  const first = service.create(user(1), '1.00');
  now = new Date(baseTime.getTime() + 20500);
  service.cancel(first.id, user(1));
  const replacement = service.create(user(1), '1.00');
  now = new Date(baseTime.getTime() + 30000);
  const result = await service.acceptAccountLogEntry(entry(replacement, {
    paidAt: new Date(baseTime.getTime() + 20700).toISOString()
  }));
  assert.equal(result.accepted, false);
  assert.equal(result.anomalyCode, 'ACCOUNTLOG_ORDER_AMBIGUOUS');
  assert.equal(calls, 0);
  assert.equal(alerts.length, 1);
  assert.equal(service.getForUser(first.id, 1).status, 'payment_reported');
  assert.equal(service.getForUser(replacement.id, 1).status, 'payment_reported');
});

test('expired and completed static orders keep their amounts isolated even from the same user', async (t) => {
  const context = accountLogContext();
  t.after(() => context.cleanup());
  let now = baseTime;
  const service = new OrderService({
    db: context.db, config: context.config, clock: () => now,
    sub2api: { async createAndRedeemWithAdminKey(input) { return successRedeem(input); } }
  });
  const expired = service.create(user(1), '1.00');
  now = new Date(baseTime.getTime() + 4 * 60000);
  assert.equal(service.create(user(1), '1.00').payableAmount, '1.01');
  assert.equal(service.getForUser(expired.id, 1).status, 'expired');

  const completed = service.create(user(2), '2.00');
  now = new Date(now.getTime() + 90000);
  assert.equal((await service.acceptAccountLogEntry(entry(completed))).status, 'completed');
  assert.equal(service.create(user(2), '2.00').payableAmount, '2.01');
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
