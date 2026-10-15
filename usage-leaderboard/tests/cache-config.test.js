'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { BoundedCache } = require('../src/cache');
const { loadConfig } = require('../src/config');
const { publicIdentity, maskEmail } = require('../src/identity');

test('cache deduplicates concurrent loads, expires entries, evicts old values, and retries errors', async () => {
  let clock = 0;
  let calls = 0;
  const cache = new BoundedCache({ ttlMs: 10, maxEntries: 2, now: () => clock });
  const load = async () => { calls++; return calls; };
  assert.deepEqual(await Promise.all([cache.getOrLoad('one', load), cache.getOrLoad('one', load)]), [1, 1]);
  await cache.getOrLoad('two', load);
  await cache.getOrLoad('one', load);
  await cache.getOrLoad('three', load);
  assert.equal(cache.items.size, 2);
  assert.ok(!cache.items.has('two'));
  clock = 10;
  assert.equal(await cache.getOrLoad('one', load), 4);
  await assert.rejects(cache.getOrLoad('failed', async () => { throw new Error('failure'); }));
  assert.ok(!cache.pending.has('failed'));
  assert.equal(await cache.getOrLoad('failed', load), 5);
});

test('pending cache work is bounded independently of cached entries', async () => {
  const cache = new BoundedCache({ ttlMs: 100, maxEntries: 2, maxPending: 1 });
  let resolve;
  const pending = cache.getOrLoad('one', () => new Promise((done) => { resolve = done; }));
  await Promise.resolve();
  await assert.rejects(cache.getOrLoad('two', async () => 2), { code: 'SERVICE_BUSY' });
  resolve(1);
  assert.equal(await pending, 1);
  assert.equal(cache.pending.size, 0);
});

test('config validates timezone, transport settings and database URL without leaking credentials', () => {
  const config = loadConfig({ NODE_ENV: 'test' });
  assert.equal(config.port, 9876);
  assert.equal(config.databaseUrl, null);
  assert.equal(config.trustProxy, false);
  assert.equal(config.forwardClientFingerprint, false);
  assert.equal(config.settingsDir, null);
  assert.equal(loadConfig({ USAGE_LEADERBOARD_SETTINGS_DIR: './settings' }).settingsDir, path.resolve('settings'));
  for (const directory of ['public', path.join('public', 'nested')]) {
    assert.throws(() => loadConfig({ USAGE_LEADERBOARD_SETTINGS_DIR: path.join(config.projectRoot, directory) }), /SETTINGS_DIR/);
  }
  assert.throws(() => loadConfig({ SUB2API_TIMEZONE: 'invalid-zone' }), /SUB2API_TIMEZONE/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /HTTPS/);
  assert.throws(() => loadConfig({ SUB2API_DATABASE_URL: 'postgres://u:sensitive-password@localhost/db?options=unsafe' }), (error) => !error.message.includes('sensitive-password'));
  assert.throws(() => loadConfig({ SUB2API_BASE_URL: 'https://user:secret@example.com' }), (error) => !error.message.includes('secret'));
  assert.throws(() => loadConfig({ USAGE_LEADERBOARD_CACHE_SECONDS: '0' }), /CACHE_SECONDS/);
  assert.throws(() => loadConfig({ USAGE_LEADERBOARD_TRUST_PROXY: 'yes' }), /TRUST_PROXY/);
  assert.equal(loadConfig({ NODE_ENV: 'production', SUB2API_PUBLIC_URL: 'https://station.example.com' }).cookieSecure, true);
});

test('registered email masks hide short local parts, aliases and length, with stable anonymous fallbacks', () => {
  for (const [email, expected] of [
    ['secret@example.com', 'se***@example.com'],
    ['a@example.com', '***@example.com'],
    ['ab@example.com', 'a***@example.com'],
    ['abc@example.com', 'ab***@example.com'],
    ['abcdefghijk@example.com', 'ab***@example.com'],
    ['a+private-alias@example.com', '***@example.com'],
    ['ab+private-alias@example.com', 'a***@example.com'],
    ['  User@EXAMPLE.COM  ', 'Us***@example.com'],
    [`${'x'.repeat(60)}@example.com`, 'xx***@example.com']
  ]) {
    assert.equal(maskEmail(email), expected);
    assert.equal(publicIdentity(1, email).name, expected);
    assert.ok(!expected.includes(email.trim()));
  }
  const anonymous = publicIdentity(1, '');
  assert.match(anonymous.name, /^创造者 [A-F0-9]{6}$/);
  for (const email of ['', null, undefined, 'nickname', 'a@@example.com', 'a@localhost',
    '<img src=x onerror=alert(1)>@example.com', 'a\u202e\0b@example.com', 'user@evil.com\nprivate@example.com',
    `${'x'.repeat(250)}@example.com`, { email: 'secret@example.com' }]) {
    assert.equal(maskEmail(email), null);
    assert.deepEqual(publicIdentity(1, email), anonymous);
  }
  assert.equal(anonymous.key, publicIdentity(1, 'secret@example.com').key);
  assert.equal(anonymous.avatar, publicIdentity(1, 'changed@example.net').avatar);
  assert.notEqual(anonymous.key, publicIdentity(2, '').key);
});
