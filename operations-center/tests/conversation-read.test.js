'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const {setTimeout:delay} = require('node:timers/promises');
const {fixture,event,removeMetadata} = require('./conversation-logs-fixture');
const {ConversationLogStore} = require('../src/conversation-log-store');
const {projection,initializeMetadata,pushMetadataStatus} = require('../src/services/conversation-metadata');
const {ConversationReadService} = require('../src/services/conversation-read-service');
const {ConversationArchiveService} = require('../src/services/conversation-archive-service');
const {ConversationCleanupStore} = require('../src/conversation-cleanup-store');
const {AuthService} = require('../src/auth');
const {createApp} = require('../src/app');

async function until(check,ms=10000) {
  const deadline=Date.now()+ms;
  while (!check()) {assert(Date.now()<deadline,'reader did not settle');await delay(10);}
}
function finishIndex(store) {for (let i=0;i<100;i++) if (store.backfillMetadata().done) return;assert.fail('index did not finish');}

test('legacy metadata migration is lazy, keeps ciphertext and resumes without exposing incomplete history as complete', t => {
  const f=fixture();t.after(() => {f.store.close();f.close();});
  for (let i=0;i<3;i++) f.store.ingest(event('legacy-metadata-'+i,{at:Date.now()+i*1000}));
  const saved=f.store.db.prepare('SELECT id,original,masked FROM cl_records ORDER BY id').all();
  removeMetadata(f.store);f.store.close();f.store=new ConversationLogStore(f.directory).initialize();
  assert.deepEqual(f.store.metadataStatus(),{ready:false,indexed:0,total:3});
  assert.equal(f.store.list().summary.total,0);assert.equal(f.store.status().records,3);
  for (const name of ['bytes','gaps','processingFailures']) assert.equal(f.store.status()[name],null);
  assert.throws(() => f.store.exportIndex(),{code:'CONVERSATION_HISTORY_PREPARING'});
  assert.equal(f.store.detail(saved[0].id).id,saved[0].id);
  assert(!f.store.backfillMetadata().done);assert.equal(f.store.metadataStatus().indexed,1);
  assert.equal(f.store.list().items[0].id,event('legacy-metadata-2').id);
  f.store.close();f.store=new ConversationLogStore(f.directory).initialize();finishIndex(f.store);
  assert.deepEqual(f.store.metadataStatus(),{ready:true,indexed:3,total:3});
  assert.equal(f.store.exportIndex().count,3);
  assert.deepEqual(f.store.db.prepare('SELECT id,original,masked FROM cl_records ORDER BY id').all(),saved);
});

test('compact list, sessions and aggregates match source filters and never select or decrypt body BLOBs', t => {
  const f=fixture();t.after(() => f.close());
  for (let i=0;i<5;i++) f.store.ingest(event('metadata-filter-'+i,{user_id:2+i,key_id:20+i,protocol:i===1?'SSE':'JSON',complete:i!==2,reason:i===2?'read_error':''}));
  f.store.db.exec("UPDATE cl_records SET original=NULL,masked=NULL,complete=0,reason='redaction_failed' WHERE user_id=5");
  f.store.db.exec("UPDATE cl_records SET processing_error='INVALID_JSON' WHERE user_id=6");
  for (const query of [{},{capture:'complete'},{capture:'partial'},{capture:'missing'},{capture:'redaction_failed'},{user_id:2},{key_id:22},{protocol:'SSE'},{search:'example-model'},{search:'4'},{start:'2020-01-01',end:'2099-01-01'}]) {
    const filter=f.store.where(query);
    const expected=f.store.db.prepare('SELECT id FROM cl_records'+filter.sql+' ORDER BY at DESC,id').all(...filter.args).map(row=>row.id);
    assert.deepEqual(f.store.list(query).items.map(row=>row.id),expected);
    assert.equal(f.store.list(query).summary.total,expected.length);
  }
  const prepare=f.store.db.prepare.bind(f.store.db), open=f.store.open.bind(f.store);
  f.store.db.prepare=sql => {assert(!/SELECT \* FROM cl_records/.test(sql));return prepare(sql);};
  f.store.open=(body,aad) => {assert(aad.startsWith('policy:'));return open(body,aad);};
  assert.equal(f.store.list().items.length,5);assert.equal(f.store.sessions().items.length,5);
  assert.equal(f.store.status().gaps,2);assert.equal(f.store.status().processingFailures,2);
  assert.equal(f.store.detail(event('metadata-filter-0').id).frames.length,0);
});

test('metadata triggers follow retries, completion changes, pruning and history clearing atomically', t => {
  const f=fixture();t.after(() => f.close());const row=event('metadata-updates');f.store.ingest(row);
  f.store.db.prepare('UPDATE cl_records SET redaction_version=0,completion_version=0 WHERE id=?').run(row.id);
  const old=f.store.detail(row.id);f.store.retry(row.id,{policy_version:f.store.policy().version,processed_at:old.processed_at});
  const source=f.store.db.prepare('SELECT '+projection()+' FROM cl_records WHERE id=?').get(row.id);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM cl_record_metadata WHERE id=?').get(row.id),source);
  const cleanup=new ConversationCleanupStore(f.store).initialize();
  cleanup.requestAll({confirm:'clear-all-history',request_id:require('node:crypto').randomUUID()});
  while (cleanup.pending()) cleanup.step();
  assert.deepEqual(f.store.metadataStatus(),{ready:true,indexed:0,total:0});
  const expired=event('metadata-expired');assert(f.store.ingest(expired).accepted);
  f.store.db.prepare('UPDATE cl_records SET at=? WHERE id=?').run(Date.now()-10*86400000,expired.id);
  assert.equal(f.store.prune(),1);assert.equal(f.store.metadataStatus().indexed,0);
  f.store.ingest(event('metadata-new-after-clear'));
  f.store.db.exec('DELETE FROM cl_records');assert.equal(f.store.list().summary.total,0);
});

for (const operation of ['update','delete']) test('backfill cannot overwrite a concurrent '+operation+' or resurrect deleted history',t => {
  const f=fixture(),other=new ConversationLogStore(f.directory).initialize();t.after(() => {other.close();f.close();});
  const row=event('metadata-race-'+operation);f.store.ingest(row);f.store.db.exec('DELETE FROM cl_record_metadata');
  const prepare=f.store.db.prepare.bind(f.store.db);let raced=false;
  f.store.db.prepare=sql => {
    const statement=prepare(sql);
    if (sql==='SELECT '+projection()+' FROM cl_records WHERE id=?') return {get(id) {
      const value=statement.get(id);raced=true;
      if (operation==='update') other.db.prepare("UPDATE cl_records SET processing_error='PROCESSING_FAILED' WHERE id=?").run(id);
      else other.db.prepare('DELETE FROM cl_records WHERE id=?').run(id);
      return value;
    }};
    return statement;
  };
  f.store.backfillMetadata();assert(raced);assert(f.store.metadataStatus().ready);
  if (operation==='update') assert.equal(f.store.detail(row.id).processing_error,'PROCESSING_FAILED');
  else assert.equal(f.store.list().items.length,0);
});

test('legacy push fingerprints migrate lazily without changing list readiness or ciphertext',t => {
  const f=fixture();t.after(()=>f.close());
  for (let index=0;index<2;index++) f.store.ingest(event('push-migration-'+index));
  const saved=f.store.db.prepare('SELECT id,original,masked,fingerprint FROM cl_records ORDER BY id').all();
  f.store.db.exec(`DROP TRIGGER cl_metadata_insert; DROP TRIGGER cl_metadata_update; DROP INDEX cl_metadata_push_pending;
    ALTER TABLE cl_record_metadata DROP COLUMN fingerprint`);
  const prepare=f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare=sql=>{assert(!/FROM cl_records/i.test(sql),'initialization must not read legacy body overflow pages');return prepare(sql);};
  initializeMetadata(f.store.db);f.store.db.prepare=prepare;
  assert.deepEqual(f.store.metadataStatus(),{ready:true,indexed:2,total:2});
  assert.deepEqual(pushMetadataStatus(f.store.db),{ready:false,indexed:0,total:2});
  assert.equal(f.store.list().summary.total,2);assert.equal(f.store.exportIndex().count,2);
  assert(!f.store.backfillMetadata().done);assert.equal(pushMetadataStatus(f.store.db).indexed,1);
  finishIndex(f.store);assert.deepEqual(pushMetadataStatus(f.store.db),{ready:true,indexed:2,total:2});
  assert.deepEqual(f.store.db.prepare('SELECT id,original,masked,fingerprint FROM cl_records ORDER BY id').all(),saved);
  for (const row of saved) assert.equal(f.store.db.prepare('SELECT fingerprint FROM cl_record_metadata WHERE id=?').get(row.id).fingerprint,row.fingerprint);
});

for (const operation of ['update','delete','replace']) test('push fingerprint backfill preserves a concurrent '+operation,t=>{
  const f=fixture(),other=new ConversationLogStore(f.directory).initialize();t.after(()=>{other.close();f.close();});
  const row=event('push-fingerprint-race-'+operation);f.store.ingest(row);
  f.store.db.prepare("UPDATE cl_record_metadata SET fingerprint='' WHERE id=?").run(row.id);
  const prepare=f.store.db.prepare.bind(f.store.db);let raced=false;
  f.store.db.prepare=sql=>{
    const statement=prepare(sql);
    if (sql==='SELECT fingerprint FROM cl_records WHERE id=?') return {get(id) {
      const value=statement.get(id);raced=true;
      if (operation==='update') other.db.prepare("UPDATE cl_records SET processing_error='PROCESSING_FAILED' WHERE id=?").run(id);
      else {
        other.db.prepare('DELETE FROM cl_records WHERE id=?').run(id);
        if (operation==='replace') assert(other.ingest({...row,response:Buffer.from('{"changed":true}').toString('base64')}).accepted);
      }
      return value;
    }};
    return statement;
  };
  f.store.backfillMetadata();assert(raced);assert(pushMetadataStatus(f.store.db).ready);
  const source=prepare('SELECT fingerprint,processing_error FROM cl_records WHERE id=?').get(row.id);
  assert.deepEqual(prepare('SELECT fingerprint,processing_error FROM cl_record_metadata WHERE id=?').get(row.id),source);
  if (operation==='update') assert.equal(source.processing_error,'PROCESSING_FAILED');
});

async function setup(t,options={}) {
  const f=fixture(),auth=new AuthService(f.config),archive=new ConversationArchiveService(f.store);
  const read=new ConversationReadService(f.store,{configured:true,canWork:()=>false,...options});
  const app=createApp({config:f.config,database:{},auth,conversations:f.store,conversationRead:read,conversationArchive:archive,messages:f.messages});
  const server=await new Promise(resolve=>{const value=app.listen(0,'127.0.0.1',()=>resolve(value));});
  t.after(async()=>{await read.stop();await archive.stop();auth.close();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});f.close();});
  const base='http://127.0.0.1:'+server.address().port;
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password:f.config.adminPassword})});
  const session=await login.json();await archive.start();
  return {...f,read,archive,base,headers:{authorization:'Session '+session.sessionToken},
    collector:{authorization:'Bearer '+f.token,'content-type':'application/json'},
    get:(target,options={})=>fetch(base+'/api/conversation-logs/'+target,{headers:{authorization:'Session '+session.sessionToken},...options})};
}
const workerFile=path.join(__dirname,'conversation-read-worker-fixture.cjs');
async function blockingRead(f,controller) {
  await f.read.ensureChild();
  const blocked=new Promise(resolve=>f.read.child.once('message',resolve));
  const result=f.get('records?search=__fixture_block__',{signal:controller?.signal});
  assert.equal((await blocked).type,'fixture-blocked');
  return {result};
}

test('authenticated isolated reads preserve exact payloads, HTTP/WS details and live collector status without main-process fallback',async t=>{
  const f=await setup(t),row=event('isolated-read');f.store.ingest(row);
  const ws=event('isolated-ws',{protocol:'WebSocket',method:'WS',frames:[{direction:'in',at:1,binary:false,body:Buffer.from('{"message":"hello"}').toString('base64')}]});f.store.ingest(ws);
  for (const name of ['list','status','sessions','detail','payload','exportIndex']) f.store[name]=()=>assert.fail('synchronous read fallback');
  for (const target of ['status','records','sessions','index','records/'+row.id,'records/'+ws.id]) assert.equal((await f.get(target)).status,200,target);
  await fetch(f.base+'/api/conversation-logs/collector-policy',{headers:{...f.collector,'x-conversation-dropped':'7','x-conversation-collector-version':'2'}});
  const status=await(await f.get('status')).json();assert(status.configured);assert.equal(status.collectorDropped,7);assert.equal(status.collectorVersion,2);assert(status.lastContact);
  const body='records/'+row.id+'/payload/request?source=original';
  const value=await(await f.get(body)).json();assert.equal(value.base64,row.request);
  assert.equal(Buffer.from(await(await f.get(body+'&download=1')).arrayBuffer()).toString('base64'),row.request);
  assert.equal((await(await f.get(body+'&view=preview')).json()).text,Buffer.from(row.request,'base64').toString());
  assert.equal((await(await f.get('records/'+ws.id)).json()).frames.length,1);
  const invalid=await f.get('records?start=bad');assert.equal(invalid.status,400);
  for (const headers of [{},f.collector]) assert.equal((await fetch(f.base+'/api/conversation-logs/status',{headers})).status,401);
  assert.equal((await fetch('http://127.0.0.1:'+f.read.port+'/status')).status,401);
});

test('a blocked SQLite read times out independently while health, policy and ingestion remain responsive, then recovers',async t=>{
  const f=await setup(t,{workerFile,timeoutMs:1600}),{result}=await blockingRead(f);
  const before=performance.now();
  assert.equal((await fetch(f.base+'/healthz')).status,200);
  assert.equal((await fetch(f.base+'/api/conversation-logs/collector-policy',{headers:f.collector})).status,200);
  const row=event('ingest-during-blocked-read');
  const saved=await fetch(f.base+'/api/conversation-logs/ingest',{method:'POST',headers:f.collector,body:JSON.stringify(row)});
  assert.equal(saved.status,200);assert((await saved.json()).accepted);
  assert(performance.now()-before<1000,'collector and health waited for the blocked reader');
  const response=await result;assert.equal(response.status,503);assert.equal((await response.json()).error.code,'CONVERSATION_READ_TIMEOUT');
  assert.equal((await f.get('records/'+row.id)).status,200);
});

test('client cancellation and reader death release the queue and restart only the isolated reader',async t=>{
  const f=await setup(t,{workerFile}),controller=new AbortController();
  const {result}=await blockingRead(f,controller),old=f.read.child;
  const cancelled=assert.rejects(result,{name:'AbortError'});controller.abort();await cancelled;
  await until(()=>f.read.child!==old);assert.equal((await f.get('status')).status,200);
  const blocked=await blockingRead(f);f.read.child.kill('SIGKILL');
  const failed=await blocked.result;assert.equal(failed.status,503);assert.equal((await failed.json()).error.code,'CONVERSATION_READ_UNAVAILABLE');
  assert.equal((await f.get('status')).status,200);assert(f.archive.port);
});

test('the read queue is bounded, expires waiting requests and never holds health',async t=>{
  const f=await setup(t,{workerFile,maxQueue:2,queueTimeoutMs:250,timeoutMs:1000}),{result}=await blockingRead(f);
  const waiting=[f.get('status'),f.get('records')];await until(()=>f.read.queue.length===2);
  const busy=await f.get('sessions');assert.equal(busy.status,503);assert.equal((await busy.json()).error.code,'CONVERSATION_READ_BUSY');
  for (const promise of waiting) {const response=await promise;assert.equal(response.status,503);assert.equal((await response.json()).error.code,'CONVERSATION_READ_BUSY');}
  assert.equal((await fetch(f.base+'/healthz')).status,200);assert.equal((await result).status,503);
  // Restore the production queue budget before a cold process start on a busy test host.
  f.read.queueTimeoutMs=5000;
  assert.equal((await f.get('status')).status,200);
});

test('memory refusal has no synchronous fallback or data loss and idle readers exit then restart',async t=>{
  const f=await setup(t,{memoryBudgetBytes:0,idleMs:40});const row=event('read-memory-refusal');f.store.ingest(row);
  const refused=await f.get('records');assert.equal(refused.status,409);assert.equal((await refused.json()).error.code,'CONVERSATION_READ_MEMORY');assert.equal(f.read.child,null);
  assert.equal(f.store.payload(row.id,'original','request').body.toString('base64'),row.request);
  f.read.memoryBudgetBytes=undefined;assert.equal((await f.get('records')).status,200);
  await until(()=>!f.read.child);assert.equal((await f.get('status')).status,200);
});

test('body admission refuses large decryptions without truncating or modifying either archived copy',async t=>{
  const f=await setup(t,{memoryBudgetBytes:128*1024**2});
  const policy=f.store.configure({...f.store.policy(),mode:'original'});
  const raw=Buffer.from(JSON.stringify({text:'x'.repeat(18*1024**2)}));
  const row=event('large-read-budget',{policy_version:policy.version,request:raw.toString('base64')});assert(f.store.ingest(row).accepted);
  const before=f.store.db.prepare('SELECT original FROM cl_records WHERE id=?').get(row.id).original;
  assert.equal((await f.get('records/'+row.id)).status,200,'HTTP metadata must not decrypt the large body');
  const refused=await f.get('records/'+row.id+'/payload/request?source=original');assert.equal(refused.status,409);
  assert.equal((await refused.json()).error.code,'CONVERSATION_READ_MEMORY');
  assert.deepEqual(f.store.db.prepare('SELECT original FROM cl_records WHERE id=?').get(row.id).original,before);
  assert.equal((await fetch(f.base+'/healthz')).status,200);
});

test('compressed text expansion uses the live read budget while raw downloads stay byte-exact',async t=>{
  const f=await setup(t,{memoryBudgetBytes:128*1024**2}),policy=f.store.configure({...f.store.policy(),mode:'original'});
  const compressed=zlib.gzipSync(Buffer.from(JSON.stringify({text:'x'.repeat(32*1024**2)})));
  const row=event('compressed-read-budget',{policy_version:policy.version,encoding:'gzip',response:compressed.toString('base64')});assert(f.store.ingest(row).accepted);
  const target='records/'+row.id+'/payload/response?source=original';
  const preview=await f.get(target+'&view=preview');assert.equal(preview.status,409);assert.equal((await preview.json()).error.code,'CONVERSATION_READ_MEMORY');
  assert.deepEqual(Buffer.from(await(await f.get(target+'&download=1')).arrayBuffer()),compressed);
  const raw=await(await f.get(target)).json();assert.equal(raw.text,null);assert.equal(raw.base64,row.response);
  assert.equal((await fetch(f.base+'/healthz')).status,200);
});

test('background indexing yields to archive activity and interactive reads, and resumes safely',async t=>{
  let canWork=true;const f=await setup(t,{workerFile,canWork:()=>canWork,intervalMs:30});
  f.store.ingest(event('lazy-worker'));f.store.db.exec('DELETE FROM cl_record_metadata');
  const marker=path.join(f.store.directory,'fixture-block-backfill');fs.writeFileSync(marker,'fixture');
  await f.read.ensureChild();let blocked=new Promise(resolve=>f.read.child.once('message',resolve));
  f.read.start();assert.equal((await blocked).type,'fixture-blocked');
  canWork=false;await until(()=>!f.read.child);fs.rmSync(marker);
  const warming=await(await f.get('records')).json();assert.equal(warming.metadataIndex.ready,false);
  assert.equal(f.store.metadataStatus().indexed,0);
  fs.writeFileSync(marker,'fixture');blocked=new Promise(resolve=>f.read.child.once('message',resolve));canWork=true;
  assert.equal((await blocked).type,'fixture-blocked');
  const interactive=f.get('status');canWork=false;fs.rmSync(marker);
  assert.equal((await interactive).status,200,'preempted reader must restart before serving the first request');
  canWork=true;await until(()=>f.store.metadataStatus().ready);assert.equal(f.store.list().summary.total,1);
});

test('list and status responses keep background push migration scheduled until fingerprints are ready',async t=>{
  let canWork=false;const f=await setup(t,{canWork:()=>canWork,intervalMs:30});
  f.store.ingest(event('push-worker-migration'));f.store.db.exec("UPDATE cl_record_metadata SET fingerprint=''");
  for (const target of ['records','status']) {
    const value=await(await f.get(target)).json();assert.equal(value.metadataIndex.ready,true);
    assert.equal(f.read.needsIndex,true,'list readiness must not stop push fingerprint preparation');
  }
  assert.equal(pushMetadataStatus(f.store.db).ready,false);
  canWork=true;f.read.start();await until(()=>pushMetadataStatus(f.store.db).ready);
  await until(()=>!f.read.needsIndex);assert.equal(f.store.list().summary.total,1);
});
