'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { startPreview } = require('./conversation-logs-live-preview.cjs');
const { event } = require('../tests/conversation-logs-fixture');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sub2api-cleanup-browser-'));
  const browser = await chromium.launch({ headless:true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE} : {}) });
  try {
    for (const [name,width,height,colorScheme] of [['desktop',1440,1000,'light'],['mobile',390,844,'light'],['narrow',320,740,'light'],['dark',1440,1000,'dark']]) {
      const preview = await startPreview({port:0}), context = await browser.newContext({viewport:{width,height},colorScheme});
      try {
        const f=preview.fixture, outside=[event(name+'-outside',{model:'deepseek-v4.1'}),event(name+'-unknown',{model:''})];
        const keep=[event(name+'-alias',{model:'Fable5.1'}),event(name+'-kimi',{model:'Kimi K4'})];
        for(const row of [...outside,...keep])assert(f.store.ingest(row).accepted);
        const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
        const layout=async()=>{assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,name+' overflow');};
        const shot=async suffix=>{await page.evaluate(()=>scrollTo(0,0));await layout();await page.screenshot({path:path.join(directory,name+'-'+suffix+'.png'),fullPage:true});};
        await page.goto(`http://127.0.0.1:${preview.port}/preview`);await page.locator('#cl-tab-policy').click();
        const button=page.locator('[data-cl-action=cleanup-models]');await button.waitFor();assert(await button.isDisabled());
        await page.locator('[name=modelFilterEnabled]').check();await page.locator('[name=allowedModels]').fill('example-model\ngpt-6.1-sol\nFable5.1');await page.locator('[name=kimiK3Plus]').check();
        assert(await button.isDisabled());await page.locator('#cl-save').click();
        await button.waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('[data-cl-action=cleanup-models]')?.disabled);
        await shot('ready');
        await button.click();await page.locator('[data-cl-action=stop-model-cleanup]').waitFor();
        await page.locator('[data-cl-action=stop-model-cleanup]').click();await page.locator('#cl-cleanup-progress').filter({hasText:'已停止'}).waitFor();
        assert.equal(preview.cleanup.status().job.status,'cancelled');
        await button.click();
        const policy=f.store.policy(),fresh=event(name+'-fresh',{model:'gpt-6.1-sol',policy_version:policy.version});assert(f.store.ingest(fresh).accepted);
        await page.locator('#cl-cleanup-progress').filter({hasText:'清理完成'}).waitFor();
        for(const row of outside)assert.equal(f.store.db.prepare('SELECT id FROM cl_records WHERE id=?').get(row.id),undefined);
        for(const row of [...keep,fresh,preview.raw])assert.equal(f.store.payload(row.id,'original','request').body.toString('base64'),row.request);
        await page.reload();await page.locator('#cl-tab-policy').click();await page.locator('#cl-cleanup-progress').filter({hasText:'清理完成'}).waitFor();
        await shot('done');
        await page.locator('[name=allowedModels]').fill('gpt-6.1-sol');assert(await button.isDisabled());
        await page.locator('#cl-tab-requests').click();assert.equal(await page.locator('#cl-model-cleanup:visible').count(),0);
        assert.deepEqual(errors,[]);console.log(name+': saved-model gates, cancel, background cleanup, aliases/Kimi, new records, reload and layout passed');
      } finally {await context.close();await preview.stop();}
    }
    console.log('Screenshots: '+directory);
  } finally {await browser.close();}
}

main().catch(error=>{console.error(error);process.exitCode=1;});
