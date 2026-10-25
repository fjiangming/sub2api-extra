'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { startPreview, sample, groupSample } = require('./billing-import-preview.cjs');

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
        await page.waitForFunction(() => [...document.querySelectorAll('#bci-list tr')].filter(row => row.textContent.includes('可补记，待确认')).length === 3);
        assert.equal(await page.locator('#bci-filter').inputValue(), 'actionable');
        assert.equal(await page.locator('#bci-prices').getAttribute('open'), null);
        const logRow = page.locator('#bci-list tr').filter({ hasText: '用户 22' });
        assert.match(await logRow.innerText(), /当前主站价格/);
        assert.match(await logRow.innerText(), /售卖倍率 0.9/);
        assert.match(await logRow.innerText(), /0.04577850 USD/);
        assert.match(await page.locator('#bci-summary').innerText(), /可补记 3.*待核查 4.*已计费 3/);
        assert.equal(matchResult.summary.time_candidate, 3);
        assert.match(await page.locator('#bci-diagnostics').innerText(), /开始时间.*4 \/ 0/);
        assert.match(await page.locator('#bci-diagnostics').innerText(), /CSV 账单时间 2026\/10\/22.*证据读取时段/);
        assert.match(await page.locator('#bci-diagnostics').innerText(), /已观察 Token 排除 1/);
        assert.match(await page.locator('#bci-list tr').filter({ hasText: '用户 11' }).innerText(), /已关联 2 份来源证据/);
        await page.locator('#bci-filter').selectOption('review');
        await page.waitForFunction(() => document.getElementById('bci-list').textContent.includes('扣费待核查'));
        assert.equal(await page.locator('#bci-list tr').filter({ hasText: '多个候选' }).count(), 1);
        assert.match(await page.locator('#bci-list tr').filter({ hasText: '多个候选' }).innerText(), /自动核查组：1 条账单 \/ 2 个候选来源.*不同用户/s);
        if (['desktop', 'mobile'].includes(name)) {
          await page.evaluate(() => {
            window.scrollTo(0, 0);
            const table = document.getElementById('bci-list').closest('.table-wrap'); table.scrollLeft = table.scrollWidth;
          });
          await page.screenshot({ path: path.join(directory, `${name}-review.png`), fullPage: true });
          await page.evaluate(() => { document.getElementById('bci-list').closest('.table-wrap').scrollLeft = 0; });
        }
        const unresolved = page.locator('#bci-list tr').filter({ hasText: '扣费待核查' });
        assert.match(await unresolved.innerText(), /本地实际费用 0.00000000/);
        assert.equal(await unresolved.locator('input[data-select]').isDisabled(), true);
        assert.equal(await page.locator('#bci-user-filter').isVisible(), true);
        assert.match(await page.locator('#bci-review-summary').innerText(), /1 位用户有 1 条/);
        await page.locator('#bci-user').selectOption('15');
        await page.waitForFunction(() => document.querySelectorAll('#bci-list tr').length === 1);
        assert.match(await page.locator('#bci-list').innerText(), /用户 15.*扣费待核查/s);
        assert.equal(await page.locator('#bci-list [data-select]').isDisabled(), true);
        await page.locator('#bci-user').selectOption('');
        await page.waitForFunction(() => document.querySelectorAll('#bci-list tr').length === 4);
        await page.locator('#bci-filter').selectOption('all');
        await page.waitForFunction(() => document.querySelectorAll('#bci-list tr').length === 10);
        assert.equal(await page.locator('#bci-list tr').filter({ hasText: '重复行' }).count(), 1);
        assert.equal(await page.locator('#bci-list tr').filter({ hasText: '已计费' }).count(), 3);
        assert.equal(await page.locator('#bci-user-filter').isVisible(), false);
        await page.locator('#bci-filter').selectOption('actionable');
        await page.waitForFunction(() => document.querySelectorAll('#bci-list tr').length === 3);
        assert.equal(await page.locator('#bci-user-preview tbody tr').count(), 3);
        assert.match(await page.locator('#bci-user-preview').innerText(), /订阅用量/);
        assert.match(await page.locator('#bci-user-preview').innerText(), /余额/);
        const gap = supplierCost === '' ? '未知' : supplierCost === '0.3' ? '上游多扣 0.05141600' : '本站拟多收 0.02414800';
        const balanceRow = page.locator('#bci-list tr').filter({ hasText: '用户 11' });
        const subscriptionRow = page.locator('#bci-list tr').filter({ hasText: '用户 12' });
        assert.equal(await balanceRow.locator('[data-cost-gap]').innerText(), gap);
        assert.equal(await subscriptionRow.locator('[data-cost-gap]').innerText(), '不适用：订阅用量');
        const summary = page.locator('#bci-cost-preview tbody tr').filter({ hasText: '余额补扣' });
        assert.match(await summary.innerText(), supplierCost === '' ? /1 笔未知.*0.29436250.*未知：上游费用不完整/ : /0.29436250/);
        assert.match(await page.locator('#bci-user-preview tbody tr').filter({ hasText: 'demo-user-11' }).innerText(), new RegExp(gap));
        await balanceRow.locator('[data-select]').uncheck();
        assert.equal(await page.locator('#bci-cost-preview tbody tr').count(), 2);
        assert.match(await page.locator('#bci-total').innerText(), /本页所选 2 笔/);
        assert.equal(await page.locator('#bci-user-preview tbody tr').count(), 2);
        await balanceRow.locator('[data-select]').check();
        await page.locator('#bci-acknowledge').check(); assert.equal(await page.locator('#bci-confirm').isEnabled(), true);
        await page.locator('#bci-prices summary').click();
        await page.locator('#bci-pricing-mode').selectOption('manual');
        assert.equal(await page.locator('#bci-confirm').isEnabled(), false);
        await page.locator('#bci-pricing-mode').selectOption('auto');
        await Promise.all([page.waitForResponse(response => response.url().endsWith('/preview') && response.ok()),
          page.locator('#bci-preview').click()]);
        await page.waitForFunction(() => !document.getElementById('bci-preview').disabled);
        await page.locator('#bci-prices summary').click();
        const overflow = await page.evaluate(() => ({ page: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          buttons: [...document.querySelectorAll('#br-import-pane button')].filter(el => el.offsetWidth && el.scrollWidth > el.clientWidth + 1).map(el => el.textContent.trim()) }));
        assert.deepEqual(overflow, { page: false, buttons: [] });
        await page.evaluate(() => { window.scrollTo(0, 0); for (const element of document.querySelectorAll('.table-wrap')) element.scrollLeft = 0; });
        await page.screenshot({ path: path.join(directory, `${name}.png`), fullPage: true });
        if (name === 'desktop') {
          const row = preview.imports.detail(matchResult.id).rows.find(item => item.status === 'preview');
          preview.imports.store.save(row.id, { match: { ...row.match, algorithmVersion: 4 }, status: 'failed' }, row.version);
          await page.locator('#bci-filter').selectOption('all');
          await page.waitForFunction(() => document.querySelectorAll('#bci-list tr').length === 10);
          await page.locator('#bci-filter').selectOption('actionable');
          await page.waitForFunction(() => document.querySelectorAll('#bci-list tr').length === 3);
          const resumed = page.locator('#bci-list tr').filter({ hasText: '结算未完成' });
          assert.equal(await resumed.locator('[data-select]').isEnabled(), true);
          assert.equal(await resumed.locator('[data-select]').isChecked(), true);
        }
        await page.locator('#bci-acknowledge').check(); await page.locator('#bci-confirm').click();
        await page.waitForFunction(() => [...document.querySelectorAll('#bci-list tr')].filter(row => row.textContent.includes('已补记')).length === 3);
        assert.equal(await page.locator('#bci-confirm').isEnabled(), false);
        await page.reload(); await page.locator('#br-import-tab').click();
        await page.locator('#bci-batches option').nth(1).waitFor({ state: 'attached' });
        const batchID = await page.locator('#bci-batches option').nth(1).getAttribute('value');
        await page.locator('#bci-batches').selectOption(batchID);
        await page.waitForFunction(() => document.getElementById('bci-summary').textContent.includes('已补记 3 条'));
        await page.locator('#bci-filter').selectOption('settled');
        await page.waitForFunction(() => document.querySelectorAll('#bci-list tr').length === 3);
        assert.deepEqual(errors, []);
        console.log(`${name}: CSV upload, matching, preview, native demo settlement, reload, filtering and layout passed`);
      } finally { await context.close(); await preview.stop(); }
    }
    for (const [name, viewport] of [['group-desktop', { width: 1440, height: 1024 }], ['group-mobile', { width: 390, height: 844 }]]) {
      const preview = await startPreview({ port: 0, includeGroups: true });
      const context = await browser.newContext({ viewport });
      try {
        const page = await context.newPage(), errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${preview.port}/preview`);
        await page.locator('#br-import-tab').click();
        await Promise.all([page.waitForResponse(response => response.url().endsWith('/inspect') && response.ok()),
          page.locator('#bci-file').setInputFiles({ name: 'group-demo.csv', mimeType: 'text/csv', buffer: Buffer.from(groupSample) })]);
        await page.locator('#bci-upload button[type=submit]').click();
        await page.locator('#bci-workspace').waitFor({ state: 'visible' });
        await page.locator('#bci-mappings select').selectOption('356');
        await page.locator('#bci-match button[type=submit]').click();
        await page.waitForFunction(() => document.querySelectorAll('#bci-group-preview tbody tr').length === 2);
        assert.equal(await page.locator('#bci-list tr').count(), 5);
        const groupRows = page.locator('#bci-list tr').filter({ hasText: '用户 24' });
        assert.equal(await groupRows.count(), 2);
        assert.match(await page.locator('#bci-group-preview').innerText(), /整组核查通过.*2 笔/);
        await groupRows.first().locator('[data-select]').uncheck();
        assert.equal(await groupRows.last().locator('[data-select]').isChecked(), false);
        assert.equal(await page.locator('#bci-group-preview').isVisible(), false);
        await groupRows.last().locator('[data-select]').check();
        assert.equal(await groupRows.first().locator('[data-select]').isChecked(), true);
        assert.equal(await page.locator('#bci-group-preview tbody tr').count(), 2);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
        await page.screenshot({ path: path.join(directory, `${name}.png`), fullPage: true });
        await page.locator('#bci-acknowledge').check();
        await page.locator('#bci-confirm').click();
        await page.waitForFunction(() => document.getElementById('bci-summary').textContent.includes('已补记 5 条'));
        assert.equal(await page.locator('#bci-list tr').filter({ hasText: '已补记' }).count(), 5);
        assert.deepEqual(errors, []);
        console.log(`${name}: full-group disclosure, selection, native reservation and settlement passed`);
      } finally { await context.close(); await preview.stop(); }
    }
    console.log(`Screenshots: ${directory}`);
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
