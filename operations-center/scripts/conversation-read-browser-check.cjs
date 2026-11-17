'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const {startPreview}=require('./conversation-logs-live-preview.cjs');

async function main() {
  const preview=await startPreview({port:0}),directory=fs.mkdtempSync(path.join(os.tmpdir(),'sub2api-read-browser-'));
  let browser;
  try {
    browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
    for (const [name,width,height,colorScheme] of [['desktop',1440,1000,'light'],['mobile',390,844,'light'],['narrow',320,740,'light'],['dark',1440,1000,'dark']]) {
      const context=await browser.newContext({viewport:{width,height},colorScheme});
      try {
        const page=await context.newPage(),errors=[];
        page.on('pageerror',error=>errors.push(error.message));
        let release,arrived,delivered;
        const held=new Promise(resolve=>{release=resolve;}),reached=new Promise(resolve=>{arrived=resolve;}),fulfilled=new Promise(resolve=>{delivered=resolve;});
        const records=/\/api\/conversation-logs\/records(?:\?|$)/;
        await page.route(records,async route=>{arrived();await held;try {await route.continue();} finally {delivered();}});
        await page.goto(`http://127.0.0.1:${preview.port}/preview`);await reached;
        await page.locator('#cl-tab-collection').click();await page.locator('#cl-collection h2').first().waitFor();
        release();await fulfilled;await page.unroute(records);
        assert(!await page.locator('#toast-region').textContent().then(text=>/aborted|signal is/i.test(text)));
        assert(!/aborted|signal is/i.test(await page.locator('#page-meta').textContent()));
        assert.equal(await page.locator('#connection-dot.bad').count(),0);

        // Same-view requests may finish in either order. Only the latest may update the connection indicator.
        await page.evaluate(async()=>{
          const load=conversationLogsUi.load;let rejectOld;
          try {
            conversationLogsUi.load=()=>new Promise((_resolve,reject)=>{rejectOld=reject;});
            const older=loadCurrentView();conversationLogsUi.load=async()=>{};await loadCurrentView();
            rejectOld(new Error('fixture-stale-error'));await older;
          } finally {conversationLogsUi.load=load;}
        });
        assert.equal(await page.locator('#connection-label').textContent(),'数据源正常');
        assert(!await page.locator('#toast-region').textContent().then(text=>text.includes('fixture-stale-error')));
        await page.evaluate(async()=>{
          const load=conversationLogsUi.load;let resolveOld;
          try {
            conversationLogsUi.load=()=>new Promise(resolve=>{resolveOld=resolve;});const older=loadCurrentView();
            conversationLogsUi.load=async()=>{throw new Error('fixture-current-error');};await loadCurrentView();resolveOld();await older;
          } finally {conversationLogsUi.load=load;}
        });
        assert.equal(await page.locator('#connection-label').textContent(),'数据源异常');
        assert.equal(await page.locator('#page-meta').textContent(),'fixture-current-error');
        const status=/\/api\/conversation-logs\/status$/;
        await page.route(status,route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'CONVERSATION_READ_TIMEOUT',message:'日志读取超时，请稍后重试'}})}));
        await page.locator('#refresh-button').click();await page.waitForFunction(()=>document.getElementById('page-meta').textContent.includes('日志读取超时'));
        assert.equal(await page.locator('#connection-label').textContent(),'数据源异常');await page.unroute(status);

        preview.read.canWork=()=>false;preview.fixture.store.db.exec('DELETE FROM cl_record_metadata');
        await page.locator('#cl-tab-requests').click();await page.locator('#cl-index-notice').waitFor({state:'visible'});
        await page.locator('#cl-list').filter({hasText:'历史日志正在准备'}).waitFor();
        assert(await page.locator('[data-cl-action=export]').isDisabled());
        assert((await page.locator('#cl-metrics').textContent()).includes('准备中'));
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,name+' overflow');
        await page.screenshot({path:path.join(directory,name+'-warming.png'),fullPage:true});
        while (!preview.fixture.store.backfillMetadata().done) { /* Advance the real migration while automatic polling stays active. */ }
        await page.locator('#cl-index-notice').waitFor({state:'hidden'});await page.locator('[data-cl-record]').first().waitFor();
        assert.equal(await page.locator('[data-cl-action=export]').isDisabled(),false);
        await page.locator('#cl-body-request').filter({hasText:'EMAIL_'}).waitFor();
        await page.screenshot({path:path.join(directory,name+'-ready.png'),fullPage:true});
        await page.locator('#logout-button').click();await page.locator('#login-view').waitFor({state:'visible'});
        assert.deepEqual(errors,[]);console.log(name+': cancellation, stale requests, real timeout, warming and automatic refresh passed');
      } finally {await context.close();}
    }
    console.log('Screenshots: '+directory);
  } finally {await browser?.close();await preview.stop();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
