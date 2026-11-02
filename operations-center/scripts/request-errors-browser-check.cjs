'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { startPreview } = require('./request-errors-preview.cjs');
const { AppError } = require('../src/errors');

async function main() {
  const directory = process.env.REQUEST_ERRORS_QA_DIR || path.join(os.tmpdir(), 'sub2api-request-errors-qa'); fs.mkdirSync(directory, { recursive: true });
  const preview = await startPreview({ port: 0 });
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    for (const [name, width, height, colorScheme] of [['desktop', 1440, 1000, 'light'], ['wide', 1024, 900, 'light'], ['mobile', 390, 844, 'light'], ['narrow', 320, 740, 'light'], ['dark', 1024, 900, 'dark']]) {
      const context = await browser.newContext({ viewport: { width, height }, colorScheme });
      try {
        const page = await context.newPage(), errors = [];
        page.on('pageerror', e => errors.push(e.message));
        const waitLoad = async action => { const result = page.waitForResponse(r => r.url().includes('/api/request-errors/report?') && r.ok()); await action(); await result; await page.waitForFunction(() => document.getElementById('ra-status').hidden && !document.getElementById('ra-data').hidden); };
        await page.goto(`http://127.0.0.1:${preview.port}/preview`);
        await page.locator('#ra-data').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#ra-filter [name=start]').inputValue(), preview.fixture.today);
        assert.equal(await page.locator('#ra-filter [name=end]').inputValue(), preview.fixture.today);
        assert.equal(await page.locator('#ra-presets [data-preset=today]').getAttribute('aria-pressed'), 'true');
        assert.equal(await page.locator('#ra-panel tbody tr').count(), 12);
        assert.match(await page.locator('#ra-metrics').innerText(), /300/);
        const checkLayout = async () => {
          const result = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1,
            metrics: [...document.querySelectorAll('.ra-metric')].some(n => n.scrollWidth > n.clientWidth + 1),
            controls: [...document.querySelectorAll('#view-errors button,#view-errors input,#view-errors select')].filter(n => n.getBoundingClientRect().width && !n.closest('.table-wrap,dialog')).filter(n => n.getBoundingClientRect().right > innerWidth + 1).map(n => n.outerHTML) }));
          assert.equal(result.overflow, false); assert.equal(result.metrics, false); assert.deepEqual(result.controls, []);
        };
        await checkLayout(); await page.screenshot({ path: path.join(directory, `${name}-types.png`), fullPage: true });
        const share = await page.locator('#ra-panel tbody tr').first().locator('td').nth(3).innerText();
        await waitLoad(() => page.locator('#ra-local [name=failureType]').selectOption('connect_timeout'));
        assert.equal(await page.locator('#ra-panel tbody tr').count(), 1);
        assert.equal(await page.locator('#ra-panel tbody tr').first().locator('td').nth(3).innerText(), share);
        await waitLoad(() => page.locator('[data-type=connect_timeout][data-target-view=groups]').click());
        await page.locator('[data-expand]').first().click();
        assert(await page.locator('[data-key]').count() > 0);
        await page.screenshot({ path: path.join(directory, `${name}-keys.png`), fullPage: true });
        await waitLoad(() => page.locator('[data-key]').first().click());
        assert.equal(await page.locator('#ra-local [name=failureType]').inputValue(), 'connect_timeout');
        await page.locator('[data-request]').first().click(); await page.locator('#ra-dialog[open]').waitFor();
        assert.match(await page.locator('#ra-dialog-body').innerText(), /HTTP 504/);
        await page.locator('#ra-close').click();
        await waitLoad(() => page.locator('#ra-clear').click());
        await waitLoad(() => page.locator('[data-view=users]#ra-tab-users').click());
        assert.equal(await page.locator('#ra-panel tbody tr').count(), 20);
        await waitLoad(() => page.locator('#ra-pagination [data-page="1"]').click());
        assert.equal(await page.locator('#ra-panel tbody tr').count(), 5);
        await waitLoad(() => page.locator('#ra-local [name=search]').fill('用户 25').then(() => page.locator('#ra-local [type=submit]').click()));
        assert.equal(await page.locator('#ra-panel tbody tr').count(), 1);
        await waitLoad(() => page.locator('[data-user="25"]').click());
        assert.equal(await page.locator('#ra-panel tbody tr').count(), 12);
        await waitLoad(() => page.locator('#ra-clear').click());
        await waitLoad(() => page.locator('#ra-local [name=outcome]').selectOption('stream'));
        await waitLoad(() => page.locator('#ra-tab-requests').click());
        await waitLoad(() => page.locator('#ra-local [name=failureType]').selectOption('stream_truncated'));
        await page.locator('[data-request]').first().click(); await page.locator('#ra-dialog[open]').waitFor();
        assert.match(await page.locator('#ra-dialog-body').innerText(), /提前断流 · 无错误事件/);
        assert.match(await page.locator('#ra-dialog-body').innerText(), /HTTP 200/);
        await page.screenshot({ path: path.join(directory, `${name}-stream.png`) });
        await page.locator('#ra-close').click();
        await waitLoad(() => page.locator('#ra-local [name=outcome]').selectOption('recovered'));
        await page.locator('[data-request]').first().click(); await page.locator('#ra-dialog[open]').waitFor();
        assert.match(await page.locator('#ra-dialog-body').innerText(), /完整响应及正常结束/); await page.locator('#ra-close').click();
        await waitLoad(() => page.locator('[data-unlinked]').click());
        assert.equal(await page.locator('#ra-panel tbody tr').count(), 1); assert.match(await page.locator('#ra-panel').innerText(), /待关联记录/);
        await waitLoad(() => page.locator('#ra-clear').click());
        await page.locator('#ra-comparison summary').click();
        await waitLoad(() => page.locator('#ra-matrix [data-result=recovered]').first().click());
        assert.equal(await page.locator('#ra-local [name=outcome]').inputValue(), 'recovered');
        await waitLoad(() => page.locator('#ra-presets [data-preset=week]').click());
        assert.equal(await page.locator('#ra-days tbody tr').count(), 7);
        await waitLoad(() => page.locator('#ra-presets [data-preset=today]').click());
        const original = preview.fixture.service.source.read;
        preview.fixture.service.cache.clear(); preview.fixture.service.source.read = async () => { throw new AppError('SOURCE_UNAVAILABLE', '示例错误来源不可用', { status: 503 }); };
        await page.locator('#refresh-button').click(); await page.waitForFunction(() => !document.getElementById('ra-status').hidden && document.getElementById('ra-data').hidden);
        preview.fixture.service.source.read = original;
        await waitLoad(() => page.locator('#refresh-button').click());
        await checkLayout(); assert.deepEqual(errors, []);
        assert.equal(await page.locator('#ra-panel img').count(), 0, 'untrusted usernames cannot create markup');
        console.log(JSON.stringify({ name, width, status: 'passed' }));
      } finally { await context.close(); }
    }
  } finally { await browser?.close(); await preview.stop(); }
  console.log(`Screenshots: ${directory}`);
}
main().catch(e => { console.error(e); process.exitCode = 1; });
