'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { startPreview, sample, groupSample, manySample } = require('./billing-import-preview.cjs');

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
          await page.waitForFunction(() => !document.getElementById('bci-filter').disabled);
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
    {
      const preview = await startPreview({ port: 0, includeMany: true });
      const context = await browser.newContext({ viewport: { width: 1440, height: 1024 } });
      try {
        const page = await context.newPage(), previewChunkSizes = [], confirmBodies = [];
        page.on('request', request => {
          if (request.url().endsWith('/preview') && request.method() === 'POST') {
            previewChunkSizes.push(request.postDataJSON().rowIds.length);
          }
          if (request.url().endsWith('/confirm') && request.method() === 'POST') confirmBodies.push(request.postDataJSON());
        });
        await page.goto(`http://127.0.0.1:${preview.port}/preview`);
        await page.locator('#br-import-tab').click();
        await page.locator('#bci-file').setInputFiles({ name: 'many-rows.csv', mimeType: 'text/csv', buffer: Buffer.from(manySample) });
        await page.locator('#bci-upload button[type=submit]').click();
        await page.locator('#bci-workspace').waitFor({ state: 'visible' });
        await page.locator('#bci-mappings select').selectOption('356');
        await page.locator('#bci-match button[type=submit]').click();
        await page.waitForFunction(() => document.getElementById('bci-summary').textContent.includes('可补记 21'));
        await page.waitForFunction(() => !document.getElementById('bci-filter').disabled);
        assert.deepEqual(previewChunkSizes, [20, 1]);
        assert.equal(await page.locator('#bci-list tr').count(), 20);
        assert.match(await page.locator('#bci-summary').innerText(), /可补记 21/);
        const batchId = preview.imports.store.batches()[0].id;
        const rows = preview.imports.store.rows(batchId);
        assert.equal(rows.filter(row => row.status === 'preview').length, 21);
        assert.ok(rows.every(row => !row.case_id), 'preview generation must not reserve or settle cases');
        await page.waitForFunction(() => !document.getElementById('bci-filter').disabled);
        await page.locator('#bci-clear-selection').click();
        await page.locator('#bci-select-all').check();
        await page.locator('#bci-list [data-select]').first().uncheck();
        await page.locator('#bci-next').click();
        await page.waitForFunction(() => document.querySelectorAll('#bci-list tr').length === 1 && !document.getElementById('bci-filter').disabled);
        await page.locator('#bci-list [data-select]').check();
        assert.match(await page.locator('#bci-selection').innerText(), /已选 20 笔/);
        await page.locator('#bci-prev').click();
        await page.waitForFunction(() => document.querySelectorAll('#bci-list tr').length === 20 && !document.getElementById('bci-filter').disabled);
        assert.equal(await page.locator('#bci-list [data-select]').first().isChecked(), false);
        assert.equal(await page.locator('#bci-list [data-select]:checked').count(), 19);
        await page.locator('#bci-filter').selectOption('recorded');
        await page.waitForFunction(() => document.querySelectorAll('#bci-list tr').length === 3 && !document.getElementById('bci-filter').disabled);
        assert.match(await page.locator('#bci-selection').innerText(), /已选 20 笔/);
        await page.locator('#bci-clear-selection').click();
        await page.locator('#bci-filter').selectOption('actionable');
        await page.waitForFunction(() => document.querySelectorAll('#bci-list tr').length === 20 && !document.getElementById('bci-filter').disabled);
        assert.equal(await page.locator('#bci-list [data-select]:checked').count(), 0, 'clearing must survive pagination and filters');
        await page.locator('#bci-select-filtered').click();
        await page.waitForFunction(() => document.getElementById('bci-selection').textContent.includes('已选 21 笔') && !document.getElementById('bci-filter').disabled);
        assert.match(await page.locator('#bci-total').innerText(), /跨页所选 21 笔/);
        await page.locator('#bci-preview').click();
        await page.waitForFunction(() => !document.getElementById('bci-filter').disabled);
        assert.deepEqual(previewChunkSizes, [20, 1, 20, 1]);
        const quoted = preview.imports.store.rows(batchId).filter(row => row.preview);
        assert.equal(quoted.length, 21);
        assert.ok(quoted.every(row => row.preview.id !== rows.find(previous => previous.id === row.id).preview.id));
        await page.locator('#bci-acknowledge').check(); await page.locator('#bci-confirm').click();
        await page.waitForFunction(() => !document.getElementById('bci-filter').disabled);
        assert.deepEqual(confirmBodies.map(body => body.rows.length), [20, 1]);
        assert.equal(preview.ledger.usageRecords.size, 21);
        assert.equal(preview.ledger.charges.size, 21);
        assert.ok([...preview.ledger.charges.values()].every(count => count === 1));
        const expected = Number((100 - quoted.reduce((sum, row) => sum + row.preview.usage.ActualCost, 0)).toFixed(8));
        assert.equal(preview.ledger.balances.get('24'), expected);
        assert.match(await page.locator('#bci-action-status').innerText(), /已核实 21 笔已补记使用记录；余额扣费/);
        assert.equal(await page.locator('#bci-confirm').isEnabled(), false);
        for (const body of confirmBodies) await preview.imports.confirm(batchId, body);
        assert.equal(preview.ledger.usageRecords.size, 21);
        assert.equal(preview.ledger.balances.get('24'), expected);
        assert.ok([...preview.ledger.charges.values()].every(count => count === 1));
        await page.screenshot({ path: path.join(directory, 'cross-page-settled.png'), fullPage: true });
        console.log('many rows: cross-page selection, deselection, filtered select-all, 20 + 1 preview/confirmation and exactly-once demo funds passed');
      } finally { await context.close(); await preview.stop(); }
    }
    {
      const preview = await startPreview({ port: 0, includeMany: true, includeGroups: true });
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      try {
        const page = await context.newPage(), confirms = [];
        page.on('request', request => { if (request.url().endsWith('/confirm') && request.method() === 'POST') confirms.push(request.postDataJSON()); });
        const lines = manySample.trim().split('\n');
        // This export uses end timestamps; the group started 210 seconds earlier.
        const members = groupSample.trim().split('\n').slice(-2).map(line => line.replace('T09:30:00', 'T10:33:30').replace('T09:30:01', 'T10:33:31'));
        const csv = [...lines.slice(0, 23), ...members, ...lines.slice(23)].join('\n');
        await page.goto(`http://127.0.0.1:${preview.port}/preview`); await page.locator('#br-import-tab').click();
        await page.locator('#bci-file').setInputFiles({ name: 'cross-page-group.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
        await page.locator('#bci-upload button[type=submit]').click();
        await page.locator('#bci-workspace').waitFor({ state: 'visible' });
        await page.locator('#bci-mappings select').selectOption('356'); await page.locator('#bci-match button[type=submit]').click();
        await page.waitForFunction(() => document.getElementById('bci-summary').textContent.includes('可补记 23') && !document.getElementById('bci-filter').disabled);
        await page.locator('#bci-clear-selection').click(); await page.locator('#bci-select-all').check();
        assert.equal(await page.locator('#bci-group-preview tbody tr').count(), 2);
        assert.match(await page.locator('#bci-selection').innerText(), /已选 21 笔/);
        await page.locator('#bci-next').click();
        await page.waitForFunction(() => document.querySelectorAll('#bci-list tr').length === 3 && !document.getElementById('bci-filter').disabled);
        const member = page.locator('#bci-list tr').filter({ hasText: '整组报价及归属核查通过' });
        await member.locator('[data-select]').uncheck();
        assert.equal(await page.locator('#bci-group-preview').isVisible(), false);
        assert.match(await page.locator('#bci-selection').innerText(), /已选 19 笔/);
        await member.locator('[data-select]').check();
        await page.locator('#bci-prev').click();
        await page.waitForFunction(() => document.querySelectorAll('#bci-list tr').length === 20 && !document.getElementById('bci-filter').disabled);
        assert.equal(await page.locator('#bci-list [data-select]').last().isChecked(), true);
        await page.locator('#bci-preview').click();
        await page.waitForFunction(() => !document.getElementById('bci-filter').disabled);
        await page.locator('#bci-acknowledge').check(); await page.locator('#bci-confirm').click();
        await page.waitForFunction(() => !document.getElementById('bci-filter').disabled);
        assert.deepEqual(confirms.map(body => body.rows.length), [19, 2]);
        const batchId = preview.imports.store.batches().find(batch => batch.file_name === 'cross-page-group.csv').id;
        const groupIds = preview.imports.store.rows(batchId).filter(row => row.preview?.group).map(row => row.id);
        assert.equal(groupIds.length, 2);
        assert.ok(confirms.some(body => groupIds.every(id => body.rows.some(row => row.id === id))), 'never split a group between requests');
        assert.equal(preview.ledger.usageRecords.size, 21);
        assert.equal(preview.ledger.charges.size, 21);
        assert.match(await page.locator('#bci-action-status').innerText(), /已核实 21 笔/);
        await page.screenshot({ path: path.join(directory, 'cross-page-group-mobile.png'), fullPage: true });
        console.log('cross-page group: off-page selection/deselection and intact 19 + 2 confirmation passed');
      } finally { await context.close(); await preview.stop(); }
    }
    for (const [name, viewport] of [['confirm-desktop', { width: 1440, height: 1024 }], ['confirm-mobile', { width: 390, height: 844 }]]) {
      const preview = await startPreview({ port: 0 }), context = await browser.newContext({ viewport });
      let release;
      try {
        const page = await context.newPage(), errors = [];
        let confirms = 0, quotes = 0;
        page.on('pageerror', error => errors.push(error.message));
        page.on('request', request => {
          if (request.method() === 'POST' && request.url().endsWith('/confirm')) confirms++;
          if (request.method() === 'POST' && request.url().endsWith('/preview')) quotes++;
        });
        await page.goto(`http://127.0.0.1:${preview.port}/preview`); await page.locator('#br-import-tab').click();
        const batchId = preview.imports.store.batches()[0].id;
        await page.locator('#bci-batches').selectOption(batchId);
        await page.waitForFunction(() => document.querySelectorAll('#bci-list tr').length === 3 && !document.getElementById('bci-filter').disabled);
        const row = preview.imports.store.rows(batchId).find(item => item.preview?.userId === '11');
        preview.imports.store.save(row.id, { preview: { ...row.preview, expiresAt: Date.now() - 1 } }, row.version);
        await page.locator('#bci-filter').selectOption('all');
        await page.waitForFunction(() => !document.getElementById('bci-filter').disabled);
        await page.locator('#bci-filter').selectOption('actionable');
        await page.waitForFunction(() => !document.getElementById('bci-filter').disabled);
        await page.locator('#bci-acknowledge').check();
        assert.equal(await page.locator('#bci-confirm').isEnabled(), false);
        assert.match(await page.locator('#bci-confirm-note').innerText(), /1 笔扣费预览已过期/);
        assert.equal(confirms, 0); assert.equal(preview.ledger.usageRecords.size, 0);
        await page.locator('#bci-preview').click();
        await page.waitForFunction(() => !document.getElementById('bci-filter').disabled);
        const quotesBefore = quotes, restore = preview.imports.recovery.restore;
        let failOnce = true, started;
        const blocked = new Promise(resolve => { started = resolve; });
        preview.imports.recovery.restore = async (id, ...args) => {
          await restore(id, ...args);
          if (failOnce && id === row.preview.reservation.case_id) {
            await new Promise(resolve => { release = resolve; started(); });
            failOnce = false; throw new Error('模拟补记响应中断');
          }
        };
        await page.locator('#bci-acknowledge').check(); await page.locator('#bci-confirm').click();
        await blocked;
        assert.match(await page.locator('#bci-action-status').innerText(), /正在补记并结算/);
        assert.equal(await page.locator('#bci-confirm').isEnabled(), false);
        await page.evaluate(() => document.getElementById('bci-confirm').click());
        assert.equal(confirms, 1, 'double click must not start another confirmation');
        release();
        await page.waitForFunction(() => !document.getElementById('bci-filter').disabled);
        assert.match(await page.locator('#bci-action-status').innerText(), /已核实 2 笔已补记使用记录.*1 笔未确认完成.*模拟补记响应中断/s);
        assert.equal(preview.ledger.usageRecords.size, 2); assert.equal(preview.ledger.charges.size, 1);
        assert.equal(preview.ledger.balances.has('12'), false, 'subscription usage must not deduct balance');
        assert.equal(quotes, quotesBefore, 'confirmation must show receipts without launching new automatic quotes');
        assert.equal(await page.locator('#bci-acknowledge').isChecked(), false);
        assert.equal(await page.locator('#bci-list [data-select]:checked').count(), 1);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
        await page.screenshot({ path: path.join(directory, `${name}-partial.png`), fullPage: true });
        await page.locator('#bci-acknowledge').check(); await page.locator('#bci-confirm').click();
        await page.waitForFunction(() => !document.getElementById('bci-filter').disabled);
        assert.match(await page.locator('#bci-action-status').innerText(), /已核实 1 笔已补记使用记录；余额扣费 0.24858400 USD/);
        assert.equal(preview.ledger.usageRecords.size, 3); assert.equal(preview.ledger.charges.size, 2);
        assert.equal(preview.ledger.balances.get('11'), 99.751416);
        assert.ok([...preview.ledger.charges.values()].every(count => count === 1));
        assert.deepEqual(errors, []);
        console.log(`${name}: expiry, progress, duplicate click, partial failure feedback, receipt refresh and exactly-once retry passed`);
      } finally { release?.(); await context.close(); await preview.stop(); }
    }
    {
      const preview = await startPreview({ port: 0 }), context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto(`http://127.0.0.1:${preview.port}/preview`); await page.locator('#br-import-tab').click();
        await page.locator('#bci-batches').selectOption(preview.imports.store.batches()[0].id);
        await page.waitForFunction(() => document.querySelectorAll('#bci-list tr').length === 3 && !document.getElementById('bci-filter').disabled);
        await page.route('**/api/billing-imports/*/confirm', async route => {
          const response = await route.fetch(); assert.equal(response.status(), 200);
          await route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: { message: '模拟回包丢失' } }) });
        });
        await page.locator('#bci-acknowledge').check(); await page.locator('#bci-confirm').click();
        await page.waitForFunction(() => !document.getElementById('bci-filter').disabled);
        assert.match(await page.locator('#bci-action-status').innerText(), /已核实 3 笔已补记使用记录/);
        assert.equal(preview.ledger.usageRecords.size, 3); assert.equal(preview.ledger.charges.size, 2);
        assert.equal(await page.locator('#bci-confirm').isEnabled(), false);
        console.log('lost HTTP response: completed usage and charges recovered from persisted receipts');
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
