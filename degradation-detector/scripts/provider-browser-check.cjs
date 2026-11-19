'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createPreview } = require('./provider-preview.cjs');
let playwright;
try { playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright'); }
catch { playwright = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }

async function main() {
  let preview = await createPreview(0);
  const menuServer = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html><body style="margin:0"><iframe id="detector" src="${preview.baseUrl}/results?demo=readonly" style="width:100%;height:900px;border:0" title="检测结果"></iframe></body></html>`);
  });
  await new Promise(resolve => menuServer.listen(0, '127.0.0.1', resolve));
  const menuUrl = `http://127.0.0.1:${menuServer.address().port}`;
  let browser;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sub2api-provider-browser-'));
  const errors = [];
  const external = [];
  const watch = page => {
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/^https?:/.test(request.url()) && ![preview.baseUrl, menuUrl].some(base => request.url().startsWith(base + '/'))) external.push(request.url()); });
  };
  const fit = async page => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'page must fit viewport');
  const shot = (page, name) => page.screenshot({ path: path.join(directory, `${name}.png`), fullPage: true });
  const save = async page => {
    const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/provider-config' && response.request().method() === 'PUT');
    await page.locator('#pc-save').click();
    const result = await response;
    assert.equal(result.status(), 200, await result.text());
    await page.waitForFunction(() => document.getElementById('pc-save-label').textContent === '保存三方配置');
    return result.json();
  };
  try {
    browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
    for (const layout of [{ name: 'desktop', width: 1440, dark: false }, { name: 'mobile', width: 390, dark: false }, { name: 'narrow', width: 320, dark: false }, { name: 'dark', width: 1440, dark: true }]) {
      if (layout.name !== 'desktop') { await preview.close(); preview = await createPreview(0); }
      const context = await browser.newContext({ viewport: { width: layout.width, height: 900 }, colorScheme: layout.dark ? 'dark' : 'light', locale: 'zh-CN' });
      const page = await context.newPage(); watch(page);
      await page.goto(`${preview.baseUrl}/results?demo=readonly`);
      await page.locator('.p-card').first().waitFor();
      assert.equal(await page.locator('.p-card').count(), 3);
      assert.equal(await page.locator('.p-card').first().locator('.p-bar').count(), 24);
      assert.equal(await page.locator('.p-bar.passed').first().evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(53, 184, 135)');
      await fit(page); await shot(page, `${layout.name}-candy`);
      await page.locator('#p-search').fill('官Key');
      assert.equal(await page.locator('.p-card').count(), 1);
      await page.locator('#p-search').fill('');
      await page.locator('#p-status').selectOption('failed');
      assert.equal(await page.locator('.p-card').count(), 0);
      await page.locator('#p-status').selectOption('');
      const pelicanResponse = page.waitForResponse(response => response.url().includes('/api/provider-results?channel=pelican'));
      await page.locator('[data-channel="pelican"]').click();
      await pelicanResponse;
      await page.locator('.p-card button[data-group="8"]').last().click();
      await page.locator('.p-artwork').waitFor();
      await page.frameLocator('.p-artwork').locator('svg').waitFor();
      assert.equal(await page.locator('.p-artwork').getAttribute('sandbox'), 'allow-scripts');
      await page.locator('.p-history-detail summary').filter({ hasText: '作品源码' }).click();
      assert.match(await page.locator('.p-history-detail').innerText(), /<!doctype html>/);
      await fit(page); await shot(page, `${layout.name}-pelican-detail`);
      await page.locator('[data-history-close]').click();
      await page.locator('[data-provider="testllm"]').click();
      await page.locator('.p-table tbody tr').first().waitFor();
      assert.equal(await page.locator('.p-table tbody tr').count(), 2);
      assert.match(await page.locator('.p-table').first().innerText(), /极高智商/);
      await fit(page); await shot(page, `${layout.name}-testllm`);
      await page.locator('.p-table').first().getByRole('button', { name: '24小时检测记录' }).click();
      await page.locator('.p-history-detail summary').first().waitFor();
      assert.equal(await page.locator('.p-history-list [data-run-id]').count(), 24);
      assert.match(await page.locator('.p-history-detail').innerText(), /首字耗时：未取得/);
      await fit(page); await shot(page, `${layout.name}-testllm-detail`);
      if (layout.name === 'desktop') {
        preview.runtime.store.db.prepare("UPDATE degradation_provider_groups SET enabled=0 WHERE group_id='8' AND channel='testllm'").run();
        await page.evaluate(() => document.getElementById('refresh-button').click());
        await page.waitForFunction(() => !document.querySelector('.p-history').open);
        assert.equal(await page.locator('.p-history-detail').innerText(), '');
        preview.runtime.store.db.prepare("UPDATE degradation_provider_groups SET enabled=1 WHERE group_id='8' AND channel='testllm'").run();
      } else await page.locator('[data-history-close]').click();
      const denied = await page.evaluate(async () => {
        const targets = ['/admin/config', '/admin/provider-config.js', '/api/admin/provider-config'];
        return Promise.all(targets.map(url => fetch(url).then(response => response.status)));
      });
      assert.deepEqual(denied, [403, 403, 403]);
      await context.close();

      const adminContext = await browser.newContext({ viewport: { width: layout.width, height: 900 }, colorScheme: layout.dark ? 'dark' : 'light', locale: 'zh-CN' });
      const admin = await adminContext.newPage(); watch(admin);
      await admin.goto(`${preview.baseUrl}/admin/config?demo=1`);
      await admin.locator('#pc-connection-form').waitFor();
      assert.equal(await admin.locator('#legacy-config').evaluate(element => element.open), false);
      for (const channel of ['candy', 'pelican']) {
        await admin.locator(`[data-pc-channel="${channel}"]`).click();
        const form = admin.locator('#pc-connection-form');
        const preset = form.locator('[name="reasoning_effort_preset"]');
        const custom = form.locator('[name="reasoning_effort"]');
        assert.deepEqual(await preset.locator('option').evaluateAll(options => options.map(option => option.value)), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'custom']);
        await preset.selectOption('ultra');
        assert.equal(await custom.inputValue(), 'ultra');
        assert.equal(await custom.isVisible(), false);
        const selected = await save(admin);
        assert.equal(selected.channels[channel].defaults.reasoning_effort, 'ultra');
        await preset.selectOption('custom');
        assert.equal(await custom.isVisible(), true);
        await custom.fill('');
        assert.equal(await form.evaluate(element => element.checkValidity()), false);
        const effort = `manual-${channel}-${layout.name}`;
        await custom.fill(effort);
        const saved = await save(admin);
        assert.equal(saved.channels[channel].defaults.reasoning_effort, effort);
        await admin.reload(); await admin.locator('#pc-connection-form').waitFor();
        await admin.locator(`[data-pc-channel="${channel}"]`).click();
        assert.equal(await preset.inputValue(), 'custom');
        assert.equal(await custom.inputValue(), effort);
        await fit(admin); await shot(admin, `${layout.name}-admin-${channel}-effort`);
      }
      await admin.locator('[data-pc-view="groups"]').click();
      await admin.locator('[data-pc-edit="8"]').click();
      const pelicanModal = admin.locator('#pc-group-dialog');
      await pelicanModal.locator('[name="override_enabled"]').check();
      await pelicanModal.locator('[name="reasoning_effort_preset"]').selectOption('custom');
      await pelicanModal.locator('[name="reasoning_effort"]').fill(`group-pelican-${layout.name}`);
      await pelicanModal.getByRole('button', { name: '应用配置' }).click();
      const pelicanConfig = await save(admin);
      assert.equal(pelicanConfig.groups.find(group => group.id === '8').configurations.pelican.override.reasoning_effort, `group-pelican-${layout.name}`);
      await admin.locator('[data-pc-edit="8"]').click();
      assert.equal(await pelicanModal.locator('[name="reasoning_effort_preset"]').inputValue(), 'custom');
      assert.equal(await pelicanModal.locator('[name="reasoning_effort"]').inputValue(), `group-pelican-${layout.name}`);
      await pelicanModal.locator('[name="reasoning_effort"]').focus();
      await fit(admin); await shot(admin, `${layout.name}-admin-pelican-group-effort`);
      await admin.locator('#pc-group-cancel').click();
      await admin.locator('[data-pc-channel="candy"]').click();
      await admin.locator('[data-pc-view="connection"]').click();
      await fit(admin); await shot(admin, `${layout.name}-admin-connection`);
      if (layout.name === 'desktop') {
        await admin.locator('#pc-connection-form [name="model"]').fill('gpt-candy-browser');
        let result = await save(admin);
        assert.equal(result.channels.candy.defaults.model, 'gpt-candy-browser');
        await admin.reload(); await admin.locator('#pc-connection-form').waitFor();
        assert.equal(await admin.locator('#pc-connection-form [name="model"]').inputValue(), 'gpt-candy-browser');
      }
      await admin.locator('[data-pc-view="groups"]').click();
      await admin.locator('[data-pc-edit="8"]').click();
      const modal = admin.locator('#pc-group-dialog');
      await modal.locator('[name="override_enabled"]').check();
      await modal.locator('[name="reasoning_effort_preset"]').selectOption('custom');
      await modal.locator('[name="reasoning_effort"]').fill(`group-candy-${layout.name}`);
      await modal.locator('[name="key"]').focus();
      assert(await modal.locator('[name="key"]').evaluate(input => {
        const bounds = input.getBoundingClientRect();
        const footer = input.closest('form').querySelector('footer').getBoundingClientRect();
        const body = input.closest('.pc-modal-body').getBoundingClientRect();
        return bounds.top >= body.top && bounds.bottom <= Math.min(body.bottom, footer.top);
      }), 'key field must remain above footer');
      await fit(admin); await shot(admin, `${layout.name}-admin-group`);
      if (layout.name === 'desktop') {
        await modal.locator('[name="model"]').fill('gpt-group-browser');
        await modal.locator('[name="key"]').fill('sk-browser-dedicated-key-8-123456');
        await modal.getByRole('button', { name: '应用配置' }).click();
        let result = await save(admin);
        const value = result.groups.find(group => group.id === '8').configurations.candy;
        assert.equal(value.override.model, 'gpt-group-browser');
        assert.equal(value.override.reasoning_effort, 'group-candy-desktop');
        assert.equal(value.key_configured, true);
        assert.doesNotMatch(JSON.stringify(result), /sk-browser/);
        assert.equal(await admin.evaluate(() => JSON.stringify(localStorage).includes('sk-browser')), false);
        const before = preview.runtime.providerStore.counts('8', 'candy').total;
        await admin.locator('[data-pc-run="8"]').click();
        await admin.waitForFunction(() => document.querySelector('[data-pc-run="8"]').closest('tr').innerText.includes('通过 / 正常'));
        assert.equal(preview.runtime.providerStore.counts('8', 'candy').total, before + 1);
        const actualRun = preview.runtime.providerStore.run(preview.runtime.providerStore.history('8', 'candy', Number.MAX_SAFE_INTEGER, 1)[0].id);
        assert.equal(JSON.parse(actualRun.snapshot_json).reasoning_effort, 'group-candy-desktop');
        assert.equal(preview.runtime.providerStore.counts('2', 'candy').total, 28);
        await admin.locator('[data-pc-view="schedule"]').click();
        const candyPlan = admin.locator('[data-pc-plan="candy"]');
        await candyPlan.locator('input[value="interval"]').check();
        await admin.locator('[data-pc-plan="candy"] [name="interval_minutes"]').fill('120');
        result = await save(admin);
        assert.equal(result.channels.candy.schedule.mode, 'interval');
        assert.equal(result.channels.candy.schedule.interval_minutes, 120);
        assert.equal(result.channels.pelican.schedule.mode, 'daily');
      } else await admin.locator('#pc-group-cancel').click();
      await admin.locator('[data-pc-view="schedule"]').click();
      await fit(admin); await shot(admin, `${layout.name}-admin-schedule`);
      await admin.locator('[data-pc-provider="testllm"]').click();
      await admin.locator('[data-pc-view="connection"]').click();
      assert.equal(await admin.locator('#pc-connection-form [name="model_source"]').inputValue(), 'group');
      assert.equal(await admin.locator('#pc-connection-form [name="cache_test"]').isChecked(), true);
      await fit(admin); await shot(admin, `${layout.name}-admin-testllm`);
      await admin.locator('#legacy-config > summary').click();
      await admin.locator('.platform-panel:not([hidden])').waitFor();
      assert.equal(await admin.locator('#save-button').isVisible(), true);
      await adminContext.close();
      assert.equal(preview.outboundCalls, 0); assert.equal(preview.providerCalls, 0);
    }
    const embeddedContext = await browser.newContext({ viewport: { width: 1440, height: 950 }, locale: 'zh-CN' });
    const embedded = await embeddedContext.newPage(); watch(embedded);
    await embedded.goto(menuUrl);
    const detector = embedded.frameLocator('#detector');
    await detector.locator('[data-channel="pelican"]').click();
    await detector.locator('.p-card button[data-group="8"]').last().click();
    await detector.frameLocator('.p-artwork').locator('svg').waitFor();
    assert.match(await detector.locator('.p-artwork').getAttribute('src'), /signature=/);
    await shot(embedded, 'desktop-embedded-pelican');
    await embeddedContext.close();
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    assert.equal(preview.outboundCalls, 0); assert.equal(preview.providerCalls, 0);
    console.log(JSON.stringify({ ok: true, layouts: ['1440', '390', '320', 'dark'], errors, external, directory }, null, 2));
  } finally { await browser?.close(); menuServer.closeAllConnections?.(); await new Promise(resolve => menuServer.close(resolve)); await preview.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
