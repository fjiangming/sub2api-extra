'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('../src/db');
const { OrderService } = require('../src/order-service');
const { DailyOrderLimit } = require('../src/daily-order-limit');
const { createTestContext } = require('./helpers');

const user = { id: 42, emailMasked: 'al***@example.test', role: 'user' };
const initialTime = new Date('2026-10-11T04:00:00.000Z');

test('ten created orders exhaust the daily quota even after cancellation; existing payments remain available', (t) => {
  const context = createTestContext({ paymentMode: 'personal_manual' });
  t.after(() => context.cleanup());
  const service = new OrderService({ ...context, sub2api: {}, clock: () => initialTime });
  for (let index = 0; index < 9; index += 1) {
    const order = service.create(user, '1.00');
    service.cancel(order.id, user);
    assert.equal(service.dailyOrderLimit.status(user.id).remaining, 9 - index);
  }
  const last = service.create(user, '1.00');
  const audits = context.db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count;
  assert.throws(() => service.create(user, '1.00'), (error) => {
    assert.equal(error.code, 'DAILY_ORDER_LIMIT_REACHED');
    assert.equal(error.status, 429);
    assert.equal(error.details.dailyOrderLimit.remaining, 0);
    return true;
  });
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM recharge_orders').get().count, 10);
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count, audits);
  assert.equal(service.canAccessQr(last.id, user), true);
  service.cancel(last.id, user);
  assert.equal(service.dailyOrderLimit.status(user.id).remaining, 0);
  assert.equal(service.dailyOrderLimit.status(43).remaining, 10);
  assert.equal(service.create({ ...user, id: 43 }, '1.00').userId, '43');
});

test('expired and completed orders count while invalid and rolled-back creations consume no quota', (t) => {
  const context = createTestContext({ paymentMode: 'personal_manual', maxActiveOrders: 20, orderTtlMinutes: 3 });
  t.after(() => context.cleanup());
  let now = initialTime;
  const service = new OrderService({ ...context, sub2api: {}, clock: () => now });
  assert.throws(() => service.create(user, '0.01'));
  assert.equal(service.dailyOrderLimit.status(user.id).used, 0);
  context.db.exec(`
    CREATE TRIGGER fail_creation_audit BEFORE INSERT ON audit_events
    WHEN NEW.event_type = 'ORDER_CREATED'
    BEGIN SELECT RAISE(ABORT, 'test audit failure'); END;
  `);
  assert.throws(() => service.create(user, '1.00'));
  assert.equal(service.dailyOrderLimit.status(user.id).used, 0);
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM recharge_orders').get().count, 0);
  context.db.exec('DROP TRIGGER fail_creation_audit');
  const completed = service.create(user, '1.00');
  context.db.prepare("UPDATE recharge_orders SET status = 'completed' WHERE id = ?").run(completed.id);
  const expired = service.create(user, '1.00');
  now = new Date(initialTime.getTime() + 3 * 60000);
  assert.equal(service.getForUser(expired.id, user.id).status, 'expired');
  assert.equal(service.dailyOrderLimit.status(user.id).used, 2);
});

test('historical orders survive restart and the quota resets exactly at Shanghai midnight', (t) => {
  const context = createTestContext({ paymentMode: 'personal_manual' });
  let db = context.db;
  t.after(() => { if (db.open) db.close(); context.cleanup(); });
  let now = new Date('2026-10-11T15:59:59.000Z');
  const service = new OrderService({ ...context, sub2api: {}, clock: () => now });
  for (let index = 0; index < 10; index += 1) {
    const order = service.create(user, '1.00');
    service.cancel(order.id, user);
  }
  db.close();
  db = createDatabase(context.databasePath, context.config.secret);
  const restarted = new OrderService({ db, config: context.config, sub2api: {}, clock: () => now });
  assert.deepEqual(restarted.dailyOrderLimit.status(user.id), {
    limit: 10, used: 10, remaining: 0, day: '2026-10-11',
    timeZone: 'Asia/Shanghai', resetsAt: '2026-10-11T16:00:00.000Z'
  });
  assert.throws(() => restarted.create(user, '1.00'), { code: 'DAILY_ORDER_LIMIT_REACHED' });
  now = new Date('2026-10-11T16:00:00.000Z');
  assert.equal(restarted.dailyOrderLimit.status(user.id).remaining, 10);
  assert.equal(restarted.dailyOrderLimit.status(user.id).day, '2026-10-12');
  restarted.create(user, '1.00');
  assert.equal(restarted.dailyOrderLimit.status(user.id).remaining, 9);
});

test('official reservations share the personal quota and uncertain creations remain counted after restart', (t) => {
  const context = createTestContext({ paymentMode: 'personal_manual' });
  let db = context.db;
  t.after(() => { if (db.open) db.close(); context.cleanup(); });
  const service = new OrderService({ ...context, sub2api: {}, clock: () => initialTime });
  for (let index = 0; index < 8; index += 1) {
    const order = service.create(user, '1.00');
    service.cancel(order.id, user);
  }
  const quota = service.dailyOrderLimit;
  const confirmed = quota.reserveOfficial(user.id);
  quota.confirmOfficial(confirmed, 123);
  quota.releaseOfficial(confirmed);
  quota.reserveOfficial(user.id);
  assert.throws(() => quota.reserveOfficial(user.id), { code: 'DAILY_ORDER_LIMIT_REACHED' });
  assert.throws(() => service.create(user, '1.00'), { code: 'DAILY_ORDER_LIMIT_REACHED' });
  db.close();
  db = createDatabase(context.databasePath, context.config.secret);
  const restarted = new DailyOrderLimit({ db, clock: () => initialTime });
  assert.equal(restarted.status(user.id).used, 10);
  assert.throws(() => restarted.reserveOfficial(user.id), { code: 'DAILY_ORDER_LIMIT_REACHED' });
});
