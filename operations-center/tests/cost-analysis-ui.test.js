'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  entryEditorCurrency,
  expenseEditorCurrency,
  focusLedgerEntryFilter,
  focusExpenseFilter
} = require('../public/cost-analysis-ui');

function fields({ start = '2026-09-01', end = '2026-09-30', currency = 'CNY' } = {}) {
  return {
    start: { value: start },
    end: { value: end },
    currency: { value: currency }
  };
}

test('new income and expenses default to CNY while edits retain their recorded currency', () => {
  assert.equal(entryEditorCurrency(null), 'CNY');
  assert.equal(entryEditorCurrency({ currency: 'usd' }), 'USD');
  assert.equal(expenseEditorCurrency(null), 'CNY');
  assert.equal(expenseEditorCurrency({ currency: 'usd' }), 'USD');
});

test('saved income uses the shared ledger filter focus behavior', () => {
  const elements = fields();
  const result = focusLedgerEntryFilter(elements, { date: '2026-10-05', currency: 'usd' });

  assert.deepEqual(result, {
    currency: 'USD', date: '2026-10-05', currencyChanged: true, dateChanged: true
  });
  assert.deepEqual(
    [elements.start.value, elements.end.value, elements.currency.value],
    ['2026-10-05', '2026-10-05', 'USD']
  );
});

test('saved expense switches the report currency so a provider cost remains visible', () => {
  const elements = fields();
  const result = focusExpenseFilter(elements, { date: '2026-09-15', currency: 'usd' });

  assert.deepEqual(result, {
    currency: 'USD', date: '2026-09-15', currencyChanged: true, dateChanged: false
  });
  assert.equal(elements.currency.value, 'USD');
  assert.equal(elements.start.value, '2026-09-01');
  assert.equal(elements.end.value, '2026-09-30');
});

test('saved expense outside the report range narrows the range to its date', () => {
  const elements = fields();
  const result = focusExpenseFilter(elements, { date: '2026-10-05', currency: 'CNY' });

  assert.equal(result.currencyChanged, false);
  assert.equal(result.dateChanged, true);
  assert.equal(elements.start.value, '2026-10-05');
  assert.equal(elements.end.value, '2026-10-05');
});

test('editing both currency and date updates both report filters', () => {
  const elements = fields();
  const result = focusExpenseFilter(elements, { date: '2025-12-31', currency: 'EUR' });

  assert.equal(result.currencyChanged, true);
  assert.equal(result.dateChanged, true);
  assert.deepEqual(
    [elements.start.value, elements.end.value, elements.currency.value],
    ['2025-12-31', '2025-12-31', 'EUR']
  );
});

test('saved expense already covered by the report leaves filters unchanged', () => {
  const elements = fields();
  const result = focusExpenseFilter(elements, { date: '2026-09-10', currency: 'CNY' });

  assert.equal(result.currencyChanged, false);
  assert.equal(result.dateChanged, false);
  assert.deepEqual(
    [elements.start.value, elements.end.value, elements.currency.value],
    ['2026-09-01', '2026-09-30', 'CNY']
  );
});

function costReportUi({ periods = [], notices = [], daily = {}, beforeFetch = async () => {}, timers = { setTimeout, clearTimeout } }) {
  const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const definitions = script.slice(0, script.indexOf("$('login-form').addEventListener"));
  const nodes = new Map();
  let option;
  const requests = [];
  nodes.set('cost-analysis-filter', { elements: {
    ...fields(), granularity: { value: 'day' }
  } });
  nodes.set('cost-expense-form', { elements: { providerId: { value: '' } } });
  const report = {
    range: { start: '2026-09-01', end: '2026-09-30' }, currency: 'CNY', timezone: 'Asia/Shanghai',
    summary: { automaticRevenue: 1000, manualRevenue: 250, revenue: 1250, expense: 16,
      profit: 1234, margin: 98.72, userBalance: 123, balanceUsers: 1,
      actualProfit: 1111, actualMargin: 88.88, transactions: 1, averageTransaction: 1000,
      incomeCount: 1, expenseCount: 2 },
    periods, breakdown: [], incomeBreakdown: [], caveats: [], notices
  };
  const context = vm.createContext({
    URLSearchParams,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    document: { getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, { textContent: '', innerHTML: '' });
      return nodes.get(id);
    } },
    window: { echarts: { init: () => ({ setOption: (value) => { option = value; } }) } },
    fetch: async (url) => (requests.push(url), await beforeFetch(url), {
      ok: true, status: 200, headers: { get: () => 'application/json' },
      json: async () => url.startsWith('/api/cost-analysis?') ? report :
        url.startsWith('/api/cost-analysis/daily-profit?') ?
          { currency: 'CNY', timezone: 'Asia/Shanghai', items: [], ...(typeof daily === 'function' ? daily(url) : daily) } : { items: [], sync: {} }
    })
  });
  const ui = vm.runInContext(`${definitions}\n({ loadCostAnalysis, renderCostAnalysisNotices });`, context);
  return { ...ui, nodes, requests, state: vm.runInContext('state', context), chart: () => option };
}

function reportPeriod(overrides = {}) {
  return {
    start: '2026-09-01', end: '2026-09-01', label: '09-01', automaticRevenue: 1000,
    manualRevenue: 250, revenue: 1250, expense: 10, profit: 1240, margin: 99.2,
    transactions: 1, balanceConsumption: 13.12500001, consumptionProfit: 3.12500001,
    consumptionComplete: true, ...overrides
  };
}

test('profit trend uses the same main-site and supplier totals as the real-income daily list', async () => {
  const ui = costReportUi({ periods: [reportPeriod()], daily: { periods: [
    { label: '09-01', siteConsumption: 20.12500001, supplierConsumption: 10, profit: 10.12500001 },
    { label: '09-02', siteConsumption: 4, supplierConsumption: 6, profit: -2 }
  ] } });
  await ui.loadCostAnalysis();
  const option = JSON.parse(JSON.stringify(ui.chart()));
  assert.deepEqual(option.legend.data, ['主站消费', '供应商消费', '真实收入']);
  assert.equal(option.series.length, 3);
  assert.deepEqual(option.series.map((series) => series.data), [[20.12500001, 4], [10, 6], [10.12500001, -2]]);
  assert.match(ui.requests.find(url => url.startsWith('/api/cost-analysis?')), /include_consumption=0/);
});

test('unknown supplier costs leave real income unknown while main-site consumption remains visible', async () => {
  const warning = '部分日期的用量明细不完整。';
  const ui = costReportUi({ periods: [reportPeriod({
    balanceConsumption: null, consumptionProfit: null, consumptionComplete: false
  })], notices: [warning], daily: { periods: [
    { label: '09-01', siteConsumption: 13, supplierConsumption: null, profit: null }
  ] } });
  await ui.loadCostAnalysis();
  assert.equal(ui.chart().series[0].data[0], 13);
  assert.equal(ui.chart().series[1].data[0], null);
  assert.equal(ui.chart().series[2].data[0], null);
  const notices = ui.nodes.get('cost-analysis-operational-notices');
  assert.equal(notices.hidden, false);
  assert.match(notices.innerHTML, /用量明细不完整/);
  ui.renderCostAnalysisNotices({ sync: { status: 'error', error: 'offline' } });
  assert.match(notices.innerHTML, /用量明细不完整/);
  assert.match(notices.innerHTML, /供应商同步失败/);
});

test('empty daily profit tables span all eight columns', async () => {
  const ui = costReportUi({ periods: [] });
  await ui.loadCostAnalysis();
  assert.match(ui.nodes.get('cost-daily-profits').innerHTML, /colspan="8"/);
  assert.equal(ui.nodes.get('cost-daily-profit-summary').innerHTML, '');
});

test('background polling updates both the archived list and trend without another manual-income query or forced rebuild', async () => {
  const callbacks = [];
  let reads = 0;
  const ui = costReportUi({
    timers: { setTimeout: callback => (callbacks.push(callback), callbacks.length), clearTimeout: () => {} },
    daily: () => ++reads === 1 ? { archive: { pendingDays: 1, ready: true },
      items: [{ date: '2026-09-01', status: 'pending_archive', profit: null, providers: [] }] } :
      { archive: { pendingDays: 0, ready: true },
        items: [{ date: '2026-09-01', siteConsumption: 10, supplierConsumption: 2, profit: 8,
          complete: true, status: 'complete', mode: 'archived', providers: [] }] }
  });
  ui.state.currentView = 'costs'; ui.state.user = { name: 'admin' };
  await ui.loadCostAnalysis({ refresh: true });
  assert.match(ui.nodes.get('cost-daily-profits').innerHTML, /待统计/);
  await callbacks.shift()();
  assert.match(ui.nodes.get('cost-daily-profits').innerHTML, /已归档/);
  assert.equal(ui.chart().series[2].data[0], 8);
  assert.equal(ui.requests.filter(url => url.startsWith('/api/cost-analysis?')).length, 1);
  assert.ok(!ui.requests.at(-1).includes('refresh='));
  assert.equal(callbacks.length, 0);
});

test('manual cost analysis refresh requests a fresh upstream summary without changing other financial queries', async () => {
  const ui = costReportUi({});
  await ui.loadCostAnalysis({ refresh: true });
  assert.match(ui.requests.find((url) => url.startsWith('/api/cost-analysis/daily-profit?')), /refresh=1/);
  assert.ok(ui.requests.filter((url) => !url.startsWith('/api/cost-analysis/daily-profit?'))
    .every((url) => !url.includes('refresh=')));
});

test('a delayed month query or its failure cannot overwrite the latest selected date range', async () => {
  for (const failed of [false, true]) {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let first = true;
    const ui = costReportUi({
      beforeFetch: async (url) => {
        if (!url.startsWith('/api/cost-analysis/daily-profit?') || !first) return;
        first = false;
        await gate;
        if (failed) throw new Error('The earlier month query failed');
      },
      daily: (url) => ({ items: [{ date: new URLSearchParams(url.split('?')[1]).get('end'),
        siteConsumption: 10, supplierConsumption: 2, profit: 8, margin: 80, complete: true, providers: [] }] })
    });
    const earlier = ui.loadCostAnalysis();
    ui.nodes.get('cost-analysis-filter').elements.end.value = '2026-09-15';
    await ui.loadCostAnalysis();
    release();
    await earlier;
    const table = ui.nodes.get('cost-daily-profits').innerHTML;
    assert.match(table, /2026-09-15/);
    assert.doesNotMatch(table, /2026-09-30/);
  }
});

test('daily profit renders actual supplier costs, losses, zero denominators and escaped supplier details', async () => {
  const ui = costReportUi({ daily: {
    items: [
      { date: '2026-09-02', siteConsumption: 0, supplierConsumption: 2, profit: -2,
        margin: null, siteRequests: 0, complete: true, status: 'complete', providers: [] },
      { date: '2026-09-01', siteConsumption: 13.12500001, supplierConsumption: 10,
        profit: 3.12500001, margin: 23.81, siteRequests: 3, complete: true, status: 'complete',
        providers: [{ name: '<img src=x onerror=alert(1)>', cost: 10, complete: true,
          lastSyncedAt: '2026-09-02T00:00:00Z' }] }
    ],
    summary: { days: 2, completeDays: 2, siteConsumption: 13.12500001,
      supplierConsumption: 12, profit: 1.12500001, margin: 8.57 }
  } });
  ui.nodes.get('cost-analysis-filter').elements.granularity.value = 'month';
  await ui.loadCostAnalysis();
  const table = ui.nodes.get('cost-daily-profits').innerHTML;
  assert.match(table, /2026-09-01/);
  assert.match(table, /2026-09-02/);
  assert.match(table, /13\.12500001 CNY/);
  assert.match(table, /3\.12500001 CNY/);
  assert.match(table, /negative-value[^>]*>-2 CNY/);
  assert.match(table, /N\/A/);
  assert.match(table, /<details class="cost-daily-suppliers">/);
  assert.match(table, /&lt;img/);
  assert.match(table, /账号汇总/);
  assert.match(ui.nodes.get('cost-daily-profit-meta').textContent, /上游账号日汇总/);
  assert.doesNotMatch(table, /<img|<details[^>]* open/);
  assert.match(ui.nodes.get('cost-daily-profit-summary').innerHTML, /1\.12500001 CNY/);
});

test('missing supplier data leaves daily costs, profits and totals unknown rather than zero', async () => {
  const ui = costReportUi({ daily: {
    items: [{ date: '2026-09-01', siteConsumption: 13, supplierConsumption: null,
      profit: null, margin: null, siteRequests: 3, complete: false, status: 'supplier_incomplete',
      providers: [{ name: 'Supplier', cost: null, complete: false, reasons: ['<未同步>'] }] }],
    summary: { days: 1, completeDays: 0, siteConsumption: 13,
      supplierConsumption: null, profit: null, margin: null }, notices: ['供应商实际消费暂不可用']
  } });
  await ui.loadCostAnalysis();
  const table = ui.nodes.get('cost-daily-profits').innerHTML;
  assert.match(table, /供应商待核验/);
  assert.match(table, /&lt;未同步&gt;/);
  assert.doesNotMatch(table, />0 CNY/);
  assert.match(ui.nodes.get('cost-daily-profit-summary').innerHTML, /待核验/);
  assert.match(ui.nodes.get('cost-daily-profit-notices').innerHTML, /暂不可用/);
});
