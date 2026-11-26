'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DateTime } = require('luxon');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { startPreview } = require('./supplier-group-preview.cjs');
const { keyIdentity } = require('../src/services/supplier-group-source');

async function until(page, predicate, argument) { await page.waitForFunction(predicate, argument, { timeout: 20000 }); }
async function openDay(page, date) {
  await page.locator('[data-metric=profit]').click();
  await page.locator(`[data-dialog] [data-day="${date}"]`).click();
}
async function openGroups(page, provider = 'ling') {
  await page.locator(`[data-provider-groups="${provider}"]`).click();
  await page.locator('[data-provider-group-content="groups"]').waitFor();
}
async function layout(page) {
  const result = await page.locator('[data-dialog]').evaluate(dialog => {
    const bounds = dialog.getBoundingClientRect();
    const nodes = [...dialog.querySelectorAll('button,summary,.cost-provider-group-totals dd,.cost-provider-group-table td')].filter(node => node.getClientRects().length && !node.closest('.table-wrap'));
    return { overflow: dialog.scrollWidth > dialog.clientWidth + 1,
      clipped: nodes.filter(node => { const box = node.getBoundingClientRect(); return box.right > bounds.right + 1 || box.left < bounds.left - 1 || node.scrollWidth > node.clientWidth + 2; }).map(node => node.textContent),
      overlapping: [...dialog.querySelectorAll('.cost-provider-actions')].some(row => {
        const [a, b] = [...row.children].map(node => node.getBoundingClientRect());
        return Math.min(a.right, b.right) > Math.max(a.left, b.left) + 1 && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top) + 1;
      }) };
  });
  assert.equal(result.overflow, false); assert.deepEqual(result.clipped, []); assert.equal(result.overlapping, false);
}
async function subtotals(page, fixture, directory, name) {
  const original = structuredClone(fixture.items[0]);
  try {
    Object.assign(fixture.items[0], { complete: false, accountCovered: false });
    Object.assign(fixture.items[0].keys[1], { cost: null, upstreamAmount: null, requests: null, complete: false });
    await fixture.service.collect(fixture.date);
    await openDay(page, fixture.date); await openGroups(page);
    const group = page.locator('[data-provider-group-row]').filter({ hasText: 'Claude 标准' });
    assert.match(await group.locator('td').nth(3).innerText(), /12[\s\S]*已知小计/);
    assert.match(await page.locator('.cost-provider-group-table tfoot').innerText(), /20[\s\S]*已知小计/);
    assert.equal(await page.locator('[data-provider-main-total]').innerText(), '47');
    assert.match(await page.locator('.cost-provider-group-totals').innerText(), /供应商当日消费[\s\S]*23/);
    await layout(page); await page.screenshot({ path: path.join(directory, `${name}-known-subtotal.png`), fullPage: true });
    await page.locator('[data-close]').click();
    Object.assign(fixture.items[0], structuredClone(original), { accountCovered: false, archiveConflict: true });
    await fixture.service.collect(fixture.date);
    await openDay(page, fixture.date); await openGroups(page);
    assert.match(await group.innerText(), /历史归档冲突/);
    assert.match(await group.locator('td').nth(3).innerText(), /15[\s\S]*已知小计/);
    await layout(page); await page.locator('[data-close]').click();
    fixture.items[0].keys.forEach(key => Object.assign(key, { cost: null, upstreamAmount: null, requests: null, complete: false }));
    await fixture.service.collect(fixture.date);
    await openDay(page, fixture.date); await openGroups(page);
    assert.match(await group.locator('td').nth(3).innerText(), /暂不可用$/);
    assert.equal(await page.locator('.cost-provider-group-table .supplier-group-subtotal').count(), 0);
    await page.locator('[data-close]').click();
  } finally {
    Object.assign(fixture.items[0], original); delete fixture.items[0].archiveConflict;
    await fixture.service.collect(fixture.date);
  }
}
async function pagination(page, fixture) {
  const originalKeys = [...fixture.items[0].keys];
  try {
    for (const [from, to, index] of [[100, 121, 0], [300, 321, 9]]) await fixture.database.query(`INSERT INTO accounts
      SELECT n,'灵枢 API 扩展账号 ' || n,'active',$1::jsonb,'2026-01-01T00:00:00Z',NULL FROM generate_series($2::int,$3::int) n`,
    [JSON.stringify({ api_key: fixture.secrets[index] }), from, to]);
    for (let n = 200; n < 220; n++) {
      const secret = `sk-synthetic-extra-provider-group-${n}`;
      fixture.items[0].keys.push({ ...originalKeys[0], id: `extra-${n}`, groupRef: `extra-${n}`, groupName: `额外分组 ${n}`,
        identity: keyIdentity(secret), cost: 0, upstreamAmount: 0, requests: 0 });
      await fixture.database.query("INSERT INTO accounts VALUES($1,$2,'active',$3::jsonb,'2026-01-01T00:00:00Z',NULL)",
        [n, `灵枢 API 额外账号 ${n}`, JSON.stringify({ api_key: secret })]);
    }
    await fixture.service.collect(fixture.date);
    await openDay(page, fixture.date); await openGroups(page);
    assert.match(await page.locator('[data-provider-group-page]').innerText(), /1 \/ 2/);
    assert.equal(await page.locator('[data-provider-group-row]').count(), 20);
    assert.equal(await page.locator('[data-provider-main-total]').innerText(), '47');
    assert.match(await page.locator('.cost-provider-group-table tfoot').innerText(), /47[\s\S]*23/);
    const group = page.locator('[data-provider-group-row]').filter({ hasText: 'Claude 标准' });
    assert.equal(await group.locator('[data-provider-group-account]').count(), 10);
    await group.locator('[data-provider-group]').click();
    await page.locator('[data-provider-group-content="accounts"]').waitFor();
    assert.equal(await page.locator('[data-provider-group-account]').count(), 20);
    assert.match(await page.locator('[data-provider-group-page]').innerText(), /1 \/ 2[\s\S]*25/);
    await page.locator('[data-provider-group-step="1"]').click();
    await until(page, () => document.querySelector('[data-provider-group-page]')?.textContent.includes('2 / 2'));
    assert.equal(await page.locator('[data-provider-group-account]').count(), 5);
    await page.locator('[data-provider-group-back]').click();
    await page.locator('[data-provider-group-content="groups"]').waitFor();
    await page.locator('[data-provider-group-step="1"]').click();
    await until(page, () => document.querySelector('[data-provider-group-page]')?.textContent.includes('2 / 2'));
    assert.equal(await page.locator('[data-provider-group-row]').count(), 2);
    assert.equal(await page.locator('.cost-provider-pending [data-provider-group-account]').count(), 10);
    await page.locator('[data-provider-group-pending]').click();
    await page.locator('[data-provider-group-content="pending"]').waitFor();
    assert.equal(await page.locator('[data-provider-group-account]').count(), 20);
    await page.locator('[data-provider-group-step="1"]').click();
    await until(page, () => document.querySelector('[data-provider-group-page]')?.textContent.includes('2 / 2'));
    assert.equal(await page.locator('[data-provider-group-account]').count(), 3);
    await page.keyboard.press('Escape');
    assert.match(await page.locator('[data-provider-group-page]').innerText(), /2 \/ 2/);
    await page.locator('[data-close]').click();
  } finally {
    fixture.items[0].keys = originalKeys;
    await fixture.database.exec('DELETE FROM accounts WHERE id>=100');
    await fixture.service.collect(fixture.date);
  }
}
async function run() {
  const directory = process.env.PROVIDER_GROUP_SCREENSHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'provider-group-browser-'));
  fs.mkdirSync(directory, { recursive: true });
  const preview = await startPreview(), fixture = preview.fixture;
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  const outcomes = [];
  try {
    for (const [name, width, height, colorScheme] of [['desktop', 1440, 1000, 'light'], ['embedded', 1060, 900, 'light'],
      ['mobile', 390, 844, 'light'], ['narrow', 320, 740, 'light'], ['dark', 1280, 900, 'dark']]) {
      const context = await browser.newContext({ viewport: { width, height }, colorScheme, reducedMotion: 'reduce' });
      const page = await context.newPage(), errors = [], queries = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => { if (new URL(request.url()).pathname === '/api/cost-analysis/supplier-groups') queries.push(new URL(request.url()).searchParams); });
      try {
        await page.goto(`http://127.0.0.1:${preview.port}/preview`);
        await until(page, () => accountingUi.state.report?.automatic && accountingUi.state.report.items.some(row => row.providers?.length));
        await openDay(page, fixture.date);
        assert.equal(await page.locator('[data-provider-groups]').count(), 3);
        await page.evaluate(() => document.getElementById('toast-region').replaceChildren());
        await layout(page); await page.screenshot({ path: path.join(directory, `${name}-daily.png`), fullPage: true });
        await openGroups(page);
        assert.equal(await page.locator('[data-dialog]').evaluate(dialog => Math.round(dialog.getBoundingClientRect().width)), Math.min(width, 920));
        assert.equal(await page.locator('[data-dialog]').count(), 1);
        assert.deepEqual(await page.locator('.cost-provider-group-table thead th').allTextContents(),
          ['主站对应账号及消费', '上游供应商分组', '主站消费合计', '供应商分组消费']);
        assert.equal(await page.locator('[data-provider-main-total]').innerText(), '47');
        assert.match(await page.locator('.cost-provider-group-totals').innerText(), /供应商当日消费[\s\S]*23/);
        const claude = page.locator('[data-provider-group-row]').filter({ hasText: 'Claude 标准' });
        assert.equal(await claude.locator('[data-provider-group-account]').count(), 3);
        assert.equal(await claude.locator('td').nth(2).locator('span').last().innerText(), '35');
        assert.equal(await claude.locator('td').nth(3).locator('span').last().innerText(), '15');
        const account = page.locator('[data-provider-group-account$=":11"]');
        await account.locator('summary').click();
        assert.match(await account.locator('.supplier-group-account-splits').innerText(), /主站标准[\s\S]*20[\s\S]*主站高倍率[\s\S]*3/);
        await layout(page); await page.screenshot({ path: path.join(directory, `${name}-groups.png`), fullPage: true });
        await page.keyboard.press('Escape');
        assert.match(await page.locator('[data-open-day]').getAttribute('data-open-day'), new RegExp(fixture.date));
        await openGroups(page);
        assert.equal(await page.locator('[data-provider-group-account$=":11"]').getAttribute('open'), '');
        await page.locator('[data-provider-group-back]').click(); await openGroups(page, 'zen');
        const zero = page.locator('[data-provider-group-row]').filter({ hasText: 'Zero' });
        assert.equal(await zero.locator('td').nth(3).locator('span').last().innerText(), '0');
        assert.match(await page.locator('.cost-provider-group-totals').innerText(), /暂不可用/);
        await layout(page);
        await page.locator('[data-close]').click();
        const yesterday = DateTime.fromISO(fixture.date).minus({ days: 1 }).toISODate(), calls = fixture.controls.calls.length;
        await openDay(page, yesterday); await openGroups(page);
        assert.equal(fixture.controls.calls.length, calls);
        assert.match(await page.locator('.cost-provider-group-meta').innerText(), /历史归档/);
        await page.locator('[data-close]').click();
        const missing = DateTime.fromISO(fixture.date).minus({ days: 10 }).toISODate();
        await openDay(page, missing); await openGroups(page);
        assert.match(await page.locator('[data-drawer]').innerText(), /暂无分组消费归档/);
        assert.equal(await page.locator('[data-provider-main-total]').innerText(), '暂不可用');
        assert.equal(fixture.controls.calls.length, calls);
        await layout(page); await page.locator('[data-close]').click();
        await subtotals(page, fixture, directory, name);
        if (name === 'desktop') {
          await pagination(page, fixture);
          await openDay(page, fixture.date);
          const failing = route => route.fulfill({ status: 503, json: { error: { message: 'Synthetic group outage' } } });
          await page.route('**/api/cost-analysis/supplier-groups?*', failing);
          await page.locator('[data-provider-groups="ling"]').click();
          await page.locator('[data-provider-group-retry]').waitFor();
          assert.match(await page.locator('[data-drawer]').innerText(), /Synthetic group outage/);
          await page.unroute('**/api/cost-analysis/supplier-groups?*', failing);
          await page.locator('[data-provider-group-retry]').click(); await page.locator('[data-provider-group-content="groups"]').waitFor();
          await page.locator('[data-provider-group-back]').click();
          let release, started, finished;
          const gate = new Promise(resolve => { release = resolve; }), intercepted = new Promise(resolve => { started = resolve; }), done = new Promise(resolve => { finished = resolve; });
          const slow = async route => {
            started(); await gate;
            try { await route.fulfill({ status: 503, json: { error: { message: 'Superseded group response' } } }); } catch { /* The read was cancelled on return. */ }
            finally { finished(); }
          };
          await page.route('**/api/cost-analysis/supplier-groups?*', slow);
          try {
            await page.locator('[data-provider-groups="ling"]').click(); await intercepted;
            await page.locator('[data-provider-group-back]').click();
            release(); await done;
            assert.equal(await page.locator('[data-provider-group-content]').count(), 0);
            assert.match(await page.locator('[data-open-day]').innerText(), /供应商账号消费/);
          } finally { release(); await page.unroute('**/api/cost-analysis/supplier-groups?*', slow); }
          await page.locator('[data-close]').click();
        }
        assert.deepEqual(errors, []);
        assert(queries.every(query => query.has('date') && query.has('providerId') && !query.has('refresh')));
        outcomes.push({ viewport: name, passed: true });
        console.log(`${name}: provider group details passed`);
      } finally { await context.close(); }
    }
    console.log(JSON.stringify({ outcomes, screenshots: directory }, null, 2));
  } finally { await browser.close(); await preview.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
