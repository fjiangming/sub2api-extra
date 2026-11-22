'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { startPreview } = require('./group-monitor-preview.cjs');

async function main() {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sub2api-group-monitor-ui-'));
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
  const results=[];
  try {
    for(const [name,width,height,colorScheme]of [['desktop',1440,1000,'light'],['embedded',1060,900,'light'],['mobile',390,844,'light'],['narrow',320,740,'light'],['dark',1060,900,'dark']]) {
      const preview=await startPreview({port:0}),origin=`http://127.0.0.1:${preview.port}`;
      const context=await browser.newContext({viewport:{width,height},colorScheme,hasTouch:width<700,isMobile:width<700});
      try {
        const page=await context.newPage(),errors=[],external=[];
        page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(!request.url().startsWith(origin))external.push(request.url());});
        await context.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
        await page.goto(`${origin}/preview`);await page.locator('[data-gm-group-row]').first().waitFor();
        const layout=async()=>{
          const value=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth+1,escaped:[...document.querySelectorAll('#gm-root button,#gm-root input,#gm-root select')].filter(n=>n.getBoundingClientRect().width&&!n.closest('[hidden],.table-wrap,dialog:not([open])')).filter(n=>{const r=n.getBoundingClientRect();return r.left<0||r.right>innerWidth+1;}).map(n=>n.id||n.outerHTML.slice(0,70)),dialog:[...document.querySelectorAll('.gm-dialog[open]')].some(n=>n.getBoundingClientRect().right>innerWidth+1)}));
          assert.deepEqual(value,{overflow:false,escaped:[],dialog:false},`${name} layout ${JSON.stringify(value)}`);
        };
        const metric=label=>page.locator(`[data-gm-metric="${label}"]`);
        assert.equal(await metric('全部分组').innerText(),'12');assert.equal(await metric('请求正常').innerText(),'7');assert.equal(await metric('请求失败').innerText(),'2');assert.equal(await metric('倍率异常').innerText(),'5');
        await layout();await page.screenshot({path:path.join(directory,`${name}-requests.png`),fullPage:true});
        await page.locator('#gm-group-pages [data-gm-size]').selectOption('10');await page.waitForFunction(()=>document.querySelectorAll('[data-gm-group-row]').length===10);
        await page.locator('#gm-group-pages [aria-label="下一页"]').click();await page.waitForFunction(()=>document.querySelectorAll('[data-gm-group-row]').length===2);
        await page.locator('#gm-search').fill('未命中分组');await page.waitForFunction(()=>document.querySelectorAll('[data-gm-group-row]').length===0);
        await page.locator('#gm-search').fill('');await page.waitForFunction(()=>document.querySelectorAll('[data-gm-group-row]').length===10);
        await page.locator('#gm-platform').selectOption('openai');await page.waitForFunction(()=>document.querySelectorAll('[data-gm-group-row]').length===4);
        await page.locator('#gm-platform').selectOption('all');await page.locator('#gm-status').selectOption('failed');await page.waitForFunction(()=>document.querySelectorAll('[data-gm-group-row]').length===2);
        await page.locator('#gm-status').selectOption('all');await page.locator('#gm-tab-anomalies').click();await page.locator('[data-gm-finding-row]').first().waitFor();
        assert.equal(await page.locator('[data-gm-finding-row]').count(),5);await layout();await page.screenshot({path:path.join(directory,`${name}-anomalies.png`),fullPage:true});
        await page.locator('[data-gm-finding-row]').filter({hasText:'claude-shared-02'}).locator('[data-gm-finding]').click();await page.locator('#gm-dialog[open]').waitFor();
        assert.match(await page.locator('#gm-dialog-body').innerText(),/Claude 高优/);await layout();await page.screenshot({path:path.join(directory,`${name}-shared-account.png`),fullPage:true});await page.locator('#gm-close').click();
        await page.locator('#gm-scope').selectOption('unknown');await page.waitForFunction(()=>document.querySelectorAll('[data-gm-finding-row]').length===1);assert.match(await page.locator('#gm-findings-table').innerText(),/倍率待核验/);
        await preview.fixture.database.exec('UPDATE accounts SET rate_multiplier=0.8 WHERE id=102');await page.locator('#gm-rescan').click();await page.waitForFunction(()=>document.querySelector('#gm-rescan').disabled===false&&document.querySelector('[data-gm-metric="倍率异常"]').textContent==='4');
        await page.locator('#gm-scope').selectOption('history');await page.waitForFunction(()=>document.querySelectorAll('[data-gm-finding-row]').length===1&&document.querySelector('#gm-findings-table').textContent.includes('已解除'));assert.match(await page.locator('#gm-findings-table').innerText(),/已解除/);
        await page.locator('#gm-tab-requests').click();await page.locator('#gm-search').fill('Claude 特价');await page.locator('[data-gm-group="3"]').first().waitFor();await page.locator('[data-gm-group="3"]').first().click();await page.locator('#gm-dialog[open]').waitFor();
        assert.match(await page.locator('#gm-dialog-body').innerText(),/不参与/);await layout();await page.screenshot({path:path.join(directory,`${name}-group-accounts.png`),fullPage:true});
        await page.locator('#gm-model').fill('claude-sonnet-4-5');await page.locator('#gm-save-group').click();await page.locator('#gm-dialog').waitFor({state:'hidden'});await page.waitForFunction(()=>document.querySelector('[data-gm-group-row="3"]').textContent.includes('待检测'));
        await page.locator('#gm-search').fill('Gemini 新分组');await page.locator('[data-gm-group="10"]').first().waitFor();await page.locator('[data-gm-group="10"]').first().click();await page.locator('#gm-dialog[open]').waitFor();
        await page.locator('#gm-model').fill('gemini-2.5-flash');await page.locator('#gm-key').fill(preview.fixture.keys.get('1'));await page.locator('#gm-save-group').click();await page.waitForFunction(()=>document.querySelector('#gm-form-error').textContent.includes('不属于该分组'));
        assert.equal(await page.locator('#gm-dialog-footer [data-gm-retest]').isDisabled(),true);
        await page.locator('#gm-key').fill(preview.fixture.keys.get('10'));await page.locator('#gm-save-group').click();await page.locator('#gm-dialog').waitFor({state:'hidden'});
        assert.equal(await page.locator('#gm-key').count(),0);
        await page.locator('#gm-settings').click();await page.locator('#gm-timeout').fill('0');await page.locator('#gm-save-settings').click();await page.waitForFunction(()=>document.querySelector('#gm-form-error').textContent.length>0);
        await page.locator('#gm-timeout').fill('5');await page.locator('#gm-concurrency').fill('1');await page.locator('#gm-auto').uncheck();await layout();await page.screenshot({path:path.join(directory,`${name}-settings.png`),fullPage:true});await page.locator('#gm-save-settings').click();await page.locator('#gm-dialog').waitFor({state:'hidden'});
        await page.locator('#gm-search').fill('Claude 备用');await page.locator('[data-gm-retest="8"]').first().waitFor();preview.fixture.failGroups.delete('8');await page.locator('[data-gm-retest="8"]').first().click();await page.waitForFunction(()=>document.querySelector('[data-gm-group-row="8"]').textContent.includes('请求正常'));
        await page.locator('#gm-search').fill('');await page.waitForFunction(()=>document.querySelectorAll('[data-gm-group-row]').length===10);
        preview.fixture.setDelay(200);await page.locator('#gm-run-all').click();await page.locator('#gm-progress:not([hidden])').waitFor();await page.locator('#gm-stop').click();await page.locator('#gm-progress').waitFor({state:'hidden'});
        preview.fixture.setDelay(0);await page.locator('#gm-run-all:not(:disabled)').click();await page.waitForFunction(()=>document.querySelector('#gm-run-summary').textContent.includes('上轮已完成')&&document.querySelector('[data-gm-metric="请求正常"]').textContent==='9');
        assert.equal(await metric('请求失败').innerText(),'1');await layout();
        await page.locator('#gm-search').fill('OpenAI 测试');await page.locator('[data-gm-group="9"]').first().waitFor();await page.locator('[data-gm-group="9"]').first().click();await page.locator('#gm-dialog[open]').waitFor();assert.match(await page.locator('#gm-dialog-body').innerText(),/HTTP 401/);await page.locator('#gm-close').click();
        await page.locator('#gm-settings').click();
        await page.keyboard.press('Escape');
        await page.locator('[data-view="overview"]').click();await page.waitForFunction(()=>!document.querySelector('.gm-dialog[open]'));assert.equal(await page.locator('#gm-key').count(),0);
        await page.evaluate(()=>document.querySelector('[data-view="group-monitor"]').click());await page.locator('[data-gm-group-row]').first().waitFor();
        await page.locator('#logout-button').click();await page.locator('#login-view:not([hidden])').waitFor();assert.equal(await page.locator('[data-gm-group-row]').count(),0);
        assert.deepEqual(errors,[]);assert.deepEqual(external,[]);results.push({name,width,status:'passed',pageErrors:errors.length,externalRequests:external.length});console.log(JSON.stringify(results.at(-1)));
      }finally{await context.close();await preview.stop();}
    }
    fs.writeFileSync(path.join(directory,'verification.json'),JSON.stringify(results,null,2));console.log(`Screenshots: ${directory}`);
  }finally{await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
