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

test('PostgreSQL retains above-ceiling real users and excludes below-floor users in every period and metric; personal usage stays real', async (t) => {
  const users = [{ id: 2, email: 'actual@example.com' }, { id: 3 }, { id: 4 }, { id: 5, status: 'disabled' }, { id: 6, role: 'admin' }, { id: 7 }];
  const quantities = [1500123, 70000123, 999999, 9000000, 6000000, 1500000123];
  const logs = users.map((user, i) => ({ user_id: user.id, created_at: '2026-10-13T02:00Z', input_tokens: quantities[i] }));
  const { settings, leaderboard } = await setup(t, users, logs);
  for (const period of ['today', 'week', 'month', 'all']) for (const metric of ['tokens', 'requests']) {
    const board = await leaderboard.get(period, metric, '2');
    assert.equal(board.display.mode, 'mixed');
    assert.equal(board.display.realCount, 3);
    assert.equal(board.display.simulatedCount, 7);
    assert.equal(board.entries.length, 10);
    assert.deepEqual(board.entries.filter((row) => row.source === 'real').map((row) => row.tokens).sort((a, b) => a - b), [quantities[0], quantities[1], quantities[5]]);
    assert.ok(board.entries.filter((row) => row.source === 'simulation').every((row) => row.tokens <= DEFAULT_RULES.boardMaximumTokens));
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

test('the real floor precedes SQL cutoff and real contenders can beat it by requests; drafts, publication and rollback retain their rules', async (t) => {
  const users = Array.from({ length: 17 }, (_, i) => ({ id: i + 2 }));
  const quantities = [4e6, 5e6, 10e6, 60e6, 60e6 + 1, ...Array.from({ length: 12 }, (_, i) => 1e6 + i)];
  const logs = users.map((user, i) => ({ user_id: user.id, created_at: '2026-10-13T02:00Z', input_tokens: quantities[i] }));
  logs.push(...users.slice(5).flatMap((user) => Array.from({ length: 2 }, () => ({ user_id: user.id, created_at: '2026-10-13T02:00Z', input_tokens: 0 }))));
  const rules = { ...DEFAULT_RULES, minimumTokens: 20e6, maximumTokens: 100e6, boardMinimumTokens: 5e6, boardMaximumTokens: 60e6 };
  const { settings, leaderboard } = await setup(t, users, logs, rules);
  for (const period of ['today', 'week', 'month', 'all']) for (const metric of ['tokens', 'requests']) {
    const board = await leaderboard.get(period, metric, '4');
    assert.equal(board.entries.length, 10);
    assert.equal(board.display.realCount, 4);
    assert.equal(board.display.simulatedCount, 6);
    const real = board.entries.filter((row) => row.source === 'real');
    if (metric === 'tokens') {
      assert.deepEqual(real.map((row) => row.tokens).sort((a, b) => a - b), [5e6, 10e6, 60e6, 60e6 + 1]);
      assert.ok(board.entries.every((row) => row.tokens >= 5e6));
    } else {
      assert.ok(real.every((row) => row.tokens < 5e6 && row.requests === 3));
    }
    assert.ok(board.entries.filter((row) => row.source === 'simulation').every((row) => row.tokens >= 20e6 && row.tokens <= 60e6));
    assert.ok(board.entries.every((row, i, rows) => !i || rows[i - 1][metric] >= row[metric]));
    assert.equal(board.summary.tokens, board.entries.reduce((sum, row) => sum + row.tokens, 0));
    assert.equal(board.me.tokens, 10e6);
    assert.equal(board.me.rankingAvailable, false);
    if (metric === 'tokens') {
      assert.equal(board.entries[0].tokens, 60e6 + 1);
      assert.equal(board.entries.at(-1).tokens, 5e6);
    }
  }
  const before = await leaderboard.get('month', 'tokens', '4');
  const changed = { ...rules, boardMinimumTokens: 25e6, boardMaximumTokens: 50e6 };
  await settings.generate({ revision: settings.snapshot().revision, rules: changed, keepIdentities: false });
  const preview = await leaderboard.preview(settings.draftCandidate(), 'month', 'tokens');
  assert.equal(preview.display.realCount, 2);
  assert.deepEqual(preview.entries.filter((row) => row.source === 'real').map((row) => row.tokens), [60e6 + 1, 60e6]);
  assert.ok(preview.entries.filter((row) => row.source === 'simulation').every((row) => row.tokens >= 25e6 && row.tokens <= 50e6));
  assert.deepEqual((await leaderboard.get('month', 'tokens', '4')).entries, before.entries);
  await settings.publish({ revision: settings.snapshot().revision, source: 'simulation' }, 'admin');
  const live = await leaderboard.get('month', 'tokens', '4');
  assert.deepEqual(live.entries, preview.entries);
  await settings.rollback({ revision: settings.snapshot().revision }, 'admin');
  assert.deepEqual((await leaderboard.get('month', 'tokens', '4')).entries, before.entries);
});

test('ten above-ceiling real users fill the actual Top 10 in every period, including stable cutoff and personal ranking', async (t) => {
  const users = Array.from({ length: 12 }, (_, i) => ({ id: i + 2 }));
  const logs = users.map((user, i) => ({ user_id: user.id, created_at: '2026-10-13T02:00Z', input_tokens: 20000000 + i }));
  const rules = { ...DEFAULT_RULES, boardMaximumTokens: 10e6 };
  const { leaderboard } = await setup(t, users, logs, rules);
  for (const period of ['today', 'week', 'month', 'all']) for (const metric of ['tokens', 'requests']) {
    const board = await leaderboard.get(period, metric, '2');
    assert.equal(board.display.mode, 'real');
    assert.equal(board.display.simulatedCount, 0);
    assert.equal(board.entries.length, 10);
    assert.ok(board.entries.every((row) => row.source === 'real'));
    assert.ok(board.entries.every((row) => row.tokens > rules.boardMaximumTokens));
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

test('a below-floor high-frequency real user enters the actual request Top 10 when ten real users meet the floor', async (t) => {
  const users = Array.from({ length: 11 }, (_, i) => ({ id: i + 2 }));
  const logs = users.map((user) => ({ user_id: user.id, created_at: '2026-10-13T02:00Z', input_tokens: user.id === 12 ? 1000 : 2000123 }));
  logs.push(...Array.from({ length: 9 }, () => ({ user_id: 12, created_at: '2026-10-13T02:00Z', input_tokens: 1000 })));
  const { leaderboard } = await setup(t, users, logs);
  const scoped = await leaderboard.get('month', 'requests', '12');
  assert.equal(scoped.display.mode, 'real');
  assert.equal(scoped.display.realCount, 10);
  assert.equal(scoped.display.simulatedCount, 0);
  assert.ok(scoped.entries.every((row) => row.source === 'real'));
  assert.equal(scoped.entries[0].key, scoped.me.key);
  assert.equal(scoped.entries[0].requests, 10);
  assert.equal(scoped.entries[0].tokens, 10000);
  assert.equal(scoped.summary.tokens, 2000123 * 10 + 10000);
  assert.equal(scoped.me.rankingAvailable, true);
  assert.equal(scoped.me.rank, 1);
  assert.equal(scoped.me.boardRank, 1);
  assert.equal(scoped.me.inLeaderboard, true);
  assert.equal(scoped.me.next, null);
  const tokens = await leaderboard.get('month', 'tokens', '2');
  assert.equal(tokens.display.mode, 'real');
  assert.equal(tokens.me.rankingAvailable, true);
});

test('real users crossing the cutoff enter both metrics after cache expiry and every viewer gets the same board', async (t) => {
  const users = Array.from({ length: 12 }, (_, i) => ({ id: i + 2 }));
  const logs = users.map((user, i) => ({ user_id: user.id, created_at: '2026-10-13T02:00Z', input_tokens: 30000000 - i * 1000000 }));
  const { db, settings, leaderboard } = await setup(t, users, logs);
  let clock = new Date('2026-10-13T03:30:00Z');
  settings.now = leaderboard.now = () => clock;
  leaderboard.boardCache.now = leaderboard.personalCache.now = () => clock.getTime();
  const before = await leaderboard.get('today', 'tokens', '13');
  assert.equal(before.me.inLeaderboard, false);
  await insertLogs(db, [{ user_id: 13, created_at: '2026-10-13T03:30:01Z', input_tokens: 100000000 }]);
  clock = new Date('2026-10-13T03:30:59Z');
  assert.deepEqual((await leaderboard.get('today', 'tokens', '13')).entries, before.entries);
  clock = new Date('2026-10-13T03:31:01Z');
  for (const period of ['today', 'week', 'month', 'all']) for (const metric of ['tokens', 'requests']) {
    const board = await leaderboard.get(period, metric, '13');
    assert.equal(board.entries[0].key, board.me.key);
    assert.equal(board.me.tokens, 119000000);
    assert.equal(board.me.requests, 2);
    assert.equal(board.me.boardRank, 1);
    assert.equal(board.me.inLeaderboard, true);
    for (const user of users) {
      const view = await leaderboard.get(period, metric, String(user.id));
      assert.deepEqual(view.entries, board.entries);
      const row = view.entries.find((entry) => entry.key === view.me.key);
      assert.equal(view.me.inLeaderboard, Boolean(row));
      assert.equal(view.me.boardRank, row?.rank ?? null);
      if (row) {
        assert.equal(row.tokens, view.me.tokens);
        assert.equal(row.requests, view.me.requests);
      } else assert.ok(view.me[metric] <= view.entries.at(-1)[metric]);
    }
  }
});

test('a real caller below the Token floor can beat the mixed cutoff in all periods without republishing', async (t) => {
  const rules = { ...DEFAULT_RULES, boardMaximumTokens: 50e6 };
  const { db, settings, leaderboard } = await setup(t, [{ id: 2 }, { id: 3 }], [{ user_id: 2, created_at: '2026-10-13T02:00Z', input_tokens: 0 }], rules);
  let clock = new Date('2026-10-13T03:30:00Z');
  settings.now = leaderboard.now = () => clock;
  leaderboard.boardCache.now = leaderboard.personalCache.now = () => clock.getTime();
  let calls = 0;
  for (const period of ['today', 'week', 'month', 'all']) {
    const board = await leaderboard.get(period, 'requests', '2');
    assert.equal(board.me.inLeaderboard, false);
    calls = Math.max(calls, board.entries.at(-1).requests);
  }
  await insertLogs(db, Array.from({ length: calls + 1 }, () => ({ user_id: 2, created_at: '2026-10-13T03:30:01Z', input_tokens: 0 })));
  clock = new Date('2026-10-13T03:31:01Z');
  const revision = settings.snapshot().revision;
  for (const period of ['today', 'week', 'month', 'all']) {
    const board = await leaderboard.get(period, 'requests', '2');
    const row = board.entries.find((entry) => entry.key === board.me.key);
    assert.ok(row);
    assert.equal(row.tokens, 0);
    assert.equal(row.requests, calls + 2);
    assert.equal(board.me.tokens, row.tokens);
    assert.equal(board.me.requests, row.requests);
    assert.equal(board.me.boardRank, row.rank);
    assert.equal(board.me.rankingAvailable, false);
    assert.equal(board.me.rank, null);
    assert.equal(board.me.percentile, null);
    assert.equal(board.entries.length, 10);
    assert.equal(board.display.realCount, 1);
    assert.equal(board.display.simulatedCount, 9);
    assert.ok(board.entries.filter((entry) => entry.source === 'simulation').every((entry) => entry.tokens >= rules.boardMinimumTokens && entry.tokens <= rules.boardMaximumTokens));
    assert.deepEqual((await leaderboard.get(period, 'requests', '3')).entries, board.entries);
    assert.equal((await leaderboard.get(period, 'tokens', '2')).me.inLeaderboard, false);
  }
  assert.equal(settings.snapshot().revision, revision);
});

test('a late usage write invalidates a cached board when personal totals would otherwise outrun its candidates', async (t) => {
  const { db, leaderboard } = await setup(t, [{ id: 2 }, { id: 3 }], []);
  const before = await leaderboard.get('today', 'tokens', '3');
  assert.equal(before.display.realCount, 0);
  await insertLogs(db, [{ user_id: 2, created_at: '2026-10-13T03:29:59Z', input_tokens: 120000000 }]);
  const board = await leaderboard.get('today', 'tokens', '2');
  const row = board.entries.find((entry) => entry.key === board.me.key);
  assert.ok(row);
  assert.equal(row.tokens, 120000000);
  assert.equal(row.tokens, board.me.tokens);
  assert.equal(row.requests, board.me.requests);
  assert.equal(board.me.boardRank, row.rank);
  assert.deepEqual((await leaderboard.get('today', 'tokens', '3')).entries, board.entries);
  assert.ok(!/qualifiedEntries|snapshotConsistent|"seed"|"email"/.test(JSON.stringify(board)));
});

test('writes between shared ranking totals and model details trigger a bounded shared refresh instead of conflicting numbers', async (t) => {
  const { db, leaderboard, repository } = await setup(t, [{ id: 2 }], [{ user_id: 2, created_at: '2026-10-13T02:00Z', input_tokens: 20000000 }]);
  const read = repository.board.bind(repository);
  let writes = 0;
  repository.board = async (...args) => {
    const result = await read(...args);
    if (writes++ === 0) await insertLogs(db, [{ user_id: 2, created_at: '2026-10-13T03:29:59Z', input_tokens: 50000000 }]);
    return result;
  };
  const board = await leaderboard.get('today', 'tokens', '2');
  const row = board.entries.find((entry) => entry.key === board.me.key);
  assert.equal(board.me.tokens, 70000000);
  assert.equal(row.tokens, board.me.tokens);
  assert.equal(row.requests, board.me.requests);
  assert.equal(board.me.models.reduce((sum, model) => sum + model.tokens, 0), board.me.tokens);
  assert.equal(board.me.models.reduce((sum, model) => sum + model.requests, 0), board.me.requests);
  assert.equal(board.me.trend.at(-1).tokens, board.me.tokens);
  leaderboard.invalidate();
  let attempts = 0;
  repository.board = async (...args) => {
    attempts++;
    const result = await read(...args);
    await insertLogs(db, [{ user_id: 2, created_at: '2026-10-13T03:29:59Z', input_tokens: 1 }]);
    return result;
  };
  await assert.rejects(leaderboard.get('today', 'tokens', '2'), { code: 'SERVICE_BUSY' });
  assert.equal(attempts, 3);
});

test('published real usage can cross the ceiling after a cache refresh while live examples advance and survive midnight without republishing', async (t) => {
  const rules = { ...DEFAULT_RULES, boardMaximumTokens: 50e6 };
  const { db, settings, leaderboard } = await setup(t, [{ id: 2 }], [{ user_id: 2, created_at: '2026-10-13T02:00Z', input_tokens: 17000123 }], rules);
  let clock = new Date('2026-10-13T03:30:00Z');
  settings.now = leaderboard.now = () => clock;
  leaderboard.boardCache.now = leaderboard.personalCache.now = () => clock.getTime();
  const original = await leaderboard.get('today', 'tokens', '2');
  const revision = settings.snapshot().revision;
  await insertLogs(db, [{ user_id: 2, created_at: '2026-10-13T03:30:01Z', input_tokens: 40000000 }]);
  clock = new Date('2026-10-13T03:30:59Z');
  const cached = await leaderboard.get('today', 'tokens', '2');
  assert.equal(cached.me.tokens, original.me.tokens);
  assert.deepEqual(cached.entries, original.entries);
  clock = new Date('2026-10-13T05:30:00Z');
  const updated = await leaderboard.get('today', 'tokens', '2');
  assert.equal(updated.me.tokens, 57000123);
  assert.equal(updated.entries.find((row) => row.source === 'real').tokens, 57000123);
  assert.ok(updated.entries.filter((row) => row.source === 'simulation').every((row) => row.tokens <= rules.boardMaximumTokens));
  assert.ok(updated.entries.some((row) => row.source === 'simulation' && row.tokens > original.entries.find((old) => old.key === row.key).tokens));
  clock = new Date('2026-10-13T16:00:00Z');
  const nextDay = await leaderboard.get('today', 'tokens', '2');
  assert.equal(nextDay.display.dynamic, true);
  assert.equal(nextDay.display.date, '2026-10-14');
  assert.equal(nextDay.entries.length, 10);
  assert.equal(nextDay.me.tokens, 0);
  assert.equal(settings.snapshot().revision, revision);
  assert.equal(settings.snapshot().expired, false);
  const preview = await leaderboard.preview(settings.draftCandidate(), 'today', 'tokens');
  assert.deepEqual(preview.entries, nextDay.entries);
});
