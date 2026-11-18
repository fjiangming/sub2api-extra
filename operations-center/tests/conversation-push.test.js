'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const zlib = require('node:zlib');
const { fixture,event,rawRequest,rawResponse } = require('./conversation-logs-fixture');
const { ConversationLogStore } = require('../src/conversation-log-store');
const { ConversationPushStore } = require('../src/conversation-push-store');
const { ConversationPushService } = require('../src/services/conversation-push-service');
const { ConversationPushTransport,checkAddress } = require('../src/services/conversation-push-transport');
const { publicPolicy } = require('../src/services/conversation-push-policy');
const { AuthService } = require('../src/auth');
const { createApp } = require('../src/app');

function setup(t,options={}) {
  const f=fixture(options);t.after(()=>{f.store.close();f.close();});
  f.push=new ConversationPushStore(f.store,options).initialize();return f;
}
function configure(f,extra={}) {
  return f.push.configure({...f.push.policy(),enabled:true,webhook:{enabled:true,url:'https://receiver.example/logs',token:'test-private-token'},...extra});
}
function batch(f,filter={},destinations=['webhook']) {
  const preview=f.push.preview({filter,destinations});
  const body={filter,destinations,batchId:crypto.randomUUID(),previewToken:preview.previewToken};
  return {preview,body,result:f.push.enqueue(body)};
}
async function receiver(t,handler) {
  const server=http.createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  return 'http://127.0.0.1:'+server.address().port;
}
function localPolicy(url,extra={}) {
  return {...structuredClone(require('../src/services/conversation-push-policy').defaults),allowPrivateNetwork:true,timeoutSeconds:3,
    webhook:{enabled:true,url,token:'test-private-token'},...extra};
}

test('push defaults are off; configuration is encrypted, CAS protected, and secrets never returned',t=>{
  const f=setup(t);assert.equal(f.push.policy().enabled,false);
  const value=configure(f);assert(value.webhook.tokenConfigured);assert(!JSON.stringify(value).includes('test-private-token'));
  assert(!f.push.db.prepare('SELECT body FROM cl_push_policies ORDER BY version DESC LIMIT 1').get().body.includes(Buffer.from('test-private-token')));
  const old=f.push.policy();assert.throws(()=>f.push.configure({...old,version:1}),{code:'CONVERSATION_PUSH_CONFLICT'});
  const safe=publicPolicy(old);delete safe.webhook.tokenConfigured;delete safe.s3.credentialsConfigured;delete safe.s3.sessionTokenConfigured;
  f.push.configure(safe);assert.equal(f.push.policy().webhook.token,'test-private-token');
  f.push.configure({...f.push.policy(),webhook:{...f.push.policy().webhook,clearToken:true}});assert.equal(f.push.policy().webhook.token,'');
  configure(f,{s3:{...f.push.policy().s3,enabled:true,endpoint:'https://s3.example/',bucket:'test-bucket',accessKeyId:'test-id',secretAccessKey:'test-secret',sessionToken:'temporary-token'}});
  const s3=f.push.configure({...f.push.policy(),s3:{...f.push.policy().s3,clearSessionToken:true}}).s3;
  assert.equal(s3.sessionTokenConfigured,false);assert(s3.credentialsConfigured);assert(!JSON.stringify(s3).includes('test-id'));
  for(const url of ['http://public.example/','https://user:password@public.example/','https://public.example/?token=secret'])assert.throws(()=>configure(f,{webhook:{enabled:true,url}}));
  assert.throws(()=>configure(f,{s3:{...f.push.policy().s3,enabled:true,endpoint:'https://s3.example/bucket'}}));
});

test('capture scope and JSONL speed retain defaults and survive older clients omitting new fields',t=>{
  const f=setup(t);assert.equal(f.push.policy().captureScope,'complete');assert.equal(f.push.policy().s3.jsonl.uploadMiBPerSecond,2);
  const old=structuredClone(f.push.policy());delete old.captureScope;delete old.s3.jsonl.uploadMiBPerSecond;
  f.push.db.prepare('UPDATE cl_push_policies SET body=? WHERE version=1').run(f.store.seal(old,'push-policy:1'));
  assert.equal(f.push.policy().captureScope,'complete');assert.equal(f.push.policy().s3.jsonl.uploadMiBPerSecond,2);
  configure(f,{captureScope:'all',s3:{...f.push.policy().s3,jsonl:{...f.push.policy().s3.jsonl,uploadMiBPerSecond:0.5}}});
  const client=structuredClone(f.push.policy());delete client.captureScope;delete client.s3.jsonl.uploadMiBPerSecond;
  f.push.configure(client);assert.equal(f.push.policy().captureScope,'all');assert.equal(f.push.policy().s3.jsonl.uploadMiBPerSecond,0.5);
  for(const rate of [0,0.24,64.1,Infinity])assert.throws(()=>configure(f,{s3:{...f.push.policy().s3,jsonl:{...f.push.policy().s3.jsonl,uploadMiBPerSecond:rate}}}));
  assert.throws(()=>configure(f,{captureScope:'completed-model'}));
  for(const value of [null,undefined,[],0,'invalid'])assert.throws(()=>f.push.configure(value),{code:'CONVERSATION_PUSH_INVALID'});
});

test('explicitly including unconfirmed transport preserves raw errors, diagnostics and exact body bytes',t=>{
  const f=setup(t);f.store.configure({...f.store.policy(),mode:'dual'});configure(f,{automatic:true,source:'original'});
  const row=event('scope-diagnostics',{capture_version:2,protocol:'SSE',complete:false,reason:'read_error',
    response:Buffer.from('data: {"type":"response.completed","response":{"id":"resp_scope","object":"response","status":"completed","output":[]}}\n\n').toString('base64')});
  row.body_sha256=require('../src/conversation-log-store').bodyDigest({request:Buffer.from(row.request,'base64'),response:Buffer.from(row.response,'base64'),frames:[]});
  row.transport_diagnostics={version:1,request:{bytes:Buffer.from(row.request,'base64').length,expected_bytes:-1,eof:true,error:'',error_during_close:false},
    response:{bytes:Buffer.from(row.response,'base64').length,expected_bytes:-1,eof:false,error:'cancelled',error_during_close:true}};
  f.store.ingest(row);const input={filter:{},destinations:['webhook']};
  assert.equal(f.push.preview(input).eligible,0);assert.deepEqual(f.push.preview(input).unavailableReasons,{INCOMPLETE_CAPTURE:1});
  configure(f,{captureScope:'all',source:'original'});const original=batch(f).result;assert.equal(original.created,1);
  const job=f.push.claim(),body=f.push.envelope(job);assert.equal(body.request,row.request);assert.equal(body.response,row.response);
  assert.equal(body.metadata.complete,false);assert.equal(body.metadata.reason,'read_error');assert.equal(body.metadata.upstream_status,'completed');
  assert.deepEqual(body.metadata.transport_diagnostics,row.transport_diagnostics);
  configure(f,{captureScope:'all',source:'masked'});assert.equal(batch(f).result.created,1);
  const masked=f.push.claim();assert.equal(masked.source,'masked');assert(!Buffer.from(f.push.envelope(masked).request,'base64').toString().includes('alice@example.com'));
  configure(f,{captureScope:'complete',source:'masked'});assert.equal(f.push.validJob(masked).cancel,'INCOMPLETE_CAPTURE');
});

test('preview and automatic skips distinguish privacy gates; all scope never falls back to raw',t=>{
  const f=setup(t);configure(f,{automatic:true,captureScope:'all'});
  const failed=event('skip-failed',{response:Buffer.from('{invalid').toString('base64')}),warning=event('skip-warning'),outdated=event('skip-outdated'),missing=event('skip-missing'),excluded=event('skip-excluded',{user_id:3});
  for(const row of [failed,warning,outdated,missing,excluded])f.store.ingest(row);
  f.store.db.prepare('UPDATE cl_records SET inspection_warnings=? WHERE id=?').run('["OPAQUE_IMAGE"]',warning.id);
  f.store.db.prepare('UPDATE cl_records SET redaction_version=0 WHERE id=?').run(outdated.id);
  f.store.db.prepare('UPDATE cl_records SET masked=NULL WHERE id=?').run(missing.id);
  f.store.configure({...f.store.policy(),excludedUserIds:[3]});
  const preview=f.push.preview({filter:{},destinations:['webhook']});
  assert.equal(preview.eligible,0);assert.equal(preview.excluded,1);
  assert.deepEqual(preview.unavailableReasons,{PROCESSING_FAILED:1,INSPECTION_INCOMPLETE:1,REDACTION_OUTDATED:1,COPY_UNAVAILABLE:1});
  f.push.scanAutomatic();f.push.scanAutomatic();assert.equal(f.push.list().total,0);
  const skipped=Object.fromEntries(f.push.list().skipped.map(row=>[row.code,row.count]));
  assert.deepEqual(skipped,{COLLECTION_EXCLUDED:1,COPY_UNAVAILABLE:1,INSPECTION_INCOMPLETE:1,PROCESSING_FAILED:1,REDACTION_OUTDATED:1});
  const pending=event('skip-pending');f.store.receive(pending);assert(f.push.scanAutomatic().processing);
  assert.equal(f.push.preview({filter:{search:pending.id},destinations:['webhook']}).unavailableReasons.PROCESSING_PENDING,1);
  assert.equal(f.push.list().total,0);
});

test('manual batches bind preview to content and policy, deduplicate, and require matching UUID parameters',t=>{
  const f=setup(t);configure(f);f.store.ingest(event('manual'));
  const value=batch(f);assert.equal(value.preview.jobs,1);assert.equal(value.result.created,1);
  assert.deepEqual(f.push.enqueue(value.body),value.result);
  assert.throws(()=>f.push.enqueue({...value.body,filter:{search:'changed'}}),{code:'CONVERSATION_PUSH_CONFLICT'});
  assert.equal(batch(f).result.created,0);
  const before=f.push.preview({filter:{},destinations:['webhook']});
  f.store.configure({...f.store.policy(),excludedUserIds:[2]});
  assert.throws(()=>f.push.enqueue({filter:{},destinations:['webhook'],batchId:crypto.randomUUID(),previewToken:before.previewToken}),{code:'CONVERSATION_PUSH_PREVIEW_CHANGED'});
  assert.equal(f.push.claim(),null);assert.equal(f.push.list().items[0].error_code,'COLLECTION_EXCLUDED');
});

test('auto queue starts with new logs, resumes across DB restart, and survives rowid reuse after retention',t=>{
  let now=Date.now();const f=setup(t,{now:()=>now});
  f.store.ingest(event('history'));configure(f,{automatic:true});assert.equal(f.push.scanAutomatic().created,0);
  const row=event('new');f.store.ingest(row);assert.equal(f.push.scanAutomatic().created,1);assert.equal(f.push.scanAutomatic().created,0);
  f.store.close();f.store=new ConversationLogStore(f.directory,{now:()=>now}).initialize();
  f.push=new ConversationPushStore(f.store,{now:()=>now}).initialize();
  f.store.ingest(event('restart'));assert.equal(f.push.scanAutomatic().created,1);
  f.store.db.prepare('DELETE FROM cl_records').run();assert.equal(f.push.list().total,0);
  f.store.ingest(event('reused-rowid'));assert.equal(f.push.scanAutomatic().created,1);
  configure(f,{automatic:false});f.store.ingest(event('while-paused'));configure(f,{automatic:true});assert.equal(f.push.scanAutomatic().created,0);
});

test('model and user rules apply to historical and queued jobs, unavailable masked copy never falls back',t=>{
  const f=setup(t);configure(f);
  f.store.ingest(event('permitted',{model:'gpt-6-astra'}));f.store.ingest(event('unselected'));
  f.store.ingest(event('excluded',{user_id:3}));f.store.ingest(event('processing-failed',{model:'gpt-6-astra',response:Buffer.from('{bad').toString('base64')}));
  f.store.configure({...f.store.policy(),modelFilterEnabled:true,allowedModels:['gpt-6-astra'],kimiK3Plus:true,excludedUserIds:[3]});
  const value=batch(f);assert.equal(value.preview.matched,4);assert.equal(value.preview.excluded,2);assert.equal(value.preview.unavailable,1);assert.equal(value.result.created,1);
  f.store.configure({...f.store.policy(),allowedModels:[]});assert.equal(f.push.claim(),null);assert.equal(f.push.list().items[0].error_code,'COLLECTION_EXCLUDED');
});

test('payload envelope retains exact original bytes, compression, numeric spelling, WS frames and checksums',t=>{
  const f=setup(t);configure(f,{source:'original'});
  const compressed=zlib.gzipSync(Buffer.from(rawResponse)),row=event('gzip',{response:compressed.toString('base64'),encoding:'gzip'});f.store.ingest(row);batch(f);
  let job=f.push.claim(),payload=f.push.envelope(job);
  assert.equal(Buffer.from(payload.request,'base64').toString(),rawRequest);assert.deepEqual(Buffer.from(payload.response,'base64'),compressed);
  assert.equal(payload.metadata.encoding,'gzip');assert.equal(payload.checksums.response.sha256,crypto.createHash('sha256').update(compressed).digest('hex'));
  f.push.finish(job,{status:'sent'});
  const frames=[{direction:'out',at:0,binary:true,body:Buffer.from([0,255,13,10]).toString('base64')}];
  f.store.ingest(event('ws',{protocol:'WebSocket',frames}));batch(f,{protocol:'WebSocket'});job=f.push.claim();payload=f.push.envelope(job);assert.deepEqual(payload.frames,frames);
  f.push.finish(job,{status:'sent'});configure(f,{source:'masked'});batch(f,{search:row.id});job=f.push.claim();payload=f.push.envelope(job);
  assert.equal(payload.metadata.encoding,'');assert(!Buffer.from(payload.request,'base64').toString().includes('alice@example.com'));assert(Buffer.from(payload.request,'base64').toString().includes('9007199254740993'));
});

test('leases, bounded retries, explicit retry, content changes and late receipts preserve queue state',t=>{
  let now=Date.now();const f=setup(t,{now:()=>now});configure(f,{maxAttempts:2,retrySeconds:5});f.store.ingest(event('retry'));const b=batch(f);
  const first=f.push.claim();assert.equal(first.attempts,1);assert.equal(f.push.claim(),null);
  f.push.finish(first,{status:'failed',errorCode:'TIMEOUT',retryable:true});assert.equal(f.push.claim(),null);now+=5000;
  const second=f.push.claim();assert.equal(second.id,first.id);assert.equal(second.attempts,2);
  assert.equal(f.push.finish(first,{status:'sent'}),0);
  now+=30000;assert.equal(f.push.claim(),null);assert.equal(f.push.list().items[0].status,'failed');
  f.push.retry(first.id);const third=f.push.claim();assert.equal(third.attempts,1);
  assert.equal(f.push.cancelBatch(b.result.id).cancelled,1);assert.equal(f.push.finish(third,{status:'sent'}),0);
  f.push.retry(first.id);configure(f,{webhook:{enabled:true,url:'https://other.example/',token:''}});assert.equal(f.push.claim(),null);assert.equal(f.push.list().items[0].error_code,'TARGET_CHANGED');
});

test('queue bound stops auto cursor without losing unscheduled records; paused target cannot starve active target',t=>{
  const f=setup(t);configure(f,{automatic:true,queueLimit:100});
  for(let n=0;n<102;n++)f.store.ingest(event('capacity-'+n));
  f.push.scanAutomatic();f.push.scanAutomatic();assert(f.push.scanAutomatic().full);assert.equal(f.push.list().total,100);
  const job=f.push.claim();f.push.finish(job,{status:'sent'});assert.equal(f.push.scanAutomatic().created,1);
  assert.throws(()=>batch(f),{code:'CONVERSATION_PUSH_QUEUE_FULL'});
  configure(f,{automatic:false,queueLimit:200,webhook:{...f.push.policy().webhook,enabled:false},s3:{...f.push.policy().s3,enabled:true,endpoint:'https://s3.example/',bucket:'test-bucket',accessKeyId:'test-id',secretAccessKey:'test-secret'}});
  batch(f,{request_id:event('capacity-101').request_id},['s3']);assert.equal(f.push.claim().destination,'s3');
});

test('modified masked content invalidates queued copy; retention cascades jobs and references',t=>{
  const f=setup(t);configure(f);const row=event('change');f.store.ingest(row);batch(f);
  const raw=f.store.open(f.store.db.prepare('SELECT masked FROM cl_records WHERE id=?').get(row.id).masked,row.id+':masked');
  f.store.db.prepare('UPDATE cl_records SET masked=?,processed_at=processed_at+1 WHERE id=?').run(f.store.seal(raw,row.id+':masked'),row.id);
  assert.equal(f.push.claim(),null);assert.equal(f.push.list().items[0].error_code,'CONTENT_CHANGED');
  f.store.db.prepare('DELETE FROM cl_records WHERE id=?').run(row.id);assert.equal(f.push.list().total,0);assert.equal(f.push.db.prepare('SELECT count(*) n FROM cl_push_arrivals').get().n,0);
});

test('endpoint guard rejects nonpublic, mapped private and metadata addresses; pins DNS without rebinding',async t=>{
  for(const address of ['127.0.0.1','10.0.0.1','::ffff:192.168.1.2','169.254.169.254','::','ff02::1'])assert.throws(()=>checkAddress(address,false));
  for(const address of ['169.254.169.254','100.100.100.200','168.63.129.16','fd00:ec2::254','fd20:ce::254','fe80::1','0.0.0.0','224.0.0.1'])assert.throws(()=>checkAddress(address,true));
  for(const address of ['8.8.8.8','2606:4700:4700::1111'])checkAddress(address,false);
  let received=0;const url=await receiver(t,(_req,res)=>{received++;res.writeHead(204);res.end();});
  let calls=0;const transport=new ConversationPushTransport({lookup:async()=>{calls++;return [{address:calls===1?'127.0.0.1':'169.254.169.254',family:4}];}});
  const policy=localPolicy(url.replace('127.0.0.1','pinned.example'));
  assert.equal((await transport.send(policy,'webhook',{delivery_id:'one'})).status,'sent');assert.equal(calls,1);assert.equal(received,1);
  assert.equal((await transport.send(policy,'webhook',{delivery_id:'two'})).errorCode,'ADDRESS_BLOCKED');assert.equal(received,1);
  const unsafe=new ConversationPushTransport({lookup:async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]});
  policy.allowPrivateNetwork=false;policy.webhook.url='https://mixed.example';assert.equal((await unsafe.send(policy,'webhook',{})).errorCode,'ADDRESS_BLOCKED');
});

test('webhook stable idempotency and bearer, sanitized failures, redirect refusal, timeout and abort',async t=>{
  const requests=[];let mode=503;
  const url=await receiver(t,(req,res)=>{let body='';req.on('data',chunk=>{body+=chunk;});req.on('end',()=>{requests.push({headers:req.headers,body});if(mode===0)return;res.writeHead(mode,{location:'/should-not-follow'});res.end('private remote error');});});
  const transport=new ConversationPushTransport(),policy=localPolicy(url),envelope={delivery_id:'stable',request:'YQ=='};
  const first=await transport.send(policy,'webhook',envelope);assert.equal(first.httpStatus,503);assert(first.retryable);assert(!JSON.stringify(first).includes('private remote error'));
  mode=204;assert.equal((await transport.send(policy,'webhook',envelope)).status,'sent');assert.equal(requests[0].headers['idempotency-key'],requests[1].headers['idempotency-key']);assert.equal(requests[0].headers.authorization,'Bearer test-private-token');
  mode=302;assert.equal((await transport.send(policy,'webhook',envelope)).errorCode,'REDIRECT_REJECTED');assert.equal(requests.length,3);
  mode=401;assert.equal((await transport.send(policy,'webhook',envelope)).retryable,false);
  mode=0;assert.equal((await transport.send(policy,'webhook',envelope)).errorCode,'TIMEOUT');
  const controller=new AbortController(),pending=transport.send(policy,'webhook',envelope,controller.signal);controller.abort();assert.equal((await pending).errorCode,'ABORTED');
});

test('S3 uses SDK signing, one stable object per delivery, bounded error response and no redirects',async t=>{
  const requests=[];let mode=200;
  const url=await receiver(t,(req,res)=>{let body='';req.on('data',chunk=>{body+=chunk;});req.on('end',()=>{requests.push({url:req.url,headers:req.headers,body});res.writeHead(mode,{'content-type':'application/xml',location:'/other'});res.end(mode===200?'':'<Error><Code>AccessDenied</Code><pushCode>remote-private-token</pushCode><httpStatus>200</httpStatus><retryable>true</retryable><Message>'+('x'.repeat(mode===500?70000:10))+'</Message></Error>');});});
  const transport=new ConversationPushTransport(),policy=localPolicy(url,{s3:{enabled:true,endpoint:url,region:'us-east-1',bucket:'test-bucket',prefix:'archive',forcePathStyle:true,accessKeyId:'test-key',secretAccessKey:'test-secret',sessionToken:''}});
  const envelope={delivery_id:'stable-s3',metadata:{at:1700000000000},request:'YQ=='};
  assert.equal((await transport.send(policy,'s3',envelope)).status,'sent');assert.equal((await transport.send(policy,'s3',envelope)).status,'sent');
  assert.equal(requests[0].url,requests[1].url);assert(requests[0].url.startsWith('/test-bucket/archive/2023-11-14/stable-s3.json'));
  assert(requests[0].headers.authorization.startsWith('AWS4-HMAC-SHA256 '));assert.equal(requests[0].body,JSON.stringify(envelope));
  mode=301;const redirect=await transport.send(policy,'s3',envelope);assert.equal(redirect.errorCode,'REDIRECT_REJECTED');assert.equal(requests.length,3);
  mode=403;const denied=await transport.send(policy,'s3',envelope);assert.equal(denied.errorCode,'HTTP_REJECTED');assert.equal(denied.httpStatus,403);assert.equal(denied.retryable,false);assert(!JSON.stringify(denied).includes('remote-private-token'));
  mode=500;const large=await transport.send(policy,'s3',envelope);assert.equal(large.status,'failed');assert(!JSON.stringify(large).includes('xxxxx'));
});

test('S3 virtual-host addressing validates and pins the actual bucket hostname',async t=>{
  const seen=[],hosts=[];
  const url=await receiver(t,(req,res)=>{req.resume();req.on('end',()=>{seen.push(req.headers.host);res.end();});});
  const transport=new ConversationPushTransport({lookup:async host=>{hosts.push(host);return [{address:'127.0.0.1',family:4}];}});
  const policy=localPolicy(url,{s3:{enabled:true,endpoint:url.replace('127.0.0.1','storage.example'),region:'us-east-1',bucket:'test-bucket',prefix:'archive',forcePathStyle:false,accessKeyId:'test-key',secretAccessKey:'test-secret',sessionToken:''}});
  const result=await transport.send(policy,'s3',{delivery_id:'virtual'});assert.equal(result.status,'sent');assert.deepEqual(hosts,['test-bucket.storage.example']);assert(seen[0].startsWith('test-bucket.storage.example:'));
});

test('worker rechecks exclusion after asynchronous DNS and cancellation aborts in-flight work',async t=>{
  const f=setup(t);let received=0;const url=await receiver(t,(_req,res)=>{received++;res.end();});
  configure(f,{allowPrivateNetwork:true,webhook:{enabled:true,url:url.replace('127.0.0.1','deferred.example')}});f.store.ingest(event('guard'));batch(f);
  let release;const pending=new Promise(resolve=>{release=resolve;});
  const worker=new ConversationPushService(f.push,{transport:new ConversationPushTransport({lookup:()=>pending})});
  const sending=worker.tick();f.store.configure({...f.store.policy(),excludedUserIds:[2]});release([{address:'127.0.0.1',family:4}]);await sending;assert.equal(received,0);
  f.store.configure({...f.store.policy(),excludedUserIds:[]});
  let started,aborted=false;const ready=new Promise(resolve=>{started=resolve;});
  worker.transport={send:(_policy,_destination,_body,signal)=>new Promise(resolve=>{started();signal.addEventListener('abort',()=>{aborted=true;resolve({status:'failed',errorCode:'ABORTED',retryable:true});},{once:true});})};
  f.push.db.prepare("UPDATE cl_push_jobs SET status='pending',next_at=0").run();
  const work=worker.tick();await ready;worker.cancelBatch(f.push.list().batches[0].id);await work;assert(aborted);assert.equal(f.push.list().items[0].status,'cancelled');await worker.stop();
});

test('push admin endpoints enforce authentication, CSRF and collector separation, and test uses synthetic data',async t=>{
  const f=setup(t),sent=[];
  const worker=new ConversationPushService(f.push,{transport:{send:async(_policy,_destination,envelope)=>{sent.push(envelope);return {status:'sent',httpStatus:204};}}});
  t.after(()=>worker.stop());configure(f);f.store.ingest(event('api'));
  const auth=new AuthService(f.config);t.after(()=>auth.close());
  const app=createApp({config:f.config,auth,database:{},conversations:f.store,conversationPush:worker,messages:f.messages,settings:{getStatus:()=>({setupRequired:false})}});
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port+'/api/';
  const request=(path,method='GET',headers={},body)=>fetch(base+path,{method,headers:{'content-type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});
  assert.equal((await request('conversation-logs/push/policy')).status,401);
  assert.equal((await request('conversation-logs/push/policy','GET',{authorization:'Bearer '+f.token})).status,401);
  const login=await request('auth/login','POST',{}, {username:'admin',password:f.config.adminPassword}),session=await login.json();
  const headers={authorization:'Session '+session.sessionToken},writes={...headers,'x-csrf-token':session.csrfToken};
  const response=await request('conversation-logs/push/policy','GET',headers);assert.equal(response.headers.get('cache-control'),'no-store');assert(!JSON.stringify(await response.json()).includes('test-private-token'));
  assert.equal((await request('conversation-logs/push/policy','PUT',headers,f.push.policy())).status,403);
  assert.equal((await request('conversation-logs/push/jsonl/flush','POST',headers,{})).status,403);
  assert.equal((await request('conversation-logs/push/jsonl/flush','POST',writes,{})).status,409);
  assert.equal((await request('conversation-logs/push/jsonl/missing/retry','POST',headers,{})).status,403);
  assert.equal((await request('conversation-logs/push/jsonl/missing/retry','POST',writes,{})).status,409);
  assert.equal((await request('conversation-logs/push/test/webhook','POST',writes,{})).status,200);assert.equal(sent[0].schema,'sub2api.conversation.test.v1');assert(!JSON.stringify(sent[0]).includes('alice'));
  const preview=await(await request('conversation-logs/push/preview','POST',writes,{filter:{},destinations:['webhook']})).json();
  const body={filter:{},destinations:['webhook'],batchId:crypto.randomUUID(),previewToken:preview.previewToken};
  assert.equal((await request('conversation-logs/push/batches','POST',headers,body)).status,403);
  assert.equal((await request('conversation-logs/push/batches','POST',writes,body)).status,202);
  await worker.running;assert.equal(sent[1].schema,'sub2api.conversation.v1');assert.equal(f.push.list().items[0].status,'sent');
});
