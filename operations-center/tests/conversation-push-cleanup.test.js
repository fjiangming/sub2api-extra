'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const { EventEmitter } = require('node:events');
const { fixture, event, rawRequest, rawResponse } = require('./conversation-logs-fixture');
const { s3Receiver } = require('./conversation-s3-fixture');
const { ConversationLogStore } = require('../src/conversation-log-store');
const { ConversationPushStore } = require('../src/conversation-push-store');
const { ConversationPushService } = require('../src/services/conversation-push-service');
const { ConversationPushSupervisor } = require('../src/services/conversation-push-supervisor');
const { ConversationPushTransport } = require('../src/services/conversation-push-transport');
const { ConversationReadService } = require('../src/services/conversation-read-service');
const { holdPayloads } = require('../src/services/conversation-local-retention');

function setup(t, options = {}) {
  let now = Date.now();
  const f = fixture({ now: () => now });
  f.store.configure({ ...f.store.policy(), mode: 'original', retention: 0 });
  f.push = new ConversationPushStore(f.store, { now: () => now }).initialize();
  f.push.configure({ ...f.push.policy(), enabled: true, source: 'original', deleteAfterPush: true,
    webhook: { enabled: true, url: 'https://receiver.example/logs', token: '' }, ...options });
  f.service = new ConversationPushService(f.push, { transport: { send: async () => ({ status: 'sent', httpStatus: 200 }) } });
  f.advance = (ms = 30001) => { now += ms; };
  f.enqueue = (row, destinations = ['webhook']) => {
    f.store.ingest(row);
    const input = { filter: { search: row.id }, destinations }, preview = f.push.preview(input);
    return f.push.enqueue({ ...input, previewToken: preview.previewToken, batchId: crypto.randomUUID() });
  };
  t.after(async () => { await f.worker?.stop(); await f.service.stop(); f.store.close(); f.close(); });
  return f;
}
const exists = (f, row) => Boolean(f.store.db.prepare('SELECT 1 FROM cl_records WHERE id=?').get(row.id));
const until = async predicate => {
  const deadline = Date.now() + 15000;
  while (!predicate()) { assert(Date.now() < deadline, 'cleanup worker timed out'); await new Promise(resolve => setTimeout(resolve, 50)); }
};
async function deliveredRows(f, count, extra = {}) {
  const rows = [];
  for (let n = 0; n < count; n++) {
    const row = event('batch-delivered-' + n, extra); rows.push(row);
    f.enqueue(row); await f.service.tick();
  }
  return rows;
}

test('cleanup is explicit, legacy policies stay off and older clients preserve the saved setting', t => {
  const f = setup(t, { deleteAfterPush: false });
  const old = { ...f.push.policy() }; delete old.deleteAfterPush;
  f.push.db.prepare('UPDATE cl_push_policies SET body=? WHERE version=?').run(f.store.seal(old, 'push-policy:' + old.version), old.version);
  assert.equal(f.push.policy().deleteAfterPush, false);
  f.push.configure({ ...f.push.policy(), deleteAfterPush: true });
  const client = { ...f.push.policy() }; delete client.deleteAfterPush;
  f.push.configure(client); assert.equal(f.push.policy().deleteAfterPush, true);
  assert.throws(() => f.push.configure({ ...f.push.policy(), deleteAfterPush: 'true' }));
});

test('confirmed delivery deletes both encrypted copies and indexes but retains bounded content-free receipts and idempotency', async t => {
  const f = setup(t); f.store.configure({ ...f.store.policy(), mode: 'dual' });
  const row = event('clean-confirmed'), batch = f.enqueue(row);
  assert(f.store.db.prepare('SELECT original,masked FROM cl_records WHERE id=?').get(row.id).masked);
  await f.service.tick(); assert(exists(f, row));
  assert.equal(f.push.cleanup.step().deleted, true); assert(!exists(f, row));
  for (const table of ['cl_record_metadata', 'cl_processing', 'cl_push_arrivals', 'cl_push_cleanup_queue']) {
    const key = table === 'cl_record_metadata' ? 'id' : 'record_id';
    assert.equal(f.store.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${key}=?`).get(row.id).n, 0);
  }
  const history = f.push.list(); assert.equal(history.total, 1); assert.equal(history.items[0].status, 'sent');
  assert(history.items[0].local_deleted_at); assert.equal(history.items[0].user_id, null);
  assert.equal(f.push.batch(batch.id).counts[0].count, 1);
  const receipt = JSON.stringify(f.store.db.prepare('SELECT * FROM cl_push_receipts').all());
  assert(!receipt.includes(rawRequest)); assert(!receipt.includes(rawResponse)); assert(!receipt.includes('alice@example.com'));
  const replay = f.store.ingest(row); assert(replay.accepted && replay.duplicate); assert(!exists(f, row));
  assert.throws(() => f.store.ingest({ ...row, request: Buffer.from('changed').toString('base64') }), { code: 'CONVERSATION_ID_CONFLICT' });
});

test('disabled cleanup and unsuccessful or uncertain HTTP receipts preserve the complete archive', async t => {
  for (const result of [{ status: 'failed', httpStatus: 503, retryable: true }, { status: 'sent', httpStatus: 0 }]) {
    const f = setup(t), row = event('keep-' + result.httpStatus); f.enqueue(row);
    f.service.transport.send = async () => result;
    const before = f.store.db.prepare('SELECT original FROM cl_records WHERE id=?').get(row.id).original;
    await f.service.tick(); assert.equal(f.push.cleanup.step().deleted, false);
    assert.deepEqual(f.store.db.prepare('SELECT original FROM cl_records WHERE id=?').get(row.id).original, before);
  }
  const f = setup(t, { deleteAfterPush: false }), row = event('disabled-cleanup'); f.enqueue(row); await f.service.tick();
  assert.equal(f.push.cleanup.step().deleted, false); assert(exists(f, row));
});

test('all destinations must finish and a failed or cancelled sibling prevents premature deletion', async t => {
  const f = setup(t);
  f.push.configure({ ...f.push.policy(), s3: { ...f.push.policy().s3, enabled: true, format: 'json', endpoint: 'https://s3.example/', bucket: 'test-bucket', accessKeyId: 'fictional', secretAccessKey: 'fictional' } });
  const row = event('two-destinations'); f.enqueue(row, ['webhook', 's3']);
  await f.service.tick(); assert.equal(f.push.cleanup.step().deleted, false); assert(exists(f, row));
  f.service.transport.send = async () => ({ status: 'failed', httpStatus: 403 }); await f.service.tick();
  f.advance(); assert.equal(f.push.cleanup.step().deleted, false); assert(exists(f, row));
  const failed = f.push.list({ status: 'failed' }).items[0]; f.push.retry(failed.id);
  f.service.transport.send = async () => ({ status: 'sent', httpStatus: 200 }); await f.service.tick();
  f.advance(); assert(f.push.cleanup.step().deleted); assert(!exists(f, row));
  assert.equal(f.push.list({ status: 'sent' }).total, 2);
});

test('changed content and newly enabled targets are preserved until the current version is delivered', async t => {
  const f = setup(t), row = event('changed-copy'); f.enqueue(row); await f.service.tick();
  f.store.db.prepare('UPDATE cl_records SET fingerprint=? WHERE id=?').run('new-fingerprint', row.id);
  assert.equal(f.push.cleanup.step().reason, 'content_changed'); assert(exists(f, row));
  const g = setup(t), other = event('new-target'); g.enqueue(other); await g.service.tick();
  g.push.configure({ ...g.push.policy(), s3: { ...g.push.policy().s3, enabled: true, endpoint: 'https://s3.example/', bucket: 'test-bucket', accessKeyId: 'fictional', secretAccessKey: 'fictional' } });
  assert.equal(g.push.cleanup.step().reason, 'content_changed'); assert(exists(g, other));
});

test('cancelled sibling jobs and unfinished processing retain the record', async t => {
  const f = setup(t);
  f.push.configure({ ...f.push.policy(), s3: { ...f.push.policy().s3, enabled: true, format: 'json', endpoint: 'https://s3.example/', bucket: 'test-bucket', accessKeyId: 'fictional', secretAccessKey: 'fictional' } });
  const row = event('cancelled-sibling'), batch = f.enqueue(row, ['webhook', 's3']); await f.service.tick();
  f.push.cancelBatch(batch.id); assert.equal(f.push.cleanup.step().reason, 'delivery_pending'); assert(exists(f, row));
  const g = setup(t), pending = event('processing-hold'); g.enqueue(pending); await g.service.tick();
  g.store.db.prepare('UPDATE cl_records SET processing_pending=1 WHERE id=?').run(pending.id);
  assert.equal(g.push.cleanup.step().reason, 'processing'); assert(exists(g, pending));
});

test('an old completion cannot delete a different record reinserted under the same ID', async t => {
  const f = setup(t), first = event('reused-id'); f.enqueue(first);
  const job = f.push.claim({ single: true }); assert(job);
  f.store.db.prepare('DELETE FROM cl_records WHERE id=?').run(first.id);
  const next = { ...first, request: Buffer.from('{"input":"replacement"}').toString('base64') };
  assert(f.store.ingest(next).accepted); assert.equal(f.push.finish(job, { status: 'sent', httpStatus: 200 }), 0);
  assert.equal(f.push.cleanup.step().deleted, false); assert(exists(f, next));
  assert.equal(f.store.payload(next.id, 'original', 'request').body.toString(), '{"input":"replacement"}');
});

test('delivery evidence expires in bounded batches and the same-timestamp marker cap cannot grow indefinitely', t => {
  const f = setup(t), at = Date.now();
  const insert = f.store.db.prepare('INSERT INTO cl_delivered_records VALUES(?,?,?,?)');
  f.store.db.transaction(() => { for (let n = 0; n < 100005; n++) insert.run(String(n).padStart(32, '0'), 'fingerprint', 'digest', at); })();
  f.push.cleanup.prune(); assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM cl_delivered_records').get().n, 100000);
  assert(!f.store.db.prepare('SELECT 1 FROM cl_delivered_records WHERE id=?').get('0'.repeat(32)));
  f.advance(31 * 86400000); f.push.cleanup.prune();
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM cl_delivered_records').get().n, 99744);
});

test('queued body reads and exports hold archive leases until completion or cancellation', async t => {
  for (const target of ['/export', '/records/0123456789abcdef/payload?source=original']) {
    const f = setup(t), row = event('lease-' + target); f.enqueue(row); await f.service.tick();
    const read = new ConversationReadService(f.store); read.drain = () => {};
    const res = new EventEmitter(); res.status = () => res; res.json = () => res;
    read.proxy({}, res, () => {}, target);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM cl_payload_leases').get().n, 1);
    assert.equal(f.push.cleanup.step().reason, 'reading'); assert(exists(f, row));
    res.emit('close'); assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM cl_payload_leases').get().n, 0);
    assert(f.push.cleanup.step().deleted); await read.stop();
  }
});

test('orphaned leases expire and confirmed historical jobs resume cleanup after database restart', async t => {
  const f = setup(t), row = event('restart-cleanup'); f.enqueue(row); await f.service.tick();
  f.store.db.prepare('DELETE FROM cl_push_cleanup_queue').run();
  f.store.db.prepare('INSERT INTO cl_payload_leases VALUES(?,?)').run('orphan', Date.now() + 1000);
  await f.service.stop(); f.store.close(); f.advance(2000);
  f.store = new ConversationLogStore(f.directory, { now: f.push.now }).initialize();
  f.push = new ConversationPushStore(f.store, { now: f.push.now }).initialize();
  f.service = new ConversationPushService(f.push);
  assert(f.push.cleanup.step().deleted); assert(!exists(f, row));
});

test('a local deletion failure rolls back receipts and retries without resending delivered data', async t => {
  const f = setup(t), row = event('local-retry'); f.enqueue(row); await f.service.tick();
  f.store.db.exec("CREATE TRIGGER fixture_refuse_delete BEFORE DELETE ON cl_records BEGIN SELECT RAISE(ABORT,'fixture'); END;");
  f.service.maintain(); assert.equal(f.service.cleanupError, 'LOCAL_CLEANUP_RETRY'); assert(exists(f, row));
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM cl_push_receipts').get().n, 0);
  assert.equal(f.push.list({ status: 'sent' }).total, 1);
  f.store.db.exec('DROP TRIGGER fixture_refuse_delete'); f.advance(); f.service.maintain();
  assert(!exists(f, row)); assert.equal(f.service.cleanupError, '');
});

test('background reclamation releases quota and physical pages without a full VACUUM', async t => {
  const f = setup(t), row = event('reclaim-pages', { request: Buffer.from(JSON.stringify({ input: 'x'.repeat(2 * 1024 ** 2) })).toString('base64') });
  f.enqueue(row); await f.service.tick(); f.store.db.pragma('wal_checkpoint(TRUNCATE)');
  const before = f.store.storageUsage(); assert(f.push.cleanup.step().deleted);
  f.push.cleanup.reclaim();
  const reusable = f.store.storageUsage(); assert(reusable.quotaBytes < before.quotaBytes);
  for (let n = 0; n < 32; n++) f.push.cleanup.reclaim();
  assert(f.store.storageUsage().physicalBytes < before.physicalBytes);
});

test('physical shrinking yields to pending deliveries while logical deletion and quota reuse continue', async t => {
  const f = setup(t), [sent] = await deliveredRows(f, 1, {
    request: Buffer.from(JSON.stringify({ input: 'x'.repeat(2 * 1024 ** 2) })).toString('base64')
  });
  const pending = event('reclaim-pending'); f.enqueue(pending);
  const before = f.store.storageUsage().quotaBytes, calls = [], reclaim = f.push.cleanup.reclaim.bind(f.push.cleanup);
  f.push.cleanup.reclaim = options => { calls.push(options); reclaim(options); };
  f.service.maintain(); assert(!exists(f, sent)); assert(exists(f, pending));
  assert(f.store.storageUsage().quotaBytes < before);
  assert(f.store.db.pragma('freelist_count', { simple: true }) > 128);
  f.advance(); f.service.maintain(); assert.equal(calls.length, 0);
  assert.equal(f.service.reclaimIdleSince, null);
  await f.service.tick(); f.advance(200); f.service.maintain(); assert(!exists(f, pending));
  f.advance(29800); f.service.maintain(); assert.equal(calls.length, 0);
  f.advance(200); f.service.maintain(); assert.deepEqual(calls, [{ pages: 128 }]);
  f.advance(29800); f.service.maintain(); assert.equal(calls.length, 1);
  f.advance(200); f.service.maintain(); assert.deepEqual(calls, [{ pages: 128 }, { pages: 128 }]);
});

test('automatic arrivals, open JSONL tails and failed files retain priority over physical shrinking', t => {
  const f = setup(t, { automatic: true });
  f.push.configure({ ...f.push.policy(), webhook: { ...f.push.policy().webhook, enabled: false },
    s3: { ...f.push.policy().s3, enabled: true, endpoint: 'https://storage.example/', bucket: 'fictional-reclaim', accessKeyId: 'fictional', secretAccessKey: 'fictional' } });
  const calls = [];
  f.push.cleanup.reclaim = options => calls.push(options);
  const held = () => {
    f.service.reclaimIdleSince = f.push.now() - 60000;
    f.service.maintain(); assert.equal(f.service.reclaimIdleSince, null);
    assert.equal(calls.length, 0); f.advance();
  };
  f.store.ingest(event('reclaim-unscanned', { at: f.push.now() })); held();
  assert.equal(f.push.scanAutomatic().created, 1); held();
  assert(f.service.jsonl.store.assignOne());
  const file = f.service.jsonl.store.list().files[0]; assert.equal(file.status, 'open'); held();
  f.store.db.prepare("UPDATE cl_push_jsonl_files SET status='failed',error_code='CONNECTION_FAILED' WHERE id=?").run(file.id); held();
  f.store.db.prepare("UPDATE cl_push_jobs SET status='failed' WHERE jsonl_file_id=?").run(file.id); held();
});

test('foreground work, readers, pricing and stop/start reset the physical shrinking idle window', async t => {
  const f = setup(t), service = f.service;
  const reset = block => {
    service.reclaimIdleSince = f.push.now() - 60000; block();
    service.maintain(); assert.equal(service.reclaimIdleSince, null); f.advance();
  };
  reset(() => { service.canWork = () => false; }); service.canWork = () => true;
  reset(() => { service.canCleanup = () => false; }); service.canCleanup = () => true;
  const release = holdPayloads(f.store.db, f.push.now); t.after(release);
  reset(() => {}); release();
  reset(() => { service.jsonl.active = {}; }); service.jsonl.active = null;
  service.reclaimIdleSince = f.push.now() - 60000;
  f.push.configure({ ...f.push.policy(), webhook: { ...f.push.policy().webhook,
    billing: { enabled: true, rates: [{ model: 'example-model', price: '1' }] } } });
  assert.equal(f.push.pricing.request({}).status, 'pending');
  service.maintain(); assert.equal(service.reclaimIdleSince, null);
  await service.stop(); service.reclaimIdleSince = f.push.now() - 60000;
  service.start(); assert(service.reclaimIdleSince === null || service.reclaimIdleSince === f.push.now());
  await service.stop();
});

test('multipart parts or a lost Complete receipt never authorize archive deletion', async t => {
  let lose = true;
  const receiver = await s3Receiver({ beforeRequest: (entry, res) => {
    if (lose && entry.method === 'POST' && entry.query.has('uploadId')) { lose = false; res.end = () => { res.destroy(); return res; }; }
  } }); t.after(() => receiver.close());
  const f = setup(t);
  f.push.configure({ ...f.push.policy(), webhook: { enabled: false, url: '', token: '' }, allowPrivateNetwork: true, retrySeconds: 5,
    s3: { ...f.push.policy().s3, enabled: true, endpoint: receiver.url, bucket: 'test-bucket', prefix: '', accessKeyId: 'fictional', secretAccessKey: 'fictional' } });
  await f.service.stop(); f.service = new ConversationPushService(f.push, { transport: new ConversationPushTransport() });
  const row = event('complete-receipt'); f.enqueue(row, ['s3']); await f.service.jsonl.tick();
  assert.equal(receiver.completed.length, 1); assert.equal(f.push.cleanup.step().deleted, false); assert(exists(f, row));
  for (let n = 0; n < 3 && f.push.list().items[0].status !== 'sent'; n++) { f.advance(); await f.service.jsonl.tick(); }
  assert.equal(f.push.list().items[0].status, 'sent'); assert(f.push.cleanup.step().deleted); assert(!exists(f, row));
  const receipt = f.store.db.prepare('SELECT object_key,sha256 FROM cl_push_receipts').get();
  assert.match(receipt.object_key, /\.jsonl$/); assert.match(receipt.sha256, /^[a-f0-9]{64}$/);
  assert(!fs.readdirSync(f.store.directory).some(name => name.endsWith('.jsonl')));
});

test('cleanup obeys worker priority and cross-process reader leases without delaying collection', async t => {
  const receiver = await s3Receiver(); t.after(() => receiver.close());
  const f = setup(t);
  f.push.configure({ ...f.push.policy(), webhook: { enabled: false, url: '', token: '' }, allowPrivateNetwork: true,
    s3: { ...f.push.policy().s3, enabled: true, endpoint: receiver.url, bucket: 'test-bucket', accessKeyId: 'fictional', secretAccessKey: 'fictional' } });
  const row = event('worker-cleanup'); f.enqueue(row, ['s3']);
  let permitted = false;
  const worker = new ConversationPushSupervisor(f.push, { canCleanup: () => permitted }); f.worker = worker; worker.start();
  await until(() => f.push.list().items[0]?.status === 'sent'); assert(exists(f, row));
  const release = holdPayloads(f.store.db); t.after(release); permitted = true;
  await new Promise(resolve => setTimeout(resolve, 1300)); assert(exists(f, row));
  const next = event('collection-during-cleanup'); assert(f.store.ingest(next).accepted);
  release(); await until(() => !exists(f, row)); assert(exists(f, next));
  assert.equal(f.push.list({ status: 'sent' }).total, 1);
});

test('cleanup uses an indexed due queue and skips deferred records without starving confirmed siblings', async t => {
  const f = setup(t), rows = await deliveredRows(f, 3);
  const held = [...rows].sort((a, b) => a.id.localeCompare(b.id))[0];
  f.store.db.prepare('UPDATE cl_records SET processing_pending=1 WHERE id=?').run(held.id);
  const plan = f.store.db.prepare('EXPLAIN QUERY PLAN SELECT record_id FROM cl_push_cleanup_queue WHERE next_at<=? ORDER BY next_at,record_id LIMIT 1').all(f.push.now());
  assert(plan.some(row => row.detail.includes('cl_push_cleanup_due')));
  assert(!plan.some(row => row.detail.includes('TEMP B-TREE')));
  const result = f.push.cleanup.batch({ maxMs: 1000 });
  assert.equal(result.deleted, 2); assert(exists(f, held));
  assert.equal(f.store.db.prepare('SELECT reason FROM cl_push_cleanup_queue WHERE record_id=?').get(held.id).reason, 'processing');
  f.store.db.prepare('UPDATE cl_records SET processing_pending=0 WHERE id=?').run(held.id);
  f.advance(); assert.equal(f.push.cleanup.batch({ maxMs: 1000 }).deleted, 1);
});

test('cleanup batches limit bytes and records, allow one oversized record and recheck foreground priority', async t => {
  const f = setup(t), rows = await deliveredRows(f, 6);
  const bytes = f.store.db.prepare('SELECT bytes FROM cl_record_metadata LIMIT 1').get().bytes;
  assert.equal(f.push.cleanup.batch({ maxBytes: 2 * bytes, maxMs: 1000 }).deleted, 2);
  assert.equal(f.push.cleanup.batch({ maxBytes: 1, maxMs: 1000 }).deleted, 1);
  assert.equal(f.push.cleanup.batch({ maxRecords: 1, maxMs: 1000 }).deleted, 1);
  assert.equal(f.push.cleanup.batch({ maxMs: 0 }).deleted, 0);
  const remaining = () => rows.filter(row => exists(f, row)).length;
  assert.equal(remaining(), 2);
  assert.equal(f.push.cleanup.batch({ maxMs: 1000, canWork: () => remaining() > 1 }).deleted, 1);
  assert.equal(remaining(), 1);
  const release = holdPayloads(f.store.db); assert.equal(f.push.cleanup.batch().deleted, 0);
  release(); assert.equal(f.push.cleanup.batch({ maxMs: 1000 }).deleted, 1);
});

test('a batch commits receipts and deletions together and rolls back every earlier deletion on failure', async t => {
  const f = setup(t), rows = await deliveredRows(f, 3);
  const refused = [...rows].sort((a, b) => a.id.localeCompare(b.id))[1];
  const before = f.push.cleanup.status();
  f.store.db.exec(`CREATE TRIGGER fixture_batch_failure BEFORE DELETE ON cl_records WHEN OLD.id='${refused.id}'
    BEGIN SELECT RAISE(ABORT,'fixture second deletion'); END;`);
  assert.throws(() => f.push.cleanup.batch({ maxMs: 1000 }), /fixture second deletion/);
  assert(rows.every(row => exists(f, row)));
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM cl_push_receipts').get().n, 0);
  assert.deepEqual(f.push.cleanup.status(), before);
  f.store.db.exec('DROP TRIGGER fixture_batch_failure');
  assert.equal(f.push.cleanup.batch({ maxMs: 1000 }).deleted, 3);
  assert.equal(f.push.list({ status: 'sent' }).total, 3);
});

test('a source deletion that is ignored cannot leave a receipt or incorrectly increment cleanup progress', async t => {
  const f = setup(t), [row] = await deliveredRows(f, 1);
  f.store.db.exec('CREATE TRIGGER fixture_ignore_delete BEFORE DELETE ON cl_records BEGIN SELECT RAISE(IGNORE); END;');
  assert.throws(() => f.push.cleanup.batch({ maxMs: 1000 }), /CONVERSATION_CLEANUP_CHANGED/);
  assert(exists(f, row)); assert.equal(f.push.cleanup.status().deleted, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM cl_push_receipts').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM cl_delivered_records').get().n, 0);
});

test('missing or legacy metadata postpones deletion until the compact projection is ready', async t => {
  const f = setup(t), [row] = await deliveredRows(f, 1);
  f.store.db.prepare('DELETE FROM cl_record_metadata WHERE id=?').run(row.id);
  assert.equal(f.push.cleanup.batch().deleted, 0); assert(exists(f, row));
  assert.equal(f.store.db.prepare('SELECT reason FROM cl_push_cleanup_queue').get().reason, 'metadata_pending');
  f.store.backfillMetadata(); f.advance();
  f.store.db.prepare("UPDATE cl_record_metadata SET fingerprint='' WHERE id=?").run(row.id);
  assert.equal(f.push.cleanup.batch().deleted, 0); assert(exists(f, row));
  f.store.backfillMetadata(); f.advance();
  assert.equal(f.push.cleanup.batch({ maxMs: 1000 }).deleted, 1);
});

test('cleanup yields to another SQLite writer promptly and restores its connection timeout', async t => {
  const f = setup(t), rows = await deliveredRows(f, 2);
  const timeout = f.store.db.pragma('busy_timeout', { simple: true });
  const writer = new Database(f.store.file, { timeout: 1 });
  try {
    writer.exec('BEGIN IMMEDIATE');
    const began = performance.now();
    assert.throws(() => f.push.cleanup.batch(), { code: 'SQLITE_BUSY' });
    assert(performance.now() - began < 200, 'cleanup must not wait seconds behind foreground writes');
    assert.equal(f.store.db.pragma('busy_timeout', { simple: true }), timeout);
    assert(rows.every(row => exists(f, row)));
    writer.exec('ROLLBACK');
    assert.equal(f.push.cleanup.batch({ maxMs: 1000 }).deleted, 2);
    assert(writer.prepare('SELECT COUNT(*) n FROM cl_records').get().n === 0);
    writer.exec('BEGIN IMMEDIATE'); writer.exec('ROLLBACK');
  } finally { if (writer.inTransaction) writer.exec('ROLLBACK'); writer.close(); }
});

test('large single-record deletions keep the accelerated cleanup interval bounded', t => {
  const f = setup(t); let calls = 0;
  f.push.cleanup.batch = () => { calls++; return { deleted: 1, bytes: 20 * 1024 ** 2 }; };
  f.service.maintain(); assert.equal(calls, 1);
  f.advance(199); f.service.maintain(); assert.equal(calls, 1);
  f.advance(1); f.service.maintain(); assert.equal(calls, 2);
  f.service.canWork = () => false; f.advance(); f.service.maintain(); assert.equal(calls, 2);
  f.service.canWork = () => true; f.service.canCleanup = () => false;
  f.service.maintain(); assert.equal(calls, 2);
});

test('a successful file is cleaned during a different multipart upload without changing its bytes or checkpoints', async t => {
  let block = false, reached = false, resume;
  const barrier = new Promise(resolve => { resume = resolve; });
  const receiver = await s3Receiver({ beforeRequest: async entry => {
    if (block && entry.method === 'PUT' && entry.query.has('partNumber')) { reached = true; await barrier; }
  } }); t.after(() => receiver.close());
  const f = setup(t);
  f.push.configure({ ...f.push.policy(), webhook: { enabled: false, url: '', token: '' }, allowPrivateNetwork: true,
    s3: { ...f.push.policy().s3, enabled: true, endpoint: receiver.url, bucket: 'test-bucket', prefix: '', accessKeyId: 'fictional', secretAccessKey: 'fictional' } });
  await f.service.stop(); f.service = new ConversationPushService(f.push, { transport: new ConversationPushTransport() });
  const sent = event('interleave-sent'), active = event('interleave-active');
  f.enqueue(sent, ['s3']); await f.service.jsonl.tick(); assert(exists(f, sent));
  const before = receiver.completed[0].body;
  f.advance(); f.enqueue(active, ['s3']); block = true;
  const uploading = f.service.jsonl.tick();
  try {
    await until(() => reached); assert(f.service.jsonl.active);
    const file = f.service.jsonl.store.get(f.service.jsonl.active.file.id);
    f.service.maintain(); assert(!exists(f, sent)); assert(exists(f, active));
    const held = f.service.jsonl.store.get(file.id);
    assert.equal(held.status, 'running'); assert.equal(held.upload_id, file.upload_id);
    assert.equal(held.uploaded_parts, file.uploaded_parts);
    assert.equal(f.push.cleanup.status().deleted, 1);
    assert(!f.push.pricing.pending());
  } finally { resume(); await uploading; }
  assert.equal(receiver.completed.length, 2); assert.deepEqual(receiver.completed[0].body, before);
  const received = JSON.parse(receiver.completed[1].body.toString().trim());
  assert.equal(received.request_id, active.request_id);
  assert.equal(received.request, Buffer.from(active.request, 'base64').toString());
  assert.equal(received.response, Buffer.from(active.response, 'base64').toString());
  const complete = f.push.list().items.find(row => row.record_id === active.id); assert.equal(complete.status, 'sent');
  f.advance(); f.service.maintain(); assert(!exists(f, active));
});
