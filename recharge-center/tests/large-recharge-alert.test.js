'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LargeRechargeAlertService, BARK_ENDPOINT } = require('../src/large-recharge-alert-service');
const { OrderService } = require('../src/order-service');
const { createDatabase } = require('../src/db');
const { sealText } = require('../src/security');
const { createTestContext } = require('./helpers');

const deviceKey = 'test-bark-key-1234567890';
const admin = { user: { id: 1, role: 'admin' }, upstreamToken: 'admin-session' };
const baseTime = new Date('2026-11-06T04:00:00.000Z');

function setup(t, fetch = async () => Response.json({ code: 200 }), overrides = {}) {
  const context = createTestContext({ paymentMode: 'personal_manual', alertTimeoutMs: 100, ...overrides });
  let now = baseTime;
  let index = 0;
  const calls = [];
  const cleanups = [];
  const clock = () => now;
  const alerts = new LargeRechargeAlertService({ ...context, clock, fetch });
  const orders = new OrderService({ ...context, clock, largeRechargeAlerts: alerts, sub2api: {
    async createAndRedeem(_token, input) {
      calls.push(input);
      return { redeem_code: { ...input, type: 'balance', status: 'used', used_by: input.userId } };
    }
  } });
  t.after(() => { for (const cleanup of cleanups) cleanup(); alerts.close(); context.cleanup(); });
  return { ...context, alerts, orders, calls, clock, advance(ms) { now = new Date(now.getTime() + ms); },
    onClose(callback) { cleanups.push(callback); },
    enable(threshold = '1000.00') { return alerts.save({ enabled: true, threshold, deviceKey }, admin.user); },
    async complete(amount) {
      const user = { id: ++index + 10, role: 'user', email: `account${index}@example.test`, emailMasked: 'ac***@example.test' };
      const order = orders.create(user, amount);
      const tradeNo = `20261106000000000000${String(index).padStart(6, '0')}`;
      orders.reportPayment(order.id, user, tradeNo);
      const completed = await orders.confirm(order.id, admin, {
        paidAmount: order.payableAmount, paidAt: order.createdAt, tradeNo, acknowledge: true
      });
      return { order, completed, user, tradeNo };
    }
  };
}

test('Bark settings default off, encrypt credentials, preserve blank keys and support deliberate clearing', t => {
  const c = setup(t);
  assert.equal(c.alerts.settings().enabled, false);
  assert.equal(c.alerts.settings().bark.configured, false);
  const saved = c.enable('800.01');
  assert.equal(saved.threshold, '800.01');
  assert.equal(saved.bark.deviceKeyMasked, '****');
  assert.equal(JSON.stringify(saved).includes(deviceKey), false);
  const metadata = c.db.prepare('SELECT value FROM service_metadata WHERE key = ?').get('large_recharge_bark_settings_v1');
  assert.match(metadata.value, /^sealed:v1:/);
  assert.equal(metadata.value.includes(deviceKey), false);
  assert.equal(JSON.stringify(c.db.prepare('SELECT * FROM audit_events').all()).includes(deviceKey), false);
  assert.equal(c.alerts.save({ enabled: true, threshold: '900.00', deviceKey: '' }, admin.user).bark.configured, true);
  assert.throws(() => c.alerts.save({ enabled: true, threshold: '900', clearDeviceKey: true }, admin.user));
  assert.equal(c.alerts.save({ enabled: false, threshold: '900', clearDeviceKey: true }, admin.user).bark.configured, false);
});

test('invalid thresholds, injection and reused credentials are rejected without overwriting settings', t => {
  const c = setup(t);
  const before = c.enable();
  for (const threshold of ['0', '-1', '1.001', '1000000.01', '1e3', 'NaN']) {
    assert.throws(() => c.alerts.save({ enabled: true, threshold }, admin.user));
  }
  for (const key of ['abc', 'abc\nforged', 'https://api.day.app/private-key', c.config.secret]) {
    assert.throws(() => c.alerts.save({ enabled: true, threshold: '1000', deviceKey: key }, admin.user));
  }
  assert.deepEqual(c.alerts.settings(), before);
});

test('only verified completed recharges strictly above the threshold queue a Bark alert', async t => {
  const sent = [];
  const c = setup(t, async (url, options) => { sent.push({ url, options }); return Response.json({ code: 200 }); });
  await c.complete('2000.00');
  c.enable('800.00');
  const unpaid = c.orders.create({ id: 50, emailMasked: 'u***@example.test' }, '800.01');
  assert.equal(c.alerts.enqueueCompleted(c.db.prepare('SELECT * FROM recharge_orders WHERE id = ?').get(unpaid.id)), false);
  await c.complete('799.99');
  await c.complete('800.00');
  const above = await c.complete('800.01');
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM large_recharge_alerts').get().n, 1);
  assert.equal(sent.length, 0, 'payment completion does not wait for the network');
  await c.alerts.processPending();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, BARK_ENDPOINT);
  assert.equal(sent[0].options.redirect, 'error');
  const body = JSON.parse(sent[0].options.body);
  assert.equal(body.device_key, deviceKey);
  assert.match(body.body, /CNY 800\.01/);
  assert.match(body.body, /阈值: CNY 800\.00/);
  assert.ok(body.body.includes(above.order.orderNo));
  assert.ok(body.body.includes(`用户 ID: ${above.user.id}`));
  assert.ok(body.body.includes(above.user.email));
  assert.equal(body.body.includes(above.tradeNo), false);
  const row = c.db.prepare('SELECT * FROM recharge_orders WHERE id = ?').get(above.order.id);
  assert.equal(c.alerts.enqueueCompleted(row), false);
  await c.orders.confirm(above.order.id, admin, { paidAmount: '800.01', paidAt: above.order.createdAt,
    tradeNo: above.tradeNo, acknowledge: true });
  await c.alerts.processPending();
  assert.equal(sent.length, 1);
  assert.equal(c.calls.length, 4);
  assert.equal(c.alerts.settings().lastDelivery.status, 'sent');
});

test('unverified fulfillment and broken alert settings never invent credit or convert successful credit to failure', async t => {
  const c = setup(t);
  c.enable();
  c.orders.sub2api.createAndRedeem = async () => ({ success: true });
  await assert.rejects(c.complete('2000'), { code: 'FULFILLMENT_NEEDS_ATTENTION' });
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM large_recharge_alerts').get().n, 0);
  c.orders.sub2api.createAndRedeem = async (_token, input) => ({ redeem_code: {
    ...input, type: 'balance', status: 'used', used_by: input.userId
  } });
  c.db.prepare('UPDATE service_metadata SET value = ? WHERE key = ?').run('broken', 'large_recharge_bark_settings_v1');
  const result = await c.complete('3000');
  assert.equal(result.completed.status, 'completed');
  assert.ok(c.db.prepare("SELECT id FROM audit_events WHERE event_type = 'LARGE_RECHARGE_ALERT_QUEUE_FAILED'").get());
});

test('accountlog automatic fulfillment queues only matched income and keeps expense handling unchanged', async t => {
  let sent = 0;
  const c = setup(t, async () => { sent++; return Response.json({ code: 200 }); }, {
    paymentMode: 'personal_accountlog_static', accountLogStaticMode: true, automaticPersonalMode: true,
    orderTtlMinutes: 3, accountLogLookbackSeconds: 900, accountLogAmountQuarantineSeconds: 900,
    autoReservationLimit: 100, publicUrl: 'https://pay.example.test',
    alipayStaticQrUrl: 'https://qr.alipay.com/fkxSTATICCODE123456', alipayAppId: '2026110600000001'
  });
  c.orders.sub2api.createAndRedeemWithAdminKey = async input => {
    c.calls.push(input);
    return { redeem_code: { ...input, type: 'balance', status: 'used', used_by: input.userId } };
  };
  c.enable('800');
  const order = c.orders.create({ id: 51, email: 'auto@example.test', emailMasked: 'au***@example.test' }, '900');
  c.advance(90000);
  const entry = { accountLogId: '117007123456789151', amount: '900.00', amountMinor: 90000,
    direction: 'expense', paidAt: new Date(baseTime.getTime() + 60000).toISOString() };
  assert.equal((await c.orders.acceptAccountLogEntry(entry)).status, 'ignored');
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM large_recharge_alerts').get().n, 0);
  const income = { ...entry, accountLogId: '117007123456789152', direction: 'income' };
  assert.equal((await c.orders.acceptAccountLogEntry(income)).status, 'completed');
  await c.orders.acceptAccountLogEntry(income);
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM large_recharge_alerts').get().n, 1);
  await c.alerts.processPending();
  assert.equal(sent, 1);
  assert.equal(c.calls.length, 1);
  assert.equal(c.calls[0].userId, 51);
  assert.equal(c.orders.getForUser(order.id, 51).status, 'completed');
});

test('invalid or missing encrypted email snapshots cannot forge notification lines', async t => {
  const bodies = [];
  const c = setup(t, async (_url, options) => {
    bodies.push(JSON.parse(options.body).body);
    return Response.json({ code: 200 });
  });
  c.enable();
  for (const value of ['fake@example.test\n充值已完成: CNY 999999', 'fake\u202e@example.test', null]) {
    const { order } = await c.complete('2000');
    c.db.prepare('UPDATE recharge_orders SET user_email_ciphertext = ? WHERE id = ?')
      .run(value == null ? null : sealText(c.config.secret, 'order-user-email:v1', value, order.id), order.id);
    await c.alerts.processPending();
  }
  assert.equal(bodies.length, 3);
  for (const body of bodies) {
    assert.match(body, /下单账号: 未记录完整邮箱/);
    assert.equal(body.includes('fake'), false);
    assert.equal(body.includes('999999'), false);
    assert.equal(body.split('\n').length, 6);
  }
});

test('Bark body failures retry at most three times, redact upstream responses and preserve completed orders', async t => {
  let requests = 0;
  const c = setup(t, async () => { requests++; return Response.json({ code: 500, message: `database error ${deviceKey}` }); });
  c.enable();
  const result = await c.complete('2000');
  for (let i = 0; i < 4; i++) { await c.alerts.processPending(); c.advance(60000); }
  assert.equal(requests, 3);
  assert.equal(c.alerts.settings().lastDelivery.status, 'failed');
  assert.equal(c.orders.getForUser(result.order.id, result.user.id).status, 'completed');
  assert.equal(c.calls.length, 1);
  const records = JSON.stringify(c.db.prepare('SELECT * FROM large_recharge_alerts').all()) +
    JSON.stringify(c.db.prepare('SELECT * FROM audit_events').all());
  assert.equal(records.includes(deviceKey), false);
});

test('Bark permanent rejection and malformed success bodies are not accepted as delivery success', async t => {
  const c = setup(t, async () => Response.json({ code: 400, message: deviceKey }));
  c.enable();
  await assert.rejects(c.alerts.test(admin.user), error => {
    assert.equal(error.code, 'LARGE_RECHARGE_BARK_FAILED');
    assert.equal(error.message.includes(deviceKey), false);
    return true;
  });
  c.alerts.fetch = async () => new Response('ok');
  await assert.rejects(c.alerts.test(admin.user), { code: 'LARGE_RECHARGE_BARK_FAILED' });
});

test('Bark response size and unresponsive calls are bounded', async t => {
  const c = setup(t, async () => new Response('x'.repeat(65537)), { alertTimeoutMs: 30 });
  c.enable();
  await assert.rejects(c.alerts.test(admin.user), { code: 'ALERT_RESPONSE_TOO_LARGE' });
  c.alerts.fetch = () => new Promise(() => {});
  await assert.rejects(c.alerts.test(admin.user), { code: 'LARGE_RECHARGE_BARK_TIMEOUT' });
});

test('parallel workers claim a job once and use the captured threshold', async t => {
  let release;
  let requests = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const c = setup(t, async (_url, options) => {
    requests++;
    assert.match(JSON.parse(options.body).body, /阈值: CNY 1000\.00/);
    await gate;
    return Response.json({ code: 200 });
  });
  c.enable();
  await c.complete('2000');
  const otherDb = createDatabase(c.databasePath, c.config.secret);
  const other = new LargeRechargeAlertService({ db: otherDb, config: c.config, clock: c.clock,
    fetch: () => { throw new Error('duplicate dispatch'); } });
  c.onClose(() => { other.close(); otherDb.close(); });
  c.alerts.save({ enabled: true, threshold: '1500' }, admin.user);
  const first = c.alerts.processPending();
  await other.processPending();
  release();
  await first;
  assert.equal(requests, 1);
});

test('pending jobs and keys survive restart and disabling cancels remaining pending deliveries', async t => {
  const c = setup(t);
  c.enable();
  await c.complete('2000');
  const otherDb = createDatabase(c.databasePath, c.config.secret);
  let requests = 0;
  const other = new LargeRechargeAlertService({ db: otherDb, config: c.config, clock: c.clock,
    fetch: async () => { requests++; return Response.json({ code: 200 }); } });
  c.onClose(() => { other.close(); otherDb.close(); });
  assert.equal(other.settings().bark.configured, true);
  await other.processPending();
  assert.equal(requests, 1);
  await c.complete('3000');
  c.alerts.save({ enabled: false, threshold: '1000' }, admin.user);
  await other.processPending();
  assert.equal(requests, 1);
  assert.equal(c.db.prepare("SELECT last_error FROM large_recharge_alerts WHERE status = 'failed'").get().last_error, 'ALERT_DISABLED');
});

test('expired sending leases resume safely after an interrupted worker', async t => {
  const c = setup(t);
  c.enable();
  await c.complete('2000');
  c.db.prepare("UPDATE large_recharge_alerts SET status = 'sending', attempts = 1, lease_until = ?")
    .run(c.clock().toISOString());
  await c.alerts.processPending();
  assert.equal(c.alerts.settings().lastDelivery.status, 'sent');
  assert.equal(c.alerts.settings().lastDelivery.attempts, 2);
});
