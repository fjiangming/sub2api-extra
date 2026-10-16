'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SettingsStore } = require('../src/settings');
const { DEFAULT_RULES } = require('../src/simulation');
const { memoryDatabase, insertUsers, insertLogs, service } = require('./helpers');

async function setup(t, users, logs, rules = DEFAULT_RULES) {
  const db = await memoryDatabase();
  t.after(() => db.close());
  await insertUsers(db, users); await insertLogs(db, logs);
  const dependencies = service(db);
  const settings = new SettingsStore(dependencies.config, { now: () => new Date('2026-10-13T03:30:00Z') });
  dependencies.leaderboard.settings = settings;
  settings.onPublish = () => dependencies.leaderboard.invalidate();
  const generated = await settings.generate({ revision: 0, rules });
  await settings.publish({ revision: generated.revision, source: 'simulation' }, 'admin');
  return { db, settings, ...dependencies };
}

test('PostgreSQL includes only real users within both board bounds in every period and metric; personal usage stays real', async (t) => {
  const users = [{ id: 2, email: 'actual@example.com' }, { id: 3 }, { id: 4 }, { id: 5, status: 'disabled' }, { id: 6, role: 'admin' }, { id: 7 }];
  const quantities = [1500123, 70000123, 999999, 9000000, 6000000, 1500000123];
  const logs = users.map((user, i) => ({ user_id: user.id, created_at: '2026-10-13T02:00Z', input_tokens: quantities[i] }));
  const { settings, leaderboard } = await setup(t, users, logs);
  for (const period of ['today', 'week', 'month', 'all']) for (const metric of ['tokens', 'requests']) {
    const board = await leaderboard.get(period, metric, '2');
    assert.equal(board.display.mode, 'mixed');
    assert.equal(board.display.realCount, 2);
    assert.equal(board.display.simulatedCount, 8);
    assert.equal(board.entries.length, 10);
    assert.deepEqual(board.entries.filter((row) => row.source === 'real').map((row) => row.tokens).sort((a, b) => a - b), quantities.slice(0, 2));
    assert.equal(board.entries.find((row) => row.name === 'ac***@example.com').tokens, 1500123);
    assert.equal(board.me.tokens, 1500123);
    assert.equal(board.me.requests, 1);
    assert.equal(board.me.trendTotal, 1500123);
    assert.equal(board.me.models[0].tokens, 1500123);
    assert.equal(board.me.rank, null);
    assert.equal(board.me.next, null);
    assert.equal(board.me.percentile, null);
    assert.equal(board.me.rankingAvailable, false);
    assert.equal(board.summary.tokens, board.entries.reduce((sum, row) => sum + row.tokens, 0));
    assert.ok(board.entries.every((row, i, rows) => !i || rows[i - 1][metric] >= row[metric]));
    assert.ok(!/actual@example.com|qualifiedEntries|"seed"|"draft"|"rules"|"email"|actual_cost/.test(JSON.stringify(board)));
  }
  await settings.publish({ revision: settings.snapshot().revision, source: 'real' }, 'admin');
  const restored = await leaderboard.get('month', 'tokens', '2');
  assert.equal(restored.display.mode, 'real');
  assert.equal(restored.me.rank, 3);
  assert.equal(restored.me.rankingAvailable, true);
  assert.equal(restored.summary.tokens, quantities[0] + quantities[1] + quantities[2] + quantities[5]);
});

test('board bounds precede SQL cutoff and simulation bounds, and drafts, publication and rollback retain the right ranges', async (t) => {
  const users = Array.from({ length: 17 }, (_, i) => ({ id: i + 2 }));
  const quantities = [4e6, 5e6, 10e6, 60e6, 60e6 + 1, ...Array.from({ length: 12 }, (_, i) => 100e6 + i)];
  const logs = users.map((user, i) => ({ user_id: user.id, created_at: '2026-10-13T02:00Z', input_tokens: quantities[i] }));
  const rules = { ...DEFAULT_RULES, minimumTokens: 20e6, maximumTokens: 100e6, boardMinimumTokens: 5e6, boardMaximumTokens: 60e6 };
  const { settings, leaderboard } = await setup(t, users, logs, rules);
  for (const period of ['today', 'week', 'month', 'all']) for (const metric of ['tokens', 'requests']) {
    const board = await leaderboard.get(period, metric, '4');
    assert.equal(board.entries.length, 10);
    assert.equal(board.display.realCount, 3);
    assert.equal(board.display.simulatedCount, 7);
    assert.deepEqual(board.entries.filter((row) => row.source === 'real').map((row) => row.tokens).sort((a, b) => a - b), [5e6, 10e6, 60e6]);
    assert.ok(board.entries.every((row) => row.tokens >= 5e6 && row.tokens <= 60e6));
    assert.ok(board.entries.filter((row) => row.source === 'simulation').every((row) => row.tokens >= 20e6));
    assert.ok(board.entries.every((row, i, rows) => !i || rows[i - 1][metric] >= row[metric]));
    assert.equal(board.summary.tokens, board.entries.reduce((sum, row) => sum + row.tokens, 0));
    assert.equal(board.me.tokens, 10e6);
    assert.equal(board.me.rankingAvailable, false);
    if (metric === 'tokens') {
      assert.equal(board.entries[0].tokens, 60e6);
      assert.equal(board.entries.at(-1).tokens, 5e6);
    }
  }
  const before = await leaderboard.get('month', 'tokens', '4');
  const changed = { ...rules, boardMinimumTokens: 25e6, boardMaximumTokens: 50e6 };
  await settings.generate({ revision: settings.snapshot().revision, rules: changed });
  const preview = await leaderboard.preview(settings.draftCandidate(), 'month', 'tokens');
  assert.equal(preview.display.realCount, 0);
  assert.ok(preview.entries.every((row) => row.tokens >= 25e6 && row.tokens <= 50e6));
  assert.deepEqual((await leaderboard.get('month', 'tokens', '4')).entries, before.entries);
  await settings.publish({ revision: settings.snapshot().revision, source: 'simulation' }, 'admin');
  const live = await leaderboard.get('month', 'tokens', '4');
  assert.deepEqual(live.entries, preview.entries);
  await settings.rollback({ revision: settings.snapshot().revision }, 'admin');
  assert.deepEqual((await leaderboard.get('month', 'tokens', '4')).entries, before.entries);
});

test('ten qualifying real users turn simulation into the actual Top 10, including stable cutoff and personal ranking', async (t) => {
  const users = Array.from({ length: 12 }, (_, i) => ({ id: i + 2 }));
  const logs = users.map((user, i) => ({ user_id: user.id, created_at: '2026-10-13T02:00Z', input_tokens: 2000000 + i }));
  const { leaderboard } = await setup(t, users, logs);
  for (const metric of ['tokens', 'requests']) {
    const board = await leaderboard.get('month', metric, '2');
    assert.equal(board.display.mode, 'real');
    assert.equal(board.display.simulatedCount, 0);
    assert.equal(board.entries.length, 10);
    assert.ok(board.entries.every((row) => row.source === 'real'));
    assert.equal(board.me.rankingAvailable, true);
    assert.equal(board.me.rank, metric === 'tokens' ? 12 : 1);
    assert.equal(board.summary.active, 12);
  }
});

test('publication during an in-flight database query cannot return or reuse the previous simulated view', async (t) => {
  const { leaderboard, repository, inspector, settings } = await setup(t, [{ id: 2 }], [{ user_id: 2, created_at: '2026-10-13T02:00Z', input_tokens: 1700123 }]);
  await inspector.inspect();
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const running = new Promise((resolve) => { started = resolve; });
  const boardQuery = repository.board.bind(repository);
  let first = true;
  repository.board = async (...args) => {
    const raw = await boardQuery(...args);
    if (first) { first = false; started(); await gate; }
    return raw;
  };
  const pending = leaderboard.get('month', 'tokens', '2');
  await running;
  await settings.publish({ revision: settings.snapshot().revision, source: 'real' }, 'admin');
  release();
  const result = await pending;
  assert.equal(result.display.mode, 'real');
  assert.equal(result.entries.length, 1);
  assert.equal((await leaderboard.get('month', 'tokens', '2')).display.mode, 'real');
});

test('request sorting cannot displace qualifying real users with below-floor high-frequency users', async (t) => {
  const users = Array.from({ length: 11 }, (_, i) => ({ id: i + 2 }));
  const logs = users.map((user) => ({ user_id: user.id, created_at: '2026-10-13T02:00Z', input_tokens: user.id === 12 ? 1000 : 2000123 }));
  logs.push(...Array.from({ length: 9 }, () => ({ user_id: 12, created_at: '2026-10-13T02:00Z', input_tokens: 1000 })));
  const { leaderboard } = await setup(t, users, logs);
  const scoped = await leaderboard.get('month', 'requests', '2');
  assert.equal(scoped.display.mode, 'priority');
  assert.equal(scoped.display.realCount, 10);
  assert.equal(scoped.display.simulatedCount, 0);
  assert.ok(scoped.entries.every((row) => row.tokens === 2000123 && row.source === 'real'));
  assert.equal(scoped.summary.tokens, 2000123 * 10);
  assert.equal(scoped.me.rankingAvailable, false);
  assert.equal(scoped.me.rank, null);
  assert.equal(scoped.me.next, null);
  const tokens = await leaderboard.get('month', 'tokens', '2');
  assert.equal(tokens.display.mode, 'real');
  assert.equal(tokens.me.rankingAvailable, true);
});
