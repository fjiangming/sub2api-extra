'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DateTime } = require('luxon');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { startPreview } = require('./supplier-group-preview.cjs');

async function until(page, predicate) { await page.waitForFunction(predicate, null, { timeout: 20000 }); }
async function layout(page) {
  const result = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
    bad: [...document.querySelectorAll('#accounting-groups button,#accounting-groups label,#accounting-groups strong')]
      .filter(n => n.getClientRects().length && !n.closest('.table-wrap') && (n.scrollWidth > n.clientWidth + 2)).map(n => n.textContent) }));
  assert(result.scroll <= result.width + 1, `Page overflow: ${JSON.stringify(result)}`);
  assert.deepEqual(result.bad, []);
}
async function run() {
  const directory = process.env.SUPPLIER_GROUP_SCREENSHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'supplier-group-browser-'));
  fs.mkdirSync(directory, { recursive: true });
  const preview = await startPreview(), fixture = preview.fixture;
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  const outcomes = [];
  try {
    for (const spec of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'wide', width: 1920, height: 1080 },
      { name: 'mobile', width: 390, height: 844 }, { name: 'narrow', width: 320, height: 740 }, { name: 'dark', width: 1280, height: 900, colorScheme: 'dark' }]) {
      const context = await browser.newContext({ viewport: { width: spec.width, height: spec.height }, colorScheme: spec.colorScheme || 'light', reducedMotion: 'reduce' });
      const page = await context.newPage(), errors = [], responses = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('response', async response => {
        if (response.url().includes('/api/cost-analysis/supplier-groups?') && response.ok()) {
          const body = await response.json().catch(() => null); if (body) responses.push(body);
        }
      });
      try {
        fixture.service.configure({ aliases: {}, alert: { enabled: true, amount: 10, percent: 5 } }, 'browser-test');
        await page.goto(`http://127.0.0.1:${preview.port}/preview`);
        await page.locator('[data-tab=groups]').click();
        await until(page, () => document.querySelector('.supplier-group-table tbody tr')?.textContent.includes('Claude'));
        assert.equal(await page.locator('.supplier-group-table tbody tr').count(), 7);
        assert.deepEqual(await page.locator('.supplier-group-provider-heading h2').allTextContents(), ['灵枢 API', 'Nova Relay', 'Zen API']);
        assert.equal(await page.locator('.supplier-group-table').first().locator('thead th').count(), 5);
        assert.deepEqual(await page.locator('.supplier-group-table').first().locator('thead th').allTextContents(),
          ['主站账号账号消费 CNY', '上游供应商分组', '主站合计', '上游分组消费折算 CNY', '差额主站 − 上游']);
        assert.equal(await page.locator('.supplier-group-account').count(), 10);
        assert.match(await page.locator('[data-sg-pending="ling"]').innerText(), /灵枢 API 待核验 Key/);
        assert.equal(await page.locator('.supplier-group-account-name').filter({ hasText: '灵枢 API Claude 主账号' }).count(), 1);
        const account = page.locator('.supplier-group-account').filter({ hasText: '灵枢 API Claude 主账号' });
        assert.equal(await account.locator('.supplier-group-account-amount').innerText(), '23');
        assert.equal(await account.locator('summary').innerText(), '灵枢 API Claude 主账号\n23');
        await account.locator('summary').click();
        assert.match(await account.locator('.supplier-group-account-splits').innerText(), /主站标准\n20\n主站高倍率\n3/);
        const previousAccount = await account.elementHandle();
        await page.locator('[data-sg-date]').dispatchEvent('change');
        await page.waitForFunction(node => !node.isConnected, previousAccount);
        assert.equal(await account.getAttribute('open'), '');
        const firstGroup = page.locator('.supplier-group-table tbody tr').first();
        assert.match(await firstGroup.locator('.supplier-group-main').innerText(), /35$/);
        assert.match(await firstGroup.locator('.supplier-group-upstream').innerText(), /15$/);
        assert.match(await page.locator('.supplier-group-table').first().locator('tfoot').innerText(), /上游已取得 23/);
        assert.equal(await page.locator('.supplier-group-table').first().locator('tfoot td').first().locator('span').last().innerText(), '47');
        assert.doesNotMatch(await page.locator('.supplier-group-table').first().innerText(), /sk-s/);
        assert.equal(await page.locator('#cost-accounting-add').isVisible(), false);
        const allGroups = await page.locator('[data-sg-content]').innerText();
        assert.match(allGroups, /上游偏高/);
        assert.match(allGroups, /有 Key 未关联/);
        const zero = page.locator('.supplier-group-table tbody tr').filter({ hasText: 'Zero' });
        assert.match(await zero.locator('.supplier-group-main').innerText(), /0$/);
        assert.match(await zero.locator('.supplier-group-upstream').innerText(), /0$/);
        await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: path.join(directory, `${spec.name}-groups.png`), fullPage: true }); await layout(page);

        await page.getByRole('button', { name: '查看 Claude 标准 账号与每日明细', exact: true }).click();
        await until(page, () => document.querySelectorAll('#sg-detail-panel .supplier-group-account-table tbody tr').length === 3);
        assert.equal(await page.locator('.supplier-group-account-table tbody tr').count(), 3);
        assert.match(await page.locator('.supplier-group-heading').innerText(), /3 个主站账号 · 3 个主站分组/);
        assert.match(await page.locator('.supplier-group-account-table').innerText(), /主站高倍率/);
        assert.match(await page.locator('.supplier-group-account-table').innerText(), /灵枢 Claude 备用/);
        assert.equal(await page.locator('[data-sg-key]').count(), 0);
        await layout(page); await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: path.join(directory, `${spec.name}-accounts.png`), fullPage: true });
        await page.getByRole('tab', { name: '按主站分组', exact: true }).click();
        await until(page, () => document.querySelector('#sg-detail-panel thead')?.textContent.includes('账号'));
        assert.equal(await page.locator('#sg-detail-panel tbody tr').count(), 3);
        assert.match(await page.locator('#sg-detail-panel tbody').innerText(), /灵枢 API Claude 主账号/);
        await page.getByRole('tab', { name: '每日对比', exact: true }).click();
        await until(page, () => document.querySelector('#sg-detail-panel thead')?.textContent.includes('日期'));
        assert.equal(await page.locator('#sg-detail-panel tbody tr').count(), 7);
        await page.getByRole('button', { name: '返回分组列表', exact: true }).click();
        await until(page, () => Boolean(document.querySelector('.supplier-group-table')));

        await page.getByRole('button', { name: '账号关联核对', exact: true }).click();
        await until(page, () => Boolean(document.querySelector('[data-sg-issues]')));
        assert.equal(await page.locator('.supplier-group-account-table tbody tr').count(), 3);
        await page.locator('[data-sg-issues]').uncheck();
        await until(page, () => document.querySelectorAll('.supplier-group-account-table tbody tr').length === 12);
        await page.locator('[data-sg-proof="11"]').click();
        assert.match(await page.locator('[data-sg-dialog]').innerText(), /名称与完整 Key 指纹交叉核验唯一/);
        await page.locator('[data-sg-close]').click();
        await page.locator('[data-sg-provider]').selectOption('ling');
        await until(page, () => document.querySelectorAll('.supplier-group-account-table tbody tr').length === 5);
        await page.locator('[data-sg-provider]').selectOption('');
        await until(page, () => document.querySelectorAll('.supplier-group-account-table tbody tr').length === 12);

        await page.locator('[data-sg-settings]').click();
        await page.locator('[data-sg-alias-provider]').selectOption('ling'); await page.locator('[data-sg-alias]').fill('灵枢专线\nLS');
        await page.locator('[data-sg-alias-provider]').selectOption('nova'); await page.locator('[data-sg-alias]').fill('NR');
        await page.locator('[data-sg-settings-form] [name=amount]').fill('100');
        await layout(page); await page.screenshot({ path: path.join(directory, `${spec.name}-settings.png`), fullPage: true });
        await page.getByRole('button', { name: '保存设置', exact: true }).click();
        await until(page, () => !document.querySelector('[data-sg-dialog]').open && document.querySelectorAll('.supplier-group-account-table tbody tr').length === 12);
        assert.deepEqual(fixture.store.settings(fixture.service.scope()).aliases.ling, ['灵枢专线', 'LS']);
        assert.deepEqual(fixture.store.settings(fixture.service.scope()).aliases.nova, ['NR']);
        await page.getByRole('button', { name: '返回分组列表', exact: true }).click();
        await until(page, () => document.querySelector('[data-sg-content]')?.textContent.includes('上游高于主站'));
        await page.locator('[data-sg-provider]').selectOption('ling');
        await until(page, () => document.querySelectorAll('.supplier-group-table tbody tr').length === 3);
        assert.equal(await page.locator('.supplier-group-provider').count(), 1);
        assert.match(await page.locator('.supplier-group-table tfoot').innerText(), /上游已取得 23/);
        assert.equal(await page.locator('.supplier-group-table tfoot td').first().locator('span').last().innerText(), '47');
        await page.locator('[data-sg-provider]').selectOption('');
        await until(page, () => document.querySelectorAll('.supplier-group-table tbody tr').length === 7);
        if (spec.name === 'desktop') {
          await page.route('**/api/cost-analysis/supplier-groups?**', route => route.abort());
          await page.locator('[data-sg-date]').dispatchEvent('change');
          await until(page, () => document.querySelector('[data-sg-warning]')?.textContent.includes('稍后自动重试'));
          assert((await page.locator('.supplier-group-diff > span:last-child').allTextContents()).every(text => text === '—'));
          assert((await page.locator('.supplier-group-table tfoot td:last-child > span:last-child').allTextContents()).every(text => text === '—'));
          await page.unroute('**/api/cost-analysis/supplier-groups?**');
          await page.locator('[data-sg-date]').dispatchEvent('change');
          await until(page, () => document.querySelector('[data-sg-warning]')?.hidden);
        }

        const originalKeys = fixture.items[0].keys;
        try {
          fixture.items[0].keys = [];
          await fixture.service.collect(fixture.date);
          await page.locator('[data-sg-date]').dispatchEvent('change');
          await until(page, () => document.querySelector('[data-sg-pending="ling"]')?.textContent.includes('Claude 主账号'));
          const pendingRow = page.locator('[data-sg-pending="ling"]');
          assert.equal(await pendingRow.locator('.supplier-group-account').count(), 5);
          assert.match(await pendingRow.locator('.supplier-group-main').innerText(), /47$/);
          assert.match(await pendingRow.locator('.supplier-group-upstream').innerText(), /—$/);
          await layout(page); await page.evaluate(() => scrollTo(0, 0));
          await page.screenshot({ path: path.join(directory, `${spec.name}-missing-upstream.png`), fullPage: true });
        } finally {
          fixture.items[0].keys = originalKeys;
          await fixture.service.collect(fixture.date);
        }

        const yesterday = DateTime.fromISO(fixture.date).minus({ days: 1 }).toISODate(), calls = fixture.controls.calls.length;
        await page.locator('[data-sg-date]').fill(yesterday); await page.locator('[data-sg-date]').dispatchEvent('change');
        await until(page, () => document.querySelector('[data-sg-meta]')?.textContent.includes('本地归档') && Boolean(document.querySelector('.supplier-group-table')));
        assert.equal(fixture.controls.calls.length, calls);
        await page.locator('[data-sg-date]').fill(DateTime.fromISO(fixture.date).minus({ days: 10 }).toISODate()); await page.locator('[data-sg-date]').dispatchEvent('change');
        await until(page, () => document.querySelector('[data-sg-content]')?.textContent.includes('该日没有分组消费归档'));
        assert.equal(fixture.controls.calls.length, calls);
        await layout(page);
        await page.locator('[data-tab=cash]').click(); await until(page, () => !document.getElementById('accounting-cash').hidden);
        assert.equal(await page.locator('#cost-accounting-add').isVisible(), true);
        assert.deepEqual(errors, []);
        assert(responses.every(r => !JSON.stringify(r).includes(fixture.secrets[0]) && !JSON.stringify(r).includes('upstreamSnapshot')));
        outcomes.push({ viewport: spec.name, passed: true });
      } finally { await context.close(); }
    }
    console.log(JSON.stringify({ outcomes, screenshots: directory }, null, 2));
  } finally { await browser.close(); await preview.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
