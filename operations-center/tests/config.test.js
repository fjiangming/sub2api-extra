'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');
const { parseDateRange, dateInTimezone } = require('../src/services/metrics-service');

function baseEnv(overrides = {}) {
  return {
    NODE_ENV: 'test',
    OPERATIONS_CENTER_ADMIN_PASSWORD: 'correct-horse-battery',
    SUB2API_DATABASE_URL: 'postgresql://reader@example.test/sub2api',
    ...overrides
  };
}

test('cleanup requires an explicit maintenance connection', () => {
  assert.throws(
    () => loadConfig(baseEnv({ OPERATIONS_CENTER_ENABLE_CLEANUP: 'true' })),
    /SUB2API_MAINTENANCE_DATABASE_URL/
  );
  const config = loadConfig(baseEnv({
    OPERATIONS_CENTER_ENABLE_CLEANUP: 'true',
    SUB2API_MAINTENANCE_DATABASE_URL: 'postgresql://maintainer@example.test/sub2api'
  }));
  assert.equal(config.cleanupEnabled, true);
  assert.match(config.maintenanceDatabaseUrl, /^postgresql:/);
});

test('invalid IANA timezone is rejected', () => {
  assert.throws(() => loadConfig(baseEnv({ SUB2API_TIMEZONE: 'Mars/Olympus' })), /IANA/);
});

test('date ranges are inclusive and bounded', () => {
  assert.deepEqual(parseDateRange({ start: '2026-09-01', end: '2026-09-30' }), {
    start: '2026-09-01',
    end: '2026-09-30',
    endExclusive: '2026-10-01',
    days: 30
  });
  assert.throws(() => parseDateRange({ start: '2026-10-01', end: '2026-09-30' }), /结束日期/);
  assert.throws(() => parseDateRange({ start: '2020-01-01', end: '2026-01-01' }, { maxDays: 30 }), /最多 30 天/);
});

test('timezone date does not silently use UTC', () => {
  const instant = new Date('2026-09-20T16:30:00Z');
  assert.equal(dateInTimezone('UTC', instant), '2026-09-20');
  assert.equal(dateInTimezone('Asia/Shanghai', instant), '2026-09-21');
});
