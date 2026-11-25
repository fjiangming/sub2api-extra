'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DailyProfitStore } = require('../src/daily-profit-store');
const { DailyProfitService } = require('../src/services/daily-profit-service');
const { dailyProfitReport } = require('../src/services/cost-analysis-service');

function fixture(t, start = '2026-10-31T04:00:00Z') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-profit-test-'));
  let clock = new Date(start);
  const store = new DailyProfitStore(directory, { now: () => clock.getTime() });
  store.initialize();
  const config = { financeTimezone: 'Asia/Shanghai', sub2apiTimezone: 'Asia/Shanghai',
    databaseUrl: 'postgres://readonly:synthetic@main.example:5432/sub2api', providerMonitorBaseUrl: 'https://monitor.example' };
  let cost = 2, failed = false, lotteryReward = 0;
  const calls = [], supplierCalls = [];
  const analysis = {
    pool: { configured: () => true }, providerMonitor: { configured: () => true, integrationToken: 'synthetic-token' },
    async createSupplierDailyCostsReader() {
      return async query => {
        supplierCalls.push(query);
        return { items: [{ date: query.from, cost, complete: cost != null,
          providers: [{ id: 'p1', name: 'Enabled supplier', cost, complete: cost != null }] }] };
      };
    },
    async getSupplierDailyCost(date, id, accessToken, { supplierReader }) {
      const result = await supplierReader({ from: date, to: date, connectionId: id });
      return { date, provider: result.items[0].providers.find(provider => provider.id === id) };
    },
    async getDailyProfit(input, options) {
      calls.push({ input, options });
      if (failed) throw new Error('private diagnostics must not be persisted');
      const archived = options.supplierReader ? (await options.supplierReader({ from: input.start, to: input.end }))?.items?.[0] : null;
      const supplierConsumption = archived ? archived.cost : cost;
      const row = { date: input.start, siteConsumption: 10.12500001, supplierConsumption, lotteryReward,
        profit: supplierConsumption == null ? null : Number((10.12500001 - supplierConsumption - lotteryReward).toFixed(8)),
        margin: supplierConsumption == null ? null : 80.25,
        siteRequests: 5, supplierRequests: null, complete: supplierConsumption != null, siteComplete: true,
        supplierComplete: supplierConsumption != null, status: supplierConsumption == null ? 'supplier_incomplete' : 'complete',
        providers: archived ? archived.providers : [{ id: 'p1', name: 'Enabled supplier', cost, complete: cost != null }] };
      return { ...dailyProfitReport([row], { range: { start: input.start, end: input.end },
        currency: 'CNY', timezone: config.financeTimezone }), generatedAt: clock.toISOString() };
    }
  };
  const schedules = [];
  const cron = { schedule(expression, callback, options) {
    const task = { stopped: false, stop() { this.stopped = true; } };
    schedules.push({ expression, callback, options, task });
    return task;
  } };
  const service = new DailyProfitService({ analysis, store, config, now: () => new Date(clock), cronImpl: cron });
  t.after(async () => { await service.stop(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { service, store, analysis, config, calls, supplierCalls, schedules, directory,
    time(value) { clock = new Date(value); }, cost(value) { cost = value; }, fail(value = true) { failed = value; },
    reward(value) { lotteryReward = value; },
    seed(date, overrides = {}) {
      const row = { date, siteConsumption: 10.12500001, supplierConsumption: cost, lotteryReward,
        profit: Number((10.12500001 - cost - lotteryReward).toFixed(8)), margin: 80.25,
        siteRequests: 5, supplierRequests: null, complete: cost != null, siteComplete: true,
        supplierComplete: cost != null, lotteryComplete: true, status: cost == null ? 'supplier_incomplete' : 'complete',
        providers: [{ id: 'p1', name: 'Enabled supplier', cost, complete: cost != null }], ...overrides };
      store.enqueue(service.scope(), date);
      store.finish(store.claim(service.scope()), { row, notices: [] });
    } };
}

test('history queries return immediately and recompute durable supplier snapshots without upstream backfill', async t => {
  const f = fixture(t);
  f.seed('2026-10-28'); f.seed('2026-10-29');
  const query = { start: '2026-10-28', end: '2026-10-30', granularity: 'month' };
  const initial = await f.service.getDailyProfit(query);
  assert.equal(initial.archive.pendingDays, 1);
  assert.equal(initial.summary.profit, null);
  assert.equal(initial.items[0].status, 'pending_archive');
  assert.equal(f.calls.length, 0);
  await f.service.drain();
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls.every(call => call.input.refresh === '1'));
  const saved = await f.service.getDailyProfit(query);
  assert.equal(f.calls.length, 1);
  assert.equal(saved.archive.pendingDays, 0);
  assert.equal(saved.summary.profit, 24.37500003);
  assert.equal(saved.periods[0].profit, saved.summary.profit);
  assert.ok(saved.items.every(row => row.mode === 'archived' && row.computedAt));
  f.store.close();
  f.store.initialize();
  assert.deepEqual((await f.service.getDailyProfit(query)).items, saved.items);
  assert.equal(f.calls.length, 1);
});

test('current day is always read live, concurrent reads merge, and future days never query or enqueue', async t => {
  const f = fixture(t);
  const query = { start: '2026-10-31', end: '2026-11-01' };
  const reports = await Promise.all([f.service.getDailyProfit(query), f.service.getDailyProfit(query)]);
  assert.equal(f.calls.length, 1);
  assert.equal(reports[0].items[0].status, 'future');
  assert.equal(reports[0].items[1].mode, 'live');
  assert.equal(f.store.list(f.service.scope(), '2026-10-31', '2026-11-01').length, 0);
  assert.equal(reports[0].archive.pendingDays, 0);
  await f.service.getDailyProfit({ ...query, poll: '1' });
  assert.equal(f.calls.length, 1);
  f.cost(4);
  assert.equal((await f.service.getDailyProfit(query)).items[1].supplierConsumption, 4);
  assert.equal(f.calls.length, 2);
});

test('permitted live readers reuse short-lived sessions and isolate administrator credentials', async t => {
  const f = fixture(t);
  let exchanges = 0;
  f.analysis.createSupplierDailyCostsReader = async token => {
    exchanges++;
    return async () => token;
  };
  const first = await f.service.supplierReader('2026-10-31', 'synthetic-admin-one');
  assert.equal(await f.service.supplierReader('2026-10-31', 'synthetic-admin-one'), first);
  assert.equal(exchanges, 1);
  await f.service.supplierReader('2026-10-31', 'synthetic-admin-two');
  assert.equal(exchanges, 2);
  f.time('2026-10-31T04:06:00Z');
  await f.service.supplierReader('2026-10-31', 'synthetic-admin-two');
  assert.equal(exchanges, 3);
});

test('the 01:00 finance-day job persists once, catches downtime and never archives a partial previous day', async t => {
  const f = fixture(t, '2026-10-31T16:30:00Z'); // November 1, 00:30 in Shanghai.
  const query = { start: '2026-10-31', end: '2026-10-31' };
  await f.service.getDailyProfit(query);
  await f.service.drain();
  assert.equal(f.calls.length, 0);
  f.service.start();
  assert.equal(f.schedules[0].expression, '0 1 * * *');
  assert.equal(f.schedules[0].options.timezone, 'Asia/Shanghai');
  assert.equal(f.schedules[0].options.noOverlap, true);
  await f.service.drain();
  assert.ok(f.calls.every(call => call.input.start !== '2026-10-31'));
  f.time('2026-10-31T17:00:00Z');
  f.schedules[0].callback();
  await f.service.drain();
  assert.equal(f.calls.filter(call => call.input.start === '2026-10-31').length, 1);
  f.service.scheduleDue();
  await f.service.drain();
  assert.equal(f.calls.filter(call => call.input.start === '2026-10-31').length, 1);
  f.time('2026-11-03T18:00:00Z');
  f.service.scheduleDue();
  await f.service.drain();
  assert.ok(['2026-11-01', '2026-11-02', '2026-11-03'].every(date => f.calls.some(call => call.input.start === date)));
  assert.deepEqual(f.supplierCalls.map(query => query.from), ['2026-10-31', '2026-11-03']);
  await f.service.stop();
  assert.equal(f.schedules[0].task.stopped, true);
});

test('yesterday recalculations retain supplier costs and failed source updates retain the complete snapshot', async t => {
  const f = fixture(t);
  const query = { start: '2026-10-30', end: '2026-10-30' };
  await f.service.getDailyProfit(query);
  await f.service.drain();
  f.cost(8);
  const refreshed = await f.service.getDailyProfit({ ...query, refresh: '1' });
  assert.equal(refreshed.archive.pendingDays, 0);
  assert.equal(refreshed.items[0].supplierConsumption, 2);
  const pending = await f.service.getDailyProfit({ ...query, recalculate: '1' });
  assert.equal(f.calls.length, 1);
  assert.equal(pending.items[0].supplierConsumption, 2);
  assert.equal(pending.items[0].archiveStatus, 'pending');
  await f.service.drain();
  assert.equal((await f.service.getDailyProfit(query)).items[0].supplierConsumption, 2);
  f.fail();
  await f.service.getDailyProfit({ ...query, recalculate: '1' });
  await f.service.drain();
  const failed = await f.service.getDailyProfit(query);
  assert.equal(failed.items[0].supplierConsumption, 2);
  assert.equal(failed.items[0].computedAt, pending.items[0].computedAt);
  assert.equal(failed.items[0].complete, true);
  assert.equal(failed.items[0].lastAttempt.errorCode, 'DAILY_PROFIT_FAILED');
  assert.equal(failed.items[0].archiveStatus, 'retrying');
  assert.doesNotMatch(JSON.stringify(failed), /private diagnostics/);
  const before = f.calls.length;
  await f.service.drain();
  assert.equal(f.calls.length, before);
  f.store.close(); f.store.initialize();
  f.time('2026-10-31T04:02:00Z'); f.fail(false); f.cost(1);
  await f.service.drain();
  assert.equal((await f.service.getDailyProfit(query)).items[0].supplierConsumption, 2);
});

test('historical rearchives preserve supplier costs while recalculating lottery deductions', async t => {
  const f = fixture(t), date = '2026-10-28', query = { start: date, end: date };
  f.seed(date);
  await f.service.getDailyProfit(query);
  await f.service.drain();
  f.cost(0);
  f.reward(3);
  f.analysis.createSupplierDailyCostsReader = async () => { throw new Error('History must not access the monitor'); };
  await f.service.getDailyProfit({ ...query, recalculate: '1' });
  await f.service.drain();
  const row = (await f.service.getDailyProfit(query)).items[0];
  assert.equal(row.supplierConsumption, 2);
  assert.equal(row.providers[0].cost, 2);
  assert.equal(row.lotteryReward, 3);
  assert.equal(row.profit, 5.12500001);
  assert.equal(row.complete, true);
  assert.equal(row.lastAttempt.errorCode, null);
  f.store.close(); f.store.initialize();
  assert.equal((await f.service.getDailyProfit(query)).items[0].supplierConsumption, 2);
});

test('verified zero supplier consumption remains complete when old history is rearchived', async t => {
  const f = fixture(t), date = '2026-10-28', query = { start: date, end: date };
  f.cost(0);
  f.seed(date);
  await f.service.getDailyProfit(query);
  await f.service.drain();
  f.cost(9);
  await f.service.getDailyProfit({ ...query, recalculate: '1' });
  await f.service.drain();
  const row = (await f.service.getDailyProfit(query)).items[0];
  assert.equal(row.supplierConsumption, 0);
  assert.equal(row.providers[0].cost, 0);
  assert.equal(row.complete, true);
  assert.equal(row.profit, 10.12500001);
});

test('all archived dates including yesterday retain supplier costs and use finance calendar boundaries', async t => {
  const f = fixture(t), query = { start: '2026-10-28', end: '2026-10-30' };
  f.seed('2026-10-28'); f.seed('2026-10-29');
  await f.service.getDailyProfit(query);
  await f.service.drain();
  f.cost(0);
  await f.service.getDailyProfit({ ...query, recalculate: '1' });
  await f.service.drain();
  const report = await f.service.getDailyProfit(query);
  assert.deepEqual(report.items.map(row => [row.date, row.supplierConsumption]), [
    ['2026-10-30', 2], ['2026-10-29', 2], ['2026-10-28', 2]
  ]);
  f.config.financeTimezone = 'America/New_York';
  f.time('2026-11-01T04:30:00Z');
  assert.equal(f.service.canFetchSupplier('2026-10-30', true), false);
  assert.equal(f.service.canFetchSupplier('2026-10-31', true), false); // 00:30, before archival.
  f.time('2026-11-01T05:00:00Z');
  assert.equal(f.service.canFetchSupplier('2026-10-31', true), true);
  assert.equal(f.service.canFetchSupplier('2026-10-31'), false);
  f.time('2026-11-02T04:30:00Z'); // Still November 1 before the DST midnight in New York.
  assert.equal(f.service.canFetchSupplier('2026-10-31', true), true);
  f.time('2026-11-02T05:00:00Z');
  assert.equal(f.service.canFetchSupplier('2026-10-31', true), false);
});

test('old incomplete supplier snapshots keep each known amount and never turn missing suppliers into zero', async t => {
  const f = fixture(t), date = '2026-10-28', scope = f.service.scope();
  f.cost(null);
  f.seed(date);
  const original = f.store.list(scope, date, date)[0];
  original.row.providers.push({ id: 'p2', name: 'Known supplier', cost: 9, complete: true });
  f.store.db.prepare('UPDATE daily_profit_snapshots SET payload=? WHERE scope=? AND date=?')
    .run(JSON.stringify({ row: original.row, notices: original.notices }), scope, date);
  f.cost(0);
  f.analysis.createSupplierDailyCostsReader = async () => { throw new Error('Do not fetch expired logs'); };
  await f.service.getDailyProfit({ start: date, end: date, recalculate: '1' });
  await f.service.drain();
  const row = (await f.service.getDailyProfit({ start: date, end: date })).items[0];
  assert.equal(row.supplierConsumption, null);
  assert.equal(row.profit, null);
  assert.equal(row.providers[0].cost, null);
  assert.equal(row.providers[1].cost, 9);
  assert.equal(row.complete, false);
});

test('manual refresh of a locked historical provider returns its stored value without contacting upstream', async t => {
  const f = fixture(t), date = '2026-10-28';
  f.seed(date);
  await f.service.getDailyProfit({ start: date, end: date });
  await f.service.drain();
  const before = f.store.list(f.service.scope(), date, date)[0];
  f.analysis.getSupplierDailyCost = async () => { throw new Error('Historical refresh must stay local'); };
  const result = await f.service.refreshProvider({ date, providerId: 'p1' });
  assert.equal(result.reused, true);
  assert.equal(result.provider.cost, 2);
  assert.deepEqual(f.store.list(f.service.scope(), date, date)[0], before);
  await assert.rejects(f.service.refreshProvider({ date, providerId: 'missing' }), { code: 'PROVIDER_NOT_ARCHIVED' });
});

test('failed rearchives preserve known suppliers even when the existing day is incomplete', async t => {
  for (const cost of [12, '12']) {
    const f = fixture(t), date = '2026-10-28', scope = f.service.scope();
    f.store.enqueue(scope, date);
    f.store.finish(f.store.claim(scope), { row: { date, complete: false, siteComplete: false,
      supplierComplete: false, supplierConsumption: null, providers: [
        { id: 'p1', complete: true, cost }, { id: 'p2', complete: false, cost: null }
      ] } }, 'DAILY_PROFIT_INCOMPLETE');
    const before = f.store.list(scope, date, date)[0];
    f.fail();
    await f.service.getDailyProfit({ start: date, end: date, recalculate: '1' });
    await f.service.drain();
    const after = f.store.list(scope, date, date)[0];
    assert.equal(after.row.supplierConsumption, null);
    assert.equal(after.row.providers[0].cost, cost);
    assert.equal(after.row.complete, false);
    assert.equal(after.computedAt, before.computedAt);
    assert.equal(after.lastAttempt.errorCode, 'DAILY_PROFIT_FAILED');
  }
});

test('manual refresh of yesterday reads only its archive and does not call the upstream account', async t => {
  const f = fixture(t);
  const date = '2026-10-30', scope = f.service.scope();
  await f.service.getDailyProfit({ start: date, end: date });
  await f.service.drain();
  const before = f.store.list(scope, date, date)[0];
  let refreshed;
  f.analysis.getSupplierDailyCost = async (requestedDate, providerId) => {
    refreshed = { requestedDate, providerId };
    return { date: requestedDate, provider: {
      id: providerId, name: 'Enabled supplier', cost: 7, complete: true, requests: 9, reasons: []
    } };
  };
  const result = await f.service.refreshProvider({ date, providerId: 'p1' });
  assert.equal(refreshed, undefined);
  assert.equal(result.reused, true);
  assert.equal(result.mode, 'archived');
  assert.equal(result.provider.cost, 2);
  assert.equal(result.row.supplierConsumption, 2);
  assert.equal(result.row.profit, 8.12500001);
  assert.equal(result.row.supplierRequests, null);
  assert.equal(result.row.complete, true);
  assert.equal(f.store.jobs(scope, date, date).length, 0);
  const saved = f.store.list(scope, date, date)[0];
  assert.equal(saved.row.supplierConsumption, 2);
  assert.equal(saved.computedAt, before.computedAt);
});

test('manual provider refresh never creates an upstream retry even for missing historical costs', async t => {
  const f = fixture(t);
  const date = '2026-10-30', scope = f.service.scope();
  await f.service.getDailyProfit({ start: date, end: date });
  await f.service.drain();
  const before = f.store.list(scope, date, date)[0];
  before.row.providers[0].cost = null;
  before.row.providers[0].complete = false;
  before.row.supplierConsumption = null;
  before.row.supplierComplete = false;
  before.row.complete = false;
  f.store.db.prepare('UPDATE daily_profit_snapshots SET payload=? WHERE scope=? AND date=?')
    .run(JSON.stringify({ row: before.row, notices: [] }), scope, date);
  f.analysis.getSupplierDailyCost = async (requestedDate, providerId) => ({
    date: requestedDate,
    provider: { id: providerId, name: 'Enabled supplier', cost: null, complete: false, reasons: ['上游连接暂不可用'] }
  });
  const result = await f.service.refreshProvider({ date, providerId: 'p1' });
  assert.equal(result.provider.complete, false);
  assert.equal(result.reused, true);
  assert.equal(result.row.supplierConsumption, before.row.supplierConsumption);
  assert.equal(result.row.complete, false);
  assert.equal(result.lastAttempt.errorCode, null);
  assert.equal(result.computedAt, before.computedAt);
  assert.equal(f.store.jobs(scope, date, date).length, 0);
  const saved = f.store.list(scope, date, date)[0];
  assert.equal(saved.row.supplierConsumption, before.row.supplierConsumption);
  assert.equal(saved.computedAt, before.computedAt);
});

test('missing older history stays unknown without authenticating or querying upstream, even when force is requested', async t => {
  const f = fixture(t), date = '2026-10-29', query = { start: date, end: date };
  f.analysis.createSupplierDailyCostsReader = async () => { throw new Error('Older history must never authenticate'); };
  await f.service.getDailyProfit(query);
  await f.service.drain();
  let row = (await f.service.getDailyProfit(query)).items[0];
  assert.equal(row.siteConsumption, 10.12500001);
  assert.equal(row.supplierConsumption, null);
  assert.equal(row.profit, null);
  assert.equal(row.complete, false);
  assert.match(row.notices.join(), /历史缺口需从备份恢复/);
  await f.service.getDailyProfit({ ...query, accounting: '1', refresh: '1' });
  await f.service.drain();
  row = (await f.service.getDailyProfit(query)).items[0];
  assert.equal(row.supplierConsumption, null);
  assert.equal(row.providers.length, 0);
  await assert.rejects(f.service.refreshProvider({ date, providerId: 'p1' }), { code: 'PROVIDER_NOT_ARCHIVED' });
});

test('yesterday initial archive retries fill only missing accounts and never overwrite known costs', async t => {
  const f = fixture(t), date = '2026-10-30', scope = f.service.scope();
  const queries = [];
  let failed = true;
  f.analysis.createSupplierDailyCostsReader = async () => async query => {
    queries.push(query);
    const providers = [
      { id: 'p1', name: 'Known supplier', cost: queries.length === 1 ? 9 : 0, complete: true },
      { id: 'p2', name: 'Missing supplier', cost: failed ? null : 3, complete: !failed }
    ].filter(provider => !query.connectionId || provider.id === query.connectionId);
    return { items: [{ date, cost: failed ? null : 3, complete: !failed, providers }] };
  };
  await f.service.getDailyProfit({ start: date, end: date });
  await f.service.drain();
  assert.equal(queries.length, 1);
  assert.equal(f.store.list(scope, date, date)[0].row.providers[0].cost, 9);
  f.store.close(); f.store.initialize();
  failed = false;
  f.time('2026-10-31T04:02:00Z');
  await f.service.drain();
  const row = f.store.list(scope, date, date)[0].row;
  assert.deepEqual(queries.map(query => query.connectionId || 'all'), ['all', 'p2']);
  assert.equal(row.providers[0].cost, 9);
  assert.equal(row.providers[1].cost, 3);
  assert.equal(row.supplierConsumption, 12);
  assert.equal(row.complete, true);
  assert.equal(f.store.jobs(scope, date, date).length, 0);
});

test('an explicit recalculation cannot inherit or regain a previous-day archive fetch permission', async t => {
  const f = fixture(t), date = '2026-10-30', scope = f.service.scope(), query = { start: date, end: date };
  f.cost(null);
  await f.service.getDailyProfit(query);
  assert.equal(f.store.db.prepare('SELECT fetch_supplier FROM daily_profit_jobs WHERE scope=? AND date=?').get(scope, date).fetch_supplier, 1);
  await f.service.drain();
  f.store.close(); f.store.initialize();
  await f.service.getDailyProfit({ ...query, recalculate: '1' });
  await f.service.getDailyProfit(query); // A poll must not grant permission to the forced job.
  assert.equal(f.store.db.prepare('SELECT fetch_supplier FROM daily_profit_jobs WHERE scope=? AND date=?').get(scope, date).fetch_supplier, 0);
  f.analysis.createSupplierDailyCostsReader = async () => { throw new Error('Recalculation must stay local'); };
  await f.service.drain();
  assert.equal(f.store.list(scope, date, date)[0].row.supplierConsumption, null);
});

test('yesterday legacy migrations and scheduled catch-up cannot grant historical snapshots upstream access', async t => {
  const f = fixture(t), date = '2026-10-30', scope = f.service.scope();
  f.cost(null); f.seed(date);
  const snapshot = f.store.list(scope, date, date)[0];
  delete snapshot.row.lotteryReward;
  f.store.db.prepare('UPDATE daily_profit_snapshots SET payload=? WHERE scope=? AND date=?')
    .run(JSON.stringify({ row: snapshot.row, notices: [] }), scope, date);
  f.service.scheduleDue();
  await f.service.getDailyProfit({ start: date, end: date });
  f.cost(0);
  await f.service.drain();
  const row = f.store.list(scope, date, date)[0].row;
  assert.equal(row.lotteryReward, 0);
  assert.equal(row.supplierConsumption, null);
  assert.equal(row.complete, false);
  assert.equal(f.supplierCalls.length, 0);
});

test('archive retries lose upstream permission after the finance date changes and cached readers cannot bypass it', async t => {
  const f = fixture(t), date = '2026-10-30', scope = f.service.scope();
  f.cost(null);
  await f.service.getDailyProfit({ start: date, end: date });
  await f.service.drain();
  const cached = f.service.readerCache.read;
  f.time('2026-10-31T16:00:00Z'); // November 1 in the finance timezone.
  await assert.rejects(cached({ from: date, to: date }), { code: 'SUPPLIER_HISTORY_FETCH_FORBIDDEN' });
  f.cost(0);
  f.analysis.createSupplierDailyCostsReader = async () => { throw new Error('Retry must not request an older day'); };
  await f.service.drain();
  assert.equal(f.store.list(scope, date, date)[0].row.supplierConsumption, null);
  await assert.rejects(f.service.supplierReader(date, null, null, true), { code: 'SUPPLIER_HISTORY_FETCH_FORBIDDEN' });
});

test('today manual supplier refresh remains live and never writes a historical snapshot', async t => {
  const f = fixture(t), date = '2026-10-31';
  f.cost(4);
  const result = await f.service.refreshProvider({ date, providerId: 'p1' });
  assert.equal(result.mode, 'live');
  assert.equal(result.provider.cost, 4);
  assert.equal(f.store.list(f.service.scope(), date, date).length, 0);
  f.time('2026-10-31T16:00:00Z');
  f.cost(6);
  assert.equal((await f.service.refreshProvider({ date: '2026-11-01', providerId: 'p1' })).provider.cost, 6);
});

test('partial dates preserve successful amounts and gaps propagate to every trend granularity', async t => {
  const f = fixture(t);
  f.seed('2026-10-29');
  const query = { start: '2026-10-29', end: '2026-10-30' };
  await f.service.getDailyProfit(query);
  f.cost(null);
  await f.service.drain({ limit: 1 });
  f.cost(2);
  await f.service.drain({ limit: 1 });
  for (const granularity of ['day', 'week', 'month', 'year']) {
    const report = await f.service.getDailyProfit({ ...query, granularity });
    assert.equal(report.summary.siteConsumption, 20.25000002);
    assert.equal(report.summary.profit, null);
    assert.equal(report.periods.find(row => row.end >= '2026-10-30').profit, null);
    assert.equal(report.summary.completeDays, 1);
  }
});

test('missing durable credentials keep jobs queued without repeated login and unsupported currencies never query', async t => {
  const f = fixture(t);
  f.analysis.providerMonitor.integrationToken = null;
  await f.service.getDailyProfit({ start: '2026-10-30', end: '2026-10-30' });
  await f.service.drain();
  assert.equal(f.calls.length, 0);
  assert.equal((await f.service.getDailyProfit({ start: '2026-10-30', end: '2026-10-30' })).archive.ready, false);
  const usd = await f.service.getDailyProfit({ start: '2026-10-30', end: '2026-11-01', currency: 'USD' });
  assert.equal(usd.archive.pendingDays, 0);
  assert.ok(usd.items.every(row => row.status === 'unsupported_currency'));
  await f.service.drain({ accessToken: 'synthetic-admin-sso' });
  assert.equal(f.calls[0].options.accessToken, 'synthetic-admin-sso');
});

test('scope survives credential rotation, isolates different databases and handles daylight-saving finance days', async t => {
  const f = fixture(t, '2026-11-01T06:30:00Z');
  const first = f.service.scope();
  f.config.databaseUrl = 'postgres://newuser:rotated@main.example:5432/sub2api';
  assert.equal(f.service.scope(), first);
  f.config.databaseUrl = 'postgres://newuser:rotated@main.example:5432/other';
  assert.notEqual(f.service.scope(), first);
  f.config.financeTimezone = 'America/New_York';
  f.service.scheduleDue();
  const jobs = f.store.jobs(f.service.scope(), '2026-10-30', '2026-11-01');
  assert.deepEqual(jobs.map(job => job.date), ['2026-10-31']);
});

test('leases and generations prevent duplicate workers and late superseded jobs from overwriting a refresh', t => {
  const f = fixture(t), scope = f.service.scope();
  f.store.enqueue(scope, '2026-10-30');
  const old = f.store.claim(scope);
  assert.equal(f.store.claim(scope), null);
  f.store.enqueue(scope, '2026-10-30', { force: true });
  const current = f.store.claim(scope);
  assert.equal(f.store.finish(old, { row: { date: '2026-10-30', profit: 999 } }), false);
  assert.equal(f.store.finish(current, { row: { date: '2026-10-30', profit: 3 } }), true);
  assert.equal(f.store.list(scope, '2026-10-30', '2026-10-30')[0].row.profit, 3);
  f.store.enqueue(scope, '2026-10-29');
  f.store.claim(scope);
  f.store.close(); f.store.initialize();
  assert.equal(f.store.claim(scope), null);
  f.time('2026-10-31T04:06:00Z');
  assert.ok(f.store.claim(scope));
});

test('legacy job schema migrates without granting old recalculations supplier-fetch permission', async t => {
  const f = fixture(t), date = '2026-10-30', scope = f.service.scope();
  f.store.enqueue(scope, date, { fetchSupplier: true });
  f.store.db.exec('ALTER TABLE daily_profit_jobs DROP COLUMN fetch_supplier');
  f.store.close(); f.store.initialize();
  const job = f.store.db.prepare('SELECT fetch_supplier FROM daily_profit_jobs WHERE scope=? AND date=?').get(scope, date);
  assert.equal(job.fetch_supplier, 0);
  f.analysis.createSupplierDailyCostsReader = async () => { throw new Error('Legacy jobs must not gain upstream access'); };
  await f.service.drain();
  assert.equal(f.store.list(scope, date, date)[0].row.supplierConsumption, null);
});

test('daily archive HTTP requires administrator auth and returns archived history without recalculation', async t => {
  const { createApp } = require('../src/app');
  const { AuthService } = require('../src/auth');
  const f = fixture(t);
  Object.assign(f.config, { env: 'test', trustProxy: false, authMode: 'local', adminUser: 'admin',
    adminPassword: 'synthetic-password-for-test', sessionTtlMinutes: 30, cookieSecure: false });
  const auth = new AuthService(f.config);
  const server = createApp({ config: f.config, auth, costAnalysis: f.analysis, dailyProfit: f.service,
    settings: { getStatus: () => ({ setupRequired: false }) } }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); auth.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const endpoint = `${base}/api/cost-analysis/daily-profit?start=2026-10-30&end=2026-10-30`;
  assert.equal((await fetch(endpoint)).status, 401);
  assert.equal(f.calls.length, 0);
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: f.config.adminPassword }) });
  assert.equal(login.status, 200);
  const headers = { cookie: login.headers.get('set-cookie').split(';')[0] };
  const response = await fetch(endpoint, { headers });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).items[0].status, 'pending_archive');
  assert.equal(f.calls.length, 0);
  await f.service.drain();
  const saved = await (await fetch(endpoint, { headers })).json();
  assert.equal(saved.items[0].mode, 'archived');
  assert.equal(saved.items[0].profit, 8.12500001);
  assert.equal(f.calls.length, 1);
});

test('manual provider refresh endpoint requires CSRF and returns the unchanged archived row', async t => {
  const { createApp } = require('../src/app');
  const { AuthService } = require('../src/auth');
  const f = fixture(t);
  const date = '2026-10-30';
  await f.service.getDailyProfit({ start: date, end: date });
  await f.service.drain();
  f.analysis.getSupplierDailyCost = async (requestedDate, providerId) => ({
    date: requestedDate,
    provider: { id: providerId, name: 'Enabled supplier', cost: 7, complete: true, requests: 9, reasons: [] }
  });
  Object.assign(f.config, { env: 'test', trustProxy: false, authMode: 'local', adminUser: 'admin',
    adminPassword: 'synthetic-password-for-test', sessionTtlMinutes: 30, cookieSecure: false });
  const auth = new AuthService(f.config);
  const server = createApp({ config: f.config, auth, costAnalysis: f.analysis, dailyProfit: f.service,
    settings: { getStatus: () => ({ setupRequired: false }) } }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); auth.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: f.config.adminPassword }) });
  const session = await login.json();
  const headers = { authorization: `Session ${session.sessionToken}`, 'x-csrf-token': session.csrfToken,
    'content-type': 'application/json' };
  const missingCsrf = await fetch(`${base}/api/cost-analysis/daily-profit/provider-refresh`, {
    method: 'POST', headers: { authorization: headers.authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ date, providerId: 'p1' })
  });
  assert.equal(missingCsrf.status, 403);
  const response = await fetch(`${base}/api/cost-analysis/daily-profit/provider-refresh`, {
    method: 'POST', headers, body: JSON.stringify({ date, providerId: 'p1' })
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.reused, true);
  assert.equal(payload.row.supplierConsumption, 2);
  assert.equal(payload.provider.cost, 2);
});

test('archived results render independently of a stalled live read and today is never stored as history', async t => {
  const f = fixture(t);
  const query = { start: '2026-10-30', end: '2026-10-31' };
  await f.service.getDailyProfit({ start: query.start, end: query.start });
  await f.service.drain();
  f.service.calculationTimeoutMs = 55;
  const original = f.analysis.getDailyProfit;
  f.analysis.getDailyProfit = async input => {
    if (input.start === '2026-10-31') return new Promise(() => {});
    return original(input);
  };
  const live = f.service.getDailyProfit(query);
  const saved = await f.service.getDailyProfit({ ...query, live: '0', refresh: '1' });
  assert.equal(saved.items.find(row => row.date === '2026-10-30').complete, true);
  assert.equal(saved.items.find(row => row.date === '2026-10-31').status, 'live_pending');
  assert.equal(saved.archive.pendingDays, 0);
  const failed = await live;
  assert.equal(failed.items[0].status, 'live_failed');
  assert.equal(failed.completeSubtotal.profit, 8.12500001);
  assert.equal(f.service.live.size, 0);
  assert.equal(f.store.list(f.service.scope(), '2026-10-31', '2026-10-31').length, 0);
  assert.equal(failed.items[1].notices.length, 0);
  assert.equal(failed.items[0].notices.length, 1);
  f.analysis.getDailyProfit = original;
  assert.equal((await f.service.getDailyProfit(query)).summary.completeDays, 2);
});

test('old failed snapshots resume local calculation without gaining a new supplier fetch grant', async t => {
  const f = fixture(t);
  const date = '2026-10-30', scope = f.service.scope();
  await f.service.getDailyProfit({ start: date, end: date });
  f.cost(null);
  await f.service.drain();
  f.store.db.prepare('DELETE FROM daily_profit_jobs WHERE scope=? AND date=?').run(scope, date);
  const incomplete = await f.service.getDailyProfit({ start: date, end: date });
  assert.equal(incomplete.archive.pendingDays, 1);
  f.cost(2);
  await f.service.drain();
  const calls = f.calls.length;
  const row = (await f.service.getDailyProfit({ start: date, end: date, refresh: '1' })).items[0];
  await f.service.drain();
  assert.equal(f.calls.length, calls);
  assert.equal(row.complete, false);
  assert.equal(row.lastAttempt.errorCode, 'DAILY_PROFIT_INCOMPLETE');
  assert.equal(row.supplierConsumption, null);
});

test('failed partial recalculations preserve full archived amounts, timestamps and isolated diagnostics after restart', async t => {
  const f = fixture(t), date = '2026-10-30', query = { start: date, end: date };
  await f.service.getDailyProfit(query);
  await f.service.drain();
  const original = (await f.service.getDailyProfit(query)).items[0];
  f.time('2026-10-31T04:05:00Z');
  await f.service.getDailyProfit({ ...query, recalculate: '1' });
  const originalGet = f.analysis.getDailyProfit;
  f.analysis.getDailyProfit = async (...args) => {
    const report = await originalGet(...args);
    Object.assign(report.items[0], { siteConsumption: null, siteComplete: false, complete: false, profit: null });
    return report;
  };
  await f.service.drain();
  f.store.close(); f.store.initialize();
  const saved = (await f.service.getDailyProfit(query)).items[0];
  assert.equal(saved.complete, true);
  assert.equal(saved.profit, original.profit);
  assert.equal(saved.computedAt, original.computedAt);
  assert.equal(saved.lastAttempt.at, '2026-10-31T04:05:00.000Z');
  assert.equal(saved.lastAttempt.errorCode, 'DAILY_PROFIT_INCOMPLETE');
  assert.equal(saved.archiveStatus, 'retrying');
  assert.equal(saved.nextAttemptAt, '2026-10-31T04:06:00.000Z');
});

test('a timed-out archive job releases the worker and late results cannot overwrite a successful retry', async t => {
  const f = fixture(t), scope = f.service.scope();
  f.seed('2026-10-29');
  f.service.calculationTimeoutMs = 50;
  let resume;
  const pending = new Promise(resolve => { resume = resolve; });
  const original = f.analysis.getDailyProfit;
  f.analysis.getDailyProfit = async (input, options) => {
    if (input.start === '2026-10-30') await pending;
    return original(input, options);
  };
  await f.service.getDailyProfit({ start: '2026-10-29', end: '2026-10-30' });
  await f.service.drain();
  const rows = await f.service.getDailyProfit({ start: '2026-10-29', end: '2026-10-30' });
  assert.equal(rows.items[0].lastAttempt.errorCode, 'DAILY_PROFIT_TIMEOUT');
  assert.equal(rows.items[1].complete, true);
  assert.equal(f.service.running, null);
  f.time('2026-10-31T04:02:00Z');
  f.analysis.getDailyProfit = original;
  f.cost(4);
  await f.service.drain();
  const saved = f.store.list(scope, '2026-10-30', '2026-10-30');
  resume();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.store.list(scope, '2026-10-30', '2026-10-30'), saved);
  assert.equal(saved[0].row.supplierConsumption, 4);
});

test('stalled supplier session creation is bounded and a cached live poll expires after one minute', async t => {
  const f = fixture(t);
  f.service.calculationTimeoutMs = 45;
  f.analysis.createSupplierDailyCostsReader = () => new Promise(() => {});
  const query = { start: '2026-10-31', end: '2026-10-31' };
  assert.equal((await f.service.getDailyProfit(query)).items[0].status, 'live_failed');
  assert.equal(f.calls.length, 0);
  f.analysis.createSupplierDailyCostsReader = async () => async () => null;
  assert.equal((await f.service.getDailyProfit(query)).items[0].complete, true);
  const before = f.calls.length;
  for (const seconds of [5, 15, 30, 45, 59]) {
    f.time(`2026-10-31T04:00:${String(seconds).padStart(2, '0')}Z`);
    await f.service.getDailyProfit({ ...query, poll: '1' });
  }
  assert.equal(f.calls.length, before);
  f.time('2026-10-31T04:01:01Z');
  await f.service.getDailyProfit({ ...query, poll: '1' });
  assert.equal(f.calls.length, before + 1);
});

test('a data source change during calculation cannot archive a result under the previous scope', async t => {
  const f = fixture(t), date = '2026-10-30', scope = f.service.scope();
  await f.service.getDailyProfit({ start: date, end: date });
  const original = f.analysis.getDailyProfit;
  f.analysis.getDailyProfit = async (input, options) => {
    const report = await original(input, options);
    f.config.databaseUrl = 'postgres://readonly:synthetic@other.example:5432/sub2api';
    return report;
  };
  await f.service.drain({ limit: 1 });
  const row = f.store.list(scope, date, date)[0];
  assert.equal(row.row.complete, false);
  assert.equal(row.lastAttempt.errorCode, 'DAILY_PROFIT_FAILED');
  assert.equal(f.store.list(f.service.scope(), date, date).length, 0);
});
