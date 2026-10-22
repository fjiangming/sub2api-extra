'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { SchemaInspector } = require('../src/schema-inspector');
const { CostAnalysisService } = require('../src/services/cost-analysis-service');

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
