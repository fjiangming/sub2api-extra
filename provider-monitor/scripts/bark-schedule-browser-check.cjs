const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { startPreview } = require('./bark-schedule-preview.cjs');

async function checkLayout(page) {
  const problems = await page.evaluate(() => {
    const dialog = document.querySelector('#notification-dialog');
    const controls = [...dialog.querySelectorAll('label, input, select, button')]
      .filter((node) => node.getBoundingClientRect().width && !node.closest('[hidden]'))
      .filter((node) => node.getBoundingClientRect().right > innerWidth + 1 ||
        node.getBoundingClientRect().left < 0)
      .map((node) => node.outerHTML);
    return { overflow: document.documentElement.scrollWidth > innerWidth + 1,
      dialogOverflow: dialog.scrollWidth > dialog.clientWidth + 1, controls };
  });
  assert.deepEqual(problems, { overflow: false, dialogOverflow: false, controls: [] });
}

async function main() {
  const directory = process.env.BARK_SCHEDULE_QA_DIR || path.join(os.tmpdir(), 'provider-bark-schedule-qa');
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
      const external = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/*', (route) => {
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
        await page.locator('[data-view=settings]').click();
        const edit = page.locator('[data-action=edit-channel]').first();
        const form = page.locator('#notification-form');
        const save = form.locator('button[type=submit]');
        await edit.click();
        assert.equal(await form.locator('[name=barkLevel]').inputValue(), 'timeSensitive');
        assert.equal(await form.locator('[name=barkScheduleEnabled]').isChecked(), false);
        assert.equal(await form.locator('[data-bark-schedule]').isVisible(), false);
        assert.equal(await form.locator('[name=barkDeviceKey]').inputValue(), '');
        await form.locator('[name=barkLevel]').selectOption('active');
        await form.locator('[name=barkScheduleEnabled]').check();
        assert.equal(await form.locator('[name=barkScheduleTimezone]').inputValue(), 'Asia/Shanghai');
        const rows = form.locator('[data-bark-period]');
        assert.equal(await rows.count(), 1);
        assert.equal(await rows.first().locator('[data-bark-period-start]').inputValue(), '22:00');
        assert.equal(await rows.first().locator('[data-bark-period-end]').inputValue(), '08:00');
        assert.equal(await rows.first().locator('[data-bark-period-level]').inputValue(), 'critical');
        assert.equal(await rows.first().locator('[data-bark-remove-period]').isDisabled(), true);
        await form.locator('[name=barkScheduleTimezone]').fill('invalid/timezone');
        await save.click();
        await page.waitForFunction(() => document.querySelector('#notification-error').textContent.includes('时区无效'));
        await form.locator('[name=barkScheduleTimezone]').fill('Asia/Shanghai');
        await form.locator('[data-bark-add-period]').click();
        assert.equal(await rows.count(), 2);
        assert.equal(await rows.last().locator('[data-bark-period-start]').evaluate((node) => node.checkValidity()), false);
        await rows.last().locator('[data-bark-period-start]').fill('08:00');
        await rows.last().locator('[data-bark-period-end]').fill('23:00');
        await rows.last().locator('[data-bark-period-level]').selectOption('active');
        await save.click();
        await page.waitForFunction(() => document.querySelector('#notification-error').textContent.includes('不能重叠'));
        assert.equal(await rows.last().locator('[data-bark-period-end]').inputValue(), '23:00');
        assert.equal(preview.app.locals.services.notifications.listChannels()[0].config.levelSchedule, undefined);
        await rows.last().locator('[data-bark-period-end]').fill('22:00');
        await checkLayout(page);
        await rows.first().scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(directory, `${name}-schedule.png`) });
        await save.click();
        await page.waitForSelector('#notification-dialog:not([open])', { state: 'attached' });
        const channel = preview.app.locals.services.notifications.listChannels()[0];
        assert.equal(channel.config.level, 'active');
        assert.deepEqual(channel.config.levelSchedule, { enabled: true, timezone: 'Asia/Shanghai', periods: [
          { start: '22:00', end: '08:00', level: 'critical' },
          { start: '08:00', end: '22:00', level: 'active' }
        ] });
        for (const [instant, level] of [
          ['2026-11-11T04:00:00Z', 'active'],
          ['2026-11-11T14:00:00Z', 'critical'],
          ['2026-11-11T16:00:00Z', 'critical'],
          ['2026-11-12T00:00:00Z', 'active']
        ]) {
          preview.setNow(instant);
          await Promise.all([
            page.waitForResponse((response) => response.url().endsWith('/test') && response.status() === 200),
            page.locator('[data-action=test-channel]').first().click()
          ]);
          assert.equal(preview.requests.at(-1).level, level);
        }
        await page.reload();
        await page.waitForSelector('#app-shell:not([hidden])');
        await page.locator('[data-view=settings]').click();
        await edit.click();
        assert.equal(await form.locator('[name=barkScheduleEnabled]').isChecked(), true);
        assert.equal(await rows.count(), 2);
        assert.equal(await form.locator('[name=barkDeviceKey]').inputValue(), '');
        await rows.last().locator('[data-bark-remove-period]').click();
        assert.equal(await rows.count(), 1);
        await rows.first().locator('[data-bark-period-end]').fill('22:00');
        await save.click();
        await page.waitForFunction(() => document.querySelector('#notification-error').textContent.includes('不能相同'));
        await rows.first().locator('[data-bark-period-end]').fill('08:00');
        await form.locator('[name=barkScheduleEnabled]').uncheck();
        assert.equal(await form.locator('[data-bark-schedule]').isVisible(), false);
        assert.equal(await form.locator('[name=barkScheduleTimezone]').isDisabled(), true);
        await save.click();
        await page.waitForSelector('#notification-dialog:not([open])', { state: 'attached' });
        assert.equal(preview.app.locals.services.notifications.listChannels()[0].config.levelSchedule.enabled, false);
        preview.setNow('2026-11-12T14:00:00Z');
        await Promise.all([
          page.waitForResponse((response) => response.url().endsWith('/test') && response.status() === 200),
          page.locator('[data-action=test-channel]').first().click()
        ]);
        assert.equal(preview.requests.at(-1).level, 'active');
        await edit.click();
        await form.locator('[name=barkScheduleEnabled]').check();
        assert.equal(await rows.first().locator('[data-bark-period-end]').inputValue(), '08:00');
        await form.locator('[name=type]').selectOption('webhook');
        assert.equal(await form.locator('[name=barkScheduleTimezone]').isDisabled(), true);
        await form.locator('[name=type]').selectOption('bark');
        assert.equal(await form.locator('[name=barkScheduleTimezone]').isDisabled(), false);
        if (name === 'desktop') {
          for (let index = 1; index < 24; index += 1) await form.locator('[data-bark-add-period]').click();
          assert.equal(await rows.count(), 24);
          assert.equal(await form.locator('[data-bark-add-period]').isDisabled(), true);
          for (let index = 24; index > 1; index -= 1) await rows.last().locator('[data-bark-remove-period]').click();
          assert.equal(await form.locator('[data-bark-add-period]').isDisabled(), false);
        }
        await checkLayout(page);
        await save.click();
        await page.waitForSelector('#notification-dialog:not([open])', { state: 'attached' });
        await page.locator('[data-action=add-channel]').click();
        await form.locator('[name=name]').fill('新分时段 iPhone');
        await form.locator('[name=type]').selectOption('bark');
        assert.equal(await form.locator('[name=barkDeviceKey]').evaluate((node) => node.checkValidity()), false);
        await form.locator('[name=barkDeviceKey]').fill('new-preview-device-key');
        await form.locator('[name=barkEndpoint]').fill(channel.config.endpoint);
        await form.locator('[name=barkScheduleEnabled]').check();
        await rows.first().locator('[data-bark-period-start]').fill('21:00');
        await form.locator('[name=barkScheduleEnabled]').uncheck();
        await save.click();
        await page.waitForSelector('#notification-dialog:not([open])', { state: 'attached' });
        const newChannel = preview.app.locals.services.notifications.listChannels().find((item) => item.name === '新分时段 iPhone');
        assert.equal(newChannel.config.levelSchedule.enabled, false);
        assert.equal(newChannel.config.levelSchedule.periods[0].start, '21:00');
        await page.locator('tr').filter({ hasText: '新分时段 iPhone' }).locator('[data-action=edit-channel]').click();
        assert.equal(await form.locator('[name=barkDeviceKey]').inputValue(), '');
        await form.locator('[name=barkScheduleEnabled]').check();
        assert.equal(await rows.first().locator('[data-bark-period-start]').inputValue(), '21:00');
        await checkLayout(page);
        await form.locator('[data-dialog-close]').last().click();
        assert.deepEqual(errors, []);
        assert.deepEqual(external, []);
        console.log(`${name}: schedule editing, validation, persistence, send-time levels and layout passed`);
      } finally { await context.close(); await preview.close(); }
    }
    console.log(`Screenshots: ${directory}`);
  } finally { await browser.close(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
