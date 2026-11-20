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
  const until=async (predicate,timeout=20000)=>{const deadline=Date.now()+timeout;while(!predicate()){assert(Date.now()<deadline,'Timed out waiting for delivery');await new Promise(resolve=>setTimeout(resolve,100));}};
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sub2api-push-browser-'));
  const receipts=[];let mode=200,rejectJsonlPart=false,rejectReplica=false;
  const replicaTarget=await s3Receiver({beforeRequest:(entry,res)=>{
    if(rejectReplica&&entry.method==='PUT'){res.writeHead(403,{'content-type':'application/xml'});res.end('<Error><Code>AccessDenied</Code></Error>');return false;}
  }});
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
        const page=await context.newPage(),errors=[],external=[],writes=[];mode=200;receipts.length=0;rejectJsonlPart=false;jsonlTarget.completed.length=0;jsonlTarget.objects.clear();
        page.on('pageerror',error=>errors.push(error.message));
        page.on('request',request=>{if(!request.url().startsWith(`http://127.0.0.1:${preview.port}/`)&&!/^(blob:|data:)/.test(request.url()))external.push(request.url());
          const url=new URL(request.url());if(url.pathname.startsWith('/api/conversation-logs/push/')&&!url.pathname.includes('/test/')&&['POST','PUT'].includes(request.method()))writes.push(Date.now());});
        const writeBudget=async reserve=>{
          while(writes.filter(at=>at>Date.now()-61000).length+reserve>30){
            const first=writes.find(at=>at>Date.now()-61000);await new Promise(resolve=>setTimeout(resolve,Math.max(1,first+61000-Date.now())));
          }
        };
        const names={webhookEnabled:'platformEnabled',webhookUrl:'platformUrl',webhookToken:'platformToken',s3Enabled:'platformEnabled',endpoint:'platformEndpoint',bucket:'platformBucket',accessKeyId:'platformAccessKey',secretAccessKey:'platformSecretKey',s3Format:'platformFormat',jsonlMaxGB:'platformMaxGB',jsonlTimezone:'platformTimezone',jsonlUploadRate:'platformRate'};
        const field=name=>page.locator(`#clp-form [name="${names[name]||name}"]`);
        const view=async name=>page.locator(`[data-clp-view="${name}"]`).click();
        const startPricing=async()=>{
          const pending=page.waitForResponse(response=>response.url().endsWith('/api/conversation-logs/push/billing/price')&&response.request().method()==='POST');
          await page.locator('[data-clp-action=bill-price]').click();const response=await pending;assert.equal(response.status(),202);return (await response.json()).job;
        };
        const edit=async id=>{await view('platforms');await page.locator(`.icon-button[data-clpp-edit="${id}"]`).click();};
        const refresh=async()=>{
          const active=await page.locator('[data-clp-view][aria-selected=true]').getAttribute('data-clp-view');
          await view('jobs');await page.locator('[data-clp-action=refresh]').click();if(active!=='jobs')await view(active);
        };
        const shot=async suffix=>{await page.evaluate(()=>{window.scrollTo(0,0);document.querySelectorAll('.table-wrap').forEach(node=>{node.scrollLeft=0;});});await page.screenshot({path:path.join(directory,name+'-'+suffix+'.png'),fullPage:true});};
        const layout=async()=>{
          const result=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth+1,
            controls:[...document.querySelectorAll('#cl-push input,#cl-push select,#cl-push .button')].filter(node=>!node.closest('.table-wrap')&&node.getBoundingClientRect().width).filter(node=>node.getBoundingClientRect().right>innerWidth+1).map(node=>node.name||node.id)}));
          assert.equal(result.overflow,false,name+' overflow');assert.deepEqual(result.controls,[]);
        };
        const waitJobs=async(status,count)=>{
          try {await until(()=>preview.push.store.list().counts.some(row=>row.status===status&&row.count===count),70000);}
          catch(error) {
            const state=preview.push.status({}),files=state.jsonl.files.map(({id,status,records,error_code,pause_reason})=>({id,status,records,error_code,pause_reason}));
            throw new Error(`${name}, expected ${status}=${count}: `+JSON.stringify({counts:state.counts,files,workerReady:state.workerReady,lastError:state.lastError,
              message:await page.locator('#clp-message').textContent()}),{cause:error});
          }
          await view('jobs');await refresh();
        };
        await page.goto(`http://127.0.0.1:${preview.port}/preview`);await page.locator('#cl-tab-push').click();await field('enabled').waitFor();
        assert.equal(await field('enabled').isChecked(),false);assert.equal(await page.locator('#clp-preview').isDisabled(),true);
        assert.equal(await field('deleteAfterPush').isChecked(),false);
        assert.equal(await page.locator('#clp-automatic-options').isVisible(),false);
        assert.equal(await field('automaticMode').isDisabled(),true);
        assert.equal(await field('captureScope').inputValue(),'complete');
        await field('enabled').check();await field('automatic').check();await field('allowPrivateNetwork').check();
        assert.equal(await field('automaticMode').inputValue(),'realtime');
        await field('automaticMode').selectOption('previous_day');
        await page.locator('#clpp-type').selectOption('s3');await page.locator('[data-clpp-add]').click();
        assert.equal(await field('jsonlUploadRate').inputValue(),'2');
        await field('endpoint').fill(targetUrl);await field('bucket').fill('demo-archive');await field('accessKeyId').fill('fictional-id');await field('secretAccessKey').fill('fictional-secret');
        await field('s3Format').selectOption('json');
        await page.locator('#clpp-type').selectOption('webhook');await page.locator('[data-clpp-add]').click();
        await field('webhookUrl').fill(targetUrl+'/webhook');await field('webhookToken').fill('fictional-webhook-token');
        await edit('s3');assert.equal(await field('secretAccessKey').inputValue(),'fictional-secret');
        await edit('webhook');assert.equal(await field('webhookToken').inputValue(),'fictional-webhook-token');
        await page.evaluate(()=>conversationLogsUi.load());assert.equal(await field('webhookToken').inputValue(),'fictional-webhook-token');
        await page.locator('#clp-save').click();await page.locator('#clp-message').filter({hasText:'已保存'}).waitFor();
        await edit('s3');assert.equal(await field('secretAccessKey').inputValue(),'');await edit('webhook');assert.equal(await field('webhookToken').inputValue(),'');assert.equal(preview.push.store.list().total,0);
        await edit('s3');await page.locator('[data-clpp-toggle=s3]').uncheck();
        assert.equal(await field('platformEnabled').isChecked(),false);
        await page.locator('[data-clpp-save]').click();await page.locator('#clp-message').filter({hasText:'已保存'}).waitFor();
        assert.equal(preview.push.store.policy().s3.enabled,false);
        await edit('s3');await page.locator('[data-clpp-toggle=s3]').check();
        assert.equal(await field('platformEnabled').isChecked(),true);
        await page.locator('[data-clpp-save]').click();await page.locator('#clp-message').filter({hasText:'已保存'}).waitFor();
        assert.equal(preview.push.store.policy().s3.enabled,true);
        await edit('s3');const savedName=await field('platformName').inputValue();
        await field('platformName').fill('Unsaved platform');await page.locator('[data-clpp-close]').click();
        assert.equal(await page.locator('#clpp-editor').isVisible(),false);
        await edit('s3');assert.equal(await field('platformName').inputValue(),'Unsaved platform');
        const rateCount=await page.locator('#clpp-rates tr').count();
        await page.locator('[data-clpp-add-rate]').click();await page.locator('#clpp-rates tr').last().locator('[data-model]').fill('button-audit');
        await page.locator('#clpp-rates tr').last().locator('[data-price]').fill('123');
        await page.locator(`[data-clpp-rate-remove="${rateCount}"]`).click();assert.equal(await page.locator('#clpp-rates tr').count(),rateCount);
        await page.locator('[data-clp-action=discard]').click();await page.waitForFunction(()=>document.querySelector('#clp-dirty').textContent==='');
        await edit('s3');assert.equal(await field('platformName').inputValue(),savedName);
        await page.locator('#clpp-type').selectOption('s3');await page.locator('[data-clpp-add]').click();
        const unsavedPlatform=await page.locator('[data-clpp-remove]').last().getAttribute('data-clpp-remove');
        await page.locator(`[data-clpp-remove="${unsavedPlatform}"]`).click();assert.equal(await page.locator(`[data-clpp-remove="${unsavedPlatform}"]`).count(),0);
        await page.locator('[data-clp-action=discard]').click();await page.waitForFunction(()=>document.querySelector('#clp-dirty').textContent==='');
        assert.equal(preview.push.store.policy().automaticMode,'previous_day');
        await page.locator('#clp-automatic-status').filter({hasText:'次日 00:00 起 · Asia/Shanghai'}).waitFor();
        await page.reload();await page.locator('#cl-tab-push').click();await field('automaticMode').waitFor();
        assert.equal(await field('automaticMode').inputValue(),'previous_day');
        const scheduleRoute='**/api/conversation-logs/push/jobs?*';
        await page.route(scheduleRoute,async route=>{
          const response=await route.fetch(),value=await response.json();
          Object.assign(value.automatic,{waiting:12,ready:2});await route.fulfill({response,json:value});
        });
        await refresh();
        await page.locator('#clp-automatic-status').filter({hasText:'待自动核对 12 条，已到日期 2 条'}).waitFor();
        await layout();await shot('daily-configuration');
        await page.unroute(scheduleRoute);
        await field('automatic').uncheck();assert.equal(await page.locator('#clp-automatic-options').isVisible(),false);
        await page.locator('#clp-save').click();await page.locator('#clp-message').filter({hasText:'已保存'}).waitFor();
        assert.equal(preview.push.store.policy().automaticMode,'previous_day');
        await field('automatic').check();assert.equal(await field('automaticMode').inputValue(),'previous_day');
        await field('automaticMode').selectOption('realtime');
        await refresh();assert.equal(await field('automaticMode').inputValue(),'realtime');
        await page.locator('#clp-save').click();await page.locator('#clp-message').filter({hasText:'已保存'}).waitFor();
        assert.equal(preview.push.store.policy().automaticMode,'realtime');
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
        const previewRoute='**/api/conversation-logs/push/preview';let releasePreview;
        const waiting=new Promise(resolve=>{releasePreview=resolve;});
        await page.route(previewRoute,async route=>{
          await waiting;await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:{code:'CONVERSATION_PUSH_HISTORY_PREPARING',message:'所选历史日志的推送索引仍在后台准备，请稍后重新预览'}})});
        });
        await page.locator('#clp-preview').click();await page.locator('#clp-preview-status').filter({hasText:'正在预览'}).waitFor();
        assert(await page.locator('#clp-preview').isDisabled());await layout();await shot('preview-loading');releasePreview();
        await page.locator('#clp-preview-status.amber').filter({hasText:'后台准备'}).waitFor();
        await page.waitForFunction(()=>!document.querySelector('#clp-preview').disabled);
        assert.equal(await page.locator('#clp-enqueue').count(),0);await layout();await shot('preview-preparing');
        await page.unroute(previewRoute);await page.route(previewRoute,route=>route.abort('failed'));
        await page.locator('#clp-preview').click();await page.locator('#clp-preview-status.amber').filter({hasText:'运营中心连接失败'}).waitFor();
        await page.unroute(previewRoute);
        const jobsRoute='**/api/conversation-logs/push/jobs?*';
        await page.route(jobsRoute,route=>route.abort('failed'));
        await page.locator('[data-clp-action=refresh]').click();await page.locator('#clp-message.amber').filter({hasText:'运营中心连接失败'}).waitFor();
        await page.unroute(jobsRoute);await page.route(jobsRoute,async route=>{
          const response=await route.fetch(),value=await response.json();value.metadataIndex={ready:false,indexed:2,total:3};
          await route.fulfill({response,json:value});
        });
        await page.locator('[data-clp-action=refresh]').click();await page.locator('#clp-index').filter({hasText:'2 / 3'}).waitFor();
        assert.equal(await page.locator('#clp-message').textContent(),'');await page.unroute(jobsRoute);
        await page.locator('[data-clp-action=refresh]').click();await page.waitForFunction(()=>document.querySelector('#clp-index').textContent==='');
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
        await edit('s3');await field('s3Format').selectOption('jsonl');await field('endpoint').fill(jsonlTarget.url);await page.locator('[data-clpp-toggle=webhook]').uncheck();
        assert.equal(await field('jsonlMaxGB').inputValue(),'10');await field('jsonlTimezone').fill('Asia/Shanghai');await field('jsonlUploadRate').fill('1.5');
        await page.locator('#clp-save').click();await page.locator('#clp-message').filter({hasText:'已保存'}).waitFor();
        assert.equal(preview.push.store.policy().s3.jsonl.uploadMiBPerSecond,1.5);
        await page.locator('[data-clp-test=s3]').click();await page.locator('#clp-test-s3').filter({hasText:'连接成功'}).waitFor();
        assert.equal(JSON.parse(jsonlTarget.completed[0].body.toString()).schema,'sub2api.conversation.test.v1');
        assert(jsonlTarget.completed[0].path.includes('/test/test-'));
        await view('jobs');
        preview.fixture.store.ingest(event(name+'-jsonl-a',{model:'Opus5'}));preview.fixture.store.ingest(event(name+'-jsonl-b',{model:'Opus5'}));preview.fixture.store.ingest(event(name+'-jsonl-c',{model:'Fable5'}));
        await until(()=>preview.push.store.list().counts.some(row=>row.status==='buffered'&&row.count===3));
        await page.locator('[data-clp-action=refresh]').click();await page.locator('#clp-files').filter({hasText:'汇总中'}).waitFor();
        await page.locator('#clp-backlog').filter({hasText:'待上传 2 个文件'}).waitFor();
        await layout();await shot('jsonl-configuration');
        const stateRoute='**/api/conversation-logs/push/jobs?*';
        let pauseReason='archive_busy';
        await page.route(stateRoute,async route=>{
          const response=await route.fetch(),body=await response.json(),value=body.data||body;
          const file=value.jsonl.files[0];file.status='running';file.bytes=10000000000;file.uploaded_bytes=8388608;file.uploaded_parts=1;file.pause_reason=pauseReason;
          file.model='<img src=x onerror=alert(1)>';file.object_key='2026-06-25/Opus5/'+ 'Opus5-'.repeat(12)+'.jsonl';
          Object.assign(value.jsonl.backlog,{atRisk:true,expiryAt:Date.now()+3600000});
          await route.fulfill({response,json:body});
        });
        try {
          await page.locator('[data-clp-action=refresh]').click();await page.locator('#clp-files').filter({hasText:'采集优先，上传暂缓'}).waitFor();
          await page.locator('#clp-backlog.amber').filter({hasText:'到期风险'}).waitFor();
          assert.equal(await page.locator('#clp-files img').count(),0);assert.equal(await page.locator('#clp-files progress').first().getAttribute('value'),'8388608');
          await layout();await shot('jsonl-progress-paused');
          pauseReason='memory_wait';await page.locator('[data-clp-action=refresh]').click();
          await page.locator('#clp-files').filter({hasText:'等待内存恢复，上传进度保留'}).waitFor();
          assert.equal(await page.locator('#clp-files progress').first().getAttribute('value'),'8388608');
          await layout();await shot('jsonl-memory-wait');
        } finally {await page.unroute(stateRoute);}
        await page.locator('[data-clp-action=refresh]').click();
        await page.locator('#clp-flush').click();await waitJobs('sent',9);
        const jsonlFiles=jsonlTarget.completed.filter(file=>Object.hasOwn(JSON.parse(file.body.toString().split('\n')[0]),'request'));
        assert.equal(jsonlFiles.length,2);assert.deepEqual(jsonlFiles.map(file=>file.body.toString().trimEnd().split('\n').length).sort(),[1,2]);
        for(const file of jsonlFiles)assert.match(file.path,/^\/demo-archive\/conversation-logs\/\d{4}-\d{2}-\d{2}\/(Opus5|Fable5)\/\1-\d{4}-\d{2}-\d{2}-\d{8}T\d{9}Z-[a-f0-9]{16}\.jsonl$/);
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
        await view('platforms');await field('captureScope').selectOption('all');await page.locator('#clp-save').click();await page.locator('#clp-message').filter({hasText:'已保存'}).waitFor();await view('jobs');
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
        await edit('webhook');await field('webhookToken').fill('unsaved-sensitive-value');await refresh();assert.equal(await field('webhookToken').inputValue(),'unsaved-sensitive-value');
        await page.locator('#cl-tab-requests').click();assert.equal(await page.locator('#clp-form').count(),0);
        await page.locator('#cl-tab-push').click();await edit('webhook');assert.equal(await field('webhookToken').inputValue(),'');
        assert.equal(await field('captureScope').inputValue(),'all');await edit('s3');assert.equal(await field('jsonlUploadRate').inputValue(),'1.5');await view('jobs');
        const retained=event(name+'-cleanup-original',{model:'Opus5',response:Buffer.from('{invalid').toString('base64')});preview.fixture.store.ingest(retained);
        await until(()=>preview.push.store.list().counts.some(row=>row.status==='buffered'&&row.count===1));
        await page.locator('#clp-flush').click();await waitJobs('sent',13);
        assert(preview.fixture.store.db.prepare('SELECT 1 FROM cl_records WHERE id=?').get(retained.id));
        await view('platforms');await field('deleteAfterPush').check();await page.locator('#clp-save').click();await page.locator('#clp-message').filter({hasText:'已保存'}).waitFor();await view('jobs');
        await until(()=>!preview.fixture.store.db.prepare('SELECT 1 FROM cl_records WHERE id=?').get(retained.id));
        await page.locator('[data-clp-action=refresh]').click();await page.locator('#clp-cleanup').filter({hasText:'已清理'}).waitFor();
        await page.locator('#clp-jobs').filter({hasText:'送达成功，本地已清理'}).waitFor();
        assert.equal(preview.push.store.list().total,13);assert.equal(preview.push.store.list({status:'sent'}).total,13);
        assert(preview.fixture.store.ingest(retained).duplicate);assert(!preview.fixture.store.db.prepare('SELECT 1 FROM cl_records WHERE id=?').get(retained.id));
        assert.equal(await field('deleteAfterPush').isChecked(),true);await layout();await shot('delivered-cleanup');
        await view('platforms');await page.locator('#clpp-type').selectOption('s3');await page.locator('[data-clpp-add]').click();
        await field('platformName').fill('Replica <S3>');await field('endpoint').fill(replicaTarget.url);await field('bucket').fill('replica-archive');
        await field('accessKeyId').fill('replica-fictional-key');await field('secretAccessKey').fill('replica-fictional-secret');
        await field('jsonlUploadRate').fill('64');
        await page.locator('#clpp-rates tr').filter({has:page.locator('[data-model][value="gpt-6.2-sol"]')}).locator('[data-price]').fill('80000');
        await page.locator('[data-clpp-save]').click();await page.locator('#clp-message').filter({hasText:'已保存'}).waitFor();
        const replicaId=preview.push.store.policy().platforms[0].id;
        assert.equal(preview.push.store.policy().platforms[0].name,'Replica <S3>');
        assert.equal(preview.push.store.policy().platforms[0].billing.rates.find(row=>row.model==='gpt-6.2-sol').price,'80000');
        await layout();await shot('multi-platforms');
        rejectReplica=true;const replicated=event(name+'-replicated',{model:'gpt-6.2-sol'});preview.fixture.store.ingest(replicated);
        await until(()=>preview.push.store.list().counts.some(row=>row.status==='buffered'&&row.count===2));
        await view('jobs');await page.locator('#clp-flush').click();await waitJobs('failed',1);
        assert(preview.fixture.store.db.prepare('SELECT 1 FROM cl_records WHERE id=?').get(replicated.id));
        assert.equal(preview.push.store.billing.report({model:'gpt-6.2-sol'}).summary.files,1);
        await page.locator('#clp-files').filter({hasText:'Replica <S3>'}).waitFor();
        rejectReplica=false;await page.locator('[data-clp-file-retry]').click();await waitJobs('sent',15);
        await until(()=>!preview.fixture.store.db.prepare('SELECT 1 FROM cl_records WHERE id=?').get(replicated.id));
        await view('billing');await page.locator('#clp-bill-model').fill('gpt-6.2-sol');await page.locator('[data-clp-action=bill-filter]').click();
        await page.waitForFunction(()=>{const rows=[...document.querySelectorAll('#clp-billing tbody tr')];return rows.length===2&&rows.every(row=>row.cells[1].textContent==='gpt-6.2-sol');});
        await page.locator('#clp-billing').filter({hasText:'80000'}).waitFor();
        assert.equal(await page.locator('#clp-billing tbody tr').count(),2);
        assert.equal(await page.locator('#clp-billing img').count(),0);await layout();await shot('billing-models');
        await page.locator('[data-clp-bill-view=detail]').click();await page.waitForFunction(()=>document.querySelector('#clp-billing thead th').textContent.includes('送达时间'));
        await page.locator('#clp-billing').filter({hasText:'已计费'}).waitFor();
        assert.equal(await page.locator('#clp-billing tbody tr').count(),2);await layout();await shot('billing-detail');
        const oldAmount=preview.push.store.billing.report({model:'gpt-6.2-sol'}).summary.amount;
        await edit(replicaId);await page.locator('#clpp-rates tr').filter({has:page.locator('[data-model][value="gpt-6.2-sol"]')}).locator('[data-price]').fill('100000');
        await page.locator('[data-clpp-add-rate]').click();await page.locator('#clpp-rates tr').last().locator('[data-model]').fill('Opus5');
        await page.locator('#clpp-rates tr').last().locator('[data-price]').fill('12345.6789');
        await page.locator('[data-clpp-save]').click();await page.locator('#clp-message').filter({hasText:'已保存'}).waitFor();
        assert.equal(preview.push.store.billing.report({model:'gpt-6.2-sol'}).summary.amount,oldAmount);
        await edit('s3');await page.locator('[data-clpp-add-rate]').click();await page.locator('#clpp-rates tr').last().locator('[data-model]').fill('Opus5');
        await page.locator('#clpp-rates tr').last().locator('[data-price]').fill('50000');
        await view('billing');assert(await page.locator('[data-clp-action=bill-price]').isDisabled());await view('platforms');
        await page.locator('[data-clpp-save]').click();await page.locator('#clp-message').filter({hasText:'已保存'}).waitFor();
        await view('billing');await page.locator('#clp-bill-model').fill('Opus5');await page.locator('#clp-bill-platform').selectOption('s3');
        await page.locator('[data-clp-action=bill-filter]').click();await page.locator('#clp-billing').filter({hasText:'待定价'}).waitFor();
        await startPricing();await page.locator('#clp-message').filter({hasText:'补记任务已提交'}).waitFor();
        await until(()=>preview.push.store.pricing.status()?.status==='done');
        await page.locator('[data-clp-action=bill-refresh]').click();await page.locator('#clp-bill-pricing').filter({hasText:'补记已完成'}).waitFor();
        assert(preview.push.store.billing.report({model:'Opus5',platform:'s3'}).items.every(row=>row.rate==='50000'));
        await startPricing();await until(()=>preview.push.store.pricing.status()?.status==='done');
        await page.locator('[data-clp-action=bill-refresh]').click();await page.locator('#clp-bill-pricing').filter({hasText:'已补记 0 项'}).waitFor();
        assert.equal(preview.push.store.billing.report({model:'gpt-6.2-sol'}).summary.amount,oldAmount);await layout();await shot('billing-priced');
        await writeBudget(5);const pricingPolicy=preview.push.store.policy();
        preview.push.store.db.transaction(()=>{
          for(let i=0;i<605;i++)preview.push.store.billing.record({id:name+'-background-'+i,platformId:'s3',model:'Opus5',bytes:1000000,
            deliveryId:name+'-background-'+i,sha256:'b'.repeat(64),logDate:'2026-11-20',historical:true,policy:pricingPolicy});
        })();
        await startPricing();await page.locator('#clp-message').filter({hasText:'补记任务已提交'}).waitFor();
        const backgroundId=preview.push.store.pricing.status().id;
        await until(()=>preview.push.store.pricing.status().updated>0);
        await page.locator('[data-clp-action=bill-refresh]').click();await page.locator('[data-clp-action=bill-stop]').waitFor();
        assert(await page.locator('[data-clp-action=bill-price]').isDisabled());await layout();await shot('billing-progress');
        const cancelPricing=page.waitForResponse(response=>response.url().endsWith('/billing/price/'+backgroundId+'/cancel')&&response.request().method()==='POST');
        await page.locator('[data-clp-action=bill-stop]').click();const cancelledPricing=await cancelPricing;
        assert.equal(cancelledPricing.status(),200,await cancelledPricing.text());
        assert.equal((await cancelledPricing.json()).job.status,'cancelled');
        await page.locator('#clp-bill-pricing').filter({hasText:'补记已停止'}).waitFor();
        const stopped=preview.push.store.pricing.status();assert.equal(stopped.status,'cancelled');assert(stopped.updated>0&&stopped.updated<605);
        await startPricing();await page.locator('#clp-message').filter({hasText:'补记任务已提交'}).waitFor();
        assert.notEqual(preview.push.store.pricing.status().id,backgroundId);
        await page.locator('#cl-tab-requests').click();assert.equal(await page.locator('#clp-form').count(),0);
        await until(()=>preview.push.store.pricing.status().status==='done');
        assert.equal(preview.push.store.pricing.status().updated+stopped.updated,605);
        await page.locator('#cl-tab-push').click();await view('billing');
        await page.locator('#clp-bill-pricing').filter({hasText:'补记已完成'}).waitFor();await layout();await shot('billing-background-complete');
        await page.locator('[data-clp-bill-view=detail]').click();
        await page.waitForFunction(()=>!document.querySelector('#clp-bill-next').disabled);
        const pageResponse=(kind,number)=>page.waitForResponse(response=>{
          const url=new URL(response.url());return url.pathname===`/api/conversation-logs/push/${kind}`&&url.searchParams.get('page')===String(number);
        });
        let nextPage=pageResponse('billing',2);await page.locator('#clp-bill-next').click();assert.equal((await(await nextPage).json()).page,2);
        await page.locator('#clp-bill-pages').filter({hasText:'2 /'}).waitFor();
        nextPage=pageResponse('billing',1);await page.locator('#clp-bill-prev').click();assert.equal((await(await nextPage).json()).page,1);
        await writeBudget(6);await preview.push.stop();await view('platforms');await field('automatic').uncheck();await field('deleteAfterPush').uncheck();
        await page.locator('#clp-save').click();await page.locator('#clp-message').filter({hasText:'已保存'}).waitFor();
        const buttonEvents=Array.from({length:25},(_,index)=>event(name+'-button-'+index,{model:'ButtonAudit'}));
        for(const item of buttonEvents)preview.fixture.store.ingest(item);
        await view('jobs');await page.locator('#clp-history [name=search]').fill('ButtonAudit');await page.locator('#clp-preview').click();
        await page.locator('#clp-acknowledge').check();await page.locator('#clp-enqueue').click();
        await until(()=>preview.push.store.list().counts.some(row=>row.status==='pending'&&row.count===50));await refresh();
        nextPage=pageResponse('jobs',2);await page.locator('#clp-next').click();assert.equal((await(await nextPage).json()).page,2);
        await page.locator('#clp-pages').filter({hasText:'2 /'}).waitFor();
        nextPage=pageResponse('jobs',1);await page.locator('#clp-prev').click();assert.equal((await(await nextPage).json()).page,1);
        const cancelledBatch=preview.push.store.list().batches.find(row=>row.created===50);
        assert(cancelledBatch);await page.locator(`[data-clp-cancel="${cancelledBatch.id}"]`).click();
        await until(()=>preview.push.store.list().counts.some(row=>row.status==='cancelled'&&row.count===50));
        for(const item of buttonEvents)assert(preview.fixture.store.db.prepare('SELECT 1 FROM cl_records WHERE id=?').get(item.id));
        await page.locator('#clp-job-status').selectOption('cancelled');await page.locator('[data-clp-retry]').first().click();
        await until(()=>preview.push.store.list().counts.some(row=>row.status==='pending'&&row.count===1));
        assert.equal(preview.push.store.list({status:'cancelled'}).total,49);await layout();await shot('buttons-cancel-retry');
        const safe=await page.evaluate(async()=>JSON.stringify(await(await fetch('/api/conversation-logs/push/policy')).json()));assert(!safe.includes('fictional-webhook-token'));assert(!safe.includes('fictional-secret'));
        await layout();await shot('delivered');
        await page.locator('#logout-button').click();await page.locator('#login-view').waitFor({state:'visible'});assert.equal(await page.locator('#clp-form').count(),0);
        assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
        console.log(name+': platform enable/disable/close/discard/remove, rate add/remove, pagination, batch cancel/retry, multi-platform S3/JSONL/Webhook, drafts, independent rates, failed replica/retry/cleanup, immutable billing, automatic batches/cancel/background progress, schedule/resume/privacy/layout/logout passed');
      } finally {await context.close();await preview.stop();}
    }
    console.log('Screenshots: '+directory);
  } finally {await browser?.close();await jsonlTarget.close();await replicaTarget.close();await new Promise(resolve=>{target.close(resolve);target.closeAllConnections();});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
