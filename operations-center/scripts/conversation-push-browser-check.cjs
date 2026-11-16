'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { startPreview } = require('./conversation-logs-live-preview.cjs');
const { event } = require('../tests/conversation-logs-fixture');

async function main() {
  const until=async predicate=>{const deadline=Date.now()+20000;while(!predicate()){assert(Date.now()<deadline,'Timed out waiting for delivery');await new Promise(resolve=>setTimeout(resolve,100));}};
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sub2api-push-browser-'));
  const receipts=[];let mode=200;
  const target=http.createServer((req,res)=>{
    let body='';req.on('data',chunk=>{body+=chunk;});req.on('end',()=>{receipts.push({url:req.url,headers:req.headers,body:JSON.parse(body)});res.writeHead(mode,{'content-type':'application/xml'});res.end(mode===200?'':'<Error><Code>AccessDenied</Code></Error>');});
  });
  await new Promise(resolve=>target.listen(0,'127.0.0.1',resolve));
  const targetUrl='http://127.0.0.1:'+target.address().port;
  let browser;
  try {
    browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
    for(const [name,width,height,colorScheme] of [['desktop',1440,1000,'light'],['mobile',390,844,'light'],['narrow',320,740,'light'],['dark',1440,1000,'dark']]) {
      const preview=await startPreview({port:0}),context=await browser.newContext({viewport:{width,height},colorScheme});
      try {
        const page=await context.newPage(),errors=[],external=[];mode=200;receipts.length=0;
        page.on('pageerror',error=>errors.push(error.message));
        page.on('request',request=>{if(!request.url().startsWith(`http://127.0.0.1:${preview.port}/`)&&!/^(blob:|data:)/.test(request.url()))external.push(request.url());});
        const field=name=>page.locator(`#clp-form [name="${name}"]`);
        const shot=async suffix=>{await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:path.join(directory,name+'-'+suffix+'.png'),fullPage:true});};
        const layout=async()=>{
          const result=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth+1,
            controls:[...document.querySelectorAll('#cl-push input,#cl-push select,#cl-push .button')].filter(node=>node.getBoundingClientRect().width).filter(node=>node.getBoundingClientRect().right>innerWidth+1).map(node=>node.name||node.id)}));
          assert.equal(result.overflow,false,name+' overflow');assert.deepEqual(result.controls,[]);
        };
        const waitJobs=async(status,count)=>{
          await until(()=>preview.push.store.list().counts.some(row=>row.status===status&&row.count===count));
          await page.locator('[data-clp-action=refresh]').click();
        };
        await page.goto(`http://127.0.0.1:${preview.port}/preview`);await page.locator('#cl-tab-push').click();await field('enabled').waitFor();
        assert.equal(await field('enabled').isChecked(),false);assert.equal(await page.locator('#clp-preview').isDisabled(),true);
        await field('enabled').check();await field('automatic').check();await field('allowPrivateNetwork').check();
        await field('webhookEnabled').check();await field('webhookUrl').fill(targetUrl+'/webhook');await field('webhookToken').fill('fictional-webhook-token');
        await field('s3Enabled').check();await field('endpoint').fill(targetUrl);await field('bucket').fill('demo-archive');await field('accessKeyId').fill('fictional-id');await field('secretAccessKey').fill('fictional-secret');
        await page.evaluate(()=>conversationLogsUi.load());assert.equal(await field('webhookToken').inputValue(),'fictional-webhook-token');
        await page.locator('#clp-save').click();await page.locator('#clp-message').filter({hasText:'已保存'}).waitFor();
        assert.equal(await field('webhookToken').inputValue(),'');assert.equal(await field('secretAccessKey').inputValue(),'');assert.equal(preview.push.store.list().total,0);
        await page.locator('[data-clp-test=webhook]').click();await page.locator('#clp-test-webhook').filter({hasText:'连接成功'}).waitFor();
        await page.locator('[data-clp-test=s3]').click();await page.locator('#clp-test-s3').filter({hasText:'连接成功'}).waitFor();
        assert.equal(receipts.length,2);assert(receipts.every(row=>row.body.schema==='sub2api.conversation.test.v1'));
        await layout();await shot('configuration');
        const row=event(name+'-automatic');preview.fixture.store.ingest(row);await waitJobs('sent',2);
        const sent=receipts.filter(item=>item.body.schema==='sub2api.conversation.v1');assert.equal(sent.length,2,JSON.stringify({schemas:receipts.map(item=>item.body.schema),counts:preview.push.store.list().counts}));assert(sent.every(item=>!Buffer.from(item.body.request,'base64').toString().includes('alice@example.com')));
        assert(sent.some(item=>item.headers.authorization?.startsWith('AWS4-HMAC-SHA256')));assert(sent.some(item=>item.headers['idempotency-key']===item.body.delivery_id));
        await page.locator('#clp-history [name=search]').fill(preview.raw.id);await page.locator('#clp-preview').click();await page.locator('#clp-acknowledge').waitFor();
        assert.equal(await page.locator('#clp-enqueue').isDisabled(),true);await page.locator('#clp-acknowledge').check();await layout();await shot('preview');
        await page.locator('#clp-enqueue').dblclick();await waitJobs('sent',4);assert.equal(preview.push.store.list().batches.length,1);
        await page.locator('#clp-preview').click();await page.locator('#clp-preview-result').filter({hasText:'没有需要新增'}).waitFor();
        mode=403;const failed=event(name+'-failed');preview.fixture.store.ingest(failed);await waitJobs('failed',2);
        await page.locator('#clp-job-status').selectOption('failed');await page.locator('[data-clp-retry]').first().waitFor();
        await layout();await shot('failed');
        mode=200;const failedJobs=preview.push.store.list({status:'failed'}).items;
        for(const job of failedJobs){await page.locator(`[data-clp-retry="${job.id}"]`).click();await until(()=>preview.push.store.list({status:'sent'}).items.some(row=>row.id===job.id));}
        await page.locator('#clp-job-status').selectOption('');await waitJobs('sent',6);
        await field('webhookToken').fill('unsaved-sensitive-value');await page.locator('[data-clp-action=refresh]').click();assert.equal(await field('webhookToken').inputValue(),'unsaved-sensitive-value');
        await page.locator('#cl-tab-requests').click();assert.equal(await page.locator('#clp-form').count(),0);
        await page.locator('#cl-tab-push').click();await field('webhookToken').waitFor();assert.equal(await field('webhookToken').inputValue(),'');
        const safe=await page.evaluate(async()=>JSON.stringify(await(await fetch('/api/conversation-logs/push/policy')).json()));assert(!safe.includes('fictional-webhook-token'));assert(!safe.includes('fictional-secret'));
        await layout();await shot('delivered');
        await page.locator('#logout-button').click();await page.locator('#login-view').waitFor({state:'visible'});assert.equal(await page.locator('#clp-form').count(),0);
        assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
        console.log(name+': config, secret clearing, synthetic connection tests, automatic Webhook/S3, manual preview/idempotency, failure/retry and logout passed');
      } finally {await context.close();await preview.stop();}
    }
    console.log('Screenshots: '+directory);
  } finally {await browser?.close();await new Promise(resolve=>{target.close(resolve);target.closeAllConnections();});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
