'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { startPreview } = require('./domain-access-live-preview.cjs');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sub2api-domain-formal-browser-'));
  const preview = await startPreview({ port: 0, now: Date.parse('2026-11-13T07:00:00Z') });
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    for (const [name,width,height] of [['desktop',1440,1000],['wide',1920,1080],['tablet',1024,900],['mobile',390,844],['narrow',320,740]]) {
      const context = await browser.newContext({ viewport: { width,height }, acceptDownloads: true });
      try {
        const page = await context.newPage(), errors = [], external = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('request', request => { if (!request.url().startsWith(`http://127.0.0.1:${preview.port}/`) && !request.url().startsWith('blob:') && !request.url().startsWith('data:')) external.push(request.url()); });
        const waitIdle = () => page.waitForFunction(() => document.getElementById('da-root').getAttribute('aria-busy') === 'false');
        const load = async action => {
          const response = page.waitForResponse(value => value.url().includes('/api/domain-access/report?') && value.ok());
          await action(); await response; await waitIdle();
        };
        const layout = async () => {
          const result = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1,
            metrics: [...document.querySelectorAll('.da-metric')].some(node => node.scrollWidth > node.clientWidth + 1),
            controls: [...document.querySelectorAll('#da-root button,#da-root input,#da-root select')].filter(node => node.getBoundingClientRect().width && !node.closest('.table-wrap,dialog,.da-tabs')).filter(node => node.getBoundingClientRect().right > innerWidth + 1).map(node => node.outerHTML) }));
          assert.equal(result.overflow,false,`${name} page overflow`); assert.equal(result.metrics,false); assert.deepEqual(result.controls,[]);
        };
        await page.goto(`http://127.0.0.1:${preview.port}/preview`); await page.locator('#da-user-table tbody tr').first().waitFor(); await waitIdle();
        assert.equal(await page.locator('#da-user-table tbody tr').count(),20);
        assert.match(await page.locator('#da-metrics').innerText(),/25/);
        await layout(); await page.screenshot({ path: path.join(directory,`${name}-users.png`),fullPage:true });
        assert(await page.locator('#da-chart canvas').count() > 0);
        const canvas = await page.locator('#da-chart canvas').evaluate(canvas => { const bytes = canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data; let colored = 0; for (let i=3;i<bytes.length;i+=4) if (bytes[i]) colored++; return colored; });
        assert(canvas > 500,'chart must render pixels');
        await page.locator('[data-da-select]').first().check();
        await load(() => page.locator('[data-da-page="2"]').click());
        await page.locator('[data-da-select]').first().check(); assert.match(await page.locator('#da-selection').innerText(),/2 位/);
        await page.locator('#da-create').click(); await page.locator('#da-draft-title').fill(`域名迁移 ${name}`);
        await page.locator('#da-draft-content').fill('请更换域名。<img src="https://untrusted.example/pixel">');
        await page.locator('[data-da-editor=preview]').click(); assert.equal(await page.locator('#da-draft-preview img').count(),0);
        await page.screenshot({ path:path.join(directory,`${name}-draft.png`) });
        await load(() => page.locator('#da-save-draft').click());
        await page.waitForFunction(() => document.getElementById('da-drafts').textContent.includes('已生成草稿'));
        assert(!preview.fixture.messageStore.items().some(row => row.status === 'active'));
        await load(() => page.locator('#da-tab-users').click());
        await load(() => page.locator('#da-users-filter [name=search]').fill('user2@example.com'));
        assert.equal(await page.locator('#da-user-table [data-da-user]').count(),2);
        await page.locator('#da-user-table [data-da-user]').first().click(); await page.locator('#da-detail-dialog[open]').waitFor();
        await page.locator('[data-da-detail-tab=evidence]').click(); assert.match(await page.locator('#da-detail-body').innerText(),/网关/);
        await page.locator('[data-da-detail-tab=overview]').click(); await page.locator('[data-da-notify-user]').click();
        await page.locator('#da-notify-note').fill('本地测试：已人工联系');
        await load(() => page.locator('#da-notify-form [type=submit]').click());
        assert.match(await page.locator('#da-user-table').innerText(),/已通知/);
        const downloadEvent = page.waitForEvent('download'); await page.locator('[data-da-action=export]').click(); const download = await downloadEvent;
        const exported = await download.path(); assert(fs.readFileSync(exported,'utf8').includes('user2@example.com'));
        await load(() => page.locator('[data-da-action=reset]').click());
        await load(() => page.locator('#da-users-filter [name=search]').fill('NO_SUCH_USER'));
        assert.match(await page.locator('#da-user-table').innerText(),/没有记录/);
        await load(() => page.locator('[data-da-action=reset]').click());
        await load(() => page.locator('#da-tab-requests').click());
        await load(() => page.locator('#da-requests-filter [name=identity]').selectOption('ambiguous'));
        assert.equal(await page.locator('#da-request-table tbody tr').count(),1);
        await page.locator('#da-request-table [data-da-request]').first().click(); await page.locator('#da-detail-dialog[open]').waitFor();
        assert.match(await page.locator('#da-detail-body').innerText(),/多个身份/);
        assert.equal(await page.locator('#da-detail-body [data-da-compose-user]').count(),0);
        await page.keyboard.press('Escape');
        await load(() => page.locator('#da-tab-history').click()); assert.match(await page.locator('#da-history').innerText(),/Referer 线索/);
        await load(() => page.locator('#da-tab-collection').click());
        assert.match(await page.locator('#da-collection').innerText(),/读取正常/);
        await layout(); await page.screenshot({ path:path.join(directory,`${name}-collection.png`),fullPage:true });
        await page.locator('#da-settings-form [name=rawDays]').fill('45');
        await load(() => page.locator('#da-settings-form [type=submit]').click());
        assert.equal(preview.fixture.service.settings().rawDays,45);
        preview.fixture.service.collector.directory = null;
        await load(() => page.locator('#refresh-button').click()); assert.match(await page.locator('#da-status').innerText(),/尚未配置/);
        preview.fixture.service.collector.directory = preview.fixture.logDir;
        await load(() => page.locator('#da-tab-users').click());
        await page.locator('#da-user-table [data-da-user]').first().click(); await page.locator('#da-detail-dialog[open]').waitFor();
        await page.locator('[data-da-close=detail-dialog]').click();
        await page.locator('#logout-button').click(); await page.locator('#login-view').waitFor({state:'visible'});
        assert.equal(await page.locator('#da-user-table tbody tr').count(),0,'logout clears sensitive rows');
        assert.equal(await page.locator('#da-root dialog[open]').count(),0);
        assert.deepEqual(errors,[]); assert.deepEqual(external,[]);
        console.log(JSON.stringify({ name,width,passed:true }));
      } finally { await context.close(); }
    }
  } finally { await browser?.close(); await preview.stop(); }
  console.log(`Screenshots: ${directory}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
