'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture,event } = require('./conversation-logs-fixture');
const { ConversationLogStore } = require('../src/conversation-log-store');
const { ConversationRepairStore } = require('../src/conversation-repair-store');
const { ConversationRepairService } = require('../src/services/conversation-repair-service');
const { AuthService } = require('../src/auth');
const { createApp } = require('../src/app');
const { REDACTION_VERSION } = require('../src/services/conversation-sensitive');

const b64 = value => Buffer.from(value).toString('base64');
const snapshot = (f,id) => f.store.db.prepare('SELECT original,masked,processed_at,redaction_version,complete,reason FROM cl_records WHERE id=?').get(id);
function add(f,seed,extra = {}) {const row = event(seed,{policy_version:f.store.policy().version,...extra});assert(f.store.ingest(row).accepted);return row;}
function finish(store) {for (let i=0;i<100 && store.pending();i++) store.step();assert.equal(store.pending(),null);return store.latest('redaction');}
function request(f,store) {return store.request({policy_version:f.store.policy().version},'redaction');}
async function until(check) {const end = Date.now() + 20000;while (!check()) {assert(Date.now() < end,'History redaction did not settle');await new Promise(resolve => setTimeout(resolve,25));}}

test('explicit history redaction rebuilds even current copies from the original, not from a damaged masked copy', t => {
  const f = fixture();t.after(() => f.close());const store = new ConversationRepairStore(f.store).initialize();
  const requestText = JSON.stringify({model:'claude-opus-5-5',tools:[{name:'Read',input_schema:{type:'object'}}],messages:[{role:'assistant',content:[{type:'tool_use',id:'toolu_demo',name:'Read',input:{path:'/file'}}]}],content:'Read; alice@example.com; 2026-11-19'});
  const row = add(f,'current-force',{request:b64(requestText)}),before = snapshot(f,row.id);
  f.store.db.prepare('UPDATE cl_records SET masked=? WHERE id=?').run(f.store.seal(Buffer.from('broken-old-copy'),row.id + ':masked'),row.id);
  assert(!f.store.detail(row.id).retry_available);
  const job = request(f,store);assert.equal(request(f,store).id,job.id);
  assert.throws(() => store.request({policy_version:f.store.policy().version}),error => error.code === 'CONVERSATION_REPAIR_ACTIVE');
  const fresh = add(f,'new-after-redaction'),freshBefore = snapshot(f,fresh.id);
  const done = finish(new ConversationRepairStore(f.store).initialize());
  assert.equal(done.repaired,1);assert.equal(done.scanned,1);assert.equal(done.scope,'redaction');
  const saved = snapshot(f,row.id);assert.deepEqual(saved.original,before.original);assert(saved.processed_at > before.processed_at);
  assert.equal(saved.redaction_version,REDACTION_VERSION);assert.equal(saved.complete,before.complete);assert.equal(saved.reason,before.reason);
  const body = f.store.payload(row.id,'masked','request').text;assert(body.includes('Read;'));assert(body.includes('2026-11-19'));assert(!body.includes('alice@example.com'));
  assert.equal(JSON.parse(body).tools[0].name,'Read');assert.deepEqual(snapshot(f,fresh.id),freshBefore);
});

test('history redaction reports missing originals, original-only mode, warnings and failures without fabricating source data', t => {
  const f = fixture();t.after(() => f.close());const store = new ConversationRepairStore(f.store).initialize();
  f.store.configure({...f.store.policy(),mode:'masked'});const missing = add(f,'missing-original'),missingBefore = snapshot(f,missing.id);
  const warning = add(f,'opaque-history',{request:b64(JSON.stringify({model:'claude-opus-5-5',messages:[{role:'assistant',content:[{type:'thinking',thinking:'alice@example.com',signature:'ZmljdGlvbmFsX3NpZ25hdHVyZQ=='}]}]}))});
  const invalid = add(f,'invalid-history',{request:b64('{"content":"-----BEGIN PRIVATE KEY-----\\nunfinished"}')});
  f.store.configure({...f.store.policy(),mode:'original'});const original = add(f,'only-original'),originalBefore = snapshot(f,original.id);
  f.store.configure({...f.store.policy(),mode:'dual'});request(f,store);const done = finish(store);
  assert.equal(done.missing_original,1);assert.equal(done.original_only,1);assert.equal(done.warnings,1);assert.equal(done.errors,1);assert.equal(done.repaired,1);
  assert.deepEqual(snapshot(f,missing.id),missingBefore);assert.deepEqual(snapshot(f,original.id),originalBefore);
  assert(f.store.detail(warning.id).original);assert.equal(f.store.detail(invalid.id).processing_error,'INCOMPLETE_PRIVATE_KEY');assert(f.store.detail(invalid.id).original);
});

test('excluded users, unselected models, expired records and processing-pending rows are never decrypted', t => {
  const f = fixture();t.after(() => f.close());const store = new ConversationRepairStore(f.store).initialize();
  const excluded = add(f,'excluded',{user_id:3}),model = add(f,'model',{model:'other'}),expired = add(f,'expired',{at:Date.now() - 3 * 86400000}),pending = add(f,'pending');
  f.store.db.prepare('UPDATE cl_records SET processing_pending=1 WHERE id=?').run(pending.id);
  f.store.configure({...f.store.policy(),excludedUserIds:[3],modelFilterEnabled:true,allowedModels:['example-model'],kimiK3Plus:false,retention:1});
  const before = [excluded,model,expired,pending].map(row => snapshot(f,row.id));
  request(f,store);const open = f.store.open;f.store.open = function(value,aad) {if (/(?:original|masked)$/.test(aad)) throw new Error('must not decrypt excluded history');return open.call(this,value,aad);};
  const done = finish(store);f.store.open = open;assert.equal(done.skipped,4);assert.equal(done.errors,0);
  assert.deepEqual([excluded,model,expired,pending].map(row => snapshot(f,row.id)),before);
});

test('resource pressure and bounded crash attempts preserve bodies; another click can retry deferred records', t => {
  const f = fixture();t.after(() => f.close());const row = add(f,'defer-redaction'),before = snapshot(f,row.id);
  const store = new ConversationRepairStore(f.store,{memoryBudget:() => 0}).initialize();request(f,store);assert.equal(finish(store).deferred,1);assert.deepEqual(snapshot(f,row.id),before);
  store.memoryBudget = () => Infinity;request(f,store);const free = f.store.freeBytes;f.store.freeBytes = () => 0;
  assert.equal(finish(store).deferred,1);assert.deepEqual(snapshot(f,row.id),before);f.store.freeBytes = free;
  const job = request(f,store),cursor = f.store.db.prepare('SELECT rowid n FROM cl_records WHERE id=?').get(row.id).n;
  f.store.db.prepare('UPDATE cl_repairs SET current_rowid=?,attempts=3 WHERE id=?').run(cursor,job.id);assert.equal(finish(store).deferred,1);assert.deepEqual(snapshot(f,row.id),before);
  request(f,store);assert.equal(finish(store).repaired,1);
});

test('cancellation and policy/algorithm changes never commit a replacement under a stale task', t => {
  const f = fixture();t.after(() => f.close());const row = add(f,'redaction-race'),before = snapshot(f,row.id),store = new ConversationRepairStore(f.store).initialize();
  const job = request(f,store);f.store.processingLimits = () => {store.cancel(job.id,'redaction');return {};};store.step();
  assert.equal(store.latest().status,'cancelled');assert.deepEqual(snapshot(f,row.id),before);
  f.store.processingLimits = () => ({});request(f,store);f.store.configure({...f.store.policy(),phone:false});store.step();assert.equal(store.latest().error_code,'POLICY_CHANGED');
  request(f,store);f.store.db.prepare("UPDATE cl_repairs SET redaction_hash='old-engine' WHERE status='pending'").run();store.step();assert.equal(store.latest().error_code,'ALGORITHM_CHANGED');assert.deepEqual(snapshot(f,row.id),before);
});

test('monotonic history boundary protects arrivals even when rowids and wall clock are reused', t => {
  const f = fixture();t.after(() => f.close());const store = new ConversationRepairStore(f.store,{now:() => 100000}).initialize();
  const old = add(f,'reused-id');request(f,store);f.store.db.prepare('DELETE FROM cl_records WHERE id=?').run(old.id);
  const fresh = add(f,'fresh-reused-rowid');f.store.db.prepare('UPDATE cl_records SET archived_at=0 WHERE id=?').run(fresh.id);const before = snapshot(f,fresh.id);
  assert.equal(finish(store).skipped,1);assert.deepEqual(snapshot(f,fresh.id),before);
});

test('legacy pending history jobs migrate as compatibility checks without decoding bodies at startup', t => {
  const f = fixture();t.after(() => f.close());const row = add(f,'legacy-repair-migration'),before = snapshot(f,row.id);
  const store = new ConversationRepairStore(f.store).initialize();store.request({policy_version:f.store.policy().version});
  for (const column of ['scope','redaction_hash','missing_original','original_only','upper_arrival','boundary_version']) f.store.db.exec('ALTER TABLE cl_repairs DROP COLUMN ' + column);
  const open = f.store.open;f.store.open = () => {throw new Error('migration must not decode');};
  const reopened = new ConversationRepairStore(f.store).initialize();f.store.open = open;
  assert.equal(reopened.pending().scope,'compatibility');assert.equal(reopened.pending().boundary_version,0);assert.equal(reopened.pending().redaction_hash,'');
  assert.deepEqual(snapshot(f,row.id),before);reopened.cancel(reopened.pending().id,'compatibility');request(f,reopened);assert.equal(finish(reopened).repaired,1);
});

test('a record deleted and re-ingested during processing cannot be overwritten even when its ID and processed time match', t => {
  const f = fixture();t.after(() => f.close());const row = add(f,'reinsert-during-mask'),before = snapshot(f,row.id),store = new ConversationRepairStore(f.store).initialize();
  request(f,store);let fresh;
  f.store.processingLimits = () => {
    f.store.processingLimits = () => ({});f.store.db.prepare('DELETE FROM cl_records WHERE id=?').run(row.id);assert(f.store.ingest(row).accepted);
    f.store.db.prepare('UPDATE cl_records SET processed_at=? WHERE id=?').run(before.processed_at,row.id);fresh = snapshot(f,row.id);return {};
  };
  store.step();assert.equal(store.latest('redaction').skipped,1);assert.deepEqual(snapshot(f,row.id),fresh);assert.equal(store.latest('redaction').repaired,0);
});

test('low-memory startup defers the worker without discarding the persistent task', async t => {
  const f = fixture(),service = new ConversationRepairService(f.store,{memoryBudgetBytes:0});t.after(async () => {await service.stop();f.close();});
  service.request({policy_version:f.store.policy().version},'redaction');assert.equal(service.child,null);assert.equal(service.status('redaction').job.status,'pending');
});

test('saving policy while a background writer competes cannot fail by upgrading a stale read transaction', t => {
  const f = fixture(),other = new ConversationLogStore(f.directory).initialize();t.after(() => {other.close();f.close();});
  const store = new ConversationRepairStore(f.store).initialize();request(f,store);other.db.pragma('busy_timeout = 1');
  const policy = f.store.policy(),readPolicy = f.store.policy;let blocked = false;
  f.store.policy = function(...args) {
    const current = readPolicy.apply(this,args);
    try {other.db.prepare('UPDATE cl_repairs SET updated_at=updated_at+1').run();} catch (error) {if (!/^SQLITE_(?:BUSY|LOCKED)/.test(error.code || '')) throw error;blocked = true;}
    return current;
  };
  const saved = f.store.configure({...policy,phone:false});f.store.policy = readPolicy;
  assert(blocked);assert.equal(saved.version,policy.version + 1);store.step();assert.equal(store.latest('redaction').error_code,'POLICY_CHANGED');
});

test('history APIs isolate tasks by scope and require administrator authentication, CSRF and saved policy', async t => {
  const f = fixture(),auth = new AuthService(f.config),service = new ConversationRepairService(f.store,{canWork:() => false});
  t.after(async () => {await service.stop();auth.close();f.close();});
  const app = createApp({config:f.config,database:{},auth,conversations:f.store,conversationRepair:service,messages:f.messages});
  const server = app.listen(0,'127.0.0.1');await new Promise(resolve => server.once('listening',resolve));t.after(() => new Promise(resolve => {server.close(resolve);server.closeAllConnections();}));
  const base = 'http://127.0.0.1:' + server.address().port,path = base + '/api/conversation-logs/history-redaction';
  assert.equal((await fetch(path)).status,401);assert.equal((await fetch(path,{headers:{authorization:'Bearer ' + f.token}})).status,401);
  const session = await (await fetch(base + '/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password:f.config.adminPassword})})).json();
  const headers = {authorization:'Session ' + session.sessionToken,'content-type':'application/json'},body = JSON.stringify({policy_version:f.store.policy().version});
  assert.equal((await fetch(path,{method:'POST',headers,body})).status,403);headers['x-csrf-token'] = session.csrfToken;
  assert.equal((await fetch(path,{method:'POST',headers,body:JSON.stringify({policy_version:999})})).status,409);
  assert.equal((await fetch(path,{method:'POST',headers,body:JSON.stringify({policy_version:f.store.policy().version,force:true})})).status,400);
  const response = await fetch(path,{method:'POST',headers,body});assert.equal(response.status,202);const job = (await response.json()).job;assert.equal(job.scope,'redaction');assert.equal(service.child,null);
  const other = base + '/api/conversation-logs/history-repair';const otherStatus = await (await fetch(other,{headers})).json();assert.equal(otherStatus.job,null);assert.equal(otherStatus.activeScope,'redaction');
  assert.equal((await fetch(other,{method:'POST',headers,body})).status,409);
  await fetch(other + '/' + job.id + '/cancel',{method:'POST',headers,body:'{}'});assert.equal(service.store.pending().id,job.id);
  assert.equal((await fetch(path + '/' + job.id + '/cancel',{method:'POST',headers:{authorization:headers.authorization},body:'{}'})).status,403);
  assert.equal((await fetch(path + '/' + job.id + '/cancel',{method:'POST',headers,body:'{}'})).status,200);assert.equal(service.store.latest().status,'cancelled');
});

test('isolated redaction worker resumes persisted progress across restart and leaves room for new archiving', async t => {
  const f = fixture();for (let i=0;i<5;i++) add(f,'redaction-worker-' + i);
  let permit = false;const service = new ConversationRepairService(f.store,{canWork:() => permit,intervalMs:50});
  t.after(async () => {await service.stop();f.close();});service.start();const job = service.request({policy_version:f.store.policy().version},'redaction').job;
  assert.equal(service.child,null);permit = true;service.wake();await until(() => service.status('redaction').job.scanned >= 1);permit = false;
  const oldChild = service.child;oldChild.kill('SIGKILL');await until(() => !service.child);const progress = service.status('redaction').job.scanned;
  const fresh = add(f,'live-during-redaction'),before = snapshot(f,fresh.id);assert.equal(service.status('redaction').job.id,job.id);
  permit = true;service.wake();await until(() => service.status('redaction').job.status === 'done');
  const done = service.status('redaction').job;assert(done.scanned >= progress);assert.equal(done.repaired,5);assert.equal(done.scanned,5);assert.deepEqual(snapshot(f,fresh.id),before);
});
