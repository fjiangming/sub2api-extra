'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { profileFixture } = require('./profile-fixture');
const { parseQuery, parseUserId, csvCell } = require('../src/services/user-profiles-service');

let fixture;
test.before(async () => { fixture = await profileFixture(); });
test.after(async () => { await fixture?.database.close(); });
const range = { start: '2026-09-14', end: '2026-10-13' };

test('PostgreSQL report reconciles retained identities, effective platforms and four Token categories', async () => {
  const report = await fixture.profiles.getReport(range);
  assert.equal(report.summary.users, 6);
  assert.equal(report.summary.cost, 123);
  assert.equal(report.summary.requests, 117);
  assert.equal(report.summary.tokens, 3550);
  assert.equal(report.summary.multi_users, 1);
  assert.equal(report.summary.average_cost, 20.5);
  assert.equal(report.coverage.selected.status, 'matched');
  assert.equal(report.attention.declining, 1);
  assert.equal(report.attention.low_balance, 1);
  assert.equal(report.platforms.find((p) => p.platform === 'gemini').cost, 70);
  assert.equal(report.platforms.find((p) => p.platform === 'anthropic').cost, 17);
  assert.equal(report.platforms.find((p) => p.platform === 'grok').cost, 20);
  assert.equal(report.platforms.find((p) => p.platform === '(unknown)').cost, 5);
  assert.equal(report.platforms.reduce((sum, p) => sum + p.cost, 0), report.summary.cost);
  for (const metric of ['requests', 'tokens', 'cost']) {
    assert.equal(report.models[metric].reduce((sum, m) => sum + m[metric], 0), report.summary[metric]);
  }
  assert.equal(report.concentration.reduce((sum, b) => sum + b.users, 0), 6);
  assert.equal(report.concentration.reduce((sum, b) => sum + b.cost, 0), 123);
  assert.equal(report.concentration[0].users, 2);
});

test('search, tags and pagination preserve the overall consumption denominator and zero consumption users', async () => {
  const list = await fixture.profiles.getUsers({ ...range, search: '林知夏', pageSize: '1' });
  assert.equal(list.pagination.total, 1);
  assert.equal(list.totalConsumption, 123);
  assert.equal(list.items[0].cost, 94);
  assert.equal(list.items[0].consumption_share, 94 / 123);
  const high = await fixture.profiles.getUsers({ ...range, segment: 'high' });
  assert.equal(high.pagination.total, 2);
  assert.equal(high.totalConsumption, 123);
  assert.deepEqual(high.items.map((u) => u.id), ['2', '3']);
  const literal = await fixture.profiles.getUsers({ ...range, search: '%' });
  assert.deepEqual(literal.items.map((u) => u.id), ['7']);
  const free = await fixture.profiles.getUsers({ ...range, search: '6' });
  assert.equal(free.items[0].requests, 1);
  assert.equal(free.items[0].cost, 0);
  assert.equal(free.items[0].high_consumption, false);
  const page2 = await fixture.profiles.getUsers({ ...range, page: 2, pageSize: 2 });
  assert.equal(page2.items.length, 2);
  assert.equal(page2.pagination.hasNext, true);
  assert.equal(page2.totalConsumption, 123);
});

test('mixed billing runway excludes subscriptions and remains independent of platform/billing filters', async () => {
  const detail = await fixture.profiles.getUser('2', { ...range, platform: 'gemini', billing: 'subscription' });
  assert.equal(detail.user.cost, 70);
  assert.equal(detail.user.balance, 4);
  assert.equal(detail.user.daily_balance_cost, 2);
  assert.equal(detail.user.runway_days, 2);
  assert.equal(detail.user.low_balance, true);
  assert.equal(detail.user.platform_count, 1);
  assert.equal(detail.user.declining, false);
  assert.equal(detail.models.requests[0].model, 'gemini-2.5-pro');
  const all = await fixture.profiles.getUser('2', range);
  assert.equal(all.user.runway_days, detail.user.runway_days);
  assert.equal(all.user.declining, true);
  assert.equal(all.user.active_days, 4);
  assert.equal(all.trend.find((d) => d.date === '2026-10-13').cost, 7);
});

test('attention can surface a user who stopped using the service in the selected period', async () => {
  await fixture.insert(Array.from({ length: 100 }, () => ({ user_id: 8, group_id: 1,
    actual_cost: 0.01, created_at: '2026-10-03T03:00:00Z' })));
  await fixture.aggregate();
  const query = { start: '2026-10-07', end: '2026-10-13' };
  const report = await fixture.profiles.getReport(query);
  assert.equal(report.attention.declining, 2);
  const declining = await fixture.profiles.getUsers({ ...query, segment: 'decline' });
  const stopped = declining.items.find((u) => u.id === '8');
  assert.equal(stopped.requests, 0);
  assert.equal(stopped.cost, 0);
  assert.equal(stopped.declining, true);
  assert.equal(declining.totalConsumption, report.summary.cost);
  await fixture.database.engine.exec('DELETE FROM usage_logs WHERE user_id = 8');
  await fixture.aggregate();
});

test('deleted and missing identities remain in accounting; deleted balances are unavailable', async () => {
  const deleted = await fixture.profiles.getUser('3', range);
  assert.equal(deleted.user.deleted, true);
  assert.equal(deleted.user.cost, 20);
  assert.equal(deleted.user.balance, null);
  assert.equal(deleted.user.runway_days, null);
  const missing = await fixture.profiles.getUser('5', range);
  assert.equal(missing.user.deleted, true);
  assert.equal(missing.user.name, '用户 #5');
  assert.equal(missing.user.cost, 5);
  assert.equal(missing.user.platform_count, 0);
  await assert.rejects(fixture.profiles.getUser('1', range), { code: 'USER_PROFILE_NOT_FOUND' });
});

test('CSV exports all matching users regardless of page and neutralizes formulas', async () => {
  const result = await fixture.profiles.exportUsers({ ...range, page: 3, pageSize: 1 });
  assert.ok(result.csv.startsWith('\uFEFF'));
  assert.equal(result.csv.trimEnd().split('\r\n').length, 7);
  assert.ok(result.csv.includes(`"'=HYPERLINK(""invalid"")"`));
  const filtered = await fixture.profiles.exportUsers({ ...range, search: '林知夏', page: 99, pageSize: 1 });
  assert.equal(filtered.csv.trimEnd().split('\r\n').length, 2);
  for (const value of ['=1+1', ' +SUM(A1)', '\t@formula', '-formula', '\rmalicious']) {
    assert.ok(csvCell(value).startsWith('"\''));
  }
});

test('missing detail is reported and recent attention never treats missing history as zero', async () => {
  await fixture.database.engine.exec('DELETE FROM usage_logs WHERE user_id = 2 AND created_at < \'2026-10-07Z\'');
  const report = await fixture.profiles.getReport(range);
  assert.equal(report.coverage.selected.status, 'partial');
  assert.deepEqual(report.coverage.selected.missingDays, ['2026-10-03']);
  assert.equal(report.recent.available, false);
  assert.equal(report.attention.declining, null);
  assert.equal(report.attention.low_balance, null);
  const detail = await fixture.profiles.getUser('2', range);
  assert.equal(detail.user.runway_days, null);
  assert.equal(detail.user.declining, null);
  await fixture.insert(Array.from({ length: 100 }, () => ({ user_id: 2, group_id: 1, account_id: 1,
    requested_model: 'claude-sonnet-4', actual_cost: 0.1, input_tokens: 10, created_at: '2026-10-03T04:00:00Z' })));
});

test('older schema falls back to logged model and unknown platforms with honest coverage', async (t) => {
  const old = await profileFixture();
  t.after(() => old.database.close());
  await old.database.engine.exec(`DROP TABLE groups, accounts, usage_dashboard_aggregation_watermark;
    ALTER TABLE usage_logs DROP COLUMN requested_model; ALTER TABLE users DROP COLUMN balance`);
  old.inspector.reset();
  const report = await old.profiles.getReport(range);
  assert.equal(report.coverage.selected.status, 'unverified');
  assert.equal(report.summary.cost, 123);
  assert.equal(report.platforms.length, 1);
  assert.equal(report.platforms[0].platform, '(unknown)');
  assert.equal(report.models.requests[0].model, 'routed-model');
  assert.equal(report.attention.low_balance, null);
});

test('query boundaries validate real dates, retention, metric enums and bigint identities', () => {
  const now = new Date('2026-10-13T12:00:00Z');
  assert.equal(parseQuery({}, fixture.config, now).range.start, '2026-09-14');
  for (const input of [{ start: '2026-02-30' }, { start: '2026-09-13' }, { end: '2026-10-14' },
    { start: '2026-10-14', end: '2026-10-13' }, { sort: 'cost; DROP TABLE users' },
    { page: '1.5' }, { pageSize: '101' }, { metric: ['requests', 'cost'] }, { search: 'a'.repeat(121) }]) {
    assert.throws(() => parseQuery(input, fixture.config, now));
  }
  assert.equal(parseUserId('9223372036854775807'), '9223372036854775807');
  for (const id of ['0', '-1', '2 OR 1=1', '9223372036854775808']) assert.throws(() => parseUserId(id));
});

test('no usage is a verified empty state with null share denominators', async () => {
  const report = await fixture.profiles.getReport({ start: '2026-09-20', end: '2026-09-21' });
  assert.equal(report.coverage.selected.status, 'matched');
  assert.equal(report.summary.users, 0);
  assert.equal(report.summary.cost, 0);
  assert.equal(report.summary.average_cost, null);
  assert.equal(report.summary.multi_rate, null);
  assert.deepEqual(report.platforms, []);
  assert.deepEqual(report.concentration, []);
  const users = await fixture.profiles.getUsers({ start: '2026-09-20', end: '2026-09-21' });
  assert.equal(users.pagination.total, 0);
  assert.deepEqual(users.items, []);
});

test('unknown platform is retained but does not manufacture multi-platform behavior', async () => {
  await fixture.insert([{ user_id: 6, requested_model: 'unknown-free-fixture', created_at: '2026-10-11T04:00:00Z' }]);
  await fixture.aggregate();
  const user = await fixture.profiles.getUser('6', range);
  assert.equal(user.platforms.length, 2);
  assert.equal(user.user.platform_count, 1);
  await fixture.database.engine.exec("DELETE FROM usage_logs WHERE requested_model = 'unknown-free-fixture'");
  await fixture.aggregate();
});

test('bounded model detail keeps complete denominators for each independent metric', async () => {
  await fixture.insert(Array.from({ length: 60 }, (_, i) => ({ user_id: 9, group_id: 2,
    requested_model: `model-${i}`, actual_cost: i, input_tokens: 61 - i, created_at: '2026-10-11T04:00:00Z' })));
  await fixture.aggregate();
  const detail = await fixture.profiles.getUser('9', range);
  for (const metric of ['requests', 'tokens', 'cost']) {
    assert.equal(detail.models[metric].length, 51);
    assert.equal(detail.models[metric].at(-1).model, '其他模型');
    assert.equal(detail.models[metric].reduce((sum, m) => sum + m[metric], 0), detail.user[metric]);
  }
  assert.equal(detail.models.cost[0].model, 'model-59');
  assert.equal(detail.models.tokens[0].model, 'model-0');
  await fixture.database.engine.exec('DELETE FROM usage_logs WHERE user_id = 9');
  await fixture.aggregate();
});

test('timezone day boundaries work on a 23-hour daylight-saving day', async (t) => {
  const dst = await profileFixture({ timezone: 'America/New_York', now: '2026-03-10T12:00:00Z' });
  t.after(() => dst.database.close());
  await dst.insert(['2026-03-08T04:59:59Z', '2026-03-08T05:00:00Z', '2026-03-09T03:59:59Z', '2026-03-09T04:00:00Z']
    .map((created_at) => ({ user_id: 2, group_id: 1, actual_cost: 1, created_at })));
  await dst.aggregate();
  const report = await dst.profiles.getReport({ start: '2026-03-08', end: '2026-03-08' });
  assert.equal(report.summary.requests, 2);
  assert.equal(report.summary.cost, 2);
  assert.equal(report.coverage.selected.status, 'matched');
  const detail = await dst.profiles.getUser('2', { start: '2026-03-08', end: '2026-03-08' });
  assert.deepEqual(detail.trend.map((d) => d.date), ['2026-03-08']);
});

test('aggregation runs in a read-only PostgreSQL snapshot', async () => {
  await fixture.profiles.snapshot(async (client) => {
    const { rows } = await client.query('SHOW transaction_read_only');
    assert.equal(rows[0].transaction_read_only, 'on');
  });
});
