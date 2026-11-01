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
  await waitFor(page, target => {
    const instance = echarts.getInstanceByDom(document.querySelector(target));
    return Boolean(instance && instance.getZr().animation.isFinished());
  }, selector);
  const painted = await page.locator(`${selector} canvas`).first().evaluate(canvas => {
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0; for (let index = 3; index < pixels.length; index += 4) if (pixels[index]) count++;
    return count;
  });
  assert(painted > 500);
  const layout = await page.locator(selector).evaluate(node => {
    const instance = echarts.getInstanceByDom(node), model = instance.getModel();
    const legend = instance.getViewOfComponentModel(model.getComponent('legend')).group;
    const bounds = legend.getBoundingRect().clone(); bounds.applyTransform(legend.getComputedTransform());
    return { legendBottom: bounds.y + bounds.height, plotTop: model.getComponent('grid').coordinateSystem.getRect().y };
  });
  assert(layout.legendBottom + 14 < layout.plotTop, 'Chart legend must clear the plot and axis labels');
}

async function checkCreditDetails(page) {
  await page.locator('[data-command=credits]:visible').click();
  await page.waitForSelector('#cost-auto-users tr [data-cost-auto-user-detail]');
  assert.equal(await page.locator('#cost-auto-users tr').count(), 20);
  await page.locator('#cost-auto-users-next').click();
  await waitFor(page, () => document.querySelector('#cost-auto-users-page-label').textContent.includes('2 / 2'));
  await page.locator('#cost-auto-user-search [name=search]').fill('paid@example.test');
  await page.locator('#cost-auto-user-search [type=submit]').click();
  await waitFor(page, () => document.querySelectorAll('#cost-auto-users tr [data-cost-auto-user-detail]').length === 1);
  await page.locator('[data-cost-auto-user-detail]').click();
  await page.waitForSelector('#cost-auto-records .redeem-code');
  assert.match(await page.locator('#cost-auto-records').innerText(), /example-paid/);
  await page.locator('#cost-auto-records-back').click();
  assert.equal(await page.locator('#cost-auto-user-search [name=search]').inputValue(), 'paid@example.test');
  await page.locator('#cost-auto-income-close').click();
  await waitFor(page, () => accountingUi.state.active);
}

async function main() {
  const directory = process.env.ACCOUNTING_QA_DIR || path.join(os.tmpdir(), 'sub2api-accounting-ui-qa');
  fs.mkdirSync(directory, { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  try {
    for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }], ['narrow', { width: 320, height: 740 }]]) {
      const preview = await startPreview();
      const context = await browser.newContext({ viewport });
      try {
        // Automatic consumption reporting must work before the optional accounting start.
        preview.accounting.configure({ startDate: preview.today, reason: 'Verify automatic history independence' }, 'example');
        const page = await context.newPage(), errors = [], requests = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('request', request => requests.push(new URL(request.url()).pathname));
        await page.goto(`http://127.0.0.1:${preview.port}/preview`);
        await waitFor(page, () => Boolean(accountingUi.state.report));
        assert.equal(await page.locator('[data-tab=automatic]').getAttribute('aria-selected'), 'true');
        assert.equal(await page.locator('.accounting-rules').evaluate(node => node.open), false);
        assert.equal(await page.locator('#cost-analysis-filter [name=granularity]').inputValue(), 'day');
        await page.locator('#cost-analysis-filter [name=start]').fill(preview.start);
        await page.locator('#cost-analysis-filter [name=end]').fill(preview.today);
        await page.locator('#cost-analysis-filter [type=submit]').click();
        await waitFor(page, start => accountingUi.state.report.range.start === start && accountingUi.state.report.summary.completeDays === 31, preview.start);
        const automatic = await page.evaluate(() => accountingUi.state.report.summary);
        assert.equal(automatic.siteConsumption, 4340); assert.equal(automatic.supplierConsumption, 573.5);
        assert.equal(automatic.profit, 3766.5); assert.equal(automatic.margin, 86.79);
        assert.equal(await page.locator('[data-automatic-days] tr').count(), 15);
        await page.locator('[data-automatic-day-step="1"]').click();
        assert.match(await page.locator('[data-automatic-day-page]').innerText(), /2 \/ 3/);
        await page.locator('[data-automatic-day-step="-1"]').click();
        await checkChart(page, '#accounting-automatic-chart');
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: path.join(directory, `${name}-automatic.png`), fullPage: true });
        await page.locator('[data-automatic-metrics] [data-metric=profit]').click();
        await page.locator('[data-dialog] [data-automatic-day]').first().click();
        assert.match(await page.locator('[data-drawer]').innerText(), /供应商实际消费/);
        assert.doesNotMatch(await page.locator('[data-drawer]').innerText(), /期初|待分类/);
        await page.screenshot({ path: path.join(directory, `${name}-automatic-detail.png`) });
        await page.locator('[data-dialog] [data-close]').first().click();
        await waitFor(page, () => !accountingUi.state.automaticMetaLoading);
        await page.locator('[data-command=automatic-balance]').click();
        assert.match(await page.locator('[data-drawer]').innerText(), /不含 ID 1/);
        await page.locator('[data-dialog] [data-close]').first().click();
        await checkCreditDetails(page);
        assert(requests.includes('/api/cost-analysis/automatic-income/users'));
        assert(!requests.some(url => url.startsWith('/api/cost-analysis/accounting/')), 'Default reporting must not require accounting migration or reconciliation');

        // A slow or failed supplementary balance query must not hide valid daily totals.
        let releaseMeta;
        const metaGate = new Promise(resolve => { releaseMeta = resolve; });
        const metaRoute = async route => { await metaGate; await route.fulfill({ status: 503, json: { error: { message: 'Synthetic metadata outage' } } }); };
        await page.route('**/api/cost-analysis?*', metaRoute);
        await page.evaluate(() => { accountingUi.state.report = null; accountingUi.load(); });
        await waitFor(page, () => accountingUi.state.report?.automatic && accountingUi.state.automaticMetaLoading);
        assert.equal(await page.evaluate(() => accountingUi.state.report.summary.profit), 3766.5);
        releaseMeta();
        await waitFor(page, () => !accountingUi.state.automaticMetaLoading && accountingUi.state.automaticMeta === null);
        assert.match(await page.locator('[data-automatic-meta]').innerText(), /暂不可用/);
        assert.equal(await page.evaluate(() => accountingUi.state.report.summary.profit), 3766.5);
        await page.unroute('**/api/cost-analysis?*', metaRoute);

        // An obsolete fine-accounting response must not replace a later automatic tab.
        let releaseReport, enteredReport;
        const reportGate = new Promise(resolve => { releaseReport = resolve; });
        const reportEntered = new Promise(resolve => { enteredReport = resolve; });
        const reportRoute = async route => { enteredReport(); await reportGate; await route.continue(); };
        await page.route('**/api/cost-analysis/accounting/report?*', reportRoute);
        await page.locator('[data-tab=business]').click(); await reportEntered;
        await page.locator('[data-tab=automatic]').click();
        await waitFor(page, () => accountingUi.state.report?.automatic && accountingUi.state.tab === 'automatic');
        const oldResponse = page.waitForResponse(response => response.url().includes('/accounting/report?'));
        releaseReport(); await oldResponse;
        assert.equal(await page.evaluate(() => accountingUi.state.report.automatic), true);
        assert.equal(await page.locator('[data-notice]').isVisible(), false);
        await page.unroute('**/api/cost-analysis/accounting/report?*', reportRoute);
        preview.accounting.configure({ startDate: preview.start, reason: 'Restore isolated accounting fixture' }, 'example');
        await page.locator('[data-tab=business]').click();
        await waitFor(page, () => accountingUi.state.report && !accountingUi.state.report.automatic && accountingUi.state.report.summary.completeDays === 31);
        const baseline = await page.evaluate(() => accountingUi.state.report.summary);
        assert.equal(baseline.fee, 31); assert.equal(baseline.supplierCost, 573.5); assert.equal(baseline.revenue, 1749);
        assert.equal(baseline.profit, 1144.5);
        assert.equal(await page.locator('[data-days] tr').count(), 15);
        await page.locator('[data-day-step="1"]').click();
        assert.match(await page.locator('[data-day-page]').innerText(), /2 \/ 3/);
        await page.locator('[data-day-step="-1"]').click();
        await page.locator('[data-metric=revenue]').click();
        assert.equal(await page.locator('[data-dialog]').evaluate(node => node.open), true);
        await page.locator('[data-dialog] [data-day]').first().click();
        assert.match(await page.locator('[data-drawer]').innerText(), /收入与费用分摊/);
        await page.screenshot({ path: path.join(directory, `${name}-daily-detail.png`) });
        await page.locator('[data-dialog] [data-close]').first().click();
        await checkChart(page, '#accounting-chart');
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: path.join(directory, `${name}-business.png`), fullPage: true });
        await page.locator('[data-tab=cash]').click();
        await checkCreditDetails(page);
        assert(requests.includes('/api/cost-analysis/accounting/credits/users'));
        await page.locator('#cost-accounting-add').click();
        await page.waitForSelector('[data-entry-form]');
        assert.equal(await page.locator('[data-entry-form] [name=currency]').inputValue(), 'CNY');
        await page.locator('[data-entry-form] [name=name]').fill('Browser expense <verified>');
        await page.locator('[data-entry-form] [name=amount]').fill('3.5');
        await page.locator('[data-entry-form] [name=reason]').fill('Synthetic browser invoice');
        await page.screenshot({ path: path.join(directory, `${name}-entry.png`) });
        await page.locator('[data-entry-form] [type=submit]').click();
        await waitFor(page, () => !document.querySelector('[data-dialog]').open);
        await waitFor(page, () => document.querySelector('[data-documents]').textContent.includes('Browser expense <verified>'));
        assert.equal(preview.store.documents().filter(document => document.name === 'Browser expense <verified>').length, 1);
        assert.equal(await page.locator('[data-documents] verified').count(), 0);
        await page.locator('[data-tab=business]').click();
        await waitFor(page, () => accountingUi.state.report.summary.fee === 34.5);
        await page.locator('[data-tab=audit]').click();
        await page.locator('[data-users] [data-opening="2"]').click();
        await page.locator('[data-opening-form] [name=quantity]').fill('0');
        await page.locator('[data-opening-form] [name=cashValue]').fill('0');
        await page.locator('[data-opening-form] [name=reason]').fill('Verified zero at example start');
        await page.locator('[data-opening-form] [type=submit]').click();
        await waitFor(page, () => !document.querySelector('[data-dialog]').open);
        await waitFor(page, () => document.querySelector('[data-users]').textContent.includes('已确认'));
        await page.locator('#cost-analysis-filter [name=start]').fill(preview.today);
        await page.locator('#cost-analysis-filter [type=submit]').click();
        await waitFor(page, today => accountingUi.state.report.range.start === today, preview.today);
        await page.locator('#cost-accounting-add').click();
        await page.waitForSelector('[data-entry-form]');
        const yesterday = addUtcDays(preview.today, -1);
        await page.locator('[data-entry-form] [name=name]').fill('Outside selected range');
        await page.locator('[data-entry-form] [name=date]').fill(yesterday);
        await page.locator('[data-entry-form] [name=amount]').fill('2');
        await page.locator('[data-entry-form] [name=serviceStart]').fill(yesterday);
        await page.locator('[data-entry-form] [name=serviceEnd]').fill(yesterday);
        await page.locator('[data-entry-form] [name=reason]').fill('Synthetic past invoice');
        await page.locator('[data-entry-form] [type=submit]').click();
        await waitFor(page, date => accountingUi.state.report.range.start === date && accountingUi.state.report.range.end === date, yesterday);
        await waitFor(page, () => document.querySelector('[data-documents]').textContent.includes('Outside selected range'));
        preview.controls.supplierUnavailable = true;
        await page.locator('[data-tab=business]').click();
        await page.locator('#refresh-button').click();
        await waitFor(page, () => accountingUi.state.report.archive.pendingDays > 0);
        await preview.daily.drain();
        await page.locator('#cost-analysis-filter [type=submit]').click();
        await waitFor(page, () => accountingUi.state.report.summary.profit === null && accountingUi.state.report.items[0].supplierCost === null);
        await page.locator('[data-day]').first().click();
        assert.match(await page.locator('[data-drawer]').innerText(), /待核验|连接暂不可用/);
        await page.locator('[data-dialog] [data-close]').first().click();
        await page.locator('[data-tab=automatic]').click();
        await waitFor(page, () => accountingUi.state.report?.automatic && accountingUi.state.report.summary.profit === null);
        assert.equal(await page.evaluate(() => accountingUi.state.report.summary.siteConsumption), 140);
        assert.equal(await page.evaluate(() => accountingUi.state.report.summary.supplierConsumption), null);
        await page.locator('[data-automatic-day]').first().click();
        assert.match(await page.locator('[data-drawer]').innerText(), /暂不可用|连接暂不可用/);
        await page.locator('[data-dialog] [data-close]').first().click();
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
        assert.deepEqual(errors, []);
        console.log(`${name}: automatic history, metadata failure, tab race, both charts/drilldowns, optional accounting, entries, opening, source gaps and layout passed`);
      } finally { await context.close(); await preview.close(); }
    }
  } finally { await browser.close(); }
  console.log(`Accounting UI screenshots: ${directory}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
