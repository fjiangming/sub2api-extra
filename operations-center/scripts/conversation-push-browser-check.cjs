'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { startPreview } = require('./conversation-logs-live-preview.cjs');
const { event } = require('../tests/conversation-logs-fixture');
const { s3Receiver } = require('../tests/conversation-s3-fixture');

async function main() {
  const until=async predicate=>{const deadline=Date.now()+20000;while(!predicate()){assert(Date.now()<deadline,'Timed out waiting for delivery');await new Promise(resolve=>setTimeout(resolve,100));}};
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sub2api-push-browser-'));
  const receipts=[];let mode=200,rejectJsonlPart=false;
  const jsonlTarget=await s3Receiver({beforeRequest:(entry,res)=>{
    if(rejectJsonlPart&&entry.method==='PUT'){res.writeHead(403,{'content-type':'application/xml'});res.end('<Error><Code>AccessDenied</Code></Error>');return false;}
  }});
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
        const page=await context.newPage(),errors=[],external=[];mode=200;receipts.length=0;rejectJsonlPart=false;jsonlTarget.completed.length=0;jsonlTarget.objects.clear();
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
          try {await until(()=>preview.push.store.list().counts.some(row=>row.status===status&&row.count===count));}
          catch(error) {
            const state=preview.push.status({}),files=state.jsonl.files.map(({id,status,records,error_code,pause_reason})=>({id,status,records,error_code,pause_reason}));
            error.message+=` (${name}, expected ${status}=${count}): `+JSON.stringify({counts:state.counts,files,workerReady:state.workerReady,lastError:state.lastError,
              message:await page.locator('#clp-message').textContent()});throw error;
          }
          await page.locator('[data-clp-action=refresh]').click();
        };
        await page.goto(`http://127.0.0.1:${preview.port}/preview`);await page.locator('#cl-tab-push').click();await field('enabled').waitFor();
        assert.equal(await field('enabled').isChecked(),false);assert.equal(await page.locator('#clp-preview').isDisabled(),true);
        assert.equal(await field('captureScope').inputValue(),'complete');assert.equal(await field('jsonlUploadRate').inputValue(),'2');
        await field('enabled').check();await field('automatic').check();await field('allowPrivateNetwork').check();
        await field('webhookEnabled').check();await field('webhookUrl').fill(targetUrl+'/webhook');await field('webhookToken').fill('fictional-webhook-token');
        await field('s3Enabled').check();await field('endpoint').fill(targetUrl);await field('bucket').fill('demo-archive');await field('accessKeyId').fill('fictional-id');await field('secretAccessKey').fill('fictional-secret');
        await field('s3Format').selectOption('json');
        await page.evaluate(()=>conversationLogsUi.load());assert.equal(await field('webhookToken').inputValue(),'fictional-webhook-token');
        await page.locator('#clp-save').click();await page.locator('#clp-message').filter({hasText:'已保存'}).waitFor();
        assert.equal(await field('webhookToken').inputValue(),'');assert.equal(await field('secretAccessKey').inputValue(),'');assert.equal(preview.push.store.list().total,0);
        await page.locator('[data-clp-test=webhook]').click();await page.locator('#clp-test-webhook').filter({hasText:'连接成功'}).waitFor();
        await page.locator('[data-clp-test=s3]').click();await page.locator('#clp-test-s3').filter({hasText:'连接成功'}).waitFor();
        assert.equal(receipts.length,2);assert(receipts.every(row=>row.body.schema==='sub2api.conversation.test.v1'));
        await layout();await shot('configuration');
        const row=event(name+'-automatic');preview.fixture.store.ingest(row);await waitJobs('sent',2);
        await page.locator('#clp-jobs').filter({hasText:'已固定脱敏副本'}).waitFor();
        const sent=receipts.filter(item=>Object.hasOwn(item.body,'request'));assert.equal(sent.length,2);
        for(const item of sent){assert.deepEqual(Object.keys(item.body),['request_id','request','response']);assert.equal(item.body.request_id,row.request_id);assert(!item.body.request.includes('alice@example.com'));}
        assert(sent.some(item=>item.headers.authorization?.startsWith('AWS4-HMAC-SHA256')));
        assert(sent.some(item=>preview.push.store.list().items.some(job=>job.id===item.headers['idempotency-key'])));
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
        await field('s3Format').selectOption('jsonl');await field('endpoint').fill(jsonlTarget.url);await field('webhookEnabled').uncheck();
        assert.equal(await field('jsonlMaxGB').inputValue(),'10');await field('jsonlTimezone').fill('Asia/Shanghai');await field('jsonlUploadRate').fill('1.5');
        await page.locator('#clp-save').click();await page.locator('#clp-message').filter({hasText:'已保存'}).waitFor();
        assert.equal(preview.push.store.policy().s3.jsonl.uploadMiBPerSecond,1.5);
        await page.locator('[data-clp-test=s3]').click();await page.locator('#clp-test-s3').filter({hasText:'连接成功'}).waitFor();
        assert.equal(JSON.parse(jsonlTarget.completed[0].body.toString()).schema,'sub2api.conversation.test.v1');
        preview.fixture.store.ingest(event(name+'-jsonl-a',{model:'Opus5'}));preview.fixture.store.ingest(event(name+'-jsonl-b',{model:'Opus5'}));preview.fixture.store.ingest(event(name+'-jsonl-c',{model:'Fable5'}));
        await until(()=>preview.push.store.list().counts.some(row=>row.status==='buffered'&&row.count===3));
        await page.locator('[data-clp-action=refresh]').click();await page.locator('#clp-files').filter({hasText:'汇总中'}).waitFor();
        await page.locator('#clp-backlog').filter({hasText:'待上传 2 个文件'}).waitFor();
        await layout();await shot('jsonl-configuration');
        const stateRoute='**/api/conversation-logs/push/jobs?*';
        await page.route(stateRoute,async route=>{
          const response=await route.fetch(),body=await response.json(),value=body.data||body;
          const file=value.jsonl.files[0];file.status='running';file.bytes=10000000000;file.uploaded_bytes=8388608;file.uploaded_parts=1;file.pause_reason='archive_busy';
          file.model='<img src=x onerror=alert(1)>';file.object_key='2026-06-25/'+ 'Opus5-'.repeat(12)+'.jsonl';
          Object.assign(value.jsonl.backlog,{atRisk:true,expiryAt:Date.now()+3600000});
          await route.fulfill({response,json:body});
        });
        try {
          await page.locator('[data-clp-action=refresh]').click();await page.locator('#clp-files').filter({hasText:'采集优先，上传暂缓'}).waitFor();
          await page.locator('#clp-backlog.amber').filter({hasText:'到期风险'}).waitFor();
          assert.equal(await page.locator('#clp-files img').count(),0);assert.equal(await page.locator('#clp-files progress').first().getAttribute('value'),'8388608');
          await layout();await shot('jsonl-progress-paused');
        } finally {await page.unroute(stateRoute);}
        await page.locator('[data-clp-action=refresh]').click();
        await page.locator('#clp-flush').click();await waitJobs('sent',9);
        const jsonlFiles=jsonlTarget.completed.filter(file=>Object.hasOwn(JSON.parse(file.body.toString().split('\n')[0]),'request'));
        assert.equal(jsonlFiles.length,2);assert.deepEqual(jsonlFiles.map(file=>file.body.toString().trimEnd().split('\n').length).sort(),[1,2]);
        const jsonlIds=[];
        for(const file of jsonlFiles){assert(file.path.endsWith('.jsonl'));for(const line of file.body.toString().trimEnd().split('\n')){const body=JSON.parse(line);assert.deepEqual(Object.keys(body),['request_id','request','response']);jsonlIds.push(body.request_id);assert(!body.request.includes('alice@example.com'));}}
        assert.deepEqual(jsonlIds.sort(),['a','b','c'].map(suffix=>event(name+'-jsonl-'+suffix).request_id).sort());
        rejectJsonlPart=true;preview.fixture.store.ingest(event(name+'-jsonl-failed',{model:'Opus5'}));
        await until(()=>preview.push.store.list().counts.some(row=>row.status==='buffered'&&row.count===1));await page.locator('#clp-flush').click();await waitJobs('failed',1);
        await page.locator('[data-clp-file-retry]').waitFor();await layout();await shot('jsonl-failed');
        rejectJsonlPart=false;await page.locator('[data-clp-file-retry]').click();await waitJobs('sent',10);assert.equal(jsonlTarget.uploads.size,0);
        const partial=event(name+'-scope-partial',{complete:false,reason:'read_error',model:'Opus5',
          request:Buffer.from(JSON.stringify({model:'Opus5',input:'alice@example.com',marker:'partial-'+name})).toString('base64')});preview.fixture.store.ingest(partial);
        await until(()=>preview.push.store.list().skipped.some(row=>row.code==='INCOMPLETE_CAPTURE'));
        await page.locator('[data-clp-action=refresh]').click();await page.locator('#clp-skipped').filter({hasText:'传输完整性未确认'}).waitFor();
        await page.locator('#clp-history [name=search]').fill(partial.id);await page.locator('#clp-preview').click();
        await page.locator('#clp-preview-result').filter({hasText:'当前范围不推送'}).waitFor();assert.equal(await page.locator('#clp-enqueue').count(),0);
        await field('captureScope').selectOption('all');await page.locator('#clp-save').click();await page.locator('#clp-message').filter({hasText:'已保存'}).waitFor();
        await page.locator('#clp-preview').click();await page.locator('#clp-acknowledge').waitFor();await page.locator('#clp-acknowledge').check();
        await page.locator('#clp-enqueue').click();await waitJobs('sent',11);
        const partialBody=jsonlTarget.completed.flatMap(file=>file.body.toString().trimEnd().split('\n').map(JSON.parse)).find(body=>body.request?.includes('partial-'+name));
        assert.deepEqual(Object.keys(partialBody),['request_id','request','response']);assert.equal(partialBody.request_id,partial.request_id);assert(!partialBody.request.includes('alice@example.com'));
        assert.equal(preview.fixture.store.db.prepare('SELECT reason FROM cl_records WHERE id=?').get(partial.id).reason,'read_error');
        const fallback=event(name+'-original-fallback',{model:'Opus5',response:Buffer.from('{invalid').toString('base64')});preview.fixture.store.ingest(fallback);
        await until(()=>preview.push.store.list().counts.some(row=>row.status==='buffered'&&row.count===1));
        await page.locator('#clp-flush').click();await waitJobs('sent',12);
        const fallbackBody=jsonlTarget.completed.flatMap(file=>file.body.toString().trimEnd().split('\n').map(JSON.parse)).find(body=>body.response==='{invalid');
        assert.deepEqual(Object.keys(fallbackBody),['request_id','request','response']);assert.equal(fallbackBody.request_id,fallback.request_id);
        assert.equal(fallbackBody.request,Buffer.from(fallback.request,'base64').toString());assert.equal(fallbackBody.response,Buffer.from(fallback.response,'base64').toString());
        await page.locator('[data-clp-action=refresh]').click();await page.locator('#clp-skipped').filter({hasText:'回退原文'}).waitFor();
        await page.locator('#clp-history [name=search]').fill(fallback.id);await page.locator('#clp-preview').click();
        await page.locator('#clp-preview-result').filter({hasText:'回退原文 1 条'}).waitFor();await layout();await shot('original-fallback');
        await field('webhookToken').fill('unsaved-sensitive-value');await page.locator('[data-clp-action=refresh]').click();assert.equal(await field('webhookToken').inputValue(),'unsaved-sensitive-value');
        await page.locator('#cl-tab-requests').click();assert.equal(await page.locator('#clp-form').count(),0);
        await page.locator('#cl-tab-push').click();await field('webhookToken').waitFor();assert.equal(await field('webhookToken').inputValue(),'');
        assert.equal(await field('captureScope').inputValue(),'all');assert.equal(await field('jsonlUploadRate').inputValue(),'1.5');
        const safe=await page.evaluate(async()=>JSON.stringify(await(await fetch('/api/conversation-logs/push/policy')).json()));assert(!safe.includes('fictional-webhook-token'));assert(!safe.includes('fictional-secret'));
        await layout();await shot('delivered');
        await page.locator('#logout-button').click();await page.locator('#login-view').waitFor({state:'visible'});assert.equal(await page.locator('#clp-form').count(),0);
        assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
        console.log(name+': Webhook/legacy S3, JSONL config/rate/scope/grouping/resume/progress/pause/backlog/skips, privacy, layout and logout passed');
      } finally {await context.close();await preview.stop();}
    }
    console.log('Screenshots: '+directory);
  } finally {await browser?.close();await jsonlTarget.close();await new Promise(resolve=>{target.close(resolve);target.closeAllConnections();});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
