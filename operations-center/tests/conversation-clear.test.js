'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const { fixture,event } = require('./conversation-logs-fixture');
const { ConversationLogStore } = require('../src/conversation-log-store');
const { ConversationCleanupStore } = require('../src/conversation-cleanup-store');
const { ConversationCleanupService } = require('../src/services/conversation-cleanup-service');
const { ConversationArchiveService } = require('../src/services/conversation-archive-service');
const { ConversationPushStore } = require('../src/conversation-push-store');
const { ConversationPushService } = require('../src/services/conversation-push-service');
const { AuthService } = require('../src/auth');
const { createApp } = require('../src/app');

const request = () => ({request_id:crypto.randomUUID(),confirm:'clear-all-history'});
const ids = f => f.store.db.prepare('SELECT id FROM cl_records ORDER BY id').all().map(row => row.id);
function finish(store) { for (let index = 0; index < 200 && store.pending(); index++) store.step(); assert.equal(store.pending(),null); }
async function until(check,timeout = 18000) {
  const end = Date.now() + timeout;
  while (!check()) { assert(Date.now() < end,'History clear did not settle'); await new Promise(resolve => setTimeout(resolve,30)); }
}

function capacityFixture(t) {
  const gib = 1024 ** 3, mib = 1024 ** 2, space = { free: 100 * gib, wal: 0 };
  const f = fixture({ freeBytes: () => space.free }); t.after(() => f.close());
  const policy = f.store.configure({ ...f.store.policy(), mode: 'original', capacity: 1 });
  const cleanup = new ConversationCleanupStore(f.store).initialize();
  assert(f.store.ingest(event('capacity-old', { policy_version: policy.version,
    request: Buffer.from(JSON.stringify({ input: 'x'.repeat(4 * mib) })).toString('base64') })).accepted);
  f.store.db.pragma('wal_checkpoint(TRUNCATE)');
  const stat = fs.statSync, padding = gib + 2 * mib - stat(f.store.file).size;
  const pragma = f.store.db.pragma, pageSize = pragma.call(f.store.db, 'page_size', { simple: true });
  // Scale occupied pages and file size together; freed pages still come from a real archive and clear job.
  t.mock.method(f.store.db, 'pragma', function (sql, ...options) {
    const value = pragma.call(this, sql, ...options);
    return sql === 'page_count' ? value + padding / pageSize : value;
  });
  t.mock.method(fs, 'statSync', (file, ...options) => {
    const value = stat(file, ...options);
    if (file === f.store.file) return { ...value, size: value.size + padding };
    if (file === f.store.file + '-wal') return { ...value, size: value.size + space.wal };
    return value;
  });
  assert.equal(f.store.collectorPolicy().enabled, false);
  f.store.db.pragma('secure_delete=OFF');
  cleanup.requestAll(request()); finish(cleanup);
  assert.equal(f.store.list().summary.total, 0);
  return { f, space, policy, gib, mib };
}

test('clearing an archive restores reception without shrinking its physical file or raising capacity', t => {
  const { f, policy, gib, mib } = capacityFixture(t);
  const status = f.store.status();
  assert(status.diskBytes > gib); assert(status.storage.reusableBytes > 4 * mib);
  assert(status.storage.quotaBytes + mib < gib); assert.equal(status.storage.pauseReason, '');
  assert.equal(f.store.collectorPolicy().enabled, true); assert.equal(f.store.lastError, null);
  assert.deepEqual(f.store.policy(), policy);
  const fresh = event('capacity-new', { policy_version: policy.version });
  assert(f.store.receive(fresh).accepted); assert(f.store.processPending(fresh.id));
  assert.equal(f.store.payload(fresh.id, 'original', 'request').body.toString('base64'), fresh.request);
  assert.equal(f.store.payload(fresh.id, 'original', 'response').body.toString('base64'), fresh.response);
  assert.equal(f.store.status().records, 1);
});

test('reusable pages never bypass WAL accounting or the actual free-disk reserve', t => {
  const { f, space, policy, gib } = capacityFixture(t);
  space.wal = gib;
  assert.equal(f.store.collectorPolicy().enabled, false);
  assert.equal(f.store.status().storage.pauseReason, 'capacity');
  assert.deepEqual(f.store.receive(event('wal-full', { policy_version: policy.version })), { accepted: false, reason: 'capacity' });
  space.wal = 0; space.free = 0;
  assert.equal(f.store.collectorPolicy().enabled, false);
  assert.equal(f.store.status().storage.pauseReason, 'disk_reserve');
  assert.deepEqual(f.store.receive(event('disk-full', { policy_version: policy.version })), { accepted: false, reason: 'capacity' });
  assert.equal(f.store.status().records, 0);
  space.free = 100 * gib; assert.equal(f.store.collectorPolicy().enabled, true);
});

test('unavailable or invalid page statistics fall back to physical capacity and never admit an overfull archive', t => {
  const { f } = capacityFixture(t), pragma = f.store.db.pragma;
  let unavailable = true;
  t.mock.method(f.store.db, 'pragma', function (sql, ...options) {
    if (sql === 'freelist_count') {
      if (unavailable) throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' });
      return -1;
    }
    return pragma.call(this, sql, ...options);
  });
  for (const failure of [true, false]) {
    unavailable = failure;
    const usage = f.store.storageUsage();
    assert.equal(usage.accountingReady, false); assert.equal(usage.reusableBytes, 0);
    assert.equal(usage.quotaBytes, usage.physicalBytes);
    assert.equal(f.store.collectorPolicy().enabled, false);
  }
});

test('explicit history clear deletes every model, user, copy and derived index while preserving policies and new arrivals', t => {
  const f = fixture();t.after(() => f.close());
  for (const [index,mode] of ['dual','masked','original'].entries()) {
    const p = f.store.configure({...f.store.policy(),mode});
    f.store.ingest(event('all-' + index,{user_id:index + 2,model:index === 1 ? '' : 'model-' + index,policy_version:p.version}));
  }
  const missing = event('all-missing');f.store.ingest(missing);
  f.store.db.prepare('UPDATE cl_records SET original=NULL,masked=NULL WHERE id=?').run(missing.id);
  const p = f.store.configure({...f.store.policy(),enabled:false,retention:0,modelFilterEnabled:true,allowedModels:[],kimiK3Plus:false,excludedUserIds:[2,3,4]});
  const cleanup = new ConversationCleanupStore(f.store).initialize();assert.equal(cleanup.pending(),null);
  const job = cleanup.requestAll(request());assert.equal(job.scope,'all');assert.equal(ids(f).length,4);
  assert.equal(cleanup.step().deleted,1);
  const enabled = f.store.configure({...p,enabled:true,modelFilterEnabled:false,excludedUserIds:[]});
  const fresh = event('new-after-clear',{at:1,policy_version:enabled.version});assert(f.store.ingest(fresh).accepted);
  finish(cleanup);assert.equal(cleanup.latest().deleted,4);assert.deepEqual(ids(f),[fresh.id]);
  assert.deepEqual(f.store.policy(),enabled);assert.equal(f.store.payload(fresh.id,'original','request').body.toString('base64'),fresh.request);
  assert.equal(f.store.list({}).summary.total,1);assert.equal(f.store.sessions({}).items[0].attempts,1);
  assert.throws(() => f.store.detail(missing.id),{code:'CONVERSATION_NOT_FOUND'});
});

test('arrival boundary preserves reused rowids, backdated timestamps and same-clock new records', t => {
  const f = fixture({now:() => 5000});t.after(() => f.close());
  const old = ['boundary-1','boundary-2','boundary-3'].map(seed => event(seed,{at:5000}));old.forEach(row => assert(f.store.ingest(row).accepted));
  const cleanup = new ConversationCleanupStore(f.store).initialize();
  cleanup.requestAll(request());cleanup.step();
  // A concurrent expiry can remove the old highest row, allowing SQLite to reuse its rowid.
  f.store.db.prepare('DELETE FROM cl_records WHERE id=?').run(old[2].id);
  const fresh = event('reused-rowid',{at:1});assert(f.store.ingest(fresh).accepted);
  assert.equal(f.store.db.prepare('SELECT rowid n FROM cl_records WHERE id=?').get(fresh.id).n,3);
  finish(cleanup);assert.deepEqual(ids(f),[fresh.id]);assert.equal(cleanup.latest().deleted,2);
  assert.equal(f.store.db.prepare('PRAGMA foreign_key_check').all().length,0);
});

test('clear requests require a dedicated confirmation, stay idempotent after completion and never extend the cutoff', t => {
  const f = fixture();t.after(() => f.close());const cleanup = new ConversationCleanupStore(f.store).initialize();
  for (const invalid of [{},{policy_version:2},{...request(),confirm:false},{...request(),filter:{}},{...request(),request_id:'invalid'}]) {
    assert.throws(() => cleanup.requestAll(invalid),{code:'CONVERSATION_INVALID_INPUT'});
  }
  f.store.ingest(event('idempotent-old'));const input = request(),job = cleanup.requestAll(input);
  assert.equal(cleanup.requestAll(request()).id,job.id);finish(cleanup);
  const fresh = event('after-done');f.store.ingest(fresh);
  assert.equal(cleanup.requestAll(input).id,job.id);assert.equal(cleanup.pending(),null);assert.deepEqual(ids(f),[fresh.id]);
  cleanup.requestAll(request());finish(cleanup);assert.equal(ids(f).length,0);
  const empty = cleanup.requestAll(request());finish(cleanup);assert.equal(cleanup.latest().id,empty.id);assert.equal(cleanup.latest().deleted,0);
});

test('metadata scans stay bounded when concurrent expiry replaces the entire old range with new arrivals', t => {
  const f = fixture();t.after(() => f.close());
  const rows = Array.from({length:5},(_,index) => event('bounded-' + index));rows.forEach(row => assert(f.store.ingest(row).accepted));
  const cleanup = new ConversationCleanupStore(f.store).initialize();cleanup.requestAll(request());
  f.store.db.prepare('DELETE FROM cl_records WHERE rowid>1').run();
  for (let index = 0; index < 4; index++) assert(f.store.ingest(event('replacement-' + index)).accepted);
  // Deletion must never try to open body ciphertext, including an unreadable archived copy.
  f.store.db.prepare("UPDATE cl_records SET original=x'0102',masked=x'0304' WHERE rowid=1").run();
  assert.equal(cleanup.step({scanSize:2}).deleted,1);
  const skipped = cleanup.step({scanSize:2});assert.equal(skipped.deleted,0);assert.equal(skipped.scanned,2);assert.equal(cleanup.pending().cursor_rowid,3);
  finish(cleanup);assert.equal(ids(f).length,4);assert.equal(cleanup.latest().deleted,1);
});

test('model cleanup and full history clear exclude each other and cancellation is scoped', t => {
  const f = fixture();t.after(() => f.close());f.store.ingest(event('exclusive'));
  const p = f.store.configure({...f.store.policy(),modelFilterEnabled:true,allowedModels:['gpt-6.1-sol']});
  const cleanup = new ConversationCleanupStore(f.store).initialize(),model = cleanup.request({policy_version:p.version});
  assert.throws(() => cleanup.requestAll(request()),{code:'CONVERSATION_CLEANUP_ACTIVE'});
  cleanup.cancel(model.id,'all');assert(cleanup.pending());cleanup.cancel(model.id,'models');
  const all = cleanup.requestAll(request());assert.throws(() => cleanup.request({policy_version:p.version}),{code:'CONVERSATION_CLEANUP_ACTIVE'});
  cleanup.cancel(all.id,'models');assert(cleanup.pending());cleanup.cancel(all.id,'all');
  assert.equal(cleanup.step().worked,false);assert.equal(ids(f).length,1);
  assert.equal(cleanup.latest('all').status,'cancelled');assert.equal(cleanup.latest('models').status,'cancelled');
  cleanup.requestAll(request());finish(new ConversationCleanupStore(f.store).initialize());assert.equal(ids(f).length,0);
});

test('legacy cleanup schema migrates additively and old archived rows without arrival markers are cleared', t => {
  const f = fixture();t.after(() => f.close());f.store.ingest(event('pre-trigger'));
  f.store.db.exec(`CREATE TABLE cl_model_cleanups(id TEXT PRIMARY KEY,policy_version INTEGER NOT NULL,model_policy_hash TEXT NOT NULL,status TEXT NOT NULL,
    upper_rowid INTEGER NOT NULL,cursor_rowid INTEGER NOT NULL DEFAULT 0,scanned INTEGER NOT NULL DEFAULT 0,deleted INTEGER NOT NULL DEFAULT 0,
    requested_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,error_code TEXT NOT NULL DEFAULT '');`);
  const p = f.store.policy(),cleanup = new ConversationCleanupStore(f.store).initialize();
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM cl_push_arrivals').get().n,0);
  cleanup.requestAll(request());finish(cleanup);assert.equal(ids(f).length,0);assert.deepEqual(f.store.policy(),p);
});

test('history clear removes buffered JSONL metadata and jobs without invoking any external storage deletion', async t => {
  const f = fixture(),push = new ConversationPushStore(f.store).initialize();
  const p = push.policy();push.configure({...p,enabled:true,automatic:true,source:'original',s3:{...p.s3,enabled:true,endpoint:'https://s3.example.com',bucket:'fictional-bucket',accessKeyId:'fictional',secretAccessKey:'fictional'}});
  const service = new ConversationPushService(push);t.after(async () => {await service.stop();f.close();});
  f.store.ingest(event('jsonl-clear'));push.scanAutomatic();service.jsonl.store.assignOne();
  const file = service.jsonl.store.list().files[0];assert.equal(file.records,1);
  const cleanup = new ConversationCleanupStore(f.store).initialize();cleanup.requestAll(request());finish(cleanup);service.jsonl.store.reconcile();
  for (const table of ['cl_records','cl_push_jobs','cl_push_arrivals','cl_push_jsonl_members']) assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM ' + table).get().n,0);
  assert.equal(service.jsonl.store.get(file.id).status,'cancelled');assert.equal(service.jsonl.store.claim(),null);
  assert.equal(push.policy().enabled,true);assert.equal(f.store.db.prepare('PRAGMA foreign_key_check').all().length,0);
});

test('new JSONL arrivals sharing an old file survive clear and remain eligible for a fresh export', async t => {
  const f = fixture(),push = new ConversationPushStore(f.store).initialize();
  const p = push.policy();push.configure({...p,enabled:true,automatic:true,source:'original',s3:{...p.s3,enabled:true,endpoint:'https://s3.example.com',bucket:'fictional-bucket',accessKeyId:'fictional',secretAccessKey:'fictional'}});
  const service = new ConversationPushService(push);t.after(async () => {await service.stop();f.close();});
  const at = Date.now();assert(f.store.ingest(event('jsonl-old-shared',{at})).accepted);push.scanAutomatic();service.jsonl.store.assignOne();
  const cleanup = new ConversationCleanupStore(f.store).initialize();cleanup.requestAll(request());
  const fresh = event('jsonl-new-shared',{at});assert(f.store.ingest(fresh).accepted);push.scanAutomatic();service.jsonl.store.assignOne();
  assert.equal(service.jsonl.store.list().files[0].records,2);finish(cleanup);service.jsonl.store.reconcile();
  assert.deepEqual(ids(f),[fresh.id]);assert.equal(push.list().items[0].status,'pending');assert.equal(push.list().items[0].record_id,fresh.id);
  assert(service.jsonl.store.assignOne());assert.equal(push.list().items[0].status,'buffered');
  assert.equal(f.store.payload(fresh.id,'original','request').body.toString('base64'),fresh.request);
});

test('busy writers cause immediate deferral without progress or policy changes', async t => {
  const f = fixture(),service = new ConversationCleanupService(f.store),other = new ConversationLogStore(f.directory).initialize();
  t.after(async () => {await service.stop();other.close();f.close();});f.store.ingest(event('locked-clear'));
  other.db.exec('BEGIN IMMEDIATE');const at = performance.now();
  assert.throws(() => service.requestAll(request()),{code:'CONVERSATION_CLEANUP_BUSY'});
  assert(performance.now() - at < 500,'Management operation should not wait for a long archive transaction');
  assert.equal(f.store.db.pragma('busy_timeout',{simple:true}),5000);other.db.exec('ROLLBACK');
  service.store.requestAll(request());f.store.db.pragma('busy_timeout = 1');other.db.exec('BEGIN IMMEDIATE');
  assert.throws(() => service.store.step(),error => error.code.startsWith('SQLITE_BUSY'));other.db.exec('ROLLBACK');
  assert.equal(service.store.latest().deleted,0);assert.equal(ids(f).length,1);finish(service.store);assert.equal(ids(f).length,0);
});

test('full-history API requires an administrator, CSRF and explicit confirmation; capture tokens cannot clear', async t => {
  const f = fixture(),cleanup = new ConversationCleanupService(f.store,{canWork:() => false}),auth = new AuthService(f.config);
  t.after(async () => {await cleanup.stop();auth.close();f.close();});f.store.ingest(event('http-clear'));
  const app = createApp({config:f.config,auth,database:{},conversations:f.store,conversationCleanup:cleanup,messages:f.messages});
  const server = app.listen(0,'127.0.0.1');await new Promise(resolve => server.once('listening',resolve));
  t.after(() => new Promise(resolve => {server.close(resolve);server.closeAllConnections();}));
  const base = 'http://127.0.0.1:' + server.address().port,endpoint = base + '/api/conversation-logs/history-clear';
  assert.equal((await fetch(endpoint)).status,401);assert.equal((await fetch(endpoint,{headers:{authorization:'Bearer ' + f.token}})).status,401);
  const login = await fetch(base + '/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password:f.config.adminPassword})});
  const session = await login.json(),headers = {authorization:'Session ' + session.sessionToken,'content-type':'application/json'},body = JSON.stringify(request());
  assert.equal((await fetch(endpoint,{method:'POST',headers,body})).status,403);headers['x-csrf-token'] = session.csrfToken;
  assert.equal((await fetch(endpoint,{method:'POST',headers,body:'{}'})).status,400);
  const response = await fetch(endpoint,{method:'POST',headers,body});assert.equal(response.status,202);const result = await response.json();assert.equal(result.job.scope,'all');
  assert.equal(ids(f).length,1);assert.equal((await (await fetch(base + '/api/conversation-logs/model-cleanup',{headers})).json()).job,null);
  assert.equal((await fetch(endpoint + '/' + result.job.id + '/cancel',{method:'POST',headers:{authorization:headers.authorization,'content-type':'application/json'},body:'{}'})).status,403);
  assert.equal((await fetch(endpoint + '/' + result.job.id + '/cancel',{method:'POST',headers,body:'{}'})).status,200);
  assert.equal(cleanup.status('all').job.status,'cancelled');
});

test('low-priority history clear yields to archive work and keeps concurrent ingestion and management available', async t => {
  const f = fixture();f.store.configure({...f.store.policy(),mode:'original',retention:0});const p = f.store.policy();
  for (let index = 0; index < 6; index++) f.store.ingest(event('worker-clear-' + index,{policy_version:p.version,request:Buffer.from('x'.repeat(1024 ** 2)).toString('base64')}));
  const archive = new ConversationArchiveService(f.store),cleanup = new ConversationCleanupService(f.store,{canWork:() => permit && !archive.busy,intervalMs:100});
  let permit = false;const auth = new AuthService(f.config);
  t.after(async () => {await cleanup.stop();await archive.stop();auth.close();f.close();});await archive.start();
  const app = createApp({config:f.config,auth,database:{},conversations:f.store,conversationArchive:archive,conversationCleanup:cleanup,messages:f.messages});
  const server = app.listen(0,'127.0.0.1');await new Promise(resolve => server.once('listening',resolve));
  t.after(() => new Promise(resolve => {server.close(resolve);server.closeAllConnections();}));const base = 'http://127.0.0.1:' + server.address().port;
  const login = await fetch(base + '/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password:f.config.adminPassword})}),session = await login.json();
  cleanup.requestAll(request());await until(() => cleanup.ready);await new Promise(resolve => setTimeout(resolve,180));assert.equal(cleanup.status('all').job.deleted,0);
  permit = true;const fresh = [];
  for (let index = 0; index < 4; index++) {
    const response = await fetch(base + '/api/conversation-logs/policy',{headers:{authorization:'Session ' + session.sessionToken},signal:AbortSignal.timeout(2000)});assert.equal(response.status,200);
    const row = event('concurrent-clear-' + index,{at:1,policy_version:p.version});fresh.push(row.id);
    const result = await fetch(base + '/api/conversation-logs/ingest',{method:'POST',headers:{authorization:'Bearer ' + f.token,'content-type':'application/json'},body:JSON.stringify(row),signal:AbortSignal.timeout(3000)});
    assert.equal(result.status,200);assert((await result.json()).accepted);
  }
  await until(() => cleanup.status('all').job.status === 'done');assert.equal(cleanup.status('all').job.deleted,6);assert.deepEqual(ids(f),fresh.sort());
  assert.deepEqual(f.store.policy(),p);assert.equal(f.store.db.pragma('secure_delete',{simple:true}),1);await until(() => !cleanup.child);
});
