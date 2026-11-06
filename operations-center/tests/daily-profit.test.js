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

test('refresh reads saved history, explicit recalculation replaces it and failed updates retain the complete snapshot', async t => {
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
  assert.equal((await f.service.getDailyProfit(query)).items[0].supplierConsumption, 8);
  f.fail();
  await f.service.getDailyProfit({ ...query, recalculate: '1' });
  await f.service.drain();
  const failed = await f.service.getDailyProfit(query);
  assert.equal(failed.items[0].supplierConsumption, 8);
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
  assert.equal((await f.service.getDailyProfit(query)).items[0].supplierConsumption, 1);
});

test('manual provider refresh reads one upstream account and atomically updates its archived day', async t => {
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
  assert.deepEqual(refreshed, { requestedDate: date, providerId: 'p1' });
  assert.equal(result.mode, 'archived');
  assert.equal(result.provider.cost, 7);
  assert.equal(result.row.supplierConsumption, 7);
  assert.equal(result.row.profit, 3.12500001);
  assert.equal(result.row.supplierRequests, 9);
  assert.equal(result.row.complete, true);
  assert.equal(f.store.jobs(scope, date, date).length, 0);
  const saved = f.store.list(scope, date, date)[0];
  assert.equal(saved.row.supplierConsumption, 7);
  assert.equal(saved.computedAt, before.computedAt);
});

test('an incomplete manual provider refresh preserves the last complete archive and schedules a retry', async t => {
  const f = fixture(t);
  const date = '2026-10-30', scope = f.service.scope();
  await f.service.getDailyProfit({ start: date, end: date });
  await f.service.drain();
  const before = f.store.list(scope, date, date)[0];
  f.analysis.getSupplierDailyCost = async (requestedDate, providerId) => ({
    date: requestedDate,
    provider: { id: providerId, name: 'Enabled supplier', cost: null, complete: false, reasons: ['上游连接暂不可用'] }
  });
  const result = await f.service.refreshProvider({ date, providerId: 'p1' });
  assert.equal(result.provider.complete, false);
  assert.equal(result.row.supplierConsumption, before.row.supplierConsumption);
  assert.equal(result.row.complete, true);
  assert.equal(result.lastAttempt.errorCode, 'DAILY_PROFIT_INCOMPLETE');
  assert.equal(result.computedAt, before.computedAt);
  assert.equal(f.store.jobs(scope, date, date).length, 1);
  const saved = f.store.list(scope, date, date)[0];
  assert.equal(saved.row.supplierConsumption, before.row.supplierConsumption);
  assert.equal(saved.computedAt, before.computedAt);
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

test('manual provider refresh endpoint requires CSRF and returns the refreshed archived row', async t => {
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
  assert.equal(payload.row.supplierConsumption, 7);
  assert.equal(payload.provider.cost, 7);
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

test('old failed snapshots without jobs resume automatically and completed days never refresh upstream on page refresh', async t => {
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
  assert.equal(row.complete, true);
  assert.equal(row.lastAttempt.errorCode, null);
});

test('failed partial recalculations preserve full archived amounts, timestamps and isolated diagnostics after restart', async t => {
  const f = fixture(t), date = '2026-10-30', query = { start: date, end: date };
  await f.service.getDailyProfit(query);
  await f.service.drain();
  const original = (await f.service.getDailyProfit(query)).items[0];
  f.time('2026-10-31T04:05:00Z');
  await f.service.getDailyProfit({ ...query, recalculate: '1' });
  f.cost(null);
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
  f.analysis.createSupplierDailyCostsReader = async () => null;
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
