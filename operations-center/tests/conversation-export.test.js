'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const zlib=require('node:zlib');
const {setTimeout:delay}=require('node:timers/promises');
const {fixture,event,id,exportBodyBytes}=require('./conversation-logs-fixture');
const {ConversationExportData,parseExport}=require('../src/services/conversation-export-data');
const {ConversationExportService}=require('../src/services/conversation-export-service');
const {ConversationReadService}=require('../src/services/conversation-read-service');
const {ConversationArchiveService}=require('../src/services/conversation-archive-service');
const {AuthService}=require('../src/auth');
const {createApp}=require('../src/app');
const {bodyDigest}=require('../src/conversation-log-store');

async function until(check,ms=10000) {
  const end=Date.now()+ms;
  while (!check()) {assert(Date.now()<end,'export did not settle');await delay(10);}
}
const lines=body => body.toString('utf8').trimEnd().split('\n').map(line=>JSON.parse(line));
const checksum=body => crypto.createHash('sha256').update(body).digest('hex');

test('JSONL export validates bounded integer N, source and filters with safe defaults',()=>{
  assert.deepEqual(parseExport({}),{filter:{},source:'masked',limit:1000});
  for (const limit of [0,-1,1.5,10001,'20',null,Infinity]) assert.throws(()=>parseExport({limit}),{code:'CONVERSATION_EXPORT_INVALID_INPUT'});
  for (const value of [{source:'masked,original'},{filter:{protocol:'bad'}},{filter:{page:2}},{filter:{search:['value']}},{extra:true},null]) {
    assert.throws(()=>parseExport(value),{code:'CONVERSATION_EXPORT_INVALID_INPUT'});
  }
  assert.equal(parseExport({limit:10000,source:'original'}).limit,10000);
});

test('latest N uses stable list ordering, all current filters and no pagination or older replacement rows',t=>{
  const f=fixture();t.after(()=>f.close());const at=Date.now()-10000;
  for (let n=0;n<32;n++) assert(f.store.ingest(event('export-order-'+n,{at:at+Math.floor(n/2),user_id:n%2+2,protocol:n%3 ? 'JSON':'SSE',
    complete:n!==31,reason:n===31?'read_error':''})).accepted);
  const data=new ConversationExportData(f.store);
  for (const filter of [{},{user_id:'2'},{protocol:'SSE'},{capture:'partial'},{search:'example-model'},{start:'2020-01-01',end:'2099-01-01'},
    {key_id:'20',session_id:id('session').repeat(2)},{request_id:event('export-order-7').request_id}]) {
    const selection=data.select({filter,limit:3,source:'original'}),where=f.store.where(filter,true);
    const expected=f.store.db.prepare('SELECT id FROM cl_record_metadata'+where.sql+' ORDER BY at DESC,id LIMIT 3').all(...where.args).map(row=>row.id);
    assert.deepEqual(selection.rows.map(row=>row.id),expected);assert.equal(selection.selected,expected.length);
  }
  const newest=data.select({limit:1}).rows[0];
  f.store.db.prepare('UPDATE cl_records SET masked=NULL WHERE id=?').run(newest.id);
  const selected=data.select({limit:1});assert.equal(selected.selected,1);assert.equal(selected.rows.length,1);
  const fallback=data.envelope(selected,selected.rows[0]);assert.equal(fallback.source,'original');assert.equal(fallback.fallback_reason,'COPY_UNAVAILABLE');
  f.store.db.prepare('UPDATE cl_records SET original=NULL WHERE id=?').run(newest.id);
  const missing=data.select({limit:1});assert.equal(missing.rows.length,0);assert.equal(missing.skipped.COPY_UNAVAILABLE,1);
  assert.throws(()=>data.select({filter:{start:'bad'}}),{code:'CONVERSATION_INVALID_INPUT'});
  f.store.db.exec('DELETE FROM cl_record_metadata');assert.throws(()=>data.select({}),{code:'CONVERSATION_EXPORT_HISTORY_PREPARING'});
});

test('export uses original fallback for unavailable masking, retains diagnostics, and enforces exclusions',t=>{
  const f=fixture();t.after(()=>f.close());
  const states=['safe','failed','warnings','outdated','pending','missing','excluded','partial'];
  for (const name of states) f.store.ingest(event('export-'+name,{user_id:name==='excluded'?7:2,complete:name!=='partial',reason:name==='partial'?'read_error':''}));
  f.store.db.prepare("UPDATE cl_records SET masked=NULL,processing_error='INVALID_JSON' WHERE id=?").run(id('export-failed'));
  f.store.db.prepare("UPDATE cl_records SET inspection_warnings='[\"OPAQUE_IMAGE\"]' WHERE id=?").run(id('export-warnings'));
  f.store.db.prepare('UPDATE cl_records SET redaction_version=0 WHERE id=?').run(id('export-outdated'));
  f.store.db.prepare('UPDATE cl_records SET processing_pending=1 WHERE id=?').run(id('export-pending'));
  f.store.db.prepare('UPDATE cl_records SET original=NULL,masked=NULL WHERE id=?').run(id('export-missing'));
  f.store.configure({...f.store.policy(),excludedUserIds:[7]});
  const data=new ConversationExportData(f.store),masked=data.select({limit:100});
  assert.equal(masked.rows.length,6);
  assert.deepEqual(masked.skipped,{COPY_UNAVAILABLE:1,COLLECTION_EXCLUDED:1});
  for (const [name,reason] of [['failed','PROCESSING_FAILED'],['warnings','INSPECTION_INCOMPLETE'],['outdated','REDACTION_OUTDATED'],['pending','PROCESSING_PENDING']]) {
    const copy=data.envelope(masked,masked.rows.find(row=>row.id===id('export-'+name)));
    assert.equal(copy.source,'original');assert.equal(copy.requested_source,'masked');assert.equal(copy.fallback_reason,reason);
    assert.deepEqual(exportBodyBytes(copy,'request'),Buffer.from(event().request,'base64'));assert.equal(copy.checksums.request.sha256,checksum(Buffer.from(event().request,'base64')));
  }
  const partial=data.envelope(masked,masked.rows.find(row=>!row.complete));assert.equal(partial.metadata.complete,false);assert.equal(partial.metadata.reason,'read_error');
  assert(!partial.request.includes('alice@example.com'));
  const original=data.select({source:'original'});assert.equal(original.rows.length,6);assert.deepEqual(original.skipped,{COPY_UNAVAILABLE:1,COLLECTION_EXCLUDED:1});
  assert.equal(data.envelope(original,original.rows[0]).source,'original');
  f.store.configure({...f.store.policy(),modelFilterEnabled:true,allowedModels:['other-model'],kimiK3Plus:false});
  assert.equal(data.select({source:'original'}).skipped.COLLECTION_EXCLUDED,8);
});

test('snapshot guards reject reprocessing, clearing and rule changes and never mutate ciphertext',t=>{
  const f=fixture();t.after(()=>f.close());const row=event('export-snapshot');f.store.ingest(row);
  const data=new ConversationExportData(f.store),selection=data.select({source:'original'}),before=f.store.db.prepare('SELECT original,masked FROM cl_records WHERE id=?').get(row.id);
  assert.deepEqual(exportBodyBytes(data.envelope(selection,selection.rows[0]),'request'),Buffer.from(row.request,'base64'));
  assert.deepEqual(f.store.db.prepare('SELECT original,masked FROM cl_records WHERE id=?').get(row.id),before);
  f.store.db.prepare('UPDATE cl_records SET processed_at=processed_at+1 WHERE id=?').run(row.id);
  assert.throws(()=>data.envelope(selection,selection.rows[0]),{code:'CONVERSATION_EXPORT_RECORD_CHANGED'});
  const next=data.select({source:'original'});f.store.db.prepare('DELETE FROM cl_records WHERE id=?').run(row.id);
  assert.throws(()=>data.guard(next,next.rows[0]),{code:'CONVERSATION_EXPORT_RECORD_CHANGED'});
  f.store.configure({...f.store.policy(),email:false});assert.throws(()=>data.guard(next),{code:'CONVERSATION_EXPORT_POLICY_CHANGED'});
});

async function setup(t,options={}) {
  const f=fixture(),auth=new AuthService(f.config),archive=new ConversationArchiveService(f.store);
  const read=new ConversationReadService(f.store,{configured:true});
  const exporter=new ConversationExportService(f.store,auth,{canWork:()=>true,...options});
  const app=createApp({config:f.config,database:{},auth,conversations:f.store,conversationArchive:archive,conversationRead:read,conversationExport:exporter,messages:f.messages});
  const server=await new Promise(resolve=>{const value=app.listen(0,'127.0.0.1',()=>resolve(value));});
  t.after(async()=>{await exporter.stop();await read.stop();await archive.stop();auth.close();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});f.close();});
  const base='http://127.0.0.1:'+server.address().port;
  async function login() {
    const response=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password:f.config.adminPassword})});
    return response.json();
  }
  const session=await login(),headers={authorization:'Session '+session.sessionToken,'x-csrf-token':session.csrfToken,'content-type':'application/json'};
  const endpoint=base+'/api/conversation-logs/exports';
  const start=async spec=>{const response=await fetch(endpoint,{method:'POST',headers,body:JSON.stringify(spec || {})});assert.equal(response.status,201,await response.clone().text());return response.json();};
  const status=async job=>(await fetch(endpoint+'/'+job.id,{headers})).json();
  const done=async job=>{let value;await until(()=>{const saved=exporter.jobs.get(job.id);return saved && !['ready','running'].includes(saved.status);});value=await status(job);return value;};
  return {...f,auth,archive,read,exporter,base,endpoint,session,headers,login,start,status,done,
    download:value=>fetch(base+value.downloadUrl),cancel:job=>fetch(endpoint+'/'+job.id+'/cancel',{method:'POST',headers,body:'{}'})};
}

test('native JSONL retains stored request IDs and every attempt, decompresses SSE and preserves WS messages',async t=>{
  const f=await setup(t),at=Date.now()-5000;
  const compressed=zlib.gzipSync(Buffer.from('data: {"type":"error","message":"example"}\n\ndata: [DONE]\n\n'));
  const rows=[event('export-http',{at}),event('export-sse',{at:at+1,request_id:event('export-http').request_id,protocol:'SSE',encoding:'gzip',response:compressed.toString('base64'),status:502,complete:false,reason:'read_error'}),
    event('export-ws',{at:at+2,method:'WS',protocol:'WebSocket',status:101,frames:[{at:0,direction:'out',binary:false,body:Buffer.from('{ "id":9007199254740993,"n":1.2300 }').toString('base64')},
      {at:1,direction:'in',binary:true,body:Buffer.from([0,255,1,200]).toString('base64')}]})];
  const transport=rows[1];transport.capture_version=2;
  transport.transport_diagnostics={version:1,request:{bytes:Buffer.byteLength(transport.request,'base64'),expected_bytes:-1,eof:true,error:'',error_during_close:false},
    response:{bytes:compressed.length,expected_bytes:-1,eof:false,error:'cancelled',error_during_close:true}};
  transport.body_sha256=bodyDigest({request:Buffer.from(transport.request,'base64'),response:compressed,frames:[]});
  for (const row of rows) assert(f.store.ingest(row).accepted);
  for (const row of rows) assert.equal(f.store.db.prepare('SELECT request_id FROM cl_records WHERE id=?').get(row.id).request_id,row.request_id);
  const value=await f.start({limit:3,source:'original'});
  f.store.open=()=>assert.fail('main process decrypted an export body');
  const response=await f.download(value);assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/application\/x-ndjson/);
  assert.match(response.headers.get('content-disposition'),/\.jsonl"$/);assert.equal(response.headers.get('cache-control'),'no-store');
  const body=Buffer.from(await response.arrayBuffer()),records=lines(body);assert(body.at(-1)===10);assert.notEqual(body.subarray(0,3).toString('hex'),'efbbbf');
  assert.equal(records.length,3);for(const record of records)assert.deepEqual(Object.keys(record),['request_id','request','response']);
  assert.deepEqual(records.map(record=>record.request_id),rows.toReversed().map(row=>row.request_id));assert.equal(new Set(records.map(record=>record.request_id)).size,2);
  assert.deepEqual(records[0],{request_id:rows[2].request_id,request:[Buffer.from(rows[2].request,'base64').toString(),'{ "id":9007199254740993,"n":1.2300 }'],
    response:[Buffer.from(rows[2].response,'base64').toString(),'data:application/octet-stream;base64,AP8ByA==']});
  assert.equal(records[1].request,Buffer.from(transport.request,'base64').toString());assert.equal(records[1].response,zlib.gunzipSync(compressed).toString());
  assert.deepEqual(records[2],{request_id:rows[0].request_id,request:Buffer.from(rows[0].request,'base64').toString(),response:Buffer.from(rows[0].response,'base64').toString()});
  const saved=f.store.db.prepare('SELECT complete,reason,status,transport_diagnostics FROM cl_records WHERE id=?').get(transport.id);
  assert.equal(saved.complete,0);assert.equal(saved.reason,'read_error');assert.equal(saved.status,502);assert.deepEqual(JSON.parse(saved.transport_diagnostics),transport.transport_diagnostics);
  const result=await f.done(value.job);assert.equal(result.status,'completed');assert.equal(result.bytes,body.length);assert.equal(result.sha256,checksum(body));assert.equal(result.exported,3);
  await until(()=>!f.exporter.child);assert(!f.archive.child,'export must not start or restart the collector');
});

test('masked native export preserves latest N with marked original fallbacks and reports actual counts',async t=>{
  const f=await setup(t),at=Date.now()-5000;
  for (let n=0;n<4;n++) f.store.ingest(event('export-mask-'+n,{at:at+n}));
  f.store.db.prepare("UPDATE cl_records SET masked=NULL,processing_error='INVALID_JSON' WHERE id=?").run(id('export-mask-3'));
  const value=await f.start({limit:2}),response=await f.download(value),body=await response.text();assert.equal(response.status,200);
  assert.equal(lines(body).length,2);for(const row of lines(body))assert.deepEqual(Object.keys(row),['request_id','request','response']);
  assert.deepEqual(lines(body).map(row=>row.request_id),[event('export-mask-3').request_id,event('export-mask-2').request_id]);
  assert.equal(lines(body)[0].request,Buffer.from(event().request,'base64').toString());assert(!lines(body)[1].request.includes('alice@example.com'));
  const result=await f.done(value.job);assert.equal(result.selected,2);assert.equal(result.exported,2);assert.deepEqual(result.skipped,{});
  assert.equal(result.fallbacks,1);assert.deepEqual(result.fallbackReasons,{PROCESSING_FAILED:1});
  f.store.db.prepare('UPDATE cl_records SET original=NULL WHERE id=?').run(id('export-mask-3'));
  const empty=await f.start({limit:1});assert.equal((await f.download(empty)).status,409);assert.equal((await f.done(empty.job)).errorCode,'CONVERSATION_EXPORT_EMPTY');
});

test('corrupted masked ciphertext falls back to exact original bytes with a read failure marker',t=>{
  const f=fixture();t.after(()=>f.close());const row=event('corrupt-mask');f.store.ingest(row);
  f.store.db.prepare('UPDATE cl_records SET masked=? WHERE id=?').run(Buffer.from('invalid encrypted copy'),row.id);
  const data=new ConversationExportData(f.store),selection=data.select({limit:1}),copy=data.envelope(selection,selection.rows[0]);
  assert.equal(copy.source,'original');assert.equal(copy.fallback_reason,'MASKED_READ_FAILED');assert.equal(copy.requested_source,'masked');
  assert.deepEqual(exportBodyBytes(copy,'request'),Buffer.from(row.request,'base64'));assert.deepEqual(exportBodyBytes(copy,'response'),Buffer.from(row.response,'base64'));
  assert.equal(copy.checksums.response.sha256,checksum(Buffer.from(row.response,'base64')));
});

test('original fallbacks preserve compressed SSE and binary WebSocket frames byte for byte',t=>{
  const f=fixture();t.after(()=>f.close());f.store.configure({...f.store.policy(),mode:'original'});
  const compressed=zlib.gzipSync(Buffer.from('data: {"message":"alice@example.com"}\n\ndata: [DONE]\n\n'));
  const rows=[event('fallback-sse',{policy_version:f.store.policy().version,encoding:'gzip',protocol:'SSE',response:compressed.toString('base64')}),
    event('fallback-ws',{policy_version:f.store.policy().version,protocol:'WebSocket',frames:[{at:2,direction:'in',binary:true,body:Buffer.from([0,255,13,10]).toString('base64')}]})];
  for(const row of rows)f.store.ingest(row);
  const data=new ConversationExportData(f.store),selection=data.select({limit:2});assert.equal(selection.rows.length,2);
  for(const selected of selection.rows){const input=rows.find(row=>row.id===selected.id),copy=data.envelope(selection,selected);
    assert.equal(copy.source,'original');assert.equal(copy.fallback_reason,'COPY_UNAVAILABLE');assert.deepEqual(exportBodyBytes(copy,'request'),Buffer.from(input.request,'base64'));
    assert.deepEqual(exportBodyBytes(copy,'response'),Buffer.from(input.response,'base64'));assert.deepEqual(copy.frames,input.frames);assert.equal(copy.metadata.encoding,input.encoding);}
});

test('download tickets require CSRF to create, bind the original live admin session, work without cookies and cannot replay or alter scope',async t=>{
  const f=await setup(t);f.store.ingest(event('export-auth'));
  for (const headers of [{},{authorization:'Bearer '+f.token},{authorization:f.headers.authorization}]) {
    const response=await fetch(f.endpoint,{method:'POST',headers:{'content-type':'application/json',...headers},body:'{}'});
    assert.equal(response.status,headers.authorization===f.headers.authorization ? 403:401);
  }
  const value=await f.start({limit:1}),other=await f.login();
  const foreign=await fetch(f.endpoint+'/'+value.job.id,{headers:{authorization:'Session '+other.sessionToken}});assert.equal(foreign.status,404);
  assert(!JSON.stringify(value).includes(f.session.sessionToken));assert(!JSON.stringify(value.job).includes('ticket'));
  const altered=await fetch(f.base+value.downloadUrl.replace(/ticket=.+/,'ticket=bad'));assert.equal(altered.status,401);
  const response=await fetch(f.base+value.downloadUrl+'&source=original&limit=10000');assert.equal(response.status,200);
  const downloaded=lines(await response.text())[0];assert.deepEqual(Object.keys(downloaded),['request_id','request','response']);assert.equal(downloaded.request_id,event('export-auth').request_id);
  assert(!downloaded.request.includes('alice@example.com'));await f.done(value.job);
  assert.equal((await f.download(value)).status,401);
  const revoked=await f.start({limit:1});
  await fetch(f.base+'/api/auth/logout',{method:'POST',headers:f.headers});assert.equal((await f.download(revoked)).status,401);
});

test('expired tickets and cancellation release the single export slot and never expose another session task',async t=>{
  const f=await setup(t,{ticketTtlMs:400});f.store.ingest(event('export-expiry'));
  const first=await f.start({limit:1});assert.equal((await fetch(f.endpoint,{method:'POST',headers:f.headers,body:'{}'})).status,409);
  await until(()=>f.exporter.jobs.get(first.job.id).status==='expired');assert.equal((await f.download(first)).status,401);
  const next=await f.start({});assert.equal((await f.cancel(next.job)).status,200);assert.equal((await f.status(next.job)).status,'cancelled');
  assert.equal((await f.download(next)).status,401);
});

test('memory protection refuses isolated export without truncation, changing archive data or synchronous fallback',async t=>{
  const f=await setup(t,{memoryBudgetBytes:0}),row=event('export-start-memory');f.store.ingest(row);
  const before=f.store.db.prepare('SELECT original,masked FROM cl_records WHERE id=?').get(row.id),value=await f.start({});
  assert.equal((await f.download(value)).status,409);assert.equal((await f.done(value.job)).errorCode,'CONVERSATION_EXPORT_MEMORY');assert.equal(f.exporter.child,null);
  assert.deepEqual(f.store.db.prepare('SELECT original,masked FROM cl_records WHERE id=?').get(row.id),before);
  f.exporter.memoryBudgetBytes=128*1024**2;
  const policy=f.store.configure({...f.store.policy(),mode:'original'}),raw=Buffer.from(JSON.stringify({text:'x'.repeat(10*1024**2)}));
  const large=event('export-large-memory',{at:Date.now()+1,policy_version:policy.version,request:raw.toString('base64')});assert(f.store.ingest(large).accepted);
  const big=await f.start({limit:1,source:'original'});assert.equal((await f.download(big)).status,409);
  assert.equal((await f.done(big.job)).errorCode,'CONVERSATION_EXPORT_MEMORY');
  assert.deepEqual(f.store.payload(large.id,'original','request').body,raw);assert.equal((await fetch(f.base+'/healthz')).status,200);
});

test('missing archived request ID explicitly fails download without inventing an ID or modifying saved bodies',async t=>{
  const f=await setup(t),row=event('export-missing-id');assert(f.store.ingest(row).accepted);
  const before=f.store.db.prepare('SELECT original,masked FROM cl_records WHERE id=?').get(row.id);
  f.store.db.prepare("UPDATE cl_records SET request_id='' WHERE id=?").run(row.id);
  const value=await f.start({source:'original',limit:1}),response=await f.download(value);assert.equal(response.status,409);
  assert.equal((await response.json()).error.code,'CONVERSATION_EXPORT_REQUEST_ID');
  const result=await f.done(value.job);assert.equal(result.status,'failed');assert.equal(result.errorCode,'CONVERSATION_EXPORT_REQUEST_ID');assert.equal(result.exported,0);assert(!result.sha256);
  assert.deepEqual(f.store.db.prepare('SELECT original,masked FROM cl_records WHERE id=?').get(row.id),before);
  assert.equal((await fetch(f.base+'/healthz')).status,200);
});

test('export yields to collection and interactive reads while health and durable ingestion stay responsive',async t=>{
  let allowed=false;const f=await setup(t,{canWork:()=>allowed,maxPauseMs:5000});f.store.ingest(event('export-priority'));
  const value=await f.start({}),response=f.download(value);
  await until(()=>f.exporter.jobs.get(value.job.id).pauseReason==='archive_busy');
  const exportPid=f.exporter.child.pid;assert.notEqual(exportPid,process.pid);
  assert.equal((await fetch(f.base+'/api/conversation-logs/records',{headers:f.headers})).status,200);assert.notEqual(f.read.child.pid,exportPid);
  await f.archive.start();const before=performance.now(),row=event('export-during-ingest');
  assert.equal((await fetch(f.base+'/healthz')).status,200);
  const accepted=await fetch(f.base+'/api/conversation-logs/ingest',{method:'POST',headers:{authorization:'Bearer '+f.token,'content-type':'application/json'},body:JSON.stringify(row)});
  assert((await accepted.json()).accepted);assert(performance.now()-before<1500,'export held health or ingestion');
  allowed=true;assert.equal((await response).status,200);await(await response).arrayBuffer();assert.equal((await f.done(value.job)).status,'completed');
});

test('sustained collection pressure ends the download explicitly and frees its process and reservation',async t=>{
  const f=await setup(t,{canWork:()=>false,maxPauseMs:150});f.store.ingest(event('export-continuously-busy'));
  const value=await f.start({}),response=await f.download(value);assert.equal(response.status,503);
  assert.equal((await f.done(value.job)).errorCode,'CONVERSATION_EXPORT_BUSY');await until(()=>!f.exporter.child);
  assert.equal(f.exporter.current,null);assert.equal((await fetch(f.base+'/healthz')).status,200);
});

test('memory rejection after an earlier emitted line still fails the file rather than silently succeeding with fewer rows',async t=>{
  const f=await setup(t,{memoryBudgetBytes:128*1024**2}),policy=f.store.configure({...f.store.policy(),mode:'original'}),at=Date.now()-5000;
  assert(f.store.ingest(event('export-memory-second',{at,policy_version:policy.version,
    request:Buffer.from(JSON.stringify({text:'x'.repeat(10*1024**2)})).toString('base64')})).accepted);
  assert(f.store.ingest(event('export-memory-first',{at:at+1,policy_version:policy.version,
    request:Buffer.from(JSON.stringify({text:'x'.repeat(128*1024)})).toString('base64')})).accepted);
  const value=await f.start({source:'original',limit:2}),response=await f.download(value);assert.equal(response.status,200);
  await assert.rejects(response.arrayBuffer());const result=await f.done(value.job);
  assert.equal(result.status,'failed');assert.equal(result.errorCode,'CONVERSATION_EXPORT_MEMORY');assert.equal(result.exported,1);assert(!result.sha256);
});

for (const change of ['policy','record','request-id','delete','cancel','logout','disconnect','worker-death']) test('in-flight '+change+' interrupts only the export and cannot be reported as a complete file',async t=>{
  const f=await setup(t,{bytesPerSecond:128*1024}),policy=f.store.configure({...f.store.policy(),mode:'original'});
  const row=event('export-race-'+change,{policy_version:policy.version,request:Buffer.from(JSON.stringify({text:'x'.repeat(512*1024)})).toString('base64')});assert(f.store.ingest(row).accepted);
  const value=await f.start({limit:1,source:'original'}),controller=new AbortController();
  const response=await fetch(f.base+value.downloadUrl,{signal:controller.signal});assert.equal(response.status,200);
  const reading=response.arrayBuffer(),rejected=assert.rejects(reading);
  const child=f.exporter.child;
  if (change==='policy') f.store.configure({...f.store.policy(),excludedUserIds:[2]});
  else if (change==='record') f.store.db.prepare('UPDATE cl_records SET processed_at=processed_at+1 WHERE id=?').run(row.id);
  else if (change==='request-id') f.store.db.prepare('UPDATE cl_records SET request_id=? WHERE id=?').run(id('changed-request'),row.id);
  else if (change==='delete') f.store.db.prepare('DELETE FROM cl_records WHERE id=?').run(row.id);
  else if (change==='cancel') await f.cancel(value.job);
  else if (change==='logout') await fetch(f.base+'/api/auth/logout',{method:'POST',headers:f.headers});
  else if (change==='disconnect') controller.abort();
  else child.kill('SIGKILL');
  await rejected;await until(()=>!f.exporter.child);
  const job=f.exporter.jobs.get(value.job.id);assert.notEqual(job.status,'completed');assert(job.errorCode);assert(!job.sha256);
  if (change==='policy') assert.equal(job.errorCode,'CONVERSATION_EXPORT_POLICY_CHANGED');
  if (['record','request-id','delete'].includes(change)) assert.equal(job.errorCode,'CONVERSATION_EXPORT_RECORD_CHANGED');
  assert.equal((await fetch(f.base+'/healthz')).status,200);assert(!f.archive.child,'export failure touched collector lifecycle');
});
