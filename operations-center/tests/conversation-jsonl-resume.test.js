'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { S3Client, UploadPartCommand } = require('@aws-sdk/client-s3');
const { fixture, event, exportBodyBytes } = require('./conversation-logs-fixture');
const { s3Receiver } = require('./conversation-s3-fixture');
const { ConversationLogStore } = require('../src/conversation-log-store');
const { ConversationPushStore } = require('../src/conversation-push-store');
const { ConversationPushService } = require('../src/services/conversation-push-service');
const { ConversationPushTransport } = require('../src/services/conversation-push-transport');
const { defaults } = require('../src/services/conversation-push-policy');
const { jsonlBytes } = require('../src/services/conversation-jsonl-format');
const { pacedBody, waitForTurn, withArchiveRetry, prepareWithMemoryWait } = require('../src/services/conversation-jsonl-flow');

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

test('concurrent archive writes cannot discard an acknowledged multipart receipt or its capacity ledger',async t=>{
  const receiver=await s3Receiver();t.after(()=>receiver.close());
  const f=setup(t,receiver),other=new ConversationLogStore(f.directory).openReader();
  const row=event('concurrent-part',{model:'Opus5'});f.store.ingest(row);f.enqueue();
  const get=f.jsonl.get.bind(f.jsonl);let competed=false,conflict;
  f.jsonl.get=id=>{
    const file=get(id);
    if(f.jsonl.db.inTransaction&&file?.status==='running'&&file.upload_id&&!competed) {
      competed=true;
      try { other.db.prepare("UPDATE cl_push_cursor SET record_id='concurrent-worker' WHERE singleton=1").run(); }
      catch(error) { conflict=error; }
    }
    return file;
  };
  try { await f.service.jsonl.tick(); }
  finally { f.jsonl.get=get;other.close(); }
  const file=f.jsonl.list().files[0];
  assert.equal(file.status,'sent');assert.equal(file.attempts,1);
  assert(competed);assert.match(conflict?.code||'',/^SQLITE_BUSY/);
  assert.equal(receiver.completed.length,1);assert.equal(puts(receiver).length,1);
  const delivered=receiver.completed[0].body,usage=f.push.billing.report().items[0];
  assert.equal(usage.bytes,delivered.length);
  assert.equal(usage.sha256,crypto.createHash('sha256').update(delivered).digest('hex'));
  assert.deepEqual(exportBodyBytes(JSON.parse(delivered.toString()),'request'),Buffer.from(row.request,'base64'));
});

test('historical capacity receipts are backfilled atomically during concurrent archive writes',async t=>{
  const receiver=await s3Receiver();t.after(()=>receiver.close());
  const f=setup(t,receiver);f.store.ingest(event('concurrent-history',{model:'Opus5'}));f.enqueue();
  await f.service.jsonl.tick();assert.equal(receiver.completed.length,1);
  f.push.db.exec('DELETE FROM cl_push_storage_usage');
  const other=new ConversationLogStore(f.directory).openReader(),read=f.push.policy.bind(f.push);
  let competed=false,conflict;
  f.push.policy=(...args)=>{
    const policy=read(...args);
    if(f.push.db.inTransaction&&!competed) {
      competed=true;
      try { other.db.prepare("UPDATE cl_push_cursor SET record_id='concurrent-worker' WHERE singleton=1").run(); }
      catch(error) { conflict=error; }
    }
    return policy;
  };
  try {
    assert.equal(f.push.billing.backfill(),1);
    f.push.policy=read;
    assert(competed);assert.match(conflict?.code||'',/^SQLITE_BUSY/);
    assert.equal(f.push.billing.report().summary.bytes,receiver.completed[0].body.length);
    other.db.exec('BEGIN IMMEDIATE');
    assert.equal(f.push.billing.backfill(),0,'an empty backfill must not compete for the writer');
    assert.equal(f.push.billing.report().summary.files,1);
  } finally { f.push.policy=read;if(other.db.inTransaction)other.db.exec('ROLLBACK');other.close(); }
});

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
  f=setup(t,receiver,{jsonlOptions:{memoryWaitMs:0}});f.push.configure({...f.push.policy(),maxAttempts:1});
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

async function within(promise, timeoutMs = 2000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Upload did not stop within its deadline')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

for (const mode of ['cancellation', 'timeout', 'watchdog']) test(`an SDK part that ignores ${mode} cannot retain the upload slot`, async t => {
  const receiver = await s3Receiver(); t.after(() => receiver.close());
  const f = setup(t, receiver); f.push.configure({ ...f.push.policy(), timeoutSeconds: 3 });
  const row = large(f, 'sdk-ignores-' + mode), send = S3Client.prototype.send;
  let release, held = false;
  S3Client.prototype.send = function(command, ...args) {
    if (command instanceof UploadPartCommand && command.input.PartNumber === 2) {
      held = true; return new Promise(resolve => { release = resolve; });
    }
    return send.call(this, command, ...args);
  };
  const sending = f.service.jsonl.tick();
  let before;
  try {
    await until(() => held); before = f.jsonl.get(f.jsonl.list().files[0].id);
    if (mode === 'cancellation') f.service.jsonl.invalidate();
    if (mode === 'watchdog') { f.service.jsonl.active.lastCheckpointAt -= 120001; f.service.jsonl.recoverExpired(); }
    await within(sending, mode === 'timeout' ? 5000 : 2000);
    const paused = f.jsonl.get(before.id);
    assert.equal(paused.status, 'pending'); assert.equal(paused.error_code, { cancellation: 'ABORTED', timeout: 'TIMEOUT', watchdog: 'UPLOAD_STALLED' }[mode]);
    assert.equal(paused.upload_id, before.upload_id); assert.equal(paused.uploaded_bytes, 8 * 1024 ** 2);
    assert.equal(paused.uploaded_parts, 1); assert.equal(f.service.jsonl.active, null);
    assert.equal(receiver.completed.length, 0); assert.equal(f.push.billing.report().summary.files, 0);
    release({ ETag: 'late-unconfirmed-part' }); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.jsonl.get(before.id).uploaded_parts, 1);
  } finally {
    S3Client.prototype.send = send; release?.({ ETag: 'late-unconfirmed-part' });
    f.service.jsonl.invalidate(); await sending;
  }
  f.advance(); await f.service.jsonl.tick();
  const file = f.jsonl.get(before.id), body = receiver.completed[0].body;
  assert.equal(file.status, 'sent'); assert.equal(file.bytes, body.length);
  assert.equal(file.sha256, crypto.createHash('sha256').update(body).digest('hex'));
  assert.equal(puts(receiver).filter(entry => entry.query.get('partNumber') === '1').length, 1);
  assert.deepEqual(exportBodyBytes(JSON.parse(body), 'request'), Buffer.from(row.request, 'base64'));
});

test('cancelling an unfinished S3 response body retains confirmed parts and releases the connection', async t => {
  let hold = true, held = false, response;
  const receiver = await s3Receiver({ beforeRequest: (entry, res) => {
    if (hold && entry.method === 'PUT' && entry.query.get('partNumber') === '2') {
      response = res; res.writeHead(200, { 'content-type': 'application/xml' });
      res.write('<UploadPartResult>'); held = true; return false;
    }
  } }); t.after(() => receiver.close());
  const f = setup(t, receiver); const row = large(f, 'response-body-cancel');
  const sending = f.service.jsonl.tick();
  let file;
  try {
    await until(() => held); file = f.jsonl.get(f.jsonl.list().files[0].id);
    f.service.jsonl.invalidate(); await within(sending);
    assert.equal(f.jsonl.get(file.id).status, 'pending');
    assert.equal(f.jsonl.get(file.id).uploaded_parts, 1);
    await until(() => response.destroyed);
    assert.equal(receiver.completed.length, 0);
  } finally { hold = false; response?.destroy(); f.service.jsonl.invalidate(); await sending; }
  f.advance(); await f.service.jsonl.tick();
  assert.equal(f.jsonl.get(file.id).status, 'sent'); assert.equal(creates(receiver).length, 1);
  assert.deepEqual(exportBodyBytes(JSON.parse(receiver.completed[0].body), 'request'), Buffer.from(row.request, 'base64'));
});

test('an unfinished Complete response cannot authorize billing or cleanup and resumes without resending parts', async t => {
  let hold = true, held = false, response;
  const receiver = await s3Receiver({ beforeRequest: (entry, res) => {
    if (hold && entry.method === 'POST' && entry.query.has('uploadId')) {
      response = res; res.writeHead(200, { 'content-type': 'application/xml' });
      res.write('<CompleteMultipartUploadResult>'); held = true; return false;
    }
  } }); t.after(() => receiver.close());
  const f = setup(t, receiver); f.push.configure({ ...f.push.policy(), maxAttempts: 1, deleteAfterPush: true });
  const row = large(f, 'complete-body-cancel'), sending = f.service.jsonl.tick();
  let file;
  try {
    await until(() => held); file = f.jsonl.get(f.jsonl.list().files[0].id);
    assert.equal(file.uploaded_parts, 2);
    f.service.jsonl.invalidate(); await within(sending);
    assert.equal(f.jsonl.get(file.id).status, 'pending'); assert.equal(f.jsonl.get(file.id).attempts, 0);
    assert.equal(f.push.billing.report().summary.files, 0);
    f.service.maintain(); assert(f.store.db.prepare('SELECT 1 FROM cl_records WHERE id=?').get(row.id));
    await until(() => response.destroyed); assert.equal(receiver.completed.length, 0);
  } finally { hold = false; response?.destroy(); f.service.jsonl.invalidate(); await sending; }
  f.advance(); await f.service.jsonl.tick();
  const done = f.jsonl.get(file.id), body = receiver.completed[0].body;
  assert.equal(done.status, 'sent'); assert.equal(creates(receiver).length, 1); assert.equal(puts(receiver).length, 2);
  assert.equal(done.sha256, crypto.createHash('sha256').update(body).digest('hex'));
  assert.equal(f.push.billing.report().summary.files, 1);
  assert.deepEqual(exportBodyBytes(JSON.parse(body), 'request'), Buffer.from(row.request, 'base64'));
  f.advance(); f.service.maintain(); assert.equal(f.store.db.prepare('SELECT 1 FROM cl_records WHERE id=?').get(row.id), undefined);
});

test('a transport ignoring cancellation requires a worker restart and its late success cannot mark a file sent', async t => {
  let fail = true, stall = false, release;
  const receiver = await s3Receiver({ beforeRequest: (entry, res) => fail && entry.query.get('partNumber') === '2' ? reject(res) : undefined });
  t.after(() => receiver.close());
  const transport = new ConversationPushTransport(), send = transport.sendJsonl.bind(transport);
  transport.sendJsonl = (...args) => stall ? new Promise(resolve => { release = resolve; }) : send(...args);
  const f = setup(t, receiver, { transport, jsonlOptions: { abortGraceMs: 0 } });
  large(f, 'unresponsive-transport'); await f.service.jsonl.tick();
  const before = f.jsonl.get(f.jsonl.list().files[0].id), parts = f.jsonl.parts(before);
  assert.equal(before.attempts, 1); assert.equal(before.uploaded_parts, 1);
  stall = true; fail = false; f.advance(); const sending = f.service.jsonl.tick();
  try {
    await until(() => release); const active = f.service.jsonl.active;
    active.lastCheckpointAt -= 120001; f.service.jsonl.recoverExpired();
    assert.equal(active.controller.signal.reason.pushCode, 'UPLOAD_STALLED'); assert(f.service.jsonl.needsRestart());
    release({ status: 'sent', httpStatus: 200, sha256: 'unverified' }); await within(sending);
    const paused = f.jsonl.get(before.id);
    assert.equal(paused.status, 'pending'); assert.equal(paused.error_code, 'UPLOAD_STALLED'); assert.equal(paused.attempts, 1);
    assert.equal(paused.upload_id, before.upload_id); assert.deepEqual(f.jsonl.parts(paused), parts);
    assert.equal(f.push.billing.report().summary.files, 0); assert.equal(f.service.jsonl.needsRestart(), false);
  } finally { release?.({ status: 'failed', errorCode: 'ABORTED', retryable: true }); await sending; }
  stall = false; f.advance(); await f.service.jsonl.tick();
  assert.equal(f.jsonl.get(before.id).status, 'sent'); assert.equal(creates(receiver).length, 1);
  assert.equal(puts(receiver).filter(entry => entry.query.get('partNumber') === '1').length, 1);
});

test('a busy local part checkpoint retries in place without rereading or retransmitting the file', async t => {
  const receiver = await s3Receiver(); t.after(() => receiver.close()); const f = setup(t, receiver);
  f.push.configure({ ...f.push.policy(), maxAttempts: 1 }); const row = large(f, 'local-checkpoint-busy');
  const other = new ConversationLogStore(f.directory).openReader(), save = f.jsonl.savePart.bind(f.jsonl);
  const busyTimeout = f.jsonl.db.pragma('busy_timeout', { simple: true }); f.jsonl.db.pragma('busy_timeout = 1');
  const delivery = f.push.delivery.bind(f.push); let reads = 0, compete = true;
  f.push.delivery = (...args) => { reads++; return delivery(...args); };
  f.jsonl.savePart = (...args) => {
    if (!compete || args[2].number !== 2) return save(...args);
    compete = false; other.db.exec('BEGIN IMMEDIATE');
    try { return save(...args); } finally { other.db.exec('ROLLBACK'); }
  };
  try { await f.service.jsonl.tick(); }
  finally { f.jsonl.savePart = save; f.jsonl.db.pragma(`busy_timeout = ${busyTimeout}`); other.close(); }
  const done = f.jsonl.get(f.jsonl.list().files[0].id), body = receiver.completed[0].body;
  assert.equal(done.status, 'sent'); assert.equal(creates(receiver).length, 1);
  assert.equal(compete, false); assert.equal(done.attempts, 1); assert.equal(reads, 2);
  assert.equal(f.push.billing.report().summary.files, 1);
  assert.deepEqual(puts(receiver).map(entry => entry.query.get('partNumber')), ['1','2']);
  assert.equal(done.sha256, crypto.createHash('sha256').update(body).digest('hex'));
  assert.deepEqual(exportBodyBytes(JSON.parse(body), 'request'), Buffer.from(row.request, 'base64'));
});

for (const stage of ['uploadId','savePart','guard','finish']) test(`a real SQLite writer lock during ${stage} yields and preserves one multipart delivery`, async t => {
  const receiver = await s3Receiver(); t.after(() => receiver.close());
  const f = setup(t, receiver), row = large(f, 'writer-wait-' + stage);
  const other = new ConversationLogStore(f.directory).openReader(), action = f.jsonl[stage].bind(f.jsonl);
  const busyTimeout = f.jsonl.db.pragma('busy_timeout', { simple: true }); f.jsonl.db.pragma('busy_timeout = 1');
  let competed = false, busy = 0, timer, heartbeats = 0;
  const heartbeat = setInterval(() => { heartbeats++; }, 10);
  f.jsonl[stage] = (...args) => {
    if (!competed) {
      competed = true;
      if (stage === 'guard') f.jsonl.db.prepare('UPDATE cl_push_jsonl_files SET lease_until=? WHERE id=?').run(f.jsonl.now() + 1000, args[0].id);
      other.db.exec('BEGIN IMMEDIATE');
      timer = setTimeout(() => other.db.exec('ROLLBACK'), 80);
    }
    try { return action(...args); }
    catch (error) { if (/^SQLITE_BUSY/.test(error.code || '')) busy++; throw error; }
  };
  try { await f.service.jsonl.tick(); }
  finally {
    clearInterval(heartbeat); clearTimeout(timer); if (other.db.inTransaction) other.db.exec('ROLLBACK');
    f.jsonl[stage] = action; f.jsonl.db.pragma(`busy_timeout = ${busyTimeout}`); other.close();
  }
  const file = f.jsonl.get(f.jsonl.list().files[0].id), body = receiver.completed[0]?.body;
  assert(competed && busy > 0); assert(heartbeats >= 3, 'local lock waiting must release the event loop');
  assert.equal(file.status, 'sent'); assert.equal(file.attempts, 1); assert.equal(file.error_code, '');
  assert.equal(creates(receiver).length, 1); assert.equal(receiver.requests.filter(entry => entry.method === 'POST' && entry.query.has('uploadId')).length, 1);
  assert.deepEqual(puts(receiver).map(entry => entry.query.get('partNumber')), ['1','2']);
  assert.equal(f.push.billing.report().summary.files, 1); assert.equal(file.bytes, body.length);
  assert.equal(file.sha256, crypto.createHash('sha256').update(body).digest('hex'));
  assert.deepEqual(exportBodyBytes(JSON.parse(body), 'request'), Buffer.from(row.request, 'base64'));
});

for (const cancel of [false, true]) test(`a ${cancel ? 'cancelled' : 'prolonged'} local checkpoint wait retains the archive and resumes confirmed parts`, async t => {
  const receiver = await s3Receiver(); t.after(() => receiver.close());
  const f = setup(t, receiver, { jsonlOptions: { archiveRetryMs: 100 } });
  f.push.configure({ ...f.push.policy(), maxAttempts: 1, deleteAfterPush: true });
  const row = large(f, 'bounded-lock-' + cancel), other = new ConversationLogStore(f.directory).openReader();
  const save = f.jsonl.savePart.bind(f.jsonl), busyTimeout = f.jsonl.db.pragma('busy_timeout', { simple: true });
  f.jsonl.db.pragma('busy_timeout = 1'); let competed = false, release, cancellation;
  f.jsonl.savePart = (...args) => {
    if (!competed && args[2].number === 2) {
      competed = true; other.db.exec('BEGIN IMMEDIATE');
      release = setTimeout(() => other.db.exec('ROLLBACK'), 150);
      if (cancel) cancellation = setTimeout(() => f.service.jsonl.invalidate(), 20);
    }
    return save(...args);
  };
  try { await within(f.service.jsonl.tick()); }
  finally {
    clearTimeout(release); clearTimeout(cancellation); if (other.db.inTransaction) other.db.exec('ROLLBACK');
    f.jsonl.savePart = save; f.jsonl.db.pragma(`busy_timeout = ${busyTimeout}`); other.close();
  }
  const paused = f.jsonl.get(f.jsonl.list().files[0].id);
  assert(competed); assert.equal(paused.status, 'pending'); assert.equal(paused.error_code, cancel ? 'ABORTED' : 'ARCHIVE_BUSY');
  assert.equal(paused.attempts, 0); assert.equal(paused.uploaded_parts, 1); assert(paused.upload_id);
  assert.equal(receiver.completed.length, 0); assert.equal(f.push.billing.report().summary.files, 0);
  f.service.maintain(); assert(f.store.db.prepare('SELECT 1 FROM cl_records WHERE id=?').get(row.id));
  f.advance(); await f.service.jsonl.tick();
  const done = f.jsonl.get(paused.id); assert.equal(done.status, 'sent'); assert.equal(creates(receiver).length, 1);
  assert.deepEqual(puts(receiver).map(entry => entry.query.get('partNumber')), ['1','2','2']);
  assert.equal(done.sha256, crypto.createHash('sha256').update(receiver.completed[0].body).digest('hex'));
});

test('uploading a sealed file keeps automatically scanning and collecting new files without early sealing or parallel uploads', async t => {
  let release, held = false, allowed = true;
  const gate = new Promise(resolve => { release = resolve; });
  const receiver = await s3Receiver({ beforeRequest: async entry => {
    if (entry.method === 'PUT' && entry.query.get('partNumber') === '1') { held = true; await gate; }
  } }); t.after(() => receiver.close());
  const f = setup(t, receiver, { canWork: () => allowed }); f.push.configure({ ...f.push.policy(), automatic: true });
  const first = large(f, 'collect-during-upload'); f.service.start();
  try {
    await until(() => held); const frozen = f.jsonl.get(f.jsonl.list().files[0].id);
    allowed = false;
    const next = event('collect-next', { model: 'Opus5' }), other = event('collect-other', { model: 'Fable5' });
    f.store.ingest(next); f.store.ingest(other);
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(f.push.db.prepare('SELECT 1 FROM cl_push_jobs WHERE record_id=?').get(next.id), undefined, 'foreground work takes priority');
    allowed = true;
    const assign = f.jsonl.assignOne.bind(f.jsonl); let collectionCalls = 0;
    f.jsonl.assignOne = () => { collectionCalls++; return assign(); };
    await until(() => f.push.db.prepare("SELECT COUNT(*) n FROM cl_push_jobs WHERE record_id IN (?,?) AND status='buffered'").get(next.id, other.id).n === 2);
    await f.service.jsonl.collecting;
    const collected = collectionCalls;
    for (let index = 0; index < 50; index++) f.service.jsonl.wake();
    await f.service.jsonl.collecting;
    assert(collectionCalls <= collected + 1, 'frequent arrivals cannot cause unbounded collection turns');
    assert(f.service.jsonl.active); assert.equal(f.jsonl.get(frozen.id).records, 1); assert.equal(f.jsonl.get(frozen.id).bytes, frozen.bytes);
    const open = f.jsonl.list().files.filter(file => file.id !== frozen.id);
    assert.equal(open.length, 2); assert(open.every(file => file.status === 'open' && file.bytes < 10000000000));
    assert.equal(f.push.policy().s3.jsonl.flushMinutes, 0); assert.equal(creates(receiver).length, 1); assert.equal(puts(receiver).length, 1);
    release(); await until(() => f.jsonl.get(frozen.id).status === 'sent'); await f.service.stop();
    assert.equal(receiver.completed.length, 1); assert.equal(JSON.parse(receiver.completed[0].body).request_id, first.request_id);
    assert.equal(f.jsonl.get(frozen.id).sha256, crypto.createHash('sha256').update(receiver.completed[0].body).digest('hex'));
    assert(open.every(file => f.jsonl.get(file.id).status === 'open'));
  } finally { allowed = true; release(); await f.service.stop(); }
});

test('local resource deferrals use a short independent delay without discarding network attempt history', async t => {
  const receiver = await s3Receiver(); t.after(() => receiver.close()); const f = setup(t, receiver);
  f.push.configure({ ...f.push.policy(), retrySeconds: 30, maxAttempts: 10 });
  f.store.ingest(event('local-backoff')); f.enqueue(); f.jsonl.assignOne();
  const id = f.jsonl.list().files[0].id; f.jsonl.seal(id);
  for (const code of ['ARCHIVE_BUSY','EXPORT_MEMORY','UPLOAD_STALLED','ABORTED','HTTP_REJECTED']) {
    f.jsonl.db.prepare("UPDATE cl_push_jsonl_files SET status='pending',attempts=4,next_at=0 WHERE id=?").run(id);
    const file = f.jsonl.claim(); f.jsonl.finish(file, { status: 'failed', errorCode: code, retryable: true });
    const saved = f.jsonl.get(id); assert.equal(saved.status, 'pending');
    assert.equal(saved.attempts, code === 'HTTP_REJECTED' ? 5 : 4);
    assert.equal(saved.next_at - f.jsonl.now(), code === 'HTTP_REJECTED' ? 480000 : 5000);
  }
});

test('archive retries await guards, stop on cancellation or invalidation, and have a bounded busy deadline', async () => {
  const busy = Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' });
  let clock = 0, calls = 0, checks = 0;
  const options = { now: () => clock, timeoutMs: 75, wait: async ms => { clock += ms; }, guard: async () => { checks++; } };
  await assert.rejects(withArchiveRetry(() => { calls++; throw busy; }, options), { code: 'SQLITE_BUSY' });
  assert.equal(clock, 75); assert.equal(calls, 4); assert.equal(checks, 4);
  const controller = new AbortController(); calls = 0;
  await assert.rejects(withArchiveRetry(() => { calls++; throw busy; }, { ...options, signal: controller.signal,
    wait: async () => { controller.abort(); } }), /ABORTED/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(withArchiveRetry(() => { calls++; throw busy; }, { ...options,
    guard: async () => { throw new Error('DELIVERY_INVALIDATED'); } }), /DELIVERY_INVALIDATED/);
  assert.equal(calls, 0);
  await assert.rejects(prepareWithMemoryWait(async () => { throw new Error('CONTENT_CHANGED'); }, {
    guard: async () => {}, checkpoint: async () => {}, onPause: async () => {}
  }), /CONTENT_CHANGED/);
});

test('repeating identical persisted upload receipts is idempotent and conflicting receipts remain rejected', async t => {
  const receiver = await s3Receiver(); t.after(() => receiver.close()); const f = setup(t, receiver);
  f.store.ingest(event('idempotent-local-receipt')); f.enqueue(); f.jsonl.assignOne();
  f.jsonl.seal(f.jsonl.list().files[0].id); const file = f.jsonl.claim();
  const part = { number: 1, bytes: file.bytes, etag: 'fixture-etag', sha256: crypto.createHash('sha256').update('fixture').digest('base64') };
  assert(f.jsonl.uploadId(file, 'fixture-upload')); assert(f.jsonl.savePart(file, 'fixture-upload', part));
  assert(f.jsonl.uploadId(file, 'fixture-upload')); assert(f.jsonl.savePart(file, 'fixture-upload', part));
  assert.equal(f.jsonl.uploadId(file, 'other-upload'), 0);
  assert.equal(f.jsonl.savePart(file, 'fixture-upload', { ...part, etag: 'different' }), false);
  assert.equal(f.jsonl.savePart(file, 'fixture-upload', { ...part, bytes: part.bytes - 1 }), false);
  assert.equal(f.jsonl.savePart(file, 'fixture-upload', { ...part, sha256: Buffer.alloc(32).toString('base64') }), false);
  assert.deepEqual(f.jsonl.parts(file), [part]); assert.equal(f.jsonl.get(file.id).uploaded_bytes, part.bytes);
  assert.equal(f.jsonl.get(file.id).uploaded_parts, 1);
});

test('frequent upload guards check current policy versions without decrypting policy bodies', async t => {
  const receiver = await s3Receiver(); t.after(() => receiver.close()); const f = setup(t, receiver);
  f.store.ingest(event('lightweight-guard')); f.enqueue(); f.jsonl.assignOne();
  f.jsonl.seal(f.jsonl.list().files[0].id); const file = f.jsonl.claim(), policy = f.push.policy(), archivePolicy = f.store.policy();
  const pushPolicy = f.push.policy, readPolicy = f.store.policy;
  f.push.policy = f.store.policy = () => { throw new Error('Guard must only read policy versions'); };
  try { for (let index = 0; index < 20; index++) f.jsonl.guard(file, policy.version, archivePolicy.version); }
  finally { f.push.policy = pushPolicy; f.store.policy = readPolicy; }
  f.push.configure({ ...policy, retrySeconds: policy.retrySeconds + 1 });
  assert.throws(() => f.jsonl.guard(file, policy.version, archivePolicy.version), /DELIVERY_INVALIDATED/);
  f.jsonl.guard(file, f.push.policy().version, archivePolicy.version);
  f.store.configure({ ...archivePolicy, retention: 1 });
  assert.throws(() => f.jsonl.guard(file, f.push.policy().version, archivePolicy.version), /DELIVERY_INVALIDATED/);
});

test('a busy planning read leaves the job pending without consuming attempts or misclassifying the copy', async t => {
  const receiver = await s3Receiver(); t.after(() => receiver.close()); const f = setup(t, receiver);
  const row = event('busy-planning-read'); f.store.ingest(row); f.enqueue();
  const delivery = f.push.delivery;
  f.push.delivery = () => { throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' }); };
  try { assert.throws(() => f.jsonl.assignOne(), { code: 'SQLITE_BUSY' }); }
  finally { f.push.delivery = delivery; }
  const job = f.push.db.prepare('SELECT * FROM cl_push_jobs WHERE record_id=?').get(row.id);
  assert.equal(job.status, 'pending'); assert.equal(job.attempts, 0); assert.equal(job.error_code, '');
  assert(f.jsonl.assignOne()); assert.equal(f.push.list().items[0].status, 'buffered');
});

test('saving policy during upload preserves acknowledged parts and bills the verified delivery once',async t=>{
  let release,held=false,hold=true;
  const gate=new Promise(resolve=>{release=resolve;});
  const receiver=await s3Receiver({beforeRequest:async entry=>{
    if(hold&&entry.method==='PUT'&&entry.query.get('partNumber')==='2') { held=true;await gate; }
  }});t.after(()=>receiver.close());
  const f=setup(t,receiver);f.service.wake=()=>{};
  const row=large(f,'policy-during-upload'),sending=f.service.jsonl.tick();
  let before;
  try {
    await until(()=>held);before=f.jsonl.get(f.jsonl.list().files[0].id);
    assert.equal(before.uploaded_parts,1);assert(before.upload_id);
    const policy=f.push.policy();
    await f.service.configure({...policy,s3:{...policy.s3,name:'Updated storage',billing:{enabled:true,rates:[{model:'Opus5',price:'40000'}]}}});
  } finally { hold=false;release();await sending; }
  const paused=f.jsonl.get(before.id);
  assert.equal(paused.status,'pending');assert.equal(paused.upload_id,before.upload_id);
  assert.equal(paused.uploaded_parts,1);assert.equal(paused.uploaded_bytes,before.uploaded_bytes);
  assert.equal(f.push.billing.report().summary.files,0);
  f.advance();await f.service.jsonl.tick();
  assert.equal(f.jsonl.get(before.id).status,'sent');assert.equal(creates(receiver).length,1);
  assert.equal(puts(receiver).filter(entry=>entry.query.get('partNumber')==='1').length,1);
  assert.equal(receiver.completed.length,1);
  const delivered=receiver.completed[0].body,usage=f.push.billing.report().items[0];
  assert.equal(f.push.billing.report().summary.files,1);assert.equal(usage.rate,'40000');
  assert.equal(usage.bytes,delivered.length);assert.equal(usage.sha256,crypto.createHash('sha256').update(delivered).digest('hex'));
  assert.deepEqual(exportBodyBytes(JSON.parse(delivered.toString()),'request'),Buffer.from(row.request,'base64'));
});

test('temporary memory pressure waits at the current record without rereading or reuploading the confirmed prefix', async t => {
  let f, pressure = false;
  const receiver = await s3Receiver({beforeRequest:entry => {
    if (entry.method === 'PUT' && entry.query.get('partNumber') === '1') { pressure = true; f.jsonl.memoryBudget = () => 0; }
  }}); t.after(() => receiver.close());
  f = setup(t,receiver); const first = large(f,'wait-memory-first'), second = event('wait-memory-second',{model:'Opus5'});
  f.store.ingest(second); f.enqueue();
  f.push.db.prepare('UPDATE cl_push_jobs SET created_at=created_at+1 WHERE record_id=?').run(second.id);
  const delivery = f.push.delivery.bind(f.push); let firstReads = 0;
  f.push.delivery = (job,...args) => { if (job.record_id === first.id) firstReads++; return delivery(job,...args); };
  const sending = f.service.jsonl.tick();
  try {
    await until(() => f.jsonl.list().files[0]?.pause_reason === 'memory_wait');
    const file = f.jsonl.list().files[0]; assert(pressure); assert.equal(file.status,'running');
    assert.equal(file.uploaded_parts,1); assert.equal(file.error_code,''); assert.equal(receiver.completed.length,0);
    f.jsonl.memoryBudget = () => Infinity; await sending;
    assert.equal(firstReads,2); // Planning and the first send; the memory wait never restarts the file.
    assert.equal(f.jsonl.get(file.id).status,'sent'); assert.equal(f.jsonl.get(file.id).pause_reason,'');
    assert.equal(creates(receiver).length,1); assert.equal(puts(receiver).filter(entry => entry.query.get('partNumber') === '1').length,1);
    const rows = receiver.completed[0].body.toString().trimEnd().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(rows.map(row => row.request_id),[first.request_id,second.request_id]);
    assert.deepEqual(exportBodyBytes(rows[0],'request'),Buffer.from(first.request,'base64'));
  } finally { f.jsonl.memoryBudget = () => Infinity; f.service.jsonl.invalidate(); await sending; }
});

test('memory waits are bounded, check cancellation and archive priority, and never retry other errors', async () => {
  let clock = 0, calls = 0, checks = 0, checkpoints = 0; const pauses = [];
  const options = {timeoutMs:500,now:() => clock,wait:async ms => {clock += ms;},guard:() => {checks++;},
    checkpoint:async () => {checkpoints++;},onPause:reason => pauses.push(reason)};
  const memory = Object.assign(new Error('EXPORT_MEMORY'),{code:'EXPORT_MEMORY'});
  await assert.rejects(prepareWithMemoryWait(() => {calls++;throw memory;},options),{code:'EXPORT_MEMORY'});
  assert.equal(clock,500); assert.equal(calls,3); assert(checks >= 5); assert.equal(checkpoints,3);
  assert.deepEqual(pauses,['memory_wait','memory_wait','']);
  calls = 0; pauses.length = 0;
  await assert.rejects(prepareWithMemoryWait(() => {calls++;throw new Error('CONTENT_CHANGED');},options),/CONTENT_CHANGED/);
  assert.equal(calls,1); assert.deepEqual(pauses,[]);
  let cancelled = false;
  await assert.rejects(prepareWithMemoryWait(() => {throw memory;},{...options,
    wait:async () => {cancelled = true;},guard:() => {if (cancelled) throw new Error('DELIVERY_INVALIDATED');}}),/DELIVERY_INVALIDATED/);
  assert.equal(pauses.at(-1),'');
});

test('resuming a file clears old file and member errors while retaining its immutable upload checkpoints', async t => {
  const receiver = await s3Receiver({beforeRequest:(entry,res) => entry.query.get('partNumber') === '2' ? reject(res) : undefined});
  t.after(() => receiver.close()); const f = setup(t,receiver); large(f,'clear-stale-memory');
  await f.service.jsonl.tick(); const file = f.jsonl.list().files[0], before = f.jsonl.get(file.id), parts = f.jsonl.parts(file);
  assert.equal(before.error_code,'HTTP_REJECTED'); assert.equal(before.uploaded_parts,1);
  f.advance(); const claimed = f.jsonl.claim(); assert.equal(claimed.error_code,''); assert.equal(claimed.http_status,0);
  const current = f.jsonl.get(file.id); assert.equal(current.status,'running'); assert.equal(current.error_code,'');
  assert.equal(current.http_status,0); assert.equal(current.upload_id,before.upload_id); assert.equal(current.object_key,before.object_key);
  assert.deepEqual(f.jsonl.parts(current),parts);
  assert.deepEqual(f.push.db.prepare('SELECT DISTINCT error_code,http_status FROM cl_push_jobs WHERE jsonl_file_id=?').all(file.id),[{error_code:'',http_status:0}]);
});

test('full file validation uses compact metadata, detects missing copies and falls back safely while the index is incomplete', async t => {
  const receiver = await s3Receiver(); t.after(() => receiver.close()); const f = setup(t,receiver);
  const row = event('compact-file-check',{model:'Opus5'}); f.store.ingest(row); f.enqueue(); assert(f.jsonl.assignOne());
  const file = f.jsonl.get(f.jsonl.list().files[0].id), prepare = f.push.db.prepare.bind(f.push.db); let bodyChecks = 0;
  f.push.db.prepare = sql => { if (/LEFT JOIN cl_records r/.test(sql)) bodyChecks++; return prepare(sql); };
  assert.equal(f.jsonl.invalidReason(file,{full:true}),''); assert.equal(bodyChecks,0);
  f.push.db.prepare('DELETE FROM cl_record_metadata WHERE id=?').run(row.id);
  assert.equal(f.jsonl.invalidReason(file,{full:true}),''); assert.equal(bodyChecks,1);
  f.push.db.prepare('UPDATE cl_records SET original=NULL WHERE id=?').run(row.id);
  assert.equal(f.jsonl.invalidReason(file,{full:true}),'COPY_UNAVAILABLE'); assert.equal(bodyChecks,1);
});

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
    f.service.jsonl.active.lastCheckpointAt -= 120001;
    await new Promise(resolve => setTimeout(resolve, 150)); f.service.jsonl.recoverExpired();
    assert.equal(f.service.jsonl.active.controller.signal.aborted, false, 'priority waits keep the watchdog alive');
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

test('expired JSONL leases are requeued without discarding resumable upload state', async t => {
  const receiver = await s3Receiver(); t.after(() => receiver.close()); const f = setup(t, receiver);
  f.store.ingest(event('expired-lease')); f.enqueue(); f.jsonl.assignOne(); const file = f.jsonl.list().files[0]; f.jsonl.seal(file.id);
  const active = f.jsonl.claim(); assert(f.jsonl.uploadId(active, 'stale-upload'));
  f.jsonl.db.prepare("UPDATE cl_push_jsonl_files SET uploaded_bytes=?,uploaded_parts=?,lease_until=? WHERE id=?")
    .run(8 * 1024 ** 2, 1, f.jsonl.now() - 1, file.id);
  f.jsonl.db.prepare('INSERT INTO cl_push_jsonl_parts VALUES(?,?,?,?,?)').run(file.id, 1, 8 * 1024 ** 2, 'etag', 'sha256');
  assert.equal(f.jsonl.recoverExpired(), 1);
  const recovered = f.jsonl.get(file.id);
  assert.equal(recovered.status, 'pending'); assert.equal(recovered.error_code, 'DELIVERY_UNKNOWN');
  assert.equal(recovered.attempts, 0, 'an abandoned local attempt does not consume a network retry');
  assert.equal(recovered.upload_id, 'stale-upload'); assert.equal(recovered.uploaded_bytes, 8 * 1024 ** 2);
  assert.equal(recovered.uploaded_parts, 1); assert.equal(recovered.lease_token, ''); assert.equal(f.jsonl.recoverExpired(), 0);
});

test('JSONL lease watchdog aborts an expired active upload before requeueing it', async t => {
  const receiver = await s3Receiver(); t.after(() => receiver.close()); const f = setup(t, receiver);
  f.store.ingest(event('active-expired-lease')); f.enqueue(); f.jsonl.assignOne(); const file = f.jsonl.list().files[0]; f.jsonl.seal(file.id);
  const active = f.jsonl.claim(); assert(f.jsonl.uploadId(active, 'active-stale-upload'));
  f.jsonl.db.prepare('UPDATE cl_push_jsonl_files SET lease_until=? WHERE id=?').run(f.jsonl.now() - 1, file.id);
  let reason; f.service.jsonl.wake = () => {};
  f.service.jsonl.active = { file: active, controller: { abort: error => { reason = error.pushCode; } } };
  f.service.jsonl.recoverExpired();
  assert.equal(reason, 'UPLOAD_STALLED'); assert.equal(f.jsonl.get(file.id).status, 'pending');
  assert.equal(f.jsonl.get(file.id).upload_id, 'active-stale-upload');
  reason = ''; f.service.jsonl.recoverExpired(); assert.equal(reason, 'DELIVERY_INVALIDATED');
  f.service.jsonl.active = null;
});

test('JSONL upload can continue while ordinary delivery yields to archive processing', async t => {
  const receiver = await s3Receiver(); t.after(() => receiver.close());
  const f = setup(t, receiver, { canWork: () => false, canJsonlWork: () => true });
  f.store.ingest(event('archive-pending-upload')); f.enqueue();
  assert.equal((await f.service.jsonl.tick()), true);
  assert.equal(f.jsonl.list().files[0].status, 'sent');
  assert.equal(receiver.completed.length, 1);
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
