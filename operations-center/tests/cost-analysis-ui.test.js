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

function costReportUi({ periods, notices = [] }) {
  const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const definitions = script.slice(0, script.indexOf("$('login-form').addEventListener"));
  const nodes = new Map();
  let option;
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
    document: { getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, { textContent: '', innerHTML: '' });
      return nodes.get(id);
    } },
    window: { echarts: { init: () => ({ setOption: (value) => { option = value; } }) } },
    fetch: async (url) => ({
      ok: true, status: 200, headers: { get: () => 'application/json' },
      json: async () => url.startsWith('/api/cost-analysis?') ? report : { items: [], sync: {} }
    })
  });
  const ui = vm.runInContext(`${definitions}\n({ loadCostAnalysis, renderCostAnalysisNotices });`, context);
  return { ...ui, nodes, chart: () => option };
}

function reportPeriod(overrides = {}) {
  return {
    start: '2026-09-01', end: '2026-09-01', label: '09-01', automaticRevenue: 1000,
    manualRevenue: 250, revenue: 1250, expense: 10, profit: 1240, margin: 99.2,
    transactions: 1, balanceConsumption: 13.12500001, consumptionProfit: 3.12500001,
    consumptionComplete: true, ...overrides
  };
}

test('profit trend uses balance consumption and recorded expenses instead of topups or current balance', async () => {
  const ui = costReportUi({ periods: [reportPeriod(), reportPeriod({
    start: '2026-09-02', end: '2026-09-02', label: '09-02',
    balanceConsumption: 4, expense: 6, consumptionProfit: -2
  })] });
  await ui.loadCostAnalysis();
  const option = JSON.parse(JSON.stringify(ui.chart()));
  assert.deepEqual(option.legend.data, ['余额消费', '支出', '实际利润']);
  assert.equal(option.series.length, 3);
  assert.deepEqual(option.series.map((series) => series.data), [[13.12500001, 4], [10, 6], [3.12500001, -2]]);
  const table = ui.nodes.get('cost-periods').innerHTML;
  assert.match(table, /13\.12500001 CNY/);
  assert.match(table, /3\.12500001 CNY/);
  assert.match(table, /negative-value[^>]*>-2 CNY/);
});

test('unavailable consumption stays null in the chart and N/A in the table while expenses remain visible', async () => {
  const warning = '部分日期的用量明细不完整，余额消费与实际利润趋势留空。';
  const ui = costReportUi({ periods: [reportPeriod({
    balanceConsumption: null, consumptionProfit: null, consumptionComplete: false
  })], notices: [warning] });
  await ui.loadCostAnalysis();
  assert.equal(ui.chart().series[0].data[0], null);
  assert.equal(ui.chart().series[1].data[0], 10);
  assert.equal(ui.chart().series[2].data[0], null);
  assert.equal((ui.nodes.get('cost-periods').innerHTML.match(/N\/A/g) || []).length, 2);
  const notices = ui.nodes.get('cost-analysis-operational-notices');
  assert.equal(notices.hidden, false);
  assert.match(notices.innerHTML, /用量明细不完整/);
  ui.renderCostAnalysisNotices({ sync: { status: 'error', error: 'offline' } });
  assert.match(notices.innerHTML, /用量明细不完整/);
  assert.match(notices.innerHTML, /供应商同步失败/);
});

test('empty cost period tables span all ten columns', async () => {
  const ui = costReportUi({ periods: [] });
  await ui.loadCostAnalysis();
  assert.match(ui.nodes.get('cost-periods').innerHTML, /colspan="10"/);
});
