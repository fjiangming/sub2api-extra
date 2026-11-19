'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture,event } = require('./conversation-logs-fixture');
const { ConversationLogStore } = require('../src/conversation-log-store');
const { ConversationRepairStore } = require('../src/conversation-repair-store');
const { ConversationRepairService } = require('../src/services/conversation-repair-service');
const { ConversationArchiveService } = require('../src/services/conversation-archive-service');
const { ConversationPushStore } = require('../src/conversation-push-store');
const { AuthService } = require('../src/auth');
const { createApp } = require('../src/app');
const { REDACTION_VERSION } = require('../src/services/conversation-sensitive');

const terminal = 'data: {"type":"response.completed","response":{"id":"resp_demo","object":"response","status":"completed","output":[]}}\n\n';
const b64 = value => Buffer.from(value).toString('base64');
function old(f,seed,extra = {}) {
  const row = event(seed,{protocol:'SSE',reason:'read_error',complete:false,response:b64(terminal),policy_version:f.store.policy().version,...extra});
  assert(f.store.ingest(row).accepted);
  f.store.db.prepare("UPDATE cl_records SET redaction_version=3,completion_version=0,completion_source='',upstream_status='unknown',upstream_evidence='',archived_at=0 WHERE id=?").run(row.id);
  return row;
}
function finish(store) { for (let i=0;i<100 && store.pending();i++) store.step(); assert.equal(store.pending(),null); }
function snapshot(f,id) { return f.store.db.prepare('SELECT original,masked,complete,reason,processed_at FROM cl_records WHERE id=?').get(id); }
async function until(check,ms = 20000) {
  const end = Date.now() + ms;
  while (!check()) { assert(Date.now() < end,'Timed out waiting for history repair'); await new Promise(resolve => setTimeout(resolve,25)); }
}

test('history repair is explicit, bounded, idempotent and keeps original transport and ciphertext', t => {
  const f = fixture();t.after(() => f.close()); const store = new ConversationRepairStore(f.store).initialize();
  const normal = old(f,'history-normal'), encrypted = old(f,'history-encrypted',{request:b64(JSON.stringify({model:'gpt-6.1-sol',input:[{type:'reasoning',encrypted_content:'gAAAAAB_fictional-ciphertext_1234567890==',summary:[{type:'summary_text',text:'alice@example.com'}]}]}))});
  f.store.db.prepare("UPDATE cl_records SET masked=NULL,processing_error='UNINSPECTABLE_CONTENT' WHERE id=?").run(encrypted.id);
  const before = snapshot(f,encrypted.id);assert.equal(store.pending(),null);
  const p = f.store.policy(),job = store.request({policy_version:p.version});assert.equal(store.request({policy_version:p.version}).id,job.id);
  const fresh = event('after-history-boundary');f.store.ingest(fresh);const freshBefore = snapshot(f,fresh.id);
  finish(store);const saved = f.store.detail(encrypted.id);
  assert.equal(saved.processing_error,''); assert(saved.original && saved.masked);assert.deepEqual(saved.inspection_warnings,['OPAQUE_ENCRYPTED_REASONING']);
  assert.equal(saved.upstream_status,'completed'); assert(!saved.complete);assert.equal(saved.reason,'read_error');
  assert.deepEqual(snapshot(f,encrypted.id).original,before.original);assert.equal(f.store.payload(encrypted.id,'original','request').body.toString('base64'),encrypted.request);
  assert.equal(store.latest().repaired,2);assert.equal(store.latest().analyzed,2);assert.equal(store.latest().warnings,1);
  assert.deepEqual(snapshot(f,fresh.id),freshBefore);assert.equal(f.store.detail(normal.id).upstream_status,'completed');
  const push = new ConversationPushStore(f.store).initialize();assert(!push.copyReady(push.metadata(encrypted.id),'original',p));
  store.request({policy_version:p.version});finish(store);assert.equal(store.latest().repaired,0);
});

test('masked-only history can be analyzed independently without inventing an original or changing the body', t => {
  const f = fixture();t.after(() => f.close());f.store.configure({...f.store.policy(),mode:'masked'});
  const row = old(f,'masked-analysis'),before = snapshot(f,row.id),store = new ConversationRepairStore(f.store).initialize();
  assert.equal(before.original,null);store.request({policy_version:f.store.policy().version});finish(store);
  const saved = f.store.detail(row.id);assert.equal(saved.upstream_status,'completed');assert.equal(saved.completion_source,'masked');assert(!saved.complete);assert(!saved.original);
  assert.deepEqual(snapshot(f,row.id),before);assert.equal(store.latest().analyzed,1);assert.equal(store.latest().repaired,0);
});

test('explicit history checks repair old image failures without changing media, capture errors or fresh records', t => {
  const f = fixture();t.after(() => f.close());f.store.configure({...f.store.policy(),mode:'masked'});
  const image = 'data:image/png;base64,aGVsbG8=',request = b64(JSON.stringify({model:'gpt-6.1-sol',input:[{role:'user',content:[
    {type:'input_text',text:'alice@example.com'},{type:'input_image',image_url:image}]}]}));
  const row = old(f,'history-image',{request});
  f.store.db.prepare("UPDATE cl_records SET masked=NULL,processing_error='UNINSPECTABLE_CONTENT',redaction_version=0,inspection_warnings='[]' WHERE id=?").run(row.id);
  const before = snapshot(f,row.id),store = new ConversationRepairStore(f.store).initialize();assert.equal(store.pending(),null);
  assert.equal(f.store.detail(row.id).processing_error,'UNINSPECTABLE_CONTENT');
  store.request({policy_version:f.store.policy().version});const fresh = event('fresh-image',{request});assert(f.store.ingest(fresh).accepted);
  const freshBefore = snapshot(f,fresh.id);finish(store);const saved = f.store.detail(row.id);
  assert.equal(saved.processing_error,'');assert.deepEqual(saved.inspection_warnings,['OPAQUE_IMAGE']);assert(saved.original && saved.masked);
  assert(!saved.complete);assert.equal(saved.reason,'read_error');assert.equal(saved.upstream_status,'completed');
  assert.deepEqual(snapshot(f,row.id).original,before.original);assert.deepEqual(snapshot(f,fresh.id),freshBefore);
  assert.equal(JSON.parse(f.store.payload(row.id,'masked','request').text).input[0].content[1].image_url,image);
  assert(!f.store.payload(row.id,'masked','request').text.includes('alice@example.com'));
  assert.equal(store.latest().repaired,1);assert.equal(store.latest().warnings,1);
});

test('history explicitly upgrades old completion evidence for SSE recorded as JSON while preserving all transport and body fields', t => {
  const f = fixture();t.after(() => f.close());
  const row = event('json-labelled-sse',{protocol:'JSON',complete:false,reason:'read_error',response:b64(terminal)});assert(f.store.ingest(row).accepted);
  f.store.db.prepare("UPDATE cl_records SET completion_version=1,upstream_status='unverified',upstream_evidence='invalid_format' WHERE id=?").run(row.id);
  const before = snapshot(f,row.id),store = new ConversationRepairStore(f.store).initialize();assert.equal(store.pending(),null);
  store.request({policy_version:f.store.policy().version});finish(store);const saved = f.store.detail(row.id);
  assert.equal(saved.upstream_status,'completed');assert.equal(saved.upstream_evidence,'response.completed');assert.equal(saved.completion_version,2);
  assert.equal(saved.protocol,'JSON');assert(!saved.complete);assert.equal(saved.reason,'read_error');assert.deepEqual(snapshot(f,row.id),before);
  assert.equal(store.latest().analyzed,1);assert.equal(store.latest().repaired,0);
  const push = new ConversationPushStore(f.store).initialize();assert(!push.copyReady(push.metadata(row.id),'original',f.store.policy()));
});

test('explicit background repair recognizes compaction while keeping raw bytes and the original read error', t => {
  const f = fixture();t.after(() => f.close());f.store.configure({...f.store.policy(),mode:'masked'});
  const encrypted = 'gAAAAAB_fictional-compaction_1234567890==',item = {type:'compaction',id:'cmp_12345678901234567890',encrypted_content:encrypted};
  const request = b64(JSON.stringify({model:'gpt-6.1-sol',input:[item,{role:'user',content:'alice@example.com'}]}));
  const row = old(f,'history-compaction',{request});
  f.store.db.prepare("UPDATE cl_records SET masked=NULL,processing_error='UNINSPECTABLE_CONTENT',redaction_version=0,inspection_warnings='[]' WHERE id=?").run(row.id);
  const before = snapshot(f,row.id),store = new ConversationRepairStore(f.store).initialize();assert.equal(store.pending(),null);
  store.request({policy_version:f.store.policy().version});finish(store);
  const saved = f.store.detail(row.id);assert.equal(saved.processing_error,'');assert.equal(saved.redaction_version,REDACTION_VERSION);
  assert.deepEqual(saved.inspection_warnings,['OPAQUE_ENCRYPTED_COMPACTION']);assert(saved.original && saved.masked);
  assert(!saved.complete);assert.equal(saved.reason,'read_error');assert.equal(saved.upstream_status,'completed');
  assert.deepEqual(snapshot(f,row.id).original,before.original);assert.equal(f.store.payload(row.id,'original','request').body.toString('base64'),request);
  const masked = JSON.parse(f.store.payload(row.id,'masked','request').text);assert.deepEqual(masked.input[0],item);assert.match(masked.input[1].content,/^<EMAIL_/);
  assert.equal(store.latest().repaired,1);assert.equal(store.latest().warnings,1);
  store.request({policy_version:f.store.policy().version});finish(store);assert.equal(store.latest().repaired,0);
});

test('excluded users, unselected models, expired logs and missing historical bodies never enter decryption', t => {
  let now = Date.now(); const f = fixture({now:() => now});t.after(() => f.close());
  old(f,'excluded-user',{user_id:3});old(f,'excluded-model',{model:'other-model'});old(f,'expired');old(f,'missing');
  f.store.db.prepare("UPDATE cl_records SET original=NULL,masked=NULL WHERE id=?").run(event('missing').id);
  now += 2 * 86400000;
  const p = f.store.configure({...f.store.policy(),excludedUserIds:[3],modelFilterEnabled:true,allowedModels:['example-model'],kimiK3Plus:false,retention:1});
  const store = new ConversationRepairStore(f.store,{now:() => now}).initialize();store.request({policy_version:p.version});
  const original = f.store.open.bind(f.store);f.store.open = (value,aad) => { assert(aad.startsWith('policy:'));return original(value,aad); };
  finish(store);assert.equal(store.latest().skipped,4);assert.equal(store.latest().analyzed,0);
});

test('policy changes pause history and cancellation during processing prevents all body and completion writes', t => {
  const f = fixture();t.after(() => f.close());const row = old(f,'cancel-during-processing'),store = new ConversationRepairStore(f.store).initialize();
  const job = store.request({policy_version:f.store.policy().version}),before = snapshot(f,row.id);
  f.store.processingLimits = () => {store.cancel(job.id);return {};};store.step();
  assert.equal(store.latest().status,'cancelled');assert.equal(store.latest().scanned,0);assert.deepEqual(snapshot(f,row.id),before);assert.equal(f.store.detail(row.id).completion_version,0);
  f.store.processingLimits = () => ({});store.request({policy_version:f.store.policy().version});
  f.store.configure({...f.store.policy(),excludedUserIds:[2]});store.step();assert.equal(store.latest().status,'paused');assert.equal(store.latest().error_code,'POLICY_CHANGED');
  assert.deepEqual(snapshot(f,row.id),before);
});

test('history rechecks late exclusions outside the expensive processing write lock', t => {
  const f = fixture(),other = new ConversationLogStore(f.directory).initialize();t.after(() => {other.close();f.close();});
  const row = old(f,'late-history-exclusion'),before = snapshot(f,row.id),store = new ConversationRepairStore(f.store).initialize();store.request({policy_version:f.store.policy().version});
  f.store.processingLimits = () => {other.configure({...other.policy(),excludedUserIds:[2]});return {};};store.step();store.step();
  assert.equal(store.latest().status,'paused');assert.deepEqual(snapshot(f,row.id),before);assert.equal(f.store.detail(row.id).completion_version,0);
});

test('memory and capacity pressure defer whole records, preserve copies and allow a later bounded pass', t => {
  const f = fixture();t.after(() => f.close());const row = old(f,'history-pressure'),before = snapshot(f,row.id);
  const store = new ConversationRepairStore(f.store,{memoryBudget:() => 0}).initialize();store.request({policy_version:f.store.policy().version});finish(store);
  assert.equal(store.latest().deferred,1);assert.deepEqual(snapshot(f,row.id),before);
  store.memoryBudget = () => Infinity;store.request({policy_version:f.store.policy().version});
  const free = f.store.freeBytes;f.store.freeBytes = () => 0;finish(store);assert.equal(store.latest().deferred,1);assert.deepEqual(snapshot(f,row.id),before);
  f.store.freeBytes = free;store.request({policy_version:f.store.policy().version});finish(store);assert.equal(store.latest().repaired,1);
  assert.deepEqual(snapshot(f,row.id).original,before.original);assert.equal(f.store.detail(row.id).upstream_status,'completed');
  const g = fixture();t.after(() => g.close());g.store.configure({...g.store.policy(),mode:'masked'});
  const single = old(g,'analysis-space-pressure'),singleBefore = snapshot(g,single.id),analysis = new ConversationRepairStore(g.store).initialize();
  analysis.request({policy_version:g.store.policy().version});
  g.store.processingLimits = () => {g.store.freeBytes = () => 0;return {};};finish(analysis);
  assert.equal(analysis.latest().deferred,1);assert.equal(g.store.detail(single.id).completion_version,0);assert.deepEqual(snapshot(g,single.id),singleBefore);
});

test('bounded crash attempts, persistent cursors and reused SQLite rowids cannot pull fresh records into the old task', t => {
  const f = fixture();t.after(() => f.close());const a = old(f,'attempt-a'),b = old(f,'attempt-b');
  const store = new ConversationRepairStore(f.store).initialize();const job = store.request({policy_version:f.store.policy().version});
  const cursor = f.store.db.prepare('SELECT rowid n FROM cl_records WHERE id=?').get(a.id).n;
  f.store.db.prepare('UPDATE cl_repairs SET current_rowid=?,attempts=3 WHERE id=?').run(cursor,job.id);
  store.step();assert.equal(store.latest().deferred,1);assert.equal(f.store.detail(a.id).redaction_version,3);
  f.store.db.prepare('DELETE FROM cl_records WHERE id=?').run(b.id);
  f.store.ingest(event('reused-new'));f.store.db.prepare('UPDATE cl_records SET archived_at=? WHERE id=?').run(job.requested_at,event('reused-new').id);
  const reopened = new ConversationRepairStore(f.store).initialize();finish(reopened);assert.equal(reopened.latest().scanned,2);assert.equal(reopened.latest().skipped,1);
  assert.equal(f.store.detail(event('reused-new').id).redaction_version,REDACTION_VERSION);
});

test('administrator authentication, CSRF and current-policy validation protect history endpoints', async t => {
  const f = fixture(),auth = new AuthService(f.config),service = new ConversationRepairService(f.store,{canWork:() => false});
  t.after(async () => {await service.stop();auth.close();f.close();});
  const app = createApp({config:f.config,database:{},auth,conversations:f.store,conversationRepair:service,messages:f.messages});
  const server = app.listen(0,'127.0.0.1');await new Promise(resolve => server.once('listening',resolve));t.after(() => new Promise(resolve => {server.close(resolve);server.closeAllConnections();}));
  const base = 'http://127.0.0.1:' + server.address().port,path = base + '/api/conversation-logs/history-repair',body = JSON.stringify({policy_version:f.store.policy().version});
  assert.equal((await fetch(path)).status,401);assert.equal((await fetch(path,{headers:{authorization:'Bearer ' + f.token}})).status,401);
  const session = await (await fetch(base + '/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password:f.config.adminPassword})})).json();
  const headers = {authorization:'Session ' + session.sessionToken,'content-type':'application/json'};
  assert.equal((await fetch(path,{method:'POST',headers,body})).status,403);headers['x-csrf-token'] = session.csrfToken;
  assert.equal((await fetch(path,{method:'POST',headers,body:JSON.stringify({policy_version:999})})).status,409);
  const response = await fetch(path,{method:'POST',headers,body});assert.equal(response.status,202);const job = (await response.json()).job;
  assert.equal((await fetch(path + '/' + job.id + '/cancel',{method:'POST',headers:{authorization:headers.authorization},body:'{}'})).status,403);
  assert.equal((await fetch(path + '/' + job.id + '/cancel',{method:'POST',headers,body:'{}'})).status,200);
});

test('isolated history worker yields to live archiving and resumes committed progress after a crash', async t => {
  const f = fixture();for (let i=0;i<10;i++) old(f,'worker-history-' + i);
  let permit = false;const archive = new ConversationArchiveService(f.store),service = new ConversationRepairService(f.store,{canWork:() => permit && !archive.busy,intervalMs:30});
  const auth = new AuthService(f.config);t.after(async () => {await service.stop();await archive.stop();auth.close();f.close();});await archive.start();service.start();
  const app = createApp({config:f.config,database:{},auth,conversations:f.store,conversationArchive:archive,conversationRepair:service,messages:f.messages});
  const server = app.listen(0,'127.0.0.1');await new Promise(resolve => server.once('listening',resolve));t.after(() => new Promise(resolve => {server.close(resolve);server.closeAllConnections();}));
  const base = 'http://127.0.0.1:' + server.address().port,job = service.request({policy_version:f.store.policy().version}).job;
  assert.equal(service.child,null);assert.equal(service.status().job.scanned,0);
  permit = true;service.wake();await until(() => service.status().job.scanned >= 1);assert.notEqual(service.child.pid,process.pid);permit = false;const oldChild = service.child;oldChild.kill('SIGKILL');
  await until(() => service.child === null);assert.equal(service.status().job.id,job.id);assert(service.status().job.scanned >= 1);
  for (let i=0;i<3;i++) {
    const start = performance.now();assert.equal((await fetch(base + '/healthz',{signal:AbortSignal.timeout(2000)})).status,200);assert(performance.now() - start < 1000);
    const response = await fetch(base + '/api/conversation-logs/ingest',{method:'POST',headers:{authorization:'Bearer ' + f.token,'content-type':'application/json'},body:JSON.stringify(event('concurrent-history-' + i)),signal:AbortSignal.timeout(3000)});
    assert.equal(response.status,200);assert((await response.json()).accepted);
  }
  permit = true;service.wake();await until(() => service.status().job.status === 'done');assert.equal(service.status().job.scanned,10);assert.equal(service.status().job.repaired,10);
  assert.equal(f.store.status().records,13);assert.equal(f.store.db.pragma('secure_delete',{simple:true}),1);
});
