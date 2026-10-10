'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseResponse,buildBody,ProviderRegistry } = require('../src/providers');
const { encrypt,decrypt,publicAddress,safeUrl,checkIp } = require('../src/security');
const { loadConfig } = require('../src/config');
const { normalizeRequest } = require('../src/request');
const { demoCatalog } = require('../src/demo');

test('encrypted credentials survive restarts and reject changed keys or tampering',() => {
  const key = loadConfig({},true).encryptionKey;
  const sealed = encrypt({ apiKey:'secret',body:'original bytes' },key);
  assert.deepEqual(decrypt(sealed,key),{ apiKey:'secret',body:'original bytes' });
  assert.throws(() => decrypt(sealed,Buffer.alloc(32,8).toString('base64')));
  assert.throws(() => decrypt(sealed.slice(0,-4)+'AAAA',key));
});
test('private, mapped, link-local and metadata endpoints are blocked',() => {
  for (const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','::1','::ffff:127.0.0.1','fc00::1','fe80::1']) assert.equal(publicAddress(ip),false,ip);
  assert.throws(() => safeUrl('https://169.254.169.254/',['169.254.169.254']));
  assert.throws(() => safeUrl('https://evil.example/',['supplier.example']));
  assert.throws(() => safeUrl('https://user:secret@supplier.example/',['supplier.example']));
});
test('IP deny rules override allow rules and IPv4-mapped clients normalize correctly',() => {
  checkIp({ ip_whitelist:['127.0.0.0/8'] },'::ffff:127.0.0.1');
  assert.throws(() => checkIp({ ip_whitelist:['127.0.0.0/8'],ip_blacklist:['127.0.0.1'] },'127.0.0.1'));
});
test('Lingsu and XCM responses normalize status, nested identity and financial proof',() => {
  const lingsu = parseResponse({}, { id:'lv_test',status:'completed',funds_status:'captured',quoted_price:'2.1',content_url:'/v1/videos/lv_test/content' });
  assert.equal(lingsu.completed,true); assert.equal(lingsu.amount,'2.10000000');
  const xcm = parseResponse({}, { data:{ task_id:'job_test',status:'succeeded',video_url:'https://cdn.example/test.mp4' } });
  assert.equal(xcm.id,'job_test'); assert.equal(xcm.completed,true);
  assert.throws(() => parseResponse({}, { id:'../admin',status:'done' }));
});
test('Lingsu reference and special models use their own request contracts',() => {
  const request = { model:'public',prompt:'test',duration:30,aspect_ratio:'16:9',resolution:'720p',references:[{ type:'image',source:'data:image/png;base64,AAAA',role:'reference' }] };
  const special = JSON.parse(buildBody({ upstreamModel:'supplier-special',requestStyle:'lingsu-special' },request));
  assert.equal(special.duration,30); assert.equal(special.ratio,'16:9'); assert.deepEqual(special.images,['AAAA']);
  const reference = JSON.parse(buildBody({ upstreamModel:'supplier-full',requestStyle:'lingsu-references' },request));
  assert.equal(reference.seconds,30); assert.equal(reference.references[0].source,request.references[0].source);
});
test('generic driver can map nested request and response fields without executable expressions',() => {
  const body = JSON.parse(buildBody({ upstreamModel:'custom',fields:{ duration:'options.seconds',aspect_ratio:'options.ratio' } },{ model:'public',prompt:'test',duration:10,resolution:'720p',aspect_ratio:'16:9',references:[] }));
  assert.deepEqual(body.options,{ seconds:10,ratio:'16:9' });
  const response = parseResponse({ response:{ idPaths:['task.key'],statusPaths:['task.state'],success:['ready'] } },{ task:{ key:'task-1',state:'ready' } });
  assert.equal(response.completed,true);
  assert.throws(() => buildBody({ upstreamModel:'custom',fields:{ duration:'__proto__.polluted' } },{ duration:5 }));
  assert.equal({}.polluted,undefined);
});
test('unsupported durations, conflicting aliases and reference protocols are rejected',() => {
  const model = { ...demoCatalog().models[0],maxReferences:{ image:1,video:0,audio:0,total:1 } };
  assert.throws(() => normalizeRequest({ model:model.id,prompt:'test',duration:5,seconds:10 },model));
  assert.throws(() => normalizeRequest({ model:model.id,prompt:'test',duration:31 },model));
  assert.throws(() => normalizeRequest({ model:model.id,prompt:'test',references:[{ type:'image',source:'http://127.0.0.1/x' }] },model));
});
test('live quote increases reject spending before create',async () => {
  const registry = new ProviderRegistry({ json:async () => ({ amount:'10' }) });
  await assert.rejects(registry.quote({ quote:{ path:'/quote',method:'GET',amountPath:'amount',currency:'CNY',mode:'per_request' } },{ upstreamModel:'x' },{ duration:5 },'{}',{ currency:'CNY',quotedAmountBound:'2.1' }),{ code:'SUPPLIER_QUOTE_INCREASED' });
});
