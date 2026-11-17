'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, event } = require('./conversation-logs-fixture');
const { ConversationCleanupStore } = require('../src/conversation-cleanup-store');
const { ConversationCleanupService } = require('../src/services/conversation-cleanup-service');
const { ConversationArchiveService } = require('../src/services/conversation-archive-service');
const { ConversationPushStore } = require('../src/conversation-push-store');
const { ConversationPushService } = require('../src/services/conversation-push-service');
const { AuthService } = require('../src/auth');
const { createApp } = require('../src/app');

const select = (f, extra = {}) => f.store.configure({ ...f.store.policy(), modelFilterEnabled:true, allowedModels:['gpt-6.1-sol','Fable5.1'], kimiK3Plus:true, ...extra });
const ids = f => f.store.db.prepare('SELECT id FROM cl_records ORDER BY id').all().map(row => row.id);
async function until(predicate, milliseconds = 18000) {
  const end = Date.now() + milliseconds;
  while (!predicate()) { assert(Date.now() < end, 'Timed out waiting for cleanup worker'); await new Promise(resolve => setTimeout(resolve, 30)); }
}
function finish(store) { for (let index = 0; index < 100 && store.pending(); index++) store.step(); assert.equal(store.pending(), null); }

test('model cleanup shares aliases and Kimi matching, deletes unknown models and preserves selected raw bytes', t => {
  const f = fixture(); t.after(() => f.close());
  const keep = ['GPT-6.1-SOL','Fable5.1','Claude Fable 5.1','Kimi K3','kimi-k3.1-pro','kimi-k4'];
  const remove = ['','example-model','gpt-6.1-terra','Fable5.2','kimi-k2.9'];
  const saved = keep.map(model => event('keep-' + model,{model}));
  for (const row of [...saved,...remove.map(model => event('remove-' + model,{model}))]) assert(f.store.ingest(row).accepted);
  const p = select(f), store = new ConversationCleanupStore(f.store).initialize();
  store.request({policy_version:p.version}); finish(store);
  assert.equal(store.latest().deleted, remove.length); assert.equal(store.latest().scanned, keep.length + remove.length);
  assert.deepEqual(ids(f), saved.map(row => row.id).sort());
  for (const row of saved) assert.equal(f.store.payload(row.id,'original','request').body.toString('base64'), row.request);
  assert.deepEqual(f.store.policy(),p);
});

test('cleanup is explicitly triggered with current saved policy, blocks disabled/empty selection and deduplicates clicks', t => {
  const f = fixture(); t.after(() => f.close()); const store = new ConversationCleanupStore(f.store).initialize();
  f.store.ingest(event('before-request')); assert.equal(store.pending(),null);
  assert.throws(() => store.request({policy_version:f.store.policy().version}),{code:'CONVERSATION_CLEANUP_MODELS_REQUIRED'});
  const empty = select(f,{allowedModels:[],kimiK3Plus:false});
  assert.throws(() => store.request({policy_version:empty.version}),{code:'CONVERSATION_CLEANUP_MODELS_REQUIRED'});
  const p = select(f);
  assert.throws(() => store.request({policy_version:empty.version}),{code:'CONVERSATION_POLICY_CONFLICT'});
  assert.throws(() => store.request({policy_version:p.version,all:true}),{code:'CONVERSATION_INVALID_INPUT'});
  const job = store.request({policy_version:p.version}); assert.equal(store.request({policy_version:p.version}).id,job.id);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM cl_model_cleanups').get().n,1);
  assert.equal(ids(f).length,1);
});

test('history boundary excludes concurrent new records and a changed model list pauses before deletion', t => {
  const f = fixture(); t.after(() => f.close());
  const old = event('old-outside'), keep = event('old-selected',{model:'gpt-6.1-sol'});
  f.store.ingest(old); f.store.ingest(keep); const p = select(f), store = new ConversationCleanupStore(f.store).initialize();
  store.request({policy_version:p.version});
  const fresh = event('fresh',{model:'gpt-6.1-sol',policy_version:p.version}); assert(f.store.ingest(fresh).accepted);
  const changed = select(f,{allowedModels:['example-model','gpt-6.1-sol'],kimiK3Plus:false});
  store.step(); assert.equal(store.latest().status,'paused'); assert.equal(store.latest().deleted,0); assert(ids(f).includes(old.id));
  const job = store.request({policy_version:changed.version}); finish(store); assert.equal(store.latest().id,job.id); assert.equal(store.latest().deleted,0);
  const next = select(f); store.request({policy_version:next.version});
  f.store.configure({...next,retention:0}); finish(store);
  assert.equal(store.latest().deleted,1); assert.deepEqual(ids(f),[keep.id,fresh.id].sort());
});

test('one-record transactions persist progress, resume after restart and stop between batches', t => {
  const f = fixture(); t.after(() => f.close());
  for (let index=0;index<8;index++) f.store.ingest(event('resume-' + index));
  const p=select(f), store=new ConversationCleanupStore(f.store).initialize(); store.request({policy_version:p.version});
  assert.equal(store.step().deleted,1); assert.equal(store.latest().deleted,1);
  const reopened=new ConversationCleanupStore(f.store).initialize(); assert.equal(reopened.pending().cursor_rowid,1);
  assert.equal(reopened.step().deleted,1); reopened.cancel(reopened.pending().id);
  assert.equal(reopened.step().worked,false); assert.equal(ids(f).length,6); assert.equal(reopened.latest().status,'cancelled');
  reopened.request({policy_version:p.version}); finish(reopened); assert.equal(ids(f).length,0); assert.equal(reopened.latest().deleted,6);
});

test('deleting an unselected model removes local push references and invalidates a buffered JSONL file', async t => {
  const f=fixture(); t.after(()=>f.close()); const push=new ConversationPushStore(f.store).initialize();
  const p=push.policy(); push.configure({...p,enabled:true,automatic:true,source:'original',s3:{...p.s3,enabled:true,endpoint:'https://s3.example.com',bucket:'fixture-bucket',accessKeyId:'fictional',secretAccessKey:'fictional'}});
  const service=new ConversationPushService(push); t.after(()=>service.stop());
  const row=event('buffered-outside'); f.store.ingest(row); push.scanAutomatic(); service.jsonl.store.assignOne();
  assert.equal(push.list().items[0].status,'buffered'); const policy=select(f), cleanup=new ConversationCleanupStore(f.store).initialize();
  cleanup.request({policy_version:policy.version}); finish(cleanup);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM cl_push_jsonl_members').get().n,0);
  service.jsonl.store.reconcile();
  assert.equal(push.list().total,0); assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM cl_push_arrivals').get().n,0);
  assert.equal(service.jsonl.store.list().files[0].status,'cancelled');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM cl_push_jsonl_members').get().n,0);
});

test('admin authentication and CSRF protect asynchronous cleanup and cancellation', async t => {
  const f=fixture(); const cleanup=new ConversationCleanupService(f.store), auth=new AuthService(f.config);
  t.after(async()=>{await cleanup.stop();auth.close();f.close();});
  const p=select(f), app=createApp({config:f.config,auth,database:{},conversations:f.store,conversationCleanup:cleanup,messages:f.messages});
  const server=app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})); const base='http://127.0.0.1:'+server.address().port;
  const path=base+'/api/conversation-logs/model-cleanup', body=JSON.stringify({policy_version:p.version});
  assert.equal((await fetch(path)).status,401);
  assert.equal((await fetch(path,{headers:{authorization:'Bearer '+f.token}})).status,401);
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password:f.config.adminPassword})});
  const session=await login.json(), headers={authorization:'Session '+session.sessionToken,'content-type':'application/json'};
  assert.equal((await fetch(path,{method:'POST',headers,body})).status,403);
  headers['x-csrf-token']=session.csrfToken;
  const response=await fetch(path,{method:'POST',headers,body});assert.equal(response.status,202);const value=await response.json();assert(value.job.id);
  assert.equal((await fetch(path+'/'+value.job.id+'/cancel',{method:'POST',headers:{authorization:headers.authorization},body:'{}'})).status,403);
  assert.equal((await fetch(path+'/'+value.job.id+'/cancel',{method:'POST',headers,body:'{}'})).status,200);
});

test('real low-priority cleanup worker coexists with archived ingestion and responsive management requests', async t => {
  const f=fixture(); f.store.configure({...f.store.policy(),mode:'original'});
  for(let index=0;index<8;index++) f.store.ingest(event('large-cleanup-'+index,{policy_version:f.store.policy().version,request:Buffer.from(JSON.stringify({text:'x'.repeat(1024**2)})).toString('base64')}));
  const keep=event('large-keep',{model:'gpt-6.1-sol',policy_version:f.store.policy().version});f.store.ingest(keep);
  const p=select(f), cleanup=new ConversationCleanupService(f.store), archive=new ConversationArchiveService(f.store), auth=new AuthService(f.config);
  t.after(async()=>{await cleanup.stop();await archive.stop();auth.close();f.close();});await archive.start();
  const app=createApp({config:f.config,auth,database:{},conversations:f.store,conversationArchive:archive,conversationCleanup:cleanup,messages:f.messages});
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));const base='http://127.0.0.1:'+server.address().port;
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password:f.config.adminPassword})});
  const session=await login.json();cleanup.request({policy_version:p.version});await until(()=>cleanup.ready);assert.notEqual(cleanup.child.pid,process.pid);
  for(let index=0;index<4;index++) {
    const policy=await fetch(base+'/api/conversation-logs/policy',{headers:{authorization:'Session '+session.sessionToken},signal:AbortSignal.timeout(2000)});assert.equal(policy.status,200);
    const row=event('concurrent-'+index,{model:'gpt-6.1-sol',policy_version:p.version});
    const ingest=await fetch(base+'/api/conversation-logs/ingest',{method:'POST',headers:{authorization:'Bearer '+f.token,'content-type':'application/json'},body:JSON.stringify(row),signal:AbortSignal.timeout(3000)});
    assert.equal(ingest.status,200);assert((await ingest.json()).accepted);
  }
  await until(()=>cleanup.status().job.status==='done');assert.equal(cleanup.status().job.deleted,8);assert.equal(ids(f).length,5);
  assert.equal(f.store.payload(keep.id,'original','request').body.toString('base64'),keep.request);
  assert.equal(f.store.db.pragma('secure_delete',{simple:true}),1);assert.deepEqual(f.store.policy(),p);
});

test('worker crash keeps committed counters and resumes the same job without another user click', async t => {
  const f=fixture();for(let index=0;index<12;index++)f.store.ingest(event('crash-'+index));const p=select(f),service=new ConversationCleanupService(f.store);
  t.after(async()=>{await service.stop();f.close();});service.start();const job=service.request({policy_version:p.version}).job;
  await until(()=>service.status().job.deleted>=1&&service.ready);const child=service.child;child.kill('SIGKILL');
  await until(()=>service.status().job.status==='done',20000);assert.equal(service.status().job.id,job.id);assert.equal(service.status().job.deleted,12);assert.equal(ids(f).length,0);
});
