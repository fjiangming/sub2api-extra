'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MockAgent } = require('undici');
const { SafeHttpClient } = require('../src/http-client');
const { fixture } = require('./helpers');
const { decrypt } = require('../src/security');
const { parseResponse } = require('../src/providers');

async function mockHttp(t) {
  const http = new SafeHttpClient();
  await http.dispatcher.close();
  const agent = new MockAgent();
  agent.disableNetConnect();
  http.dispatcher = agent;
  t.after(() => agent.close());
  return { http,agent,pool:agent.get('https://supplier.example') };
}

test('Lingsu HTTP workflow preserves header/body and automatically settles funds',async t => {
  const f = await fixture(t);
  const mock = await mockHttp(t);
  f.catalog.providers[0].type = 'lingsu';
  f.catalog.providers[0].baseUrl = 'https://supplier.example';
  f.catalog.providers[0].apiKey = 'upstream-test-secret';
  f.catalog.models[0].requestStyle = 'lingsu-references';
  f.registry.http = mock.http;
  const job = await f.reserve();
  const snapshot = decrypt(job.secret_snapshot,f.config.encryptionKey);
  assert.equal(JSON.parse(snapshot.supplierBody).seconds,5);
  assert.equal(JSON.parse(snapshot.supplierBody).duration,undefined);
  mock.pool.intercept({ path:'/v1/videos',method:'POST',body:snapshot.supplierBody,
    headers:{ authorization:'Bearer upstream-test-secret','idempotency-key':job.id } }).reply(202,{ id:'lv_http',status:'queued',funds_status:'reserved',quoted_price:'0.1' });
  await f.processOne();
  mock.pool.intercept({ path:'/v1/videos/lv_http',method:'GET',headers:{ authorization:'Bearer upstream-test-secret' } })
    .reply(200,{ id:'lv_http',status:'completed',funds_status:'captured',quoted_price:'0.1',content_url:'/v1/videos/lv_http/content' });
  await f.db.query('UPDATE video_adapter.jobs SET next_poll_at=NOW()');
  await f.processOne();
  mock.pool.intercept({ path:'/v1/videos/lv_http/download',method:'GET' }).reply(200,'video-fixture',{ headers:{ 'content-type':'video/mp4' } });
  assert.equal((await f.api(`/v1/videos/${job.id}/content`)).body,'video-fixture');
  assert.equal((await f.db.query('SELECT funds_state FROM video_adapter.jobs')).rows[0].funds_state,'captured');
  mock.agent.assertNoPendingInterceptors();
});
test('supplier errors and malformed JSON never get interpreted as successful tasks',async t => {
  const { http,pool } = await mockHttp(t);
  const provider = { baseUrl:'https://supplier.example',apiKey:'secret',downloadHosts:[] };
  pool.intercept({ path:'/bad',method:'GET' }).reply(200,'not-json');
  await assert.rejects(http.json(provider,'/bad'),{ code:'UPSTREAM_JSON_INVALID' });
  pool.intercept({ path:'/missing',method:'GET' }).reply(404,{ error:'missing' });
  await assert.rejects(http.json(provider,'/missing'),{ code:'UPSTREAM_HTTP_ERROR',upstreamStatus:404 });
});
test('download redirects strip credentials on an explicitly allowed media host',async t => {
  const { http,agent,pool } = await mockHttp(t);
  const provider = { baseUrl:'https://supplier.example',apiKey:'secret',downloadHosts:['media.example'] };
  pool.intercept({ path:'/content',method:'GET',headers:{ authorization:'Bearer secret' } })
    .reply(302,'',{ headers:{ location:'https://media.example/file.mp4' } });
  agent.get('https://media.example').intercept({ path:'/file.mp4',method:'GET',headers:headers => !('authorization' in headers) })
    .reply(200,'video',{ headers:{ 'content-type':'video/mp4' } });
  const response = await http.request(provider,'/content',{ download:true });
  assert.equal(await response.text(),'video');
  agent.assertNoPendingInterceptors();
});
test('API redirects and unregistered/private download targets are rejected',async t => {
  const { http,pool } = await mockHttp(t);
  const provider = { baseUrl:'https://supplier.example',apiKey:'secret',downloadHosts:[] };
  pool.intercept({ path:'/api',method:'GET' }).reply(302,'',{ headers:{ location:'https://supplier.example/other' } });
  await assert.rejects(http.json(provider,'/api'),{ code:'REDIRECT_DENIED' });
  pool.intercept({ path:'/content',method:'GET' }).reply(302,'',{ headers:{ location:'https://169.254.169.254/metadata' } });
  await assert.rejects(http.request(provider,'/content',{ download:true }),{ code:'UNSAFE_URL' });
});

test('numeric supplier amounts and large task IDs preserve their original decimal text',async t => {
  const { http,pool } = await mockHttp(t);
  const provider = { baseUrl:'https://supplier.example',apiKey:'secret',downloadHosts:[] };
  pool.intercept({ path:'/precise',method:'GET' }).reply(200,'{"id":9007199254740993,"quoted_price":0.100000000000000001,"status":"completed"}');
  const result = parseResponse(provider,await http.json(provider,'/precise'));
  assert.equal(result.id,'9007199254740993');
  assert.equal(result.amount,'0.10000001');
});
