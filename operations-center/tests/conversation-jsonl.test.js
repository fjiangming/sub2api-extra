'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { fixture, event, rawRequest, rawResponse, exportBodyBytes } = require('./conversation-logs-fixture');
const { s3Receiver } = require('./conversation-s3-fixture');
const { ConversationPushStore } = require('../src/conversation-push-store');
const { ConversationPushService } = require('../src/services/conversation-push-service');
const { ConversationPushSupervisor } = require('../src/services/conversation-push-supervisor');
const { ConversationPushTransport } = require('../src/services/conversation-push-transport');
const { jsonlChunks, jsonlBytes, dayAt } = require('../src/services/conversation-jsonl-format');
const { deliveryBody } = require('../src/services/conversation-envelope');
const { AuthService } = require('../src/auth');
const { createApp } = require('../src/app');

async function until(predicate, timeout = 15000) {
  const end = Date.now() + timeout;
  while (!predicate()) { assert(Date.now() < end, 'Timed out waiting for background JSONL work'); await new Promise(resolve => setTimeout(resolve, 40)); }
}
function setup(t, { now = Date.now, jsonlOptions, supervisor = false, memoryBudgetBytes } = {}) {
  const f = fixture({ now }); f.store.configure({ ...f.store.policy(), mode: 'original', retention: 0 });
  const push = new ConversationPushStore(f.store, { now }).initialize();
  const service = supervisor ? new ConversationPushSupervisor(push, { memoryBudgetBytes }) : new ConversationPushService(push, { jsonlOptions });
  t.after(async () => { await service.stop(); f.close(); });
  return { ...f, push, service, jsonl: service.jsonl.store };
}
function configure(f, url = 'https://storage.example', extra = {}) {
  const current = f.push.policy();
  return f.push.configure({ ...current, enabled: true, source: 'original', allowPrivateNetwork: url.startsWith('http:'), ...extra,
    s3: { ...current.s3, enabled: true, endpoint: url, bucket: 'incoming-04-20260624', prefix: '', accessKeyId: 'fictional-id', secretAccessKey: 'fictional-secret', ...extra.s3,
      jsonl: { ...current.s3.jsonl, uploadMiBPerSecond: 64, ...extra.s3?.jsonl } } });
}
function enqueue(f, filter = {}) {
  const input = { filter, destinations: ['s3'] }, preview = f.push.preview(input);
  return f.push.enqueue({ ...input, previewToken: preview.previewToken, batchId: crypto.randomUUID() });
}
function lines(receiver) { return receiver.completed.flatMap(file => file.body.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line))); }

test('JSONL defaults, legacy JSON policy migration, CAS, timezone and exact 10 GB limit', t => {
  const f = setup(t); const initial = f.push.policy();
  assert.equal(initial.s3.format, 'jsonl'); assert.equal(initial.s3.jsonl.maxFileBytes, 10000000000);
  const legacy = structuredClone(initial); delete legacy.s3.format; delete legacy.s3.jsonl;
  f.push.db.prepare('UPDATE cl_push_policies SET body=? WHERE version=?').run(f.store.seal(legacy, 'push-policy:1'), 1);
  assert.equal(f.push.policy().s3.format, 'json'); configure(f);
  assert.equal(f.push.policy().s3.format, 'json');
  assert.throws(() => configure(f, 'https://storage.example', { s3: { jsonl: { maxFileBytes: 10000000001, timezone: 'UTC', flushMinutes: 0 } } }));
  assert.throws(() => configure(f, 'https://storage.example', { s3: { jsonl: { maxFileBytes: 10000000000, timezone: 'invalid-zone', flushMinutes: 0 } } }));
  assert.equal(dayAt(Date.parse('2026-06-25T16:01:00Z'), 'Asia/Shanghai'), '2026-06-26');
  assert.equal(dayAt(Date.parse('2026-06-25T16:01:00Z'), 'UTC'), '2026-06-25');
});

test('streamed JSONL equals JSON.stringify, preserving escapes and surrogate pairs at chunk boundaries', () => {
  const envelope = { text: 'x'.repeat(16383) + '\uD83D\uDE00\n"\\\r' + 'x'.repeat(17000), nested: [null, { v: 9007199254740991 }], base64: Buffer.alloc(100000, 37).toString('base64') };
  const text = [...jsonlChunks(envelope)].join('');
  assert.equal(text, JSON.stringify(envelope) + '\n'); assert.equal(jsonlBytes(envelope), Buffer.byteLength(text));
  assert.deepEqual(JSON.parse(text), envelope); assert.equal(text.split('\n').length, 2);
});

test('historical files group by date and model, preserve raw HTTP/SSE/WS bytes and use unique timestamped paths', async t => {
  const receiver = await s3Receiver(); t.after(() => receiver.close());
  const f = setup(t); configure(f, receiver.url);
  const at = Date.parse('2026-06-25T10:00:00Z'), sse = 'data: {"delta":"one\\ntwo","n":1.2300}\r\n\r\ndata: [DONE]\r\n\r\n';
  const frames = [{ direction: 'out', at: 0, binary: true, body: Buffer.from([0, 255, 10]).toString('base64') }];
  f.store.ingest(event('group-http', { at, model: 'Opus5' }));
  f.store.ingest(event('group-sse', { at: at + 1, request_id:event('group-http').request_id, model: 'Opus5', protocol: 'SSE', response: Buffer.from(sse).toString('base64') }));
  f.store.ingest(event('group-ws', { at, model: 'Fable5', protocol: 'WebSocket', frames }));
  f.store.ingest(event('group-next-day', { at: at + 86400000, model: 'Opus5' })); enqueue(f);
  await f.service.jsonl.tick(); await f.service.jsonl.tick(); await f.service.jsonl.tick();
  assert.equal(receiver.objects.size, 3); assert.equal(f.push.list().counts.find(row => row.status === 'sent').count, 4);
  const received = lines(receiver); assert.equal(received.length, 4);
  for (const value of received) {assert.deepEqual(Object.keys(value),['request_id','request','response']);if(!Array.isArray(value.request))assert.equal(value.request,rawRequest);}
  assert.deepEqual(received.map(value=>value.request_id).sort(),['group-http','group-http','group-ws','group-next-day'].map(seed=>event(seed).request_id).sort());
  assert(received.some(value => value.response === rawResponse));
  assert(received.some(value => value.response === sse));
  assert.deepEqual(received.find(value => Array.isArray(value.request)),{request_id:event('group-ws').request_id,request:[rawRequest,'data:application/octet-stream;base64,AP8K'],response:[rawResponse]});
  const opus = receiver.completed.find(file => file.path.startsWith('/incoming-04-20260624/2026-06-25/Opus5-'));
  assert.equal(opus.body.toString().trimEnd().split('\n').length, 2);
  assert.match(opus.path, /Opus5-2026-06-25-\d{8}T\d{9}Z-[a-f0-9]{16}\.jsonl$/);
  assert.equal(f.jsonl.db.prepare('SELECT COUNT(*) n FROM cl_push_jsonl_members').get().n, 0);
});

test('rolling uses encoded UTF-8 bytes and never splits or truncates a log record', async t => {
  const receiver = await s3Receiver(); t.after(() => receiver.close());
  const f = setup(t, { jsonlOptions: { maxFileBytes: 900 } }); configure(f, receiver.url);
  for (let index = 0; index < 4; index++) f.store.ingest(event('rolling-' + index)); enqueue(f);
  for (let index = 0; index < 8; index++) await f.service.jsonl.tick();
  assert(receiver.completed.length >= 2); assert.equal(lines(receiver).length, 4);
  for (const file of receiver.completed) { assert(file.body.length <= 900); assert(file.body.at(-1) === 10); }
  for (const row of lines(receiver)) assert.equal(row.request, rawRequest);
  assert.equal(new Set(receiver.completed.map(file => file.path)).size, receiver.completed.length);
});

test('planner rolls at the actual 10 GB counter without 32-bit overflow', t => {
  const f = setup(t); configure(f, 'https://storage.example', { automatic: true });
  f.store.ingest(event('ten-gb-first')); f.push.scanAutomatic(); assert(f.jsonl.assignOne());
  const file = f.jsonl.list().files[0];
  f.jsonl.db.prepare('UPDATE cl_push_jsonl_files SET bytes=9999999999 WHERE id=?').run(file.id);
  f.store.ingest(event('ten-gb-second')); f.push.scanAutomatic(); assert(f.jsonl.assignOne());
  assert.equal(f.jsonl.get(file.id).status, 'pending'); assert.equal(f.jsonl.get(file.id).bytes, 9999999999);
  assert.equal(f.jsonl.list().files.length, 2);
});

for(const legacyVersion of [1,2,3]) test(`an open v${legacyVersion} daily file is sealed before v4 records and uploads unchanged`, async t => {
  let now=Date.now();const receiver=await s3Receiver();t.after(()=>receiver.close());
  const f=setup(t,{now:()=>now});configure(f,receiver.url,{automatic:true});
  const old=event('old-daily',{at:now,model:'Opus5'});f.store.ingest(old);f.push.scanAutomatic();
  f.push.db.prepare('UPDATE cl_push_jobs SET envelope_version=? WHERE record_id=?').run(legacyVersion,old.id);
  assert(f.jsonl.assignOne());const legacy=f.jsonl.list().files[0];
  assert.equal(legacy.status,'open');assert.equal(legacy.envelope_version,legacyVersion);
  const before=[];for await(const body of f.jsonl.envelopes(f.jsonl.get(legacy.id),()=>{},async()=>{})) before.push(body);
  const legacyBytes=Buffer.from(before.map(body=>JSON.stringify(deliveryBody(body))+'\n').join(''));
  now+=10;const next=event('text-daily',{at:now,model:'Opus5'});f.store.ingest(next);assert.equal(f.push.scanAutomatic().created,1);
  assert(f.jsonl.assignOne());assert.equal(f.jsonl.get(legacy.id).status,'pending');
  const text=f.jsonl.list().files.find(file=>file.id!==legacy.id);assert.equal(text.envelope_version,4);assert.equal(text.status,'open');
  assert.equal(text.day,legacy.day);assert.equal(text.model,legacy.model);assert.notEqual(text.object_key,legacy.object_key);
  await f.service.jsonl.tick();assert.equal(receiver.completed.length,1);assert.deepEqual(receiver.completed[0].body,legacyBytes);
  assert.equal(f.jsonl.get(legacy.id).sha256,crypto.createHash('sha256').update(legacyBytes).digest('hex'));
  f.jsonl.flush();await f.service.jsonl.tick();assert.equal(receiver.completed.length,2);
  const received=lines(receiver);
  if(legacyVersion===3)assert.deepEqual(Object.keys(received[0]),['request','response']);
  else assert.equal(received[0].schema,'sub2api.conversation.v'+legacyVersion);
  assert.deepEqual(received[1],{request_id:next.request_id,request:rawRequest,response:rawResponse});
  assert.equal(received[0].request,legacyVersion===1?old.request:rawRequest);
  assert.equal(f.push.list({status:'sent'}).total,2);
});

test('today stays open until flush or timezone rollover; a timer can flush low-volume logs', async t => {
  let now = Date.now(); const receiver = await s3Receiver(); t.after(() => receiver.close());
  const f = setup(t, { now: () => now }); configure(f, receiver.url, { automatic: true });
  f.store.ingest(event('today', { at: now })); f.push.scanAutomatic(); await f.service.jsonl.tick();
  assert.equal(receiver.completed.length, 0); assert.equal(f.jsonl.list().files[0].status, 'open');
  f.jsonl.flush(); await f.service.jsonl.tick(); assert.equal(receiver.completed.length, 1);
  f.store.ingest(event('tomorrow', { at: now })); f.push.scanAutomatic(); await f.service.jsonl.tick();
  now += 86400000; await f.service.jsonl.tick(); assert.equal(receiver.completed.length, 2);
  configure(f, receiver.url, { automatic: true, s3: { jsonl: { maxFileBytes: 10000000000, timezone: 'UTC', flushMinutes: 1 } } });
  f.store.ingest(event('timer', { at: now })); f.push.scanAutomatic(); await f.service.jsonl.tick(); now += 60001;
  await f.service.jsonl.tick(); assert.equal(receiver.completed.length, 3);
});

test('real multipart upload uses bounded 8 MiB parts, per-part checksums and final SHA-256', async t => {
  const receiver = await s3Receiver(); t.after(() => receiver.close());
  const f = setup(t); configure(f, receiver.url);
  const request = Buffer.from(JSON.stringify({ model: 'Opus5', messages: [{ role: 'user', content: 'x'.repeat(10 * 1024 ** 2) }] }));
  f.store.ingest(event('multipart', { model: 'Opus5', request: request.toString('base64') })); enqueue(f);
  await f.service.jsonl.tick();
  const parts = receiver.requests.filter(row => row.method === 'PUT');
  assert.equal(parts.length, 2); assert.equal(parts[0].body.length, 8 * 1024 ** 2); assert(parts[1].body.length < parts[0].body.length);
  assert.deepEqual(exportBodyBytes(lines(receiver)[0],'request'), request);
  const file = f.jsonl.list().files[0]; assert.equal(file.status, 'sent'); assert.equal(file.bytes, receiver.completed[0].body.length);
  assert.equal(file.sha256, crypto.createHash('sha256').update(receiver.completed[0].body).digest('hex'));
});

test('timing and size configuration changes preserve a daily manifest and its pending records', async t => {
  let now = Date.now(); const receiver = await s3Receiver(); t.after(() => receiver.close()); const f = setup(t, { now: () => now });
  configure(f, receiver.url, { automatic: true }); f.store.ingest(event('settings', { at: now })); f.push.scanAutomatic(); await f.service.jsonl.tick();
  const file = f.jsonl.list().files[0];
  configure(f, receiver.url, { automatic: true, s3: { jsonl: { maxFileBytes: 2000000000, timezone: 'Asia/Shanghai', flushMinutes: 1 } } });
  now += 60001; await f.service.jsonl.tick(); assert.equal(f.jsonl.get(file.id).status, 'sent'); assert.equal(lines(receiver).length, 1);
  assert.equal(f.push.list().items[0].status, 'sent');
});

test('failed multipart is never marked sent; retry reuses the upload ID, object key and identical bytes', async t => {
  let rejectPart = true;
  const receiver = await s3Receiver({ beforeRequest: (entry, res) => {
    if (rejectPart && entry.method === 'PUT') { res.writeHead(403, { 'content-type': 'application/xml' }); res.end('<Error><Code>AccessDenied</Code></Error>'); return false; }
  } }); t.after(() => receiver.close());
  const f = setup(t); configure(f, receiver.url); f.store.ingest(event('retry-file')); enqueue(f); await f.service.jsonl.tick();
  const file = f.jsonl.list().files[0]; assert.equal(file.status, 'failed'); assert.equal(f.push.list().items[0].status, 'failed'); assert.equal(receiver.completed.length, 0);
  rejectPart = false; f.jsonl.retry(file.id); await f.service.jsonl.tick();
  assert.equal(f.jsonl.get(file.id).status, 'sent'); assert.equal(receiver.completed[0].path, '/incoming-04-20260624/' + file.object_key);
  assert(!receiver.requests.some(row => row.method === 'DELETE')); assert.equal(receiver.uploads.size, 0);
  assert.equal(receiver.requests.filter(row => row.query.has('uploads')).length, 1);
  const sent = receiver.requests.filter(row => row.method === 'PUT');
  assert.equal(sent[0].query.get('uploadId'), sent[1].query.get('uploadId')); assert.deepEqual(sent[0].body, sent[1].body);
});

test('a lost Complete receipt retries byte-identical content at the same key without duplicating lines', async t => {
  let loseReceipt = true, now = Date.now();
  const receiver = await s3Receiver({ beforeRequest: (entry, res) => {
    if (loseReceipt && entry.method === 'POST' && entry.query.has('uploadId')) {
      loseReceipt = false; res.end = () => { res.destroy(); return res; };
    }
  } }); t.after(() => receiver.close());
  const f = setup(t, { now: () => now }); configure(f, receiver.url, { retrySeconds: 5 });
  const row = event('unknown-complete'); f.store.ingest(row); enqueue(f); await f.service.jsonl.tick();
  const file = f.jsonl.list().files[0]; assert.equal(file.status, 'pending'); assert.equal(receiver.completed.length, 1);
  f.store.db.prepare('UPDATE cl_records SET processed_at=processed_at+1,processing_policy_version=processing_policy_version+1 WHERE id=?').run(row.id);
  now += 5001; await f.service.jsonl.tick();
  assert.equal(f.jsonl.get(file.id).status, 'pending'); assert.equal(f.jsonl.get(file.id).error_code, 'MULTIPART_RESTART');
  assert.equal(receiver.completed.length, 1);
  now += 10001; await f.service.jsonl.tick();
  assert.equal(f.jsonl.get(file.id).status, 'sent'); assert.equal(receiver.completed.length, 2); assert.equal(receiver.objects.size, 1);
  assert.equal(receiver.completed[0].path, receiver.completed[1].path); assert.deepEqual(receiver.completed[0].body, receiver.completed[1].body);
  assert.deepEqual(JSON.parse([...receiver.objects.values()][0].toString()),{request_id:row.request_id,request:rawRequest,response:rawResponse});
});

test('masked JSONL includes marked original fallbacks and rebuilds staged copies after rule changes', async t => {
  const receiver = await s3Receiver(); t.after(() => receiver.close()); const f = setup(t);
  f.store.configure({ ...f.store.policy(), mode: 'dual' }); configure(f, receiver.url, { source: 'masked', automatic: true });
  f.store.ingest(event('masked-jsonl')); f.store.ingest(event('bad-mask', { response: Buffer.from('{invalid').toString('base64') }));
  f.push.scanAutomatic(); await f.service.jsonl.tick(); assert.equal(f.push.list().total, 2);
  f.jsonl.flush(); await f.service.jsonl.tick();
  assert.equal(lines(receiver).length, 2);
  const safe=lines(receiver).find(row=>row.response!=='{invalid'),failed=lines(receiver).find(row=>row.response==='{invalid');
  assert.deepEqual(Object.keys(safe),['request_id','request','response']);assert.equal(safe.request_id,event('masked-jsonl').request_id);assert(!safe.request.includes('alice@example.com'));
  assert.equal(failed.request_id,event('bad-mask').request_id);
  assert.equal(failed.request,rawRequest);
  assert.equal(failed.response,'{invalid');
  f.store.ingest(event('outdated-mask')); f.push.scanAutomatic(); await f.service.jsonl.tick();
  f.store.configure({ ...f.store.policy(), email: !f.store.policy().email }); f.jsonl.flush(); await f.service.jsonl.tick();
  assert.equal(lines(receiver).length, 3);assert(f.jsonl.list().files.some(file=>file.status==='cancelled'&&file.error_code==='REDACTION_OUTDATED'));
  const outdated=lines(receiver).find(row=>row.request===rawRequest&&row.response===rawResponse);
  assert.deepEqual(Object.keys(outdated),['request_id','request','response']);assert.equal(outdated.request_id,event('outdated-mask').request_id);
});

test('buffered members do not exhaust the pending queue or prematurely split a daily model file', async t => {
  const receiver = await s3Receiver(); t.after(() => receiver.close()); const f = setup(t);
  configure(f, receiver.url, { automatic: true, queueLimit: 100 });
  for (let index = 0; index < 101; index++) f.store.ingest(event('pressure-' + index));
  f.push.scanAutomatic(); f.push.scanAutomatic(); assert(f.push.scanAutomatic().full);
  await f.service.jsonl.tick(); assert.equal(receiver.completed.length, 0); assert(f.push.pendingCount() < 100);
  assert.equal(f.push.scanAutomatic().created, 1);
  f.jsonl.flush(); for (let index = 0; index < 8; index++) await f.service.jsonl.tick();
  assert.equal(receiver.completed.length, 1); assert.equal(lines(receiver).length, 101);
});

test('exclusion after staging discards the old file and requeues only permitted complete logs', async t => {
  const receiver = await s3Receiver(); t.after(() => receiver.close());
  const f = setup(t); configure(f, receiver.url, { automatic: true });
  f.store.ingest(event('allow', { user_id: 2 })); f.store.ingest(event('deny', { user_id: 3 })); f.push.scanAutomatic(); await f.service.jsonl.tick();
  f.store.configure({ ...f.store.policy(), excludedUserIds: [3] }); f.jsonl.flush();
  await f.service.jsonl.tick(); await f.service.jsonl.tick();
  assert.equal(lines(receiver).length, 1); assert.deepEqual(Object.keys(lines(receiver)[0]),['request_id','request','response']);assert.equal(lines(receiver)[0].request_id,event('allow').request_id);
  assert.equal(f.push.list({status:'sent'}).items[0].user_id,2);
  assert(f.jsonl.list().files.some(file => file.status === 'cancelled')); assert.equal(f.push.list({ status: 'cancelled' }).items[0].error_code, 'COLLECTION_EXCLUDED');
});

test('batch cancellation during multipart prevents Complete and leaves no published partial object', async t => {
  let release, started; const ready = new Promise(resolve => { started = resolve; }); const wait = new Promise(resolve => { release = resolve; });
  const receiver = await s3Receiver({ beforeRequest: async entry => { if (entry.method === 'PUT') { started(); await wait; } } }); t.after(() => receiver.close());
  const f = setup(t); configure(f, receiver.url); f.store.ingest(event('cancel-stream')); const batch = enqueue(f);
  const sending = f.service.jsonl.tick(); await ready; f.service.cancelBatch(batch.id); release(); await sending;
  assert.equal(receiver.completed.length, 0); assert.equal(f.push.list().items[0].status, 'cancelled');
  await f.service.jsonl.tick(); assert(f.jsonl.list().files.some(file => file.status === 'cancelled'));
});

test('archive expiry cancels an unuploaded manifest rather than producing a shorter file', async t => {
  const f = setup(t); configure(f, 'https://storage.example', { automatic: true });
  const row = event('expired-manifest'); f.store.ingest(row); f.push.scanAutomatic(); await f.service.jsonl.tick();
  f.store.db.prepare('DELETE FROM cl_records WHERE id=?').run(row.id); f.jsonl.reconcile();
  assert.equal(f.jsonl.list().files[0].status, 'cancelled'); assert.equal(f.jsonl.db.prepare('SELECT COUNT(*) n FROM cl_push_jsonl_members').get().n, 0);
});

test('restart preserves frozen metadata and manifest while lost upload leases recover', async t => {
  const receiver = await s3Receiver(); t.after(() => receiver.close()); const f = setup(t);
  configure(f, receiver.url, { automatic: true }); f.store.ingest(event('restart')); f.push.scanAutomatic(); await f.service.jsonl.tick();
  const file = f.jsonl.list().files[0]; f.jsonl.seal(file.id); const leased = f.jsonl.claim(); assert(leased);
  f.jsonl.recover(); await f.service.jsonl.tick();
  assert.equal(f.jsonl.get(file.id).status, 'sent'); assert.equal(lines(receiver).length, 1);
  assert.equal(f.jsonl.finish(leased, { status: 'failed', errorCode: 'LATE' }), 0);
});

test('resource admission and an oversized single line fail visibly without truncating the archive', async t => {
  const f = setup(t, { jsonlOptions: { memoryBudget: () => 0 } }); configure(f, 'https://storage.example', { maxAttempts: 1 });
  const row = event('memory'); f.store.ingest(row); enqueue(f); await f.service.jsonl.tick();
  assert.equal(f.push.list().items[0].error_code, 'EXPORT_MEMORY'); assert.equal(f.jsonl.list().files.length, 0);
  assert.equal(f.store.payload(row.id, 'original', 'request').body.toString(), rawRequest);
  f.jsonl.memoryBudget = () => Infinity; f.jsonl.maxFileBytes = 1; f.push.retry(f.push.list().items[0].id); await f.service.jsonl.tick();
  assert.equal(f.push.list().items[0].error_code, 'JSONL_RECORD_TOO_LARGE'); assert.equal(f.store.payload(row.id, 'original', 'request').body.toString(), rawRequest);
});

test('JSONL planning fails invalid request IDs visibly without buffering or uploading incomplete lines',async t=>{
  const receiver=await s3Receiver();t.after(()=>receiver.close());const f=setup(t);configure(f,receiver.url);
  const row=event('jsonl-missing-id');assert(f.store.ingest(row).accepted);
  f.store.db.prepare("UPDATE cl_records SET request_id='' WHERE id=?").run(row.id);enqueue(f);
  await f.service.jsonl.tick();
  const job=f.push.list().items[0];assert.equal(job.status,'failed');assert.equal(job.error_code,'EXPORT_REQUEST_ID');assert.equal(job.attempts,1);
  assert.equal(f.jsonl.list().files.length,0);assert.equal(receiver.requests.length,0);
  assert.equal(f.store.payload(row.id,'original','request').body.toString(),rawRequest);
});

test('an invalid frozen request ID blocks multipart completion and cleans up the unfinished upload',async t=>{
  let now=Date.now();const receiver=await s3Receiver();t.after(()=>receiver.close());const f=setup(t,{now:()=>now});configure(f,receiver.url);
  const row=event('jsonl-invalid-frozen-id');f.store.ingest(row);enqueue(f);assert(f.jsonl.assignOne());
  const member=f.jsonl.db.prepare('SELECT job_id,metadata FROM cl_push_jsonl_members').get();
  const metadata=f.store.open(member.metadata,'jsonl-metadata:'+member.job_id);delete metadata.request_id;
  f.jsonl.db.prepare('UPDATE cl_push_jsonl_members SET metadata=? WHERE job_id=?').run(f.store.seal(metadata,'jsonl-metadata:'+member.job_id),member.job_id);
  f.jsonl.seal(f.jsonl.list().files[0].id);await f.service.jsonl.tick();
  const file=f.jsonl.list().files[0];assert.equal(file.status,'failed');assert.equal(file.error_code,'EXPORT_REQUEST_ID');assert.equal(file.attempts,1);
  assert.equal(receiver.completed.length,0);assert.equal(receiver.requests.filter(entry=>entry.method==='PUT').length,0);
  assert.equal(f.jsonl.get(file.id).upload_version,0);now+=3600001;await f.service.jsonl.tick();
  assert.equal(receiver.uploads.size,0);assert.equal(f.jsonl.get(file.id).upload_id,'');assert.equal(f.jsonl.get(file.id).attempts,1);
  assert.equal(f.store.db.prepare('SELECT request_id FROM cl_records WHERE id=?').get(row.id).request_id,row.request_id);
});

test('production supervisor uploads in a child, recovers after a crash and keeps API-side work responsive', async t => {
  const receiver = await s3Receiver(); t.after(() => receiver.close()); const f = setup(t, { supervisor: true });
  configure(f, receiver.url, { automatic: true }); f.service.start(); await until(() => f.service.ready);
  assert.notEqual(f.service.child.pid, process.pid); const row = event('supervised'); f.store.ingest(row);
  await until(() => f.jsonl.list().files.some(file => file.status === 'open')); const original = f.jsonl.list().files[0];
  const child = f.service.child; child.kill('SIGKILL'); await until(() => f.service.child && f.service.child !== child && f.service.ready);
  f.service.flush(); await until(() => f.jsonl.get(original.id).status === 'sent');
  assert.equal(lines(receiver).length, 1); assert.equal(f.service.status({}).workerReady, true);
  assert.equal(lines(receiver)[0].request, rawRequest);
});

test('administrator policy requests finish while the production child is waiting on an S3 part', async t => {
  let release, started; const ready = new Promise(resolve => { started = resolve; }); const waiting = new Promise(resolve => { release = resolve; });
  const receiver = await s3Receiver({ beforeRequest: async entry => { if (entry.method === 'PUT') { started(); await waiting; } } }); t.after(() => receiver.close());
  const f = setup(t, { supervisor: true }); configure(f, receiver.url, { automatic: true });
  const auth = new AuthService(f.config); t.after(() => auth.close());
  const app = createApp({ config: f.config, auth, database: {}, conversations: f.store, conversationPush: f.service, messages: f.messages, settings: { getStatus: () => ({ setupRequired: false }) } });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = 'http://127.0.0.1:' + server.address().port;
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: f.config.adminPassword }) });
  const session = await login.json(); f.service.start(); await until(() => f.service.ready);
  f.store.ingest(event('responsive')); await until(() => f.jsonl.list().files.some(file => file.status === 'open')); f.service.flush();
  await ready;
  try {
    for (let index = 0; index < 5; index++) {
      const result = await fetch(base + '/api/conversation-logs/push/policy', { headers: { authorization: 'Session ' + session.sessionToken }, signal: AbortSignal.timeout(1500) });
      assert.equal(result.status, 200); assert.equal((await result.json()).s3.format, 'jsonl'); assert.equal(receiver.completed.length, 0);
    }
  } finally { release(); }
  await until(() => receiver.completed.length === 1);
});

test('an interrupted cancellation resumes requeueing members after restart', async t => {
  const receiver = await s3Receiver(); t.after(() => receiver.close()); const f = setup(t); configure(f, receiver.url);
  f.store.ingest(event('cancel-recover-a')); f.store.ingest(event('cancel-recover-b')); enqueue(f);
  f.jsonl.assignOne(); f.jsonl.assignOne(); const file = f.jsonl.list().files[0];
  f.jsonl.db.prepare("UPDATE cl_push_jsonl_files SET status='cancelled',error_code='DELIVERY_INVALIDATED' WHERE id=?").run(file.id);
  await f.service.jsonl.tick(); await f.service.jsonl.tick();
  assert.equal(lines(receiver).length, 2); assert.equal(f.push.list().counts.find(row => row.status === 'sent').count, 2);
});

test('disk reserve rejection keeps the complete archive and failed diagnostic uploads are aborted', async t => {
  const receiver = await s3Receiver({ beforeRequest: (entry, res) => {
    if (entry.method === 'PUT') { res.writeHead(403, { 'content-type': 'application/xml' }); res.end('<Error><Code>AccessDenied</Code></Error>'); return false; }
  } }); t.after(() => receiver.close()); const f = setup(t); configure(f, receiver.url, { maxAttempts: 1 });
  const row = event('space'); f.store.ingest(row); enqueue(f); f.store.freeBytes = () => 0; await f.service.jsonl.tick();
  assert.equal(f.push.list().items[0].error_code, 'EXPORT_CAPACITY'); assert.equal(f.jsonl.list().files.length, 0);
  assert.equal(f.store.payload(row.id, 'original', 'request').body.toString(), rawRequest);
  assert.equal((await f.service.test('s3')).status, 'failed'); assert.equal(receiver.uploads.size, 0);
});

test('JSONL multipart still blocks unsafe addresses and never trusts remote error fields', async () => {
  const transport = new ConversationPushTransport(), envelope = { schema: 'test' };
  const policy = { ...structuredClone(require('../src/services/conversation-push-policy').defaults), timeoutSeconds: 3,
    s3: { endpoint: 'https://169.254.169.254', bucket: 'test-bucket', region: 'us-east-1', prefix: '', forcePathStyle: true, accessKeyId: 'id', secretAccessKey: 'secret' } };
  const result = await transport.sendJsonl(policy, { id: 'test', source: 'test', object_key: 'test.jsonl', records: 1, bytes: jsonlBytes(envelope) }, [envelope]);
  assert.equal(result.errorCode, 'ADDRESS_BLOCKED'); assert.equal(result.status, 'failed');
});
