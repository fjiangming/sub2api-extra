'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CostLedgerStore } = require('../src/cost-ledger-store');
const { CostAnalysisService, createPeriods, periodStart } = require('../src/services/cost-analysis-service');

async function createService(t, rows = [], balance = { user_balance: '0', balance_users: '0' }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'operations-center-cost-analysis-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new CostLedgerStore(directory);
  await store.initialize();
  const queries = [];
  const service = new CostAnalysisService({
    pool: {
      async query(sql, params) {
        queries.push({ sql, params });
        if (/FROM users/.test(sql)) return { rows: [balance] };
        return { rows };
      }
    },
    inspector: { requireTables: async () => [] },
    config: { financeTimezone: 'Asia/Shanghai' },
    store,
    providerMonitor: { configured: () => false, integrationToken: null },
    sub2api: { configured: () => false }
  });
  return { service, store, queries };
}

test('cost analysis aggregates used balance redemptions, manual income and expenses by Monday-based weeks', async (t) => {
  const { service, store, queries } = await createService(t, [
    { date: '2026-09-01', transactions: '2', revenue: '100.00' },
    { date: '2026-09-08', transactions: '1', revenue: '50.00' }
  ], { user_balance: '25.00', balance_users: '4' });
  await store.replaceProviders([{
    id: 'provider-1', name: 'Provider One', adapterType: 'custom', enabled: true, currency: 'CNY'
  }]);
  await service.createExpense({
    kind: 'custom', name: '服务器', date: '2026-09-01', amount: 40, currency: 'CNY', note: ''
  }, 'admin');
  await service.createIncome({
    name: '项目回款', date: '2026-09-02', amount: 20, currency: 'CNY', note: ''
  }, 'admin');
  await service.createIncome({
    name: '项目回款', date: '2026-09-09', amount: 10, currency: 'CNY', note: ''
  }, 'admin');
  await service.createExpense({
    kind: 'provider', providerId: 'provider-1', name: '', date: '2026-09-08', amount: 30,
    currency: 'CNY', note: ''
  }, 'admin');

  const report = await service.getReport({
    start: '2026-09-01', end: '2026-09-10', granularity: 'week', currency: 'cny'
  });
  assert.deepEqual(report.summary, {
    automaticRevenue: 150,
    manualRevenue: 30,
    revenue: 180,
    expense: 70,
    profit: 110,
    margin: 61.11,
    userBalance: 25,
    balanceUsers: 4,
    actualProfit: 85,
    actualMargin: 47.22,
    transactions: 3,
    incomeCount: 2,
    expenseCount: 2,
    averageTransaction: 50
  });
  assert.equal(report.periods.length, 2);
  assert.deepEqual(report.periods.map((row) => [
    row.start, row.end, row.automaticRevenue, row.manualRevenue, row.revenue, row.expense, row.profit
  ]), [
    ['2026-09-01', '2026-09-06', 100, 20, 120, 40, 80],
    ['2026-09-07', '2026-09-10', 50, 10, 60, 30, 30]
  ]);
  assert.deepEqual(report.periods.map((row) => row.label), ['09-01 ~ 09-06', '09-07 ~ 09-10']);
  assert.deepEqual(report.breakdown.map((row) => [row.name, row.amount]), [['服务器', 40], ['Provider One', 30]]);
  assert.deepEqual(report.incomeBreakdown, [{ name: '项目回款', amount: 30, count: 2, percentage: 100 }]);
  assert.match(queries[0].sql, /SUM\(value\)/);
  assert.match(queries[0].sql, /FROM redeem_codes/);
  assert.match(queries[0].sql, /used_at >=/);
  assert.match(queries[0].sql, /status = 'used'/);
  assert.match(queries[0].sql, /type = 'balance'/);
  assert.match(queries[0].sql, /\$4 = 'CNY'/);
  assert.doesNotMatch(queries[0].sql, /payment_orders|pay_amount|\bJOIN\b/);
  assert.deepEqual(queries[0].params, ['2026-09-01', '2026-09-11', 'Asia/Shanghai', 'CNY']);
  assert.match(queries[1].sql, /SUM\(balance\)/);
  assert.match(queries[1].sql, /FROM users/);
  assert.match(queries[1].sql, /id <> 1/);
  assert.match(queries[1].sql, /deleted_at IS NULL/);
  assert.equal(queries[1].params, undefined);
});

test('cost analysis requires redeem codes and users for automatic income and current balance', async (t) => {
  const { service, queries } = await createService(t);
  let required;
  service.inspector = {
    requireTables: async (names) => {
      required = names;
      return ['redeem_codes'];
    }
  };

  await assert.rejects(
    service.getReport({ start: '2026-09-01', end: '2026-09-30', currency: 'CNY' }),
    (error) => error.code === 'SCHEMA_INCOMPATIBLE' &&
      error.message === '缺少必要数据表：redeem_codes' && error.status === 503
  );
  assert.deepEqual(required, ['redeem_codes', 'users']);
  assert.equal(queries.length, 0);
});

test('period helpers cover partial month and year ranges without dropping boundaries', () => {
  assert.equal(periodStart('2026-09-06', 'week'), '2026-08-31');
  assert.deepEqual(
    createPeriods({ start: '2025-12-20', end: '2026-02-02' }, 'month').map((row) => [row.start, row.end]),
    [['2025-12-20', '2025-12-31'], ['2026-01-01', '2026-01-31'], ['2026-02-01', '2026-02-02']]
  );
});

test('day, month and year reports keep revenue and expenses in the correct periods', async (t) => {
  const { service } = await createService(t, [
    { date: '2025-12-20', transactions: '1', revenue: '10.00' },
    { date: '2025-12-31', transactions: '1', revenue: '20.00' },
    { date: '2026-01-01', transactions: '1', revenue: '30.00' },
    { date: '2026-02-02', transactions: '1', revenue: '40.00' }
  ]);
  for (const [date, amount] of [
    ['2025-12-20', 1], ['2025-12-31', 2], ['2026-01-01', 3], ['2026-02-02', 4]
  ]) {
    await service.createExpense({
      kind: 'custom', name: 'Infrastructure', date, amount, currency: 'CNY', note: ''
    }, 'admin');
  }
  for (const [date, amount] of [
    ['2025-12-20', 5], ['2025-12-31', 6], ['2026-01-01', 7], ['2026-02-02', 8]
  ]) {
    await service.createIncome({
      name: 'Services', date, amount, currency: 'CNY', note: ''
    }, 'admin');
  }

  const daily = await service.getReport({
    start: '2026-01-01', end: '2026-01-02', granularity: 'day', currency: 'CNY'
  });
  assert.deepEqual(daily.periods.map((row) => [
    row.start, row.automaticRevenue, row.manualRevenue, row.revenue, row.expense
  ]), [
    ['2026-01-01', 30, 7, 37, 3], ['2026-01-02', 0, 0, 0, 0]
  ]);

  const monthly = await service.getReport({
    start: '2025-12-20', end: '2026-02-02', granularity: 'month', currency: 'CNY'
  });
  assert.deepEqual(monthly.periods.map((row) => [
    row.label, row.automaticRevenue, row.manualRevenue, row.revenue, row.expense
  ]), [
    ['2025-12', 30, 11, 41, 3], ['2026-01', 30, 7, 37, 3], ['2026-02', 40, 8, 48, 4]
  ]);

  const yearly = await service.getReport({
    start: '2025-12-20', end: '2026-02-02', granularity: 'year', currency: 'CNY'
  });
  assert.deepEqual(yearly.periods.map((row) => [
    row.label, row.automaticRevenue, row.manualRevenue, row.revenue, row.expense
  ]), [
    ['2025', 30, 11, 41, 3], ['2026', 70, 15, 85, 7]
  ]);
});

test('currency isolation includes manual-only income without changing the automatic-income average', async (t) => {
  const { service } = await createService(t, [], { user_balance: '10', balance_users: '2' });
  await service.createExpense({
    kind: 'custom', name: 'USD Hosting', date: '2026-09-20', amount: 25,
    currency: 'USD', note: 'monthly'
  }, 'admin');
  await service.createIncome({
    name: 'USD Services', date: '2026-09-12', amount: 50, currency: 'USD', note: 'manual'
  }, 'admin');
  await service.createIncome({
    name: 'CNY Services', date: '2026-09-12', amount: 999, currency: 'CNY', note: ''
  }, 'admin');
  await service.createExpense({
    kind: 'custom', name: 'USD Domain', date: '2026-09-10', amount: 5,
    currency: 'USD', note: ''
  }, 'admin');
  await service.createExpense({
    kind: 'custom', name: 'CNY Hosting', date: '2026-09-15', amount: 99,
    currency: 'CNY', note: ''
  }, 'admin');

  const report = await service.getReport({
    start: '2026-09-01', end: '2026-09-30', granularity: 'month', currency: 'usd'
  });
  assert.deepEqual(report.summary, {
    automaticRevenue: 0,
    manualRevenue: 50,
    revenue: 50,
    expense: 30,
    profit: 20,
    margin: 40,
    userBalance: null,
    balanceUsers: null,
    actualProfit: null,
    actualMargin: null,
    transactions: 0,
    incomeCount: 1,
    expenseCount: 2,
    averageTransaction: null
  });
  assert.equal(report.periods[0].margin, 40);
  assert.deepEqual(report.breakdown.map((row) => row.name), ['USD Hosting', 'USD Domain']);
  assert.deepEqual(report.incomeBreakdown.map((row) => row.name), ['USD Services']);
  assert.deepEqual(
    service.listExpenses({ start: '2026-09-01', end: '2026-09-30', currency: 'usd' })
      .map((entry) => [entry.date, entry.currency]),
    [['2026-09-20', 'USD'], ['2026-09-10', 'USD']]
  );
  assert.deepEqual(
    service.listIncomes({ start: '2026-09-01', end: '2026-09-30', currency: 'usd' })
      .map((entry) => [entry.date, entry.currency]),
    [['2026-09-12', 'USD']]
  );

  const expenseOnly = await service.getReport({
    start: '2026-09-13', end: '2026-09-30', granularity: 'month', currency: 'CNY'
  });
  assert.equal(expenseOnly.summary.revenue, 0);
  assert.equal(expenseOnly.summary.profit, -99);
  assert.equal(expenseOnly.summary.margin, null);
  assert.equal(expenseOnly.summary.userBalance, 10);
  assert.equal(expenseOnly.summary.balanceUsers, 2);
  assert.equal(expenseOnly.summary.actualProfit, -109);
  assert.equal(expenseOnly.summary.actualMargin, null);
});

test('invalid report inputs fail before querying Sub2API', async (t) => {
  const { service, queries } = await createService(t);
  await assert.rejects(
    service.getReport({ start: '2026-02-31', end: '2026-03-01', currency: 'CNY' }),
    (error) => error.code === 'INVALID_DATE_RANGE' && error.status === 400
  );
  await assert.rejects(
    service.getReport({ start: '2026-03-01', end: '2026-03-02', granularity: 'quarter', currency: 'CNY' }),
    (error) => error.code === 'INVALID_GRANULARITY' && error.status === 400
  );
  await assert.rejects(
    service.getReport({ start: '2026-03-01', end: '2026-03-02', currency: '$$$' }),
    (error) => error.code === 'INVALID_CURRENCY' && error.status === 400
  );
  assert.equal(queries.length, 0);
});

test('manual income supports validation, listing, updates and deletion', async (t) => {
  const { service } = await createService(t);
  const valid = {
    name: '  Consulting  ', date: '2026-09-01', amount: 10.25, currency: 'cny', note: 'initial'
  };
  const created = await service.createIncome(valid, 'admin');
  assert.equal(created.name, 'Consulting');
  assert.equal(created.currency, 'CNY');
  assert.equal(created.amount, 10.25);
  assert.equal(created.createdBy, 'admin');
  assert.deepEqual(service.listIncomeItems(), ['Consulting']);

  const updated = await service.updateIncome(created.id, {
    name: 'Services', date: '2026-09-02', amount: 12.5, currency: 'usd', note: 'updated'
  }, 'operator');
  assert.equal(updated.name, 'Services');
  assert.equal(updated.currency, 'USD');
  assert.equal(updated.updatedBy, 'operator');
  assert.deepEqual(service.listIncomes({ currency: 'usd' }).map((entry) => entry.id), [created.id]);

  await assert.rejects(
    service.createIncome({ ...valid, name: ' ' }, 'admin'),
    (error) => error.code === 'COST_INCOME_NAME_REQUIRED' && error.status === 400
  );
  await assert.rejects(
    service.createIncome({ ...valid, date: '2026-02-31' }, 'admin'),
    (error) => error.code === 'COST_INCOME_DATE_INVALID' && error.status === 400
  );
  await assert.rejects(
    service.createIncome({ ...valid, amount: 1.001 }, 'admin'),
    (error) => error.code === 'COST_INCOME_AMOUNT_INVALID' && error.status === 400
  );
  await assert.rejects(
    service.createIncome({ ...valid, currency: '$$$' }, 'admin'),
    (error) => error.code === 'COST_INCOME_CURRENCY_INVALID' && error.status === 400
  );
  await assert.rejects(
    service.updateIncome('missing', valid, 'admin'),
    (error) => error.code === 'COST_INCOME_NOT_FOUND' && error.status === 404
  );

  await service.deleteIncome(created.id);
  assert.deepEqual(service.listIncomes(), []);
  await assert.rejects(
    service.deleteIncome(created.id),
    (error) => error.code === 'COST_INCOME_NOT_FOUND' && error.status === 404
  );
});

test('provider expenses require a synchronized provider while custom expenses remain independent', async (t) => {
  const { service } = await createService(t);
  await assert.rejects(service.createExpense({
    kind: 'provider', providerId: 'missing', name: '', date: '2026-09-01', amount: 10,
    currency: 'CNY', note: ''
  }, 'admin'), (error) => error.code === 'COST_PROVIDER_NOT_FOUND');
  await assert.rejects(service.createExpense({
    kind: 'custom', name: 'Invalid date', date: '0000-01-01', amount: 10,
    currency: 'CNY', note: ''
  }, 'admin'), (error) => error.code === 'COST_DATE_INVALID');
  const entry = await service.createExpense({
    kind: 'custom', name: '域名', date: '2026-09-01', amount: 10.25, currency: 'cny', note: ''
  }, 'admin');
  assert.equal(entry.amount, 10.25);
  assert.equal(entry.currency, 'CNY');
  assert.deepEqual(service.listCustomItems(), ['域名']);
});

test('editing a provider expense preserves its recorded provider-name snapshot', async (t) => {
  const { service, store } = await createService(t);
  await store.replaceProviders([{
    id: 'provider-1', name: 'Original Provider', adapterType: 'custom', enabled: true, currency: 'USD'
  }]);
  const entry = await service.createExpense({
    kind: 'provider', providerId: 'provider-1', name: '', date: '2026-09-01', amount: 10,
    currency: 'USD', note: ''
  }, 'admin');
  await store.replaceProviders([{
    id: 'provider-1', name: 'Renamed Provider', adapterType: 'custom', enabled: true, currency: 'USD'
  }]);

  const updated = await service.updateExpense(entry.id, {
    kind: 'provider', providerId: 'provider-1', name: '', date: '2026-09-02', amount: 12,
    currency: 'USD', note: 'adjusted'
  }, 'admin');

  assert.equal(updated.name, 'Original Provider');
  assert.equal(updated.amount, 12);
});

test('provider synchronization falls back to the last successful snapshot', async (t) => {
  const { service, store } = await createService(t);
  await store.replaceProviders([{
    id: 'p1', name: 'Existing Provider', adapterType: 'custom', enabled: true, currency: 'CNY'
  }]);
  let attempts = 0;
  service.providerMonitor = {
    integrationToken: 'configured',
    configured: () => true,
    listProviders: async () => { attempts += 1; throw new Error('provider monitor unavailable'); }
  };
  const result = await service.getProviders({ refresh: true });
  await service.getProviders();
  assert.equal(result.items[0].name, 'Existing Provider');
  assert.equal(result.sync.status, 'error');
  assert.equal(result.sync.error, 'provider monitor unavailable');
  assert.equal(attempts, 1);
});
