'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { once } = require('node:events');
const { performance } = require('node:perf_hooks');
const Database = require('better-sqlite3');
const { fixture, event } = require('./conversation-logs-fixture');
const { ConversationLogStore } = require('../src/conversation-log-store');
const { ConversationPushStore } = require('../src/conversation-push-store');
const { ConversationPushService } = require('../src/services/conversation-push-service');
const { ConversationPushSupervisor } = require('../src/services/conversation-push-supervisor');
const { BATCH_SIZE, INTERVAL_MS } = require('../src/conversation-storage-pricing-store');

function setup(t, { realClock = false } = {}) {
  let at = Date.now();
  const now = () => realClock ? Date.now() : at, f = fixture({ now });
  f.store.configure({ ...f.store.policy(), mode: 'original', retention: 0 });
  f.push = new ConversationPushStore(f.store, { now }).initialize();
  const policy = f.push.policy();
  f.push.configure({ ...policy, s3: { ...policy.s3, billing: { enabled: true, rates: [
    { model: 'priced', price: '40000' }, { model: 'free', price: '0' }
  ] } } });
  f.now = now; f.advance = () => { at += INTERVAL_MS; };
  f.service = new ConversationPushService(f.push);
  f.disposers = [];
  t.after(async () => { for (const dispose of f.disposers.reverse()) await dispose(); await f.service.stop(); f.close(); });
  return f;
}
function seed(f, count, extra = {}, prefix = 'usage') {
  const policy = f.push.policy();
  f.push.db.transaction(() => {
    for (let index = 0; index < count; index++) {
      const id = prefix + '-' + index;
      f.push.billing.record({ id, platformId: 's3', model: 'priced', bytes: 10 ** 9, deliveryId: id,
        sha256: crypto.createHash('sha256').update(id).digest('hex'), logDate: '2026-11-20', historical: true, policy, ...extra });
    }
  })();
}
function finish(f) {
  let iterations = 0;
  while (f.push.pricing.pending()) {
    const step = f.push.pricing.step();
    assert((step.scanned || 0) <= BATCH_SIZE); assert((step.updated || 0) <= BATCH_SIZE);
    assert(++iterations < 200, 'pricing must finish without revisiting unpriceable records');
    f.advance();
  }
  return f.push.pricing.status();
}
async function until(predicate, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert(Date.now() < deadline, 'background task did not progress');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

test('one durable request automatically drains more than 500 matching records, skips missing prices and preserves priced records', t => {
  const f = setup(t);
  seed(f, 620, { model: 'unknown' }, 'unknown'); seed(f, 1205); seed(f, 3, { model: 'free' }, 'free');
  seed(f, 1, { historical: false }, 'already');
  const before = f.push.db.prepare("SELECT * FROM cl_push_storage_usage WHERE id='already-0'").get();
  const requested = f.push.pricing.request({});
  assert.equal(requested.updated, 0); assert.equal(f.push.billing.report().summary.pricedFiles, 1);
  const first = f.push.pricing.step(); assert(first.updated > 0); assert(first.updated <= BATCH_SIZE);
  const progress = f.push.pricing.status();
  assert.deepEqual(f.push.pricing.step(), { worked: false }, 'durable pacing also applies to a second worker');
  assert.equal(f.push.pricing.status().updated, progress.updated);
  f.advance(); const job = finish(f);
  assert.equal(job.updated, 1208); assert.equal(job.status, 'done'); assert(job.batches > 5);
  assert.equal(job.terabytes, '1.208000000000'); assert.equal(job.amount, '48200.000000');
  const report = f.push.billing.report(); assert.equal(report.summary.pendingFiles, 620);
  assert.equal(report.summary.amount, '48240.000000');
  assert.deepEqual(f.push.db.prepare("SELECT * FROM cl_push_storage_usage WHERE id='already-0'").get(), before);
  f.push.pricing.request({}); assert.equal(finish(f).updated, 0);
});

test('submission freezes prices, filters and the history boundary; duplicate submissions reuse the active job', t => {
  const f = setup(t); seed(f, 220); seed(f, 10, { logDate: '2026-11-19' }, 'old-date');
  const filter = { platform: 's3', model: 'priced', start: '2026-11-20', end: '2026-11-20', page: 5 };
  const job = f.push.pricing.request(filter);
  assert.equal(f.push.pricing.request({ ...filter, page: 1 }).id, job.id);
  assert.throws(() => f.push.pricing.request({ model: 'free' }), { code: 'CONVERSATION_STORAGE_PRICING_ACTIVE' });
  f.push.pricing.step(); f.advance();
  const policy = f.push.policy(); policy.s3.billing.rates.find(row => row.model === 'priced').price = '80000'; f.push.configure(policy);
  seed(f, 3, {}, 'after-submission');
  assert.equal(finish(f).updated, 220);
  const rows = f.push.db.prepare('SELECT * FROM cl_push_storage_usage').all();
  assert(rows.filter(row => row.id.startsWith('usage-')).every(row => row.rate === '40000'));
  assert(rows.filter(row => !row.id.startsWith('usage-')).every(row => row.rate === null));
  f.push.pricing.request({}); assert.equal(finish(f).updated, 13);
  assert(f.push.db.prepare("SELECT rate FROM cl_push_storage_usage WHERE id='old-date-0'").get().rate === '80000');
  assert.throws(() => f.push.pricing.request({ surprise: true }));
  assert.throws(() => f.push.pricing.request({ start: '2026-11-21', end: '2026-11-20' }));
});

test('sparse date filters use bounded indexed keyset seeks rather than scanning or sorting the whole remainder', t => {
  const f = setup(t); seed(f, 1300, { logDate: '2026-01-01' }); seed(f, 4, {}, 'match');
  f.push.pricing.request({ start: '2026-11-20' });
  const first = f.push.pricing.step(); assert.equal(first.updated, 0); assert(first.scanned <= BATCH_SIZE);
  assert(f.push.pricing.pending()); f.advance();
  assert.equal(finish(f).updated, 4);
  const plan = f.push.db.prepare(`EXPLAIN QUERY PLAN SELECT rowid,id,bytes,log_date,delivered_at
    FROM cl_push_storage_usage INDEXED BY cl_push_storage_unpriced
    WHERE platform_id=? AND model=? AND rate IS NULL AND rowid>? AND rowid<=? ORDER BY rowid LIMIT ?`)
    .all('s3', 'priced', 0, 10000, BATCH_SIZE).map(row => row.detail).join(' ');
  assert.match(plan, /SEARCH .*cl_push_storage_unpriced.*rowid>/); assert(!plan.includes('TEMP B-TREE'));
});

test('progress survives reopening SQLite; cancellation preserves completed batches and stale cancellation cannot stop a new job', t => {
  const f = setup(t); seed(f, 350);
  const job = f.push.pricing.request({}); f.push.pricing.step(); const updated = f.push.pricing.status().updated;
  const reopenedArchive = new ConversationLogStore(f.directory, { now: f.now }).initialize();
  f.disposers.push(() => reopenedArchive.close());
  const reopened = new ConversationPushStore(reopenedArchive, { now: f.now }).initialize();
  assert.equal(reopened.pricing.status().id, job.id); assert.equal(reopened.pricing.status().updated, updated);
  f.advance(); reopened.pricing.step(); assert(reopened.pricing.status().updated > updated);
  const cancelled = reopened.pricing.cancel(job.id); assert.equal(cancelled.status, 'cancelled');
  f.advance(); assert.deepEqual(reopened.pricing.step(), { worked: false });
  const next = f.push.pricing.request({}); assert.notEqual(next.id, job.id);
  reopened.pricing.cancel(job.id); assert(f.push.pricing.pending());
  const done = finish(f); assert.equal(done.updated + cancelled.updated, 350);
  assert.equal(f.push.billing.report().summary.amount, '14000.000000');
});

test('history import is also bounded and finishes all verified old JSONL receipts before completing pricing', t => {
  const f = setup(t), policy = f.push.policy();
  const insert = f.push.db.prepare(`INSERT INTO cl_push_jsonl_files(id,target_hash,source,model,day,object_key,policy_version,archive_version,
    status,bytes,records,created_at,updated_at,uploaded_bytes,sha256,http_status,destination) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  f.push.db.transaction(() => {
    for (let index = 0; index < 251; index++) insert.run('file-' + index, 'hash', 'original', 'priced', '2026-11-20', 'file-' + index,
      policy.version, 1, 'sent', 1000000000, 1, f.now() - 1000, f.now() - 500, 1000000000, 'a'.repeat(64), 200, 's3');
  })();
  f.push.db.prepare("UPDATE cl_push_jsonl_files SET uploaded_bytes=1 WHERE id='file-0'").run();
  f.push.db.prepare("UPDATE cl_push_jsonl_files SET sha256='invalid' WHERE id='file-1'").run();
  f.push.db.prepare("UPDATE cl_push_jsonl_files SET http_status=500 WHERE id='file-2'").run();
  f.push.db.prepare("UPDATE cl_push_jsonl_files SET status='running' WHERE id='file-3'").run();
  f.push.db.prepare("UPDATE cl_push_jsonl_files SET updated_at=? WHERE id='file-4'").run(f.now() + 10000);
  const job = f.push.pricing.request({}); assert.equal(job.phase, 'history');
  const step = f.push.pricing.step(); assert.equal(step.updated, 0); assert(step.scanned <= BATCH_SIZE); f.advance();
  const done = finish(f); assert.equal(done.imported, 246); assert.equal(done.updated, 246);
  assert.equal(f.push.billing.report().summary.amount, '9840.000000');
});

test('writer contention returns promptly without blocking the HTTP process or losing progress; SQLite settings are restored', t => {
  const f = setup(t); seed(f, 300); f.push.pricing.request({});
  const file = f.store.db.pragma('database_list').find(row => row.name === 'main').file;
  const writer = new Database(path.resolve(file)); f.disposers.push(() => writer.close());
  const timeout = f.push.db.pragma('busy_timeout', { simple: true }), checkpoint = f.push.db.pragma('wal_autocheckpoint', { simple: true });
  writer.exec('BEGIN IMMEDIATE');
  try {
    const began = performance.now();
    assert.throws(() => f.push.pricing.request({}), { code: 'CONVERSATION_STORAGE_PRICING_BUSY', status: 503 });
    assert.deepEqual(f.push.pricing.step(), { worked: false, busy: true });
    assert.throws(() => f.push.pricing.cancel(f.push.pricing.status().id), { code: 'CONVERSATION_STORAGE_PRICING_BUSY' });
    assert(performance.now() - began < 200, 'a writer must not cause the default 5-second main-process stall');
    assert.equal(f.push.pricing.status().updated, 0);
    assert.equal(f.push.db.pragma('busy_timeout', { simple: true }), timeout);
    assert.equal(f.push.db.pragma('wal_autocheckpoint', { simple: true }), checkpoint);
  } finally { writer.exec('ROLLBACK'); }
  assert.equal(finish(f).updated, 300);
});

test('pricing yields to foreground work and active pushes, checks priority inside a batch and observes the one-second interval', t => {
  const f = setup(t); seed(f, 250);
  let work = false, cleanup = true;
  const service = new ConversationPushService(f.push, { canWork: () => work, canCleanup: () => cleanup });
  f.disposers.push(() => service.stop());
  service.fillBilling({}); service.maintain(); assert.equal(f.push.pricing.status().updated, 0);
  assert.equal(service.pricingStatus().pauseReason, 'foreground');
  work = true; cleanup = false; service.maintain(); assert.equal(f.push.pricing.status().updated, 0);
  cleanup = true; service.jsonl.active = {}; service.maintain(); assert.equal(service.pricingStatus().pauseReason, 'push');
  service.jsonl.active = null; service.maintain(); const updated = f.push.pricing.status().updated; assert(updated > 0);
  service.maintain(); assert.equal(f.push.pricing.status().updated, updated);
  f.advance(); let checks = 0;
  f.push.pricing.step({ canWork: () => ++checks < 8 });
  assert(f.push.pricing.status().updated - updated < BATCH_SIZE);
  f.advance(); assert.equal(finish(f).updated, 250);
});

test('the isolated low-priority worker drains all batches without browser polling and resumes automatically after process exit', async t => {
  const f = setup(t, { realClock: true }); seed(f, 655);
  let allowed = false;
  const supervisor = new ConversationPushSupervisor(f.push, { heapMiB: 128, canWork: () => allowed, canCleanup: () => allowed });
  f.disposers.push(() => supervisor.stop()); supervisor.start(); await until(() => supervisor.ready);
  const submitted = supervisor.fillBilling({}); assert.equal(submitted.job.updated, 0);
  await new Promise(resolve => setTimeout(resolve, 1200)); assert.equal(f.push.pricing.status().updated, 0);
  allowed = true; await until(() => f.push.pricing.status().updated > 0);
  const beforeExit = f.push.pricing.status().updated, child = supervisor.child;
  child.kill('SIGKILL'); await once(child, 'exit');
  assert(f.push.pricing.pending());
  const request = event('foreground-during-pricing'); const began = performance.now(); f.store.ingest(request);
  assert(performance.now() - began < 250, 'foreground writes must remain available between short pricing batches');
  assert(f.store.db.prepare('SELECT 1 FROM cl_records WHERE id=?').get(request.id));
  await until(() => f.push.pricing.status().status === 'done');
  const done = f.push.pricing.status(); assert.equal(done.id, submitted.job.id); assert.equal(done.updated, 655);
  assert(done.updated > beforeExit); assert.equal(f.push.billing.report().summary.amount, '26200.000000');
});

test('long pricing tasks interleave local delivered-body cleanup instead of postponing it until every batch completes', t => {
  const f = setup(t); seed(f, 350);
  const policy = f.push.policy(); f.push.configure({ ...policy, enabled: true, deleteAfterPush: true,
    webhook: { ...policy.webhook, enabled: true, url: 'https://receiver.example/logs' } });
  let cleanupSteps = 0;
  f.push.cleanup.step = () => { cleanupSteps++; return { deleted: false }; };
  f.push.billing.backfill = () => { throw new Error('active pricing already imports historical receipts in bounded batches'); };
  f.push.pricing.request({}); f.service.maintain(); const first = f.push.pricing.status().updated;
  assert(first > 0); f.advance(); f.service.maintain(); assert.equal(cleanupSteps, 1);
  assert.equal(f.push.pricing.status().updated, first); assert(f.push.pricing.pending());
  f.advance(); f.service.maintain(); assert(f.push.pricing.status().updated > first);
});

test('a batch failure rolls back both fees and progress so a retry cannot omit or double-price records', t => {
  const f = setup(t); seed(f, 220); f.push.pricing.request({});
  f.push.db.exec(`CREATE TRIGGER cl_test_pricing_abort BEFORE UPDATE OF rate ON cl_push_storage_usage
    WHEN NEW.id='usage-20' BEGIN SELECT RAISE(ABORT,'simulated batch failure'); END;`);
  assert.throws(() => f.push.pricing.step(), /simulated batch failure/);
  assert.equal(f.push.pricing.status().updated, 0); assert.equal(f.push.billing.report().summary.amount, '0.000000');
  f.push.db.exec('DROP TRIGGER cl_test_pricing_abort');
  assert.equal(finish(f).updated, 220); assert.equal(f.push.billing.report().summary.amount, '8800.000000');
});

test('long idle jobs reuse WAL space between batches and passive checkpointing never waits for an existing reader', t => {
  const f = setup(t); seed(f, 5000); f.push.pricing.request({});
  f.push.db.pragma('wal_checkpoint(TRUNCATE)'); f.push.db.pragma('wal_autocheckpoint = 0');
  const file = f.push.db.pragma('database_list').find(row => row.name === 'main').file;
  f.push.pricing.step(); const firstSize = fs.statSync(file + '-wal').size;
  f.advance(); assert.equal(finish(f).updated, 5000);
  assert(fs.statSync(file + '-wal').size <= firstSize * 10 + 65536, 'WAL must reuse checkpointed pages instead of growing for every batch');
  seed(f, 400, {}, 'reader-test'); f.push.pricing.request({}); f.push.pricing.step(); f.advance();
  const reader = new Database(file); f.disposers.push(() => reader.close());
  reader.exec('BEGIN');
  const before = reader.prepare('SELECT SUM(amount_micros) amount FROM cl_push_storage_usage').get().amount;
  try {
    const began = performance.now(); const done = finish(f);
    assert.equal(done.updated, 400); assert(performance.now() - began < 250, 'PASSIVE checkpoint must not wait for a reader to release its snapshot');
    assert.equal(reader.prepare('SELECT SUM(amount_micros) amount FROM cl_push_storage_usage').get().amount, before);
  } finally { reader.exec('ROLLBACK'); }
  assert.equal(f.push.billing.report().summary.pricedFiles, 5400);
});
