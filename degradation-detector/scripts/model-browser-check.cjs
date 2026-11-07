'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPreview } = require('./model-preview.cjs');
let playwright;
try { playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright'); }
catch { playwright = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }

async function main() {
  const preview = await createPreview(0);
  const browser = await playwright.chromium.launch({ channel: 'chrome', headless: true });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sub2api-model-browser-'));
  const errors = [];
  const external = [];
  const watch = page => {
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(preview.baseUrl + '/')) external.push(request.url()); });
    page.setDefaultTimeout(12000);
  };
  const shot = (page, name, fullPage = false) => page.screenshot({ path: path.join(directory, `${name}.png`), fullPage });
  const fit = async page => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'page must not overflow');
  const readConfig = page => page.evaluate(async () => (await fetch('/api/admin/config')).json());
  const save = async page => {
    const response = page.waitForResponse(response => response.url().endsWith('/api/admin/config') && response.request().method() === 'PUT');
    await page.locator('#save-button').click();
    const result = await response;
    assert.equal(result.status(), 200, await result.text());
    await page.waitForFunction(() => !document.getElementById('save-button').disabled);
    return result.json();
  };
  try {
    const adminContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
    const admin = await adminContext.newPage(); watch(admin);
    await admin.goto(`${preview.baseUrl}/admin/config?demo=1`);
    await admin.locator('.platform-panel:not([hidden]) [data-model-enabled]').waitFor();
    const before = await readConfig(admin);
    assert.equal(before.model_schedule.enabled, false);
    await admin.locator('.platform-tab[data-platform="openai"]').click();
    const panel = admin.locator('.platform-panel:not([hidden])');
    assert.equal(await panel.locator('.model-channel').count(), 2);
    assert.equal(await panel.locator('[data-model-group-key]').inputValue(), '');
    assert.equal(await panel.locator('[data-channel-key]').first().inputValue(), '');
    await admin.locator('#model-schedule-enabled').check();
    await admin.locator('#model-schedule-add').click();
    await admin.locator('#model-schedule-times input').nth(2).fill('13:00');
    await panel.locator('.model-group-overrides summary').click();
    await panel.locator('[data-model-group-model="cctest"]').fill('gpt-5-group-demo');
    let saved = await save(admin);
    assert.deepEqual(saved.model_schedule.times, ['09:30', '13:00', '21:30']);
    assert.equal(saved.platforms.find(item => item.id === 'openai').groups[0].model_detection.models.cctest, 'gpt-5-group-demo');
    const effectiveTests = data => data.platforms.map(item => {
      const test = structuredClone(item.test);
      if (!test.validation.visual?.enabled) delete test.validation.visual;
      return test;
    });
    assert.deepEqual(effectiveTests(saved), effectiveTests(before), 'model editing cannot modify effective IQ tests');
    await admin.reload();
    await admin.locator('#model-schedule-times input').nth(2).waitFor();
    assert.equal(await admin.locator('#model-schedule-enabled').isChecked(), true);
    await admin.locator('#model-schedule-mode-interval').check();
    await admin.locator('#model-schedule-interval').fill('120');
    saved = await save(admin);
    assert.equal(saved.model_schedule.mode, 'interval');
    assert.equal(saved.model_schedule.interval_minutes, 120);
    assert.deepEqual(saved.schedule_times, before.schedule_times);
    await fit(admin);
    await shot(admin, 'desktop-config', true);
    await admin.locator('.platform-tab[data-platform="openai"]').click();
    await panel.locator('[data-model-run-group]').click();
    await admin.locator('#model-admin-detail .items-table').waitFor();
    assert.equal(await admin.locator('#model-admin-detail .items-table tbody tr').count(), 8);
    await admin.locator('#model-admin-channel').selectOption('cctest');
    await admin.locator('#model-admin-detail .model-table').nth(1).waitFor();
    assert.equal(await admin.locator('#model-admin-detail .model-table').first().locator('tbody tr').count(), 11);
    assert.equal(await admin.locator('#model-admin-detail .model-table').nth(1).locator('tbody tr').count(), 6);
    assert.match(await admin.locator('#model-admin-detail').innerText(), /gpt-5-group-demo/);
    await shot(admin, 'desktop-admin-history');
    await admin.locator('#model-admin-select-all').check();
    assert.equal(await admin.locator('#model-admin-history-list input:checked').count(), 4);
    await admin.locator('#model-admin-history-list input:checked').first().uncheck();
    assert.equal(await admin.locator('#model-admin-select-all').evaluate(el => el.indeterminate), true);
    await admin.locator('#model-admin-delete-selected').click();
    await admin.locator('#confirm-accept').click();
    await admin.waitForFunction(() => document.querySelectorAll('#model-admin-history-list .model-admin-history-row').length === 1);
    await admin.locator('#model-admin-channel').selectOption('bazaarlink');
    await admin.waitForFunction(() => document.querySelectorAll('#model-admin-history-list .model-admin-history-row').length === 4);
    assert.equal(await admin.locator('#model-admin-select-all').isChecked(), false);
    await admin.locator('#model-admin-history-close').click();
    await panel.locator('[data-model-run-platform]').click();
    await admin.waitForFunction(() => [...document.querySelectorAll('#toast-region *')].some(el => el.textContent.includes('已排队 2')));

    const userContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
    const page = await userContext.newPage(); watch(page);
    await page.goto(`${preview.baseUrl}/results?demo=readonly`);
    await page.locator('#group-grid .group-card').first().waitFor();
    assert.equal(await page.locator('#group-grid .group-card').count(), 3);
    await page.locator('#group-grid .detect-button').first().click();
    await page.frameLocator('#result-detail iframe').locator('svg').waitFor();
    assert.equal(await page.locator('.validation-evidence').getAttribute('open'), null);
    await page.getByRole('button', { name: '查看源码', exact: true }).click();
    assert.match(await page.locator('#result-detail pre').innerText(), /<!doctype html>/);
    await page.getByRole('button', { name: '查看预览', exact: true }).click();
    await page.frameLocator('#result-detail iframe').locator('svg').waitFor();
    await shot(page, 'desktop-iq-detail');
    await page.locator('#dialog-close').click();
    await page.locator('#model-tab').click();
    await page.locator('#model-grid .model-card').first().waitFor();
    assert.equal(await page.locator('#model-grid .model-card').count(), 2);
    assert.equal(await page.locator('#model-grid .channel-result').count(), 4);
    await fit(page); await shot(page, 'desktop-model');
    await page.locator('[data-model-open="8"][data-model-channel="bazaarlink"]').click();
    await page.locator('#model-detail .items-table').waitFor();
    assert.equal(await page.locator('#model-detail .items-table tbody tr').count(), 8);
    assert.match(await page.locator('#model-detail').innerText(), /仅确认家族/);
    await page.locator('#model-detail .items-table details').first().locator('summary').click();
    assert.match(await page.locator('#model-detail .items-table details').first().innerText(), /response/);
    await shot(page, 'desktop-probe-detail');
    await page.locator('[data-channel-tab="cctest"]').click();
    await page.locator('#model-detail .model-table').nth(1).waitFor();
    assert.equal(await page.locator('#model-detail .model-table').first().locator('tbody tr').count(), 11);
    assert.equal(await page.locator('#model-detail .model-table').nth(1).locator('tbody tr').count(), 6);
    assert.match(await page.locator('#model-detail').innerText(), /\$0\.003/);
    const rawBlock = page.locator('#model-detail .data-block').last();
    await rawBlock.locator('summary').click();
    assert.match(await rawBlock.innerText(), /"server_tool": 0/);
    assert.match(await rawBlock.innerText(), /"baselineTotalCost": null/);
    await rawBlock.locator('summary').click();
    await shot(page, 'desktop-cctest-detail');
    const rendered = await page.evaluate(() => window.ModelResultRenderer.renderCheck({ status: 'done', scores: { future_probe: null, zero_probe: 0 }, total: null, error: '<img src=x onerror="window.__xss=1">' }));
    assert.match(rendered, /future_probe/); assert.match(rendered, /zero_probe/);
    assert.match(rendered, /&lt;img/); assert.doesNotMatch(rendered, /<img/);
    const stale = await page.evaluate(() => window.ModelResultRenderer.renderProbe({ status: 'running', items: [] }, { local_status: 'error', local_reason: '查询中断' }));
    assert.match(stale, /检测异常/); assert.match(stale, /查询中断/);
    await page.locator('#model-dialog-close').click();
    await page.locator('#model-platform-filter').selectOption('openai');
    await page.locator('#model-channel-filter').selectOption('cctest');
    assert.equal(await page.locator('#model-grid .channel-result').count(), 1);
    const denied = await page.evaluate(async () => {
      const targets = ['/api/admin/config', '/admin/config', '/admin/model-config.js'];
      const reads = await Promise.all(targets.map(url => fetch(url).then(response => response.status)));
      const write = await fetch('/api/admin/groups/8/model-runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      return [...reads, write.status];
    });
    assert.deepEqual(denied, [403, 403, 403, 403]);
    assert.equal(await page.locator('[data-model-run-group], [data-model-group-key]').count(), 0);

    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await fit(page);
      await page.locator('[data-model-open="8"][data-model-channel="cctest"]').click();
      await page.locator('#model-detail .model-table').nth(1).waitFor();
      await fit(page);
      assert.equal(await page.locator('#model-detail .model-table').first().locator('tbody tr').count(), 11);
      if (width === 390) await shot(page, 'mobile-cctest-detail');
      await page.locator('[data-channel-tab="bazaarlink"]').click();
      await page.locator('#model-detail .items-table').waitFor();
      await fit(page);
      if (width === 390) await shot(page, 'mobile-probe-detail');
      await page.locator('#model-dialog-close').click();
      await admin.setViewportSize({ width, height: 844 });
      await fit(admin);
      if (width === 390) await shot(admin, 'mobile-config', true);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${preview.baseUrl}/results?theme=dark#model`);
    await page.locator('#model-grid .model-card').first().waitFor();
    assert.equal(await page.locator('html').evaluate(el => el.classList.contains('dark')), true);
    await shot(page, 'dark-model');
    await page.locator('[data-model-open="8"][data-model-channel="bazaarlink"]').click();
    await page.locator('#model-detail .items-table').waitFor();
    await shot(page, 'dark-probe-detail');
    await admin.setViewportSize({ width: 1440, height: 900 });
    await admin.locator('.platform-panel:not([hidden]) [data-model-history]').click();
    await admin.locator('#model-admin-history-list .model-admin-history-row').first().waitFor();
    await admin.locator('#model-admin-channel').selectOption('cctest');
    await admin.locator('#model-admin-detail .model-table').first().waitFor();
    await admin.locator('#model-admin-clear-all').click();
    await admin.locator('#confirm-accept').click();
    await admin.waitForFunction(() => document.querySelectorAll('#model-admin-history-list .model-admin-history-row').length === 0);
    assert(preview.runtime.modelStore.counts('8', 'bazaarlink').total > 0, 'other channel must survive a clear');

    const iqGroups = preview.runtime.store.listMonitors(preview.runtime.config.serviceOwnerId);
    const modelGroups = preview.runtime.modelStore.groups();
    const setEnabled = (iq, model) => preview.runtime.store.db.transaction(() => {
      for (const group of iqGroups) preview.runtime.store.setMonitorEnabled(group.user_id, group.group_id, iq && Boolean(group.enabled));
      const update = preview.runtime.store.db.prepare('UPDATE model_groups SET enabled=? WHERE group_id=?');
      for (const group of modelGroups) update.run(model && group.enabled ? 1 : 0, group.group_id);
    })();
    const assertTabs = async (iq, model, selected) => {
      await page.waitForFunction(({ iq, model, selected }) => {
        const $ = id => document.getElementById(id);
        return $('iq-tab').hidden === !iq && $('model-tab').hidden === !model
          && $('iq-pane').hidden === (selected !== 'iq') && $('model-pane').hidden === (selected !== 'model')
          && $('detection-empty').hidden === Boolean(selected);
      }, { iq, model, selected });
      assert.equal(await page.locator('.result-tabs').isVisible(), iq || model);
      for (const name of ['iq', 'model']) {
        assert.equal(await page.locator(`#${name}-tab`).getAttribute('aria-selected'), String(name === selected));
        assert.equal(await page.locator(`#${name}-tab`).getAttribute('tabindex'), name === selected ? '0' : '-1');
      }
    };
    await page.locator('#model-dialog-close').click();
    await assertTabs(true, true, 'model');
    setEnabled(false, true);
    await page.evaluate(() => refresh());
    await assertTabs(false, true, 'model');
    await page.goto(`${preview.baseUrl}/results`);
    await assertTabs(false, true, 'model');
    await page.locator('#model-grid .model-card').first().waitFor();
    assert.match(await page.locator('#model-grid').innerText(), /尚无检测结果/);
    await fit(page); await shot(page, 'model-only');
    await page.locator('[data-model-open="8"][data-model-channel="bazaarlink"]').click();
    await page.locator('#model-detail .items-table').waitFor();
    setEnabled(true, false);
    await page.evaluate(() => refresh());
    await assertTabs(true, false, 'iq');
    assert.equal(await page.locator('#model-dialog').evaluate(el => el.open), false);
    await page.goto(`${preview.baseUrl}/results#model`);
    await assertTabs(true, false, 'iq');
    await page.locator('#iq-tab').focus();
    for (const key of ['ArrowRight', 'ArrowLeft', 'End', 'Home']) {
      await page.keyboard.press(key);
      await assertTabs(true, false, 'iq');
      assert.equal(await page.locator('#iq-tab').evaluate(el => el === document.activeElement), true);
    }
    await fit(page); await shot(page, 'iq-only');
    setEnabled(true, true);
    await page.evaluate(() => refresh());
    await assertTabs(true, true, 'iq');
    await page.keyboard.press('End');
    await assertTabs(true, true, 'model');
    const originalPlatform = preview.runtime.modelStore.platform('openai');
    const restrictedPlatform = structuredClone(originalPlatform);
    restrictedPlatform.channels.cctest.enabled = false;
    const updatePlatform = preview.runtime.store.db.prepare('UPDATE model_platforms SET config_json=? WHERE platform=?');
    updatePlatform.run(JSON.stringify(restrictedPlatform), 'openai');
    await page.locator('#model-refresh').click();
    await page.waitForFunction(() => !document.getElementById('model-refresh').classList.contains('busy'));
    await page.locator('#model-platform-filter').selectOption('openai');
    await page.locator('#model-channel-filter').selectOption('cctest');
    await page.locator('#model-grid .empty-list').waitFor();
    await assertTabs(true, true, 'model');
    await page.route('**/api/results', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"message":"Temporary failure"}}' }));
    await page.evaluate(() => refresh().catch(() => {}));
    await assertTabs(true, true, 'model');
    await page.unroute('**/api/results');
    updatePlatform.run(JSON.stringify(originalPlatform), 'openai');
    await page.locator('#iq-tab').click();
    await page.locator('#group-grid .detect-button').first().click();
    await page.frameLocator('#result-detail iframe').locator('svg').waitFor();
    setEnabled(false, true);
    await page.evaluate(() => refresh());
    await assertTabs(false, true, 'model');
    assert.equal(await page.locator('#result-dialog').evaluate(el => el.open), false);
    setEnabled(false, false);
    await page.evaluate(() => refresh());
    await assertTabs(false, false, null);
    await page.goto(`${preview.baseUrl}/results#model`);
    await assertTabs(false, false, null);
    assert.equal(await page.locator('#page-title').innerText(), '检测结果');
    await fit(page); await shot(page, 'no-configured-groups');
    setEnabled(false, true);
    await page.locator('#refresh-button').click();
    await assertTabs(false, true, 'model');
    setEnabled(true, true);
    assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(preview.outboundCalls, 0);
    console.log(JSON.stringify({ status: 'PASS', checks: 'Independent model config and schedules, per-group models, manual and platform runs, all 8 probe items, all 11 scores and 6 audit rounds, batch/all history deletion, original IQ preview and source, live read-only boundaries, permission-scoped tabs for both/one/neither type, automatic fallback and dialog cleanup, keyboard navigation, filtered-empty and no-history groups, request failures, mobile 390/320, dark mode, escaping and zero paid calls', screenshots: directory, pageErrors: errors, externalRequests: external }, null, 2));
  } catch (error) {
    for (const [index, context] of browser.contexts().entries()) {
      const page = context.pages()[0];
      if (page && !page.isClosed()) await shot(page, `failure-${index}`).catch(() => {});
    }
    console.error(`Screenshots: ${directory}`);
    throw error;
  } finally { await browser.close(); await preview.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
