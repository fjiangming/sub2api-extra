const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');
const { ProviderRepository } = require('../src/repositories/provider-repository');
const { DailyCostService } = require('../src/services/daily-cost-service');
const { createApplication } = require('../src/server');
const { createDatabase } = require('../src/db');
const { AppError } = require('../src/errors');

function fixture(t, specifications = [{ type: 'sub2api' }, { type: 'new-api' }]) {
  const context = createTestContext({ PROVIDER_MONITOR_INTEGRATION_TOKEN: 'daily-summary-integration-token-32-characters' });
  const finalizers = [];
  t.after(async () => { for (const close of finalizers) await close(); context.cleanup(); });
  const providers = new ProviderRepository(context.db, context.config);
  let clock = new Date('2026-10-31T12:00:00Z');
  const calls = [];
  const states = specifications.map((spec, index) => {
    const provider = providers.create({ name: `Supplier ${index}`, adapterType: spec.type,
      baseUrl: `https://supplier-${index}.example`, authMode: spec.authMode || (spec.type === 'sub2api' ? 'token_pair' : 'system_token'),
      credentials: { accessToken: 'synthetic-access', systemToken: 'synthetic-system', userId: '7' },
      rechargeMultiplier: 2, typeConfig: { monitoredKeyIds: ['123'] } });
    // The fixture has a verified rate covering the queried historical days.
    context.db.prepare(`UPDATE provider_recharge_rate_history SET valid_from='2026-01-01T00:00:00.000Z',
      paid_currency='USD', balance_currency='USD' WHERE connection_id=?`).run(provider.id);
    return { provider, amount: 12, requests: 3, ...spec };
  });
  context.db.prepare("INSERT OR REPLACE INTO settings VALUES ('currencyRates', ?, '2026-10-31')")
    .run(JSON.stringify({ USD: 1, CNY: 1 }));
  const http = { async requestJson(input, options = {}) {
    const url = new URL(input);
    calls.push({ url, options });
    const state = states[Number(url.hostname.match(/supplier-(\d+)/)[1])];
    if (state.error) throw state.error;
    if (state.beforeResponse) await state.beforeResponse(url);
    let data;
    if (url.pathname === '/api/v1/user/profile') data = { code: 0, data: { id: 7, username: 'daily-user' } };
    else if (url.pathname === '/api/v1/auth/refresh') data = { code: 0, data: {
      access_token: 'renewed-synthetic-access', refresh_token: 'renewed-synthetic-refresh', expires_in: 3600 } };
    else if (url.pathname === '/api/user/self') data = { success: true, data: { id: 7, username: 'daily-user' } };
    else if (url.pathname === '/api/status') data = { success: true, data: { quota_per_unit: state.divisor ?? 1000 } };
    else if (url.pathname === '/api/v1/usage/stats') data = { code: 0, data: state.payload ?? {
      total_actual_cost: typeof state.amount === 'function' ? state.amount(url.searchParams.get('start_date')) : state.amount,
      total_cost: 999999, total_requests: state.requests
    } };
    else if (url.pathname === '/api/log/self/stat') data = { success: true, data: state.payload ?? {
      quota: state.amount * (state.divisor ?? 1000), rpm: 99999, tpm: 9999999
    } };
    else throw new Error(`Unexpected endpoint ${url.pathname}`);
    return { data };
  } };
  const service = new DailyCostService({ ...context, providers, http, now: () => new Date(clock) });
  return { ...context, providers, service, states, calls, http, finalizers,
    advance(milliseconds) { clock = new Date(clock.getTime() + milliseconds); } };
}

const query = { from: '2026-10-29', to: '2026-10-29', timezone: 'Asia/Shanghai', currency: 'CNY' };

test('daily costs read upstream account aggregates without keys or logs and never add the old ledger', async (t) => {
  const f = fixture(t);
  const report = await f.service.report(query);
  assert.equal(report.source, 'upstream_daily_summary');
  assert.equal(report.scope, 'account');
  assert.equal(report.items[0].cost, 12);
  assert.equal(report.items[0].complete, true);
  assert.deepEqual(report.items[0].providers.map((provider) => provider.cost), [6, 6]);
  assert.equal(report.items[0].providers[0].requests, 3);
  assert.equal(report.items[0].providers[1].requests, null);
  assert.equal(report.items[0].requests, null);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM provider_cost_ledger').get().n, 0);
  assert.ok(f.calls.every(({ url, options }) => !/keys|token\/|logs/.test(url.pathname) &&
    !url.searchParams.has('api_key_id') && !url.searchParams.has('token_name') &&
    options.retries === 0 && options.timeoutMs > 0 && options.timeoutMs <= 5000));
  const sub = f.calls.find(({ url }) => url.pathname === '/api/v1/usage/stats').url;
  assert.deepEqual(Object.fromEntries(sub.searchParams), {
    start_date: query.from, end_date: query.from, timezone: query.timezone });
  const newApi = f.calls.find(({ url }) => url.pathname === '/api/log/self/stat');
  assert.equal(newApi.options.headers['New-Api-User'], '7');
  assert.equal(newApi.url.searchParams.get('type'), '2');
  assert.equal(Number(newApi.url.searchParams.get('start_timestamp')), Date.parse('2026-10-28T16:00:00Z') / 1000);
  assert.equal(Number(newApi.url.searchParams.get('end_timestamp')), Date.parse('2026-10-29T16:00:00Z') / 1000 - 1);
  assert.doesNotMatch(JSON.stringify(report), /synthetic-|supplier-\d\.example|account_key|config_key|subjectId/);
  const cached = await f.service.report(query);
  assert.ok(cached.items[0].providers.every((provider) => provider.cached));
  assert.equal(f.calls.length, 5);
});

test('concurrent refreshes share reads and replace each daily snapshot instead of accumulating costs', async (t) => {
  const f = fixture(t);
  const results = await Promise.all(Array.from({ length: 4 }, () => f.service.report(query)));
  assert.ok(results.every((report) => report.items[0].cost === 12));
  assert.equal(f.calls.length, 5);
  f.states[0].amount = 16;
  assert.equal((await f.service.report({ ...query, refresh: '1' })).items[0].cost, 14);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM provider_daily_cost_summaries').get().n, 2);
  f.states[0].amount = 4;
  assert.equal((await f.service.report({ ...query, refresh: true })).items[0].cost, 8);
  f.advance(3600001);
  f.states[0].amount = 8;
  assert.equal((await f.service.report(query)).items[0].cost, 10);
});

test('cache survives reopening the database, expires by date and recomputes currency conversion', async (t) => {
  const f = fixture(t, [{ type: 'sub2api' }]);
  await f.service.report(query);
  const filename = f.config.databasePath;
  f.db.close();
  const reopened = createDatabase(filename);
  f.finalizers.push(() => reopened.close());
  const repository = new ProviderRepository(reopened, f.config);
  const service = new DailyCostService({ db: reopened, config: f.config, providers: repository,
    http: { requestJson() { throw new Error('A fresh persisted snapshot should avoid network reads'); } },
    now: () => new Date('2026-10-31T12:00:30Z') });
  reopened.prepare("UPDATE settings SET value_json=? WHERE key='currencyRates'").run(JSON.stringify({ USD: 1, CNY: 0.2 }));
  assert.equal((await service.report(query)).items[0].cost, 30);
  assert.ok(reopened.prepare('SELECT 1 FROM schema_migrations WHERE version=34').get());
});

test('today snapshots expire after one minute and a failed provider does not hide successful suppliers', async (t) => {
  const f = fixture(t);
  const today = { ...query, from: '2026-10-31', to: '2026-10-31' };
  await f.service.report(today);
  f.advance(61000);
  f.states[1].error = new AppError('RATE_LIMITED', 'private token and upstream URL');
  const report = await f.service.report(today);
  assert.equal(report.items[0].cost, null);
  assert.equal(report.items[0].providers[0].cost, 6);
  assert.equal(report.items[0].providers[1].cost, null);
  assert.match(report.items[0].providers[1].reasons.join(), /限流/);
  assert.doesNotMatch(JSON.stringify(report), /private|token and/);
  const before = f.calls.length;
  await f.service.report({ ...query, from: '2026-10-30', to: '2026-10-30' });
  assert.equal(f.calls.length, before + 2);
});

test('crossing midnight refreshes a partial day even while its cache is still fresh', async (t) => {
  const f = fixture(t, [{ type: 'sub2api' }]);
  f.advance((3 * 3600 + 59 * 60 + 45) * 1000);
  const today = { ...query, from: '2026-10-31', to: '2026-10-31' };
  assert.equal((await f.service.report(today)).items[0].cost, 6);
  f.advance(30000);
  f.states[0].amount = 16;
  assert.equal((await f.service.report(today)).items[0].cost, 8);
  assert.equal(f.calls.length, 4);
});

test('a failed forced refresh cannot be hidden by a previously fresh cached amount', async (t) => {
  const f = fixture(t, [{ type: 'sub2api' }]);
  assert.equal((await f.service.report(query)).items[0].cost, 6);
  f.states[0].payload = { total_cost: 9999, total_requests: 0 };
  assert.equal((await f.service.report({ ...query, refresh: true })).items[0].cost, null);
  assert.equal((await f.service.report(query)).items[0].cost, null);
  f.states[0].payload = null;
  assert.equal((await f.service.report(query)).items[0].cost, 6);
});

test('missing, boolean, negative and nominal-only amounts never turn into zero costs', async (t) => {
  for (const payload of [{ total_cost: 12, total_requests: 3 },
    { total_actual_cost: null, total_requests: 0 }, { total_actual_cost: false, total_requests: 0 },
    { total_actual_cost: -1, total_requests: 3 }, { total_actual_cost: 1, total_requests: false }]) {
    const f = fixture(t, [{ type: 'sub2api', payload }]);
    const report = await f.service.report(query);
    assert.equal(report.items[0].cost, null);
    assert.match(report.items[0].providers[0].reasons.join(), /缺少有效/);
  }
  for (const spec of [{ payload: { rpm: 10 } }, { payload: { quota: false } },
    { payload: { quota: -10 } }, { divisor: 0 }, { divisor: false }]) {
    const f = fixture(t, [{ type: 'new-api', ...spec }]);
    assert.equal((await f.service.report(query)).items[0].cost, null);
  }
  const zero = fixture(t, [{ type: 'sub2api', amount: 0 }, { type: 'new-api', amount: 0 }]);
  zero.db.prepare('DELETE FROM provider_recharge_rate_history').run();
  assert.equal((await zero.service.report(query)).items[0].cost, 0);
});

test('historical recharge rates apply by day and unverified or changing rates do not fabricate cash profit', async (t) => {
  const f = fixture(t, [{ type: 'sub2api' }]);
  const id = f.states[0].provider.id;
  f.db.prepare("UPDATE provider_recharge_rate_history SET valid_to='2026-10-29T16:00:00.000Z' WHERE connection_id=?").run(id);
  f.db.prepare(`INSERT INTO provider_recharge_rate_history(connection_id, multiplier, source, status,
    paid_currency, balance_currency, valid_from, observed_at)
    VALUES (?, 4, 'manual', 'manual', 'USD', 'USD', '2026-10-29T16:00:00.000Z', '2026-10-29T16:00:00.000Z')`).run(id);
  const report = await f.service.report({ ...query, to: '2026-10-30' });
  assert.deepEqual(report.items.map((item) => item.cost), [6, 3]);
  f.db.prepare("UPDATE provider_recharge_rate_history SET valid_from='2026-10-29T20:00:00.000Z' WHERE multiplier=4").run();
  const gap = await f.service.report({ ...query, from: '2026-10-30', to: '2026-10-30' });
  assert.equal(gap.items[0].cost, null);
  assert.match(gap.items[0].providers[0].reasons.join(), /缺少完整/);
  f.db.prepare("UPDATE provider_recharge_rate_history SET valid_to='2026-10-29T20:00:00.000Z' WHERE multiplier=2").run();
  const changed = await f.service.report({ ...query, from: '2026-10-30', to: '2026-10-30' });
  assert.equal(changed.items[0].cost, null);
  assert.match(changed.items[0].providers[0].reasons.join(), /倍率发生变化/);
});

test('timezone boundaries handle daylight saving and consecutive New API days never overlap', async (t) => {
  const f = fixture(t, [{ type: 'new-api' }]);
  await f.service.report({ ...query, from: '2026-03-08', to: '2026-03-09', timezone: 'America/New_York' });
  const calls = f.calls.filter(({ url }) => url.pathname === '/api/log/self/stat').map(({ url }) => ({
    start: Number(url.searchParams.get('start_timestamp')), end: Number(url.searchParams.get('end_timestamp')) }));
  assert.equal(calls[0].end - calls[0].start + 1, 23 * 3600);
  assert.equal(calls[0].end + 1, calls[1].start);
  assert.equal(calls[1].end - calls[1].start + 1, 24 * 3600);
});

test('changed account credentials invalidate cached snapshots and duplicate accounts cannot be summed twice', async (t) => {
  const f = fixture(t, [{ type: 'sub2api' }, { type: 'sub2api' }]);
  await f.service.report(query);
  f.providers.updateCredentials(f.states[0].provider.id, { accessToken: 'new-synthetic-access' });
  f.states[0].amount = 8;
  assert.equal((await f.service.report(query)).items[0].cost, 10);
  f.providers.update(f.states[1].provider.id, { baseUrl: 'https://supplier-0.example/alias' });
  const duplicate = await f.service.report(query);
  assert.equal(duplicate.items[0].cost, null);
  assert.ok(duplicate.items[0].providers.every((provider) => provider.reasons.some((reason) => reason.includes('重复配置'))));
});

test('unsupported credentials, future dates and missing target rates never trigger a fallback to key logs', async (t) => {
  const f = fixture(t, [{ type: 'sub2api', authMode: 'api_key' }, { type: 'one-api' }]);
  const unsupported = await f.service.report(query);
  assert.equal(unsupported.items[0].cost, null);
  assert.match(unsupported.items[0].providers[0].reasons.join(), /账号日汇总需要/);
  assert.match(unsupported.items[0].providers[1].reasons.join(), /暂不支持/);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.service.report({ ...query, from: '2026-11-01', to: '2026-11-01' })).items[0].cost, null);
  f.db.prepare("UPDATE settings SET value_json='{}' WHERE key='currencyRates'").run();
  await assert.rejects(f.service.report(query), { code: 'CURRENCY_RATE_MISSING' });
  await assert.rejects(f.service.report({ ...query, from: '2026-02-30' }), { code: 'VALIDATION_ERROR' });
  assert.equal(f.calls.length, 0);
});

test('provider time budgets isolate slow suppliers without retries or exhausting later providers', async (t) => {
  const f = fixture(t);
  f.config.globalConcurrency = 1;
  let wall = Date.now();
  t.mock.method(Date, 'now', () => wall);
  f.states[0].beforeResponse = async () => { wall += 5001; };
  const report = await f.service.report(query);
  assert.equal(report.items[0].providers[0].cost, null);
  assert.match(report.items[0].providers[0].reasons.join(), /超时/);
  assert.equal(report.items[0].providers[1].cost, 6);
  assert.equal(f.calls.filter(({ url }) => url.hostname === 'supplier-0.example').length, 1);
});

test('token refresh persists safely and configuration changes during reads cannot save the wrong account snapshot', async (t) => {
  const f = fixture(t, [{ type: 'sub2api' }]);
  const id = f.states[0].provider.id;
  f.providers.updateCredentials(id, { accessToken: 'old-access', refreshToken: 'old-refresh', tokenExpiresAt: Date.now() - 10000 });
  assert.equal((await f.service.report(query)).items[0].cost, 6);
  assert.equal(f.providers.getCredentials(id).refreshToken, 'renewed-synthetic-refresh');
  const before = f.calls.length;
  await f.service.report(query);
  assert.equal(f.calls.length, before);
  f.states[0].beforeResponse = async (url) => {
    if (url.pathname.endsWith('/stats')) f.providers.updateCredentials(id, { accessToken: 'different-account' });
  };
  const changed = await f.service.report({ ...query, from: '2026-10-30', to: '2026-10-30' });
  assert.equal(changed.items[0].cost, null);
  assert.match(changed.items[0].providers[0].reasons.join(), /配置发生变化/);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM provider_daily_cost_summaries WHERE usage_date='2026-10-30'").get().n, 0);
});

test('daily summary HTTP keeps authentication and returns both real adapter aggregates without a log sync', async (t) => {
  const f = fixture(t);
  const app = createApplication({ config: f.config, db: f.db, http: f.http, startBackground: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  f.finalizers.push(async () => { await new Promise((resolve) => server.close(resolve)); await app.locals.close(); });
  const url = `http://127.0.0.1:${server.address().port}/api/integrations/daily-costs?${new URLSearchParams(query)}`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal(f.calls.length, 0);
  const response = await fetch(url, { headers: { authorization: `Bearer ${f.config.integrationToken}` } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).items[0].cost, 12);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM provider_request_samples').get().n, 0);
});
