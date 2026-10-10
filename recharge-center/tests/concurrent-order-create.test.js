'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const test = require('node:test');
const assert = require('node:assert/strict');
const { OrderService } = require('../src/order-service');
const { createTestContext } = require('./helpers');

const now = new Date('2026-10-10T04:00:00.000Z');

async function concurrentlyCreate(t, { workerCount, ordersPerWorker, paymentMode, sharedUserId = null, maxActiveOrders = 1 }) {
  const context = createTestContext({
    paymentMode,
    maxActiveOrders,
    automaticPersonalMode: true,
    accountLogStaticMode: paymentMode === 'personal_accountlog_static',
    orderTtlMinutes: 3,
    accountLogAmountQuarantineSeconds: 900,
    autoReservationLimit: 100,
    publicUrl: 'https://pay.example.test',
    alipayStaticQrUrl: 'https://qr.alipay.com/fkxSTATICCODE123456',
    alipayAppId: '2026100700000001'
  });
  const workers = [];
  t.after(async () => {
    await Promise.all(workers.map((worker) => worker.terminate()));
    context.cleanup();
  });
  new OrderService({ db: context.db, config: context.config, sub2api: {}, clock: () => now });
  const gate = new SharedArrayBuffer(4);
  const ready = [];
  const completed = [];
  for (let index = 0; index < workerCount; index += 1) {
    const worker = new Worker(path.join(__dirname, 'fixtures', 'order-create-worker.js'), {
      workerData: {
        databasePath: context.databasePath, config: context.config, now: now.toISOString(), gate,
        userIds: Array.from({ length: ordersPerWorker }, (_, offset) => sharedUserId ?? index * ordersPerWorker + offset + 1)
      }
    });
    workers.push(worker);
    ready.push(new Promise((resolve, reject) => {
      let initialized = false;
      worker.on('message', (message) => {
        if (message.type === 'ready') { initialized = true; resolve(); }
      });
      worker.once('error', reject);
      worker.once('exit', (code) => {
        if (!initialized) reject(new Error(`Order worker exited before initialization with code ${code}`));
      });
    }));
    completed.push(new Promise((resolve, reject) => {
      let results;
      worker.on('message', (message) => { if (message.type === 'result') results = message.results; });
      worker.once('error', reject);
      worker.once('exit', (code) => {
        if (code !== 0 || !results) reject(new Error(`Order worker exited with code ${code}`));
        else resolve(results);
      });
    }));
  }
  const workerResults = Promise.all(completed);
  workerResults.catch(() => {});
  await Promise.all(ready);
  Atomics.store(new Int32Array(gate), 0, 1);
  Atomics.notify(new Int32Array(gate), 0, workerCount);
  return { context, results: (await workerResults).flat() };
}

test('simultaneous static-code orders reserve unique amounts across eight database connections', { timeout: 15000 }, async (t) => {
  const { context, results } = await concurrentlyCreate(t, {
    workerCount: 8, ordersPerWorker: 4, paymentMode: 'personal_accountlog_static'
  });
  assert.deepEqual(results.filter((result) => result.errorCode), []);
  const amounts = results.map(({ order }) => Math.round(Number(order.payableAmount) * 100)).sort((a, b) => a - b);
  assert.deepEqual(amounts, Array.from({ length: 32 }, (_, offset) => 100 + offset));
  assert.equal(new Set(results.map(({ order }) => order.id)).size, 32);
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM amount_reservations').get().count, 32);
  for (const { userId, order } of results) {
    assert.equal(Number(order.userId), userId);
    assert.equal(order.creditAmount, order.payableAmount);
  }
});

for (const paymentMode of ['personal_accountlog_static', 'personal_transfer_auto']) {
  test(`simultaneous ${paymentMode} orders stop at 100 reservations and roll back every excess order`, { timeout: 15000 }, async (t) => {
    const { context, results } = await concurrentlyCreate(t, { workerCount: 8, ordersPerWorker: 15, paymentMode });
    const successes = results.filter((result) => result.order);
    const failures = results.filter((result) => result.errorCode);
    assert.equal(successes.length, 100, JSON.stringify(failures));
    assert.equal(failures.length, 20);
    assert.ok(failures.every((result) => result.errorCode === 'AUTO_ORDER_CAPACITY_REACHED'));
    const amounts = successes.map(({ order }) => Math.round(Number(order.payableAmount) * 100)).sort((a, b) => a - b);
    assert.deepEqual(amounts, Array.from({ length: 100 }, (_, offset) => 100 + offset));
    assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM amount_reservations').get().count, 100);
    assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM recharge_orders').get().count, 100);
  });
}

test('simultaneous requests for one user cannot bypass the active-order limit', { timeout: 15000 }, async (t) => {
  const { context, results } = await concurrentlyCreate(t, {
    workerCount: 8, ordersPerWorker: 1, paymentMode: 'personal_accountlog_static', sharedUserId: 42
  });
  const successes = results.filter((result) => result.order);
  const failures = results.filter((result) => result.errorCode);
  assert.equal(successes.length, 1);
  assert.equal(successes[0].order.userId, '42');
  assert.equal(successes[0].order.payableAmount, '1.00');
  assert.equal(failures.length, 7);
  assert.ok(failures.every((result) => result.errorCode === 'ACTIVE_ORDER_EXISTS'));
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM amount_reservations').get().count, 1);
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM recharge_orders').get().count, 1);
});

test('simultaneous requests across eight connections cannot create more than ten daily orders for one user', { timeout: 15000 }, async (t) => {
  const { context, results } = await concurrentlyCreate(t, {
    workerCount: 8, ordersPerWorker: 3, paymentMode: 'personal_accountlog_static',
    sharedUserId: 42, maxActiveOrders: 20
  });
  assert.equal(results.filter((result) => result.order).length, 10);
  const failures = results.filter((result) => result.errorCode);
  assert.equal(failures.length, 14);
  assert.ok(failures.every((result) => result.errorCode === 'DAILY_ORDER_LIMIT_REACHED'));
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM recharge_orders').get().count, 10);
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM amount_reservations').get().count, 10);
  assert.equal(context.db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'ORDER_CREATED'").get().count, 10);
});
