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
        assert.equal(await page.locator('.supplier-group-table tbody tr').count(), 6);
        assert.equal(await page.locator('#cost-accounting-add').isVisible(), false);
        assert.match(await page.locator('.supplier-group-table').innerText(), /上游偏高/);
        assert.match(await page.locator('.supplier-group-table').innerText(), /零消费/);
        assert.match(await page.locator('.supplier-group-table').innerText(), /有 Key 未关联/);
        await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: path.join(directory, `${spec.name}-groups.png`), fullPage: true }); await layout(page);

        await page.getByRole('button', { name: 'Claude 标准', exact: true }).click();
        await until(page, () => document.querySelector('[data-sg-key]')?.value === 'k1');
        assert.equal(await page.locator('.supplier-group-account-table tbody tr').count(), 2);
        assert.match(await page.locator('.supplier-group-heading').innerText(), /2 个 Key → 3 个账号 → 3 个主站分组/);
        assert.match(await page.locator('.supplier-group-account-table').innerText(), /主站高倍率/);
        await layout(page); await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: path.join(directory, `${spec.name}-accounts.png`), fullPage: true });
        await page.locator('[data-sg-key]').selectOption('k2');
        await until(page, () => document.querySelector('.supplier-group-account-table tbody')?.textContent.includes('高倍率'));
        assert.equal(await page.locator('.supplier-group-account-table tbody tr').count(), 1);
        await page.getByRole('tab', { name: '按主站分组', exact: true }).click();
        await until(page, () => document.querySelector('#sg-detail-panel thead')?.textContent.includes('账号'));
        assert.equal(await page.locator('#sg-detail-panel tbody tr').count(), 3);
        await page.getByRole('tab', { name: '每日对比', exact: true }).click();
        await until(page, () => document.querySelector('#sg-detail-panel thead')?.textContent.includes('日期'));
        assert.equal(await page.locator('#sg-detail-panel tbody tr').count(), 7);
        await page.getByRole('button', { name: '返回分组列表', exact: true }).click();
        await until(page, () => Boolean(document.querySelector('.supplier-group-table')));

        await page.getByRole('tab', { name: /账号关联核对/ }).click();
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
        await page.getByRole('tab', { name: '分组对比', exact: true }).click();
        await until(page, () => document.querySelector('.supplier-group-table')?.textContent.includes('上游高于主站'));

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
