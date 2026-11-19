'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPreview } = require('./preview.cjs');
let playwright;
try { playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright'); }
catch { playwright = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }

const read = page => page.evaluate(() => JSON.parse(localStorage.getItem('sub2api-provider-hierarchy-demo-v1')));
async function main() {
  const preview = await createPreview(0);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sub2api-provider-hierarchy-'));
  const errors = []; const external = []; const writes = [];
  const executablePath = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(candidate => candidate && fs.existsSync(candidate));
  let browser;
  try {
    assert.equal((await fetch(preview.url + '/api/admin/provider-config', { method: 'PUT', body: '{}' })).status, 405);
    assert.equal((await fetch(preview.url + '/api/admin/provider-config')).status, 404);
    browser = await playwright.chromium.launch({ ...(executablePath ? { executablePath } : { channel: 'chrome' }), headless: true });
    for (const layout of [
      { name: 'desktop', width: 1440, height: 1000, colorScheme: 'light' },
      { name: 'mobile', width: 390, height: 844, colorScheme: 'light' },
      { name: 'narrow', width: 320, height: 780, colorScheme: 'light' },
      { name: 'dark', width: 1440, height: 1000, colorScheme: 'dark' }
    ]) {
      const context = await browser.newContext({ viewport: { width: layout.width, height: layout.height }, colorScheme: layout.colorScheme, locale: 'zh-CN', reducedMotion: 'reduce' });
      await context.route('**/*', route => {
        const request = route.request();
        if (!['GET', 'HEAD'].includes(request.method())) writes.push(request.url());
        if (!/^https?:/.test(request.url()) || request.url().startsWith(preview.url + '/')) return route.continue();
        external.push(request.url()); return route.abort();
      });
      const page = await context.newPage(); page.setDefaultTimeout(12000);
      page.on('pageerror', error => errors.push(`${layout.name}: ${error.message}`));
      const fit = async () => {
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${layout.name}: page overflow`);
        if (await page.locator('dialog[open]').count()) assert(await page.locator('dialog[open]').evaluate(element => element.scrollWidth <= element.clientWidth), 'dialog overflow');
      };
      const shot = async name => {
        await fit();
        await page.locator('#toast').waitFor({ state: 'hidden' });
        await page.screenshot({ path: path.join(directory, `${layout.name}-${name}.png`), fullPage: (await page.locator('dialog[open]').count()) === 0 });
      };
      const save = async () => {
        await page.locator('[data-save]').click();
        assert.equal(await page.locator('#save-state').innerText(), '配置已保存');
        return read(page);
      };
      const provider = id => page.locator(`[data-provider-tab="${id}"]`).click();
      const ai = id => page.locator(`[data-ai-tab="${id}"]`).click();
      const shared = page.locator('#shared-form'); const group = page.locator('#group-form');
      const edit = id => page.locator(`[data-edit-group="${id}"]`).click();
      const apply = () => group.getByRole('button', { name: '应用到分组' }).click();
      await page.goto(preview.url + '/admin/config');
      assert.equal(await page.locator('[data-provider-tab]').count(), 2);
      assert.equal(await page.locator('[data-ai-tab]').count(), 3);
      assert.equal(await page.locator('#provider-form [name="api_url"]').count(), 1);
      assert.equal(await page.locator('[data-group-row]').count(), 3);
      assert.equal(await shared.locator('[name="protocol"],[name="cache_test"],[name="thinking_test"]').count(), 0);
      assert.deepEqual(await shared.locator('[name="reasoning_effort_preset"] option').evaluateAll(options => options.map(option => option.value)), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'custom']);
      await shot('manxue-chatgpt');
      await save();
      await shared.locator('[name="model"]').fill(`gpt-shared-${layout.name}`);
      await shared.locator('[name="reasoning_effort_preset"]').selectOption('ultra');
      assert.equal(await shared.locator('[name="reasoning_effort"]').inputValue(), 'ultra');
      await shared.locator('[name="reasoning_effort_preset"]').selectOption('custom');
      await shared.locator('[name="reasoning_effort"]').fill('');
      assert.equal(await shared.evaluate(form => form.checkValidity()), false);
      await shared.locator('[name="reasoning_effort"]').fill(`manual-${layout.name}`);
      await shared.locator('[name="target_url"]').fill('http://unsafe.example.com/v1');
      await page.locator('[data-save]').click();
      assert.match(await page.locator('#page-error').innerText(), /HTTPS/);
      assert.equal((await read(page)).providers.manxue.platforms.openai.params.model, 'gpt-6-astra');
      await shared.locator('[name="target_url"]').fill('https://changed-gateway.example.com/v1');
      await page.locator('#provider-form [name="api_url"]').fill('https://changed-manxue.example.com/tests');
      let saved = await save();
      assert.equal(saved.providers.manxue.platforms.openai.params.model, `gpt-shared-${layout.name}`);
      assert.equal(saved.providers.manxue.platforms.openai.params.reasoning_effort, `manual-${layout.name}`);
      assert(saved.providers.manxue.platforms.openai.groups.find(group => group.id === '8').key_configured);
      assert.equal(saved.providers.testllm.platforms.openai.params.model, 'gpt-6-astra');
      assert.equal(saved.providers.manxue.platforms.anthropic.params.model, 'claude-sonnet-4-5');
      assert.match(await page.locator('[data-group-row="8"] .model-cell').innerText(), new RegExp(`gpt-shared-${layout.name}`));
      assert.match(await page.locator('[data-group-row="18"] .source').innerText(), /独立参数/);
      await ai('anthropic');
      assert.equal(await shared.locator('[name="model"]').inputValue(), 'claude-sonnet-4-5');
      await shared.locator('[name="model"]').fill(`claude-manxue-${layout.name}`);
      await shared.locator('[name="reasoning_effort_preset"]').selectOption('high');
      saved = await save();
      assert.equal(saved.providers.manxue.platforms.openai.params.reasoning_effort, `manual-${layout.name}`);
      await shot('manxue-claude');

      await provider('testllm'); await ai('openai');
      assert.equal(await page.locator('[data-ai-tab]').count(), 2);
      assert.equal(await shared.locator('[name="reasoning_effort_preset"],[name="service_tier"],[name="candy"],[name="pelican"]').count(), 0);
      assert.equal(await shared.locator('[name="protocol"]').inputValue(), 'gpt');
      await shared.locator('[name="model"]').fill(`iq-shared-${layout.name}`);
      await shared.locator('[name="target_url"]').fill('https://testllm-relay.example.com/v1');
      await shared.locator('[name="cache_test"]').uncheck();
      await page.locator('#provider-form [name="api_url"]').fill('https://changed-testllm.example.com');
      saved = await save();
      assert.equal(saved.providers.testllm.platforms.openai.params.cache_test, false);
      assert.equal(saved.providers.manxue.platforms.openai.params.model, `gpt-shared-${layout.name}`);
      assert.equal(saved.providers.manxue.api_url, 'https://changed-manxue.example.com/tests');
      assert.equal(saved.providers.testllm.platforms.anthropic.params.cache_test, true);
      await shot('testllm-chatgpt');
      await ai('anthropic');
      assert.equal(await shared.locator('[name="protocol"]').inputValue(), 'claude');
      await shared.locator('[name="thinking_test"]').uncheck(); await save();
      await edit('2');
      assert.match(await page.locator('#group-path').innerText(), /TestLLM \/ Claude/);
      assert.equal(await group.locator('[name="model"]').isDisabled(), true);
      assert.equal(await group.locator('[name="reasoning_effort_preset"],[name="service_tier"]').count(), 0);
      await group.locator('.segmented label').filter({ hasText: '独立配置' }).click();
      await group.locator('[name="model"]').fill(`claude-group-${layout.name}`);
      await group.locator('[name="cache_test"]').uncheck();
      await group.locator('[name="thinking_test"]').check();
      await group.locator('[name="timeout_seconds"]').fill('240');
      await group.locator('[name="group_key"]').fill(`sk-demo-only-${layout.name}-claude-123456`);
      await group.locator('[name="clear_key"]').check(); await apply();
      assert.match(await page.locator('#group-error').innerText(), /不能同时/);
      await group.locator('[name="clear_key"]').uncheck();
      await group.locator('[name="group_key"]').focus();
      assert(await group.locator('[name="group_key"]').evaluate(input => {
        const rect = input.getBoundingClientRect();
        const body = input.closest('.dialog-body').getBoundingClientRect();
        const footer = input.closest('form').querySelector('footer').getBoundingClientRect();
        return rect.top >= body.top && rect.bottom <= Math.min(body.bottom, footer.top);
      }), 'key field must remain above the footer');
      await shot('testllm-group'); await apply(); saved = await save();
      const claude = saved.providers.testllm.platforms.anthropic;
      assert.equal(claude.groups[0].override.model, `claude-group-${layout.name}`);
      assert.equal(claude.groups[0].override.cache_test, false); assert.equal(claude.groups[0].override.thinking_test, true);
      assert.equal(claude.params.thinking_test, false);
      assert.equal(saved.providers.manxue.platforms.anthropic.groups[0].override, null);
      assert.doesNotMatch(JSON.stringify(saved), /sk-demo-only/);
      assert.equal(await page.evaluate(() => /sk-demo-only/.test(JSON.stringify(localStorage) + JSON.stringify(sessionStorage))), false);

      await provider('manxue'); await ai('openai');
      await edit('18');
      await group.locator('.segmented label').filter({ hasText: '继承平台' }).click();
      assert.equal(await group.locator('[name="model"]').isDisabled(), true);
      assert.equal(await group.locator('[name="model"]').inputValue(), `gpt-shared-${layout.name}`);
      await apply(); saved = await save();
      assert.equal(saved.providers.manxue.platforms.openai.groups.find(group => group.id === '18').override, null);
      await edit('8');
      await group.locator('.segmented label').filter({ hasText: '独立配置' }).click();
      assert.equal(await group.locator('[name="protocol"],[name="cache_test"],[name="thinking_test"]').count(), 0);
      await group.locator('[name="model"]').fill(`gpt-group-${layout.name}`);
      await group.locator('[name="reasoning_effort_preset"]').selectOption('ultra');
      await group.locator('[name="service_tier"]').selectOption('priority');
      await group.locator('[name="timeout_seconds"]').fill('180');
      await group.locator('[name="group_candy"]').uncheck();
      await shot('manxue-group'); await apply(); await save();
      await page.locator('[data-group-enabled="28"]').check();
      await page.locator('[data-save]').click();
      assert.match(await page.locator('#group-error').innerText(), /专用 Key/);
      await group.locator('[name="group_key"]').fill(`sk-demo-only-${layout.name}-backup-123456`);
      await apply(); saved = await save();
      assert(saved.providers.manxue.platforms.openai.groups.find(group => group.id === '28').key_configured);
      assert.equal(saved.providers.testllm.platforms.openai.groups.find(group => group.id === '28').key_configured, false);
      await page.locator('.advanced > summary').click();
      await shared.locator('[name="schedule_enabled"]').check();
      await shot('daily-plan');
      await page.locator('[data-add-time]').click();
      await page.locator('[data-add-time]').click();
      await fit();
      await page.locator('[data-remove-time]').click();
      await page.locator('[data-remove-time]').click();
      await shared.locator('[data-time-index="1"]').fill('09:30');
      await page.locator('[data-save]').click();
      assert.match(await page.locator('#page-error').innerText(), /重复/);
      await shared.locator('[data-time-index="1"]').fill('21:30');
      await shared.locator('[name="schedule_mode"][value="interval"]').check();
      await shared.locator('[name="interval_minutes"]').fill('120');
      await shared.locator('[name="schedule_mode"][value="daily"]').check();
      assert.equal(await shared.locator('[data-time-index="1"]').inputValue(), '21:30');
      await shared.locator('[name="schedule_mode"][value="interval"]').check();
      assert.equal(await shared.locator('[name="interval_minutes"]').inputValue(), '120');
      saved = await save();
      assert.equal(saved.providers.manxue.platforms.openai.schedule.interval_minutes, 120);
      assert.equal(saved.providers.testllm.platforms.openai.schedule.enabled, false);
      assert.equal(saved.providers.manxue.platforms.anthropic.schedule.enabled, false);
      await shot('plan');
      await page.locator('[data-run-platform]').click();
      await page.waitForFunction(() => !document.querySelector('.groups-table').textContent.includes('模拟检测中'));
      await page.locator('[data-run-group="8"]').click();
      await page.waitForFunction(() => !document.querySelector('.groups-table').textContent.includes('模拟检测中'));
      await page.locator('[data-history-group="8"]').click();
      assert.equal(await page.locator('.history-entry').count(), 5);
      await page.locator('.history-entry').first().locator('summary').click();
      assert.match(await page.locator('.history-entry').first().innerText(), new RegExp(`gpt-group-${layout.name}`));
      assert.match(await page.locator('.history-entry').first().innerText(), /ultra/);
      await shot('history'); await page.keyboard.press('Escape');
      await shared.locator('[name="model"]').fill(`gpt-after-${layout.name}`); await save();
      await page.locator('[data-history-group="18"]').click();
      await page.locator('.history-entry').first().locator('summary').click();
      assert.match(await page.locator('.history-entry').first().innerText(), new RegExp(`gpt-shared-${layout.name}`), 'historical snapshots must stay unchanged');
      await page.keyboard.press('Escape');
      await page.locator('#provider-form [name="provider_enabled"]').uncheck(); await save();
      assert.equal(await page.locator('[data-run-group]:enabled').count(), 0);
      await provider('testllm');
      assert((await page.locator('[data-run-group]:enabled').count()) > 0, 'other provider remains enabled');
      await provider('manxue'); await page.locator('#provider-form [name="provider_enabled"]').check(); await save();
      await page.locator('#group-search').fill('不存在');
      assert.equal(await page.locator('[data-group-row]').count(), 0);
      await page.locator('#group-search').fill('');
      await page.reload();
      await shared.waitFor();
      assert.equal(await page.locator('#save-state').innerText(), '配置已保存');
      assert.equal(await shared.locator('[name="model"]').inputValue(), `gpt-after-${layout.name}`);
      await provider('testllm'); await ai('anthropic'); await edit('2');
      assert.equal(await group.locator('[name="model"]').inputValue(), `claude-group-${layout.name}`);
      assert.equal(await group.locator('[name="group_key"]').inputValue(), '');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('dialog[open]').count(), 0);
      await fit();
      await context.close();
    }
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const deep = await context.newPage();
    await deep.goto(preview.url + '/admin/config?provider=testllm&platform=anthropic&group=2');
    assert.match(await deep.locator('#group-path').innerText(), /TestLLM \/ Claude/);
    await context.close();
    assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(writes, []);
    console.log(JSON.stringify({ ok: true, layouts: ['1440', '390', '320', 'dark'], errors, external, writes, directory }, null, 2));
  } finally {
    await browser?.close(); preview.server.closeAllConnections?.(); await new Promise(resolve => preview.server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
