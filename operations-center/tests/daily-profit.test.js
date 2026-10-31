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
  let cost = 2, failed = false;
  const calls = [];
  const analysis = {
    pool: { configured: () => true }, providerMonitor: { configured: () => true, integrationToken: 'synthetic-token' },
    async getDailyProfit(input, options) {
      calls.push({ input, options });
      if (failed) throw new Error('private diagnostics must not be persisted');
      const row = { date: input.start, siteConsumption: 10.12500001, supplierConsumption: cost,
        profit: cost == null ? null : 10.12500001 - cost, margin: cost == null ? null : 80.25,
        siteRequests: 5, supplierRequests: null, complete: cost != null, siteComplete: true,
        supplierComplete: cost != null, status: cost == null ? 'supplier_incomplete' : 'complete',
        providers: [{ id: 'p1', name: 'Enabled supplier', cost, complete: cost != null }] };
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
  return { service, store, analysis, config, calls, schedules, directory,
    time(value) { clock = new Date(value); }, cost(value) { cost = value; }, fail(value = true) { failed = value; } };
}

test('history queries return immediately, backfill in the background and then read only durable snapshots', async t => {
  const f = fixture(t);
  const query = { start: '2026-10-28', end: '2026-10-30', granularity: 'month' };
  const initial = await f.service.getDailyProfit(query);
  assert.equal(initial.archive.pendingDays, 3);
  assert.equal(initial.summary.profit, null);
  assert.ok(initial.items.every(row => row.status === 'pending_archive'));
  assert.equal(f.calls.length, 0);
  await f.service.drain();
  assert.equal(f.calls.length, 3);
  assert.ok(f.calls.every(call => call.input.refresh === '1'));
  const saved = await f.service.getDailyProfit(query);
  assert.equal(f.calls.length, 3);
  assert.equal(saved.archive.pendingDays, 0);
  assert.equal(saved.summary.profit, 24.37500003);
  assert.equal(saved.periods[0].profit, saved.summary.profit);
  assert.ok(saved.items.every(row => row.mode === 'archived' && row.computedAt));
  f.store.close();
  f.store.initialize();
  assert.deepEqual((await f.service.getDailyProfit(query)).items, saved.items);
  assert.equal(f.calls.length, 3);
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

test('background batches reuse one short-lived supplier session and isolate changed administrator credentials', async t => {
  const f = fixture(t);
  let exchanges = 0;
  f.analysis.createSupplierDailyCostsReader = async token => {
    exchanges++;
    return async () => token;
  };
  await f.service.getDailyProfit({ start: '2026-10-01', end: '2026-10-30' });
  for (let batch = 0; batch < 4; batch++) await f.service.drain({ accessToken: 'synthetic-admin-one' });
  assert.equal(exchanges, 1);
  assert.ok(f.calls.every(call => call.options.supplierReader === f.calls[0].options.supplierReader));
  await f.service.drain({ accessToken: 'synthetic-admin-two' });
  assert.equal(exchanges, 2);
  f.time('2026-10-31T04:06:00Z');
  await f.service.drain({ accessToken: 'synthetic-admin-two' });
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
  await f.service.stop();
  assert.equal(f.schedules[0].task.stopped, true);
});

test('refresh queues replacement without blocking, does not add amounts, and failure is retried after restart', async t => {
  const f = fixture(t);
  const query = { start: '2026-10-30', end: '2026-10-30' };
  await f.service.getDailyProfit(query);
  await f.service.drain();
  f.cost(8);
  const pending = await f.service.getDailyProfit({ ...query, refresh: '1' });
  assert.equal(f.calls.length, 1);
  assert.equal(pending.items[0].supplierConsumption, 2);
  assert.equal(pending.items[0].archiveStatus, 'pending');
  await f.service.drain();
  assert.equal((await f.service.getDailyProfit(query)).items[0].supplierConsumption, 8);
  f.fail();
  await f.service.getDailyProfit({ ...query, refresh: '1' });
  await f.service.drain();
  const failed = await f.service.getDailyProfit(query);
  assert.equal(failed.items[0].profit, null);
  assert.equal(failed.items[0].archiveStatus, 'retrying');
  assert.doesNotMatch(JSON.stringify(failed), /private diagnostics/);
  const before = f.calls.length;
  await f.service.drain();
  assert.equal(f.calls.length, before);
  f.store.close(); f.store.initialize();
  f.time('2026-10-31T04:02:00Z'); f.fail(false); f.cost(1);
  await f.service.drain();
  assert.equal((await f.service.getDailyProfit(query)).items[0].supplierConsumption, 1);
});

test('partial dates preserve successful amounts and gaps propagate to every trend granularity', async t => {
  const f = fixture(t);
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
