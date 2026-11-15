const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { startPreview } = require('./recharge-history-preview.cjs');

async function checkLayout(page) {
  const result = await page.evaluate(() => {
    const dialog = document.querySelector('#provider-dialog');
    const outside = [...dialog.querySelectorAll('label,input,button,select')].filter(node => {
      const rect = node.getBoundingClientRect();
      return rect.width && !node.closest('[hidden]') && (rect.left < 0 || rect.right > innerWidth + 1);
    }).map(node => node.outerHTML);
    return { overflow: document.documentElement.scrollWidth > innerWidth + 1,
      dialogOverflow: dialog.scrollWidth > dialog.clientWidth + 1, outside };
  });
  assert.deepEqual(result, { overflow: false, dialogOverflow: false, outside: [] });
}

async function main() {
  const directory = process.env.RECHARGE_HISTORY_QA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'provider-recharge-history-qa-'));
  fs.mkdirSync(directory, { recursive: true });
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  try {
    for (const [name, viewport, colorScheme] of [
      ['desktop', { width: 1440, height: 1000 }, 'light'],
      ['mobile', { width: 390, height: 844 }, 'light'],
      ['narrow', { width: 320, height: 740 }, 'light'],
      ['dark', { width: 1440, height: 1000 }, 'dark']
    ]) {
      const preview = await startPreview();
      const context = await browser.newContext({ viewport, colorScheme });
      const page = await context.newPage();
      const errors = [], external = [], saved = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => {
        if (/\/api\/providers(?:\/[^/]+)?$/.test(new URL(request.url()).pathname) && ['POST', 'PUT'].includes(request.method())) {
          saved.push(request.postDataJSON());
        }
      });
      await page.route('**/*', route => {
        if (new URL(route.request().url()).hostname !== '127.0.0.1') {
          external.push(route.request().url()); return route.abort();
        }
        return route.continue();
      });
      try {
        await page.goto(`http://127.0.0.1:${preview.port}`);
        await page.locator('#login-form [name=identity]').fill('admin');
        await page.locator('#login-form [name=password]').fill('preview-password');
        await page.locator('#login-form [type=submit]').click();
        await page.waitForSelector('#app-shell:not([hidden])');
        await page.locator('[data-view=providers]').click();
        await page.locator('[data-action=add-provider]').click();
        const form = page.locator('#provider-form');
        const rate = form.locator('[name=rechargeMultiplier]');
        assert.equal(await form.locator('[name=rechargeEffectiveDate]').isDisabled(), true);
        for (const value of ['1', '10', '100', '0.1', '1.000001', '0.000001']) {
          await rate.fill(value);
          assert.equal(await rate.evaluate(node => node.checkValidity()), true, `Invalid rate ${value}`);
        }
        await rate.fill('0');
        assert.equal(await rate.evaluate(node => node.checkValidity()), false);
        await rate.fill('1000001');
        assert.equal(await rate.evaluate(node => node.checkValidity()), false);
        await rate.fill('10');
        assert.equal(await form.locator('[name=rechargeEffectiveDate]').inputValue(), preview.today);
        await form.locator('[name=name]').fill('New rate example');
        await form.locator('[name=baseUrl]').fill('https://new-rate.example');
        await form.locator('[name=enabled]').uncheck();
        const cancel = form.locator('[data-dialog-close]').first();
        await checkLayout(page);
        await page.screenshot({ path: path.join(directory, `${name}-create.png`), fullPage: true });
        await form.locator('[type=submit]').click();
        await page.waitForSelector('#provider-dialog:not([open])', { state: 'attached' });
        assert.deepEqual(saved.at(-1).initialRechargeRate, { multiplier: 10, effectiveDate: preview.today });
        const created = preview.app.locals.services.providers.list().find(provider => provider.name === 'New rate example');
        assert.equal(created.recharge.manualMultiplier, 10);
        const first = preview.db.prepare('SELECT valid_from FROM provider_recharge_rate_history WHERE connection_id=? ORDER BY valid_from LIMIT 1').get(created.id);
        assert.match(first.valid_from, /T16:00:00\.000Z$/);
        await page.locator(`[data-action=edit-provider][data-id="${preview.providerId}"]`).click();
        await page.waitForFunction(() => !document.querySelector('[name=confirmInitialRecharge]').disabled);
        assert.equal(await form.locator('[name=rechargeMultiplier]').inputValue(), '');
        assert.equal(await form.locator('[name=initialRechargeMultiplier]').inputValue(), '10');
        assert.equal(await form.locator('[name=initialRechargeMultiplier]').isDisabled(), true);
        const query = { from: preview.yesterday, to: preview.yesterday, currency: 'CNY', timezone: 'Asia/Shanghai', connectionId: preview.providerId };
        const report = () => preview.app.locals.services.dailyCosts.report(query);
        assert.equal((await report()).items[0].complete, false);
        await form.locator('[name=confirmInitialRecharge]').check();
        assert.equal(await form.locator('[name=initialRechargeDate]').inputValue(), preview.yesterday);
        await checkLayout(page);
        await page.screenshot({ path: path.join(directory, `${name}-backfill.png`), fullPage: true });
        await form.locator('[type=submit]').click();
        await page.waitForSelector('#provider-dialog:not([open])', { state: 'attached' });
        assert.deepEqual(saved.at(-1).initialRechargeRate, { multiplier: 10, effectiveDate: preview.yesterday });
        assert.equal(saved.at(-1).rechargeMultiplier, null);
        assert.equal((await report()).items[0].cost, 10);
        await page.reload();
        await page.locator('[data-view=providers]').click();
        const edit = page.locator(`[data-action=edit-provider][data-id="${preview.providerId}"]`);
        await edit.click();
        await page.waitForFunction(() => !document.querySelector('[name=confirmInitialRecharge]').disabled);
        assert.equal(await form.locator('[name=confirmInitialRecharge]').isChecked(), false);
        await form.locator('[name=confirmInitialRecharge]').check();
        await form.locator('[name=initialRechargeMultiplier]').fill('20');
        await form.locator('[type=submit]').click();
        await page.waitForFunction(() => document.querySelector('#provider-form-error').textContent.includes('\u5df2\u786e\u8ba4'));
        assert.equal((await report()).items[0].cost, 10);
        await cancel.click();
        await edit.click();
        await page.waitForFunction(() => !document.querySelector('[name=confirmInitialRecharge]').disabled);
        await form.locator('[name=rechargeMultiplier]').fill('20');
        await form.locator('[type=submit]').click();
        await page.waitForSelector('#provider-dialog:not([open])', { state: 'attached' });
        assert.equal(Object.hasOwn(saved.at(-1), 'initialRechargeRate'), false);
        assert.equal((await report()).items[0].cost, 10);
        assert.equal(preview.app.locals.services.providers.get(preview.providerId).recharge.manualMultiplier, 20);
        await page.route('**/recharge-history', async route => { await new Promise(resolve => setTimeout(resolve, 300)); await route.continue(); });
        await edit.click();
        await cancel.click();
        await page.locator('[data-action=add-provider]').click();
        await page.waitForTimeout(400);
        assert.equal(await form.locator('[name=id]').inputValue(), '');
        assert.equal(await page.locator('#initial-recharge-history').isVisible(), false);
        assert.deepEqual(errors, []);
        assert.deepEqual(external, []);
        console.log(`${name}: integer/decimal validity, creation, backfill, persistence, conflict rollback, future rates and stale responses passed`);
      } catch (error) {
        await page.screenshot({ path: path.join(directory, `${name}-failure.png`), fullPage: true });
        throw error;
      } finally { await context.close(); await preview.close(); }
    }
    console.log(`Screenshots: ${directory}`);
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
