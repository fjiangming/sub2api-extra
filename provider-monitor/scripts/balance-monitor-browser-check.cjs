const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { startPreview } = require('./balance-monitor-preview.cjs');

async function checkLayout(page) {
  const problems = await page.evaluate(() => {
    const overflow = document.documentElement.scrollWidth > innerWidth + 1;
    const controls = [...document.querySelectorAll('button, input, select, .provider-meta strong')]
      .filter((node) => node.getBoundingClientRect().width && !node.closest('.module-tabs, .table-wrap'))
      .filter((node) => node.getBoundingClientRect().right > innerWidth + 1 ||
        (node.matches('.provider-meta strong') && node.scrollWidth > node.clientWidth + 1))
      .map((node) => node.outerHTML);
    return { overflow, controls };
  });
  assert.equal(problems.overflow, false);
  assert.deepEqual(problems.controls, []);
}

async function main() {
  const directory = process.env.BALANCE_QA_DIR || path.join(os.tmpdir(), 'provider-balance-qa');
  fs.mkdirSync(directory, { recursive: true });
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  try {
    for (const [name, viewport] of [
      ['desktop', { width: 1440, height: 1000 }],
      ['mobile', { width: 390, height: 844 }],
      ['narrow', { width: 320, height: 740 }]
    ]) {
      const preview = await startPreview();
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      try {
        const base = `http://127.0.0.1:${preview.port}`;
        await page.goto(base);
        await page.locator('#login-form [name=identity]').fill('admin');
        await page.locator('#login-form [name=password]').fill('preview-password');
        await page.locator('#login-form [type=submit]').click();
        await page.waitForSelector('#app-shell:not([hidden])');
        await page.locator('[data-view=providers]').click();
        await page.waitForSelector('.provider-item');
        assert.equal(await page.locator('.provider-item').count(), 3);
        const supplier = page.locator('.provider-item').filter({ hasText: '示例供应商 A' });
        assert.match(await supplier.innerText(), /余额检查\s*1 分钟/);
        assert.match(await supplier.innerText(), /资产同步\s*15 分钟/);
        await checkLayout(page);
        await page.screenshot({ path: path.join(directory, `${name}-providers.png`), fullPage: true });
        await supplier.locator('[data-action=edit-provider]').click();
        const form = page.locator('#provider-form');
        assert.equal(await form.locator('[name=balanceRefreshIntervalMinutes]').inputValue(), '1');
        assert.equal(await form.locator('[name=refreshIntervalMinutes]').inputValue(), '15');
        await form.locator('[name=balanceRefreshIntervalMinutes]').fill('0');
        assert.equal(await form.locator('[name=balanceRefreshIntervalMinutes]').evaluate((node) => node.checkValidity()), false);
        await form.locator('[name=balanceRefreshIntervalMinutes]').fill('2');
        await form.locator('[name=refreshIntervalMinutes]').fill('45');
        await checkLayout(page);
        await page.screenshot({ path: path.join(directory, `${name}-intervals.png`) });
        await form.locator('button[type=submit]').click();
        await page.waitForSelector('#provider-dialog:not([open])', { state: 'attached' });
        await page.waitForFunction(() => [...document.querySelectorAll('.provider-item')]
          .some((item) => item.textContent.includes('示例供应商 A') && item.textContent.includes('2 分钟')));
        const saved = preview.app.locals.services.providers.list().find((item) => item.name === '示例供应商 A');
        assert.equal(saved.balance_refresh_interval_minutes, 2);
        assert.equal(saved.refresh_interval_minutes, 45);
        await page.reload();
        await page.waitForSelector('#app-shell:not([hidden])');
        await page.locator('[data-view=providers]').click();
        await page.waitForSelector('.provider-item');
        await supplier.locator('[data-action=edit-provider]').click();
        assert.equal(await form.locator('[name=balanceRefreshIntervalMinutes]').inputValue(), '2');
        assert.equal(await form.locator('[name=refreshIntervalMinutes]').inputValue(), '45');
        await form.locator('[data-dialog-close]').first().click();
        preview.amounts.set('supplier-a.example.test', 12);
        const callStart = preview.calls.length;
        await Promise.all([
          page.waitForResponse((response) => response.url().endsWith('/balance/refresh') && response.status() === 200),
          supplier.locator('[data-action=refresh-balance]').click()
        ]);
        assert.equal(preview.app.locals.services.queries.summary().accounts.find((item) => item.name === '示例供应商 A').available, 12);
        assert(preview.calls.slice(callStart).every((url) => url === '/balance'));
        await page.locator('[data-view=overview]').click();
        await page.waitForSelector('[data-action=refresh-balance]');
        assert.match(await page.locator('#main-content').innerText(), /12/);
        await checkLayout(page);
        await page.screenshot({ path: path.join(directory, `${name}-balance.png`), fullPage: true });
        assert.deepEqual(errors, []);
        console.log(`${name}: interval editing, persistence, direct balance refresh and layout passed`);
      } finally {
        await context.close();
        await preview.close();
      }
    }
    console.log(`Screenshots: ${directory}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
