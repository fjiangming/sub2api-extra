'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { memoryDatabase, insertUsers, insertLogs, service } = require('./helpers');
const { publicIdentity } = require('../src/identity');

async function populated(t) {
  const db = await memoryDatabase();
  t.after(() => db.close());
  await insertUsers(db, [
    { id: 1, username: 'admin', role: 'admin' }, { id: 2, username: '山海', email: 'shanhai@example.com' }, { id: 3, username: 'Pixel', email: 'pixel@example.net' },
    { id: 4, username: '微光', email: 'weiguang@example.com' }, { id: 5, username: 'disabled', status: 'disabled' },
    { id: 6, username: 'deleted', deleted_at: '2026-10-01Z' }, { id: 7, username: 'different@example.net', email: 'private@example.org' },
    { id: 8, username: '尚未使用' }, { id: 9, username: '上期活跃' }
  ]);
  const today = '2026-10-12T16:00:00Z';
  await insertLogs(db, [
    { user_id: 2, created_at: today, input_tokens: 10, output_tokens: 20, cache_creation_tokens: 30, cache_read_tokens: 40, actual_cost: 0.2 },
    { user_id: 2, created_at: '2026-09-30T16:00:00Z', actual_cost: 0.1 },
    { user_id: 3, created_at: today, input_tokens: 100, actual_cost: 0.3 },
    { user_id: 4, created_at: today, input_tokens: 60, actual_cost: 1 },
    { user_id: 7, created_at: today, input_tokens: 10, actual_cost: 0 },
    { user_id: 2, created_at: '2026-09-01T00:00:00Z', input_tokens: 60 },
    { user_id: 3, created_at: '2026-09-01T00:00:00Z', input_tokens: 80 },
    { user_id: 4, created_at: '2026-09-01T00:00:00Z', input_tokens: 20 },
    { user_id: 9, created_at: '2026-09-01T00:00:00Z', input_tokens: 140 },
    { user_id: 9, created_at: '2026-06-01T00:00:00Z', input_tokens: 1 },
    ...[1, 5, 6].map((user_id) => ({ user_id, created_at: today, input_tokens: 100000 })),
    { user_id: 2, created_at: '2026-10-13T03:30:00Z', input_tokens: 200000 },
    { user_id: 2, created_at: '2026-12-01T00:00:00Z', input_tokens: 200000 }
  ]);
  return { db, ...service(db) };
}

test('real PostgreSQL aggregates all four token fields, token and request ties, and masks registered emails', async (t) => {
  const { leaderboard } = await populated(t);
  const data = await leaderboard.get('month', 'tokens', '4');
  assert.deepEqual(data.entries.map((user) => [user.name, user.rank]), [
    ['sh***@example.com', 1], ['pi***@example.net', 1], ['we***@example.com', 3], ['pr***@example.org', 4]
  ]);
  assert.deepEqual(data.summary, { tokens: 270, requests: 5, active: 4,
    deltas: { tokens: -10, requests: 25, active: 0 } });
  assert.equal(data.me.rank, 3);
  assert.equal(data.me.change, 1);
  assert.equal(data.me.percentile, 25);
  assert.deepEqual(data.me.next, { rank: 1, gap: 40, progress: 60 });
  assert.equal(new Date(data.window.start).toISOString(), '2026-09-30T16:00:00.000Z');
  assert.equal(data.me.trend.length, 7);
  assert.equal(data.me.trend.at(-1).date, '2026-10-13');
  assert.equal(data.me.trend.at(-1).tokens, 60);
  assert.equal(data.me.models[0].name, 'claude-test');
  assert.equal(data.me.models[0].percent, 100);
  for (const privateValue of ['shanhai@example.com', 'pixel@example.net', 'weiguang@example.com', 'private@example.org', 'different@example.net', '山海', 'Pixel', '微光']) {
    assert.ok(!JSON.stringify(data).includes(privateValue));
  }
  assert.ok(!/"(?:cost|actual_cost|email|username)":/.test(JSON.stringify(data)));
  assert.ok(!Object.hasOwn(data.entries[0], 'id'));
  const calls = await leaderboard.get('month', 'requests', '4');
  assert.deepEqual(calls.entries.map((user) => [user.name, user.rank]), [
    ['sh***@example.com', 1], ['pi***@example.net', 2], ['we***@example.com', 2], ['pr***@example.org', 2]
  ]);
  assert.deepEqual(calls.me.next, { rank: 1, gap: 1, progress: 50 });
  await assert.rejects(leaderboard.get('month', 'cost', '4'), { code: 'INVALID_REQUEST' });
});

test('today and Monday-start weeks include their boundary and exclude future records', async (t) => {
  const { leaderboard } = await populated(t);
  const today = await leaderboard.get('today', 'requests', '2');
  assert.equal(new Date(today.window.start).toISOString(), '2026-10-12T16:00:00.000Z');
  assert.equal(today.summary.requests, 4);
  assert.equal(today.me.requests, 1);
  const week = await leaderboard.get('week', 'tokens', '2');
  assert.equal(new Date(week.window.start).toISOString(), '2026-10-11T16:00:00.000Z');
  assert.equal(new Date(week.window.previousStart).toISOString(), '2026-10-04T16:00:00.000Z');
  assert.equal(new Date(week.window.previousEnd).toISOString(), '2026-10-06T03:30:00.000Z');
});

test('zero-use users, excluded administrators and other users never share personal cached data', async (t) => {
  const { leaderboard, db } = await populated(t);
  const first = await leaderboard.get('month', 'tokens', '4');
  const before = db.queryCount;
  const same = await leaderboard.get('month', 'tokens', '4');
  assert.equal(db.queryCount, before);
  assert.deepEqual(first, same);
  const other = await leaderboard.get('month', 'tokens', '8');
  assert.equal(other.me.rank, null);
  assert.equal(other.me.tokens, 0);
  assert.equal(other.me.trendTotal, 0);
  assert.deepEqual(other.me.models, []);
  assert.notEqual(other.me.key, first.me.key);
  assert.equal(db.queryCount, before + 2);
  const admin = await leaderboard.get('month', 'tokens', '1');
  assert.equal(admin.me.eligible, false);
  assert.equal(admin.me.rank, null);
  assert.equal(admin.me.tokens, 100000);
  await assert.rejects(leaderboard.get('month', 'tokens', '6'), { code: 'ACCOUNT_UNAVAILABLE' });
});

test('history cleanup changes cumulative totals and disables unavailable comparisons', async (t) => {
  const { leaderboard, db } = await populated(t);
  const all = await leaderboard.get('all', 'tokens', '4');
  assert.equal(all.summary.tokens, 571);
  assert.equal(all.comparisonAvailable, false);
  assert.equal(all.entries[0].growth, null);
  await db.engine.query("DELETE FROM public.usage_logs WHERE created_at < '2026-10-01T00:00:00+08:00'");
  leaderboard.close();
  const fresh = await leaderboard.get('month', 'tokens', '4');
  assert.equal(fresh.comparisonAvailable, false);
  assert.equal(fresh.me.change, null);
  assert.equal(fresh.summary.deltas, null);
  const retained = await leaderboard.get('all', 'tokens', '4');
  assert.equal(retained.summary.tokens, 270);
});

test('an empty station produces zero totals, seven zero days and no fabricated leaderboard', async (t) => {
  const db = await memoryDatabase({ requestedModel: false });
  t.after(() => db.close());
  await insertUsers(db, [{ id: 1, username: '新用户' }]);
  const { leaderboard } = service(db);
  const data = await leaderboard.get('all', 'tokens', '1');
  assert.deepEqual(data.entries, []);
  assert.deepEqual(data.summary, { tokens: 0, requests: 0, active: 0, deltas: null });
  assert.equal(data.me.rank, null);
  assert.equal(data.me.trend.length, 7);
  assert.equal(data.window.retainedFrom, null);
  assert.equal(data.me.modelMetric, 'requests');
});

test('top ten cutoff is stable for ties and personal ranking still works outside top ten', async (t) => {
  const db = await memoryDatabase();
  t.after(() => db.close());
  await insertUsers(db, Array.from({ length: 15 }, (_, index) => ({ id: index + 1, username: `u${index + 1}` })));
  await insertLogs(db, Array.from({ length: 15 }, (_, index) => ({ user_id: index + 1,
    created_at: '2026-10-12T18:00Z', input_tokens: index < 10 ? 100 : 10 })));
  const { leaderboard } = service(db);
  const data = await leaderboard.get('today', 'tokens', '15');
  assert.equal(data.entries.length, 10);
  assert.deepEqual(data.entries.map((user) => user.key), Array.from({ length: 10 }, (_, index) => publicIdentity(index + 1, '').key));
  assert.equal(data.me.rank, 11);
  assert.equal(data.me.percentile, 0);
  assert.equal(data.me.next.rank, 1);
  assert.equal(data.me.next.gap, 90);
});

test('large token values do not overflow integer addition; zero-token image calls use request shares', async (t) => {
  const db = await memoryDatabase();
  t.after(() => db.close());
  await insertUsers(db, [{ id: 1, username: '大用量' }, { id: 2, username: '图像' }]);
  await insertLogs(db, [
    { user_id: 1, created_at: '2026-10-12T18:00Z', input_tokens: 2000000000, output_tokens: 2000000000, cache_creation_tokens: 2000000000, cache_read_tokens: 2000000000 },
    { user_id: 2, created_at: '2026-10-12T18:00Z', model: 'image-model' },
    { user_id: 2, created_at: '2026-10-12T18:00Z', model: 'image-model' }
  ]);
  const { leaderboard } = service(db);
  const data = await leaderboard.get('today', 'requests', '2');
  assert.equal(data.summary.tokens, 8000000000);
  assert.equal(data.me.rank, 1);
  assert.equal(data.me.modelMetric, 'requests');
  assert.equal(data.me.models[0].percent, 100);
});

test('DST calendar boundaries and shorter previous months are calculated in PostgreSQL', async (t) => {
  const db = await memoryDatabase();
  t.after(() => db.close());
  const dst = service(db, { timezone: 'America/New_York', anchor: '2026-03-09T14:00:00Z' });
  const week = await dst.repository.board('week', 'tokens', '2026-03-09T14:00:00Z');
  assert.equal(new Date(week.window.start).toISOString(), '2026-03-09T04:00:00.000Z');
  assert.equal(new Date(week.window.previousStart).toISOString(), '2026-03-02T05:00:00.000Z');
  assert.equal(new Date(week.window.previousEnd).toISOString(), '2026-03-02T15:00:00.000Z');
  const month = await dst.repository.board('month', 'tokens', '2026-03-31T16:00:00Z');
  assert.equal(new Date(month.window.previousEnd).toISOString(), '2026-03-01T05:00:00.000Z');
  await assert.rejects(dst.repository.board('today', 'cost; DROP TABLE users', '2026-03-31Z'), { code: 'INVALID_REQUEST' });
  await assert.rejects(db.query('DELETE FROM public.users'), /read-only/);
});

test('schema mismatch fails explicitly and requested models take precedence when present', async (t) => {
  const db = await memoryDatabase();
  t.after(() => db.close());
  await insertUsers(db, [{ id: 1, username: 'u1' }]);
  await insertLogs(db, [{ user_id: 1, created_at: '2026-10-12T18:00Z' }]);
  await db.engine.query("UPDATE public.usage_logs SET requested_model = 'client-facing-model'");
  const { leaderboard } = service(db);
  assert.equal((await leaderboard.get('today', 'tokens', '1')).me.models[0].name, 'client-facing-model');
  await db.engine.exec('ALTER TABLE public.users DROP COLUMN email');
  const incompatible = service(db);
  await assert.rejects(incompatible.leaderboard.get('today', 'tokens', '1'), { code: 'SCHEMA_INCOMPATIBLE' });
});

test('only email and usage fields are needed; nicknames and monetary columns are never queried', async (t) => {
  const { db } = await populated(t);
  await db.engine.exec('ALTER TABLE public.users DROP COLUMN username; ALTER TABLE public.usage_logs DROP COLUMN actual_cost;');
  const { leaderboard } = service(db);
  const data = await leaderboard.get('month', 'tokens', '4');
  assert.equal(data.me.name, 'we***@example.com');
  assert.equal(data.summary.tokens, 270);
  assert.equal(data.entries.length, 4);
  assert.ok(!/"(?:cost|actual_cost|email|username)":/.test(JSON.stringify(data)));
});

test('crossing a local midnight invalidates a cached daily board immediately', async (t) => {
  const { LeaderboardService } = require('../src/leaderboard');
  const db = await memoryDatabase();
  t.after(() => db.close());
  await insertUsers(db, [{ id: 1, username: '夜间用户' }]);
  await insertLogs(db, [{ user_id: 1, created_at: '2026-10-12T15:59:00Z', input_tokens: 100 }]);
  const { config, repository, inspector } = service(db);
  let now = new Date('2026-10-12T15:59:59Z');
  const leaderboard = new LeaderboardService(repository, inspector, config, { now: () => now });
  assert.equal((await leaderboard.get('today', 'tokens', '1')).summary.tokens, 100);
  now = new Date('2026-10-12T16:00:01Z');
  const tomorrow = await leaderboard.get('today', 'tokens', '1');
  assert.equal(tomorrow.summary.tokens, 0);
  assert.equal(tomorrow.me.rank, null);
  assert.deepEqual(tomorrow.entries, []);
});
