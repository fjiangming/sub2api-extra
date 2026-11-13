'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { startPreview } = require('./domain-access-preview.cjs');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sub2api-domain-demo-'));
  const preview = await startPreview({ port: 0 });
  const origin = `http://127.0.0.1:${preview.port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    for (const [name, width, height, colorScheme] of [['desktop', 1440, 1000, 'light'], ['wide', 1920, 1080, 'light'], ['tablet', 1024, 900, 'light'], ['mobile', 390, 844, 'light'], ['narrow', 320, 740, 'light'], ['dark', 1440, 1000, 'dark']]) {
      const context = await browser.newContext({ viewport: { width, height }, colorScheme });
      try {
        const page = await context.newPage();
        const errors = [], external = [], businessRequests = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('request', request => {
          if (!request.url().startsWith(origin)) external.push(request.url());
          if (['xhr', 'fetch'].includes(request.resourceType()) || new URL(request.url()).pathname.startsWith('/api/')) businessRequests.push(request.url());
        });
        await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
        await page.goto(origin);
        await page.locator('[data-user-row]').first().waitFor();
        const layout = async () => {
          const result = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1,
            escaped: [...document.querySelectorAll('button,input,select,textarea')].filter(node => node.getBoundingClientRect().width && !node.closest('[hidden],.table-wrap,.da-small-table,.module-tabs,.da-tabs,dialog:not([open])')).filter(node => {
              const bounds = node.getBoundingClientRect(); return bounds.right > innerWidth + 1 || bounds.left < -1;
            }).map(node => node.id || node.outerHTML.slice(0, 100)),
            modal: [...document.querySelectorAll('dialog[open]')].some(node => { const bounds = node.getBoundingClientRect(); return bounds.width > innerWidth || bounds.left < 0 || bounds.right > innerWidth + 1; }) }));
          assert.equal(result.overflow, false, `${name}: document overflow`);
          assert.deepEqual(result.escaped, [], `${name}: controls outside viewport`);
          assert.equal(result.modal, false, `${name}: modal overflow`);
        };
        assert.equal(await page.locator('[data-user-row]').count(), 10);
        assert.match(await page.locator('#metrics').innerText(), /24/);
        assert.match(await page.locator('#metrics').innerText(), /12/);
        assert.match(await page.locator('#metrics').innerText(), /49/);
        const pixels = await page.locator('#trend canvas').first().evaluate(canvas => {
          const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
          let visible = 0; for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) visible++;
          return visible;
        });
        assert(pixels > 500, `${name}: chart is blank`);
        await layout();
        await page.screenshot({ path: path.join(directory, `${name}-users.png`), fullPage: true });
        await page.screenshot({ path: path.join(directory, `${name}-viewport.png`) });

        if (!['desktop', 'mobile', 'narrow'].includes(name)) {
          assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(businessRequests, []);
          console.log(JSON.stringify({ name, status: 'visual checks passed', chartPixels: pixels }));
          continue;
        }

        await page.locator('#migration-filter').selectOption('new');
        assert.equal(await page.locator('[data-user-row]').count(), 8);
        await page.locator('#migration-filter').selectOption('inactive');
        assert.equal(await page.locator('[data-user-row]').count(), 4);
        await page.locator('#reset-filters').click();
        await page.locator('#user-search').fill('linyuan@example.com');
        await page.waitForFunction(() => document.querySelectorAll('[data-user-row]').length === 1);
        assert.match(await page.locator('#user-rows').innerText(), /林远/);
        await page.locator('#user-search').fill('no-match@example.com');
        await page.locator('#empty-reset').waitFor();
        assert.equal(await page.locator('#create-draft').isDisabled(), true);
        await page.locator('#empty-reset').click();
        await page.locator('#sort').selectOption('id');
        await page.locator('[data-user-row="1001"] [data-user]').first().click();
        await page.locator('#detail-dialog[open]').waitFor();
        await page.locator('[data-detail-tab=evidence]').click();
        assert.match(await page.locator('#detail-body').innerText(), /Key #4001/);
        await layout();
        await page.screenshot({ path: path.join(directory, `${name}-user-evidence.png`) });
        await page.locator('[data-detail-tab=overview]').click();
        await page.locator('[data-back-user="1001"]').first().click();
        assert.match(await page.locator('#detail-body').innerText(), /上游尝试/);
        await layout();
        await page.locator('#detail-heading [data-user="1001"]').click();
        await page.locator('[data-close=detail-dialog]').click();

        await page.locator('#show-unlinked').click();
        assert.equal(await page.locator('#association-filter').inputValue(), 'unlinked');
        assert.equal(await page.locator('#request-rows [data-user]').count(), 0);
        await page.locator('#association-filter').selectOption('ambiguous');
        await page.locator('#request-rows [data-request]').first().click();
        assert.match(await page.locator('#detail-body').innerText(), /无法唯一确认/);
        assert.equal(await page.locator('#detail-dialog [data-draft-user]').count(), 0);
        await page.screenshot({ path: path.join(directory, `${name}-unlinked.png`) });
        await page.locator('[data-close=detail-dialog]').click();
        await page.locator('#tab-history').click();
        assert.equal(await page.locator('#view-history tbody tr').count(), 5);
        assert.equal(await page.locator('#view-history [data-user]').count(), 0);
        await page.locator('[data-history=history-02]').click();
        assert.match(await page.locator('#detail-body').innerText(), /不能证明/);
        await page.locator('[data-close=detail-dialog]').click();

        await page.locator('#tab-users').click();
        await page.locator('[data-select="1001"]').check();
        await page.locator('#user-pagination [data-direction="1"]').click();
        await page.locator('[data-select="1011"]').check();
        assert.match(await page.locator('#selection-label').innerText(), /2/);
        await page.locator('#user-pagination [data-direction="-1"]').click();
        assert.equal(await page.locator('[data-select="1001"]').isChecked(), true);
        await page.locator('#create-draft').click();
        assert.match(await page.locator('#draft-recipients').innerText(), /林远/);
        assert.match(await page.locator('#draft-recipients').innerText(), /方知/);
        await page.locator('#draft-title').fill('旧域名迁移提醒（演示）');
        await page.locator('#draft-content').fill('请更换为 yunhop.cc，保留原接口路径和 API Key。\n<b>作为文字预览</b>');
        await page.locator('[data-editor=preview]').click();
        assert.match(await page.locator('#draft-preview').innerText(), /<b>作为文字预览<\/b>/);
        assert.equal(await page.locator('#draft-preview b').count(), 0);
        await layout();
        await page.screenshot({ path: path.join(directory, `${name}-draft.png`) });
        await page.locator('#draft-form [type=submit]').click();
        assert.equal(await page.locator('#view-drafts tbody tr').count(), 2);
        await page.reload();
        await page.locator('#tab-drafts').click();
        assert.equal(await page.locator('#view-drafts tbody tr').count(), 2, 'draft survives reload');
        await page.locator('#view-drafts [data-mark-draft]').first().click();
        assert.match(await page.locator('#confirm-body').innerText(), /不发送消息/);
        await page.locator('#confirm-action').click();
        assert.match(await page.locator('#view-drafts tbody tr').first().innerText(), /已标记通知/);
        await page.locator('#tab-users').click();
        await page.locator('#notification-filter').selectOption('notified');
        assert.match(await page.locator('#user-rows').innerText(), /林远/);
        await page.locator('#reset-filters').click();
        const downloading = page.waitForEvent('download');
        await page.locator('#export-users').click();
        const download = await downloading;
        const csvPath = path.join(directory, `${name}-export.csv`);
        await download.saveAs(csvPath);
        const csv = fs.readFileSync(csvPath, 'utf8');
        assert.equal(csv.charCodeAt(0), 0xfeff);
        assert.match(csv, /linyuan@example.com/);
        assert.equal(csv.split('\r\n').length, 25);

        await page.locator('#domain').selectOption('aihub.fo2.us.ci');
        assert.equal(await page.locator('[data-user-row]').count(), 8);
        await page.locator('#domain').selectOption('epoint2api.fjmooo.cn');
        await page.locator('[data-preset="1"]').click();
        assert.equal(await page.locator('#start').inputValue(), '2026-11-13');
        await page.locator('[data-preset="30"]').click();
        assert.equal(await page.locator('#start').inputValue(), '2026-10-15');
        await page.locator('[data-preset="7"]').click();
        await page.locator('#end').fill('2026-11-05');
        await page.locator('#end').dispatchEvent('change');
        assert.equal(await page.locator('#date-error').isVisible(), true);
        await page.locator('[data-preset="7"]').click();
        assert.equal(await page.locator('#date-error').isVisible(), false);
        await page.locator('#scenario').selectOption('unconfigured');
        assert.equal(await page.locator('[data-user-row]').count(), 0);
        assert.equal(await page.locator('#export-users').isDisabled(), true);
        assert.match(await page.locator('#user-rows').innerText(), /尚未接入/);
        assert.equal(await page.locator('#trend-empty').isVisible(), true);
        await page.locator('#tab-history').click();
        assert.equal(await page.locator('#view-history tbody tr').count(), 5);
        await page.locator('#scenario').selectOption('interrupted');
        await page.locator('#tab-collection').click();
        assert.match(await page.locator('#coverage-alert').innerText(), /覆盖不完整/);
        await page.locator('#retention').fill('120');
        await page.locator('#collection-settings [type=submit]').click();
        await page.locator('#refresh').click();
        assert.equal(await page.locator('#retention').inputValue(), '120');
        assert.equal(await page.locator('#toast-region .toast').count(), 1, 'feedback does not stack over controls');
        await layout();
        await page.screenshot({ path: path.join(directory, `${name}-collection-gap.png`), fullPage: true });
        await page.locator('#restore-collection').click();
        await page.locator('#reset-demo').click();
        await page.locator('#confirm-action').click();
        await page.locator('#tab-drafts').click();
        assert.equal(await page.locator('#view-drafts tbody tr').count(), 1);
        await layout();
        assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(businessRequests, []);
        console.log(JSON.stringify({ name, status: 'all workflows passed', chartPixels: pixels, externalCalls: external.length, apiCalls: businessRequests.length }));
      } finally { await context.close(); }
    }
  } finally { await browser?.close(); await preview.stop(); }
  console.log(`Screenshots: ${directory}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
