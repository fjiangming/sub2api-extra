'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const {startPreview} = require('./conversation-logs-live-preview.cjs');
const {event,id} = require('../tests/conversation-logs-fixture');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'sub2api-conversation-browser-'));
  const preview = await startPreview({port:0}); let browser;
  try {
    browser = await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE} : {})});
    for (const [name,width,height,colorScheme] of [['desktop',1440,1000,'light'],['mobile',390,844,'light'],['narrow',320,740,'light'],['dark',1440,1000,'dark']]) {
      const context = await browser.newContext({viewport:{width,height},colorScheme,acceptDownloads:true});
      try {
        const page = await context.newPage(), errors = [], external = [];
        await page.addInitScript(() => { Object.defineProperty(navigator,'clipboard',{value:{writeText:async text => { window.conversationCopiedText = text; }}}); });
        page.on('pageerror',error => errors.push(error.message));
        page.on('request',request => { if (!request.url().startsWith(`http://127.0.0.1:${preview.port}/`) && !/^(?:blob:|data:)/.test(request.url())) external.push(request.url()); });
        const layout = async () => {
          const result = await page.evaluate(() => ({overflow:document.documentElement.scrollWidth > innerWidth + 1,controls:[...document.querySelectorAll('#cl-root input,#cl-root select,#cl-root textarea,#cl-root .button')].filter(node => node.getBoundingClientRect().width).filter(node => node.getBoundingClientRect().right > innerWidth + 1).map(node => node.outerHTML)}));
          assert.equal(result.overflow,false,name + ' page overflow'); assert.deepEqual(result.controls,[]);
        };
        await page.goto(`http://127.0.0.1:${preview.port}/preview`);
        await page.locator(`[data-cl-record="${preview.raw.id}"]`).click();
        await page.locator('#cl-body-request').filter({hasText:'EMAIL_'}).waitFor();
        assert.equal(await page.locator('#cl-inspector img').count(),0);
        await layout(); await page.screenshot({path:path.join(directory,name + '-requests.png'),fullPage:true});
        await page.locator('#cl-source').selectOption('original');
        await page.waitForFunction(() => document.getElementById('cl-body-request').textContent.includes('alice@example.com'));
        const text = await page.locator('#cl-body-request').innerText(); assert(text.includes('9007199254740993')); assert(text.includes('1.2300'));
        assert.equal(await page.locator('#cl-inspector img').count(),0);
        const downloadEvent = page.waitForEvent('download'); await page.locator('[data-cl-download=request]').click();
        const downloaded = await downloadEvent; assert.deepEqual(fs.readFileSync(await downloaded.path()),Buffer.from(preview.raw.request,'base64'));
        await page.locator(`[data-cl-record="${id('privacy-case')}"]`).click();
        await page.locator('#cl-body-request').filter({hasText:'IDENTITY_'}).waitFor();
        const privateText = await page.locator('#cl-body-request').textContent();
        for (const value of ['张三','11010519491231002X','4111111111111111','E12345678','测试路','246810']) assert(!privateText.includes(value));
        assert(JSON.parse(privateText).messages[0].content.includes(JSON.parse(privateText).customer.name));
        await layout(); await page.screenshot({path:path.join(directory,name + '-privacy.png'),fullPage:true});
        await page.locator(`[data-cl-record="${id('ws-case')}"]`).click(); await page.locator('[data-cl-detail=frames]').click();
        await page.locator('[data-cl-frame="1"]').click(); await page.locator('#cl-body-frame-1').filter({hasText:'EMAIL_'}).waitFor();
        await layout(); await page.screenshot({path:path.join(directory,name + '-frames.png'),fullPage:true});
        await page.locator('#cl-tab-sessions').click(); await page.locator('[data-cl-session]').first().waitFor();
        await page.locator('[data-cl-session]').first().click(); await page.locator('#cl-session-filter button').waitFor();
        await page.locator('[data-cl-action=clear-session]').click();
        await page.locator('#cl-filter [name=search]').fill('NO_MATCH'); await page.locator('#cl-filter [type=submit]').click();
        await page.locator('#cl-list').filter({hasText:'没有记录'}).waitFor();
        await page.locator('[data-cl-action=reset-filter]').click(); await page.locator('[data-cl-record]').first().waitFor();
        const csvEvent = page.waitForEvent('download'); await page.locator('[data-cl-action=export]').click(); const csv = await csvEvent;
        assert(fs.readFileSync(await csv.path(),'utf8').includes('request_id'));
        await page.locator('#cl-tab-collection').click(); await page.locator('#cl-collection h2').waitFor(); await layout();
        await page.locator('#cl-tab-policy').click(); await page.locator('#cl-policy-form').waitFor();
        assert.equal(await page.locator('[name=limit]').count(),0);
        for (const field of ['identity','financial','personal','device']) assert(await page.locator(`#cl-policy-form input[name=${field}]`).isChecked());
        await page.locator('[name=retention]').fill('0');
        await page.locator('#cl-user-search').fill('2'); await page.locator('[data-cl-user="2"]').waitFor(); await page.locator('[data-cl-user="2"]').check();
        await page.locator('[data-cl-action=add-rule]').click(); await page.locator('[data-rule-from]').fill('ORION-42'); await page.locator('[data-rule-to]').fill('<ORDER>');
        await page.locator('[name=modelFilterEnabled]').check();
        await page.locator('[name=allowedModels]').fill('gpt-6.1-sol\nFable5.1\nGemini carbon');
        await page.locator('[name=kimiK3Plus]').check();
        await layout(); await page.screenshot({path:path.join(directory,name + '-policy.png'),fullPage:true});
        await page.locator('#cl-save').click(); await page.waitForFunction(() => document.getElementById('cl-save')?.disabled === false && document.getElementById('cl-excluded-count')?.textContent.includes('1 位'));
        assert.deepEqual(preview.fixture.store.policy().excludedUserIds,[2]);
        const selectedPolicy = preview.fixture.store.policy(), before = preview.fixture.store.status();
        assert(selectedPolicy.modelFilterEnabled && selectedPolicy.kimiK3Plus);
        assert.equal(selectedPolicy.retention,0); assert.equal(selectedPolicy.overflow,'stop');
        for (const field of ['identity','financial','personal','device']) assert(selectedPolicy[field]);
        assert.deepEqual(selectedPolicy.allowedModels,['claude-fable-5-1','gemini-carbon','gpt-6.1-sol']);
        for (const [label,model,user_id] of [['excluded','gpt-6.1-sol',2],['unlisted','claude-fable-5-2',3],['unknown','',3]]) {
          assert.equal(preview.fixture.store.ingest(event(label + '-' + name,{user_id,model,policy_version:selectedPolicy.version})).accepted,false);
        }
        const unchanged = preview.fixture.store.status();
        for (const key of ['records','gaps','bytes']) assert.equal(unchanged[key],before[key],key);
        for (const model of ['gpt-6.1-sol','Fable5.1','Kimi K4']) {
          assert.equal(preview.fixture.store.ingest(event(model + '-' + name,{user_id:3,model,at:preview.raw.at-30000,policy_version:selectedPolicy.version})).accepted,true);
        }
        await page.reload(); await page.locator('#cl-tab-policy').click(); await page.locator('[data-cl-remove-user="2"]').waitFor();
        assert.equal(await page.locator('[name=retention]').inputValue(),'0');
        assert(await page.locator('[name=modelFilterEnabled]').isChecked());
        assert(await page.locator('[name=kimiK3Plus]').isChecked());
        assert.equal(await page.locator('[name=allowedModels]').inputValue(),'claude-fable-5-1\ngemini-carbon\ngpt-6.1-sol');
        await page.locator('[data-cl-action=clear-users]').click(); await page.locator('[data-cl-action=remove-rule]').click();
        await page.locator('[name=allowedModels]').fill(''); await page.locator('[name=kimiK3Plus]').uncheck(); await page.locator('#cl-save').click();
        await page.waitForFunction(() => document.getElementById('cl-save')?.disabled === false && document.getElementById('cl-excluded-count')?.textContent.includes('0 位'));
        assert.deepEqual(preview.fixture.store.policy().excludedUserIds,[]);
        assert.equal(preview.fixture.store.ingest(event('empty-models-' + name,{model:'gpt-6.1-sol',policy_version:preview.fixture.store.policy().version})).accepted,false);
        await page.locator('[name=modelFilterEnabled]').uncheck(); await page.locator('#cl-save').click();
        await page.waitForFunction(() => document.getElementById('cl-save')?.disabled === false);
        assert.equal(preview.fixture.store.policy().modelFilterEnabled,false);
        const largeText = JSON.stringify({ content: 'a'.repeat(350000) + ' END_OF_FULL_RESPONSE' });
        const large = event('large-' + name,{at:Date.now()+1000,request:preview.raw.request,response:Buffer.from(largeText).toString('base64'),policy_version:preview.fixture.store.policy().version});
        assert.equal(preview.fixture.store.ingest(large).accepted,true);
        await page.locator('#cl-tab-requests').click();
        await page.locator(`[data-cl-record="${large.id}"]`).click();
        await page.waitForFunction(() => document.getElementById('cl-body-response')?.textContent.length === 65536);
        await page.locator('[data-cl-full=response]').waitFor({state:'visible'});
        await page.locator('[data-cl-copy=response]').click();
        await page.waitForFunction(() => window.conversationCopiedText?.includes('END_OF_FULL_RESPONSE'));
        assert.equal(await page.evaluate(() => window.conversationCopiedText),largeText);
        const fullDownloadEvent = page.waitForEvent('download'); await page.locator('[data-cl-download=response]').click();
        const fullDownload = await fullDownloadEvent;
        assert.deepEqual(fs.readFileSync(await fullDownload.path()),Buffer.from(largeText));
        assert.equal((await page.locator('#cl-body-response').textContent()).length,65536);
        await layout(); await page.screenshot({path:path.join(directory,name + '-large-preview.png'),fullPage:true});
        await page.locator('[data-cl-full=response]').click();
        await page.waitForFunction(() => document.getElementById('cl-body-response')?.textContent.includes('END_OF_FULL_RESPONSE'));
        assert.equal(await page.locator('#cl-body-response').textContent(),largeText);
        await page.locator('[data-cl-full=response]').waitFor({state:'hidden'});
        const failedPolicy = preview.fixture.store.configure({...preview.fixture.store.policy(),mode:'masked',custom:[{from:'call_demo',to:'broken'}]});
        const failed = event('retry-ui-' + name,{at:Date.now()+2000,policy_version:failedPolicy.version}); preview.fixture.store.ingest(failed);
        await page.locator('[data-cl-action=reset-filter]').click(); await page.locator(`[data-cl-record="${failed.id}"]`).click();
        await page.locator('.cl-processing').filter({hasText:'PROTECTED_FIELD_MATCH'}).waitFor();
        await page.locator('#cl-body-response').filter({hasText:'alice@example.com'}).waitFor();
        await layout(); await page.screenshot({path:path.join(directory,name + '-processing-error.png'),fullPage:true});
        preview.fixture.store.configure({...preview.fixture.store.policy(),modelFilterEnabled:true,allowedModels:['gpt-6.1-sol'],kimiK3Plus:false});
        await page.locator('[data-cl-action=reset-filter]').click();
        await page.locator('.cl-processing').filter({hasText:'该模型不在采集名单中'}).waitFor();
        assert(await page.locator('[data-cl-action=reprocess]').isDisabled());
        preview.fixture.store.configure({...preview.fixture.store.policy(),modelFilterEnabled:false});
        await page.locator('[data-cl-action=reset-filter]').click();
        await page.waitForFunction(() => document.querySelector('[data-cl-action=reprocess]')?.disabled === false);
        const firstAttempt = preview.fixture.store.detail(failed.id).processed_at;
        await page.locator('[data-cl-action=reprocess]').click();
        await page.waitForFunction(() => document.querySelector('[data-cl-action=reprocess]')?.disabled === false);
        assert(preview.fixture.store.detail(failed.id).processed_at > firstAttempt);
        assert(preview.fixture.store.detail(failed.id).original);
        preview.fixture.store.configure({...preview.fixture.store.policy(),custom:[]});
        await page.locator('[data-cl-action=reset-filter]').click();
        await page.locator(`[data-cl-record="${failed.id}"][aria-pressed=true]`).waitFor();
        // Hold the mutation response to check duplicate clicks and late-response isolation.
        let release, arrived, delivered;
        const held = new Promise(resolve => { release = resolve; }), reached = new Promise(resolve => { arrived = resolve; }), fulfilled = new Promise(resolve => { delivered = resolve; });
        const routePath = `**/records/${failed.id}/reprocess`;
        await page.route(routePath,async route => { const response = await route.fetch(); arrived(); await held; await route.fulfill({response}); delivered(); });
        await page.locator('[data-cl-action=reprocess]').click(); await reached;
        assert.equal(await page.locator('[data-cl-action=reprocess]').isDisabled(),true);
        await page.locator(`[data-cl-record="${large.id}"]`).click();
        release(); await fulfilled; await page.unroute(routePath);
        await page.waitForFunction(() => document.getElementById('cl-body-response')?.textContent.includes('aaaa'));
        assert(!await page.locator('.cl-processing').count());
        await page.locator(`[data-cl-record="${failed.id}"]`).click();
        await page.locator('#cl-body-response').filter({hasText:'EMAIL_'}).waitFor();
        assert.equal(await page.locator('.cl-processing').count(),0);
        assert.equal(await page.locator('#cl-source option[value=original]').isDisabled(),true);
        assert.equal(preview.fixture.store.detail(failed.id).original,false);
        await layout(); await page.screenshot({path:path.join(directory,name + '-reprocessed.png'),fullPage:true});
        const sig = 'ZmljdGlvbmFsLXByb3RvY29sLXNpZ25hdHVyZQ==';
        const signed = event('signature-ui-' + name,{at:Date.now()+3000,policy_version:preview.fixture.store.policy().version,request:Buffer.from(JSON.stringify({messages:[
          {role:'assistant',content:[{type:'thinking',thinking:'alice@example.com',signature:sig}]},
          {role:'user',content:'continue',url:'https://service.example/contact?email=alice@example.com&keep=ok'}
        ]})).toString('base64')});
        assert(preview.fixture.store.ingest(signed).accepted);
        await page.locator('[data-cl-action=reset-filter]').click();await page.locator(`[data-cl-record="${signed.id}"]`).click();
        await page.locator('.cl-processing').filter({hasText:'可读文本已处理'}).waitFor();
        await page.locator('#cl-body-request').filter({hasText:'EMAIL_'}).waitFor();
        const signedText=await page.locator('#cl-body-request').textContent();assert(signedText.includes(sig));assert(!signedText.includes('alice@example.com'));
        assert(JSON.parse(signedText).messages[1].url.startsWith('https://service.example/contact?email=%3CEMAIL_'));
        assert.equal(preview.fixture.store.detail(signed.id).processing_error,'');assert(preview.fixture.store.detail(signed.id).original);
        assert.equal(await page.locator('#cl-source option[value=original]').isDisabled(),false);
        assert((await page.locator('.cl-processing').textContent()).includes('暂停脱敏推送'));
        const retrySignature=page.waitForResponse(response=>response.url().endsWith(`/records/${signed.id}/reprocess`)&&response.request().method()==='POST');
        await page.locator('[data-cl-action=reprocess]').click();assert.equal((await retrySignature).status(),200);
        await page.waitForFunction(()=>document.querySelector('[data-cl-action=reprocess]')?.disabled===false);
        assert.deepEqual(preview.fixture.store.detail(signed.id).inspection_warnings,['OPAQUE_SIGNATURE']);
        await layout();await page.screenshot({path:path.join(directory,name+'-inspection-warning.png'),fullPage:true});
        const legacy = event('legacy-url-ui-'+name,{at:Date.now()+4000,policy_version:preview.fixture.store.policy().version,
          request:Buffer.from('{"url":"https://service.example/contact?email=alice%40example.com&keep=ok"}').toString('base64')});
        assert(preview.fixture.store.ingest(legacy).accepted);
        // Emulate an old URL failure with an exact retained original, then retry through the real archive process.
        preview.fixture.store.db.prepare("UPDATE cl_records SET original=?,masked=NULL,processing_error='UNINSPECTABLE_CONTENT',redaction_version=0,redaction_policy_hash='' WHERE id=?")
          .run(preview.fixture.store.seal({request:legacy.request,response:legacy.response,frames:[]},legacy.id+':original'),legacy.id);
        await page.locator('[data-cl-action=reset-filter]').click();await page.locator(`[data-cl-record="${legacy.id}"]`).click();
        await page.locator('.cl-processing').filter({hasText:'UNINSPECTABLE_CONTENT'}).waitFor();
        const retryUrl=page.waitForResponse(response=>response.url().endsWith(`/records/${legacy.id}/reprocess`)&&response.request().method()==='POST');
        await page.locator('[data-cl-action=reprocess]').click();assert.equal((await retryUrl).status(),200);
        await page.locator('#cl-body-request').filter({hasText:'EMAIL_'}).waitFor();
        await page.waitForFunction(()=>!document.querySelector('.cl-processing'));
        assert(!preview.fixture.store.detail(legacy.id).original);assert.deepEqual(preview.fixture.store.detail(legacy.id).inspection_warnings,[]);
        await layout();await page.screenshot({path:path.join(directory,name+'-legacy-link-reprocessed.png'),fullPage:true});
        await page.locator('#logout-button').click(); await page.locator('#login-view').waitFor({state:'visible'});
        assert.equal(await page.locator('#cl-list [data-cl-record]').count(),0); assert.equal(await page.locator('#cl-inspector').innerText(),'选择一条请求查看原始请求与响应');
        assert.deepEqual(errors,[]); assert.deepEqual(external,[]);
        console.log(name + ': raw bytes, XSS, WS frames, model gates, fallback, signature warnings, legacy URL retry, late responses and logout passed');
      } finally { await context.close(); }
    }
    console.log('Screenshots: ' + directory);
  } finally { await browser?.close(); await preview.stop(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
