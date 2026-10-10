'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const Database = require('better-sqlite3');
const { OrderService } = require('../../src/order-service');

const db = new Database(workerData.databasePath, { timeout: 5000 });
db.pragma('foreign_keys = ON');
const service = new OrderService({
  db,
  config: workerData.config,
  sub2api: {},
  clock: () => new Date(workerData.now)
});
parentPort.postMessage({ type: 'ready' });
Atomics.wait(new Int32Array(workerData.gate), 0, 0);

const results = [];
try {
  for (const id of workerData.userIds) {
    try {
      const order = service.create({ id, emailMasked: `u${id}***@example.test`, role: 'user' }, '1.00');
      results.push({ userId: id, order });
    } catch (error) {
      results.push({ userId: id, errorCode: error?.code || error?.name });
    }
  }
} finally {
  db.close();
}
parentPort.postMessage({ type: 'result', results });
