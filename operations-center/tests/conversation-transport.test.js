'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture,event} = require('./conversation-logs-fixture');
const {ConversationLogStore,bodyDigest} = require('../src/conversation-log-store');
const {ConversationPushStore} = require('../src/conversation-push-store');

const b64 = value => Buffer.from(value).toString('base64');
function sample(seed) {
  const row = event(seed,{capture_version:2,protocol:'SSE',complete:false,reason:'read_error',
    response:b64('data: {"type":"response.completed","response":{"id":"resp_fixture","object":"response","status":"completed","output":[]}}\n\n')});
  row.body_sha256 = bodyDigest({request:Buffer.from(row.request,'base64'),response:Buffer.from(row.response,'base64'),frames:[]});
  row.transport_diagnostics = {version:1,
    request:{bytes:Buffer.from(row.request,'base64').length,expected_bytes:-1,eof:true,error:'',error_during_close:false},
    response:{bytes:Buffer.from(row.response,'base64').length,expected_bytes:-1,eof:false,error:'cancelled',error_during_close:true}};
  return row;
}

test('optional negotiated transport diagnostics preserve exact bodies, idempotency and conservative delivery gates', t => {
  const f=fixture();t.after(()=>f.close());const row=sample('diagnostics');
  assert.equal(f.store.collectorPolicy().transport_diagnostics_version,1);
  const ack=f.store.ingest(row);assert(ack.accepted);assert.equal(ack.body_sha256,row.body_sha256);
  assert.deepEqual(f.store.ingest(row),{...ack,duplicate:true});
  const detail=f.store.detail(row.id);assert.deepEqual(detail.transport_diagnostics,row.transport_diagnostics);
  assert(!detail.complete);assert.equal(detail.reason,'read_error');assert.equal(detail.upstream_status,'completed');
  for(const side of ['request','response']) assert.equal(f.store.payload(row.id,'original',side).body.toString('base64'),row[side]);
  const changed=structuredClone(row);changed.transport_diagnostics.response.error_during_close=false;
  assert.throws(()=>f.store.ingest(changed),{code:'CONVERSATION_ID_CONFLICT'});
  const push=new ConversationPushStore(f.store).initialize();
  push.configure({...push.policy(),enabled:true,automatic:true,webhook:{enabled:true,url:'https://receiver.example/logs'}});
  assert.equal(push.scanAutomatic().created,0);assert.equal(push.preview({filter:{},destinations:['webhook']}).eligible,0);
  assert(!Object.hasOwn(f.store.list().items[0],'transport_diagnostics'));
  assert(!f.store.db.pragma('table_info(cl_record_metadata)').some(column=>column.name==='transport_diagnostics'));
});

test('transport diagnostics reject free-form errors, inconsistent byte counts and unsupported contracts before persisting', t => {
  const f=fixture();t.after(()=>f.close());
  for (const [index,change] of [
    row=>{row.transport_diagnostics.version=2;},
    row=>{row.transport_diagnostics.response.error='private host and token';},
    row=>{row.transport_diagnostics.response.message='raw sensitive error';},
    row=>{row.transport_diagnostics.request.bytes++;},
    row=>{row.transport_diagnostics.response.bytes--;},
    row=>{row.transport_diagnostics.request.error_during_close=true;},
    row=>{row.transport_diagnostics.response.expected_bytes=-2;},
    row=>{row.capture_version=1;},
    row=>{row.protocol='WebSocket';},
    row=>{row.frames=[{direction:'in',at:0,body:b64('frame'),binary:false}];}
  ].entries()) {
    const row=sample('invalid-diagnostics-'+index);change(row);
    assert.throws(()=>f.store.ingest(row),{code:'CONVERSATION_INVALID_INPUT'});
  }
  assert.equal(f.store.status().records,0);
});

test('new centers accept unchanged old events and migrate diagnostics without scanning or rewriting history', t => {
  const f=fixture();t.after(()=>{f.store.close();f.close();});
  const old=event('old-without-diagnostics'),v2=sample('v2-without-diagnostics');delete v2.transport_diagnostics;
  for(const row of [old,v2]) {assert(f.store.ingest(row).accepted);assert.equal(f.store.detail(row.id).transport_diagnostics,null);}
  const encrypted=f.store.db.prepare('SELECT id,original,masked,fingerprint FROM cl_records ORDER BY id').all();
  const policy=f.store.policy(),key=Buffer.from(f.store.key),indexed=f.store.metadataStatus();
  f.store.db.exec('ALTER TABLE cl_records DROP COLUMN transport_diagnostics');f.store.close();
  f.store=new ConversationLogStore(f.directory).initialize();
  assert.deepEqual(f.store.policy(),policy);assert.deepEqual(f.store.key,key);assert.deepEqual(f.store.metadataStatus(),indexed);
  assert.deepEqual(f.store.db.prepare('SELECT id,original,masked,fingerprint FROM cl_records ORDER BY id').all(),encrypted);
  for(const row of [old,v2]) {assert(f.store.ingest(row).duplicate);assert.equal(f.store.detail(row.id).transport_diagnostics,null);}
  assert(f.store.ingest(sample('after-migration')).accepted);
});

test('reprocessing preserves transport diagnostics and original errors, with no body reads in metadata queries', t => {
  const f=fixture();t.after(()=>f.close());const row=sample('diagnostics-retry');f.store.ingest(row);
  f.store.db.prepare('UPDATE cl_records SET redaction_version=0 WHERE id=?').run(row.id);
  const before=f.store.detail(row.id),original=f.store.payload(row.id,'original','request').body;
  const done=f.store.retry(row.id,{policy_version:f.store.policy().version,processed_at:before.processed_at});
  assert.deepEqual(done.transport_diagnostics,row.transport_diagnostics);assert(!done.complete);assert.equal(done.reason,'read_error');
  assert.deepEqual(f.store.payload(row.id,'original','request').body,original);
  const prepare=f.store.db.prepare.bind(f.store.db),open=f.store.open.bind(f.store);
  f.store.db.prepare=sql=>{assert(!/SELECT \* FROM cl_records/.test(sql));return prepare(sql);};
  f.store.open=(value,aad)=>{assert(aad.startsWith('policy:'));return open(value,aad);};
  assert.equal(f.store.list().summary.total,1);assert.equal(f.store.sessions().items.length,1);assert.equal(f.store.status().gaps,1);
  assert.deepEqual(f.store.detail(row.id).transport_diagnostics,row.transport_diagnostics);
});
