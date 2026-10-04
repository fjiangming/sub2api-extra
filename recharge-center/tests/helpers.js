'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDatabase } = require('../src/db');

function createTestContext(overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recharge-center-test-'));
  const secret = 'test-secret-0123456789abcdef0123456789abcdef';
  const config = {
    env: 'test',
    secret,
    quickAmounts: [10, 50, 100],
    allowedAmounts: [10, 50, 100],
    minAmount: 1,
    maxAmount: 1000000,
    maxActiveOrders: 1,
    orderTtlMinutes: 20,
    reviewTtlHours: 72,
    fulfillmentLeaseMinutes: 5,
    listenerMaxEventAgeSeconds: 600,
    ...overrides
  };
  const databasePath = path.join(directory, 'test.db');
  const db = createDatabase(databasePath, secret);
  return {
    directory,
    databasePath,
    config,
    db,
    cleanup() {
      if (db.open) db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

module.exports = { createTestContext };
