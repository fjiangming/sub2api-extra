'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPreview } = require('./preview.cjs');
let playwright;
try { playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright'); }
catch { playwright = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }

const readConfig = page => page.evaluate(() => JSON.parse(localStorage.getItem('degradation-multi-provider-demo-v1')));
const fit = async page => {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'page must fit its viewport');
  if (await page.locator('dialog[open]').count()) assert(await page.locator('dialog[open]').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth), 'dialog must not overflow');
};

async function main() {
  const preview = await createPreview(0);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sub2api-multi-demo-check-'));
  const candidates = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'];
  const executablePath = candidates.find(candidate => candidate && fs.existsSync(candidate));
  let browser;
  const errors = [];
  const external = [];
  try {
    browser = await playwright.chromium.launch({ ...(executablePath ? { executablePath } : { channel: 'chrome' }), headless: true });
    for (const layout of [
      { name: 'desktop', width: 1440, height: 1000, colorScheme: 'light' },
      { name: 'mobile', width: 390, height: 844, colorScheme: 'light' },
      { name: 'narrow', width: 320, height: 780, colorScheme: 'light' },
      { name: 'dark', width: 1440, height: 1000, colorScheme: 'dark' },
    ]) {
      const context = await browser.newContext({ viewport: { width: layout.width, height: layout.height }, colorScheme: layout.colorScheme, locale: 'zh-CN', reducedMotion: 'reduce' });
      await context.route('**/*', route => {
        if (!/^https?:/.test(route.request().url()) || route.request().url().startsWith(preview.url + '/')) return route.continue();
        external.push(route.request().url()); return route.abort();
      });
      const page = await context.newPage();
      page.setDefaultTimeout(12000);
      page.on('pageerror', error => errors.push(`${layout.name}: ${error.message}`));
      const shot = async name => { await fit(page); await page.screenshot({ path: path.join(directory, `${layout.name}-${name}.png`), fullPage: true }); };
      const save = async () => { await page.locator('[data-save]').click(); assert.equal(await page.locator('#save-state').innerText(), '配置已保存'); };
      await page.goto(preview.url + '/results');
      assert.equal(await page.locator('.group-card').count(), 12);
      assert.equal(await page.locator('[data-provider="manxue"]').getAttribute('aria-selected'), 'true');
      assert.equal(await page.locator('[data-kind="candy"]').getAttribute('aria-selected'), 'true');
      assert.equal(await page.locator('[data-run], [data-save], [data-group-edit]').count(), 0, 'results must have no admin controls');
      const counts = await page.locator('.group-card').evaluateAll(cards => cards.map(card => {
        const passed = card.querySelectorAll('.bar.passed').length;
        const failed = card.querySelectorAll('.bar.incorrect').length;
        return [card.querySelector('.card-footer b').textContent, `${(passed / (passed + failed) * 100).toFixed(1)}%`];
      }));
      for (const [shown, actual] of counts) assert.equal(shown, actual, 'errors must be excluded from the pass rate');
      const colors = await page.locator('.bar.passed').first().evaluate(element => getComputedStyle(element).backgroundColor.match(/\d+/g).map(Number));
      assert(colors[1] > colors[0] && colors[1] > colors[2], 'passing bars must be green');
      await shot('candy');

      await page.locator('[data-card="g3"] .bar.incorrect').last().click();
      assert.equal(await page.locator('.detail-content .result-heading .status').innerText(), '答案不符');
      assert.equal(await page.locator('.answer-code').innerText(), '8');
      await page.locator('.prompt-section summary').click();
      assert.match(await page.locator('.prompt-section pre').innerText(), /演示题目/);
      await shot('candy-detail');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('dialog[open]').count(), 0);

      await page.locator('[data-kind="pelican"]').click();
      assert.equal(await page.locator('.group-card').count(), 12);
      assert.equal(await page.locator('[data-card="g3"] .card-heading .status').innerText(), '疑似降智');
      await page.locator('[data-card="g1"] .card-footer button').click();
      await page.frameLocator('.artwork').locator('svg').waitFor();
      assert(await page.frameLocator('.artwork').locator('svg').getAttribute('aria-label'));
      const source = await page.locator('.artwork-source').textContent();
      assert.equal(source, fs.readFileSync(path.join(__dirname, 'pelican.html'), 'utf8'));
      await shot('pelican-detail');
      await page.locator('[data-close]').click();
      await page.locator('[data-kind="candy"]').click();
      await page.locator('[data-filter="query"]').fill('does-not-exist');
      assert.equal(await page.locator('.group-card').count(), 0);
      await page.locator('[data-filter="query"]').fill('');
      await page.locator('[data-filter="platform"]').selectOption('Claude');
      assert.equal(await page.locator('.group-card').count(), 4);
      await page.locator('[data-filter="platform"]').selectOption('all');

      await page.locator('[data-provider="testllm"]').click();
      assert.equal(await page.locator('.llm-row').count(), 16);
      assert.equal(await page.locator('.result-table th').count(), 6);
      assert.equal(await page.locator('[data-row="c1"] td').nth(2).locator('.metric-main').innerText(), '0%');
      assert.equal(await page.locator('[data-row="c2"] td').nth(2).locator('.metric-main').innerText(), '未取得');
      assert.equal(await page.locator('[data-row="c2"] .status').innerText(), '检测异常');
      await shot('testllm');
      await page.locator('[data-row="g1"] [data-detail]').click();
      assert.equal(await page.locator('.history-entry').count(), 12);
      assert.match(await page.locator('.detail-content').innerText(), /智商一般/);
      await page.locator('[data-history-record="1"]').click();
      assert.equal(await page.locator('.history-entry.active').getAttribute('data-history-record'), '1');
      await shot('testllm-history');
      await page.keyboard.press('Escape');
      await page.locator('[data-filter="platform"]').selectOption('GPT');
      assert.equal(await page.locator('.llm-row').count(), 9);
      await page.locator('[data-filter="platform"]').selectOption('Claude');
      assert.equal(await page.locator('.llm-row').count(), 7);
      await page.locator('[data-filter="status"]').selectOption('issue');
      assert.equal(await page.locator('.llm-row').count(), 1);

      await page.locator('[data-preview="admin"]').click();
      await page.locator('[data-setting="model"]').fill('gpt-demo-default');
      await page.locator('[data-setting="effort"]').selectOption('high');
      await page.locator('[data-kind="pelican"]').click();
      assert.equal(await page.locator('[data-setting="model"]').inputValue(), 'gpt-6-astra');
      assert.equal(await page.locator('[data-setting="effort"]').inputValue(), 'medium');
      await page.locator('[data-kind="candy"]').click();
      assert.equal(await page.locator('[data-setting="model"]').inputValue(), 'gpt-demo-default');
      await save();
      await page.reload();
      assert.equal(await page.locator('[data-setting="model"]').inputValue(), 'gpt-demo-default');
      await shot('admin');
      await page.locator('[data-setting="timeout"]').fill('0');
      await page.locator('[data-save]').click();
      assert.match(await page.locator('#toast').innerText(), /30–900/);
      assert.equal((await readConfig(page)).channels.candy.timeout, 180, 'invalid config must not be saved');
      await page.locator('[data-setting="timeout"]').fill('180');
      await save();

      await page.locator('#admin-groups').click();
      await page.locator('[data-group-toggle="g2"]').uncheck();
      await page.locator('[data-group-edit="g1"]').click();
      await page.locator('#override-enabled').check();
      await page.locator('[data-setting="group-model"]').fill('gpt-demo-override');
      await page.locator('[data-setting="group-effort"]').selectOption('max');
      await page.locator('#group-key').fill('demo-secret-must-not-persist');
      const positions = await page.locator('#group-form').evaluate(form => ({ input: form.querySelector('#group-key').getBoundingClientRect().bottom, footer: form.querySelector('.dialog-footer').getBoundingClientRect().top }));
      assert(positions.input <= positions.footer, 'group controls must not cover the key field');
      await shot('group-editor');
      await page.locator('#group-form button[type="submit"]').click();
      assert.equal(await page.locator('[data-config-group="g1"] [data-run]').isDisabled(), true);
      await save();
      assert.equal((await readConfig(page)).channels.candy.groups.g1.override.model, 'gpt-demo-override');
      assert(!(await page.evaluate(() => JSON.stringify(localStorage))).includes('demo-secret-must-not-persist'));
      await page.reload();
      await page.locator('#admin-groups').click();
      assert.equal(await page.locator('[data-config-group="g1"] .mono').innerText(), 'gpt-demo-override');
      assert.equal(await page.locator('[data-group-toggle="g2"]').isChecked(), false);
      await shot('groups');
      await page.locator('[data-kind="pelican"]').click();
      assert.equal(await page.locator('[data-group-toggle="g2"]').isChecked(), true, 'group selection must be independent');
      assert.equal(await page.locator('[data-config-group="g1"] .mono').innerText(), 'gpt-6-astra');
      await page.locator('[data-provider="testllm"]').click();
      assert.equal(await page.locator('[data-config-group]').count(), 16);
      await page.locator('#admin-providers').click();
      assert.equal(await page.locator('[data-setting="model"]').isDisabled(), true);
      await page.locator('[data-setting="modelSource"]').selectOption('default');
      await page.locator('[data-setting="model"]').fill('gpt-iq-default');
      await save();
      await page.locator('#admin-groups').click();
      assert.equal(await page.locator('[data-config-group="g1"] .mono').innerText(), 'gpt-iq-default');
      await page.locator('#admin-providers').click();
      await page.locator('[data-setting="modelSource"]').selectOption('group');
      await save();
      await shot('admin-testllm');

      await page.locator('#admin-schedule').click();
      await page.locator('[data-plan-mode="daily"][data-plan-channel="candy"]').click();
      await page.locator('[data-add-time="candy"]').click();
      assert.equal(await page.locator('[data-plan-row="candy"] [data-plan-time]').count(), 3);
      await page.locator('[data-plan-time="2"][data-plan-channel="candy"]').fill('09:00');
      await page.locator('[data-save]').click();
      assert.match(await page.locator('#toast').innerText(), /重复/);
      await page.locator('[data-plan-time="2"][data-plan-channel="candy"]').fill('15:30');
      await page.locator('[data-plan-interval="iq"]').fill('120');
      await page.locator('[data-plan-enabled="pelican"]').uncheck();
      await save();
      const config = await readConfig(page);
      assert.deepEqual(config.channels.candy.schedule.times, ['09:00', '21:00', '15:30']);
      assert.equal(config.channels.iq.schedule.interval, 120);
      assert.equal(config.channels.pelican.schedule.enabled, false);
      await shot('schedule');
      await page.locator('[data-plan-row="iq"] [data-run]').click();
      assert.equal(await page.locator('[data-plan-row="iq"] [data-run]').isDisabled(), true);
      await page.waitForFunction(() => !document.querySelector('#run-status').textContent.includes('正在执行'));
      assert.equal((await readConfig(page)).logs.length, 1);
      assert.equal((await readConfig(page)).logs[0].count, 16);
      await shot('run-receipt');

      await page.locator('[data-preview="results"]').click();
      await page.locator('[data-provider="manxue"]').click();
      assert.equal(await page.locator('.group-card').count(), 11, 'saved group selection must affect results');
      await page.locator('[data-card="g1"] .card-footer button').click();
      assert.match(await page.locator('#dialog-subtitle').innerText(), /糖果检测/);
      assert.match(await page.locator('.detail-note').innerText(), /gpt-6-astra/, 'history must retain its original model');
      await page.locator('[data-close]').click();
      await page.locator('[data-kind="pelican"]').click();
      assert.equal(await page.locator('.group-card').count(), 12);
      await fit(page);
      await context.close();
      console.log(`${layout.name}: passed`);
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    const response = await fetch(preview.url + '/api/admin/config', { method: 'POST', body: '{}' });
    assert.equal(response.status, 405);
    assert.equal((await fetch(preview.url + '/api/results')).status, 404);
    console.log(`Four layouts passed; no page errors or external requests. Screenshots: ${directory}`);
  } finally {
    await browser?.close();
    preview.server.closeAllConnections();
    await new Promise(resolve => preview.server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
