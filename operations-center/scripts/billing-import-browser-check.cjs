'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { startPreview, sample } = require('./billing-import-preview.cjs');

async function main() {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  const directory = process.env.BILLING_IMPORT_QA_DIR || path.join(os.tmpdir(), 'sub2api-csv-billing-ui-qa');
  fs.mkdirSync(directory, { recursive: true });
  try {
    for (const [name, viewport, supplierCost] of [
      ['desktop', { width: 1440, height: 1024 }, '0.224436'],
      ['mobile', { width: 390, height: 844 }, '0.224436'],
      ['positive-gap', { width: 1440, height: 1024 }, '0.3'],
      ['unknown-cost', { width: 390, height: 844 }, '']
    ]) {
      const preview = await startPreview({ port: 0 });
      const context = await browser.newContext({ viewport });
      try {
        const page = await context.newPage(), errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${preview.port}/preview`);
        await page.locator('#br-import-tab').click();
        await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/billing-imports/inspect') && response.ok()),
          page.locator('#bci-file').setInputFiles({ name: 'browser-demo.csv', mimeType: 'text/csv', buffer: Buffer.from(sample.replaceAll('174000,0.224436,', `174000,${supplierCost},`)) })]);
        await page.locator('#bci-upload button[type=submit]').click();
        await page.locator('#bci-workspace').waitFor({ state: 'visible' });
        await page.locator('#bci-mappings select').selectOption('356');
        const [matchResponse] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/match') && response.ok()),
          page.locator('#bci-match button[type=submit]').click()]);
        const matchResult = await matchResponse.json();
        await page.waitForFunction(() => !document.querySelector('#bci-match button[type=submit]').disabled);
        await page.waitForFunction(() => document.querySelectorAll('#bci-list tr').length === 10);
        assert.equal(await page.locator('#bci-list tr').filter({ hasText: '时间候选' }).count(), 2, JSON.stringify({ summary: matchResult.summary, diagnostics: matchResult.matchDiagnostics }));
        assert.equal(await page.locator('#bci-list tr').filter({ hasText: '多个候选' }).count(), 1);
        assert.equal(await page.locator('#bci-list tr').filter({ hasText: '已确认本地扣费' }).count(), 3, JSON.stringify({ summary: matchResult.summary, diagnostics: matchResult.matchDiagnostics }));
        assert.equal(await page.locator('#bci-list tr').filter({ hasText: '已定位用户，请求待核查' }).count(), 1);
        assert.equal(await page.locator('#bci-list tr').filter({ hasText: '有记录，扣费待核查' }).count(), 1);
        assert.match(await page.locator('#bci-diagnostics').innerText(), /开始时间.*4 \/ 0/);
        await page.locator('#bci-filter').selectOption('owners');
        await page.waitForFunction(() => document.querySelectorAll('#bci-list tr').length === 1);
        assert.match(await page.locator('#bci-list').innerText(), /用户 22.*Key 122/);
        assert.equal(await page.locator('#bci-list input[data-select]').isDisabled(), true);
        await page.locator('#bci-filter').selectOption('unresolved');
        await page.waitForFunction(() => document.getElementById('bci-list').textContent.includes('扣费待核查'));
        assert.match(await page.locator('#bci-list').innerText(), /本地实际费用 0.00000000/);
        assert.equal(await page.locator('#bci-list input[data-select]').isDisabled(), true);
        await page.locator('#bci-filter').selectOption('all');
        await page.waitForFunction(() => document.querySelectorAll('#bci-list tr').length === 10);
        assert.equal(await page.locator('#bci-list tr').filter({ hasText: '重复行' }).count(), 1);
        await page.locator('#bci-price-evidence').fill('Local demo: historical price snapshot verified.');
        await page.locator('#bci-final-usage').check(); await page.locator('#bci-time-checked').check();
        await page.locator('#bci-preview').click();
        await page.waitForFunction(() => [...document.querySelectorAll('#bci-list tr')].filter(row => row.textContent.includes('待确认扣费')).length === 2);
        assert.equal(await page.locator('#bci-user-preview tbody tr').count(), 2);
        assert.match(await page.locator('#bci-user-preview').innerText(), /订阅用量/);
        assert.match(await page.locator('#bci-user-preview').innerText(), /余额/);
        const gap = supplierCost === '' ? '未知' : supplierCost === '0.3' ? '上游多扣 0.05141600' : '本站拟多收 0.02414800';
        const balanceRow = page.locator('#bci-list tr').filter({ hasText: '用户 11' });
        const subscriptionRow = page.locator('#bci-list tr').filter({ hasText: '用户 12' });
        assert.equal(await balanceRow.locator('[data-cost-gap]').innerText(), gap);
        assert.equal(await subscriptionRow.locator('[data-cost-gap]').innerText(), '不适用：订阅用量');
        const summary = page.locator('#bci-cost-preview tbody tr').filter({ hasText: '余额补扣' });
        assert.match(await summary.innerText(), new RegExp(supplierCost === '' ? '1 笔未知.*0.24858400.*未知：上游费用不完整' : `${supplierCost === '0.3' ? '0.30000000' : '0.22443600'}.*0.24858400.*${gap}`));
        assert.match(await page.locator('#bci-user-preview tbody tr').filter({ hasText: 'demo-user-11' }).innerText(), new RegExp(gap));
        await balanceRow.locator('[data-select]').uncheck();
        assert.equal(await page.locator('#bci-cost-preview tbody tr').count(), 1);
        assert.match(await page.locator('#bci-total').innerText(), /本页所选 1 笔/);
        assert.equal(await page.locator('#bci-user-preview tbody tr').count(), 1);
        await balanceRow.locator('[data-select]').check();
        await page.locator('#bci-acknowledge').check(); assert.equal(await page.locator('#bci-confirm').isEnabled(), true);
        await page.locator('#bci-price-list input[data-price=multiplier]').first().fill('1.2');
        assert.equal(await page.locator('#bci-confirm').isEnabled(), false);
        await Promise.all([page.waitForResponse(response => response.url().endsWith('/preview') && response.ok()),
          page.locator('#bci-preview').click()]);
        await page.waitForFunction(() => !document.getElementById('bci-preview').disabled);
        const overflow = await page.evaluate(() => ({ page: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          buttons: [...document.querySelectorAll('#br-import-pane button')].filter(el => el.offsetWidth && el.scrollWidth > el.clientWidth + 1).map(el => el.textContent.trim()) }));
        assert.deepEqual(overflow, { page: false, buttons: [] });
        await page.evaluate(() => { window.scrollTo(0, 0); for (const element of document.querySelectorAll('.table-wrap')) element.scrollLeft = 0; });
        await page.screenshot({ path: path.join(directory, `${name}.png`), fullPage: true });
        await page.locator('#bci-acknowledge').check(); await page.locator('#bci-confirm').click();
        await page.waitForFunction(() => [...document.querySelectorAll('#bci-list tr')].filter(row => row.textContent.includes('已补记扣费')).length === 2);
        assert.equal(await page.locator('#bci-confirm').isEnabled(), false);
        await page.reload(); await page.locator('#br-import-tab').click();
        await page.locator('#bci-batches option').nth(1).waitFor({ state: 'attached' });
        const batchID = await page.locator('#bci-batches option').nth(1).getAttribute('value');
        await page.locator('#bci-batches').selectOption(batchID);
        await page.waitForFunction(() => document.getElementById('bci-summary').textContent.includes('已补记 2 条'));
        await page.locator('#bci-filter').selectOption('settled');
        await page.waitForFunction(() => document.querySelectorAll('#bci-list tr').length === 2);
        assert.deepEqual(errors, []);
        console.log(`${name}: CSV upload, matching, preview, native demo settlement, reload, filtering and layout passed`);
      } finally { await context.close(); await preview.stop(); }
    }
    console.log(`Screenshots: ${directory}`);
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
