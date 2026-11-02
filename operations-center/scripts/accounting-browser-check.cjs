'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { startPreview } = require('./accounting-preview.cjs');
const { addUtcDays } = require('../src/services/metrics-service');

async function waitFor(page, predicate, value) {
  const deadline = Date.now() + 20000;
  while (!await page.evaluate(predicate, value)) {
    if (Date.now() > deadline) throw new Error(`Browser condition timed out: ${predicate}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
async function checkChart(page, selector) {
  await waitFor(page, target => { const chart = echarts.getInstanceByDom(document.querySelector(target)); return chart && chart.getZr().animation.isFinished(); }, selector);
  const result = await page.locator(selector).evaluate(node => {
    const chart = echarts.getInstanceByDom(node), model = chart.getModel();
    const legend = chart.getViewOfComponentModel(model.getComponent('legend')).group;
    const bounds = legend.getBoundingRect().clone(); bounds.applyTransform(legend.getComputedTransform());
    const canvas = node.querySelector('canvas'), data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let painted = 0; for (let index = 3; index < data.length; index += 4) if (data[index]) painted++;
    return { painted, legendBottom: bounds.y + bounds.height, top: model.getComponent('grid').coordinateSystem.getRect().y };
  });
  assert(result.painted > 500); assert(result.legendBottom + 14 < result.top, 'Legend clears the plot');
}
async function checkLayout(page) {
  const result = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth,
    metrics: [...document.querySelectorAll('.accounting-metric strong')].filter(node => node.getBoundingClientRect().width).map(node => ({ overflow: node.scrollWidth > node.clientWidth + 1, text: node.textContent })),
    controls: [...document.querySelectorAll('#cost-accounting-root button, #cost-accounting-root input, #cost-accounting-root select')].filter(node => node.getBoundingClientRect().width && !node.closest('.table-wrap')).filter(node => node.getBoundingClientRect().right > innerWidth + 1).map(node => node.outerHTML) }));
  assert.equal(result.overflow, false); assert(!result.metrics.some(row => row.overflow), JSON.stringify(result.metrics)); assert.deepEqual(result.controls, []);
}
async function closeDrawer(page) { await page.locator('[data-dialog] .accounting-drawer-header [data-close]').click(); }
async function credits(page) {
  await page.locator('[data-command=credits]').click(); await page.waitForSelector('#cost-auto-users [data-cost-auto-user-detail]');
  assert.equal(await page.locator('#cost-auto-users tr').count(), 20);
  await page.locator('#cost-auto-users-next').click(); await waitFor(page, () => document.querySelector('#cost-auto-users-page-label').textContent.includes('2 / 2'));
  await page.locator('#cost-auto-user-search [name=search]').fill('paid@example.test'); await page.locator('#cost-auto-user-search [type=submit]').click();
  await waitFor(page, () => document.querySelectorAll('#cost-auto-users [data-cost-auto-user-detail]').length === 1);
  await page.locator('[data-cost-auto-user-detail]').click(); await page.waitForSelector('#cost-auto-records .redeem-code');
  assert.match(await page.locator('#cost-auto-records').innerText(), /example-paid/);
  await page.locator('#cost-auto-records-back').click(); assert.equal(await page.locator('#cost-auto-user-search [name=search]').inputValue(), 'paid@example.test');
  await page.locator('#cost-auto-income-close').click(); await waitFor(page, () => accountingUi.state.active && accountingUi.state.report?.automatic);
}
async function main() {
  const directory = process.env.ACCOUNTING_QA_DIR || path.join(os.tmpdir(), 'sub2api-automatic-cash-qa'); fs.mkdirSync(directory, { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  try {
    for (const [name, viewport, colorScheme] of [['desktop', { width: 1440, height: 1000 }, 'light'], ['mobile', { width: 390, height: 844 }, 'light'], ['narrow', { width: 320, height: 740 }, 'light'], ['dark', { width: 1440, height: 1000 }, 'dark']]) {
      const preview = await startPreview(), context = await browser.newContext({ viewport, colorScheme });
      try {
        preview.accounting.configure({ startDate: preview.today, reason: 'Automatic reporting has no accounting start' }, 'example');
        const page = await context.newPage(), errors = [], paths = []; page.on('pageerror', error => errors.push(error.message)); page.on('request', request => paths.push(new URL(request.url()).pathname));
        await page.goto(`http://127.0.0.1:${preview.port}/preview`); await waitFor(page, () => accountingUi.state.report?.automatic);
        assert.equal(await page.locator('.accounting-tabs [role=tab]').count(), 2); assert.equal(await page.locator('.accounting-rules').evaluate(node => node.open), false);
        assert.equal(await page.locator('#cost-analysis-filter [name=granularity]').inputValue(), 'day');
        await page.locator('#cost-analysis-filter [name=start]').fill(preview.start); await page.locator('#cost-analysis-filter [name=end]').fill(preview.today); await page.locator('#cost-analysis-filter [type=submit]').click();
        await waitFor(page, start => accountingUi.state.report?.range.start === start && accountingUi.state.report.summary.completeDays === 31, preview.start);
        const s = await page.evaluate(() => accountingUi.state.report.summary); assert.equal(s.siteConsumption, 4340); assert.equal(s.supplierConsumption, 573.5); assert.equal(s.profit, 3766.5); assert.equal(s.margin, 86.79);
        await checkChart(page, '#accounting-automatic-chart'); assert.equal(await page.locator('[data-automatic-days] tr').count(), 15);
        await page.locator('[data-automatic-day-step="1"]').click(); assert.match(await page.locator('[data-automatic-day-page]').innerText(), /2 \/ 3/); await page.locator('[data-automatic-day-step="-1"]').click();
        await checkLayout(page); await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: path.join(directory, `${name}-automatic.png`), fullPage: true });
        await page.locator('[data-metric=profit]').click(); await page.locator('[data-dialog] [data-day]').first().click(); assert.match(await page.locator('[data-drawer]').innerText(), /供应商账号消费/); await closeDrawer(page);
        await waitFor(page, () => accountingUi.state.balances?.userBalance === 11790);
        await page.locator('[data-command=balance]').click(); await page.waitForSelector('[data-balance-page]'); assert.match(await page.locator('[data-drawer]').innerText(), /不含 ID 1/);
        await page.locator('[data-balance-step="1"]').click(); await waitFor(page, () => document.querySelector('[data-balance-page]').textContent.includes('2 / 2'));
        await page.locator('[data-balance-search] input').fill('paid@example.test'); await page.locator('[data-balance-search] [type=submit]').click(); await waitFor(page, () => document.querySelector('[data-balance-page]').textContent.includes('1 位用户')); await closeDrawer(page);
        await credits(page); assert(!paths.some(url => url.startsWith('/api/cost-analysis/accounting/')), 'No manual accounting workflow is called');

        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const failAux = async route => { await gate; await route.fulfill({ status: 503, json: { error: { message: 'Synthetic balance outage' } } }); };
        await page.route('**/api/cost-analysis/cash/balances?*', failAux);
        await page.evaluate(() => { accountingUi.state.report = null; accountingUi.load(); });
        await waitFor(page, () => accountingUi.state.report?.summary.profit === 3766.5 && accountingUi.state.balances === undefined);
        release(); await waitFor(page, () => accountingUi.state.balances === null); assert.match(await page.locator('[data-automatic-metrics]').innerText(), /3,766.5/); await page.unroute('**/api/cost-analysis/cash/balances?*', failAux);

        await page.locator('[data-detail-tab=providers]').click(); assert.equal(await page.locator('[data-provider-summary] tbody tr').count(), 2);
        await page.locator('#cost-accounting-add').click(); await page.waitForSelector('[data-entry-form]');
        assert.equal(await page.locator('[data-entry-form] [name=direction]:checked').inputValue(), 'expense');
        assert.equal(await page.locator('[data-entry-form] [name=category]').inputValue(), 'provider');
        assert.equal(await page.locator('[data-provider-field]').isVisible(), true); assert.equal(await page.locator('[data-entry-form] [name=providerId]').inputValue(), '');
        assert.equal(await page.locator('[data-entry-name]').isVisible(), false); assert.equal(await page.locator('[data-entry-form] [name=name]').isDisabled(), true);
        await page.locator('[data-entry-form] [name=category]').selectOption('custom'); assert.equal(await page.locator('[data-entry-name]').isVisible(), false);
        await page.locator('[data-entry-form] [name=direction][value=income]').check(); assert.equal(await page.locator('[data-entry-name]').isVisible(), true);
        assert.equal(await page.locator('[data-entry-form] [name=name]').evaluate(node => node.required), true); await closeDrawer(page);
        await page.locator('[data-provider-entry=alpha]').click(); await page.waitForSelector('[data-entry-form]'); assert.equal(await page.locator('[data-entry-form] [name=currency]').count(), 0); assert.match(await page.locator('[data-entry-form]').innerText(), /人民币元/); assert.equal(await page.locator('[data-entry-form] [name=providerId]').inputValue(), 'alpha');
        const oldDate = addUtcDays(preview.start, -5);
        await page.locator('[data-entry-form] [name=date]').fill(oldDate); await page.locator('[data-entry-form] [name=amount]').fill('125'); await page.locator('[data-entry-form] [type=submit]').click();
        await waitFor(page, date => accountingUi.state.tab === 'cash' && accountingUi.state.report?.range.start === date && accountingUi.state.report.items.some(row => row.amount === 125), oldDate);
        assert.equal(await page.evaluate(() => accountingUi.state.report.items[0].name), 'Sub2API 示例上游 付款');
        assert.equal(await page.locator('[data-cash-rows] tr').count(), 1); assert.equal(await page.locator('[data-cash-metrics] [data-metric]').count(), 3);
        assert.deepEqual(await page.locator('[data-cash-metrics] [data-metric]').evaluateAll(nodes => nodes.map(node => node.dataset.metric)), ['income', 'expense', 'net']);
        assert.deepEqual(await page.locator('[data-cash-history] [data-metric]').evaluateAll(nodes => nodes.map(node => node.dataset.metric)), ['historyIncome', 'historyExpense', 'userBalance', 'cumulative']);
        const metricRows = await page.evaluate(() => ({ period: document.querySelector('[data-cash-metrics]').getBoundingClientRect().bottom,
          history: document.querySelector('[data-cash-history]').getBoundingClientRect().top }));
        assert(metricRows.history > metricRows.period, 'All-history cards have their own second row');
        assert.equal(await page.evaluate(() => accountingUi.state.report.cumulative.net), -81);
        await checkChart(page, '#accounting-cash-chart'); await checkLayout(page);
        await page.locator('[data-metric=cumulative]').click(); assert.match(await page.locator('[data-drawer]').innerText(), /全历史累计入账/); assert.match(await page.locator('[data-drawer]').innerText(), /11,790/); await closeDrawer(page);
        for (const key of ['historyIncome', 'historyExpense']) { await page.locator(`[data-metric=${key}]`).click(); assert.match(await page.locator('[data-drawer]').innerText(), /全历史累计支出/); await closeDrawer(page); }
        await page.locator('[data-metric=userBalance]').click(); await page.waitForSelector('[data-balance-page]'); assert.match(await page.locator('[data-drawer]').innerText(), /不含 ID 1/); await closeDrawer(page);
        await page.locator('[data-record]').click(); await page.locator('[data-command=edit]').click(); await page.waitForSelector('[data-entry-form]'); await page.locator('[data-entry-form] [name=amount]').fill('150'); await page.locator('[data-entry-form] [type=submit]').click();
        await waitFor(page, () => accountingUi.state.report?.items[0]?.amount === 150 && !document.querySelector('[data-dialog]').open); assert.equal(await page.evaluate(() => accountingUi.state.report.cumulative.net), -106);
        assert.equal(await page.evaluate(() => accountingUi.state.report.items[0].name), 'Sub2API 示例上游 付款');
        await page.locator('[data-record]').click(); page.once('dialog', dialog => dialog.accept()); await page.locator('[data-command=delete]').click(); await waitFor(page, () => accountingUi.state.report?.summary.expense === 0 && !document.querySelector('[data-dialog]').open); assert.equal(await page.evaluate(() => accountingUi.state.report.cumulative.net), 44);

        await page.locator('#cost-analysis-filter [name=start]').fill(preview.start); await page.locator('#cost-analysis-filter [name=end]').fill(preview.today); await page.locator('[data-cash-search] [name=search]').fill(''); await page.locator('[data-cash-search] [type=submit]').click();
        await waitFor(page, () => accountingUi.state.report?.summary.income === 12199); assert.equal(await page.evaluate(() => accountingUi.state.report.cumulative.net), 44);
        assert.equal(await page.evaluate(() => accountingUi.state.report.items.find(row => row.key === 'payment:1').counted), false);
        await page.locator('[data-record="redeem:1"]').click(); await waitFor(page, () => accountingUi.state.selectedItem?.key === 'redeem:1' && document.querySelector('[data-dialog]').open);
        assert.match(await page.locator('[data-drawer]').innerText(), /已使用余额兑换记录/); assert.equal(await page.locator('[data-command=edit]').count(), 0); await closeDrawer(page);
        await page.locator('[data-record="payment:1"]').click(); await waitFor(page, () => accountingUi.state.selectedItem?.key === 'payment:1' && document.querySelector('[data-dialog]').open); assert.equal(await page.locator('[data-command=edit]').count(), 0); assert.equal(await page.locator('[data-command=delete]').count(), 0); await closeDrawer(page);
        preview.config.financeCashExchangeRates = [{ currency: 'USD', rate: 7.2, from: '2000-01-01', to: '9999-12-31' }];
        await preview.database.query(`UPDATE payment_orders SET provider_snapshot='{"currency":"USD"}' WHERE id=1`);
        await preview.cashFlow.sync({ force: true });
        const historical = { key: 'cash:historical-usd', source: 'manual', direction: 'income', date: preview.today, name: 'Historical receipt', amount: '5', currency: 'USD', rate: 7.2, active: true };
        preview.store.putCash(historical, 'example', 'Existing historical receipt');
        await page.locator('#cost-accounting-add').click(); await page.waitForSelector('[data-entry-form]'); await page.locator('[data-entry-form] [name=direction][value=income]').check(); await page.locator('[data-entry-form] [name=name]').fill('Offline receipt'); await page.locator('[data-entry-form] [name=amount]').fill('10'); await page.locator('[data-entry-form] [type=submit]').click();
        await waitFor(page, () => accountingUi.state.report?.currency === 'CNY' && accountingUi.state.report.summary.income === 12214); assert.equal(await page.evaluate(() => accountingUi.state.report.cumulative.net), 59);
        assert.equal(await page.locator('[data-cash-currency]').count(), 0);
        await page.locator('[data-cash-search] [name=search]').fill(''); await page.locator('[data-cash-search] [type=submit]').click(); await waitFor(page, () => accountingUi.state.report?.pagination.total === 6);
        const history = await page.evaluate(() => accountingUi.state.report.cumulative);
        assert.deepEqual([history.income, history.expense, history.userBalance, history.net], [12214, 365, 11790, 59]);
        await page.locator('[data-cash-search] [name=search]').fill('no-match'); await page.locator('[data-cash-search] [type=submit]').click();
        await waitFor(page, () => accountingUi.state.report?.pagination.total === 0);
        assert.deepEqual(await page.evaluate(() => { const c = accountingUi.state.report.cumulative; return [c.income, c.expense, c.userBalance, c.net]; }), [12214, 365, 11790, 59]);
        await page.locator('[data-cash-search] [name=search]').fill(''); await page.locator('[data-cash-search] [type=submit]').click(); await waitFor(page, () => accountingUi.state.report?.pagination.total === 6);
        assert.match(await page.locator('[data-cash-range]').innerText(), /人民币/); assert.doesNotMatch(await page.locator('#accounting-cash').innerText(), /USD|原币/);
        await page.locator('[data-record="cash:historical-usd"]').click(); await waitFor(page, () => accountingUi.state.selectedItem?.key === 'cash:historical-usd' && document.querySelector('[data-dialog]').open);
        assert.match(await page.locator('[data-drawer]').innerText(), /金额（元）/); await page.locator('[data-command=edit]').click(); await page.waitForSelector('[data-entry-form]'); assert.equal(await page.locator('[data-entry-form] [name=amount]').inputValue(), '5'); assert.equal(await page.locator('[data-entry-form] [name=currency]').count(), 0); await closeDrawer(page);
        assert.deepEqual(preview.store.cashRecord(historical.key), historical);
        await checkChart(page, '#accounting-cash-chart'); await checkLayout(page); await page.evaluate(() => { document.getElementById('toast-region').replaceChildren(); scrollTo(0, 0); }); await page.screenshot({ path: path.join(directory, `${name}-cash.png`), fullPage: true });

        if (name === 'desktop') {
          await page.locator('#cost-accounting-add').click(); await page.waitForSelector('[data-entry-form]');
          await page.locator('[data-entry-form] [name=category]').selectOption('custom'); await page.locator('[data-entry-form] [name=amount]').fill('3');
          await page.locator('[data-entry-form] [name=note]').fill('Example custom payment'); await page.locator('[data-entry-form] [type=submit]').click();
          await waitFor(page, () => accountingUi.state.report?.items[0]?.name === '自定义支出' && !document.querySelector('[data-dialog]').open);
          assert.equal(await page.evaluate(() => accountingUi.state.report.items[0].amount), 3);
          await page.locator('[data-record]').click(); page.once('dialog', dialog => dialog.accept()); await page.locator('[data-command=delete]').click();
          await waitFor(page, () => accountingUi.state.report?.cumulative.net === 59 && !document.querySelector('[data-dialog]').open);
          // A superseded slow response cannot overwrite a newer view.
          let unblock, handled; const pending = new Promise(resolve => { unblock = resolve; }), finished = new Promise(resolve => { handled = resolve; });
          const slow = async route => { await pending; try { await route.fulfill({ status: 500, json: { error: { message: 'Superseded response' } } }); } finally { handled(); } };
          await page.route('**/api/cost-analysis/cash/report?*', slow); await page.evaluate(() => { accountingUi.load().catch(() => {}); });
          await page.locator('[data-tab=automatic]').click(); await waitFor(page, () => accountingUi.state.report?.automatic); unblock(); await finished; await page.unroute('**/api/cost-analysis/cash/report?*', slow);
          await page.waitForTimeout(100); assert.equal(await page.evaluate(() => accountingUi.state.report.automatic), true);
          preview.controls.supplierUnavailable = true;
          await page.locator('#cost-analysis-filter [name=start]').fill(preview.today); await page.locator('#cost-analysis-filter [name=end]').fill(preview.today); await page.locator('#cost-analysis-filter [type=submit]').click();
          await waitFor(page, today => accountingUi.state.report.range.start === today, preview.today);
          assert.equal(await page.evaluate(() => accountingUi.state.report.summary.profit), null); assert.equal(await page.evaluate(() => accountingUi.state.report.items[0].providers[0].cost), 12);
          assert.doesNotMatch(await page.locator('#cost-accounting-root').innerText(), /待核验|保存核算|补录期初|核算起点/);
          await page.screenshot({ path: path.join(directory, 'desktop-missing-source.png'), fullPage: true });
          preview.controls.supplierUnavailable = false; const calls = preview.controls.supplierCalls;
          await page.evaluate(() => { accountingUi.state.liveRefreshedAt = Date.now() - 61000; return accountingUi.load({ poll: true }); });
          assert.equal(await page.evaluate(() => accountingUi.state.report.summary.profit), 121.5);
          assert(preview.controls.supplierCalls > calls, 'Archive polling cannot freeze current-day live data for more than a minute');
        }
        assert.deepEqual(errors, []); console.log(`${name}: automatic consumption, supplier drilldown, credit/balance pagination, cash CRUD, cumulative filters, charts and layout passed`);
      } finally { await context.close(); await preview.close(); }
    }
    console.log(`Screenshots: ${directory}`);
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
