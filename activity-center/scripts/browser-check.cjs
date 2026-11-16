'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { startPreview } = require('./preview.cjs');

function playwright() {
  if (process.env.PLAYWRIGHT_MODULE) return require(process.env.PLAYWRIGHT_MODULE);
  try { return require('playwright'); }
  catch { return require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
}

async function run() {
  const output = fs.mkdtempSync(path.join(os.tmpdir(),'sub2api-activity-browser-'));
  const preview = await startPreview({ port: 0 });
  const browser = await playwright().chromium.launch({ headless: true,channel: 'chrome' });
  const errors = [];
  const results = [];
  try {
    for (const [name,width,height,scheme] of [['desktop',1440,1040,'light'],['mobile',390,844,'light'],['narrow',320,760,'light'],['dark',1440,1040,'dark']]) {
      preview.source.values.set('42',6000000);
      const context = await browser.newContext({ viewport: { width,height },colorScheme: scheme });
      const page = await context.newPage();
      page.on('pageerror',error => errors.push(error.message));
      page.on('request',request => { if (!request.url().startsWith(preview.base)) errors.push(`unexpected request ${request.url()}`); });
      await page.goto(`${preview.base}/?token=preview-user`);
      await page.locator('#single-draw').waitFor({ state: 'visible' });
      await page.waitForFunction(() => !document.querySelector('#single-draw').disabled);
      assert(!page.url().includes('token='));
      assert.equal(await page.locator('[role=tab]').count(),1);
      assert.equal(await page.locator('#open-ledger').count(),0);
      assert.equal(await page.locator('#ledger-total').count(),0);
      const content = await page.locator('#activity-view').innerText();
      assert(!/概率|解锁|门槛|活动规则|每充值|5000元|2000元|1000元/.test(content));
      assert.equal(await page.locator('#recharge-link').count(),0);
      assert(await page.evaluate(() => {
        const canvas = document.querySelector('#wheel');
        const pixels = canvas.getContext('2d').getImageData(0,0,720,720).data;
        let visible = 0; const colors = new Set();
        for (let i=0;i<pixels.length;i+=64) { if (pixels[i+3]) { visible++; colors.add(`${pixels[i]},${pixels[i+1]},${pixels[i+2]}`); } }
        return visible > 4000 && colors.size > 12;
      }));
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: path.join(output,`${name}-user.png`),fullPage: true });
      const before = preview.store.used('42');
      await page.evaluate(() => { document.querySelector('#single-draw').click(); document.querySelector('#single-draw').click(); });
      await page.waitForFunction(() => document.querySelector('#outcome').textContent.includes('本次获得'));
      assert.equal(preview.store.used('42'),before+1);
      const batchId = preview.store.db.prepare('SELECT batch_id FROM rewards WHERE user_id=? ORDER BY created_at DESC LIMIT 1').get('42').batch_id;
      const row = preview.store.batch('42',batchId).rewards[0];
      const landing = await page.evaluate(() => Number(document.querySelector('#wheel').style.transform.match(/[\d.]+/)[0]) % 360);
      const expected = (360-([50,100,200,300,500,1000,2000,5000].indexOf(row.amountMinor)*45+22.5))%360;
      assert.equal(landing,expected);
      await page.locator('[data-count="10"]').click();
      await page.waitForFunction(() => document.querySelector('#outcome').textContent.includes('10 次共获得'));
      assert.equal(preview.store.used('42'),before+11);
      await page.locator('#batch-detail').click(); assert.equal(await page.locator('.batch-results > span').count(),10);
      await page.screenshot({ path: path.join(output,`${name}-batch.png`),fullPage: true });
      await page.locator('#close-dialog').click();
      // The same UUID is kept after a committed response is lost; recovery cannot spend twice.
      let lost = false;
      await page.route('**/api/activities/recharge-lottery/draw',async route => {
        if (lost) return route.continue();
        lost = true; await route.fetch(); await route.abort('failed');
      });
      await page.locator('#single-draw').click(); await page.locator('#recover-draw').waitFor({ state: 'visible' });
      await page.waitForFunction(() => !document.querySelector('#recover-draw').disabled);
      const spent = preview.store.used('42');
      await page.locator('#recover-draw').click();
      await page.waitForFunction(() => document.querySelector('#recover-draw').hidden && !document.querySelector('#single-draw').disabled);
      assert.equal(preview.store.used('42'),spent);
      await page.unroute('**/api/activities/recharge-lottery/draw');
      await page.reload(); await page.locator('#single-draw').waitFor({ state: 'visible' });
      await page.waitForFunction(() => !document.querySelector('#single-draw').disabled);
      assert.equal(await page.locator('#open-ledger').count(),0);
      await context.close();

      const adminContext = await browser.newContext({ viewport: { width,height },colorScheme: scheme });
      const admin = await adminContext.newPage(); admin.on('pageerror',error => errors.push(error.message));
      await admin.goto(`${preview.base}/?token=preview-admin`);
      await admin.locator('#open-ledger').click(); await admin.locator('#ledger-rows button').first().waitFor();
      assert.equal(await admin.locator('#ledger-total').innerText(),`¥${(preview.store.ledgerSummary().totalMinor/100).toLocaleString('zh-CN',{ minimumFractionDigits: 2,maximumFractionDigits: 2 })}`);
      assert(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await admin.screenshot({ path: path.join(output,`${name}-ledger.png`),fullPage: true });
      await admin.locator('[name=status]').selectOption('failed'); await admin.locator('#ledger-filters button[type=submit]').click();
      await admin.waitForFunction(() => document.querySelector('#ledger-rows').textContent.includes('入账异常'));
      await admin.locator('#ledger-rows button').first().click(); await admin.locator('#detail-dialog[open]').waitFor();
      await admin.screenshot({ path: path.join(output,`${name}-detail.png`),fullPage: true });
      if (name === 'dark') {
        await admin.locator('#retry-credit').click();
        await admin.waitForFunction(() => !document.querySelector('#retry-credit'));
      }
      await admin.locator('#close-dialog').click();
      await admin.locator('#clear-filters').click();
      await admin.locator('[name=query]').fill('no-matching-user'); await admin.locator('#ledger-filters button[type=submit]').click();
      await admin.waitForFunction(() => document.querySelector('#ledger-rows').textContent.includes('没有符合条件'));
      assert.equal(await admin.locator('#ledger-total').innerText(),`¥${(preview.store.ledgerSummary().totalMinor/100).toLocaleString('zh-CN',{ minimumFractionDigits: 2,maximumFractionDigits: 2 })}`);
      await admin.locator('#back-activity').click(); assert.equal(await admin.locator('#ledger-total').count(),0);
      await adminContext.close();
      results.push(name);
    }
    const context = await browser.newContext({ viewport: { width: 390,height: 844 },reducedMotion: 'reduce' });
    const page = await context.newPage(); page.on('pageerror',error => errors.push(error.message));
    const used = preview.store.used('42');
    preview.source.values.set('42',used*5000+4999);
    await page.goto(`${preview.base}/?token=preview-user`);
    await page.waitForFunction(() => document.querySelector('#available').textContent === '0');
    assert(await page.locator('#single-draw').isDisabled());
    preview.source.values.set('42',used*5000+5001);
    await page.locator('#refresh-rewards').click(); await page.waitForFunction(() => !document.querySelector('#single-draw').disabled);
    assert(await page.locator('[data-count="10"]').isDisabled());
    await page.locator('#single-draw').click(); await page.waitForFunction(() => document.querySelector('#outcome').textContent.includes('本次获得'));
    assert.equal(preview.store.used('42'),used+1);
    preview.source.values.set('42',6000000);
    await page.locator('#refresh-rewards').click(); await page.waitForFunction(() => !document.querySelector('[data-count="50"]').disabled);
    for (const count of [20,50]) {
      const before = preview.store.used('42');
      await page.locator(`[data-count="${count}"]`).click();
      await page.waitForFunction(n => document.querySelector('#outcome').textContent.includes(`${n} 次共获得`),count);
      assert.equal(preview.store.used('42'),before+count);
      await page.locator('#batch-detail').click(); assert.equal(await page.locator('.batch-results > span').count(),count);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.locator('#close-dialog').click();
      await page.waitForFunction(() => !document.querySelector('#single-draw').disabled);
    }
    await context.close();
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({ passed: results,checks: 'wheel pixels/landing, hidden parameters, single tab, single/batch/recovery, session reload, roles, ledger filters/details/retry, fractional cash, reduced motion, layouts',screenshots: output },null,2));
  } finally { await browser.close(); await preview.close(); }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
