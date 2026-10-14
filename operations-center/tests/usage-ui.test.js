'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const definitions = script.slice(0, script.indexOf("$('login-form').addEventListener"));

function usageUi({ incomplete = false, rows = null } = {}) {
  const today = new Date().toLocaleDateString('en-CA');
  const nodes = new Map();
  let chartOption;
  const filter = { elements: { start: { value: today }, end: { value: today }, dimension: { value: 'model' } } };
  nodes.set('usage-filter', filter);
  const usage = {
    range: { start: today, end: today, days: 1 }, timezone: 'Asia/Shanghai', detailRetentionDays: 30,
    summary: { total_requests: 123, active_users: 2, input_tokens: 999000000, output_tokens: 2460000,
      total_tokens: 1001460000, actual_cost: 3.75, total_cost: 4, account_cost: 2, average_duration_ms: 200,
      metrics_complete: !incomplete, actual_cost_complete: !incomplete },
    coverage: { stored_buckets: 1, available_from: today },
    limitations: incomplete ? ['用户消费已排除 ID 1，部分请求明细不完整。'] : [],
    trend: [{ date: today, total_requests: 123, total_tokens: 1001460000, actual_cost: 3.75,
      metrics_complete: !incomplete, actual_cost_complete: !incomplete }]
  };
  const details = { rows: rows ?? [{ label: 'model-main', requests: 123, input_tokens: 999000000,
    output_tokens: 2460000, total_tokens: 1001460000, actual_cost: 3.75, average_duration_ms: 200 }] };
  const context = vm.createContext({
    URLSearchParams,
    document: {
      getElementById(id) {
        if (!nodes.has(id)) nodes.set(id, { textContent: '', innerHTML: '' });
        return nodes.get(id);
      }
    },
    window: { echarts: { init: () => ({ setOption: (option) => { chartOption = option; } }) } },
    fetch: async (url) => ({
      ok: true, status: 200, headers: { get: () => 'application/json' },
      json: async () => url.startsWith('/api/metrics/usage/dimensions') ? details : usage
    })
  });
  const ui = vm.runInContext(`${definitions}\n({ formatTokens, loadUsage });`, context);
  return { ...ui, nodes, chart: () => chartOption };
}

test('Token formatting covers decimal M/B, numeric strings, small counts and unavailable values', () => {
  const { formatTokens } = usageUi();
  assert.equal(formatTokens(1000000), '1 M');
  assert.equal(formatTokens(1234567), '1.23 M');
  assert.equal(formatTokens(1000000000), '1 B');
  assert.equal(formatTokens('1234567890'), '1.23 B');
  assert.equal(formatTokens(12345), '12,345');
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(Infinity), 'N/A');
});

test('usage renders total Tokens in the summary, dimension table and chart tooltip', async () => {
  const ui = usageUi();
  await ui.loadUsage();
  const cards = ui.nodes.get('usage-metrics').innerHTML;
  assert.equal((cards.match(/<article /g) || []).length, 10);
  assert.match(cards, /输入 Token<\/div><div class="metric-value">999 M/);
  assert.match(cards, /输出 Token<\/div><div class="metric-value">2.46 M/);
  assert.match(cards, /总 Token<\/div><div class="metric-value">1 B/);
  assert.match(cards, /不含 ID 1/);
  const table = ui.nodes.get('usage-dimensions').innerHTML;
  assert.equal((table.match(/<td/g) || []).length, 7);
  assert.match(table, /999 M/);
  assert.match(table, /2.46 M/);
  assert.match(table, /1 B/);
  assert.equal(ui.chart().series[1].tooltip.valueFormatter(1001460000), '1 B');
  assert.equal(ui.chart().series[2].data[0], 3.75);
});

test('incomplete usage labels retained totals and leaves gaps in every usage series', async () => {
  const ui = usageUi({ incomplete: true });
  await ui.loadUsage();
  assert.match(ui.nodes.get('usage-metrics').innerHTML, /不含 ID 1 · 明细不完整/);
  assert.match(ui.nodes.get('usage-notices').innerHTML, /明细不完整/);
  assert.equal(ui.chart().series[2].data[0], null);
  assert.equal(ui.chart().series[1].data[0], null);
  assert.equal(ui.chart().series[0].data[0], null);
  assert.match(ui.nodes.get('usage-metrics').innerHTML, /已保留明细 · 不完整/);
});

test('empty dimension rows span all seven columns', async () => {
  const ui = usageUi({ rows: [] });
  await ui.loadUsage();
  assert.match(ui.nodes.get('usage-dimensions').innerHTML, /colspan="7"/);
});
