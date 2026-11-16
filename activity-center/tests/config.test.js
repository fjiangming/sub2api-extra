'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');
const base = { SUB2API_ADMIN_API_KEY: 'synthetic-admin-key',ACTIVITY_CENTER_RECHARGE_URL: 'http://localhost:9874',ACTIVITY_CENTER_RECHARGE_TOKEN: 't'.repeat(32) };
test('configuration fails closed on missing funding integration, invalid scope and public data paths', () => {
  for (const extra of [{ ACTIVITY_CENTER_RECHARGE_URL: '' },{ ACTIVITY_CENTER_RECHARGE_TOKEN: 'short' },{ ACTIVITY_CENTER_RECHARGE_SOURCES: 'balance' },
    { ACTIVITY_CENTER_RECHARGE_SOURCES: 'official' },{ ACTIVITY_CENTER_PUBLIC_URL: 'https://user:secret@example.test' },
    { SUB2API_PUBLIC_URLS: 'https://*.example.test' },{ ACTIVITY_CENTER_DATA_DIR: './public/database' },{ SUB2API_TIMEZONE: 'invalid' },
    { NODE_ENV: 'production' },{ ACTIVITY_CENTER_START_AT: 'not a date' }]) assert.throws(() => loadConfig({ ...base,...extra }));
  assert.equal(loadConfig(base).port,9878);
});

test('campaign start cannot be overridden to count historical payments or defer startup', () => {
  for (const value of ['2020-01-01T00:00:00Z','2099-01-01T00:00:00Z']) {
    assert.throws(() => loadConfig({ ...base,ACTIVITY_CENTER_START_AT: value }),/ACTIVITY_CENTER_START_AT/);
  }
  assert.doesNotThrow(() => loadConfig({ ...base,ACTIVITY_CENTER_START_AT: '' }));
});
