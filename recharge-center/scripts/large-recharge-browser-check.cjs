'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { startPreview } = require('./large-recharge-preview.cjs');

async function openAdmin(page) {
  await page.locator('#admin-tab').click();
  await page.waitForFunction(() => !document.getElementById('large-recharge-fields').disabled);
}

async function save(page, expectedStatus = 200) {
  const response = page.waitForResponse(res => res.url().endsWith('/api/admin/large-recharge-alert') && res.request().method() === 'PUT');
  await page.locator('#large-recharge-save').click();
  const result = await response;
  assert.equal(result.status(), expectedStatus);
  if (expectedStatus === 401) await page.waitForSelector('#login-view');
  else await page.waitForFunction(() => !document.getElementById('large-recharge-fields').disabled);
  return result.json();
}

async function main() {
  const directory = process.env.RECHARGE_QA_DIR || path.join(os.tmpdir(), 'sub2api-large-recharge-qa');
  fs.mkdirSync(directory, { recursive: true });
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  try {
    for (const [name, viewport, colorScheme] of [
      ['desktop', { width: 1440, height: 1000 }, 'light'], ['mobile', { width: 390, height: 844 }, 'light'],
      ['narrow', { width: 320, height: 740 }, 'light'], ['dark', { width: 1440, height: 1000 }, 'dark']
    ]) {
      const preview = await startPreview();
      const context = await browser.newContext({ viewport, colorScheme });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      try {
        await page.goto(`${preview.base}/preview`);
        await openAdmin(page);
        assert.equal(await page.locator('#large-recharge-enabled').isChecked(), false);
        assert.equal(await page.locator('#large-recharge-threshold').inputValue(), '1000.00');
        assert.equal(await page.locator('#large-recharge-test').isDisabled(), true);
        await page.locator('#large-recharge-enabled').check();
        await page.locator('#large-recharge-threshold').fill('800');
        await page.locator('#large-recharge-device-key').fill('example-device-key-for-preview');
        const settings = await save(page);
        assert.equal(settings.threshold, '800.00');
        assert.equal(JSON.stringify(settings).includes('example-device-key'), false);
        assert.equal(await page.locator('#large-recharge-device-key').inputValue(), '');
        assert.equal(await page.locator('#large-recharge-test').isEnabled(), true);

        const testResponse = page.waitForResponse(res => res.url().endsWith('/large-recharge-alert/test'));
        await page.locator('#large-recharge-test').click();
        assert.equal((await testResponse).status(), 200);
        await page.waitForFunction(() => document.getElementById('large-recharge-status').textContent === '测试提醒已发送');
        assert.equal(preview.controls.barkMessages.length, 1);
        await page.locator('#large-recharge-threshold').fill('900');
        assert.equal(await page.locator('#large-recharge-test').isDisabled(), true);
        const refresh = page.waitForResponse(res => new URL(res.url()).pathname === '/api/admin/orders');
        await page.locator('#refresh-admin').click();
        await refresh;
        assert.equal(await page.locator('#large-recharge-threshold').inputValue(), '900');
        await save(page);
        await page.reload();
        await openAdmin(page);
        assert.equal(await page.locator('#large-recharge-threshold').inputValue(), '900.00');
        assert.equal(await page.locator('#large-recharge-device-key').inputValue(), '');
        assert.equal(await page.locator('#large-recharge-enabled').isChecked(), true);
        await page.locator('#large-recharge-threshold').fill('1.001');
        await save(page, 400);
        assert.equal(await page.locator('#large-recharge-error').isVisible(), true);
        assert.equal(preview.largeRechargeAlerts.settings().threshold, '900.00');
        await page.locator('#large-recharge-threshold').fill('900');
        await save(page);
        await page.waitForFunction(() => document.querySelectorAll('#toast-region .toast').length === 0);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: path.join(directory, `${name}.png`), fullPage: true });
        const layout = await page.evaluate(() => ({
          overflow: document.documentElement.scrollWidth > innerWidth,
          outside: [...document.querySelectorAll('.large-recharge-settings input, .large-recharge-settings button')]
            .filter(node => node.getBoundingClientRect().width > 0)
            .filter(node => node.getBoundingClientRect().right > innerWidth + 1 || node.getBoundingClientRect().left < -1)
            .map(node => node.id)
        }));
        assert.deepEqual(layout, { overflow: false, outside: [] });
        assert.deepEqual(errors, []);
        await page.locator('#large-recharge-enabled').uncheck();
        await page.locator('#large-recharge-clear-key').check();
        await save(page);
        assert.equal(preview.largeRechargeAlerts.settings().bark.configured, false);
        assert.equal(await page.locator('#large-recharge-test').isDisabled(), true);
        if (name === 'desktop') {
          await page.locator('#large-recharge-device-key').fill('expired-session-device-key');
          await context.clearCookies();
          await save(page, 401);
          await page.waitForSelector('#login-view');
          assert.equal(await page.locator('#large-recharge-device-key').inputValue(), '');
          assert.equal(await page.locator('#large-recharge-save').evaluate(node => node.disabled), false);
          await context.request.get(`${preview.base}/preview`, {
            headers: { 'user-agent': await page.evaluate(() => navigator.userAgent) }
          });
          await page.evaluate(() => bootstrap());
          await openAdmin(page);
          assert.equal(await page.locator('#large-recharge-save').isEnabled(), true);
          assert.equal(preview.largeRechargeAlerts.settings().bark.configured, false);
        }
        await page.locator('#large-recharge-device-key').fill('unsaved-device-key-in-browser');
        await page.locator('#logout-button').click();
        await page.waitForSelector('#login-view');
        assert.equal(await page.locator('#large-recharge-device-key').inputValue(), '');
        await page.goto(`${preview.base}/preview?role=user`);
        await page.waitForSelector('#app-view');
        assert.equal(await page.locator('#admin-tab').isVisible(), false);
        assert.equal(await page.locator('.large-recharge-settings').isVisible(), false);
        const denied = await page.evaluate(async () => (await fetch('/api/admin/large-recharge-alert')).status);
        assert.equal(denied, 403);
        console.log(`${name}: admin save/test, persistence, validation, user isolation and layout passed`);
      } catch (error) {
        await page.screenshot({ path: path.join(directory, `${name}-failure.png`), fullPage: true }).catch(() => {});
        throw error;
      } finally { await context.close(); await preview.close(); }
    }
  } finally { await browser.close(); }
  console.log(`Screenshots: ${directory}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
