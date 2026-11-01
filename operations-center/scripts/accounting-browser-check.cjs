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

async function main() {
  const directory = process.env.ACCOUNTING_QA_DIR || path.join(os.tmpdir(), 'sub2api-accounting-ui-qa');
  fs.mkdirSync(directory, { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  try {
    for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }], ['narrow', { width: 320, height: 740 }]]) {
      const preview = await startPreview();
      const context = await browser.newContext({ viewport });
      try {
        const page = await context.newPage(), errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${preview.port}/preview`);
        await waitFor(page, () => Boolean(accountingUi.state.report));
        assert.equal(await page.locator('.accounting-rules').evaluate(node => node.open), false);
        assert.equal(await page.locator('#cost-analysis-filter [name=granularity]').inputValue(), 'day');
        await page.locator('#cost-analysis-filter [name=start]').fill(preview.start);
        await page.locator('#cost-analysis-filter [name=end]').fill(preview.today);
        await page.locator('#cost-analysis-filter [type=submit]').click();
        await waitFor(page, start => accountingUi.state.report.range.start === start && accountingUi.state.report.summary.completeDays === 31, preview.start);
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
        const painted = await page.locator('#accounting-chart canvas').first().evaluate(canvas => {
          const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
          let count = 0; for (let index = 3; index < pixels.length; index += 4) if (pixels[index]) count++;
          return count;
        });
        assert(painted > 500);
        const chartLayout = await page.locator('#accounting-chart').evaluate(node => {
          const instance = echarts.getInstanceByDom(node), model = instance.getModel();
          const legend = instance.getViewOfComponentModel(model.getComponent('legend')).group;
          const bounds = legend.getBoundingRect().clone(); bounds.applyTransform(legend.getComputedTransform());
          return { legendBottom: bounds.y + bounds.height, plotTop: model.getComponent('grid').coordinateSystem.getRect().y };
        });
        assert(chartLayout.legendBottom + 14 < chartLayout.plotTop, 'Chart legend must clear the plot and axis labels');
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: path.join(directory, `${name}-business.png`), fullPage: true });
        await page.locator('[data-tab=cash]').click();
        await page.locator('[data-command=credits]').click();
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
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
        assert.deepEqual(errors, []);
        console.log(`${name}: report, chart, user pagination/search/drilldown, entry/edit visibility, opening, source gaps and layout passed`);
      } finally { await context.close(); await preview.close(); }
    }
  } finally { await browser.close(); }
  console.log(`Accounting UI screenshots: ${directory}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
