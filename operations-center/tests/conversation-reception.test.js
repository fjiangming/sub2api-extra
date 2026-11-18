'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { fixture, event } = require('./conversation-logs-fixture');
const { ConversationLogStore, bodyDigest } = require('../src/conversation-log-store');
const { ConversationPushStore } = require('../src/conversation-push-store');
const { ConversationPushService } = require('../src/services/conversation-push-service');
const { ConversationCleanupStore } = require('../src/conversation-cleanup-store');
const { ConversationArchiveService } = require('../src/services/conversation-archive-service');
const { AuthService } = require('../src/auth');
const { createApp } = require('../src/app');

function v2(seed, extra = {}) {
  const row = event(seed, { capture_version: 2, ...extra });
  row.body_sha256 = bodyDigest({ request: Buffer.from(row.request, 'base64'), response: Buffer.from(row.response, 'base64'),
    frames: row.frames.map(frame => ({ ...frame, body: Buffer.from(frame.body, 'base64') })) });
  return row;
}
async function until(check, ms = 10000) {
  const deadline = Date.now() + ms;
  while (!check()) { assert(Date.now() < deadline, 'background reception did not settle'); await delay(10); }
}
function configurePush(store, source = 'masked') {
  const push = new ConversationPushStore(store).initialize();
  push.configure({ ...push.policy(), enabled: true, automatic: true, source,
    webhook: { enabled: true, url: 'https://receiver.example/logs', token: '' } });
  return push;
}

test('receipt commits encrypted byte-exact originals and pending metadata before any completion or masking work', t => {
  let processing = 0;
  const f = fixture({ processingLimits: () => { processing++; throw new Error('must run only after receipt'); } });
  t.after(() => f.close());
  const row = v2('durable-receipt');
  const ack = f.store.receive(row);
  assert.deepEqual(ack, { accepted: true, id: row.id, body_sha256: row.body_sha256 });
  assert.equal(processing, 0);
  const saved = f.store.detail(row.id);
  assert.equal(saved.processing_pending, 1); assert.equal(saved.original, true); assert.equal(saved.masked, false);
  assert.equal(saved.redaction_outdated, false); assert.equal(saved.retry_available, false); assert.equal(saved.completion_version, 0);
  assert.equal(f.store.status().processingPending, 1); assert(f.store.hasPending());
  assert.equal(f.store.payload(row.id, 'original', 'request', { decodeText: false }).body.toString('base64'), row.request);
  assert.throws(() => f.store.retry(row.id, { policy_version: 2, processed_at: 0 }), { code: 'CONVERSATION_RETRY_UNAVAILABLE' });
  for (const suffix of ['', '-wal']) assert(!fs.readFileSync(f.store.file + suffix).includes(Buffer.from('alice@example.com')));
  const duplicate = f.store.receive(row); assert(duplicate.duplicate);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM cl_processing').get().n, 1);
  assert.throws(() => f.store.receive({ ...row, duration_ms: row.duration_ms + 1 }), { code: 'CONVERSATION_ID_CONFLICT' });
});

test('a claimed receipt survives restart and lost ACK retries, then publishes just one processed copy', t => {
  let now = Date.now(); const f = fixture({ now: () => now }); t.after(() => { f.store.close(); f.close(); });
  const row = v2('restart-inbox', { at: now }); f.store.receive(row);
  assert.equal(f.store.claimPending(), row.id);
  const source = f.store.db.prepare('SELECT original FROM cl_records WHERE id=?').get(row.id).original;
  f.store.close(); now += 31000;
  f.store = new ConversationLogStore(f.directory, { now: () => now }).initialize();
  assert(f.store.receive(row).duplicate); assert.equal(f.store.claimPending(), row.id);
  assert(f.store.processPending(row.id)); assert(!f.store.hasPending());
  const detail = f.store.detail(row.id);
  assert.equal(detail.processing_pending, 0); assert.equal(detail.processing_error, ''); assert(detail.masked);
  assert.deepEqual(f.store.db.prepare('SELECT original FROM cl_records WHERE id=?').get(row.id).original, source);
  assert(!f.store.payload(row.id, 'masked', 'request').text.includes('alice@example.com'));
  assert(f.store.receive(row).duplicate); assert.equal(f.store.status().records, 1);
  assert.equal(f.store.processPending(row.id), false);
});

for (const mode of ['masked', 'original']) test('durable processing keeps the configured copy policy: ' + mode, t => {
  const f = fixture(); t.after(() => f.close());
  const policy = f.store.configure({ ...f.store.policy(), mode });
  const row = v2('inbox-' + mode, { policy_version: policy.version });
  f.store.receive(row); assert(f.store.detail(row.id).original);
  f.store.processPending(row.id);
  const saved = f.store.detail(row.id);
  assert.equal(saved.original, mode === 'original'); assert.equal(saved.masked, mode === 'masked');
  assert.equal(saved.processing_pending, 0); assert.equal(saved.processing_error, '');
});

test('processing failures and capacity pressure retain the exact original and offer manual retry', t => {
  const f = fixture(); t.after(() => f.close());
  const policy = f.store.configure({ ...f.store.policy(), mode: 'masked' });
  for (const failure of ['format', 'capacity']) {
    const row = v2('inbox-failure-' + failure, { policy_version: policy.version,
      ...(failure === 'format' ? { response: Buffer.from('{invalid').toString('base64') } : {}) });
    assert(f.store.receive(row).accepted);
    const used = f.store.usedBytes;
    if (failure === 'capacity') f.store.usedBytes = () => policy.capacity * 1024 ** 3;
    assert(f.store.processPending(row.id)); f.store.usedBytes = used;
    const saved = f.store.detail(row.id);
    assert.equal(saved.processing_error, failure === 'format' ? 'INVALID_JSON' : 'REDACTION_CAPACITY');
    assert(saved.original); assert(!saved.masked); assert(saved.retry_available); assert.equal(saved.processing_pending, 0);
    assert.equal(f.store.payload(row.id, 'original', 'response').body.toString('base64'), row.response);
    const retried = f.store.retry(row.id, { policy_version: policy.version, processed_at: saved.processed_at });
    if (failure === 'capacity') { assert(retried.masked); assert(!retried.original); }
  }
});

for (const change of ['excludedUserIds', 'modelFilterEnabled', 'enabled']) test('a policy committed during encryption rejects the whole receipt: ' + change, t => {
  const f = fixture(), other = new ConversationLogStore(f.directory).initialize();
  t.after(() => { other.close(); f.close(); });
  const seal = f.store.seal.bind(f.store);
  f.store.seal = (value, aad) => {
    if (aad.endsWith(':original')) other.configure({ ...other.policy(), [change]: change === 'excludedUserIds' ? [2] : change === 'enabled' ? false : true,
      ...(change === 'modelFilterEnabled' ? { allowedModels: [], kimiK3Plus: false } : {}) });
    return seal(value, aad);
  };
  assert.deepEqual(f.store.receive(v2('receive-policy-' + change)), { accepted: false });
  assert.equal(f.store.status().records, 0); assert(!f.store.hasPending());
});

test('excluded pending users and models are removed without loading or decrypting their bodies', t => {
  const f = fixture(); t.after(() => f.close());
  const rows = [v2('exclude-pending-user'), v2('exclude-pending-model', { user_id: 3, model: 'other' })];
  rows.forEach(row => f.store.receive(row));
  f.store.configure({ ...f.store.policy(), excludedUserIds: [2], modelFilterEnabled: true, allowedModels: ['example-model'], kimiK3Plus: false });
  const open = f.store.open.bind(f.store), prepare = f.store.db.prepare.bind(f.store.db);
  f.store.open = (value, aad) => { assert(aad.startsWith('policy:')); return open(value, aad); };
  f.store.db.prepare = sql => { assert(!sql.startsWith('SELECT original FROM cl_records')); return prepare(sql); };
  for (const row of rows) assert.equal(f.store.processPending(row.id), false);
  assert.equal(f.store.status().records, 0); assert(!f.store.hasPending());
});

test('processing publication respects new rules and never resurrects cleared or replaced history', t => {
  const f = fixture(); t.after(() => f.close());
  const row = v2('rules-before-publication'); f.store.receive(row);
  const next = () => f.store.configure({ ...f.store.policy(), custom: [{ from: 'ORION-42', to: '[PROJECT]' }] });
  assert.equal(f.store.processPending(row.id, { beforeCommit: next }), false);
  assert.equal(f.store.detail(row.id).processing_pending, 1); assert(!f.store.detail(row.id).masked);
  assert(f.store.processPending(row.id)); assert(f.store.payload(row.id, 'masked', 'request').text.includes('[PROJECT]'));
  const old = v2('clear-during-pending'); f.store.receive(old);
  const cleanup = new ConversationCleanupStore(f.store).initialize();
  const clear = () => { cleanup.requestAll({ confirm: 'clear-all-history', request_id: crypto.randomUUID() }); while (cleanup.pending()) cleanup.step(); };
  assert.equal(f.store.processPending(old.id, { beforeCommit: clear }), false);
  assert.equal(f.store.status().records, 0); assert(!f.store.hasPending());
  f.store.receive(old);
  const replacement = v2('clear-during-pending', { response: Buffer.from('{"replacement":true}').toString('base64') });
  assert.equal(f.store.processPending(old.id, { beforeCommit: () => { clear(); f.store.receive(replacement); } }), false);
  assert.equal(f.store.detail(old.id).processing_pending, 1); assert(!f.store.detail(old.id).masked);
  assert.equal(f.store.payload(old.id, 'original', 'response').body.toString('base64'), replacement.response);
  assert(f.store.processPending(old.id));
});

test('a delayed memory failure cannot mark a newly received generation as failed', t => {
  const f = fixture(); t.after(() => f.close());
  const row = v2('replace-before-memory-failure'); f.store.receive(row);
  const old = f.store.db.prepare('SELECT token FROM cl_processing WHERE record_id=?').get(row.id).token;
  f.store.db.prepare('DELETE FROM cl_records WHERE id=?').run(row.id);
  const replacement = v2('replace-before-memory-failure', { response: Buffer.from('{"replacement":true}').toString('base64') });
  f.store.receive(replacement);
  assert.equal(f.store.failPending(row.id, 'REDACTION_MEMORY_PRESSURE', old), false);
  assert.equal(f.store.detail(row.id).processing_pending, 1);
  assert.equal(f.store.detail(row.id).processing_error, '');
  assert.equal(f.store.payload(row.id, 'original', 'response').body.toString('base64'), replacement.response);
  const current = f.store.db.prepare('SELECT token FROM cl_processing WHERE record_id=?').get(row.id).token;
  assert.equal(f.store.failPending(row.id, 'REDACTION_MEMORY_PRESSURE', current), true);
  const saved = f.store.detail(row.id);
  assert.equal(saved.processing_pending, 0); assert.equal(saved.processing_error, 'REDACTION_MEMORY_PRESSURE');
  assert(saved.original); assert(saved.retry_available); assert(!f.store.hasPending());
});

test('interrupted processing has a durable retry bound with an explicit recoverable original', t => {
  let now = Date.now(); const f = fixture({ now: () => now }); t.after(() => f.close());
  const row = v2('interrupted-processing', { at: now }); f.store.receive(row);
  for (let attempt = 0; attempt < 3; attempt++) { assert.equal(f.store.claimPending(), row.id); assert.equal(f.store.claimPending(), null); now += 31000; }
  assert.equal(f.store.claimPending(), null); assert(!f.store.hasPending());
  const saved = f.store.detail(row.id);
  assert.equal(saved.processing_pending, 0); assert.equal(saved.processing_error, 'PROCESSING_INTERRUPTED');
  assert(saved.original); assert(saved.retry_available);
  assert.equal(f.store.payload(row.id, 'original', 'request').body.toString('base64'), row.request);
});

for (const source of ['original', 'masked']) test('pending receipts cannot be exported and automatic delivery resumes without skipping: ' + source, t => {
  const f = fixture(); t.after(() => f.close()); const push = configurePush(f.store, source);
  const first = v2('pending-push-first'), second = v2('pending-push-second');
  f.store.receive(first); f.store.receive(second); f.store.processPending(second.id);
  const cursor = push.db.prepare('SELECT row_id FROM cl_push_cursor').get().row_id;
  assert.equal(push.scanAutomatic().created, 0);
  assert.equal(push.db.prepare('SELECT row_id FROM cl_push_cursor').get().row_id, cursor);
  assert.equal(push.preview({ filter: { search: first.id }, destinations: ['webhook'] }).eligible, 0);
  f.store.processPending(first.id);
  assert.equal(push.scanAutomatic().created, 2); assert.equal(push.scanAutomatic().created, 0);
  assert.equal(push.pendingCount(), 2);
});

test('background export yields before scanning or loading envelopes when reception has priority', async t => {
  const f = fixture(); t.after(() => f.close()); const push = configurePush(f.store);
  let allowed = false, scans = 0, sends = 0;
  const scan = push.scanAutomatic.bind(push); push.scanAutomatic = () => { scans++; return scan(); };
  const service = new ConversationPushService(push, { canWork: () => allowed,
    transport: { async send() { sends++; return { status: 'sent' }; } } });
  f.store.ingest(v2('export-priority'));
  assert.equal(await service.tick(), false); assert.equal(scans, 0); assert.equal(sends, 0);
  assert.equal(await service.jsonl.tick(), false);
  allowed = true; assert.equal(await service.tick(), true); assert.equal(sends, 1);
});

test('durable reception refuses capacity pressure or a full inbox without writing a partial record', t => {
  let used = 0;
  const f = fixture({ usedBytes: () => used }); t.after(() => f.close());
  used = 1024 ** 4;
  assert.deepEqual(f.store.receive(v2('full-reception')), { accepted: false, reason: 'capacity' });
  assert.equal(f.store.status().records, 0); assert(!f.store.hasPending());
  used = 0;
  // Occupy the finite scheduling slots without allocating ten thousand test bodies.
  const insert = f.store.db.prepare('INSERT INTO cl_processing(record_id,next_at) VALUES(?,?)');
  f.store.db.transaction(() => { for (let i = 0; i < 10000; i++) insert.run(i.toString(16).padStart(32, '0'), Date.now()); })();
  assert.deepEqual(f.store.receive(v2('full-inbox')), { accepted: false, reason: 'processor_busy' });
  assert.equal(f.store.status().records, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM cl_processing').get().n, 10000);
});

test('processing a durable SSE receipt preserves raw transport errors, diagnostics and push rejection', t => {
  const f = fixture(); t.after(() => f.close()); const push = configurePush(f.store, 'original');
  const row = v2('pending-sse-error', { protocol: 'SSE', complete: false, reason: 'read_error',
    response: Buffer.from('data: {"type":"response.completed","response":{"id":"resp_example","object":"response","status":"completed","output":[]}}\n\n').toString('base64') });
  const length = Buffer.from(row.request, 'base64').length;
  row.transport_diagnostics = { version: 1,
    request: { bytes: length, expected_bytes: length, eof: true, error: '', error_during_close: false },
    response: { bytes: Buffer.from(row.response, 'base64').length, expected_bytes: -1, eof: false, error: 'cancelled', error_during_close: true } };
  assert(f.store.receive(row).accepted); assert(f.store.processPending(row.id));
  const saved = f.store.detail(row.id);
  assert.equal(saved.reason, 'read_error'); assert.equal(saved.complete, false);
  assert.equal(saved.upstream_status, 'completed'); assert.equal(saved.completion_source, 'original');
  assert.deepEqual(saved.transport_diagnostics, row.transport_diagnostics);
  assert.equal(f.store.payload(row.id, 'original', 'response').body.toString('base64'), row.response);
  assert.equal(push.scanAutomatic().created, 0); assert.equal(push.pendingCount(), 0);
});

test('durable WebSocket processing preserves frame bytes and metadata while redacting a separate copy', t => {
  const f = fixture(); t.after(() => f.close());
  const row = v2('pending-frames', { protocol: 'WebSocket', method: 'WS', status: 101, request: '', response: '', frames: [
    { direction: 'out', at: 0, binary: false, body: Buffer.from('{"type":"response.create","response":{"model":"example-model","input":"alice@example.com"},"unknown":9007199254740993}').toString('base64') },
    { direction: 'in', at: 35, binary: false, body: Buffer.from('{"type":"response.completed","response":{"id":"resp_example","object":"response","status":"completed","output":[]}}').toString('base64') }
  ] });
  assert.equal(f.store.receive(row).body_sha256, row.body_sha256); assert(f.store.processPending(row.id));
  const saved = f.store.detail(row.id); assert.equal(saved.frames.length, 2); assert.equal(saved.processing_error, '');
  for (let index = 0; index < row.frames.length; index++) {
    assert.equal(f.store.payload(row.id, 'original', 'frame-' + index).body.toString('base64'), row.frames[index].body);
    for (const field of ['at', 'direction', 'binary']) assert.equal(saved.frames[index][field], row.frames[index][field]);
  }
  const masked = f.store.payload(row.id, 'masked', 'frame-0').text;
  assert(!masked.includes('alice@example.com')); assert(masked.includes('9007199254740993'));
});

test('blocked processing and processor death do not prevent durable reception, health, or collector policy', async t => {
  const f = fixture(), auth = new AuthService(f.config), archive = new ConversationArchiveService(f.store);
  archive.processor.canWork = () => false;
  const app = createApp({ config: f.config, database: {}, auth, conversations: f.store, conversationArchive: archive, messages: f.messages });
  const server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(async () => { await archive.stop(); auth.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); f.close(); });
  await archive.start(); await until(() => archive.processor.port);
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = { authorization: 'Bearer ' + f.token, 'content-type': 'application/json' };
  const first = v2('independent-receiver-one');
  const ack = await fetch(base + '/api/conversation-logs/ingest', { method: 'POST', headers, body: JSON.stringify(first) });
  assert.equal(ack.status, 200); assert.equal((await ack.json()).body_sha256, first.body_sha256);
  assert.equal(f.store.detail(first.id).processing_pending, 1);
  const old = archive.processor.child; old.kill('SIGKILL'); await until(() => archive.processor.child !== old);
  const start = performance.now(), second = v2('independent-receiver-two');
  const results = await Promise.all([
    fetch(base + '/api/conversation-logs/ingest', { method: 'POST', headers, body: JSON.stringify(second) }),
    fetch(base + '/healthz'), fetch(base + '/api/conversation-logs/collector-policy', { headers })
  ]);
  assert(results.every(result => result.status === 200)); await Promise.all(results.map(result => result.text()));
  assert(performance.now() - start < 1000, 'processor failure blocked receipt or lightweight endpoints');
  assert.equal(f.store.status().records, 2); assert.equal(f.store.status().processingPending, 2);
  archive.processor.canWork = () => true;
  await until(() => !f.store.hasPending());
  assert(f.store.detail(first.id).masked); assert(f.store.detail(second.id).masked);
});
