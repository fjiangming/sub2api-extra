'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPreview } = require('./model-preview.cjs');
const { fingerprintComparison } = require('../src/model-results');
let playwright;
try { playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright'); }
catch { playwright = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }

async function main() {
  const preview = await createPreview(0);
  const aliasRun = preview.runtime.modelStore.latest('2', 'fingerpoint');
  const aliasResponse = JSON.parse(preview.runtime.modelStore.run(aliasRun.id).response_json);
  aliasResponse.analysis.prediction = aliasResponse.analysis.prediction_name = 'claude-sonnet-4.5';
  aliasResponse.analysis.results[0].model = aliasResponse.analysis.results[0].display_name = 'claude-sonnet-4.5';
  Object.assign(aliasResponse, fingerprintComparison(aliasResponse.analysis, aliasRun.model));
  preview.runtime.modelStore.updateResponse(aliasRun.id, aliasResponse, 'completed');
  const combinedRun = preview.runtime.modelStore.history('2', 'fingerpoint')[1];
  const combinedResponse = JSON.parse(preview.runtime.modelStore.run(combinedRun.id).response_json);
  combinedResponse.requested_model = 'gpt-6.1-sol';
  for (const round of combinedResponse.rounds) {
    round.analysis.prediction = round.analysis.results[0].model = 'gpt-6-astra';
    round.analysis.prediction_name = round.analysis.results[0].display_name = 'gpt-6-astra/6.1-sol';
    round.analysis.probability = round.analysis.results[0].probability = 0.998;
  }
  combinedResponse.analysis = combinedResponse.rounds.at(-1).analysis;
  Object.assign(combinedResponse, fingerprintComparison(combinedResponse.analysis, combinedResponse.requested_model));
  preview.runtime.modelStore.db.prepare('UPDATE model_runs SET model=? WHERE id=?').run(combinedResponse.requested_model, combinedRun.id);
  preview.runtime.modelStore.updateResponse(combinedRun.id, combinedResponse, 'completed');
  const browser = await playwright.chromium.launch({ channel: 'chrome', headless: true });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sub2api-model-browser-'));
  const errors = [];
  const external = [];
  const resultRequests = [];
  const watch = page => {
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (/^https?:/.test(request.url()) && !request.url().startsWith(preview.baseUrl + '/')) external.push(request.url());
      if (request.url().startsWith(preview.baseUrl + '/api/')) {
        const api = new URL(request.url()).pathname;
        if (/^\/api\/(?:model-results|results)(?:\/|$)/.test(api)) resultRequests.push({ page: new URL(page.url()).pathname, api });
      }
    });
    page.setDefaultTimeout(12000);
  };
  const shot = (page, name, fullPage = false) => page.screenshot({ path: path.join(directory, `${name}.png`), fullPage });
  const fit = async page => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'page must not overflow');
  const independentPage = async (page, type) => {
    assert.equal(await page.locator('#page-title').innerText(), type === 'iq' ? '降智检测' : '模型检测');
    assert.equal(await page.locator('.result-tabs, #iq-tab, #model-tab').count(), 0);
    assert.equal(await page.locator(type === 'iq' ? '#model-pane, #model-dialog' : '#iq-pane, #result-dialog').count(), 0);
  };
  const refreshPage = async (page, type, status = 200) => {
    const endpoint = type === 'iq' ? '/api/results' : '/api/model-results';
    const button = type === 'iq' ? '#refresh-button' : '#model-refresh';
    const response = page.waitForResponse(response => new URL(response.url()).pathname === endpoint);
    if (await page.locator('dialog[open]').count()) await page.bringToFront();
    else await page.locator(button).click();
    assert.equal((await response).status(), status);
    await page.waitForFunction(button => !document.querySelector(button).classList.contains('busy'), button);
  };
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
    assert.equal(await panel.locator('.model-channel').count(), 3);
    assert.equal(await panel.locator('[data-channel="fingerpoint"] [data-channel-key]').count(), 0);
    assert.equal(await panel.locator('[data-model-group-key]').inputValue(), '');
    assert.equal(await panel.locator('[data-channel-key]').first().inputValue(), '');
    await admin.locator('#model-schedule-enabled').check();
    await admin.locator('#model-schedule-add').click();
    await admin.locator('#model-schedule-times input').nth(2).fill('13:00');
    await panel.locator('.model-group-overrides summary').click();
    await panel.locator('[data-model-group-model="cctest"]').fill('gpt-5-group-demo');
    await panel.locator('[data-model-group-model="fingerpoint"]').fill('gpt-5-fingerpoint-demo');
    await panel.locator('[data-channel="fingerpoint"] [data-channel-field="effort"]').selectOption('max');
    await admin.locator('#fp-data-interval').fill('12');
    await admin.locator('#fp-data-application').selectOption('manual');
    let saved = await save(admin);
    assert.deepEqual(saved.model_schedule.times, ['09:30', '13:00', '21:30']);
    assert.equal(saved.platforms.find(item => item.id === 'openai').groups[0].model_detection.models.cctest, 'gpt-5-group-demo');
    assert.equal(saved.platforms.find(item => item.id === 'openai').groups[0].model_detection.models.fingerpoint, 'gpt-5-fingerpoint-demo');
    assert.equal(saved.platforms.find(item => item.id === 'openai').model_detection.channels.fingerpoint.effort, 'max');
    assert.equal(saved.fingerprint_data.interval_hours, 12); assert.equal(saved.fingerprint_data.application, 'manual');
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
    const mockData = structuredClone(saved.fingerprint_data);
    const version = { built_at: '2026-11-08T12:00:00Z', hash: 'b'.repeat(64), models: 68 };
    const updateRequests = [];
    await admin.route('**/api/admin/fingerpoint/**', route => {
      const request = route.request(); const action = request.url().split('/').at(-1);
      if (request.method() === 'POST') {
        assert(request.headers()['x-csrf-token']); updateRequests.push(action);
        if (action === 'check') { mockData.available = version; mockData.last_checked = Date.now(); }
        if (action === 'apply') { mockData.active = mockData.available; mockData.available = null; mockData.can_rollback = true; mockData.history.unshift({ at: Date.now(), action: '应用', version: '2026-11-08', status: '已应用' }); }
        if (action === 'rollback') { mockData.available = mockData.active; mockData.active = { ...version, built_at: '2026-11-03T12:00:00Z' }; mockData.can_rollback = false; }
        return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ ...mockData, busy: true }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...mockData, busy: false }) });
    });
    await admin.locator('[data-fp-update="check"]').click();
    await admin.waitForFunction(() => !document.querySelector('[data-fp-update="apply"]').disabled);
    await admin.locator('[data-fp-update="apply"]').click();
    await admin.waitForFunction(() => !document.querySelector('[data-fp-update="rollback"]').disabled);
    await admin.locator('#fp-version-history').click();
    await admin.locator('#fp-version-dialog[open]').waitFor();
    assert.match(await admin.locator('#fp-version-dialog').innerText(), /2026-11-08/);
    await admin.locator('#fp-version-dialog button').click();
    await admin.locator('[data-fp-update="rollback"]').click();
    await admin.locator('#confirm-accept').click();
    await admin.waitForFunction(() => !document.querySelector('[data-fp-update="check"]').disabled);
    assert.deepEqual(updateRequests, ['check','apply','rollback']);
    await shot(admin, 'desktop-data-management');
    await admin.unroute('**/api/admin/fingerpoint/**');
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
    await panel.locator('[data-model-history]').click();
    await admin.locator('#model-admin-channel').selectOption('fingerpoint');
    await admin.locator('#model-admin-detail [data-fingerprint-detail]').waitFor();
    assert.equal(await admin.locator('#model-admin-detail .fp-rankings').first().locator('tbody tr').count(), 6);
    assert.match(await admin.locator('#model-admin-detail').innerText(), /SDK 0\.2\.0/);
    await shot(admin, 'desktop-admin-fingerpoint');
    await admin.locator('#model-admin-history-close').click();
    await panel.locator('[data-model-run-platform]').click();
    await admin.waitForFunction(() => [...document.querySelectorAll('#toast-region *')].some(el => el.textContent.includes('已排队 3')));

    const userContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
    const page = await userContext.newPage(); watch(page);
    await page.goto(`${preview.baseUrl}/results?demo=readonly`);
    await page.locator('#group-grid .group-card').first().waitFor();
    await independentPage(page, 'iq');
    assert.equal(await page.locator('#group-grid .group-card').count(), 3);
    assert.equal(await page.locator('#iq-pane .fp-platform-zone').count(), 3);
    assert.equal(await page.locator('#iq-pane #capability-note').count(), 1);
    assert.equal(await page.locator('#platform-filter, .group-id').count(), 0);
    await shot(page, 'desktop-iq', true);
    await page.locator('#group-grid .detect-button').first().click();
    await page.frameLocator('#result-detail iframe').locator('svg').waitFor();
    assert.equal(await page.locator('.validation-evidence').getAttribute('open'), null);
    await page.getByRole('button', { name: '查看源码', exact: true }).click();
    assert.match(await page.locator('#result-detail pre').innerText(), /<!doctype html>/);
    await page.getByRole('button', { name: '查看预览', exact: true }).click();
    await page.frameLocator('#result-detail iframe').locator('svg').waitFor();
    await shot(page, 'desktop-iq-detail');
    await page.locator('#dialog-close').click();
    await page.goto(`${preview.baseUrl}/model-results`);
    await page.locator('#model-grid .model-card').first().waitFor();
    await independentPage(page, 'model');
    assert.equal(await page.locator('#model-grid .model-card').count(), 2);
    assert.equal(await page.locator('#model-grid .channel-result').count(), 6);
    assert.equal(await page.locator('#model-pane .fp-platform-zone').count(), 2);
    assert.equal(await page.locator('[data-channel-note]').count(), 3);
    assert.equal(await page.locator('.fp-channel-site[target="_blank"][rel="noopener noreferrer"]').count(), 3);
    assert.equal(await page.locator('#model-platform-filter, #model-channel-filter, #model-grid .card-foot, #model-grid .group-id').count(), 0);
    assert.doesNotMatch(await page.locator('#model-pane').innerText(), /本地|独立检测记录/);
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
    await page.locator('[data-channel-tab="fingerpoint"]').click();
    await page.locator('[data-fingerprint-detail]').waitFor();
    assert.equal(await page.locator('#model-detail .fp-rankings').first().locator('tbody tr').count(), 6);
    assert.equal(await page.locator('#model-detail > .fp-result > .model-section').nth(1).locator(':scope > .data-block').count(), 3);
    await shot(page, 'desktop-fingerpoint-detail');
    for (const decision of ['partial','unscorable','not_model',null]) {
      const rendered = await page.evaluate(decision => window.ModelResultRenderer.renderFingerprint({ status: 'done', analysis: decision ? { decision, results: [], probability: null } : null, rounds: [{ round: 1, analysis: null, samples: [] }], parameters: { count: 3 }, data: {} }), decision);
      assert.match(rendered, /不提供/); assert.doesNotMatch(rendered, /NaN|undefined|candidate_match/);
    }
    const rendered = await page.evaluate(() => window.ModelResultRenderer.renderCheck({ status: 'done', scores: { future_probe: null, zero_probe: 0 }, total: null, error: '<img src=x onerror="window.__xss=1">' }));
    assert.match(rendered, /future_probe/); assert.match(rendered, /zero_probe/);
    assert.match(rendered, /&lt;img/); assert.doesNotMatch(rendered, /<img/);
    const stale = await page.evaluate(() => window.ModelResultRenderer.renderProbe({ status: 'running', items: [] }, { local_status: 'error', local_reason: '查询中断' }));
    assert.match(stale, /检测异常/); assert.match(stale, /查询中断/);
    await page.locator('#model-dialog-close').click();
    await page.locator('[data-model-open="2"][data-model-channel="fingerpoint"]').click();
    await page.locator('[data-fingerprint-detail]').waitFor();
    assert.match(await page.locator('#model-detail .model-verdict').innerText(), /候选相符/);
    assert.match(await page.locator('#model-detail .model-verdict').innerText(), /版本号分隔符写法等价/);
    assert.match(await page.locator('#model-detail .identity-facts').first().innerText(), /claude-sonnet-4-5/);
    assert.match(await page.locator('#model-detail .fp-rankings').first().innerText(), /claude-sonnet-4\.5/);
    await fit(page); await shot(page, 'desktop-fingerpoint-alias');
    await page.locator(`[data-model-history="${combinedRun.id}"]`).click();
    await page.locator('#model-detail .model-verdict').getByText('请求名称属于参考库明确列出的组合候选名称。该参考候选包含多个模型名称，本次结果无法区分组合内的具体型号。', { exact: true }).waitFor();
    assert.match(await page.locator('#model-detail .model-verdict').innerText(), /候选相符/);
    assert.match(await page.locator('#model-detail .identity-facts').first().innerText(), /gpt-6\.1-sol/);
    assert.match(await page.locator('#model-detail .fp-rankings').first().innerText(), /gpt-6-astra\/6\.1-sol/);
    assert.match(await page.locator('#model-detail .identity-facts').first().innerText(), /99\.8%/);
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 844 }]) {
      await page.setViewportSize(viewport); await fit(page);
      assert(await page.locator('#model-detail .model-verdict').getByText('候选相符', { exact: true }).isVisible());
      await shot(page, `fingerpoint-combined-${viewport.width}`);
    }
    await page.locator('html').evaluate(el => el.classList.add('dark'));
    assert.equal(await page.locator('#model-detail .model-verdict .model-badge').evaluate(el => getComputedStyle(el).color), 'rgb(110, 231, 183)');
    await shot(page, 'fingerpoint-combined-dark');
    await page.locator('html').evaluate(el => el.classList.remove('dark'));
    await page.setViewportSize({ width: 1440, height: 900 });
    assert.equal(await page.locator('#model-detail .model-verdict .model-badge').evaluate(el => getComputedStyle(el).color), 'rgb(4, 120, 87)');
    await page.locator('#model-dialog-close').click();
    const denied = await page.evaluate(async () => {
      const targets = ['/api/admin/config', '/admin/config', '/admin/model-config.js', '/api/admin/fingerpoint/data'];
      const reads = await Promise.all(targets.map(url => fetch(url).then(response => response.status)));
      const write = await fetch('/api/admin/groups/8/model-runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      return [...reads, write.status];
    });
    assert.deepEqual(denied, [403, 403, 403, 403, 403]);
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
      await page.locator('[data-channel-tab="fingerpoint"]').click();
      await page.locator('[data-fingerprint-detail]').waitFor(); await fit(page);
      assert(await page.locator('[data-channel-tab="fingerpoint"]').evaluate(el => { const rect = el.getBoundingClientRect(); const parent = el.parentElement.getBoundingClientRect(); return rect.right <= parent.right + 1 && rect.left >= parent.left; }));
      if (width === 390) await shot(page, 'mobile-fingerpoint-detail');
      await page.locator('#model-dialog-close').click();
      if (width === 390) await shot(page, 'mobile-model', true);
      await admin.setViewportSize({ width, height: 844 });
      await fit(admin);
      if (width === 390) await shot(admin, 'mobile-config', true);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${preview.baseUrl}/model-results?theme=dark`);
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
    await page.locator('#model-dialog-close').click();
    const iqPage = await userContext.newPage(); watch(iqPage);
    await iqPage.goto(`${preview.baseUrl}/results#model`);
    await iqPage.locator('#group-grid .group-card').first().waitFor();
    await independentPage(iqPage, 'iq');
    for (const width of [390, 320]) {
      await iqPage.setViewportSize({ width, height: 844 });
      await fit(iqPage);
      if (width === 390) await shot(iqPage, 'mobile-iq', true);
    }
    await iqPage.setViewportSize({ width: 1440, height: 900 });
    setEnabled(false, true);
    await refreshPage(iqPage, 'iq');
    await iqPage.getByText('暂无可查看的降智检测分组', { exact: true }).waitFor();
    await independentPage(iqPage, 'iq');
    await refreshPage(page, 'model');
    await page.locator('#model-grid .model-card').first().waitFor();
    assert.match(await page.locator('#model-grid').innerText(), /尚无检测结果/);
    await fit(page); await shot(page, 'model-only');
    await page.locator('[data-model-open="8"][data-model-channel="bazaarlink"]').click();
    await page.locator('#model-detail .items-table').waitFor();
    setEnabled(true, false);
    await refreshPage(page, 'model');
    await page.getByText('暂无可查看的模型检测分组', { exact: true }).waitFor();
    assert.equal(await page.locator('#model-dialog').evaluate(el => el.open), false);
    assert.equal(await page.locator('[data-channel-note]').count(), 0);
    await independentPage(page, 'model');
    await refreshPage(iqPage, 'iq');
    await iqPage.locator('#group-grid .group-card').first().waitFor();
    await fit(iqPage); await shot(iqPage, 'iq-only');
    setEnabled(true, true);
    await refreshPage(page, 'model');
    const originalPlatform = preview.runtime.modelStore.platform('openai');
    const originalAnthropic = preview.runtime.modelStore.platform('anthropic');
    const restrictedPlatform = structuredClone(originalPlatform);
    restrictedPlatform.channels.cctest.enabled = false;
    const updatePlatform = preview.runtime.store.db.prepare('UPDATE model_platforms SET config_json=? WHERE platform=?');
    updatePlatform.run(JSON.stringify(restrictedPlatform), 'openai');
    await refreshPage(page, 'model');
    assert.equal(await page.locator('#model-grid [data-platform="openai"] [data-model-channel="cctest"]').count(), 0);
    assert.equal(await page.locator('#model-grid [data-platform="openai"] [data-model-channel="fingerpoint"]').count(), 1);
    assert.equal(await page.locator('[data-channel-note="cctest"]').count(), 1, 'another visible platform still enables CCTest');
    const restrictedAnthropic = structuredClone(originalAnthropic);
    restrictedAnthropic.channels.cctest.enabled = false;
    updatePlatform.run(JSON.stringify(restrictedAnthropic), 'anthropic');
    await refreshPage(page, 'model');
    assert.equal(await page.locator('[data-channel-note="cctest"]').count(), 0);
    assert.equal(await page.locator('[data-channel-note]').count(), 2);
    updatePlatform.run(JSON.stringify(originalPlatform), 'openai');
    updatePlatform.run(JSON.stringify(originalAnthropic), 'anthropic');
    await refreshPage(page, 'model');
    assert.equal(await page.locator('[data-channel-note]').count(), 3, 'enabled channels show introductions even without history');
    await iqPage.route('**/api/results', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"message":"Temporary failure"}}' }));
    await refreshPage(iqPage, 'iq', 503);
    await refreshPage(page, 'model');
    await independentPage(page, 'model');
    assert.equal(await page.locator('#model-grid .model-card').count(), 2);
    await iqPage.unroute('**/api/results');
    await iqPage.locator('#group-grid .detect-button').first().click();
    await iqPage.frameLocator('#result-detail iframe').locator('svg').waitFor();
    setEnabled(false, true);
    await refreshPage(iqPage, 'iq');
    assert.equal(await iqPage.locator('#result-dialog').evaluate(el => el.open), false);
    setEnabled(false, false);
    await refreshPage(page, 'model');
    await page.getByText('暂无可查看的模型检测分组', { exact: true }).waitFor();
    await independentPage(page, 'model');
    await independentPage(iqPage, 'iq');
    await fit(page); await shot(page, 'no-configured-groups');
    setEnabled(true, true);
    await refreshPage(page, 'model');
    await page.route('**/api/model-results', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"message":"Model service unavailable"}}' }));
    await page.reload();
    await page.locator('#error-view:not([hidden])').waitFor();
    assert.match(await page.locator('#error-message').innerText(), /Model service unavailable/);
    assert.equal(await page.locator('#model-grid .model-card').count(), 0);
    await page.unroute('**/api/model-results');
    await page.locator('#retry-button').click();
    await page.locator('#model-grid .model-card').first().waitFor();
    await page.locator('[data-model-open="8"][data-model-channel="fingerpoint"]').click();
    await page.locator('[data-fingerprint-detail]').waitFor();
    await page.route('**/api/model-results', route => route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":{"message":"Expired"}}' }));
    await refreshPage(page, 'model', 401);
    await page.locator('#error-view:not([hidden])').waitFor();
    assert.equal(await page.locator('#model-dialog').evaluate(el => el.open), false);
    assert.equal(await page.locator('#model-grid .model-card, [data-channel-note], #model-detail > *').count(), 0);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('degradation-detector.session')), null);
    await page.unroute('**/api/model-results');
    await page.locator('#retry-button').click();
    await page.locator('#model-grid .model-card').first().waitFor();
    await independentPage(page, 'model');
    assert(resultRequests.some(item => item.page === '/results' && item.api === '/api/results'));
    assert(resultRequests.some(item => item.page === '/model-results' && item.api === '/api/model-results'));
    for (const item of resultRequests) {
      if (item.page === '/results') assert(!item.api.startsWith('/api/model-results'), 'IQ page must not read model results');
      if (item.page === '/model-results') assert(!item.api.startsWith('/api/results'), 'model page must not read IQ results');
    }
    assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(preview.outboundCalls, 0);
    console.log(JSON.stringify({ status: 'PASS', checks: 'Independent IQ/model pages and result requests, no detection-type tabs or fallback, platform sections and dynamically enabled-channel introductions across platforms, official site links, three-channel config and per-group models, Fingerpoint max effort, full rankings/rounds/samples/versions, null analyses, mocked background data updates/history, independent schedules and manual runs, all original probe items/scores/audit rounds, IQ previews/source/history, disabled-group dialog revocation, read-only permissions and expired-session clearing, retry, mobile 390/320, dark mode, escaping and zero paid calls', screenshots: directory, pageErrors: errors, externalRequests: external }, null, 2));
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
