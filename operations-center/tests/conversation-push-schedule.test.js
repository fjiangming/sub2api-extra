'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { fixture, event, rawRequest, rawResponse } = require('./conversation-logs-fixture');
const { s3Receiver } = require('./conversation-s3-fixture');
const { ConversationLogStore } = require('../src/conversation-log-store');
const { ConversationPushStore } = require('../src/conversation-push-store');
const { ConversationPushService } = require('../src/services/conversation-push-service');
const { targetHash } = require('../src/services/conversation-push-policy');

const today = Date.parse('2026-11-20T04:00:00Z');
const midnight = Date.parse('2026-11-20T16:00:00Z');
function setup(t, clock = { value: today }) {
  const now = () => clock.value, f = fixture({ now });
  f.clock = clock; f.now = now;
  f.store.configure({ ...f.store.policy(), mode: 'original', retention: 0 });
  f.push = new ConversationPushStore(f.store, { now }).initialize();
  t.after(async () => { await f.service?.stop(); f.store.close(); fs.rmSync(f.directory, { recursive: true, force: true }); });
  return f;
}
function configure(f, extra = {}) {
  const current = f.push.policy();
  return f.push.configure({ ...current, enabled: true, automatic: true, automaticMode: 'previous_day', source: 'original', ...extra,
    webhook: { ...current.webhook, enabled: true, url: 'https://receiver.example/logs', ...extra.webhook },
    s3: { ...current.s3, ...extra.s3, jsonl: { ...current.s3.jsonl, ...extra.s3?.jsonl } } });
}
function ingest(f, seed, extra = {}) { const row = event(seed, { at: f.now(), ...extra }); f.store.ingest(row); return row; }
function enqueue(f, row, destination = 'webhook') {
  const input = { filter: { request_id: row.request_id }, destinations: [destination] }, preview = f.push.preview(input);
  return f.push.enqueue({ ...input, previewToken: preview.previewToken, batchId: crypto.randomUUID() });
}
function reopen(f) {
  f.store.close(); f.store = new ConversationLogStore(f.directory, { now: f.now }).initialize();
  f.push = new ConversationPushStore(f.store, { now: f.now }).initialize();
}

test('automatic mode migrates to realtime, old clients preserve a daily choice and invalid explicit modes reject', t => {
  const f = setup(t); assert.equal(f.push.policy().automaticMode, 'realtime');
  const old = structuredClone(f.push.policy()); delete old.automaticMode;
  f.push.db.prepare('UPDATE cl_push_policies SET body=? WHERE version=1').run(f.store.seal(old, 'push-policy:1'));
  assert.equal(f.push.policy().automaticMode, 'realtime');
  configure(f, { webhook: { token: 'fictional-token' } });
  const client = structuredClone(f.push.policy()); delete client.automaticMode;
  const result = f.push.configure(client); assert.equal(result.automaticMode, 'previous_day');
  assert(!JSON.stringify(result).includes('fictional-token'));
  for (const automaticMode of ['daily', '', null, false, 1, {}]) {
    assert.throws(() => configure(f, { automaticMode }), { code: 'CONVERSATION_PUSH_INVALID' });
  }
});

test('daily eligibility uses local calendar midnight, including UTC and 23/25-hour DST days', t => {
  const f = setup(t); configure(f);
  assert.equal(f.push.automaticCutoff(), Date.parse('2026-11-19T16:00:00Z'));
  const policy = structuredClone(f.push.policy()); policy.s3.jsonl.timezone = 'UTC';
  assert.equal(f.push.automaticCutoff(policy), Date.parse('2026-11-20T00:00:00Z'));
  policy.s3.jsonl.timezone = 'America/New_York';
  for (const [first, second, hours] of [['2026-03-08', '2026-03-09', 23], ['2026-11-01', '2026-11-02', 25]]) {
    f.clock.value = Date.parse(first + 'T18:00:00Z'); const start = f.push.automaticCutoff(policy);
    f.clock.value = Date.parse(second + 'T18:00:00Z');
    assert.equal((f.push.automaticCutoff(policy) - start) / 3600000, hours);
  }
  policy.automaticMode = 'realtime'; assert.equal(f.push.automaticCutoff(policy), null);
});

test('today waits while late yesterday and older arrivals pass; the midnight boundary is exclusive', t => {
  const f = setup(t); const history = ingest(f, 'daily-preexisting', { at: today - 86400000 });
  configure(f);
  const current = ingest(f, 'daily-current'), late = ingest(f, 'daily-late', { at: today - 86400000 });
  const older = ingest(f, 'daily-older', { at: today - 2 * 86400000 });
  f.clock.value = midnight - 1; const future = ingest(f, 'daily-future', { at: midnight });
  assert.equal(f.push.scanAutomatic().created, 2);
  assert.deepEqual(f.push.list().items.map(row => row.record_id).sort(), [late.id, older.id].sort());
  assert.deepEqual(f.push.automaticStatus(), { waiting: 2, ready: 0, mode: 'previous_day', timezone: 'Asia/Shanghai' });
  f.clock.value = midnight - 1; assert.equal(f.push.scanAutomatic().created, 0);
  f.clock.value = midnight; assert.equal(f.push.scanAutomatic().created, 1);
  assert(f.push.list().items.some(row => row.record_id === current.id));
  assert(!f.push.list().items.some(row => row.record_id === history.id || row.record_id === future.id));
  assert.equal(f.push.automaticStatus().waiting, 1);
});

test('delayed references survive restart and scan only compact metadata; new current-day logs stay delayed', t => {
  const f = setup(t); configure(f); const row = ingest(f, 'daily-restart'); f.push.scanAutomatic();
  const cursor = f.push.db.prepare('SELECT row_id FROM cl_push_cursor').get().row_id;
  reopen(f); assert.equal(f.push.automaticStatus().waiting, 1);
  assert.equal(f.push.db.prepare('SELECT row_id FROM cl_push_cursor').get().row_id, cursor);
  f.clock.value = midnight; const next = ingest(f, 'daily-after-restart');
  const prepare = f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare = sql => { assert(!/FROM cl_records/i.test(sql), 'automatic scheduling must not read archive body rows'); return prepare(sql); };
  assert.equal(f.push.scanAutomatic().created, 1); assert.equal(f.push.scanAutomatic().created, 0);
  f.store.db.prepare = prepare;
  assert.equal(f.push.list().items[0].record_id, row.id);
  assert.equal(f.push.db.prepare('SELECT record_id FROM cl_push_auto_waiting').get().record_id, next.id);
});

test('switching modes preserves queued identities and releases delayed data without duplicate delivery', t => {
  const f = setup(t); configure(f, { automaticMode: 'realtime' });
  const queued = ingest(f, 'mode-queued'); assert.equal(f.push.scanAutomatic().created, 1);
  const before = f.push.list().items[0], hash = targetHash(f.push.policy(), 'webhook');
  configure(f); assert.equal(targetHash(f.push.policy(), 'webhook'), hash);
  const delayed = ingest(f, 'mode-delayed'); assert.equal(f.push.scanAutomatic().created, 0);
  assert.equal(f.push.list().items[0].id, before.id);
  configure(f, { automaticMode: 'realtime' }); assert.equal(f.push.scanAutomatic().created, 1);
  assert.equal(f.push.automaticStatus().waiting, 0);
  assert.equal(enqueue(f, queued).created, 0); assert.equal(enqueue(f, delayed).created, 0);
  configure(f); f.clock.value = midnight; assert.equal(f.push.scanAutomatic().created, 0);
  assert.equal(f.push.list().total, 2);
});

test('manual history sends today immediately and next-day automatic work deduplicates it', async t => {
  const f = setup(t); configure(f); const row = ingest(f, 'daily-manual'); f.push.scanAutomatic();
  assert.equal(enqueue(f, row).created, 1);
  const delivered = [];
  f.service = new ConversationPushService(f.push, { transport: { send: async (_policy, _target, body) => { delivered.push(body); return { status: 'sent' }; } } });
  await f.service.tick(); assert.equal(delivered.length, 1); assert.equal(delivered[0].metadata.request_id, row.request_id);
  f.clock.value = midnight; await f.service.tick(); assert.equal(delivered.length, 1);
  assert.equal(f.push.automaticStatus().waiting, 0); assert.equal(f.push.list().total, 1);
});

test('pausing automatic pushing retains delayed records but does not enroll logs from the paused interval', t => {
  const f = setup(t); configure(f); const delayed = ingest(f, 'daily-pause-saved'); f.push.scanAutomatic();
  configure(f, { automatic: false }); const ignored = ingest(f, 'daily-pause-ignored'); f.push.scanAutomatic();
  f.clock.value = midnight; configure(f); assert.equal(f.push.scanAutomatic().created, 1);
  assert.equal(f.push.list().items[0].record_id, delayed.id);
  assert(!f.push.list().items.some(row => row.record_id === ignored.id)); assert.equal(f.push.automaticStatus().waiting, 0);
});

test('a full queue retains due references and resumes after a slot is released', t => {
  const f = setup(t); configure(f, { queueLimit: 100 });
  for (let index = 0; index < 101; index++) ingest(f, 'daily-capacity-' + index);
  for (let index = 0; index < 3; index++) f.push.scanAutomatic();
  assert.equal(f.push.automaticStatus().waiting, 101); f.clock.value = midnight;
  assert.equal(f.push.scanAutomatic().created, 50); assert.equal(f.push.scanAutomatic().created, 50);
  assert(f.push.scanAutomatic().full); assert.equal(f.push.automaticStatus().waiting, 1);
  const job = f.push.claim(); f.push.finish(job, { status: 'sent' });
  assert.equal(f.push.scanAutomatic().created, 1); assert.equal(f.push.automaticStatus().waiting, 0);
  assert.equal(f.push.list().total, 101);
});

test('due records recheck processing, metadata, collection scope and original fallback at publication', t => {
  const f = setup(t); configure(f, { source: 'masked' });
  const pending = event('daily-pending', { at: today }); f.store.receive(pending);
  f.push.scanAutomatic(); assert.equal(f.push.automaticStatus().waiting, 1);
  f.clock.value = midnight; assert(f.push.scanAutomatic().processing);
  f.store.processPending(pending.id); assert.equal(f.push.scanAutomatic().created, 1);
  const preparing = ingest(f, 'daily-preparing'); f.push.scanAutomatic();
  const excluded = ingest(f, 'daily-excluded', { user_id: 3 }); f.push.scanAutomatic();
  const failed = ingest(f, 'daily-fallback', { response: Buffer.from('{invalid').toString('base64') }); f.push.scanAutomatic();
  const model = ingest(f, 'daily-model', { model: 'unselected' }); f.push.scanAutomatic();
  f.store.configure({ ...f.store.policy(), mode: 'dual', excludedUserIds: [3], modelFilterEnabled: true, allowedModels: ['example-model'] });
  f.clock.value += 86400000;
  f.store.db.prepare("UPDATE cl_record_metadata SET fingerprint='' WHERE id=?").run(preparing.id);
  assert(f.push.scanAutomatic().preparing); assert(f.push.automaticStatus().waiting > 0);
  f.store.backfillMetadata(); f.push.scanAutomatic();
  assert.equal(f.push.automaticStatus().waiting, 0);
  assert(!f.push.list().items.some(row => [excluded.id, model.id].includes(row.record_id)));
  assert(f.push.list().items.some(row => row.record_id === failed.id));
  assert(f.push.list().fallbacks.some(row => row.code === 'PROCESSING_FAILED'));
});

test('archive deletion and retention remove delayed references even on a connection without foreign keys', t => {
  const f = setup(t); configure(f); const row = ingest(f, 'daily-delete'); f.push.scanAutomatic();
  f.push.db.pragma('foreign_keys = OFF'); f.push.db.prepare('DELETE FROM cl_records WHERE id=?').run(row.id);
  assert.equal(f.push.automaticStatus().waiting, 0); f.push.db.pragma('foreign_keys = ON');
  ingest(f, 'daily-expire'); f.push.scanAutomatic(); assert.equal(f.push.automaticStatus().waiting, 1);
  f.store.configure({ ...f.store.policy(), retention: 1 }); f.clock.value += 2 * 86400000;
  f.store.prune(); assert.equal(f.push.automaticStatus().waiting, 0);
});

test('daily JSONL batches span automatic scans without premature sealing and preserve model paths and exact bodies', async t => {
  const receiver = await s3Receiver(); t.after(() => receiver.close());
  const f = setup(t); configure(f, { allowPrivateNetwork: true, webhook: { enabled: false },
    s3: { enabled: true, endpoint: receiver.url, bucket: 'fictional-daily', prefix: '', accessKeyId: 'fictional-id', secretAccessKey: 'fictional-secret', jsonl: { uploadMiBPerSecond: 64 } } });
  f.service = new ConversationPushService(f.push); const jsonl = f.service.jsonl.store;
  const rows = [];
  for (let index = 0; index < 125; index++) rows.push(ingest(f, 'daily-jsonl-' + index, { model: 'Opus5.5' }));
  for (let index = 0; index < 3; index++) await f.service.tick();
  assert.equal(f.push.automaticStatus().waiting, 125); await f.service.jsonl.tick();
  assert.equal(receiver.requests.length, 0); assert.equal(jsonl.list().files.length, 0);
  f.clock.value = midnight;
  // New-day arrivals and a late prior-day record must not split the prior day's partially planned file.
  for (let index = 0; index < 60; index++) ingest(f, 'daily-jsonl-current-' + index, { model: 'Opus5.5' });
  rows.push(ingest(f, 'daily-jsonl-late', { at: today, model: 'Opus5.5' }));
  assert.equal(f.push.scanAutomatic().created, 50);
  for (let index = 0; index < 3; index++) await f.service.jsonl.tick();
  assert.equal(receiver.requests.length, 0); assert.equal(jsonl.list().files[0].records, 50);
  for (let index = 0; index < 12 && !receiver.completed.length; index++) { await f.service.tick(); await f.service.jsonl.tick(); }
  assert.equal(receiver.completed.length, 1); assert.equal(f.push.automaticStatus().waiting, 60);
  const file = receiver.completed[0];
  assert.match(file.path, /^\/fictional-daily\/2026-11-20\/Opus5\.5\/Opus5\.5-2026-11-20-\d{8}T\d{9}Z-[a-f0-9]{16}\.jsonl$/);
  const bodies = file.body.toString('utf8').trimEnd().split('\n').map(JSON.parse);
  assert.equal(bodies.length, rows.length);
  assert.deepEqual(bodies.map(row => row.request_id).sort(), rows.map(row => row.request_id).sort());
  for (const body of bodies) assert.deepEqual(body, { request_id: body.request_id, request: rawRequest, response: rawResponse });
  assert.equal(f.service.status({}).automatic.waiting, 60);
  assert.equal(f.push.list({ status: 'sent' }).total, 126);
});

test('manual JSONL history is not held by a daily automatic record still being processed', async t => {
  const receiver = await s3Receiver(); t.after(() => receiver.close());
  const f = setup(t); configure(f, { allowPrivateNetwork: true, webhook: { enabled: false },
    s3: { enabled: true, endpoint: receiver.url, bucket: 'fictional-daily', prefix: '', accessKeyId: 'fictional-id', secretAccessKey: 'fictional-secret', jsonl: { uploadMiBPerSecond: 64 } } });
  f.service = new ConversationPushService(f.push);
  const pending = event('daily-manual-jsonl-pending', { at: today }); f.store.receive(pending); f.push.scanAutomatic();
  f.clock.value = midnight;
  const current = ingest(f, 'daily-manual-jsonl-current'); assert.equal(enqueue(f, current, 's3').created, 1);
  assert(f.push.scanAutomatic().processing); assert(f.push.automaticBacklog());
  await f.service.jsonl.tick(); assert.equal(receiver.completed.length, 1);
  assert.equal(JSON.parse(receiver.completed[0].body.toString()).request_id, current.request_id);
  assert.equal(f.push.automaticStatus().waiting, 1);
});

test('realtime rollover uploads yesterday intact while today still has pending jobs', async t => {
  const receiver = await s3Receiver(); t.after(() => receiver.close());
  const f = setup(t); configure(f, { automaticMode: 'realtime', allowPrivateNetwork: true, webhook: { enabled: false },
    s3: { enabled: true, endpoint: receiver.url, bucket: 'fictional-rollover', prefix: '', accessKeyId: 'fictional', secretAccessKey: 'fictional', jsonl: { uploadMiBPerSecond: 64 } } });
  f.service = new ConversationPushService(f.push);
  const first = ingest(f, 'rollover-first', { model: 'Opus5.5' });
  f.push.scanAutomatic(); await f.service.jsonl.tick(); assert.equal(receiver.completed.length, 0);
  f.clock.value = midnight;
  const late = ingest(f, 'rollover-late', { at: today, model: 'Opus5.5' }); f.push.scanAutomatic();
  f.clock.value++;
  for (let index = 0; index < 60; index++) ingest(f, 'rollover-today-' + index, { model: 'Opus5.5' });
  assert.equal(f.push.scanAutomatic().created, 50);
  await f.service.jsonl.tick();
  assert.equal(receiver.completed.length, 1);
  assert.match(receiver.completed[0].path, /^\/fictional-rollover\/2026-11-20\/Opus5\.5\/Opus5\.5-.*\.jsonl$/);
  const bodies = receiver.completed[0].body.toString().trimEnd().split('\n').map(JSON.parse);
  assert.deepEqual(bodies, [first, late].map(row => ({ request_id: row.request_id, request: rawRequest, response: rawResponse })));
  assert(f.push.list({ status: 'pending' }).total > 0);
  assert(f.service.jsonl.store.list().files.some(file => file.day === '2026-11-21' && file.status === 'open'));
});

test('unscanned late arrivals and delayed same-day jobs hold a realtime tail until its complete membership is assigned', async t => {
  const receiver = await s3Receiver(); t.after(() => receiver.close());
  const f = setup(t); configure(f, { automaticMode: 'realtime', allowPrivateNetwork: true, webhook: { enabled: false },
    s3: { enabled: true, endpoint: receiver.url, bucket: 'fictional-late', prefix: '', accessKeyId: 'fictional', secretAccessKey: 'fictional', jsonl: { uploadMiBPerSecond: 64 } } });
  f.service = new ConversationPushService(f.push);
  const first = ingest(f, 'rollover-unscanned-first', { model: 'Opus5.5' });
  f.push.scanAutomatic(); await f.service.jsonl.tick(); f.clock.value = midnight;
  for (let index = 0; index < 60; index++) ingest(f, 'rollover-unscanned-today-' + index, { model: 'Opus5.5' });
  const late = ingest(f, 'rollover-unscanned-late', { at: today, model: 'Opus5.5' });
  assert.equal(f.push.scanAutomatic().created, 50); await f.service.jsonl.tick();
  assert.equal(receiver.requests.length, 0);
  assert.equal(f.push.scanAutomatic().created, 11);
  f.push.db.prepare('UPDATE cl_push_jobs SET next_at=? WHERE record_id=?').run(midnight + 3600000, late.id);
  for (let index = 0; index < 3; index++) await f.service.jsonl.tick();
  assert.equal(receiver.requests.length, 0);
  assert.equal(f.service.jsonl.store.list().files.find(file => file.day === '2026-11-20').records, 1);
  f.clock.value += 3600000; await f.service.jsonl.tick();
  assert.equal(receiver.completed.length, 1);
  const bodies = receiver.completed[0].body.toString().trimEnd().split('\n').map(JSON.parse);
  assert.deepEqual(bodies, [first, late].map(row => ({ request_id: row.request_id, request: rawRequest, response: rawResponse })));
  assert.equal(f.push.list({ status: 'sent' }).total, 2);
  assert.equal(f.push.list({ status: 'buffered' }).total, 60);
});

test('natural rollover scopes backlog by target, model and day and conservatively holds unknown metadata without reading bodies', t => {
  const f = setup(t); configure(f, { automatic: false,
    s3: { enabled: true, endpoint: 'https://storage.example/', bucket: 'fictional-scoped', accessKeyId: 'fictional', secretAccessKey: 'fictional' } });
  const policy = f.push.policy();
  f.push.configure({ ...policy, platforms: [{ ...policy.s3, id: 'partner', type: 's3', bucket: 'fictional-partner' }] });
  f.service = new ConversationPushService(f.push); const jsonl = f.service.jsonl.store;
  const first = ingest(f, 'scoped-first', { model: 'Opus5.5' }); enqueue(f, first, 's3'); assert(jsonl.assignOne());
  const file = jsonl.list().files[0], destination = f.push.policy().s3;
  f.push.db.prepare('UPDATE cl_push_jsonl_files SET force_flush=0 WHERE id=?').run(file.id);
  f.clock.value = midnight;
  const otherModel = ingest(f, 'scoped-other-model', { at: today, model: 'Fable5' }); enqueue(f, otherModel, 's3');
  const otherPlatform = ingest(f, 'scoped-other-platform', { at: today, model: 'Opus5.5' }); enqueue(f, otherPlatform, 'partner');
  const webhook = ingest(f, 'scoped-webhook', { at: today, model: 'Opus5.5' }); enqueue(f, webhook);
  const current = ingest(f, 'scoped-today', { model: 'Opus5.5' }); enqueue(f, current, 's3');
  assert.equal(jsonl.dayBacklog(file, destination), false);
  const same = ingest(f, 'scoped-same', { at: today, model: 'Opus5.5' }); enqueue(f, same, 's3');
  f.push.db.prepare('UPDATE cl_push_jobs SET next_at=? WHERE record_id=?').run(midnight + 3600000, same.id);
  const prepare = f.push.db.prepare.bind(f.push.db);
  f.push.db.prepare = sql => { assert(!/\bcl_records\b/i.test(sql), 'rollover must not read archive body rows'); return prepare(sql); };
  try {
    assert.equal(jsonl.sealDue(), 0);
    prepare("UPDATE cl_push_jobs SET status='cancelled' WHERE record_id=?").run(same.id);
    prepare('DELETE FROM cl_record_metadata WHERE id=?').run(otherModel.id);
    assert.equal(jsonl.sealDue(), 0);
  } finally { f.push.db.prepare = prepare; }
  f.store.backfillMetadata();
  assert.equal(jsonl.sealDue(), 1); assert.equal(jsonl.get(file.id).status, 'pending');
});

test('rollover backlog uses exclusive local midnight boundaries for both short and long DST days', t => {
  for (const [startText, endText, hours] of [
    ['2026-03-08T05:00:00Z', '2026-03-09T04:00:00Z', 23],
    ['2026-11-01T04:00:00Z', '2026-11-02T05:00:00Z', 25]
  ]) {
    const start = Date.parse(startText), end = Date.parse(endText), f = setup(t, { value: start });
    configure(f, { automatic: false, webhook: { enabled: false },
      s3: { enabled: true, endpoint: 'https://storage.example/', bucket: 'fictional-dst', accessKeyId: 'fictional', secretAccessKey: 'fictional', jsonl: { timezone: 'America/New_York' } } });
    f.service = new ConversationPushService(f.push); const jsonl = f.service.jsonl.store;
    const first = ingest(f, 'dst-first-' + hours); enqueue(f, first, 's3'); assert(jsonl.assignOne());
    const file = jsonl.list().files[0], destination = f.push.policy().s3;
    f.push.db.prepare('UPDATE cl_push_jsonl_files SET force_flush=0 WHERE id=?').run(file.id); f.clock.value = end;
    for (const at of [start - 1, end]) enqueue(f, ingest(f, 'dst-outside-' + at, { at }), 's3');
    assert.equal(jsonl.dayBacklog(file, destination), false);
    const last = ingest(f, 'dst-last-' + hours, { at: end - 1 }); enqueue(f, last, 's3');
    assert.equal(jsonl.sealDue(), 0);
    f.push.db.prepare("UPDATE cl_push_jobs SET status='cancelled' WHERE record_id=?").run(last.id);
    assert.equal(jsonl.sealDue(), 1);
  }
});

test('future-dated open files wait for their own day instead of naturally sealing early', t => {
  const f = setup(t, { value: midnight - 30000 }); configure(f, { automaticMode: 'realtime', webhook: { enabled: false },
    s3: { enabled: true, endpoint: 'https://storage.example/', bucket: 'fictional-future', accessKeyId: 'fictional', secretAccessKey: 'fictional' } });
  f.service = new ConversationPushService(f.push); const jsonl = f.service.jsonl.store;
  ingest(f, 'rollover-future', { at: midnight }); f.push.scanAutomatic(); assert(jsonl.assignOne());
  assert.equal(jsonl.sealDue(), 0); f.clock.value = midnight;
  assert.equal(jsonl.sealDue(), 0); f.clock.value += 86400000;
  assert.equal(jsonl.sealDue(), 1);
});

test('automatic backlog includes realtime webhook arrivals and unknown metadata but only scans compact indexes', t => {
  const f = setup(t); configure(f, { automaticMode: 'realtime' });
  const row = ingest(f, 'backlog-webhook');
  const prepare = f.push.db.prepare.bind(f.push.db);
  f.push.db.prepare = sql => { assert(!/\bcl_records\b/i.test(sql), 'backlog queries must not read archive body rows'); return prepare(sql); };
  try {
    assert.equal(f.push.automaticBacklog(), true);
    assert.equal(f.push.automaticBacklog({ destination: 's3' }), false);
    prepare('DELETE FROM cl_record_metadata WHERE id=?').run(row.id);
    assert.equal(f.push.automaticBacklog({ start: today, end: midnight, model: 'Opus5.5', destination: 'webhook' }), true);
  } finally { f.push.db.prepare = prepare; }
  f.store.backfillMetadata(); assert.equal(f.push.scanAutomatic().created, 1);
  assert.equal(f.push.automaticBacklog(), false);
});
