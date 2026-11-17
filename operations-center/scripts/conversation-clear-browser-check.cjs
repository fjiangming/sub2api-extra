'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { startPreview } = require('./conversation-logs-live-preview.cjs');
const { event } = require('../tests/conversation-logs-fixture');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'sub2api-clear-browser-'));
  const browser = await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE} : {})});
  try {
    for (const [name,width,height,colorScheme] of [['desktop',1440,1000,'light'],['mobile',390,844,'light'],['narrow',320,740,'light'],['dark',1440,1000,'dark']]) {
      const preview = await startPreview({port:0}),context = await browser.newContext({viewport:{width,height},colorScheme});
      try {
        let permit = false;preview.cleanup.canWork = () => permit;preview.cleanup.intervalMs = 30;
        const f = preview.fixture,policy = f.store.policy();
        const initial = f.store.db.prepare('SELECT COUNT(*) n FROM cl_records').get().n;
        const page = await context.newPage(),errors = [],external = [];
        let interruptStatus = false;
        await page.route('**/api/conversation-logs/history-clear',route => {
          if (interruptStatus && route.request().method() === 'GET') {interruptStatus = false;return route.abort('failed');}
          return route.continue();
        });
        page.on('pageerror',error => errors.push(error.message));
        page.on('request',request => {if (!request.url().startsWith(`http://127.0.0.1:${preview.port}/`) && !/^(?:blob:|data:)/.test(request.url())) external.push(request.url());});
        const shot = async suffix => {
          await page.evaluate(() => scrollTo(0,0));
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),false,name + ' overflow');
          const clipped = await page.locator('#cl-history-clear .button').evaluateAll(nodes => nodes.filter(node => node.getBoundingClientRect().right > innerWidth + 1 || node.scrollWidth > node.clientWidth + 1).map(node => node.textContent));
          assert.deepEqual(clipped,[],name + ' clipped controls');
          await page.screenshot({path:path.join(directory,name + '-' + suffix + '.png'),fullPage:true});
        };
        await page.goto(`http://127.0.0.1:${preview.port}/preview`);
        const start = page.locator('[data-clear-start]'),stop = page.locator('[data-clear-stop]');
        await page.waitForFunction(() => document.querySelector('[data-clear-start]')?.disabled === false);
        await page.locator('#cl-filter [name=search]').fill('no-matching-history');await page.locator('#cl-filter [type=submit]').click();
        await page.locator('#cl-list').filter({hasText:'当前筛选下没有记录'}).waitFor();await shot('ready');
        page.once('dialog',async dialog => {assert(dialog.message().includes('全部用户、全部模型'));await dialog.dismiss();});
        await start.click();assert.equal(preview.cleanup.store.pending(),null);
        interruptStatus = true;
        page.once('dialog',dialog => dialog.accept());await start.click();await stop.waitFor();
        assert.equal(preview.cleanup.status('all').job.deleted,0);assert(await start.isDisabled());await shot('running');
        assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM cl_model_cleanups WHERE scope='all'").get().n,1);
        await stop.click();await page.locator('#cl-history-clear').filter({hasText:'清空已停止'}).waitFor();
        assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM cl_records').get().n,initial);
        page.once('dialog',dialog => dialog.accept());await start.click();await stop.waitFor();
        const fresh = event(name + '-fresh-after-clear',{policy_version:policy.version});assert(f.store.ingest(fresh).accepted);
        await page.locator('#cl-tab-sessions').click();permit = true;
        await page.locator('#cl-history-clear').filter({hasText:'历史清空完成'}).waitFor({timeout:20000});
        assert.equal(preview.cleanup.status('all').job.deleted,initial);assert.deepEqual(f.store.db.prepare('SELECT id FROM cl_records').all(),[{id:fresh.id}]);
        assert.equal(f.store.payload(fresh.id,'original','request').body.toString('base64'),fresh.request);assert.deepEqual(f.store.policy(),policy);
        await page.reload();await page.locator('#cl-history-clear').filter({hasText:'历史清空完成'}).waitFor();
        await page.locator(`[data-cl-record="${fresh.id}"]`).waitFor();await shot('done');
        assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
        console.log(name + ': confirmation/cancel, status failure recovery, global scope despite filters, stop, background completion, new arrivals, reload and layout passed');
      } finally {await context.close();await preview.stop();}
    }
    console.log('Screenshots: ' + directory);
  } finally {await browser.close();}
}

main().catch(error => {console.error(error);process.exitCode = 1;});
