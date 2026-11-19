'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { startPreview } = require('./conversation-logs-live-preview.cjs');
const { event } = require('../tests/conversation-logs-fixture');
const { REDACTION_VERSION } = require('../src/services/conversation-sensitive');

async function until(check) {const end = Date.now() + 20000;while (!check()) {assert(Date.now() < end,'Redaction browser task did not settle');await new Promise(resolve => setTimeout(resolve,30));}}
async function configureFixture(store,policy) {
  const end = Date.now() + 5000;
  for (;;) {
    try {return store.configure(policy);} catch (error) {
      if (!/^SQLITE_(?:BUSY|LOCKED)/.test(error.code || '') || Date.now() >= end) throw error;
      await new Promise(resolve => setTimeout(resolve,30));
    }
  }
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'sub2api-redaction-browser-'));
  const browser = await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE} : {})});
  try {
    for (const [name,width,height,colorScheme] of [['desktop',1440,1000,'light'],['mobile',390,844,'light'],['narrow',320,740,'light'],['dark',1440,1000,'dark']]) {
      const preview = await startPreview({port:0}),context = await browser.newContext({viewport:{width,height},colorScheme,acceptDownloads:true});
      try {
        const f = preview.fixture,canWork = preview.repair.canWork;let permit = false;
        preview.repair.canWork = () => permit && canWork();preview.repair.intervalMs = 40;
        const source = JSON.stringify({model:'claude-opus-5-5',tools:[{name:'Read',input_schema:{type:'object'}}],tool_choice:{type:'tool',name:'Read'},messages:[{role:'user',content:'Read 2026-11-19; alice@example.com'},{role:'assistant',content:[{type:'tool_use',id:'toolu_demo',name:'Read',input:{path:'/file'}}]}]});
        const sample = event(name + '-repair-tools',{at:Date.now()+2000,policy_version:f.store.policy().version,request:Buffer.from(source).toString('base64')});assert(f.store.ingest(sample).accepted);
        const raw = f.store.db.prepare('SELECT original FROM cl_records WHERE id=?').get(sample.id).original;
        f.store.db.prepare('UPDATE cl_records SET redaction_version=6,masked=? WHERE id=?').run(f.store.seal(Buffer.from('old damaged tool names'),sample.id + ':masked'),sample.id);
        f.store.configure({...f.store.policy(),mode:'masked'});const missing = event(name + '-no-original',{policy_version:f.store.policy().version});assert(f.store.ingest(missing).accepted);
        f.store.configure({...f.store.policy(),mode:'original'});const original = event(name + '-original-only',{policy_version:f.store.policy().version});assert(f.store.ingest(original).accepted);
        f.store.configure({...f.store.policy(),mode:'dual'});
        const page = await context.newPage(),errors = [],external = [];
        page.on('pageerror',error => errors.push(error.message));
        page.on('request',request => {if (!request.url().startsWith(`http://127.0.0.1:${preview.port}/`) && !/^(?:blob:|data:)/.test(request.url())) external.push(request.url());});
        const shot = async suffix => {
          await page.evaluate(() => scrollTo(0,0));
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),false,name + ' overflow');
          const clipped = await page.locator('#cl-history-clear .button').evaluateAll(nodes => nodes.filter(node => node.getBoundingClientRect().width && (node.getBoundingClientRect().right > innerWidth + 1 || node.scrollWidth > node.clientWidth + 1)).map(node => node.textContent));
          assert.deepEqual(clipped,[],name + ' clipped controls');await page.screenshot({path:path.join(directory,name + '-' + suffix + '.png'),fullPage:true});
        };
        await page.goto(`http://127.0.0.1:${preview.port}/preview`);
        const start = page.locator('[data-redaction-start]'),stop = page.locator('[data-redaction-stop]'),summary = page.locator('[data-redaction-status]');
        await page.waitForFunction(() => document.querySelector('[data-redaction-start]')?.disabled === false);
        assert(await start.evaluate(node => node.previousElementSibling?.hasAttribute('data-clear-start')));await shot('ready');
        page.once('dialog',async dialog => {assert(dialog.message().includes('无原文'));await dialog.dismiss();});await start.click();assert.equal(preview.repair.store.pending(),null);
        page.once('dialog',dialog => dialog.accept());await start.click();await stop.waitFor();assert(await start.isDisabled());assert.equal(preview.repair.child,null);
        await page.reload();await stop.waitFor();await page.locator('#cl-tab-collection').click();await page.locator('[data-repair-start]').waitFor();assert(await page.locator('[data-repair-start]').isDisabled());
        assert((await page.locator('#cl-history-repair').textContent()).includes('历史重新脱敏正在进行'));
        await stop.click();await summary.filter({hasText:'重新脱敏已停止'}).waitFor();assert.deepEqual(f.store.db.prepare('SELECT original FROM cl_records WHERE id=?').get(sample.id).original,raw);
        page.once('dialog',dialog => dialog.accept());await start.click();await stop.waitFor();
        const fresh = event(name + '-after-task',{at:Date.now()+3000,policy_version:f.store.policy().version});assert(f.store.ingest(fresh).accepted);
        const processedAt = f.store.detail(fresh.id).processed_at;
        permit = true;preview.repair.wake();await until(() => preview.repair.status('redaction').job.scanned >= 1);permit = false;
        await until(() => !preview.repair.busy);assert(preview.repair.child);
        await page.locator('#cl-tab-requests').click();await page.locator(`[data-cl-record="${fresh.id}"]`).waitFor();
        await page.locator(`[data-cl-record="${fresh.id}"]`).click();await page.locator('#cl-body-request').filter({hasText:'EMAIL_'}).waitFor();
        await shot('running-readable');
        await page.locator('#cl-export-limit').fill('2');await page.locator('#cl-export-source').selectOption('original');
        const arriving = page.waitForEvent('download');await page.locator('[data-cl-action=export]').click();const file = await arriving;
        const exported = fs.readFileSync(await file.path(),'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
        assert.equal(exported.length,2);assert.deepEqual(exported.map(row => row.request_id),[fresh.request_id,sample.request_id]);assert.equal(exported[1].request,source);
        permit = true;await until(() => preview.repair.status('redaction').job.status === 'done');
        await summary.filter({hasText:'历史重新脱敏完成'}).waitFor();assert((await summary.textContent()).includes('无原文 1'));assert((await summary.textContent()).includes('仅存原文 1'));
        assert.equal(f.store.detail(fresh.id).processed_at,processedAt);assert.equal(f.store.detail(sample.id).redaction_version,REDACTION_VERSION);
        assert.deepEqual(f.store.db.prepare('SELECT original FROM cl_records WHERE id=?').get(sample.id).original,raw);
        await page.locator(`[data-cl-record="${sample.id}"]`).click();await page.locator('#cl-body-request').filter({hasText:'2026-11-19'}).waitFor();
        const body = await page.locator('#cl-body-request').textContent();assert(body.includes('Read'));assert(!body.includes('alice@example.com'));
        const saved = JSON.parse(f.store.payload(sample.id,'masked','request').text);assert.equal(saved.tools[0].name,saved.messages[1].content[0].name);assert.equal(saved.tools[0].name,'Read');await shot('done');
        await page.reload();await summary.filter({hasText:'历史重新脱敏完成'}).waitFor();
        permit = false;page.once('dialog',dialog => dialog.accept());await start.click();await stop.waitFor();await configureFixture(f.store,{...f.store.policy(),phone:false});permit = true;preview.repair.wake();
        await summary.filter({hasText:'保存策略已变化'}).waitFor();await shot('paused');
        await page.locator('#logout-button').click();await page.locator('#login-view').waitFor({state:'visible'});assert.equal(await page.locator('[data-redaction-start]').count(),0);
        assert.deepEqual(errors,[]);assert.deepEqual(external,[]);console.log(name + ': confirmation, persistence, scope isolation, stop, live reads/downloads, rebuild, missing originals, fresh arrivals, policy pause and layout passed');
      } finally {await context.close();await preview.stop();}
    }
    console.log('Screenshots: ' + directory);
  } finally {await browser.close();}
}
main().catch(error => {console.error(error);process.exitCode = 1;});
