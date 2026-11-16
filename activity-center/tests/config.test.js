'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');
const base = { SUB2API_ADMIN_API_KEY: 'synthetic-admin-key',SUB2API_DATABASE_URL: 'postgres://synthetic:synthetic@localhost/test' };
test('configuration fails closed on missing funding integration, invalid scope and public data paths', () => {
  for (const extra of [{ SUB2API_DATABASE_URL: '' },{ SUB2API_DATABASE_URL: 'https://example.test/database' },{ ACTIVITY_CENTER_RECHARGE_SOURCES: 'balance' },
    { ACTIVITY_CENTER_RECHARGE_SOURCES: 'redemptions,official' },{ ACTIVITY_CENTER_RECHARGE_SOURCES: ',' },{ ACTIVITY_CENTER_PUBLIC_URL: 'https://user:secret@example.test' },
    { SUB2API_PUBLIC_URLS: 'https://*.example.test' },{ ACTIVITY_CENTER_DATA_DIR: './public/database' },{ SUB2API_TIMEZONE: 'invalid' },
    { NODE_ENV: 'production' },{ ACTIVITY_CENTER_START_AT: 'not a date' }]) assert.throws(() => loadConfig({ ...base,...extra }));
  assert.equal(loadConfig(base).port,9878);
  assert.deepEqual(loadConfig(base).sources,['redemptions']);
});

test('legacy source settings normalize to redemptions without requiring the retired recharge API', () => {
  for (const sources of ['official','recharge_center','official,recharge_center']) {
    const cfg = loadConfig({ ...base,ACTIVITY_CENTER_RECHARGE_SOURCES: sources });
    assert.deepEqual(cfg.sources,['redemptions']);
  }
});

test('campaign start cannot be overridden to count historical payments or defer startup', () => {
  for (const value of ['2020-01-01T00:00:00Z','2099-01-01T00:00:00Z']) {
    assert.throws(() => loadConfig({ ...base,ACTIVITY_CENTER_START_AT: value }),/ACTIVITY_CENTER_START_AT/);
  }
  assert.doesNotThrow(() => loadConfig({ ...base,ACTIVITY_CENTER_START_AT: '' }));
});
