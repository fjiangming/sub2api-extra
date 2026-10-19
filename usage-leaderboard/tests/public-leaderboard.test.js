'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { publicIdentity } = require('../src/identity');
const { publicProfile, publicLeaderboard } = require('../src/public-leaderboard');

test('display serialization excludes internal fields at every level without changing admin data', () => {
  const privateField = { internalNote: 'DO_NOT_PUBLISH' };
  const me = { ...publicIdentity(7, 'reader@gmail.com'), ...privateField, tokens: 100, requests: 2,
    source: 'real', rank: null, rankingAvailable: false, boardRank: 2,
    trend: [{ date: '2026-10-19', tokens: 100, ...privateField }], trendTotal: 100, trendGrowth: null,
    models: [{ name: 'gpt-5', tokens: 100, requests: 2, ...privateField }] };
  const board = { period: 'today', metric: 'tokens', generatedAt: '2026-10-19T03:00:00Z', timezone: 'Asia/Shanghai',
    window: { start: '2026-10-18T16:00:00Z', end: '2026-10-19T03:00:00Z', ...privateField },
    display: { mode: 'mixed', realCount: 1, simulatedCount: 1, snapshotAt: '2026-10-19T02:55:00Z' },
    summary: { tokens: 300, active: 2 }, ...privateField,
    entries: [{ key: 'sim_0123456789abcdef', name: '12***@qq.com', tokens: 200, requests: 3,
      rank: 1, source: 'simulation', comparisonAvailable: false, ...privateField }, { ...me, rank: 2 }], me };
  const before = structuredClone(board);
  const visible = publicLeaderboard(board);
  assert.doesNotMatch(JSON.stringify(visible), /DO_NOT_PUBLISH|sim_|simulation|source|display|summary|boardRank|rankingAvailable/);
  assert.equal(visible.me.tokens, me.tokens);
  assert.deepEqual(visible.me.models, [{ name: 'gpt-5', tokens: 100, requests: 2 }]);
  assert.equal(visible.entries[1].key, visible.me.key);
  assert.equal(visible.me.key, publicProfile(me).key);
  assert.deepEqual(Object.keys(visible.entries[0]), Object.keys(visible.entries[1]));
  assert.deepEqual(board, before);
});

test('all public profiles use opaque identifiers and anonymous names cannot reveal the original identifier', () => {
  const account = publicIdentity(123);
  const profile = publicProfile(account);
  assert.match(profile.key, /^[a-f0-9]{16}$/);
  assert.notEqual(profile.key, account.key);
  assert.notEqual(profile.name, account.name);
  assert.deepEqual(publicProfile(account), profile);
  assert.notEqual(publicProfile(publicIdentity(124)).key, profile.key);
  assert.deepEqual(publicProfile({ ...account, source: 'simulation' }), profile);
  for (const domain of ['example.com', 'example.net', 'example.org']) {
    assert.equal(publicProfile({ ...account, name: `ab***@${domain}` }).name, profile.name);
    assert.equal(publicProfile({ ...account, name: `ab***@${domain}`, source: 'simulation' }).name, profile.name);
  }
  const generated = publicProfile({ key: 'sim_0123456789abcdef', name: 'ab***@gmail.com' });
  assert.match(generated.key, /^[a-f0-9]{16}$/);
  assert.deepEqual(Object.keys(generated), Object.keys(profile));
});
