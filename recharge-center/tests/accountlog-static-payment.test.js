'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('../src/db');
const { NotificationService } = require('../src/notification-service');
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
  return { id, email: `u${id}@example.test`, emailMasked: `u${id}***@example.test`, role: 'user' };
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

test('an unassociated expense lists nearby order owners without assigning the bill or changing their balances', async (t) => {
  const context = accountLogContext();
  t.after(() => context.cleanup());
  let now = new Date(baseTime.getTime() - 10 * 60000);
  const alerts = [];
  let redemptions = 0;
  const service = new OrderService({ db: context.db, config: context.config, clock: () => now,
    alerts: { async send(event) { alerts.push(event); } },
    sub2api: { async createAndRedeemWithAdminKey() { redemptions += 1; } } });
  const old = service.create(user(9), '90.00');
  now = new Date(baseTime.getTime() - 4 * 60000);
  const adjacent = service.create(user(3), '30.00');
  now = baseTime;
  const sameAmount = service.create(user(1), '10.18');
  const differentAmount = service.create(user(2), '20.00');
  const cancelled = service.create(user(4), '40.00');
  service.cancel(cancelled.id, user(4));
  const otherMode = service.create(user(6), '60.00');
  context.db.prepare('UPDATE recharge_orders SET payment_mode = ? WHERE id = ?').run('personal_manual', otherMode.id);
  now = new Date(baseTime.getTime() + 5 * 60000);
  const future = service.create(user(5), '50.00');
  now = new Date(baseTime.getTime() + 8 * 60000);
  const result = await service.acceptAccountLogEntry(entry(sameAmount, {
    amountMinor: -1018, direction: 'expense', userEmail: 'spoofed@example.test'
  }));
  assert.equal(result.accepted, false);
  assert.equal(result.orderId, null);
  assert.equal(redemptions, 0);
  assert.equal(alerts.length, 1);
  const alert = alerts[0];
  assert.equal(alert.userId, null);
  assert.equal(alert.userEmail, null);
  assert.deepEqual(alert.payment, { amount: '-10.18', direction: 'expense',
    paidAt: new Date(baseTime.getTime() + 60000).toISOString() });
  assert.equal(alert.nearbyOrders.from, new Date(baseTime.getTime() - 2 * 60000).toISOString());
  assert.equal(alert.nearbyOrders.until, new Date(baseTime.getTime() + 4 * 60000).toISOString());
  assert.equal(alert.nearbyOrders.total, 4);
  assert.equal(alert.nearbyOrders.totalUsers, 4);
  assert.equal(alert.nearbyOrders.orders[0].orderNo, sameAmount.orderNo);
  assert.deepEqual(new Set(alert.nearbyOrders.orders.map((order) => order.orderNo)),
    new Set([sameAmount, differentAmount, adjacent, cancelled].map((order) => order.orderNo)));
  for (const order of alert.nearbyOrders.orders) {
    assert.equal(order.userEmail, user(Number(order.userId)).email);
    assert.ok(!['payment_reported', 'needs_attention', 'fulfilling', 'completed'].includes(order.status));
  }
  for (const excluded of [old, future, otherMode]) {
    assert.equal(alert.nearbyOrders.orders.some((order) => order.orderNo === excluded.orderNo), false);
  }
  const stored = context.db.prepare('SELECT order_id FROM alipay_accountlog_entries').get();
  assert.equal(stored.order_id, null);
  assert.equal(Object.hasOwn(result, 'nearbyOrders'), false);
  assert.equal(JSON.stringify(service.getForAdmin(sameAmount.id)).includes(user(1).email), false);
});

test('candidate lists disclose truncation above 100 orders while retaining every counted nearby order', async (t) => {
  const context = accountLogContext();
  t.after(() => context.cleanup());
  const alerts = [];
  const service = new OrderService({ db: context.db, config: context.config, sub2api: {}, clock: () => baseTime,
    alerts: { async send(event) { alerts.push(event); } } });
  const first = service.create(user(1), '10.00');
  service.cancel(first.id, user(1));
  service.create(user(1), '10.00');
  for (let id = 2; id <= 100; id += 1) service.create(user(id), '10.00');
  await service.acceptAccountLogEntry(entry(first, { amountMinor: -1000, direction: 'expense', paidAt: first.createdAt }));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].nearbyOrders.total, 101);
  assert.equal(alerts[0].nearbyOrders.totalUsers, 100);
  assert.equal(alerts[0].nearbyOrders.orders.length, 100);
  assert.equal(new Set(alerts[0].nearbyOrders.orders.map((order) => order.userId)).size, 100);
  assert.equal(alerts[0].orderNo, null);
});

test('a damaged candidate email snapshot does not suppress the remaining users or identify the wrong account', async (t) => {
  const context = accountLogContext();
  t.after(() => context.cleanup());
  const alerts = [];
  const service = new OrderService({ db: context.db, config: context.config, sub2api: {}, clock: () => baseTime,
    alerts: { async send(event) { alerts.push(event); } } });
  const first = service.create(user(1), '10.00');
  const second = service.create(user(2), '20.00');
  context.db.prepare(`
    UPDATE recharge_orders SET user_email_ciphertext =
      (SELECT user_email_ciphertext FROM recharge_orders WHERE id = ?) WHERE id = ?
  `).run(first.id, second.id);
  await service.acceptAccountLogEntry(entry(first, { amountMinor: -1000, direction: 'expense', paidAt: first.createdAt }));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].nearbyOrders.orders.find((order) => order.userId === '1').userEmail, user(1).email);
  assert.equal(alerts[0].nearbyOrders.orders.find((order) => order.userId === '2').userEmail, null);
});

for (const hasEmailSnapshot of [true, false]) {
  test(`anomaly email after restart ${hasEmailSnapshot ? 'shows the original full account' : 'identifies legacy orders by user ID'}`, async (t) => {
    const context = accountLogContext();
    let db = context.db;
    t.after(() => {
      if (db.open) db.close();
      context.cleanup();
    });
    const account = { ...user(42), email: 'alice+recharge@example.test' };
    const originalEmail = account.email;
    let now = baseTime;
    const creator = new OrderService({ db, config: context.config, sub2api: {}, clock: () => now });
    const order = creator.create(account, '20.00');
    const stored = db.prepare('SELECT * FROM recharge_orders WHERE id = ?').get(order.id);
    assert.match(stored.user_email_ciphertext, /^sealed:v1:/);
    assert.equal(JSON.stringify(stored).includes(originalEmail), false);
    assert.equal(JSON.stringify(creator.getForAdmin(order.id)).includes(originalEmail), false);
    assert.equal(JSON.stringify(order).includes('user_email_ciphertext'), false);
    assert.equal(JSON.stringify(order).includes(originalEmail), false);
    if (!hasEmailSnapshot) {
      db.prepare('UPDATE recharge_orders SET user_email_ciphertext = NULL WHERE id = ?').run(order.id);
    }

    db.close();
    db = createDatabase(context.databasePath, context.config.secret);
    account.email = 'changed@example.test';
    now = new Date(baseTime.getTime() + 90000);
    const messages = [];
    const alerts = new NotificationService({ alertChannels: ['email'], smtpFrom: 'alerts@example.test',
      alertEmailTo: ['ops@example.test'] }, {
      transport: { async sendMail(message) { messages.push(message); } }
    });
    const service = new OrderService({ db, config: context.config, sub2api: {}, alerts, clock: () => now });
    const result = await service.acceptAccountLogEntry(entry(order, {
      direction: 'unknown', userId: 99, userEmail: 'spoofed@example.test'
    }));
    assert.equal(result.status, 'needs_attention');
    assert.equal(result.accepted, false);
    assert.equal(messages.length, 1);
    assert.match(messages[0].text, /下单用户 ID: 42/);
    if (hasEmailSnapshot) {
      assert.ok(messages[0].text.includes(`下单账号（完整邮箱）: ${originalEmail}`));
    } else {
      assert.match(messages[0].text, /未记录完整邮箱，请按用户 ID 查找/);
      assert.equal(messages[0].text.includes(originalEmail), false);
    }
    assert.equal(messages[0].text.includes('spoofed@example.test'), false);
    assert.equal(messages[0].text.includes(account.email), false);
    if (hasEmailSnapshot) {
      assert.equal(messages[0].text.includes('附近订单候选'), false);
    } else {
      assert.match(messages[0].text, /附近订单候选/);
      assert.ok(messages[0].text.includes(order.orderNo));
    }
    const audit = db.prepare('SELECT metadata_json FROM audit_events WHERE order_id = ?').all(order.id);
    assert.equal(JSON.stringify(audit).includes(originalEmail), false);
  });
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
  assert.equal(alerts[0].userId, 2);
  assert.equal(alerts[0].userEmail, user(2).email);
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
  assert.equal(alerts[0].userId, null);
  assert.equal(alerts[0].userEmail, null);
  assert.equal(alerts[0].nearbyOrders.total, 2);
  assert.deepEqual(new Set(alerts[0].nearbyOrders.orders.map((candidate) => candidate.orderNo)),
    new Set([first.orderNo, replacement.orderNo]));
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
  assert.equal(alerts[0].userId, 1);
  assert.equal(alerts[0].userEmail, user(1).email);

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
  assert.equal(alerts[1].userId, null);
  assert.equal(alerts[1].userEmail, null);
  assert.equal(alerts[2].userId, null);
  assert.equal(alerts[2].userEmail, null);
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
