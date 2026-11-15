'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { fixture,event,id,rawRequest,rawResponse } = require('./conversation-logs-fixture');
const { ConversationLogStore, defaults } = require('../src/conversation-log-store');
const { maskPayload } = require('../src/services/conversation-redaction');
const { createApp } = require('../src/app');
const { AuthService } = require('../src/auth');

test('raw archive keeps bytes, unknown fields and numeric spelling; disk bodies and policies are encrypted', t => {
  const f = fixture(); t.after(() => f.close());
  const row = event(); assert.equal(f.store.ingest(row).accepted,true);
  assert.equal(f.store.payload(row.id,'original','request').body.toString(),rawRequest);
  assert.equal(f.store.payload(row.id,'original','response').body.toString(),rawResponse);
  const masked = f.store.payload(row.id,'masked','request').text;
  assert(!masked.includes('alice@example.com')); assert(!masked.includes('202-555-0148'));
  assert(masked.includes('9007199254740993')); assert(masked.includes('1.2300')); assert(masked.includes('"unknown":{"keep":true}'));
  const response = JSON.parse(f.store.payload(row.id,'masked','response').text);
  assert.equal(response.output[0].call_id,'call_demo'); assert.equal(response.output[0].name,'lookup');
  assert.equal(JSON.parse(response.output[0].arguments).email,JSON.parse(masked).messages[0].content.match(/<EMAIL_[A-F0-9]+>/)[0]);
  f.store.configure({...f.store.policy(),custom:[{from:'ORION-42',to:'<ORDER>'}]});
  f.store.db.pragma('wal_checkpoint(TRUNCATE)');
  for (const file of fs.readdirSync(f.store.directory)) {
    const bytes = fs.readFileSync(path.join(f.store.directory,file));
    for (const secret of ['alice@example.com','ORION-42',rawRequest]) assert(!bytes.includes(Buffer.from(secret)),file + ' contains plaintext');
  }
  assert.equal(f.store.list().items[0].original,true);
  assert(!JSON.stringify(f.store.detail(row.id)).includes('alice@example.com'));
});

for (const protocol of ['responses','chat','claude','gemini','arguments']) test(`split ${protocol} stream masks across fragments without breaking protocol structure`, () => {
  let chunks;
  if (protocol === 'responses') chunks = ['alice@','example.com'].map(delta => ({type:'response.output_text.delta',item_id:'item_safe',delta}));
  if (protocol === 'chat') chunks = ['alice@','example.com'].map(content => ({id:'chat_safe',choices:[{index:0,delta:{content}}]}));
  if (protocol === 'claude') chunks = ['alice@','example.com'].map(text => ({type:'content_block_delta',index:0,delta:{type:'text_delta',text}}));
  if (protocol === 'gemini') chunks = ['alice@','example.com'].map(text => ({candidates:[{index:0,content:{parts:[{text}],role:'model'}}]}));
  if (protocol === 'arguments') chunks = ['{"email":"alice@','example.com"}'].map(delta => ({type:'response.function_call_arguments.delta',item_id:'item_safe',delta}));
  const stream = chunks.map(chunk => 'data: ' + JSON.stringify(chunk) + '\r\n\r\n').join('') + 'data: [DONE]\r\n\r\n';
  const result = maskPayload({request:Buffer.from('{}'),response:Buffer.from(stream),frames:[]},defaults,Buffer.alloc(32,1));
  const text = result.payload.response.toString();
  assert(!text.includes('alice@')); assert(!text.includes('example.com')); assert(text.includes('EMAIL_'));
  assert.equal(text.split('data: ').length,4); assert(text.endsWith('data: [DONE]\r\n\r\n'));
  assert.equal(result.hits.filter(hit => hit.name === 'email').length,1);
});

test('WebSocket frames remain ordered and reuse placeholders; compressed response downloads remain exact', t => {
  const f = fixture(); t.after(() => f.close());
  const frames = [JSON.stringify({type:'response.create',model:'example-model',input:'alice@example.com'}),...['alice@','example.com'].map(delta => JSON.stringify({type:'response.output_text.delta',item_id:'item_safe',delta})),JSON.stringify({type:'response.completed',response:{id:'resp_safe'}})];
  const row = event('ws',{protocol:'WebSocket',method:'WS',status:101,frames:frames.map((body,index) => ({direction:index ? 'in':'out',at:index,body:Buffer.from(body).toString('base64'),binary:false}))});
  f.store.ingest(row);
  assert.equal(f.store.detail(row.id).frames.length,4);
  assert.equal(f.store.payload(row.id,'original','frame-1').text,frames[1]);
  assert(!f.store.payload(row.id,'masked','frame-2').text.includes('example.com'));
  const gzip = zlib.gzipSync(rawResponse), compressed = event('gzip',{encoding:'gzip',response:gzip.toString('base64')});
  f.store.ingest(compressed); assert.deepEqual(f.store.payload(compressed.id,'original','response').body,gzip);
  assert.equal(f.store.payload(compressed.id,'original','response').text,rawResponse);
});

test('named credential strings are masked and CSV neutralizes leading whitespace formulas', t => {
  const f = fixture(); t.after(() => f.close());
  const row = event('credentials',{model:'  =HYPERLINK("bad")',request:Buffer.from('{"password":"plain-credential","api_key":"plain-credential","keep":1.2300}').toString('base64')});
  f.store.ingest(row);
  const masked = f.store.payload(row.id,'masked','request').text;
  assert(!masked.includes('plain-credential')); assert(masked.includes('1.2300'));
  assert.equal(JSON.parse(masked).password,JSON.parse(masked).api_key);
  assert(f.store.exportIndex().csv.includes("'  =HYPERLINK"));
});

test('unsafe structural rules, malformed content and binary frames fail closed without plaintext fallback', t => {
  const f = fixture(); t.after(() => f.close());
  const p = f.store.configure({...f.store.policy(),custom:[{from:'call_demo',to:'broken'}]});
  for (const row of [event('protected',{policy_version:p.version}),event('invalid',{policy_version:p.version,response:Buffer.from('{broken').toString('base64')}),event('binary',{policy_version:p.version,protocol:'WebSocket',frames:[{direction:'in',at:0,binary:true,body:Buffer.from('secret').toString('base64')}]})]) {
    f.store.ingest(row); const saved = f.store.detail(row.id);
    assert.equal(saved.reason,'redaction_failed'); assert.equal(saved.original,false); assert.equal(saved.masked,false);
  }
  const original = f.store.configure({...p,mode:'original'}), row = event('binary-original',{policy_version:original.version,response:Buffer.from([0xff,0x00]).toString('base64')});
  f.store.ingest(row); assert.deepEqual(f.store.payload(row.id,'original','response').body,Buffer.from([0xff,0x00]));
});

test('excluding a user stores no body, metadata, index, session or gap, including queued older policies', t => {
  const f = fixture(); t.after(() => f.close()); const historic = event('historic'); f.store.ingest(historic);
  const before = f.store.status(), p = f.store.configure({...f.store.policy(),excludedUserIds:[2]});
  for (const row of [event('new',{policy_version:p.version,key_id:21}),event('inflight',{policy_version:2}),{user_id:2,request:'invalid'}]) assert.deepEqual(f.store.ingest(row),{accepted:false});
  assert.equal(f.store.status().records,before.records); assert.equal(f.store.status().gaps,before.gaps);
  assert.equal(f.store.exportIndex().count,1); assert.equal(f.store.sessions().items[0].attempts,1);
  assert.equal(f.store.payload(historic.id,'original','request').text,rawRequest);
  const next = f.store.configure({...p,excludedUserIds:[]}); assert.equal(f.store.ingest(event('resumed',{policy_version:next.version})).accepted,true);
});

test('policy compare-and-swap, idempotency, filter isolation, retention and capacity remain bounded', t => {
  let now = Date.now(), free = 100 * 1024 ** 3;
  const f = fixture({now:() => now,freeBytes:() => free}); t.after(() => f.close());
  const row = event(); f.store.ingest(row); assert.equal(f.store.ingest(row).duplicate,true);
  assert.throws(() => f.store.ingest({...row,response:Buffer.from('{}').toString('base64')}),{code:'CONVERSATION_ID_CONFLICT'});
  assert.throws(() => f.store.configure({...f.store.policy(),version:1}),{code:'CONVERSATION_POLICY_CONFLICT'});
  f.store.ingest(event('other-user',{user_id:3,key_id:30}));
  assert.equal(f.store.sessions().items.length,2);
  assert.equal(f.store.list({user_id:'2',key_id:'20'}).summary.total,1);
  assert.throws(() => f.store.list({user_id:'2 OR 1=1'})); assert.throws(() => f.store.list({start:'2026-01-03',end:'2026-01-01'}));
  const p = f.store.configure({...f.store.policy(),reserve:1}); free = 1000;
  assert.equal(f.store.ingest(event('capacity',{policy_version:p.version})).reason,'capacity');
  assert.equal(f.store.status().records,2); free = 100 * 1024 ** 3;
  now += 8 * 86400000; assert.equal(f.store.prune(),2); assert.equal(f.store.list().summary.total,0);
});

test('masked-only never persists originals and restart preserves the key and policy', t => {
  const f = fixture(); t.after(() => f.close()); const p = f.store.configure({...f.store.policy(),mode:'masked'});
  const row = event('masked',{policy_version:p.version}); f.store.ingest(row); assert.equal(f.store.detail(row.id).original,false);
  f.store.close(); f.store = new ConversationLogStore(f.directory).initialize();
  assert.equal(f.store.policy().mode,'masked'); assert(f.store.payload(row.id,'masked','request').text.includes('EMAIL_'));
  f.store.close(); fs.renameSync(path.join(f.store.directory,'archive.key'),path.join(f.store.directory,'saved.key'));
  assert.throws(() => new ConversationLogStore(f.directory).initialize(),/CONVERSATION_KEY_MISSING/);
});

test('collector requires its own token and admin APIs require admin session and CSRF; downloads are exact', async t => {
  const f = fixture(); t.after(() => f.close()); const auth = new AuthService(f.config); t.after(() => auth.close());
  const app = createApp({config:f.config,auth,database:{},conversations:f.store,messages:f.messages});
  const server = await new Promise(resolve => { const value = app.listen(0,'127.0.0.1',() => resolve(value)); });
  t.after(() => new Promise(resolve => server.close(resolve))); const base = 'http://127.0.0.1:' + server.address().port;
  let response = await fetch(base + '/api/conversation-logs/status'); assert.equal(response.status,401);
  response = await fetch(base + '/api/conversation-logs/ingest',{method:'POST',body:'{invalid',headers:{'content-type':'application/json'}}); assert.equal(response.status,401);
  const login = await fetch(base + '/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password:f.config.adminPassword})});
  const session = await login.json(), headers = {authorization:'Session ' + session.sessionToken};
  response = await fetch(base + '/api/conversation-logs/collector-policy',{headers}); assert.equal(response.status,401);
  response = await fetch(base + '/api/conversation-logs/collector-policy',{headers:{authorization:'Bearer ' + f.token,'x-conversation-dropped':'12'}}); assert.equal(response.status,200); assert.equal(response.headers.get('cache-control'),'no-store');
  const row = event('api');
  response = await fetch(base + '/api/conversation-logs/ingest',{method:'POST',headers:{authorization:'Bearer ' + f.token,'content-type':'application/json'},body:JSON.stringify(row)}); assert.equal(response.status,200); assert.equal((await response.json()).accepted,true);
  response = await fetch(base + '/api/conversation-logs/policy',{method:'PUT',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(f.store.policy())}); assert.equal(response.status,403);
  response = await fetch(base + `/api/conversation-logs/records/${row.id}/payload/request?source=original&download=1`,{headers}); assert.equal(response.status,200); assert.equal(Buffer.from(await response.arrayBuffer()).toString(),rawRequest);
  assert.equal(response.headers.get('cache-control'),'no-store'); assert(response.headers.get('content-disposition').includes('attachment'));
  response = await fetch(base + '/api/conversation-logs/status',{headers}); assert.equal((await response.json()).collectorDropped,12);
  response = await fetch(base + '/api/conversation-logs/policy',{method:'PUT',headers:{...headers,'content-type':'application/json','x-csrf-token':session.csrfToken},body:JSON.stringify({...f.store.policy(),excludedUserIds:[2]})}); assert.equal(response.status,200);
});
