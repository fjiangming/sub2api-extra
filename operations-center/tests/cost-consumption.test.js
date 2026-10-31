'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { SchemaInspector } = require('../src/schema-inspector');
const { CostAnalysisService } = require('../src/services/cost-analysis-service');
const { AppError } = require('../src/errors');

let database;
let inspector;
const expenses = [
  { date: '2025-12-31', amountMinor: 50 },
  { date: '2026-01-01', amountMinor: 1000 },
  { date: '2026-01-02', amountMinor: 600 },
  { date: '2026-01-05', amountMinor: 100 },
  { date: '2026-02-01', amountMinor: 200 },
  { date: '2026-02-02', amountMinor: 100 }
].map((entry) => ({ ...entry, kind: 'custom', name: 'Hosting', currency: 'CNY' }));

function service(config = {}) {
  return new CostAnalysisService({
    pool: database, inspector,
    config: { financeTimezone: 'Asia/Shanghai', sub2apiTimezone: 'Asia/Shanghai', ...config },
    store: {
      entries: () => [...expenses, { ...expenses[1], currency: 'USD', amountMinor: 99900 }],
      incomeEntries: () => [{ name: 'Manual', date: '2026-01-01', amountMinor: 25000, currency: 'CNY' }]
    }
  });
}

async function aggregate(timezone = 'Asia/Shanghai') {
  await database.exec('TRUNCATE usage_dashboard_daily');
  await database.query(`
    INSERT INTO usage_dashboard_daily
    SELECT date::date, COUNT(l.created_at)
    FROM generate_series('2025-12-30'::date, '2026-02-03'::date, INTERVAL '1 day') date
    LEFT JOIN usage_logs l ON (l.created_at AT TIME ZONE $1)::date = date::date
    GROUP BY 1
  `, [timezone]);
}

test.before(async () => {
  database = new PGlite();
  await database.exec(`
    CREATE TABLE users (id bigint PRIMARY KEY, balance numeric, deleted_at timestamptz);
    CREATE TABLE redeem_codes (id bigint, used_by bigint, used_at timestamptz,
      status text, type text, value numeric);
    CREATE TABLE usage_logs (id bigint PRIMARY KEY, user_id bigint, created_at timestamptz,
      billing_type smallint DEFAULT 0, actual_cost numeric);
    CREATE TABLE usage_dashboard_daily (bucket_date date PRIMARY KEY, total_requests bigint);
    INSERT INTO users VALUES (1, 999999, NULL), (2, 123, NULL), (3, 456, NOW());
    INSERT INTO redeem_codes VALUES
      (1, 2, '2026-01-01T00:00:00Z', 'used', 'balance', 1000);
  `);
  inspector = new SchemaInspector(database);
});

test.beforeEach(async () => {
  await database.exec(`
    TRUNCATE usage_logs;
    INSERT INTO usage_logs (id, user_id, created_at, billing_type, actual_cost) VALUES
      (1, 2, '2025-12-31T15:59:59Z', 0, 1),
      (2, 2, '2025-12-31T16:00:00Z', 0, 8.125),
      (3, 1, '2026-01-01T00:00:00Z', 0, 10000),
      (4, 3, '2026-01-01T00:00:00Z', 0, 2),
      (5, 99, '2026-01-01T00:00:00Z', 0, 3),
      (6, 2, '2026-01-01T00:00:00Z', 1, 999),
      (7, 2, '2026-01-01T00:00:00Z', NULL, 333),
      (8, 2, '2026-01-01T15:59:59.999999Z', 0, 0.00000001),
      (9, 2, '2026-01-01T16:00:00Z', 0, 4),
      (10, 2, '2026-01-04T16:00:00Z', 0, 5),
      (11, 2, '2026-01-31T16:00:00Z', 0, 7),
      (12, 2, '2026-02-02T16:00:00Z', 0, 99999);
  `);
  await aggregate();
});

test.after(async () => { await database?.close(); });

test('balance consumption excludes admin and subscriptions, preserves deleted identities and exact finance-day boundaries', async () => {
  const report = await service().getReport({ start: '2026-01-01', end: '2026-01-02' });
  assert.deepEqual(report.periods.map((row) => [
    row.start, row.balanceConsumption, row.expense, row.consumptionProfit, row.consumptionComplete
  ]), [
    ['2026-01-01', 13.12500001, 10, 3.12500001, true],
    ['2026-01-02', 4, 6, -2, true]
  ]);
  assert.equal(report.summary.automaticRevenue, 1000);
  assert.equal(report.summary.manualRevenue, 250);
  assert.equal(report.summary.userBalance, 123);
  assert.deepEqual(report.notices, []);
});

test('all granularities sum consumption and expenses once, including partial weeks and year boundaries', async () => {
  for (const granularity of ['day', 'week', 'month', 'year']) {
    const report = await service().getReport({ start: '2025-12-31', end: '2026-02-02', granularity });
    assert.equal(Number(report.periods.reduce((sum, row) => sum + row.balanceConsumption, 0).toFixed(8)), 30.12500001);
    assert.equal(Number(report.periods.reduce((sum, row) => sum + row.consumptionProfit, 0).toFixed(8)), 9.62500001);
    assert.ok(report.periods.every((row) => row.consumptionComplete));
    if (granularity === 'month') {
      assert.deepEqual(report.periods.map((row) => [row.label, row.balanceConsumption, row.consumptionProfit]), [
        ['2025-12', 1, 0.5], ['2026-01', 22.12500001, 5.12500001], ['2026-02', 7, 4]
      ]);
    }
    if (granularity === 'week') {
      assert.equal(report.periods[0].end, '2026-01-04');
      assert.equal(report.periods[0].balanceConsumption, 18.12500001);
      assert.equal(report.periods[1].balanceConsumption, 5);
    }
  }
});

test('known zero-use days retain expenses and negative profit without fabricating revenue', async () => {
  const report = await service().getReport({ start: '2026-02-02', end: '2026-02-02' });
  assert.equal(report.periods[0].balanceConsumption, 0);
  assert.equal(report.periods[0].consumptionProfit, -1);
  assert.equal(report.periods[0].consumptionComplete, true);
});

test('cleaned usage and missing daily buckets create gaps without hiding expenses or income', async () => {
  await database.exec("DELETE FROM usage_logs WHERE id = 8; DELETE FROM usage_dashboard_daily WHERE bucket_date = '2026-01-03'");
  const report = await service().getReport({ start: '2026-01-01', end: '2026-01-03' });
  assert.deepEqual(report.periods.map((row) => [row.balanceConsumption, row.consumptionProfit, row.consumptionComplete]), [
    [null, null, false], [4, -2, true], [null, null, false]
  ]);
  assert.equal(report.periods[0].expense, 10);
  assert.equal(report.summary.automaticRevenue, 1000);
  assert.match(report.notices[0], /明细不完整/);
  const monthly = await service().getReport({ start: '2026-01-01', end: '2026-01-03', granularity: 'month' });
  assert.equal(monthly.periods[0].balanceConsumption, null);
  assert.equal(monthly.periods[0].consumptionProfit, null);
  assert.equal(monthly.periods[0].expense, 16);
});

test('finance dates can span multiple usage days without duplicating consumption or comparing mismatched buckets', async () => {
  await aggregate('UTC');
  const costs = service({ sub2apiTimezone: 'UTC' });
  const report = await costs.getReport({ start: '2026-01-01', end: '2026-01-02' });
  assert.equal(report.periods[0].balanceConsumption, 13.12500001);
  assert.equal(report.periods[1].balanceConsumption, 4);
  assert.deepEqual(report.notices, []);
  await database.exec("UPDATE usage_dashboard_daily SET total_requests = total_requests + 1 WHERE bucket_date = '2025-12-31'");
  const incomplete = await costs.getReport({ start: '2026-01-01', end: '2026-01-02' });
  assert.equal(incomplete.periods[0].consumptionProfit, null);
  assert.equal(incomplete.periods[1].consumptionProfit, -2);
});

test('other currencies and missing usage tables leave consumption unavailable while keeping financial reports usable', async () => {
  const usd = await service().getReport({ start: '2026-01-01', end: '2026-01-01', currency: 'USD' });
  assert.equal(usd.periods[0].balanceConsumption, null);
  assert.equal(usd.periods[0].consumptionProfit, null);
  assert.equal(usd.periods[0].expense, 999);
  assert.match(usd.notices[0], /仅适用于 CNY/);
  const costs = service();
  costs.inspector = { requireTables: async (names) => names.filter((name) => name === 'usage_logs') };
  const missing = await costs.getReport({ start: '2026-01-01', end: '2026-01-01' });
  assert.equal(missing.summary.automaticRevenue, 1000);
  assert.equal(missing.periods[0].balanceConsumption, null);
  assert.equal(missing.periods[0].expense, 10);
  assert.match(missing.notices[0], /缺少用量明细/);
});

function dailyCosts(from, to, change = (item) => item) {
  const items = [];
  for (let date = from; date <= to;) {
    items.push(change({ date, complete: true, cost: 2.5, requests: 2,
      providers: [{ id: 'p1', name: 'Supplier', cost: 2.5, complete: true, reasons: [] }] }));
    const next = new Date(`${date}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    date = next.toISOString().slice(0, 10);
  }
  return { range: { start: from, end: to }, source: 'upstream_daily_summary', scope: 'account', providerFilter: 'scheduled_enabled',
    currency: 'CNY', timezone: 'Asia/Shanghai', items };
}

function withSuppliers(costs, getDailyCosts = async ({ from, to }) => dailyCosts(from, to)) {
  costs.providerMonitor = { configured: () => true, integrationToken: 'integration', getDailyCosts,
    async createDailyCostsReader(token) { return (query) => this.getDailyCosts(query, token); } };
  return costs;
}

test('daily real profit uses all non-admin actual costs and upstream costs, independent of topups, manual ledgers and granularity', async () => {
  const report = await withSuppliers(service()).getDailyProfit({
    start: '2026-01-01', end: '2026-01-03', granularity: 'month'
  });
  assert.deepEqual(report.items.map((row) => [row.date, row.siteConsumption, row.supplierConsumption,
    row.profit, row.margin, row.siteRequests, row.complete]), [
    ['2026-01-03', 0, 2.5, -2.5, null, 0, true],
    ['2026-01-02', 4, 2.5, 1.5, 37.5, 1, true],
    ['2026-01-01', 1345.12500001, 2.5, 1342.62500001, 99.81, 6, true]
  ]);
  assert.equal(report.summary.siteConsumption, 1349.12500001);
  assert.equal(report.summary.supplierConsumption, 7.5);
  assert.equal(report.summary.profit, 1341.62500001);
  assert.equal(report.summary.completeDays, 3);
  assert.equal(report.currency, 'CNY');
  assert.equal(report.timezone, 'Asia/Shanghai');
});

test('the lightweight financial report skips usage scans and real-income trends aggregate the exact daily rows', async () => {
  const costs = withSuppliers(service());
  const originalQuery = costs.pool.query.bind(costs.pool);
  costs.pool = { query(sql, params) {
    assert.doesNotMatch(sql, /FROM usage_logs/);
    return originalQuery(sql, params);
  } };
  const finance = await costs.getReport({ start: '2026-01-01', end: '2026-01-03', include_consumption: '0' });
  assert.equal(finance.summary.automaticRevenue, 1000);
  assert.deepEqual(finance.notices, []);
  costs.pool = database;
  for (const granularity of ['day', 'week', 'month', 'year']) {
    const report = await costs.getDailyProfit({ start: '2026-01-01', end: '2026-01-03', granularity });
    assert.equal(report.periods.reduce((sum, row) => sum + row.supplierConsumption, 0), 7.5);
    assert.equal(Number(report.periods.reduce((sum, row) => sum + row.profit, 0).toFixed(8)), report.summary.profit);
    assert.equal(report.periods[0].margin, granularity === 'day' ? 99.81 : report.summary.margin);
  }
});

test('daily profit handles finance and usage timezones independently and refuses incomplete main-site days', async () => {
  await aggregate('UTC');
  const costs = withSuppliers(service({ sub2apiTimezone: 'UTC' }));
  const input = { start: '2026-01-01', end: '2026-01-02' };
  assert.equal((await costs.getDailyProfit(input)).items[1].siteConsumption, 1345.12500001);
  await database.exec('DELETE FROM usage_logs WHERE id = 1');
  const report = await costs.getDailyProfit(input);
  assert.equal(report.items[1].siteConsumption, null);
  assert.equal(report.items[1].profit, null);
  assert.equal(report.items[1].supplierConsumption, 2.5);
  assert.equal(report.items[1].status, 'site_incomplete');
  assert.equal(report.items[0].profit, 1.5);
  assert.equal(report.summary.profit, null);
  assert.equal(report.summary.completeDays, 1);
});

test('daily profit keeps missing, duplicate, inconsistent and unsupported supplier data unknown', async () => {
  const variants = [
    (report) => ({ ...report, items: [] }),
    (report) => ({ ...report, currency: 'USD' }),
    (report) => ({ ...report, timezone: 'UTC' }),
    (report) => ({ ...report, source: 'unknown' }),
    (report) => ({ ...report, providerFilter: undefined }),
    (report) => ({ ...report, items: [...report.items, report.items[0]] }),
    (report) => ({ ...report, items: report.items.map((item) => ({ ...item, complete: false })) }),
    (report) => ({ ...report, items: report.items.map((item) => ({ ...item, cost: 3 })) }),
    (report) => ({ ...report, items: report.items.map((item) => ({ ...item, cost: null })) }),
    (report) => ({ ...report, items: report.items.map((item) => ({ ...item, providers: [] })) }),
    (report) => ({ ...report, items: report.items.map((item) => ({ ...item,
      providers: [{ ...item.providers[0], complete: false }] })) }),
    (report) => ({ ...report, items: report.items.map((item) => ({ ...item,
      providers: [item.providers[0], item.providers[0]] })) })
  ];
  for (const change of variants) {
    const costs = withSuppliers(service(), async ({ from, to }) => change(dailyCosts(from, to)));
    const report = await costs.getDailyProfit({ start: '2026-01-01', end: '2026-01-01' });
    assert.equal(report.items[0].siteConsumption, 1345.12500001);
    assert.equal(report.items[0].supplierConsumption, null);
    assert.equal(report.items[0].profit, null);
    assert.equal(report.summary.profit, null);
  }
});

test('daily profit accepts verified zero cost and does not infer cost from an unconfigured or failed monitor', async () => {
  const costs = withSuppliers(service(), async ({ from, to }) => dailyCosts(from, to,
    (item) => ({ ...item, cost: 0, providers: [{ ...item.providers[0], cost: 0 }] })));
  assert.equal((await costs.getDailyProfit({ start: '2026-01-02', end: '2026-01-02' })).items[0].profit, 4);
  for (const configured of [false, true]) {
    costs.providerMonitor.configured = () => configured;
    costs.providerMonitor.getDailyCosts = async () => { throw new Error('monitor unavailable'); };
    const report = await costs.getDailyProfit({ start: '2026-01-02', end: '2026-01-02' });
    assert.equal(report.items[0].profit, null);
    assert.match(report.notices.join(), /供应商实际消费暂不可用/);
  }
});

test('daily supplier queries read each finance day once across year boundaries and pass the SSO token', async () => {
  const calls = [];
  const costs = withSuppliers(service(), async (query, token) => {
    calls.push({ query, token });
    return dailyCosts(query.from, query.to);
  });
  costs.providerMonitor.integrationToken = null;
  await costs.getDailyProfit({ start: '2025-01-01', end: '2026-01-02' }, { accessToken: 'browser-sso' });
  assert.equal(calls.length, 367);
  assert.equal(new Set(calls.map(({ query }) => query.from)).size, 367);
  assert.equal(calls[0].query.from, '2025-01-01');
  assert.equal(calls.at(-1).query.from, '2026-01-02');
  assert.ok(calls.every(({ query }) => query.from === query.to));
  assert.ok(calls.every(({ query, token }) => query.timezone === 'Asia/Shanghai' &&
    query.currency === 'CNY' && token === 'browser-sso'));
});

test('one failed day retains all other supplier costs and marks only the missing day unknown', async () => {
  const calls = [];
  const costs = withSuppliers(service(), async ({ from, to }) => {
    calls.push(from);
    if (from === '2026-01-02') throw new AppError('PROVIDER_MONITOR_TIMEOUT', 'private upstream details');
    return dailyCosts(from, to);
  });
  const report = await costs.getDailyProfit({ start: '2026-01-01', end: '2026-01-03' });
  assert.deepEqual(calls, ['2026-01-01', '2026-01-02', '2026-01-03']);
  assert.deepEqual(report.items.map((item) => [item.date, item.supplierConsumption]), [
    ['2026-01-03', 2.5], ['2026-01-02', null], ['2026-01-01', 2.5]
  ]);
  assert.equal(report.summary.supplierConsumption, null);
  assert.match(report.notices.join(), /2026-01-02 获取失败.*超时/);
  assert.doesNotMatch(report.notices.join(), /private upstream details/);
});

test('explicit daily profit refresh bypasses upstream summary caches for every selected date', async () => {
  const queries = [];
  const costs = withSuppliers(service(), async (query) => { queries.push(query); return dailyCosts(query.from, query.to); });
  await costs.getDailyProfit({ start: '2026-01-01', end: '2026-01-02', refresh: '1' });
  assert.equal(queries.length, 2);
  assert.ok(queries.every((query) => query.refresh === '1' && query.from === query.to));
});

test('consecutive failures and global authentication failures stop bounded daily reads while preserving successful days', async () => {
  for (const [error, expectedCalls, skipped] of [
    [new AppError('PROVIDER_MONITOR_TIMEOUT', 'timeout'), 4, '2026-01-05'],
    [new AppError('PROVIDER_MONITOR_REQUEST_FAILED', 'auth', { details: { upstreamStatus: 401 } }), 2, '2026-01-03']
  ]) {
    let calls = 0;
    const costs = withSuppliers(service(), async ({ from, to }) => {
      calls += 1;
      if (from !== '2026-01-01') throw error;
      return dailyCosts(from, to);
    });
    const report = await costs.getDailyProfit({ start: '2026-01-01', end: '2026-01-05' });
    assert.equal(calls, expectedCalls);
    assert.equal(report.items.at(-1).supplierConsumption, 2.5);
    assert.ok(report.items.slice(0, -1).every((item) => item.supplierConsumption === null && item.profit === null));
    assert.ok(report.notices.some((notice) => notice.includes(`${skipped} 至 2026-01-05 暂停查询`)));
  }
});

test('daily profit handles missing usage tables and currencies without hiding unrelated financial data', async () => {
  const costs = withSuppliers(service());
  costs.inspector = { requireTables: async () => ['usage_logs'] };
  const missing = await costs.getDailyProfit({ start: '2026-01-01', end: '2026-01-01' });
  assert.equal(missing.items[0].siteConsumption, null);
  assert.equal(missing.items[0].supplierConsumption, 2.5);
  assert.equal(missing.items[0].profit, null);
  assert.match(missing.notices.join(), /主站消费无法核验/);
  let supplierCalls = 0;
  costs.providerMonitor.getDailyCosts = async () => { supplierCalls += 1; };
  const usd = await costs.getDailyProfit({ start: '2026-01-01', end: '2026-01-01', currency: 'USD' });
  assert.equal(usd.items[0].status, 'unsupported_currency');
  assert.equal(usd.items[0].profit, null);
  assert.equal(supplierCalls, 0);
});

test('daily supplier failures identify missing exchange rates, versions, auth and connectivity without leaking upstream errors', async () => {
  const unsafe = 'https://private.example/api?token=secret-api-key';
  for (const [error, expected] of [
    [new AppError('PROVIDER_MONITOR_REQUEST_FAILED', unsafe, { details: {
      upstreamStatus: 400, upstreamCode: 'CURRENCY_RATE_MISSING' } }), /缺少 CNY 换算汇率.*设置与备份.*运行设置.*汇率（JSON）/],
    [new AppError('PROVIDER_MONITOR_AUTH_NOT_CONFIGURED', unsafe), /认证未配置或未通过/],
    [new AppError('PROVIDER_MONITOR_REQUEST_FAILED', unsafe, { details: { upstreamStatus: 401 } }), /认证未配置或未通过/],
    [new AppError('PROVIDER_MONITOR_REQUEST_FAILED', unsafe, { details: { upstreamStatus: 403 } }), /认证未配置或未通过/],
    [new AppError('PROVIDER_MONITOR_REQUEST_FAILED', unsafe, { details: { upstreamStatus: 404 } }), /HTTP 404.*配套更新/],
    [new AppError('PROVIDER_MONITOR_INVALID_RESPONSE', unsafe), /数据格式不兼容/],
    [new AppError('PROVIDER_MONITOR_TIMEOUT', unsafe), /请求供应商监控超时/],
    [new AppError('PROVIDER_MONITOR_UNAVAILABLE', unsafe), /无法连接供应商监控/],
    [new AppError('PROVIDER_MONITOR_REQUEST_FAILED', unsafe, { details: { upstreamStatus: 400 } }), /日期、时区或币种参数/],
    [new AppError('PROVIDER_MONITOR_REQUEST_FAILED', unsafe, { details: { upstreamStatus: 502 } }), /接口异常（HTTP 502）/],
    [new Error(unsafe), /未能取得有效的每日消费数据/]
  ]) {
    const costs = withSuppliers(service(), async () => { throw error; });
    const report = await costs.getDailyProfit({ start: '2026-01-02', end: '2026-01-02' });
    assert.match(report.notices.join(), expected);
    assert.doesNotMatch(JSON.stringify(report), /private\.example|secret-api-key/);
    assert.equal(report.items[0].siteConsumption, 4);
    assert.equal(report.items[0].supplierConsumption, null);
    assert.equal(report.items[0].profit, null);
  }
  const report = await service().getDailyProfit({ start: '2026-01-02', end: '2026-01-02' });
  assert.match(report.notices.join(), /未配置供应商监控地址.*PROVIDER_MONITOR_BASE_URL/);
});

test('daily supplier HTML, old report contracts and duplicate dates are diagnosed as incompatible data', async () => {
  for (const change of [
    () => ({}),
    (report) => ({ ...report, source: 'old-version' }),
    (report) => ({ ...report, source: 'provider_cost_ledger' }),
    (report) => ({ ...report, scope: 'key' }),
    (report) => ({ ...report, items: [...report.items, report.items[0]] })
  ]) {
    const costs = withSuppliers(service(), async ({ from, to }) => change(dailyCosts(from, to)));
    const report = await costs.getDailyProfit({ start: '2026-01-02', end: '2026-01-02' });
    assert.match(report.notices.join(), /数据格式不兼容/);
    assert.equal(report.items[0].profit, null);
  }
});
