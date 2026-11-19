'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { fixture, event, exportBodyBytes } = require('./conversation-logs-fixture');
const { s3Receiver } = require('./conversation-s3-fixture');
const { ConversationLogStore } = require('../src/conversation-log-store');
const { ConversationPushStore } = require('../src/conversation-push-store');
const { ConversationPushService } = require('../src/services/conversation-push-service');
const { ConversationPushTransport } = require('../src/services/conversation-push-transport');
const { defaults } = require('../src/services/conversation-push-policy');
const { jsonlBytes } = require('../src/services/conversation-jsonl-format');
const { pacedBody, waitForTurn } = require('../src/services/conversation-jsonl-flow');

function setup(t, receiver, options = {}) {
  let now = Date.now();
  const f = fixture({ now: () => now });
  f.store.configure({ ...f.store.policy(), mode: 'original', retention: 0 });
  const open = () => {
    f.push = new ConversationPushStore(f.store, { now: () => now }).initialize();
    f.service = new ConversationPushService(f.push, options); f.jsonl = f.service.jsonl.store;
  };
  open();
  f.push.configure({ ...f.push.policy(), enabled: true, source: 'original', allowPrivateNetwork: true, retrySeconds: 5,
    s3: { ...f.push.policy().s3, enabled: true, endpoint: receiver.url, bucket: 'test-bucket', prefix: '',
      accessKeyId: 'fictional-id', secretAccessKey: 'fictional-secret', jsonl: { ...f.push.policy().s3.jsonl, uploadMiBPerSecond: 64 } } });
  f.advance = (ms = 10001) => { now += ms; };
  f.restart = async () => { await f.service.stop(); f.store.close(); f.store = new ConversationLogStore(f.directory, { now: () => now }).initialize(); open(); f.jsonl.recover(); };
  f.enqueue = () => {
    const input = { filter: {}, destinations: ['s3'] }, preview = f.push.preview(input);
    return f.push.enqueue({ ...input, previewToken: preview.previewToken, batchId: crypto.randomUUID() });
  };
  t.after(async () => { await f.service.stop(); f.store.close(); f.close(); });
  return f;
}
function large(f, seed = 'resume') {
  const request = Buffer.from(JSON.stringify({ model: 'Opus5', messages: [{ role: 'user', content: 'x'.repeat(9 * 1024 ** 2) }] }));
  const row = event(seed, { model: 'Opus5', request: request.toString('base64') }); f.store.ingest(row); f.enqueue(); return row;
}
const puts = receiver => receiver.requests.filter(row => row.method === 'PUT');
const creates = receiver => receiver.requests.filter(row => row.query.has('uploads'));
function reject(res, status = 503) { res.writeHead(status, { 'content-type': 'application/xml' }); res.end('<Error><Code>FixtureFailure</Code></Error>'); return false; }

test('original fallback choice, reason and multipart prefix survive a process and database restart',async t=>{
  let failed=false;
  const receiver=await s3Receiver({beforeRequest:async(entry,res)=>{
    if(entry.method==='PUT'&&entry.query.get('partNumber')==='2'&&!failed){failed=true;return reject(res);}
  }});t.after(()=>receiver.close());
  const f=setup(t,receiver);f.push.configure({...f.push.policy(),source:'masked'});
  const row=large(f,'fallback-resume');f.store.db.prepare('UPDATE cl_records SET masked=NULL WHERE id=?').run(row.id);await f.service.jsonl.tick();
  const file=f.jsonl.list().files[0];assert.equal(file.status,'pending');assert.equal(f.jsonl.get(file.id).uploaded_parts,1);
  const member=f.jsonl.db.prepare('SELECT payload_source,fallback_reason FROM cl_push_jsonl_members WHERE file_id=?').get(file.id);
  assert.deepEqual(member,{payload_source:'original',fallback_reason:'COPY_UNAVAILABLE'});
  await f.restart();f.advance();await f.service.jsonl.tick();
  assert.equal(f.jsonl.get(file.id).status,'sent');assert.equal(receiver.completed.length,1);
  assert.equal(puts(receiver).filter(entry=>entry.query.get('partNumber')==='1').length,1);
  const copy=JSON.parse(receiver.completed[0].body.toString());assert.deepEqual(Object.keys(copy),['request_id','request','response']);assert.equal(copy.request_id,row.request_id);
  assert.deepEqual(exportBodyBytes(copy,'request'),Buffer.from(row.request,'base64'));assert.deepEqual(exportBodyBytes(copy,'response'),Buffer.from(row.response,'base64'));
  assert.equal(f.jsonl.get(file.id).bytes,receiver.completed[0].body.length);
});

test('memory pressure between records preserves confirmed parts and retries beyond the network attempt limit',async t=>{
  let f,pressure=false;
  const receiver=await s3Receiver({beforeRequest:entry=>{
    if(entry.method==='PUT'&&entry.query.get('partNumber')==='1') {pressure=true;f.jsonl.memoryBudget=()=>0;}
  }});t.after(()=>receiver.close());
  f=setup(t,receiver);f.push.configure({...f.push.policy(),maxAttempts:1});
  const first=large(f,'memory-first'),second=event('memory-second',{model:'Opus5'});f.store.ingest(second);f.enqueue();
  f.push.db.prepare('UPDATE cl_push_jobs SET created_at=created_at+1 WHERE record_id=?').run(second.id);
  await f.service.jsonl.tick();assert(pressure);
  const file=f.jsonl.list().files[0],initial=f.jsonl.get(file.id);
  assert.equal(initial.status,'pending');assert.equal(initial.error_code,'EXPORT_MEMORY');assert.equal(initial.attempts,0);
  assert.equal(initial.uploaded_parts,1);assert(initial.upload_id);assert.equal(receiver.completed.length,0);
  for(let n=0;n<3;n++) {
    f.advance();await f.service.jsonl.tick();const saved=f.jsonl.get(file.id);
    assert.equal(saved.status,'pending');assert.equal(saved.attempts,0);assert.equal(saved.upload_id,initial.upload_id);
    assert.equal(saved.uploaded_parts,1);assert.equal(receiver.completed.length,0);
  }
  f.jsonl.memoryBudget=()=>Infinity;f.advance();await f.service.jsonl.tick();
  assert.equal(f.jsonl.get(file.id).status,'sent');assert.equal(creates(receiver).length,1);
  assert.equal(puts(receiver).filter(entry=>entry.query.get('partNumber')==='1').length,1);
  const records=receiver.completed[0].body.toString().trimEnd().split('\n').map(line=>JSON.parse(line));
  assert.deepEqual(records.map(row=>row.request_id),[first.request_id,second.request_id]);
  assert.deepEqual(exportBodyBytes(records[0],'request'),Buffer.from(first.request,'base64'));
  assert.equal(f.jsonl.get(file.id).attempts,1);
});
async function until(predicate) {
  const end = Date.now() + 5000;
  while (!predicate()) { assert(Date.now() < end, 'background progress timed out'); await new Promise(resolve => setTimeout(resolve, 20)); }
}

for (const legacyVersion of [1,2,3,4]) test(`legacy v${legacyVersion} multipart progress and flat key survive upgrade and skip the first network part`, async t => {
  let fail = true;
  const receiver = await s3Receiver({ beforeRequest: (entry, res) => fail && entry.query.get('partNumber') === '2' ? reject(res) : undefined });
  t.after(() => receiver.close()); const f = setup(t, receiver); const row = large(f);
  f.push.db.prepare('UPDATE cl_push_jobs SET envelope_version=?').run(legacyVersion);
  assert(f.jsonl.assignOne());
  const planned = f.jsonl.list().files[0], legacyKey = `${planned.day}/${planned.object_key.split('/').at(-1)}`;
  f.jsonl.db.prepare('UPDATE cl_push_jsonl_files SET object_key=? WHERE id=?').run(legacyKey, planned.id);
  await f.service.jsonl.tick(); const file = f.jsonl.list().files[0], saved = f.jsonl.get(file.id);
  assert.equal(saved.status, 'pending'); assert.equal(saved.uploaded_parts, 1); assert.equal(saved.uploaded_bytes, 8 * 1024 ** 2);
  assert.equal(f.jsonl.parts(saved).length, 1); assert.equal(receiver.completed.length, 0);
  if(legacyVersion===1) {
    f.push.db.exec('ALTER TABLE cl_push_jobs DROP COLUMN envelope_version');
    f.jsonl.db.exec('ALTER TABLE cl_push_jsonl_files DROP COLUMN envelope_version');
  }
  await f.restart(); fail = false; f.advance(); await f.service.jsonl.tick();
  const done = f.jsonl.get(file.id); assert.equal(done.status, 'sent'); assert.equal(done.uploaded_parts, 2);
  assert.equal(creates(receiver).length, 1); assert.deepEqual(puts(receiver).map(row => row.query.get('partNumber')), ['1','2','2']);
  assert(puts(receiver).every(entry => entry.query.get('uploadId') === saved.upload_id));
  assert.equal(done.object_key, legacyKey); assert.equal(receiver.completed[0].path, '/test-bucket/' + legacyKey);
  assert(receiver.requests.every(entry => entry.path === '/test-bucket/' + legacyKey));
  assert.equal(JSON.parse(receiver.completed[0].body).request,legacyVersion===1?row.request:Buffer.from(row.request,'base64').toString());
  const received=JSON.parse(receiver.completed[0].body);
  if(legacyVersion===4) { assert.deepEqual(Object.keys(received),['request_id','request','response']); assert.equal(received.request_id,row.request_id); }
  else if(legacyVersion===3)assert.deepEqual(Object.keys(received),['request','response']);
  else {assert.equal(received.schema,'sub2api.conversation.v'+legacyVersion);assert.equal(received.metadata.request_id,row.request_id);}
  assert.equal(done.sha256, crypto.createHash('sha256').update(receiver.completed[0].body).digest('hex'));
  assert.equal(f.jsonl.parts(done).length, 0);
});

test('a lost part receipt overwrites only the unconfirmed part with byte-identical data', async t => {
  let lose = true;
  const receiver = await s3Receiver({ beforeRequest: (entry, res) => {
    if (lose && entry.query.get('partNumber') === '2') { lose = false; res.end = () => { res.destroy(); return res; }; }
  } });
  t.after(() => receiver.close()); const f = setup(t, receiver); large(f, 'lost-part');
  await f.service.jsonl.tick(); const file = f.jsonl.list().files[0];
  assert.equal(f.jsonl.parts(file).length, 1); assert.equal([...receiver.uploads.values()][0].parts.size, 2);
  f.advance(); await f.service.jsonl.tick();
  assert.equal(f.jsonl.get(file.id).status, 'sent'); assert.equal(creates(receiver).length, 1);
  const sent = puts(receiver); assert.deepEqual(sent.map(row => row.query.get('partNumber')), ['1','2','2']);
  assert.deepEqual(sent[1].body, sent[2].body); assert.equal(receiver.completed.length, 1);
});

test('expired remote multipart restarts at the same key without reporting premature success', async t => {
  let fail = true;
  const receiver = await s3Receiver({ beforeRequest: (entry, res) => fail && entry.query.get('partNumber') === '2' ? reject(res) : undefined });
  t.after(() => receiver.close()); const f = setup(t, receiver); large(f, 'expired-upload');
  await f.service.jsonl.tick(); const file = f.jsonl.list().files[0]; receiver.uploads.clear(); fail = false;
  f.advance(); await f.service.jsonl.tick();
  assert.equal(f.jsonl.get(file.id).error_code, 'MULTIPART_RESTART'); assert.equal(f.jsonl.get(file.id).upload_id, ''); assert.equal(receiver.completed.length, 0);
  f.advance(20001); await f.service.jsonl.tick();
  assert.equal(f.jsonl.get(file.id).status, 'sent'); assert.equal(creates(receiver).length, 2);
  assert(creates(receiver).every(entry => entry.path.endsWith(file.object_key)));
});

test('invalid checkpoints are aborted and rebuilt within the retry limit', async t => {
  let fail = true;
  const receiver = await s3Receiver({ beforeRequest: (entry, res) => fail && entry.query.get('partNumber') === '2' ? reject(res) : undefined });
  t.after(() => receiver.close()); const f = setup(t, receiver); large(f, 'checkpoint');
  await f.service.jsonl.tick(); const file = f.jsonl.list().files[0];
  f.jsonl.db.prepare('UPDATE cl_push_jsonl_parts SET number=3 WHERE file_id=?').run(file.id); fail = false;
  f.advance(); await f.service.jsonl.tick();
  assert.equal(f.jsonl.get(file.id).error_code, 'MULTIPART_CHECKPOINT_INVALID'); assert.equal(receiver.completed.length, 0);
  f.advance(20001); await f.service.jsonl.tick();
  assert.equal(f.jsonl.get(file.id).status, 'sent'); assert.equal(creates(receiver).length, 2);
  assert.equal(receiver.requests.filter(row => row.method === 'DELETE').length, 1);
});

test('a changed confirmed prefix never reaches Complete or mutates archived request bytes', async t => {
  let fail = true;
  const receiver = await s3Receiver({ beforeRequest: (entry, res) => fail && entry.query.get('partNumber') === '2' ? reject(res) : undefined });
  t.after(() => receiver.close()); const f = setup(t, receiver); const row = large(f, 'prefix');
  await f.service.jsonl.tick(); const file = f.jsonl.list().files[0];
  f.jsonl.db.prepare('UPDATE cl_push_jsonl_parts SET sha256=? WHERE file_id=?').run(Buffer.alloc(32).toString('base64'), file.id); fail = false;
  f.advance(); await f.service.jsonl.tick();
  assert.equal(f.jsonl.get(file.id).status, 'failed'); assert.equal(f.jsonl.get(file.id).error_code, 'JSONL_CONTENT_CHANGED');
  assert.equal(receiver.completed.length, 0); assert.equal(f.store.payload(row.id, 'original', 'request').body.toString('base64'), row.request);
  f.advance(); await f.service.jsonl.tick(); assert.equal(receiver.uploads.size, 0);
});

test('archive priority pauses before the next part, renews guards, and resumes the same upload', async t => {
  let allowed = true;
  const receiver = await s3Receiver({ beforeRequest: entry => { if (entry.query.get('partNumber') === '1') allowed = false; } });
  t.after(() => receiver.close()); const f = setup(t, receiver, { canWork: () => allowed }); large(f, 'priority');
  const sending = f.service.jsonl.tick();
  try {
    await until(() => f.jsonl.list().files[0]?.pause_reason === 'archive_busy');
    const file = f.jsonl.list().files[0], lease = f.jsonl.get(file.id).lease_until;
    assert.equal(puts(receiver).length, 1); assert.equal(file.uploaded_parts, 1); f.advance(300000);
    await until(() => f.jsonl.get(file.id).lease_until > lease);
    assert.equal(puts(receiver).length, 1); allowed = true; await sending;
    assert.equal(f.jsonl.get(file.id).status, 'sent'); assert.equal(f.jsonl.get(file.id).pause_reason, ''); assert.equal(creates(receiver).length, 1);
  } finally { allowed = true; f.service.jsonl.invalidate(); await sending; }
});

test('exclusion during a priority pause prevents completing a resumable upload', async t => {
  let allowed = true;
  const receiver = await s3Receiver({ beforeRequest: entry => { if (entry.query.get('partNumber') === '1') allowed = false; } });
  t.after(() => receiver.close()); const f = setup(t, receiver, { canWork: () => allowed }); large(f, 'priority-exclude');
  const sending = f.service.jsonl.tick();
  try {
    await until(() => f.jsonl.list().files[0]?.pause_reason === 'archive_busy');
    f.store.configure({ ...f.store.policy(), excludedUserIds: [2] }); await sending;
    allowed = true; await f.service.jsonl.tick();
    assert.equal(receiver.completed.length, 0); assert.equal(receiver.uploads.size, 0); assert.equal(puts(receiver).length, 1);
    assert.equal(f.push.list().items[0].status, 'cancelled');
  } finally { allowed = true; f.service.jsonl.invalidate(); await sending; }
});

test('stale lease acknowledgements cannot clear or overwrite a recovered upload', async t => {
  const receiver = await s3Receiver(); t.after(() => receiver.close()); const f = setup(t, receiver);
  f.store.ingest(event('lease')); f.enqueue(); f.jsonl.assignOne(); const file = f.jsonl.list().files[0]; f.jsonl.seal(file.id);
  const stale = f.jsonl.claim(); assert(f.jsonl.uploadId(stale, 'fake-upload'));
  f.jsonl.recover(); const current = f.jsonl.claim();
  assert.equal(f.jsonl.clearUpload(file.id, 'fake-upload', stale.lease_token), 0);
  assert.equal(f.jsonl.clearUpload(file.id, 'fake-upload'), 0); assert.equal(f.jsonl.abandonUpload(stale, 'fake-upload'), 0);
  assert.equal(f.jsonl.savePart(stale, 'fake-upload', { number: 1, bytes: 1, etag: 'etag', sha256: 'hash' }), false);
  assert.equal(f.jsonl.finish(stale, { status: 'sent' }), 0); assert.equal(f.jsonl.get(file.id).lease_token, current.lease_token);
});

test('legacy upload state is cleaned before resuming and schema migration keeps manifests intact', async t => {
  const receiver = await s3Receiver(); t.after(() => receiver.close()); const f = setup(t, receiver);
  f.store.ingest(event('migration')); f.enqueue(); f.jsonl.assignOne(); const file = f.jsonl.list().files[0];
  f.jsonl.seal(file.id); f.jsonl.db.prepare("UPDATE cl_push_jsonl_files SET upload_id='legacy' WHERE id=?").run(file.id);
  const snapshot = f.jsonl.db.prepare('SELECT job_id,metadata,fingerprint FROM cl_push_jsonl_members').all();
  f.jsonl.db.exec('DROP TABLE cl_push_jsonl_parts');
  for (const column of ['payload_source','fallback_reason']) f.jsonl.db.exec(`ALTER TABLE cl_push_jsonl_members DROP COLUMN ${column}`);
  for (const column of ['uploaded_bytes','uploaded_parts','upload_version','pause_reason','first_at']) f.jsonl.db.exec(`ALTER TABLE cl_push_jsonl_files DROP COLUMN ${column}`);
  await f.restart(); assert.deepEqual(f.jsonl.db.prepare('SELECT job_id,metadata,fingerprint FROM cl_push_jsonl_members').all(), snapshot);
  assert.equal(f.jsonl.claim(), null); await f.service.jsonl.tick();
  assert.equal(f.jsonl.get(file.id).status, 'sent'); assert.equal(receiver.requests[0].method, 'DELETE');
});

test('backlog counts pending bytes and expedites a current-day file before archive expiry', async t => {
  const receiver = await s3Receiver(); t.after(() => receiver.close()); const f = setup(t, receiver);
  f.store.configure({ ...f.store.policy(), retention: 1 });
  f.push.configure({ ...f.push.policy(), automatic: true });
  const at = Date.now(); f.store.ingest(event('backlog', { at })); f.push.scanAutomatic(); await f.service.jsonl.tick();
  const file = f.jsonl.list().files[0], backlog = f.jsonl.list().backlog;
  assert.equal(file.status, 'open'); assert.equal(backlog.files, 1); assert.equal(backlog.bytes, file.bytes); assert.equal(backlog.records, 1);
  assert.equal(backlog.firstAt, at); assert.equal(backlog.expiryAt, at + 86400000); assert.equal(backlog.atRisk, false);
  f.advance(19 * 3600000); assert.equal(f.jsonl.list().backlog.atRisk, true);
  f.jsonl.sealDue(); assert.equal(f.jsonl.get(file.id).status, 'pending'); await f.service.jsonl.tick();
  assert.equal(f.jsonl.get(file.id).status, 'sent'); assert.equal(f.jsonl.list().backlog.files, 0);
});

test('rate-limited bodies preserve bytes, pace chunks and cancel a pending wait', async () => {
  let now = 0; const waits = [], body = Buffer.alloc(200000, 51), sent = [];
  for await (const chunk of pacedBody(body, 65536, null, { now: () => now, wait: async ms => { waits.push(ms); now += ms; } })) sent.push(chunk);
  assert.deepEqual(Buffer.concat(sent), body); assert(waits.length >= 2); assert(now >= 2000);
  const controller = new AbortController();
  const stream = pacedBody(Buffer.alloc(200000), 65536, controller.signal, { wait: async () => { controller.abort(); throw new Error('cancelled'); } });
  await assert.rejects(async () => { for await (const _ of stream) { /* Drain until cancellation. */ } }, /cancelled|ABORTED/);
  const phases = []; let checks = 0;
  const waiting = waitForTurn({ canWork: () => false, guard: () => { checks++; }, signal: controller.signal, onPause: reason => phases.push(reason) });
  await assert.rejects(waiting, /ABORTED/); assert.deepEqual(phases, ['archive_busy','']); assert(checks >= 2);
});

test('low upload rates receive a per-part timeout budget and are actually paced over HTTP', async t => {
  const receiver = await s3Receiver(); t.after(() => receiver.close()); const transport = new ConversationPushTransport();
  const policy = { ...structuredClone(defaults), allowPrivateNetwork: true, timeoutSeconds: 3,
    s3: { ...defaults.s3, endpoint: receiver.url, bucket: 'test-bucket', accessKeyId: 'id', secretAccessKey: 'secret',
      jsonl: { ...defaults.s3.jsonl, uploadMiBPerSecond: 0.25 } } };
  const envelope = { body: 'x'.repeat(1310720) }, start = performance.now();
  const result = await transport.sendJsonl(policy, { id: 'paced', source: 'test', object_key: 'paced.jsonl', bytes: jsonlBytes(envelope), records: 1 }, [envelope]);
  assert.equal(result.status, 'sent', JSON.stringify(result)); assert(performance.now() - start >= 4200);
  assert.deepEqual(JSON.parse(receiver.completed[0].body), envelope);
});
