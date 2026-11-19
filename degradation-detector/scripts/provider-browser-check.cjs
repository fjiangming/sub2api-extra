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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sub2api-provider-browser-'));
  const errors = [], external = [];
  const watch = page => {
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/^https?:/.test(request.url()) && ![preview.baseUrl, menuUrl].some(base => request.url().startsWith(base + '/'))) external.push(request.url()); });
  };
  const fit = async page => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'page must fit viewport');
  const shot = (page, name) => page.screenshot({ path: path.join(directory, `${name}.png`), fullPage: true });
  const save = async page => {
    const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/provider-config' && response.request().method() === 'PUT');
    await page.locator('#pc-save').click(); const result = await response;
    assert.equal(result.status(), 200, await result.text());
    await page.waitForFunction(() => document.getElementById('pc-save-label').textContent === '保存三方配置');
    return result.json();
  };
  const scope = (data, provider, id) => data.provider_platforms.find(value => value.provider === provider && value.id === id);
  const run = async (page, provider, platform, group = '8') => {
    const suffix = group ? `/groups/${group}/runs` : '/runs';
    const response = page.waitForResponse(response => new URL(response.url()).pathname === `/api/admin/provider-platforms/${provider}/${platform}${suffix}` && response.request().method() === 'POST');
    await page.locator(group ? `[data-pc-run="${group}"]` : '[data-pc-batch]').click();
    const result = await response; assert.equal(result.status(), 202, await result.text());
    const data = await result.json();
    await page.waitForFunction(() => document.querySelector('[data-pc-batch]') && !document.querySelector('[data-pc-batch]').disabled);
    return data.runs;
  };
  let browser;
  try {
    browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
    for (const layout of [{ name: 'desktop', width: 1440, dark: false }, { name: 'mobile', width: 390, dark: false }, { name: 'narrow', width: 320, dark: false }, { name: 'dark', width: 1440, dark: true }]) {
      if (layout.name !== 'desktop') { await preview.close(); preview = await createPreview(0); }
      const options = { viewport: { width: layout.width, height: 900 }, colorScheme: layout.dark ? 'dark' : 'light', locale: 'zh-CN' };
      const reader = await browser.newContext(options); const page = await reader.newPage(); watch(page);
      await page.goto(`${preview.baseUrl}/results?demo=readonly`); await page.locator('.p-card').first().waitFor();
      assert.equal(await page.locator('.p-card').count(), 3); assert.equal(await page.locator('.p-card').first().locator('.p-bar').count(), 24);
      assert.equal(await page.locator('.p-bar.passed').first().evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(53, 184, 135)');
      await fit(page); await shot(page, `${layout.name}-candy`);
      await page.locator('#p-search').fill('官Key'); assert.equal(await page.locator('.p-card').count(), 1); await page.locator('#p-search').fill('');
      await page.locator('#p-status').selectOption('failed'); assert.equal(await page.locator('.p-card').count(), 0); await page.locator('#p-status').selectOption('');
      await page.locator('[data-channel="pelican"]').click(); await page.locator('.p-card button[data-group="8"]').last().click();
      await page.frameLocator('.p-artwork').locator('svg').waitFor();
      assert.equal(await page.locator('.p-artwork').getAttribute('sandbox'), 'allow-scripts');
      await page.locator('.p-history-detail summary').filter({ hasText: '作品源码' }).click(); assert.match(await page.locator('.p-history-detail').innerText(), /<!doctype html>/);
      await fit(page); await shot(page, `${layout.name}-pelican-detail`); await page.locator('[data-history-close]').click();
      await page.locator('[data-provider="testllm"]').click(); await page.locator('.p-table tbody tr').first().waitFor();
      assert.equal(await page.locator('.p-table tbody tr').count(), 2); assert.match(await page.locator('.p-table').first().innerText(), /极高智商/);
      await fit(page); await shot(page, `${layout.name}-testllm`);
      await page.locator('.p-table').first().getByRole('button', { name: '24小时检测记录' }).click(); await page.locator('.p-history-detail summary').first().waitFor();
      assert.equal(await page.locator('.p-history-list [data-run-id]').count(), 24); assert.match(await page.locator('.p-history-detail').innerText(), /首字耗时：未取得/);
      await shot(page, `${layout.name}-testllm-detail`);
      if (layout.name === 'desktop') {
        preview.runtime.store.db.prepare("UPDATE degradation_provider_groups SET enabled=0 WHERE group_id='8' AND channel='testllm'").run();
        await page.evaluate(() => document.getElementById('refresh-button').click()); await page.waitForFunction(() => !document.querySelector('.p-history').open);
        assert.equal(await page.locator('.p-history-detail').innerText(), '');
        preview.runtime.store.db.prepare("UPDATE degradation_provider_groups SET enabled=1 WHERE group_id='8' AND channel='testllm'").run();
      } else await page.locator('[data-history-close]').click();
      const denied = await page.evaluate(async () => Promise.all(['/admin/config', '/admin/provider-config.js', '/api/admin/provider-config'].map(url => fetch(url).then(response => response.status))));
      assert.deepEqual(denied, [403, 403, 403]); await reader.close();

      const adminContext = await browser.newContext(options); const admin = await adminContext.newPage(); watch(admin);
      await admin.goto(`${preview.baseUrl}/admin/config?demo=1`); await admin.locator('#pc-platform-form').waitFor();
      assert.equal(await admin.locator('#legacy-config').evaluate(element => element.open), false);
      assert.equal(await admin.locator('[data-pc-provider]').count(), 2); assert.equal(await admin.locator('#pc-provider-form [name="api_url"]').count(), 1);
      assert.equal(await admin.locator('[data-pc-platform]').count(), 4);
      const form = admin.locator('#pc-platform-form'); const modal = admin.locator('#pc-group-dialog'); const store = preview.runtime.providerStore;
      assert.equal(await form.locator('[name="protocol"]').count(), 0); assert.equal(await form.locator('[name="cache_test"]').count(), 0);
      const originalKeys = store.groups().map(value => value.key_cipher);
      let result = await save(admin);
      assert.equal(result.provider_platforms.length, 6); assert.deepEqual(store.groups().filter(value => value.key_cipher).map(value => value.key_cipher), originalKeys);
      await fit(admin); await shot(admin, `${layout.name}-admin-manxue`);
      const testKey = store.group('8', 'testllm').key_cipher, claudeKey = store.group('2', 'candy').key_cipher;
      const historical = store.history('8', 'candy')[0]; const oldSnapshot = store.run(historical.id).snapshot_json;
      await form.locator('[name="model"]').fill(`shared-gpt-${layout.name}`);
      await form.locator('[name="target_url"]').fill('https://gpt-relay.example.com/v1');
      assert.deepEqual(await form.locator('[name="reasoning_effort_preset"] option').evaluateAll(options => options.map(option => option.value)), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'custom']);
      await form.locator('[name="reasoning_effort_preset"]').selectOption('ultra');
      await admin.locator('[data-pc-edit="8"]').click();
      await modal.locator('[name="parameter_mode"][value="override"]').check();
      await modal.locator('[name="model"]').fill(`group-gpt-${layout.name}`);
      await modal.locator('[name="target_url"]').fill('https://group-relay.example.com/v1');
      await modal.locator('[name="reasoning_effort_preset"]').selectOption('custom');
      await modal.locator('[name="reasoning_effort"]').fill('group-custom-effort');
      await modal.locator('[name="timeout_seconds"]').fill('123');
      await modal.getByText('分组独立检测计划', { exact: true }).click();
      const groupPlan = modal.locator('[data-pc-group-plan="candy"]');
      await groupPlan.locator('[name="independent_schedule"]').check();
      await groupPlan.locator('[value="interval"]').check(); await groupPlan.locator('[data-plan-interval]').fill('45');
      await modal.locator('[name="key"]').fill(`sk-browser-manxue-${layout.name}`);
      await modal.locator('[name="clear_key"]').check(); await modal.getByRole('button', { name: '应用配置' }).click();
      assert.match(await modal.locator('#pc-group-error').innerText(), /不能同时/); await modal.locator('[name="clear_key"]').uncheck();
      await modal.locator('[name="key"]').focus();
      assert(await modal.evaluate(dialog => { const bounds = dialog.getBoundingClientRect(); return bounds.top >= 0 && bounds.bottom <= innerHeight; }), 'drawer must remain inside the viewport');
      assert(await modal.locator('[name="key"]').evaluate(input => { const bounds = input.getBoundingClientRect(); const body = input.closest('.pc-modal-body').getBoundingClientRect(); const footer = input.closest('form').querySelector('footer').getBoundingClientRect(); return bounds.top >= body.top && bounds.bottom <= Math.min(body.bottom, footer.top); }));
      await fit(admin); await shot(admin, `${layout.name}-admin-group`); await modal.getByRole('button', { name: '应用配置' }).click();
      result = await save(admin);
      assert.equal(scope(result, 'manxue', 'openai').params.reasoning_effort, 'ultra');
      for (const channel of ['candy', 'pelican']) { const value = store.group('8', channel); assert.equal(JSON.parse(value.override_json).model, `group-gpt-${layout.name}`); assert.equal(store.effective(value).timeout_seconds, 123); }
      assert.equal(store.schedule(store.group('8', 'candy')).interval_minutes, 45);
      assert.equal(store.group('8', 'candy').key_fingerprint, store.group('8', 'pelican').key_fingerprint);
      assert.equal(store.group('8', 'testllm').key_cipher, testKey); assert.equal(store.group('2', 'candy').key_cipher, claudeKey);
      assert.doesNotMatch(JSON.stringify(result), /sk-browser|key_cipher|key_fingerprint|key_context/);
      assert.equal(await admin.evaluate(() => /sk-browser/.test(JSON.stringify(localStorage) + JSON.stringify(sessionStorage))), false);
      await admin.reload(); await admin.locator('#pc-platform-form').waitFor();
      await admin.locator('[data-pc-edit="8"]').click(); assert.equal(await modal.locator('[name="key"]').inputValue(), '');
      assert.equal(await modal.locator('[name="model"]').inputValue(), `group-gpt-${layout.name}`);
      await modal.locator('[name="parameter_mode"][value="individual"]').check();
      await modal.locator('[name="model"]').fill(`candy-gpt-${layout.name}`);
      await modal.locator('[data-pc-group-channel="pelican"]').click(); await modal.locator('[name="model"]').fill(`pelican-gpt-${layout.name}`);
      await modal.locator('[data-pc-group-channel="candy"]').click(); assert.equal(await modal.locator('[name="model"]').inputValue(), `candy-gpt-${layout.name}`);
      await modal.getByRole('button', { name: '应用配置' }).click();
      const retained = ['candy', 'pelican'].map(channel => store.group('8', channel).key_cipher);
      await form.locator('[name="reasoning_effort_preset"]').selectOption('custom'); await form.locator('[name="reasoning_effort"]').fill('');
      assert.equal(await form.evaluate(element => element.checkValidity()), false);
      await form.locator('[name="reasoning_effort"]').fill(`shared-custom-${layout.name}`);
      await form.locator('[name="target_url"]').fill('https://changed-relay.example.com/v1');
      await admin.locator('#pc-provider-form [name="api_url"]').fill('https://changed-manxue.example.com/tests');
      result = await save(admin);
      assert.deepEqual(['candy', 'pelican'].map(channel => store.group('8', channel).key_cipher), retained);
      assert.equal(store.effective(store.group('8', 'candy')).model, `candy-gpt-${layout.name}`);
      let runs = await run(admin, 'manxue', 'openai'); assert.deepEqual(runs.map(value => value.channel), ['candy', 'pelican']);
      for (const value of runs) { const snapshot = JSON.parse(store.run(value.id).snapshot_json); assert.equal(snapshot.model, `${value.channel}-gpt-${layout.name}`); assert.equal(snapshot.reasoning_effort, 'group-custom-effort'); assert.equal(snapshot.target_url, 'https://group-relay.example.com/v1'); assert.equal(snapshot.api_url, 'https://changed-manxue.example.com/tests'); }
      assert.equal(store.run(historical.id).snapshot_json, oldSnapshot);
      await admin.locator('[data-pc-edit="8"]').click();
      await modal.locator('[name="parameter_mode"][value="inherit"]').check(); await modal.locator('[name="pelican"]').uncheck();
      await modal.getByText('分组独立检测计划', { exact: true }).click(); await groupPlan.locator('[name="independent_schedule"]').uncheck();
      await modal.getByRole('button', { name: '应用配置' }).click(); result = await save(admin);
      assert.equal(store.group('8', 'candy').override_json, null); assert.equal(store.effective(store.group('8', 'candy')).reasoning_effort, `shared-custom-${layout.name}`);
      assert.equal(store.group('8', 'pelican').enabled, 0);
      assert.equal(store.schedule(store.group('8', 'candy')).mode, 'daily');
      runs = await run(admin, 'manxue', 'openai'); assert.deepEqual(runs.map(value => value.channel), ['candy']);
      const otherBefore = store.counts('2', 'candy').total; runs = await run(admin, 'manxue', 'openai', null);
      assert.deepEqual(runs.map(value => value.group_id), ['8']); assert.equal(store.counts('2', 'candy').total, otherBefore);
      await admin.locator('#pc-history-channel').selectOption('candy'); await admin.locator('[data-pc-history="8"]').click();
      await admin.locator('.p-history-detail summary').first().waitFor(); await admin.locator('[data-history-close]').click();
      await admin.locator('[data-pc-enabled="8"]').uncheck(); await admin.locator('[data-pc-enabled="8"]').check();
      await admin.locator('[data-pc-platform="anthropic"]').click();
      await form.locator('[name="model"]').fill(`claude-manxue-${layout.name}`); await form.locator('[name="target_url"]').fill('https://claude-relay.example.com/v1');
      await form.locator('[name="reasoning_effort_preset"]').selectOption('high'); result = await save(admin);
      assert.equal(scope(result, 'manxue', 'openai').params.model, `shared-gpt-${layout.name}`);
      assert.equal(store.group('2', 'candy').key_cipher, claudeKey); await fit(admin); await shot(admin, `${layout.name}-admin-claude`);
      await admin.locator('[data-pc-provider="testllm"]').click(); await admin.locator('[data-pc-platform="openai"]').click();
      assert.equal(await admin.locator('[data-pc-platform="gemini"]').count(), 0); assert.equal(await form.locator('[name="reasoning_effort_preset"]').count(), 0);
      assert.equal(await form.locator('[name="service_tier"]').count(), 0); assert.equal(await form.locator('[name="protocol"]').inputValue(), 'gpt');
      await form.locator('[name="model"]').fill(`testllm-gpt-${layout.name}`); await form.locator('[name="target_url"]').fill('https://iq-relay.example.com/v1');
      await form.locator('[name="cache_test"]').uncheck(); await form.locator('[name="thinking_test"]').uncheck();
      await admin.locator('#pc-provider-form [name="api_url"]').fill('https://changed-testllm.example.com');
      await admin.locator('[data-pc-edit="8"]').click(); assert.equal(await modal.locator('[name="reasoning_effort_preset"]').count(), 0);
      await modal.locator('[name="key"]').fill(`sk-browser-testllm-${layout.name}`); await modal.getByRole('button', { name: '应用配置' }).click(); result = await save(admin);
      assert.equal(scope(result, 'testllm', 'openai').params.model, `testllm-gpt-${layout.name}`);
      assert.equal(store.effective(store.group('8', 'candy')).model, `shared-gpt-${layout.name}`); assert.equal(store.group('8', 'candy').key_cipher, retained[0]);
      runs = await run(admin, 'testllm', 'openai'); assert.deepEqual(runs.map(value => value.channel), ['testllm']);
      const iq = JSON.parse(store.run(runs[0].id).snapshot_json); assert.equal(iq.reasoning_effort, undefined); assert.equal(iq.cache_test, false); assert.equal(iq.thinking_test, false); assert.equal(iq.model, `testllm-gpt-${layout.name}`);
      await fit(admin); await shot(admin, `${layout.name}-admin-testllm`);
      await admin.locator('[data-pc-platform="anthropic"]').click(); assert.equal(await form.locator('[name="protocol"]').inputValue(), 'claude');
      await form.locator('.pc-advanced > summary').click(); await form.locator('[value="interval"]').check();
      await form.locator('[data-plan-interval]').fill('120'); result = await save(admin);
      assert.equal(scope(result, 'testllm', 'anthropic').schedule.interval_minutes, 120);
      assert.equal(scope(result, 'testllm', 'openai').schedule.mode, 'daily'); assert.equal(scope(result, 'manxue', 'anthropic').schedule.mode, 'daily');
      await admin.locator('[data-pc-provider="manxue"]').click(); await admin.locator('[data-pc-platform="gemini"]').click();
      await form.locator('.pc-advanced > summary').click(); await form.locator('[data-pc-add-time]').click(); await form.locator('[data-pc-add-time]').click();
      assert.equal(await form.locator('[data-plan-time]').count(), 4); result = await save(admin);
      assert.equal(scope(result, 'manxue', 'gemini').schedule.times.length, 4); await fit(admin); await shot(admin, `${layout.name}-admin-plan`);
      await admin.reload(); await admin.locator('#pc-platform-form').waitFor(); await admin.locator('[data-pc-provider="testllm"]').click();
      await admin.locator('[data-pc-platform="openai"]').click(); assert.equal(await form.locator('[name="model"]').inputValue(), `testllm-gpt-${layout.name}`);
      assert.equal(await admin.evaluate(() => /sk-browser/.test(JSON.stringify(localStorage) + JSON.stringify(sessionStorage))), false);
      await admin.locator('#legacy-config > summary').click(); await admin.locator('.platform-panel:not([hidden])').waitFor(); assert.equal(await admin.locator('#save-button').isVisible(), true);
      await adminContext.close(); assert.equal(preview.outboundCalls, 0); assert.equal(preview.providerCalls, 0);
      console.log(`Passed provider UI: ${layout.name}`);
    }
    const embeddedContext = await browser.newContext({ viewport: { width: 1440, height: 950 }, locale: 'zh-CN' });
    const embedded = await embeddedContext.newPage(); watch(embedded); await embedded.goto(menuUrl);
    const detector = embedded.frameLocator('#detector'); await detector.locator('[data-channel="pelican"]').click();
    await detector.locator('.p-card button[data-group="2"]').last().click(); await detector.frameLocator('.p-artwork').locator('svg').waitFor();
    assert.match(await detector.locator('.p-artwork').getAttribute('src'), /signature=/); await shot(embedded, 'desktop-embedded-pelican'); await embeddedContext.close();
    assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(preview.outboundCalls, 0); assert.equal(preview.providerCalls, 0);
    console.log(JSON.stringify({ ok: true, layouts: ['1440', '390', '320', 'dark'], errors, external, directory }, null, 2));
  } catch (error) { console.error(`Provider browser screenshots: ${directory}`); throw error; }
  finally { await browser?.close(); menuServer.closeAllConnections?.(); await new Promise(resolve => menuServer.close(resolve)); await preview.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
