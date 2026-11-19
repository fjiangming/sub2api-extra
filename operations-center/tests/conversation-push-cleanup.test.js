'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
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
