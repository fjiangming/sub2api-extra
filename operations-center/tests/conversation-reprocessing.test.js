'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, event, rawResponse } = require('./conversation-logs-fixture');
const { ConversationLogStore, defaults } = require('../src/conversation-log-store');
const { maskPayload } = require('../src/services/conversation-redaction');

const mask = response => maskPayload({request:Buffer.from('{}'),response:Buffer.from(response),frames:[]}, defaults, Buffer.alloc(32, 1)).payload.response.toString();
const expected = (store, row) => ({ policy_version: store.policy().version, processed_at: store.detail(row.id).processed_at });

test('numeric protocol IDs, multiline SSE and tool text retain structure, formatting and precision', () => {
  const response = ': keep\r\nevent: message\r\nid: 1794806368560\r\ndata: {"id":"chatcmpl-1794806368560",\r\ndata: "call_id":"call_1794806368560","output":"[tool result omitted]",\r\ndata: "text":"alice@example.com","big":9007199254740993,"decimal":1.2300}\r\n\r\ndata: [DONE]\r\n\r\n';
  const masked = mask(response);
  assert(masked.includes('EMAIL_')); assert(!masked.includes('alice@example.com'));
  assert.equal(masked.replace(/<EMAIL_[A-F0-9]+>/g, 'alice@example.com'), response);
  const nested = JSON.parse(mask('{"arguments":"{\\"id\\":\\"alice@example.com\\"}","output":"[tool result omitted]"}'));
  assert(JSON.parse(nested.arguments).id.includes('EMAIL_')); assert.equal(nested.output,'[tool result omitted]');
  assert(mask('{"type":"response.function_call_arguments.delta","item_id":"item_1794806368560","delta":"{\\"email\\":\\"alice@example.com"}').includes('EMAIL_'));
});

test('text responses, NDJSON, CR-only SSE and unknown SSE fields remain usable', () => {
  assert(mask('tool output alice@example.com\nunchanged').endsWith('\nunchanged'));
  const ndjson = '{"text":"alice@example.com","n":1.2300}\n{"text":"safe","n":9007199254740993}\n';
  assert.equal(mask(ndjson).replace(/<EMAIL_[A-F0-9]+>/g,'alice@example.com'),ndjson);
  const sse = ': hi\rx-extension: keep\rdata: {"text":"alice@example.com"}\r\rdata: [DONE]\r\r';
  assert.equal(mask(sse).replace(/<EMAIL_[A-F0-9]+>/g,'alice@example.com'),sse);
});

for (const mode of ['masked','dual']) test(`one-click retry is atomic and follows current rules and saved ${mode} retention`, t => {
  const f = fixture(); t.after(() => f.close());
  const p = f.store.configure({...f.store.policy(),mode,custom:[{from:'call_demo',to:'broken'}]});
  const row = event('retry-' + mode,{policy_version:p.version,complete:false,reason:'read_error'});
  f.store.ingest(row);
  const before = f.store.detail(row.id), stale = expected(f.store,row);
  const failed = f.store.retry(row.id,stale);
  assert.equal(failed.processing_error,'PROTECTED_FIELD_MATCH'); assert(failed.original); assert(!failed.masked);
  assert(failed.processed_at > before.processed_at);
  assert.throws(() => f.store.retry(row.id,stale),{code:'CONVERSATION_RETRY_CONFLICT'});
  const latest = f.store.configure({...f.store.policy(),mode:mode === 'dual' ? 'masked' : 'dual',custom:[]});
  assert.throws(() => f.store.retry(row.id,{...expected(f.store,row),policy_version:p.version}),{code:'CONVERSATION_RETRY_CONFLICT'});
  const fingerprint = f.store.db.prepare('SELECT fingerprint FROM cl_records WHERE id=?').get(row.id).fingerprint;
  const done = f.store.retry(row.id,expected(f.store,row));
  assert.equal(done.processing_error,''); assert.equal(done.processing_policy_version,latest.version);
  assert.equal(done.policy_version,p.version); assert.equal(done.mode,mode); assert.equal(done.complete,false); assert.equal(done.reason,'read_error');
  assert.equal(done.original,mode === 'dual'); assert(done.masked); assert(!done.retry_available);
  assert.equal(JSON.parse(f.store.payload(row.id,'masked','response').text).output[0].call_id,'call_demo');
  assert(!f.store.payload(row.id,'masked','response').text.includes('alice@example.com'));
  if (mode === 'dual') assert.equal(f.store.payload(row.id,'original','response').text,rawResponse);
  else assert.throws(() => f.store.payload(row.id,'original','response'),{code:'CONVERSATION_COPY_NOT_FOUND'});
  assert.equal(f.store.db.prepare('SELECT fingerprint FROM cl_records WHERE id=?').get(row.id).fingerprint,fingerprint);
  assert(f.store.ingest(row).duplicate);
});

test('retry honors exclusion and capacity, never removes fallback on a rejected update', t => {
  let free = 100 * 1024 ** 3;
  const f = fixture({freeBytes:() => free}); t.after(() => f.close());
  const p = f.store.configure({...f.store.policy(),mode:'masked',custom:[{from:'call_demo',to:'broken'}]});
  const row = event('retry-guard',{policy_version:p.version}); f.store.ingest(row);
  f.store.configure({...p,custom:[],excludedUserIds:[2]});
  assert.equal(f.store.detail(row.id).retry_available,false);
  assert.throws(() => f.store.retry(row.id,expected(f.store,row)),{code:'CONVERSATION_USER_EXCLUDED'});
  assert.equal(f.store.ingest(event('excluded-error',{policy_version:p.version,response:Buffer.from('{broken').toString('base64')})).accepted,false);
  f.store.configure({...f.store.policy(),excludedUserIds:[],reserve:1});
  const before = f.store.detail(row.id); free = 1000;
  assert.throws(() => f.store.retry(row.id,expected(f.store,row)),{code:'CONVERSATION_RETRY_CAPACITY'});
  assert.deepEqual(f.store.detail(row.id),before);
  assert.equal(f.store.payload(row.id,'original','response').text,rawResponse);
});

test('partial overflow bodies are retained with distinct capture and processing states; old missing records cannot retry', t => {
  const f = fixture(); t.after(() => f.close());
  for (const reason of ['body_limit','memory_limit']) {
    const row = event(reason,{complete:false,reason,response:Buffer.from('{"text":"partial').toString('base64')});
    f.store.ingest(row); const detail = f.store.detail(row.id);
    assert.equal(detail.reason,reason); assert.equal(detail.processing_error,'INVALID_JSON'); assert(detail.original);
    assert.equal(f.store.payload(row.id,'original','response').text,'{"text":"partial');
    const missing = event('missing-' + reason,{complete:false,reason,request:'',response:''}); f.store.ingest(missing);
    assert(!f.store.detail(missing.id).retry_available);
    assert.throws(() => f.store.retry(missing.id,expected(f.store,missing)),{code:'CONVERSATION_RETRY_UNAVAILABLE'});
  }
});

test('migration preserves old encrypted rows, key, policy and history without inventing recoverable bodies', t => {
  const f = fixture(); t.after(() => { f.store.close(); f.close(); }); const row = event('old-schema'); f.store.ingest(row);
  const request = f.store.payload(row.id,'original','request').body;
  f.store.db.exec("UPDATE cl_records SET original=NULL,masked=NULL,reason='redaction_failed',complete=0");
  for (const column of ['processing_error','processing_policy_version','processed_at']) f.store.db.exec('ALTER TABLE cl_records DROP COLUMN ' + column);
  f.store.close(); f.store = new ConversationLogStore(f.directory).initialize();
  assert.equal(f.store.list({capture:'redaction_failed'}).summary.total,1); assert.equal(f.store.detail(row.id).retry_available,false);
  assert.throws(() => f.store.retry(row.id,expected(f.store,row)),{code:'CONVERSATION_RETRY_UNAVAILABLE'});
  const next = event('post-migration'); assert.equal(f.store.ingest(next).accepted,true);
  assert.deepEqual(f.store.payload(next.id,'original','request').body,request);
});
