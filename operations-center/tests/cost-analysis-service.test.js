'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CostLedgerStore } = require('../src/cost-ledger-store');
const { CostAnalysisService, createPeriods, periodStart } = require('../src/services/cost-analysis-service');

async function createService(t, rows = []) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'operations-center-cost-analysis-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new CostLedgerStore(directory);
  await store.initialize();
  const queries = [];
  const service = new CostAnalysisService({
    pool: {
      async query(sql, params) {
        queries.push({ sql, params });
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

test('cost analysis aggregates recharge revenue and manual expenses by Monday-based weeks', async (t) => {
  const { service, store, queries } = await createService(t, [
    { date: '2026-09-01', transactions: '2', revenue: '100.00' },
    { date: '2026-09-08', transactions: '1', revenue: '50.00' }
  ]);
  await store.replaceProviders([{
    id: 'provider-1', name: 'Provider One', adapterType: 'custom', enabled: true, currency: 'CNY'
  }]);
  await service.createExpense({
    kind: 'custom', name: '服务器', date: '2026-09-01', amount: 40, currency: 'CNY', note: ''
  }, 'admin');
  await service.createExpense({
    kind: 'provider', providerId: 'provider-1', name: '', date: '2026-09-08', amount: 30,
    currency: 'CNY', note: ''
  }, 'admin');

  const report = await service.getReport({
    start: '2026-09-01', end: '2026-09-10', granularity: 'week', currency: 'cny'
  });
  assert.deepEqual(report.summary, {
    revenue: 150,
    expense: 70,
    profit: 80,
    margin: 53.33,
    transactions: 3,
    expenseCount: 2,
    averageTransaction: 50
  });
  assert.equal(report.periods.length, 2);
  assert.deepEqual(report.periods.map((row) => [row.start, row.end, row.revenue, row.expense, row.profit]), [
    ['2026-09-01', '2026-09-06', 100, 40, 60],
    ['2026-09-07', '2026-09-10', 50, 30, 20]
  ]);
  assert.deepEqual(report.periods.map((row) => row.label), ['09-01 ~ 09-06', '09-07 ~ 09-10']);
  assert.deepEqual(report.breakdown.map((row) => [row.name, row.amount]), [['服务器', 40], ['Provider One', 30]]);
  assert.match(queries[0].sql, /SUM\(pay_amount\)/);
  assert.deepEqual(queries[0].params, ['2026-09-01', '2026-09-11', 'Asia/Shanghai', 'CNY']);
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

  const daily = await service.getReport({
    start: '2026-01-01', end: '2026-01-02', granularity: 'day', currency: 'CNY'
  });
  assert.deepEqual(daily.periods.map((row) => [row.start, row.revenue, row.expense]), [
    ['2026-01-01', 30, 3], ['2026-01-02', 0, 0]
  ]);

  const monthly = await service.getReport({
    start: '2025-12-20', end: '2026-02-02', granularity: 'month', currency: 'CNY'
  });
  assert.deepEqual(monthly.periods.map((row) => [row.label, row.revenue, row.expense]), [
    ['2025-12', 30, 3], ['2026-01', 30, 3], ['2026-02', 40, 4]
  ]);

  const yearly = await service.getReport({
    start: '2025-12-20', end: '2026-02-02', granularity: 'year', currency: 'CNY'
  });
  assert.deepEqual(yearly.periods.map((row) => [row.label, row.revenue, row.expense]), [
    ['2025', 30, 3], ['2026', 70, 7]
  ]);
});

test('currency isolation and expense-only losses produce a null margin', async (t) => {
  const { service } = await createService(t);
  await service.createExpense({
    kind: 'custom', name: 'USD Hosting', date: '2026-09-20', amount: 25,
    currency: 'USD', note: 'monthly'
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
    revenue: 0,
    expense: 30,
    profit: -30,
    margin: null,
    transactions: 0,
    expenseCount: 2,
    averageTransaction: null
  });
  assert.equal(report.periods[0].margin, null);
  assert.deepEqual(report.breakdown.map((row) => row.name), ['USD Hosting', 'USD Domain']);
  assert.deepEqual(
    service.listExpenses({ start: '2026-09-01', end: '2026-09-30', currency: 'usd' })
      .map((entry) => [entry.date, entry.currency]),
    [['2026-09-20', 'USD'], ['2026-09-10', 'USD']]
  );
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
