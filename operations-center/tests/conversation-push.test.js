'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const zlib = require('node:zlib');
const { fixture,event,rawRequest,rawResponse,exportBodyBytes } = require('./conversation-logs-fixture');
const { ConversationLogStore } = require('../src/conversation-log-store');
const { ConversationPushStore } = require('../src/conversation-push-store');
const { ConversationPushService } = require('../src/services/conversation-push-service');
const { ConversationPushTransport,checkAddress } = require('../src/services/conversation-push-transport');
const { publicPolicy } = require('../src/services/conversation-push-policy');
const { deliveryBody } = require('../src/services/conversation-envelope');
const { AuthService } = require('../src/auth');
const { createApp } = require('../src/app');

function setup(t,options={}) {
  const f=fixture(options);t.after(()=>{f.store.close();f.close();});
  f.push=new ConversationPushStore(f.store,options).initialize();return f;
}
function concurrentSetup(t) {
  const f=fixture();
  f.push=new ConversationPushStore(f.store).initialize();
  f.other=new ConversationLogStore(f.directory).openReader();
  t.after(()=>{f.other.close();f.close();});
  return f;
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

test('policy saves serialize a competing archive writer before reading the WAL snapshot',t=>{
  const f=concurrentSetup(t),other=f.other;
  const before=f.push.policy(),read=f.push.policy.bind(f.push);
  let conflict;
  f.push.policy=(...args)=>{
    const policy=read(...args);
    try { other.db.prepare('UPDATE cl_push_cursor SET row_id=row_id+1 WHERE singleton=1').run(); }
    catch(error) { conflict=error; }
    return policy;
  };
  const saved=f.push.configure({...before,enabled:true,webhook:{...before.webhook,enabled:true,url:'https://receiver.example/logs'}});
  f.push.policy=read;
  assert.equal(saved.version,before.version+1);
  assert.equal(f.push.policy().version,saved.version);
  assert.match(conflict?.code||'',/^SQLITE_BUSY/);
  assert.equal(other.db.prepare('UPDATE cl_push_cursor SET row_id=row_id+1 WHERE singleton=1').run().changes,1);
});

test('policy lock retries preserve newer administrator edits and only notify the worker after commit',async t=>{
  const f=concurrentSetup(t),service=new ConversationPushService(f.push),before=f.push.policy();
  const other=new ConversationPushStore(f.other);
  let notifications=0;
  service.invalidate=()=>notifications++;service.wake=()=>notifications++;
  f.other.db.exec('BEGIN IMMEDIATE');
  const saving=service.configure({...before,timeoutSeconds:60});
  assert.equal(notifications,0);
  assert.equal(f.push.db.pragma('busy_timeout',{simple:true}),5000);
  other.configure({...before,timeoutSeconds:45});
  f.other.db.exec('COMMIT');
  await assert.rejects(saving,{code:'CONVERSATION_PUSH_CONFLICT',status:409});
  assert.equal(f.push.policy().timeoutSeconds,45);
  assert.equal(f.push.policy().version,before.version+1);
  assert.equal(notifications,0);
  await service.configure({...f.push.policy(),timeoutSeconds:60});
  assert.equal(f.push.policy().timeoutSeconds,60);
  assert.equal(notifications,2);
  assert.equal(f.push.db.pragma('busy_timeout',{simple:true}),5000);
});

test('persistent policy write contention returns an explicit busy error without changing configuration',async t=>{
  const f=concurrentSetup(t),service=new ConversationPushService(f.push),before=f.push.policy();
  let notifications=0,heartbeat=0;
  service.invalidate=()=>notifications++;service.wake=()=>notifications++;
  f.other.db.exec('BEGIN IMMEDIATE');
  const timer=setInterval(()=>heartbeat++,10),began=performance.now();
  try {
    await assert.rejects(service.configure({...before,timeoutSeconds:60}),{code:'CONVERSATION_PUSH_POLICY_BUSY',status:503});
  } finally { clearInterval(timer);f.other.db.exec('ROLLBACK'); }
  assert(performance.now()-began<4000);
  assert(heartbeat>=10,'lock waits must yield to other requests and timers');
  assert.deepEqual(f.push.policy(),before);
  assert.equal(notifications,0);
  assert.equal(f.push.db.pragma('busy_timeout',{simple:true}),5000);
});

test('memory deferrals preserve the single-delivery retry allowance and recover automatically',async t=>{
  let now=Date.now(),budget=0,calls=0;
  const f=setup(t,{now:()=>now});configure(f,{source:'original',maxAttempts:1,retrySeconds:5});
  const row=event('single-memory-recovery');f.store.ingest(row);batch(f);
  const before=f.store.db.prepare('SELECT original FROM cl_records WHERE id=?').get(row.id).original;
  const service=new ConversationPushService(f.push,{memoryBudget:()=>budget,transport:{send:async()=>{calls++;return {status:'sent'};}}});
  t.after(()=>service.stop());
  for(let n=0;n<4;n++) {
    await service.tick();const job=f.push.list().items[0];
    assert.equal(job.status,'pending');assert.equal(job.attempts,0);assert.equal(job.error_code,'EXPORT_MEMORY');
    assert.equal(calls,0);now+=5001;
  }
  budget=Infinity;await service.tick();assert.equal(f.push.list().items[0].status,'sent');assert.equal(calls,1);
  assert.equal(f.push.list().items[0].attempts,1);
  assert.deepEqual(f.store.db.prepare('SELECT original FROM cl_records WHERE id=?').get(row.id).original,before);
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
  const job=f.push.claim(),body=f.push.envelope(job);assert.deepEqual(exportBodyBytes(body,'request'),Buffer.from(row.request,'base64'));assert.deepEqual(exportBodyBytes(body,'response'),Buffer.from(row.response,'base64'));
  assert.equal(body.metadata.complete,false);assert.equal(body.metadata.reason,'read_error');assert.equal(body.metadata.upstream_status,'completed');
  assert.deepEqual(body.metadata.transport_diagnostics,row.transport_diagnostics);
  configure(f,{captureScope:'all',source:'masked'});assert.equal(batch(f).result.created,1);
  const masked=f.push.claim();assert.equal(masked.source,'masked');assert(!f.push.envelope(masked).request.includes('alice@example.com'));
  configure(f,{captureScope:'complete',source:'masked'});assert.equal(f.push.validJob(masked).cancel,'INCOMPLETE_CAPTURE');
});

test('preview and automatic queues use marked original fallbacks and preserve exclusion gates',t=>{
  const f=setup(t);configure(f,{automatic:true,captureScope:'all'});
  const failed=event('skip-failed',{response:Buffer.from('{invalid').toString('base64')}),warning=event('skip-warning'),outdated=event('skip-outdated'),missing=event('skip-missing'),excluded=event('skip-excluded',{user_id:3});
  for(const row of [failed,warning,outdated,missing,excluded])f.store.ingest(row);
  f.store.db.prepare('UPDATE cl_records SET inspection_warnings=? WHERE id=?').run('["OPAQUE_IMAGE"]',warning.id);
  f.store.db.prepare('UPDATE cl_records SET redaction_version=0 WHERE id=?').run(outdated.id);
  f.store.db.prepare('UPDATE cl_records SET masked=NULL WHERE id=?').run(missing.id);
  f.store.configure({...f.store.policy(),excludedUserIds:[3]});
  const preview=f.push.preview({filter:{},destinations:['webhook']});
  assert.equal(preview.eligible,4);assert.equal(preview.excluded,1);assert.equal(preview.fallbacks,4);
  assert.deepEqual(preview.unavailableReasons,{});
  assert.deepEqual(preview.fallbackReasons,{PROCESSING_FAILED:1,INSPECTION_INCOMPLETE:1,REDACTION_OUTDATED:1,COPY_UNAVAILABLE:1});
  f.push.scanAutomatic();f.push.scanAutomatic();assert.equal(f.push.list().total,4);
  const skipped=Object.fromEntries(f.push.list().skipped.map(row=>[row.code,row.count]));
  assert.deepEqual(skipped,{COLLECTION_EXCLUDED:1});
  const fallbacks=Object.fromEntries(f.push.list().fallbacks.map(row=>[row.code,row.count]));assert.deepEqual(fallbacks,preview.fallbackReasons);
  const pending=event('skip-pending');f.store.receive(pending);assert(f.push.scanAutomatic().processing);
  assert.equal(f.push.preview({filter:{search:pending.id},destinations:['webhook']}).fallbackReasons.PROCESSING_PENDING,1);
  assert.equal(f.push.list().total,4);
  for(let job;(job=f.push.claim());){const body=f.push.envelope(job);assert.equal(body.source,'original');assert.equal(body.requested_source,'masked');assert(body.fallback_reason);f.push.finish(job,{status:'sent'});}
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

test('preview, enqueue, automatic scan and job history use compact metadata with unchanged content versions',t=>{
  const f=setup(t);configure(f,{automatic:true,captureScope:'all'});
  const row=event('push-compact');f.store.ingest(row);
  const source=f.store.db.prepare('SELECT * FROM cl_records WHERE id=?').get(row.id);
  const expectedId=f.push.jobId(source,f.push.policy(),'webhook');
  const prepare=f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare=sql=>{
    if (/FROM cl_records/i.test(sql)) assert(/^SELECT \(SELECT COUNT\(\*\) FROM cl_records\)/.test(sql),'interactive push paths must not access archive body rows');
    return prepare(sql);
  };
  const selected=batch(f);assert.equal(selected.preview.matched,1);assert.equal(selected.result.created,1);
  assert.equal(f.push.list().items[0].id,expectedId);
  assert.equal(f.push.scanAutomatic().created,0);assert.equal(batch(f).preview.duplicates,1);
  assert.equal(f.push.validJob(f.push.claim()).row.fingerprint,source.fingerprint);
  for (const filter of [{capture:'partial'},{capture:'missing'},{capture:'redaction_failed'},{user_id:'3'}]) {
    assert.equal(f.push.preview({filter,destinations:['webhook']}).matched,0);
  }
  assert.equal(f.push.preview({filter:{capture:'complete'},destinations:['webhook']}).matched,1);
  assert.deepEqual(f.push.list().metadataIndex,{ready:true,indexed:1,total:1});
});

test('over-limit historical previews reject using compact metadata before touching body rows or creating tasks',t=>{
  const f=setup(t);configure(f);f.store.ingest(event('push-limit-seed'));
  const fields=f.store.db.pragma('table_info(cl_records)').map(row=>row.name);
  f.store.db.prepare(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<10000)
    INSERT INTO cl_records(${fields}) SELECT ${fields.map(field=>field==='id'?"printf('%032x',n)":'r.'+field)}
    FROM numbers CROSS JOIN cl_records r WHERE r.id=?`).run(event('push-limit-seed').id);
  f.store.db.exec("UPDATE cl_record_metadata SET fingerprint=''");
  const prepare=f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare=sql=>{
    if (/FROM cl_records/i.test(sql)) assert(/^SELECT \(SELECT COUNT\(\*\) FROM cl_records\)/.test(sql),'over-limit check must not scan legacy body rows');
    return prepare(sql);
  };
  const input={filter:{},destinations:['webhook']};
  assert.throws(()=>f.push.preview(input),/10,000/);
  assert.throws(()=>f.push.enqueue({...input,batchId:crypto.randomUUID(),previewToken:'0'.repeat(64)}),/10,000/);
  assert.equal(f.push.list().total,0);assert.equal(f.push.list().batches.length,0);
});

test('unprepared history returns an explicit retryable preview error without dropping jobs or advancing automatic arrivals',t=>{
  const f=setup(t);configure(f,{automatic:true});
  const first=event('push-preparing-first'),second=event('push-preparing-second');
  f.store.ingest(first);const saved=batch(f,{request_id:first.request_id}),job=f.push.db.prepare('SELECT * FROM cl_push_jobs LIMIT 1').get();
  f.store.ingest(second);f.store.db.prepare("UPDATE cl_record_metadata SET fingerprint='' WHERE id=?").run(first.id);
  const cursor=f.push.db.prepare('SELECT row_id FROM cl_push_cursor').get().row_id;
  const input={filter:{},destinations:['webhook']};
  assert.throws(()=>f.push.preview(input),{code:'CONVERSATION_PUSH_HISTORY_PREPARING',status:409});
  assert(f.push.scanAutomatic().preparing);assert.equal(f.push.db.prepare('SELECT row_id FROM cl_push_cursor').get().row_id,cursor);
  assert(f.push.validJob(job).paused);assert.equal(f.push.claim(),null);assert.equal(f.push.list().items[0].status,'pending');
  assert.deepEqual(f.push.list().metadataIndex,{ready:false,indexed:1,total:2});
  assert.equal(f.push.preview({filter:{request_id:second.request_id},destinations:['webhook']}).jobs,1,'prepared subsets remain available');
  f.store.backfillMetadata();assert.equal(f.push.scanAutomatic().created,1);
  assert.equal(f.push.preview({filter:{request_id:first.request_id},destinations:['webhook']}).previewToken,saved.preview.previewToken);
  assert.equal(f.push.list().total,2);assert.equal(f.push.list().items.find(row=>row.record_id===first.id).id,job.id);
  f.store.db.prepare('DELETE FROM cl_record_metadata WHERE id=?').run(first.id);
  assert.throws(()=>f.push.preview(input),{code:'CONVERSATION_PUSH_HISTORY_PREPARING'});
  assert(f.push.validJob(job).paused);assert.equal(f.push.list().total,2,'warming must not hide existing task history');
  f.store.db.prepare('DELETE FROM cl_records WHERE id=?').run(first.id);assert.equal(f.push.validJob(job).cancel,'RECORD_EXPIRED');
});

test('automatic arrivals stop at a missing compact row and resume without skipping a later prepared record',t=>{
  const f=setup(t);configure(f,{automatic:true});
  const first=event('push-missing-first'),second=event('push-missing-second');
  f.store.ingest(first);f.store.ingest(second);f.store.db.prepare('DELETE FROM cl_record_metadata WHERE id=?').run(first.id);
  const cursor=f.push.db.prepare('SELECT row_id FROM cl_push_cursor').get().row_id;
  assert(f.push.scanAutomatic().preparing);assert.equal(f.push.list().total,0);
  assert.equal(f.push.db.prepare('SELECT row_id FROM cl_push_cursor').get().row_id,cursor);
  f.store.backfillMetadata();assert.equal(f.push.scanAutomatic().created,2);
  assert.equal(f.push.scanAutomatic().created,0);
  assert.deepEqual(f.push.list().items.map(row=>row.record_id).sort(),[first.id,second.id].sort());
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

test('model and user rules apply to historical and queued jobs even with original fallbacks',t=>{
  const f=setup(t);configure(f);
  f.store.ingest(event('permitted',{model:'gpt-6-astra'}));f.store.ingest(event('unselected'));
  f.store.ingest(event('excluded',{user_id:3}));f.store.ingest(event('processing-failed',{model:'gpt-6-astra',response:Buffer.from('{bad').toString('base64')}));
  f.store.configure({...f.store.policy(),modelFilterEnabled:true,allowedModels:['gpt-6-astra'],kimiK3Plus:true,excludedUserIds:[3]});
  const value=batch(f);assert.equal(value.preview.matched,4);assert.equal(value.preview.excluded,2);assert.equal(value.preview.unavailable,0);assert.equal(value.preview.fallbacks,1);assert.equal(value.result.created,2);
  f.store.configure({...f.store.policy(),allowedModels:[]});assert.equal(f.push.claim(),null);assert.equal(f.push.list().items[0].error_code,'COLLECTION_EXCLUDED');
});

test('payload envelope retains exact original bytes, compression, numeric spelling, WS frames and checksums',t=>{
  const f=setup(t);configure(f,{source:'original'});
  const compressed=zlib.gzipSync(Buffer.from(rawResponse)),row=event('gzip',{response:compressed.toString('base64'),encoding:'gzip'});f.store.ingest(row);batch(f);
  let job=f.push.claim(),payload=f.push.envelope(job);
  assert.equal(payload.request,rawRequest);assert.deepEqual(exportBodyBytes(payload,'response'),compressed);
  assert.equal(payload.body_encodings.response,'base64');assert.equal(payload.body_encoding_reasons.response,'COMPRESSED_CONTENT');
  assert.equal(payload.metadata.encoding,'gzip');assert.equal(payload.checksums.response.sha256,crypto.createHash('sha256').update(compressed).digest('hex'));
  f.push.finish(job,{status:'sent'});
  const frames=[{direction:'out',at:0,binary:true,body:Buffer.from([0,255,13,10]).toString('base64')}];
  f.store.ingest(event('ws',{protocol:'WebSocket',frames}));batch(f,{protocol:'WebSocket'});job=f.push.claim();payload=f.push.envelope(job);assert.deepEqual(payload.frames,frames);
  f.push.finish(job,{status:'sent'});configure(f,{source:'masked'});batch(f,{search:row.id});job=f.push.claim();payload=f.push.envelope(job);
  assert.equal(payload.metadata.encoding,'');assert(!payload.request.includes('alice@example.com'));assert(payload.request.includes('9007199254740993'));
});

test('Webhook and individual S3 JSON actually deliver marked originals when masking fails',async t=>{
  const received=[];
  const url=await receiver(t,(req,res)=>{const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{
    received.push({method:req.method,body:JSON.parse(Buffer.concat(chunks).toString())});res.writeHead(200);res.end();});});
  const f=setup(t);configure(f,{allowPrivateNetwork:true,webhook:{enabled:true,url,token:'fictional-token'},
    s3:{...f.push.policy().s3,enabled:true,format:'json',endpoint:url,region:'us-east-1',bucket:'test-bucket',accessKeyId:'fictional-id',secretAccessKey:'fictional-secret'}});
  const row=event('fallback-http',{response:Buffer.from('{invalid').toString('base64')});f.store.ingest(row);
  const value=batch(f,{},['webhook','s3']);assert.equal(value.preview.fallbacks,1);assert.equal(value.result.created,2);
  const service=new ConversationPushService(f.push);t.after(()=>service.stop());await service.tick();await service.tick();
  assert.deepEqual(received.map(row=>row.method).sort(),['POST','PUT']);
  for(const {body} of received){assert.deepEqual(Object.keys(body),['request_id','request','response']);assert.equal(body.request_id,row.request_id);
    assert.equal(body.request,Buffer.from(row.request,'base64').toString());assert.equal(body.response,'{invalid');}
  assert.equal(f.push.list({status:'sent'}).total,2);
  assert(f.push.list().items.every(job=>job.delivery_source==='original'&&job.delivery_fallback_reason==='PROCESSING_FAILED'));
});

test('original fallback retries keep the same delivery after reprocessing and database restart',async t=>{
  let now=Date.now();const f=setup(t,{now:()=>now});configure(f,{retrySeconds:5});
  const row=event('frozen-original');f.store.ingest(row);
  f.store.db.prepare('UPDATE cl_records SET redaction_version=0 WHERE id=?').run(row.id);batch(f);
  const sent=[],transport={send:async(_policy,_target,envelope)=>{sent.push(structuredClone(envelope));return sent.length===1?
    {status:'failed',errorCode:'TIMEOUT',retryable:true}:{status:'sent'};}};
  const first=new ConversationPushService(f.push,{transport});await first.tick();await first.stop();
  const frozen=f.push.db.prepare('SELECT * FROM cl_push_jobs').get();assert.equal(frozen.delivery_source,'original');
  assert(frozen.delivery_metadata);assert(!frozen.delivery_metadata.includes(Buffer.from('upstream.example.com')));
  f.store.close();f.store=new ConversationLogStore(f.directory,{now:()=>now}).initialize();
  f.push=new ConversationPushStore(f.store,{now:()=>now}).initialize();
  f.store.db.prepare('UPDATE cl_records SET redaction_version=?,processed_at=processed_at+1 WHERE id=?')
    .run(require('../src/services/conversation-sensitive').REDACTION_VERSION,row.id);
  now+=5000;const retry=new ConversationPushService(f.push,{transport});t.after(()=>retry.stop());await retry.tick();
  assert.equal(sent.length,2);assert.deepEqual(sent[1],sent[0]);assert.equal(sent[1].source,'original');
  assert.equal(sent[1].fallback_reason,'REDACTION_OUTDATED');assert.equal(sent[1].request,Buffer.from(row.request,'base64').toString());
  assert.equal(f.push.list().items[0].status,'sent');
});

test('attempted masked deliveries cannot silently change into original on retry',async t=>{
  let now=Date.now();const f=setup(t,{now:()=>now});configure(f,{retrySeconds:5});
  const row=event('frozen-masked');f.store.ingest(row);batch(f);const sent=[];
  const service=new ConversationPushService(f.push,{transport:{send:async(_policy,_target,envelope)=>{
    sent.push(envelope);return {status:'failed',errorCode:'TIMEOUT',retryable:true};}}});t.after(()=>service.stop());
  await service.tick();assert.equal(sent[0].source,'masked');assert.equal(f.push.list().items[0].delivery_source,'masked');
  f.store.db.prepare('UPDATE cl_records SET redaction_version=0 WHERE id=?').run(row.id);now+=5000;
  assert.equal(await service.tick(),false);assert.equal(sent.length,1);
  assert.equal(f.push.list().items[0].status,'cancelled');assert.equal(f.push.list().items[0].error_code,'REDACTION_OUTDATED');
});

for (const legacyVersion of [1,2,3]) test(`legacy v${legacyVersion} Webhook and S3 retries stay identical while new batches include the gateway request ID`,async t=>{
  let now=Date.now();const f=setup(t,{now:()=>now});
  configure(f,{source:'original',retrySeconds:5,s3:{...f.push.policy().s3,enabled:true,format:'json',endpoint:'https://s3.example/',
    bucket:'test-bucket',accessKeyId:'test-id',secretAccessKey:'test-secret'}});
  const row=event('legacy-body-retry');f.store.ingest(row);batch(f,{},['webhook','s3']);
  for(const job of f.push.db.prepare('SELECT * FROM cl_push_jobs').all()) {
    const parts=[job.record_id,job.destination,job.target_hash,job.content_version];if(legacyVersion>=2)parts.push(legacyVersion);
    const legacyId=crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
    f.push.db.prepare('UPDATE cl_push_jobs SET id=?,envelope_version=? WHERE id=?').run(legacyId,legacyVersion,job.id);
  }
  const received={webhook:[],s3:[]},serialized={webhook:[],s3:[]},transport={send:async(_policy,destination,envelope)=>{
    const attempts=received[destination];attempts.push(structuredClone(envelope));serialized[destination].push(JSON.stringify(deliveryBody(envelope)));
    return attempts.length===1?{status:'failed',errorCode:'TIMEOUT',retryable:true}:{status:'sent'};
  }};
  const before=new ConversationPushService(f.push,{transport});await before.tick();await before.tick();await before.stop();
  assert.equal(f.push.list().total,2);
  if(legacyVersion===1)f.push.db.exec('ALTER TABLE cl_push_jobs DROP COLUMN envelope_version');
  f.store.close();f.store=new ConversationLogStore(f.directory,{now:()=>now}).initialize();
  f.push=new ConversationPushStore(f.store,{now:()=>now}).initialize();
  assert(f.push.list().items.every(job=>job.envelope_version===legacyVersion));
  now+=5001;const after=new ConversationPushService(f.push,{transport});t.after(()=>after.stop());await after.tick();await after.tick();
  for(const attempts of Object.values(received)) {
    assert.equal(attempts.length,2);assert.deepEqual(attempts[1],attempts[0]);
    assert.equal(attempts[1].schema,'sub2api.conversation.v'+legacyVersion);
    assert.equal(attempts[1].request,legacyVersion===1?row.request:rawRequest);
    assert.equal(attempts[1].response,legacyVersion===1?row.response:rawResponse);
  }
  for(const payloads of Object.values(serialized)) {
    assert.equal(payloads[1],payloads[0]);
    if(legacyVersion===3)assert.deepEqual(JSON.parse(payloads[1]),{request:rawRequest,response:rawResponse});
    else assert.equal(JSON.parse(payloads[1]).metadata.request_id,row.request_id);
  }
  const next=batch(f,{},['webhook','s3']);assert.equal(next.result.created,2);
  await after.tick();await after.tick();
  for(const attempts of Object.values(received)) {
    assert.equal(attempts.length,3);assert.equal(attempts[2].schema,'sub2api.conversation.v4');
    assert.equal(attempts[2].body_encoding,'utf-8');assert.equal(attempts[2].request,rawRequest);
    assert.notEqual(attempts[2].delivery_id,attempts[1].delivery_id);
  }
  for(const payloads of Object.values(serialized))assert.deepEqual(JSON.parse(payloads[2]),{request_id:row.request_id,request:rawRequest,response:rawResponse});
});

test('Webhook and S3 send the gateway request ID with exact decompressed bodies and retain delivery idempotency',async t=>{
  const received=[];const url=await receiver(t,(req,res)=>{let text='';req.on('data',chunk=>text+=chunk);req.on('end',()=>{
    received.push({body:JSON.parse(text),headers:req.headers,url:req.url});res.writeHead(200);res.end();});});
  const f=setup(t);configure(f,{source:'original',allowPrivateNetwork:true,webhook:{enabled:true,url,token:'fictional-token'},
    s3:{...f.push.policy().s3,enabled:true,format:'json',endpoint:url,region:'us-east-1',bucket:'test-bucket',accessKeyId:'fictional-id',secretAccessKey:'fictional-secret'}});
  const text='data: {"id":9007199254740993,"n":1.2300}\r\n\r\ndata: [DONE]\r\n\r\n';
  const row=event('compressed-http',{encoding:'gzip',response:zlib.gzipSync(Buffer.from(text)).toString('base64')});f.store.ingest(row);batch(f,{},['webhook','s3']);
  const service=new ConversationPushService(f.push);t.after(()=>service.stop());await service.tick();await service.tick();
  assert.equal(received.length,2);for(const delivery of received)assert.deepEqual(delivery.body,{request_id:row.request_id,request:rawRequest,response:text});
  const jobs=f.push.list({status:'sent'}).items;
  assert(received.some(delivery=>jobs.some(job=>delivery.headers['idempotency-key']===job.id)));
  assert(received.some(delivery=>jobs.some(job=>new URL(delivery.url,url).pathname.endsWith(job.id+'.json'))));
  assert.deepEqual(f.store.payload(row.id,'original','response',{decodeText:false}).body,Buffer.from(row.response,'base64'));
});

test('invalid archived request IDs fail both Webhook and S3 once without sending or network retries',async t=>{
  let requests=0;const url=await receiver(t,(_req,res)=>{requests++;res.writeHead(200);res.end();});
  const f=setup(t);configure(f,{source:'original',allowPrivateNetwork:true,webhook:{enabled:true,url,token:'fictional-token'},
    s3:{...f.push.policy().s3,enabled:true,format:'json',endpoint:url,region:'us-east-1',bucket:'test-bucket',accessKeyId:'fictional-id',secretAccessKey:'fictional-secret'}});
  const row=event('push-invalid-id');assert(f.store.ingest(row).accepted);
  f.store.db.prepare("UPDATE cl_records SET request_id='resp_supplier' WHERE id=?").run(row.id);batch(f,{},['webhook','s3']);
  const service=new ConversationPushService(f.push);t.after(()=>service.stop());await service.tick();await service.tick();
  assert.equal(requests,0);assert.equal(f.push.list({status:'failed'}).total,2);
  for(const job of f.push.list().items){assert.equal(job.error_code,'EXPORT_REQUEST_ID');assert.equal(job.attempts,1);}
  assert.equal(await service.tick(),false);assert.equal(requests,0);
});

test('legacy delivery metadata migration is additive and stale leases cannot freeze the selected copy',t=>{
  let now=Date.now();const f=setup(t,{now:()=>now});configure(f);f.store.ingest(event('frozen-lease'));batch(f);
  for(const column of ['delivery_source','delivery_fallback_reason','delivery_version','delivery_metadata']) {
    f.push.db.exec(`ALTER TABLE cl_push_jobs DROP COLUMN ${column}`);
  }
  f.push=new ConversationPushStore(f.store,{now:()=>now}).initialize();
  assert.equal(f.push.list().total,1);assert.equal(f.push.list().items[0].delivery_source,'');
  const stale=f.push.claim(),envelope=f.push.envelope(stale);now+=60000;const current=f.push.claim();
  assert.equal(current.id,stale.id);assert.notEqual(current.lease_token,stale.lease_token);
  assert.throws(()=>f.push.freezeCopy(stale,envelope),{code:'CONVERSATION_PUSH_CONFLICT'});
  assert.equal(f.push.list().items[0].delivery_source,'');
  const body=f.push.envelope(current);f.push.freezeCopy(current,body);
  assert.equal(f.push.list().items[0].delivery_source,'masked');assert.deepEqual(f.push.envelope(current),body);
  f.push.cancelBatch(current.batch_id);assert.throws(()=>f.push.freezeCopy(current,body),{code:'CONVERSATION_PUSH_CONFLICT'});
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

test('a Webhook success response cannot mark an interrupted large body as fully sent',async t=>{
  let received=0;
  const url=await receiver(t,(req,res)=>{
    req.on('error',()=>{});req.on('data',chunk=>{received+=chunk.length;});
    req.once('data',()=>{res.writeHead(204);res.end();});req.resume();
  });
  const envelope={delivery_id:'early-ack',request:'x'.repeat(8*1024**2)};
  const result=await new ConversationPushTransport().send(localPolicy(url),'webhook',envelope);
  assert.equal(result.status,'failed');assert(received>0);assert(received<Buffer.byteLength(JSON.stringify(envelope)));
});

test('remote S3 errors cannot impersonate local memory pressure or bypass the network retry limit',async t=>{
  const url=await receiver(t,(req,res)=>{req.resume();req.on('end',()=>{
    res.writeHead(403,{'content-type':'application/xml'});
    res.end('<Error><Code>AccessDenied</Code><code>EXPORT_MEMORY</code><Message>fixture</Message></Error>');
  });});
  const policy=localPolicy(url,{s3:{enabled:true,endpoint:url,region:'us-east-1',bucket:'test-bucket',prefix:'',forcePathStyle:true,
    accessKeyId:'test-key',secretAccessKey:'test-secret'}});
  const result=await new ConversationPushTransport().send(policy,'s3',{delivery_id:'remote-memory'});
  assert.equal(result.errorCode,'HTTP_REJECTED');assert.equal(result.httpStatus,403);assert.equal(result.retryable,false);
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
  const other=new ConversationLogStore(f.directory).openReader(),policy=f.push.policy();
  try {
    other.db.exec('BEGIN IMMEDIATE');
    let attempts=0;
    const save=f.push.configure.bind(f.push);
    f.push.configure=(...args)=>{attempts++;return save(...args);};
    const saving=request('conversation-logs/push/policy','PUT',writes,policy);
    const deadline=performance.now()+1000;
    while(!attempts&&performance.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
    assert(attempts,'the save request must reach the contended writer');
    assert.equal((await fetch(base.replace('/api/','/healthz'),{signal:AbortSignal.timeout(1000)})).status,200);
    assert.equal(f.push.policy().version,policy.version);
    other.db.exec('ROLLBACK');
    const saved=await saving;assert.equal(saved.status,200);
    const body=await saved.json();assert.equal(body.version,policy.version+1);
    assert(!JSON.stringify(body).includes('test-private-token'));
    assert.equal(f.push.db.pragma('busy_timeout',{simple:true}),5000);
    f.push.configure=save;
  } finally { if(other.db.inTransaction)other.db.exec('ROLLBACK');other.close(); }
  assert.equal((await request('conversation-logs/push/jsonl/flush','POST',headers,{})).status,403);
  assert.equal((await request('conversation-logs/push/jsonl/flush','POST',writes,{})).status,409);
  assert.equal((await request('conversation-logs/push/jsonl/missing/retry','POST',headers,{})).status,403);
  assert.equal((await request('conversation-logs/push/jsonl/missing/retry','POST',writes,{})).status,409);
  assert.equal((await request('conversation-logs/push/test/webhook','POST',writes,{})).status,200);assert.equal(sent[0].schema,'sub2api.conversation.test.v1');assert(!JSON.stringify(sent[0]).includes('alice'));
  const preview=await(await request('conversation-logs/push/preview','POST',writes,{filter:{},destinations:['webhook']})).json();
  const body={filter:{},destinations:['webhook'],batchId:crypto.randomUUID(),previewToken:preview.previewToken};
  assert.equal((await request('conversation-logs/push/batches','POST',headers,body)).status,403);
  assert.equal((await request('conversation-logs/push/batches','POST',writes,body)).status,202);
  await worker.running;assert.equal(sent[1].schema,'sub2api.conversation.v4');assert.equal(f.push.list().items[0].status,'sent');
});
