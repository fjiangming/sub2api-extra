'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { startPreview } = require('./conversation-logs-live-preview.cjs');
const { event } = require('../tests/conversation-logs-fixture');

const b64 = value => Buffer.from(value).toString('base64');
const terminal = 'data: {"type":"response.completed","response":{"id":"resp_demo","object":"response","status":"completed","output":[]}}\n\n';
const encrypted = 'gAAAAAB_fictional-encrypted-reasoning_12345678901234567890==';
async function until(check) {
  const end = Date.now() + 20000;
  while (!check()) { assert(Date.now() < end,'History browser task did not settle'); await new Promise(resolve => setTimeout(resolve,40)); }
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'sub2api-repair-browser-'));
  const browser = await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE} : {})});
  try {
    for (const [name,width,height,colorScheme] of [['desktop',1440,1000,'light'],['mobile',390,844,'light'],['narrow',320,740,'light'],['dark',1440,1000,'dark']]) {
      const preview = await startPreview({port:0}),context = await browser.newContext({viewport:{width,height},colorScheme});
      try {
        let permit = false;preview.repair.canWork = () => permit;preview.repair.intervalMs = 30;
        const f = preview.fixture,at = Date.now(),p = f.store.configure({...f.store.policy(),mode:'masked'});
        const sample = (seed,extra = {}) => event(name + '-' + seed,{at:at + 1000,policy_version:p.version,protocol:'SSE',complete:false,reason:'read_error',response:b64(terminal),...extra});
        const current = sample('current',{at:at + 3000,request:b64(JSON.stringify({model:'gpt-6.1-sol',input:[{type:'reasoning',encrypted_content:encrypted,summary:[{type:'summary_text',text:'alice@example.com'}]}]}))});
        const legacy = sample('legacy',{at:at + 2000,request:current.request});
        const file = sample('business-file',{request:b64(JSON.stringify({messages:[{role:'tool',tool_call_id:'call_safe',content:JSON.stringify([{file_id:'123456789',email:'alice@example.com',note:'reference 123456789'}])}]}))});
        const maskedOnly = sample('masked-only'),fake = sample('fake-terminal',{response:b64('data: ' + JSON.stringify({type:'response.output_text.delta',delta:terminal}) + '\n\n')});
        for (const row of [current,legacy,file,maskedOnly,fake]) assert(f.store.ingest(row).accepted);
        f.store.db.prepare("UPDATE cl_records SET masked=NULL,processing_error='UNINSPECTABLE_CONTENT',redaction_version=3,completion_version=0,upstream_status='unknown',completion_source='',archived_at=0 WHERE id=?").run(legacy.id);
        f.store.db.prepare("UPDATE cl_records SET completion_version=0,upstream_status='unknown',completion_source='',archived_at=0 WHERE id=?").run(maskedOnly.id);
        const original = f.store.payload(legacy.id,'original','request').body;
        const page = await context.newPage(),errors = [],external = [];
        page.on('pageerror',error => errors.push(error.message));
        page.on('request',request => {if (!request.url().startsWith(`http://127.0.0.1:${preview.port}/`) && !/^(?:blob:|data:)/.test(request.url())) external.push(request.url());});
        const shot = async suffix => {
          await page.evaluate(() => scrollTo(0,0));
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),false,name + ' overflow');
          const clipped = await page.locator('#cl-root .button').evaluateAll(nodes => nodes.filter(node => node.getBoundingClientRect().width && (node.getBoundingClientRect().right > innerWidth + 1 || node.scrollWidth > node.clientWidth + 1)).map(node => node.textContent));
          assert.deepEqual(clipped,[],name + ' clipped controls');
          await page.screenshot({path:path.join(directory,name + '-' + suffix + '.png'),fullPage:true});
        };
        await page.goto(`http://127.0.0.1:${preview.port}/preview`);
        await page.locator(`[data-cl-record="${current.id}"]`).click();
        await page.locator('#cl-body-request').filter({hasText:'EMAIL_'}).waitFor();
        const inspector = await page.locator('#cl-inspector').textContent();
        for (const text of ['上游已完成','传输采集异常','模型加密推理','内部未检查','不会放宽推送']) assert(inspector.includes(text),text);
        assert(!inspector.includes('处理异常'));assert((await page.locator('#cl-body-request').textContent()).includes(encrypted));
        await shot('encrypted-reasoning');
        await page.locator(`[data-cl-record="${fake.id}"]`).click();await page.locator('#cl-inspector').filter({hasText:'部分采集'}).waitFor();
        assert(!(await page.locator('#cl-inspector').textContent()).includes('上游已完成'));
        await page.locator(`[data-cl-record="${legacy.id}"]`).click();await page.locator('.cl-processing').filter({hasText:'UNINSPECTABLE_CONTENT'}).waitFor();
        await page.locator('#cl-tab-collection').click();
        const start = page.locator('[data-repair-start]');await start.waitFor();await page.waitForFunction(() => document.querySelector('[data-repair-start]')?.disabled === false);
        await start.click();await page.locator('[data-repair-stop]').waitFor();assert(await start.isDisabled());
        await page.locator('[data-repair-stop]').click();await page.locator('#cl-history-repair').filter({hasText:'已停止'}).waitFor();
        assert.deepEqual(f.store.payload(legacy.id,'original','request').body,original);
        permit = true;await start.click();await page.locator('#cl-tab-requests').click();
        await until(() => preview.repair.status().job?.status === 'done');
        await page.reload();await page.locator('#cl-tab-collection').click();await page.locator('#cl-history-repair').filter({hasText:'检查完成'}).waitFor();
        assert.equal(preview.repair.status().job.repaired,1);assert.equal(preview.repair.status().job.analyzed,2);
        await shot('history-done');assert.deepEqual(f.store.payload(legacy.id,'original','request').body,original);
        await page.locator('#cl-tab-requests').click();await page.locator(`[data-cl-record="${legacy.id}"]`).click();
        await page.locator('.cl-processing').filter({hasText:'模型加密推理'}).waitFor();assert(!f.store.detail(legacy.id).processing_error);
        await page.locator(`[data-cl-record="${maskedOnly.id}"]`).click();await page.locator('#cl-inspector').filter({hasText:'副本含完成事件'}).waitFor();
        assert(!(await page.locator('#cl-inspector').textContent()).includes('上游已完成'));await shot('masked-evidence');
        await page.locator(`[data-cl-record="${file.id}"]`).click();await page.locator('#cl-body-request').filter({hasText:'IDENTITY_'}).waitFor();
        assert(!f.store.detail(file.id).processing_error);assert.deepEqual(f.store.detail(file.id).inspection_warnings,[]);
        permit = false;await page.locator('#cl-tab-collection').click();await page.waitForFunction(() => document.querySelector('[data-repair-start]')?.disabled === false);await start.click();
        f.store.configure({...f.store.policy(),retention:0});permit = true;
        await page.locator('#cl-history-repair').filter({hasText:'检查已暂停'}).waitFor();await shot('policy-paused');
        await page.locator('#logout-button').click();await page.locator('#login-view').waitFor({state:'visible'});
        assert.equal(await page.locator('#cl-history-repair').count(),0);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
        console.log(name + ': encrypted scope, transport evidence, business IDs, background repair, cancel, reload, policy pause and layout passed');
      } finally {await context.close();await preview.stop();}
    }
    console.log('Screenshots: ' + directory);
  } finally {await browser.close();}
}
main().catch(error => {console.error(error);process.exitCode = 1;});
