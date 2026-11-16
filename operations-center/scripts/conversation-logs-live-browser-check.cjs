'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const {startPreview} = require('./conversation-logs-live-preview.cjs');
const {event,id} = require('../tests/conversation-logs-fixture');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'sub2api-conversation-browser-'));
  const preview = await startPreview({port:0}); let browser;
  try {
    browser = await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE} : {})});
    for (const [name,width,height,colorScheme] of [['desktop',1440,1000,'light'],['mobile',390,844,'light'],['narrow',320,740,'light'],['dark',1440,1000,'dark']]) {
      const context = await browser.newContext({viewport:{width,height},colorScheme,acceptDownloads:true});
      try {
        const page = await context.newPage(), errors = [], external = [];
        await page.addInitScript(() => { Object.defineProperty(navigator,'clipboard',{value:{writeText:async text => { window.conversationCopiedText = text; }}}); });
        page.on('pageerror',error => errors.push(error.message));
        page.on('request',request => { if (!request.url().startsWith(`http://127.0.0.1:${preview.port}/`) && !/^(?:blob:|data:)/.test(request.url())) external.push(request.url()); });
        const layout = async () => {
          const result = await page.evaluate(() => ({overflow:document.documentElement.scrollWidth > innerWidth + 1,controls:[...document.querySelectorAll('#cl-root input,#cl-root select,#cl-root .button')].filter(node => node.getBoundingClientRect().width).filter(node => node.getBoundingClientRect().right > innerWidth + 1).map(node => node.outerHTML)}));
          assert.equal(result.overflow,false,name + ' page overflow'); assert.deepEqual(result.controls,[]);
        };
        await page.goto(`http://127.0.0.1:${preview.port}/preview`);
        await page.locator('#cl-body-request').filter({hasText:'EMAIL_'}).waitFor();
        assert.equal(await page.locator('#cl-inspector img').count(),0);
        await layout(); await page.screenshot({path:path.join(directory,name + '-requests.png'),fullPage:true});
        await page.locator('#cl-source').selectOption('original');
        await page.waitForFunction(() => document.getElementById('cl-body-request').textContent.includes('alice@example.com'));
        const text = await page.locator('#cl-body-request').innerText(); assert(text.includes('9007199254740993')); assert(text.includes('1.2300'));
        assert.equal(await page.locator('#cl-inspector img').count(),0);
        const downloadEvent = page.waitForEvent('download'); await page.locator('[data-cl-download=request]').click();
        const downloaded = await downloadEvent; assert.deepEqual(fs.readFileSync(await downloaded.path()),Buffer.from(preview.raw.request,'base64'));
        await page.locator(`[data-cl-record="${id('ws-case')}"]`).click(); await page.locator('[data-cl-detail=frames]').click();
        await page.locator('[data-cl-frame="1"]').click(); await page.locator('#cl-body-frame-1').filter({hasText:'EMAIL_'}).waitFor();
        await layout(); await page.screenshot({path:path.join(directory,name + '-frames.png'),fullPage:true});
        await page.locator('#cl-tab-sessions').click(); await page.locator('[data-cl-session]').first().waitFor();
        await page.locator('[data-cl-session]').first().click(); await page.locator('#cl-session-filter button').waitFor();
        await page.locator('[data-cl-action=clear-session]').click();
        await page.locator('#cl-filter [name=search]').fill('NO_MATCH'); await page.locator('#cl-filter [type=submit]').click();
        await page.locator('#cl-list').filter({hasText:'没有记录'}).waitFor();
        await page.locator('[data-cl-action=reset-filter]').click(); await page.locator('[data-cl-record]').first().waitFor();
        const csvEvent = page.waitForEvent('download'); await page.locator('[data-cl-action=export]').click(); const csv = await csvEvent;
        assert(fs.readFileSync(await csv.path(),'utf8').includes('request_id'));
        await page.locator('#cl-tab-collection').click(); await page.locator('#cl-collection h2').waitFor(); await layout();
        await page.locator('#cl-tab-policy').click(); await page.locator('#cl-policy-form').waitFor();
        await page.locator('#cl-user-search').fill('2'); await page.locator('[data-cl-user="2"]').waitFor(); await page.locator('[data-cl-user="2"]').check();
        await page.locator('[data-cl-action=add-rule]').click(); await page.locator('[data-rule-from]').fill('ORION-42'); await page.locator('[data-rule-to]').fill('<ORDER>');
        await layout(); await page.screenshot({path:path.join(directory,name + '-policy.png'),fullPage:true});
        await page.locator('#cl-save').click(); await page.waitForFunction(() => document.getElementById('cl-save')?.disabled === false && document.getElementById('cl-excluded-count')?.textContent.includes('1 位'));
        assert.deepEqual(preview.fixture.store.policy().excludedUserIds,[2]);
        const before = preview.fixture.store.status().records;
        assert.equal(preview.fixture.store.ingest(event('excluded-' + name,{policy_version:preview.fixture.store.policy().version})).accepted,false);
        assert.equal(preview.fixture.store.status().records,before);
        await page.reload(); await page.locator('#cl-tab-policy').click(); await page.locator('[data-cl-remove-user="2"]').waitFor();
        await page.locator('[data-cl-action=clear-users]').click(); await page.locator('[data-cl-action=remove-rule]').click(); await page.locator('#cl-save').click();
        await page.waitForFunction(() => document.getElementById('cl-save')?.disabled === false && document.getElementById('cl-excluded-count')?.textContent.includes('0 位'));
        assert.deepEqual(preview.fixture.store.policy().excludedUserIds,[]);
        const largeText = JSON.stringify({ content: 'a'.repeat(350000) + ' END_OF_FULL_RESPONSE' });
        const large = event('large-' + name,{at:Date.now()+1000,request:preview.raw.request,response:Buffer.from(largeText).toString('base64'),policy_version:preview.fixture.store.policy().version});
        assert.equal(preview.fixture.store.ingest(large).accepted,true);
        await page.locator('#cl-tab-requests').click();
        await page.locator(`[data-cl-record="${large.id}"]`).click();
        await page.waitForFunction(() => document.getElementById('cl-body-response')?.textContent.length === 65536);
        await page.locator('[data-cl-full=response]').waitFor({state:'visible'});
        await page.locator('[data-cl-copy=response]').click();
        await page.waitForFunction(() => window.conversationCopiedText?.includes('END_OF_FULL_RESPONSE'));
        assert.equal(await page.evaluate(() => window.conversationCopiedText),largeText);
        const fullDownloadEvent = page.waitForEvent('download'); await page.locator('[data-cl-download=response]').click();
        const fullDownload = await fullDownloadEvent;
        assert.deepEqual(fs.readFileSync(await fullDownload.path()),Buffer.from(largeText));
        assert.equal((await page.locator('#cl-body-response').textContent()).length,65536);
        await layout(); await page.screenshot({path:path.join(directory,name + '-large-preview.png'),fullPage:true});
        await page.locator('[data-cl-full=response]').click();
        await page.waitForFunction(() => document.getElementById('cl-body-response')?.textContent.includes('END_OF_FULL_RESPONSE'));
        assert.equal(await page.locator('#cl-body-response').textContent(),largeText);
        await page.locator('[data-cl-full=response]').waitFor({state:'hidden'});
        await page.locator('#logout-button').click(); await page.locator('#login-view').waitFor({state:'visible'});
        assert.equal(await page.locator('#cl-list [data-cl-record]').count(),0); assert.equal(await page.locator('#cl-inspector').innerText(),'选择一条请求查看原始请求与响应');
        assert.deepEqual(errors,[]); assert.deepEqual(external,[]);
        console.log(name + ': raw bytes, XSS, WS frames, sessions, filters, downloads, exclusion persistence and logout passed');
      } finally { await context.close(); }
    }
    console.log('Screenshots: ' + directory);
  } finally { await browser?.close(); await preview.stop(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
