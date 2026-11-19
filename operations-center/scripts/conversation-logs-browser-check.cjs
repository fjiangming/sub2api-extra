'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { startPreview } = require('./conversation-logs-preview.cjs');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sub2api-conversation-demo-'));
  const preview = await startPreview({ port: 0 }), origin = `http://127.0.0.1:${preview.port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    for (const [name, width, height, colorScheme] of [['desktop', 1440, 1000, 'light'], ['wide', 1920, 1080, 'light'], ['tablet', 1024, 900, 'light'], ['mobile', 390, 844, 'light'], ['narrow', 320, 740, 'light'], ['dark', 1440, 1000, 'dark']]) {
      const context = await browser.newContext({ viewport: { width, height }, colorScheme });
      try {
        await context.addInitScript(() => {
          Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.demoClipboard = text; } } });
        });
        const page = await context.newPage(), errors = [], external = [], business = [], failed = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('requestfailed', request => failed.push(request.url()));
        page.on('request', request => {
          if (!request.url().startsWith(origin) && !request.url().startsWith('blob:') && !request.url().startsWith('data:')) external.push(request.url());
          if (['fetch', 'xhr'].includes(request.resourceType()) || request.url().startsWith(origin + '/api/')) business.push(request.url());
        });
        await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
        await page.goto(origin);
        await page.locator('[data-record]').first().waitFor();
        const layout = async stage => {
          const result = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1,
            controls: [...document.querySelectorAll('button,input,select,textarea')].filter(node => node.getBoundingClientRect().width && !node.closest('[hidden],.module-tabs,.cl-view-tabs,.table-wrap,dialog:not([open])')).filter(node => {
              const bounds = node.getBoundingClientRect(); return bounds.right > innerWidth + 1 || bounds.left < -1;
            }).map(node => node.id || node.outerHTML.slice(0, 100)),
            dialogs: [...document.querySelectorAll('dialog[open]')].map(node => node.getBoundingClientRect()).some(bounds => bounds.left < 0 || bounds.right > innerWidth + 1 || bounds.top < 0 || bounds.bottom > innerHeight + 1),
            clipped: [...document.querySelectorAll('.cl-records,.cl-inspector,.cl-pagination')].filter(node => node.getBoundingClientRect().width).filter(node => {
              const bounds = node.getBoundingClientRect(), parent = node.closest('.cl-explorer').getBoundingClientRect();
              return bounds.top < parent.top - 1 || bounds.bottom > parent.bottom + 1;
            }).map(node => node.className),
            explorerOverflow: [...document.querySelectorAll('.cl-explorer,.cl-inspector')].filter(node => node.getBoundingClientRect().width).some(node => node.scrollHeight > node.clientHeight + 1) }));
          assert.equal(result.overflow, false, `${name}/${stage}: page overflow`);
          assert.deepEqual(result.controls, [], `${name}/${stage}: escaped controls`);
          assert.equal(result.dialogs, false, `${name}/${stage}: dialog overflow`);
          assert.deepEqual(result.clipped, [], `${name}/${stage}: clipped explorer controls`);
          assert.equal(result.explorerOverflow, false, `${name}/${stage}: explorer content escapes its scroll area`);
        };
        const screenshot = async label => {
          await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('#toast-region').replaceChildren(); });
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          await page.screenshot({ path: path.join(directory, `${name}-${label}.png`), fullPage: true });
          await page.screenshot({ path: path.join(directory, `${name}-${label}-viewport.png`) });
        };
        const openPrimary = async () => {
          await page.locator('#reset-filters').click();
          await page.locator('[data-record="req_demo_0001"]').click();
        };
        const bodyText = side => page.locator(`#${side}-raw`).textContent();
        const downloadBody = async side => {
          const waiting = page.waitForEvent('download');
          await page.locator(`[data-payload-action=download][data-side=${side}]`).click();
          const download = await waiting, target = path.join(directory, `${name}-${download.suggestedFilename()}`);
          await download.saveAs(target); return fs.readFileSync(target, 'utf8');
        };
        assert.equal(await page.locator('[data-record]').count(), 6);
        assert.match(await page.locator('#metrics').innerText(), /32/);
        assert.match(await page.locator('#metrics').innerText(), /37/);
        assert.match(await page.locator('#metrics').innerText(), /27/);
        const chartPixels = await page.locator('#trend canvas').first().evaluate(canvas => {
          const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
          let visible = 0; for (let index = 3; index < data.length; index += 4) if (data[index]) visible++;
          return visible;
        });
        assert(chartPixels > 300, `${name}: blank chart`);
        assert(await page.locator('svg.lucide').count() > 15, `${name}: icons missing`);
        await layout('initial'); await screenshot('list');
        await openPrimary();
        assert.match(await bodyText('request'), /<EMAIL_1>/);
        assert.match(await bodyText('request'), /9007199254740993/);
        assert.match(await bodyText('request'), /1\.2300/);
        assert.match(await bodyText('request'), /preserve-this-field/);
        assert.match(await bodyText('request'), /call_order_01/);
        assert.equal((await bodyText('request')).includes('linyuan@example.com'), false);
        await layout('raw'); await screenshot('raw');
        const bodyScroll = await page.locator('#request-raw').evaluate(code => {
          const area = code.parentElement; area.scrollTop = area.scrollHeight;
          const result = { overflows: area.scrollHeight > area.clientHeight + 1, scrolls: area.scrollTop > 0 };
          area.scrollTop = 0; return result;
        });
        assert.equal(bodyScroll.overflows, true, `${name}: long Request should overflow internally`);
        assert.equal(bodyScroll.scrolls, true, `${name}: long Request cannot scroll`);
        if (!['desktop', 'mobile', 'narrow'].includes(name)) {
          await page.locator('#tab-policy').click(); await layout('policy'); await screenshot('policy');
          assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(business, []); assert.deepEqual(failed, []);
          console.log(JSON.stringify({ name, status: 'visual checks passed', chartPixels })); continue;
        }
        const expectedRequest = await page.evaluate(() => window.ConversationDemo.request), expectedResponse = await page.evaluate(() => window.ConversationDemo.response);
        await page.locator('#copy-source').selectOption('original');
        assert.equal(await bodyText('request'), expectedRequest);
        assert.equal(await bodyText('response'), expectedResponse);
        assert.equal(await downloadBody('request'), expectedRequest, 'original Request byte-for-byte');
        assert.equal(await downloadBody('response'), expectedResponse, 'original SSE byte-for-byte');
        await page.locator('[data-payload-action=copy][data-side=request]').click();
        assert.equal(await page.evaluate(() => window.demoClipboard), expectedRequest);
        await page.locator('[data-payload-action=expand][data-side=response]').click();
        assert.equal(await page.locator('#full-code').textContent(), expectedResponse);
        await layout('expanded'); await page.keyboard.press('Escape');
        await page.locator('[data-action=metadata]').click();
        assert.match(await page.locator('#metadata-body').innerText(), /sess_order_01/);
        await layout('metadata'); await page.locator('[data-close=metadata-dialog]').click();
        await page.locator('#copy-source').selectOption('masked');
        const masked = await bodyText('request'); assert.equal(await downloadBody('request'), masked);
        await page.locator('[data-detail=redaction]').click();
        assert.match(await page.locator('#detail-section').innerText(), /策略 v3/);
        assert.match(await page.locator('#detail-section').innerText(), /EMAIL_1/);
        await page.locator('[data-detail=payload]').click();

        await page.locator('#search').fill('no-such-record');
        assert.equal(await page.locator('[data-record]').count(), 0);
        assert.equal(await page.locator('#export-index').isDisabled(), true);
        await page.locator('[data-action=reset]').click();
        await page.locator('#platform-filter').selectOption('Anthropic');
        assert.equal(await page.locator('[data-record]').count(), 6);
        assert.match(await page.locator('#request-list').innerText(), /claude/);
        await page.locator('#reset-filters').click();
        await page.locator('#next-page').click(); assert.match(await page.locator('#page-label').innerText(), /7–12/);
        await page.locator('#prev-page').click();
        const indexWaiting = page.waitForEvent('download'); await page.locator('#export-index').click();
        const indexDownload = await indexWaiting, indexPath = path.join(directory, `${name}-index.csv`);
        await indexDownload.saveAs(indexPath); assert.equal(fs.readFileSync(indexPath, 'utf8').split('\r\n').length, 33);

        await page.locator('#capture-filter').selectOption('retry');
        await page.locator('[data-record]').first().click();
        assert.equal(await page.locator('[data-attempt]').count(), 2);
        await page.locator('[data-attempt="0"]').click(); assert.match(await bodyText('response'), /rate_limit_error/);
        await page.locator('[data-attempt="1"]').click(); assert.equal((await bodyText('response')).includes('rate_limit_error'), false);
        await screenshot('retry');
        await page.locator('#capture-filter').selectOption('partial'); await page.locator('[data-record]').first().click();
        assert.match(await page.locator('#detail-section').innerText(), /不能视为完整 Response/);
        assert.equal((await bodyText('response')).includes('response.completed'), false);
        await page.locator('#capture-filter').selectOption('missing'); await page.locator('[data-record]').first().click();
        assert.equal(await page.locator('#request-raw').count(), 0); assert.match(await page.locator('#detail-section').innerText(), /未保存正文/);
        await page.locator('#capture-filter').selectOption('redaction_failed'); await page.locator('[data-record]').first().click();
        await page.locator('[data-detail=redaction]').click(); assert.match(await page.locator('#detail-section').innerText(), /未回退保存未脱敏正文/);
        await screenshot('gap');

        await page.locator('#reset-filters').click(); await page.locator('#protocol-filter').selectOption('WebSocket');
        await page.locator('[data-record="req_demo_0003"]').click(); await page.locator('#copy-source').selectOption('masked');
        await page.locator('[data-detail=timeline]').click(); assert.equal(await page.locator('[data-frame]').count(), 6);
        await layout('websocket-timeline');
        await page.locator('[data-frame="5"]').scrollIntoViewIfNeeded();
        assert.equal(await page.locator('[data-frame="5"]').isVisible(), true);
        await page.locator('[data-frame="2"]').click();
        assert.match(await page.locator('#full-code').textContent(), /call_mail_01/); assert.match(await page.locator('#full-code').textContent(), /<EMAIL_1>/);
        await layout('websocket-message'); await page.keyboard.press('Escape'); await screenshot('websocket');
        await page.locator('#tab-sessions').click(); await page.locator('[data-session="sess_order_01"]').click();
        assert.equal(await page.locator('.cl-turn').count(), 3); assert.match(await page.locator('#session-thread').innerText(), /<EMAIL_1>/);
        await layout('sessions'); await screenshot('sessions');
        await page.locator('[data-open-record="req_demo_0001"]').click(); assert.match(await page.locator('.cl-detail-kicker').innerText(), /req_demo_0001/);

        await page.locator('#tab-policy').click();
        await page.locator('#custom-from').fill('call_order_01'); await page.locator('#custom-to').fill('<CALL_1>'); await page.locator('#add-rule').click();
        assert.match(await page.locator('#custom-error').innerText(), /改变字段结构或工具关联/);
        assert.equal(await page.locator('.cl-custom-rule').count(), 0);
        await page.locator('#custom-from').fill('ORION-42'); await page.locator('#custom-to').fill('<PROJECT_1>'); await page.locator('#add-rule').click();
        await page.locator('#rule-ip').check();
        assert.match(await page.locator('#preview-after').textContent(), /<PROJECT_1>/); assert.match(await page.locator('#preview-after').textContent(), /<IP_1>/);
        assert.match(await page.locator('#preview-after').textContent(), /9007199254740993/); assert.match(await page.locator('#preview-after').textContent(), /call_order_01/);
        await page.locator('[data-preview=response]').click(); assert.match(await page.locator('#preview-after').textContent(), /<EMAIL_1>/);
        await page.locator('[data-preview=request]').click(); await page.locator('[name=mode][value=masked]').check();
        await page.locator('#policy-retention').fill('14'); await layout('policy'); await screenshot('policy');
        await page.locator('#policy-form [type=submit]').click(); assert.match(await page.locator('#policy-feedback').innerText(), /v4/);
        await page.reload(); await page.locator('[data-record]').first().waitFor();
        await page.locator('#tab-policy').click(); assert.equal(await page.locator('#policy-retention').inputValue(), '14');
        assert.equal(await page.locator('[name=mode][value=masked]').isChecked(), true);
        await page.locator('#tab-requests').click(); await openPrimary();
        assert.match(await bodyText('request'), /ORION-42/); assert.equal((await bodyText('request')).includes('<PROJECT_1>'), false);
        assert.equal(await page.locator('#copy-source option[value=original]').isDisabled(), false, 'historical originals survive policy change');
        await page.locator('#tab-collection').click(); await page.locator('#simulate-record').click();
        assert.match(await page.locator('.cl-detail-heading h2').innerText(), /新归档/);
        assert.equal(await page.locator('#copy-source option[value=original]').isDisabled(), true, 'new masked-only snapshot has no original');
        assert.match(await bodyText('request'), /<EMAIL_1>/); assert.match(await page.locator('.cl-detail-footnote').innerText(), /v4/);
        await page.locator('#tab-policy').click(); await page.locator('[name=mode][value=original]').check(); await page.locator('#policy-form [type=submit]').click();
        await page.locator('#tab-collection').click(); await page.locator('#simulate-record').click();
        assert.equal(await page.locator('#copy-source option[value=masked]').isDisabled(), true);
        assert.equal(await page.locator('#copy-source').inputValue(), 'original');

        await page.locator('#tab-policy').click();
        assert.equal(await page.locator('[data-exclude-user]').count(), 5);
        await page.locator('[data-exclude-user="1001"]').check();
        await page.locator('#excluded-user-search').fill('#1004');
        assert.equal(await page.locator('[data-exclude-user]').count(), 1);
        await page.locator('[data-exclude-user="1004"]').check();
        await page.locator('#excluded-user-search').fill('林远');
        assert.equal(await page.locator('[data-exclude-user="1001"]').isChecked(), true);
        await page.locator('#excluded-user-search').fill('no-matching-user');
        assert.match(await page.locator('#excluded-users').innerText(), /没有匹配/);
        await page.locator('#excluded-user-search').fill('');
        assert.match(await page.locator('#excluded-user-count').innerText(), /2/);
        assert.equal(await page.locator('#policy-dirty').isVisible(), true);
        await layout('exclusion-draft');
        await page.locator('#tab-collection').click(); await page.locator('#simulate-user').selectOption('1001');
        await page.locator('#simulate-record').click();
        assert.match(await page.locator('.cl-detail-facts').innerText(), /林远/);
        assert.match(await page.locator('.cl-detail-heading h2').innerText(), /新归档/, 'unsaved exclusions do not change active capture');
        await page.locator('#tab-policy').click(); await page.locator('#policy-form [type=submit]').click();
        assert.match(await page.locator('#policy-current').innerText(), /排除 2 位用户/);
        await page.reload(); await page.locator('[data-record]').first().waitFor();
        await page.locator('#tab-policy').click();
        assert.equal(await page.locator('[data-exclude-user="1001"]').isChecked(), true);
        assert.equal(await page.locator('[data-exclude-user="1004"]').isChecked(), true);
        assert.equal(await page.locator('#policy-dirty').isVisible(), false);
        assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('sub2api-conversation-logs-demo-policy-v1')).excludedUserIds), [1001, 1004]);
        await layout('exclusions'); await screenshot('exclusions');
        await page.locator('#tab-collection').click();
        const archiveSummary = () => page.evaluate(() => ({
          facts: document.querySelector('.cl-collection-facts').innerText,
          bytes: document.querySelector('.cl-storage-line').innerText,
          gaps: document.querySelector('.cl-gap-table').innerText,
          totals: document.querySelector('#metrics').innerText
        }));
        const beforeExcluded = await archiveSummary();
        for (const id of ['1001', '1004']) {
          await page.locator('#simulate-user').selectOption(id); await page.locator('#simulate-record').click();
          assert.match(await page.locator('#toast-region').innerText(), /未保存任何数据/);
          assert.equal(await page.locator('#view-collection').isVisible(), true);
          assert.deepEqual(await archiveSummary(), beforeExcluded, 'excluded requests leave no metadata, counters, bytes or gap rows');
        }
        await layout('excluded-capture'); await screenshot('excluded-capture');
        await page.locator('#tab-requests').click(); await openPrimary();
        assert.match(await page.locator('.cl-detail-kicker').innerText(), /req_demo_0001/, 'historical records remain accessible');
        await page.locator('#search').fill('req_demo_0033'); assert.equal(await page.locator('[data-record]').count(), 0);
        await page.locator('#reset-filters').click();
        const excludedExportWaiting = page.waitForEvent('download'); await page.locator('#export-index').click();
        const excludedExport = await excludedExportWaiting, excludedIndexPath = path.join(directory, `${name}-excluded-index.csv`);
        await excludedExport.saveAs(excludedIndexPath);
        assert.equal(fs.readFileSync(excludedIndexPath, 'utf8'), fs.readFileSync(indexPath, 'utf8'), 'excluded requests add no index entries');
        await page.locator('#tab-collection').click(); await page.locator('#simulate-user').selectOption('1002');
        await page.locator('#simulate-record').click();
        assert.match(await page.locator('.cl-detail-facts').innerText(), /陈夏/);
        assert.match(await page.locator('.cl-detail-kicker').innerText(), /req_demo_0033/, 'excluded requests do not create archive IDs');
        const preBodyExclusion = await page.evaluate(() => {
          const demo = window.ConversationDemo;
          const bodyRules = new Proxy([], { get() { throw new Error('Body processing must not start for an excluded user'); } });
          for (const mode of ['dual', 'masked', 'original']) for (const index of [0, 1, 2, 3, 5, 11, 23, 29]) {
            if (demo.makeRecord(index, { ...demo.defaultPolicy, mode, custom: bodyRules, excludedUserIds: [1001] }, 1001) !== null) return false;
          }
          return demo.makeRecord(0, { ...demo.defaultPolicy, excludedUserIds: ['1001'] }, 1001) === null &&
            demo.makeRecord(0, demo.defaultPolicy, 9999) === null;
        });
        assert.equal(preBodyExclusion, true, 'skip before body processing across modes, protocols and retries; invalid identity/config cannot bypass it');
        await page.locator('#tab-policy').click();
        for (const user of ['1001', '1002', '1003', '1004', '1005']) await page.locator(`[data-exclude-user="${user}"]`).check();
        await page.locator('#policy-form [type=submit]').click(); await page.locator('#tab-collection').click();
        const beforeAllExcluded = await archiveSummary();
        for (const user of ['1001', '1002', '1003', '1004', '1005']) {
          await page.locator('#simulate-user').selectOption(user); await page.locator('#simulate-record').click();
          assert.deepEqual(await archiveSummary(), beforeAllExcluded);
        }
        await page.locator('#tab-policy').click(); await page.locator('#clear-excluded-users').click();
        assert.equal(await page.locator('[data-exclude-user]:checked').count(), 0);
        assert.equal(await page.locator('#clear-excluded-users').isDisabled(), true);
        await page.locator('#policy-form [type=submit]').click();
        await page.locator('#tab-collection').click(); await page.locator('#simulate-user').selectOption('1001'); await page.locator('#simulate-record').click();
        assert.match(await page.locator('.cl-detail-kicker').innerText(), /req_demo_0034/);
        assert.match(await page.locator('.cl-detail-facts').innerText(), /林远/);
        await page.locator('#tab-policy').click(); await page.locator('#policy-enabled').uncheck(); await page.locator('#policy-form [type=submit]').click();
        await page.locator('#tab-collection').click(); assert.equal(await page.locator('#simulate-record').isDisabled(), true);
        await layout('collection'); await screenshot('collection');
        await page.locator('#scenario').selectOption('interrupted'); assert.match(await page.locator('#coverage-banner').innerText(), /暂停|中断/);
        await page.locator('#scenario').selectOption('unconfigured'); await page.locator('#tab-requests').click();
        assert.equal(await page.locator('[data-record]').count(), 0); assert.match(await page.locator('#request-list').innerText(), /尚未接入/);
        await layout('unconfigured');
        assert.deepEqual(errors, [], `${name}: page errors`); assert.deepEqual(external, [], `${name}: external requests`);
        assert.deepEqual(business, [], `${name}: business requests`); assert.deepEqual(failed, [], `${name}: failed assets`);
        console.log(JSON.stringify({ name, status: 'all interaction checks passed', chartPixels }));
      } finally { await context.close(); }
    }
    const context = await browser.newContext();
    try {
      await context.addInitScript(() => { Storage.prototype.setItem = () => { throw new DOMException('Disabled', 'SecurityError'); }; });
      const page = await context.newPage(); await page.goto(origin); await page.locator('#tab-policy').click();
      await page.locator('#policy-retention').fill('21'); await page.locator('[data-exclude-user="1001"]').check(); await page.locator('#policy-form [type=submit]').click();
      assert.match(await page.locator('#policy-feedback').innerText(), /修改尚未生效/);
      assert.match(await page.locator('#policy-current').innerText(), /v3/);
      assert.match(await page.locator('#policy-current').innerText(), /排除 0 位用户/);
    } finally { await context.close(); }
    const compatibility = await browser.newContext();
    try {
      const page = await compatibility.newPage(); await page.goto(origin);
      await page.evaluate(() => {
        const legacy = { ...window.ConversationDemo.defaultPolicy, version: 8 }; delete legacy.excludedUserIds;
        localStorage.setItem('sub2api-conversation-logs-demo-policy-v1', JSON.stringify(legacy));
      });
      await page.reload(); await page.locator('#tab-policy').click();
      assert.equal(await page.locator('#policy-enabled').isChecked(), true);
      assert.equal(await page.locator('[data-exclude-user]:checked').count(), 0);
      assert.match(await page.locator('#policy-current').innerText(), /v8/);
      await page.evaluate(() => {
        localStorage.setItem('sub2api-conversation-logs-demo-policy-v1', JSON.stringify({ ...window.ConversationDemo.defaultPolicy, excludedUserIds: [2001] }));
      });
      await page.reload(); await page.locator('#tab-policy').click();
      assert.equal(await page.locator('[data-exclude-user="2001"]').isChecked(), true);
      assert.match(await page.locator('#excluded-users').innerText(), /用户信息暂不可用/);
      for (const invalid of [null, ['1001'], [0], [9007199254740992]]) {
        await page.evaluate(value => {
          localStorage.setItem('sub2api-conversation-logs-demo-policy-v1', JSON.stringify({ ...window.ConversationDemo.defaultPolicy, excludedUserIds: value }));
        }, invalid);
        await page.reload(); await page.locator('#tab-policy').click();
        assert.equal(await page.locator('#policy-enabled').isChecked(), false);
        assert.match(await page.locator('#policy-feedback').innerText(), /采集已暂停/);
        await page.locator('#tab-collection').click(); assert.equal(await page.locator('#simulate-record').isDisabled(), true);
      }
      await page.evaluate(() => localStorage.setItem('sub2api-conversation-logs-demo-policy-v1', '{invalid json'));
      await page.reload(); await page.locator('#tab-collection').click(); assert.equal(await page.locator('#simulate-record').isDisabled(), true);
    } finally { await compatibility.close(); }
    console.log(JSON.stringify({ screenshots: directory, status: 'passed', storageDenied: 'verified', exclusions: 'verified including legacy, invalid and unavailable users' }));
  } finally { if (browser) await browser.close(); await preview.stop(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
