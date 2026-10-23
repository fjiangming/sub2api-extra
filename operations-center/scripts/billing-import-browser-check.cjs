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
    for (const [name, viewport] of [['desktop', { width: 1440, height: 1024 }], ['mobile', { width: 390, height: 844 }]]) {
      const preview = await startPreview();
      const context = await browser.newContext({ viewport });
      try {
        const page = await context.newPage(), errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${preview.port}/preview`);
        await page.locator('#br-import-tab').click();
        await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/billing-imports/inspect') && response.ok()),
          page.locator('#bci-file').setInputFiles({ name: 'browser-demo.csv', mimeType: 'text/csv', buffer: Buffer.from(sample) })]);
        await page.locator('#bci-upload button[type=submit]').click();
        await page.locator('#bci-workspace').waitFor({ state: 'visible' });
        await page.locator('#bci-mappings select').selectOption('356');
        await Promise.all([page.waitForResponse(response => response.url().endsWith('/match') && response.ok()),
          page.locator('#bci-match button[type=submit]').click()]);
        await page.waitForFunction(() => document.querySelectorAll('#bci-list tr').length === 6);
        assert.equal(await page.locator('#bci-list tr').filter({ hasText: '时间候选' }).count(), 2);
        assert.equal(await page.locator('#bci-list tr').filter({ hasText: '多个候选' }).count(), 1);
        assert.equal(await page.locator('#bci-list tr').filter({ hasText: '已有使用记录' }).count(), 1);
        assert.equal(await page.locator('#bci-list tr').filter({ hasText: '重复行' }).count(), 1);
        await page.locator('#bci-price-evidence').fill('Local demo: historical price snapshot verified.');
        await page.locator('#bci-final-usage').check(); await page.locator('#bci-time-checked').check();
        await page.locator('#bci-preview').click();
        await page.waitForFunction(() => [...document.querySelectorAll('#bci-list tr')].filter(row => row.textContent.includes('待确认扣费')).length === 2);
        assert.equal(await page.locator('#bci-user-preview tbody tr').count(), 2);
        assert.match(await page.locator('#bci-user-preview').innerText(), /订阅用量/);
        assert.match(await page.locator('#bci-user-preview').innerText(), /余额/);
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
