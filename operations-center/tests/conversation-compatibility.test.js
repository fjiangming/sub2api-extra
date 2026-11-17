'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { availableMemory, processingBudget } = require('../src/services/conversation-memory');
const { maskPayload } = require('../src/services/conversation-redaction');
const { inspectCompletion } = require('../src/services/conversation-completion');
const { fixture,event } = require('./conversation-logs-fixture');
const { defaults, ConversationLogStore } = require('../src/conversation-log-store');
const { ConversationPushStore } = require('../src/conversation-push-store');

const MiB = 1024 ** 2;
const fakeMemory = files => ({freeMemory:() => 8 * 1024 * MiB,readFile:file => { if (!(file in files)) throw new Error('missing'); return String(files[file]); }});
function v2(stat, used = 478) { return fakeMemory({'/sys/fs/cgroup/memory.max':512 * MiB,'/sys/fs/cgroup/memory.current':used * MiB,
  '/sys/fs/cgroup/memory.stat':Object.entries(stat).map(([key,value]) => key + ' ' + value * MiB).join('\n')}); }
const raw = (request = '{}',response = '{}',frames = []) => ({request:Buffer.from(request),response:Buffer.from(response),frames});
const mask = value => maskPayload(value,defaults,Buffer.alloc(32,1));
const encrypted = 'gAAAAAB_fictional-encrypted-reasoning_12345678901234567890==';
const reasoning = () => ({type:'reasoning',id:'rs_12345678901234567890',status:'completed',summary:[{type:'summary_text',text:'contact alice@example.com'}],encrypted_content:encrypted});
const terminal = (type = 'completed', id = 'resp_demo') => ({type:'response.' + type,response:{object:'response',id,status:type,output:[]}});
const sse = values => values.map(value => 'event: ' + value.type + '\r\ndata: ' + JSON.stringify(value) + '\r\n\r\n').join('');
const inspect = (response,extra = {},limits) => inspectCompletion(raw('{}',response),{protocol:'SSE',status:200,encoding:'',...extra},limits);

test('cgroup v2 credits only half of clean inactive cache and retains heap and reserve limits', () => {
  const dependencies = v2({file:340,inactive_file:330,anon:127,shmem:0,file_dirty:0,file_writeback:0});
  assert.equal(availableMemory(undefined,dependencies),199 * MiB);
  const withHeap = {...dependencies,heapStatistics:() => ({heap_size_limit:272 * MiB,used_heap_size:40 * MiB})};
  assert.equal(processingBudget(undefined,withHeap),167 * MiB);
  assert.equal(processingBudget(undefined,{...withHeap,heapStatistics:() => ({heap_size_limit:96 * MiB,used_heap_size:50 * MiB})}),14 * MiB);
  assert.equal(processingBudget(0,withHeap),0); assert.equal(availableMemory(13,dependencies),13);
});

test('dirty, shared, active and anonymous memory never receive cache credit', () => {
  assert.equal(availableMemory(undefined,v2({file:340,inactive_file:330,shmem:120,file_dirty:180,file_writeback:30})),39 * MiB);
  assert.equal(availableMemory(undefined,v2({file:340,inactive_file:330,shmem:340})),34 * MiB);
  assert.equal(availableMemory(undefined,v2({anon:478,active_file:330})),34 * MiB);
  assert.equal(processingBudget(undefined,{...v2({anon:510},510),heapStatistics:() => ({heap_size_limit:256 * MiB,used_heap_size:16 * MiB})}),0);
  assert.equal(availableMemory(undefined,v2({file:10,inactive_file:1000})),39 * MiB);
});

test('cgroup v1 hierarchical cache, missing statistics and host MemAvailable are handled conservatively', () => {
  const dependencies = fakeMemory({'/sys/fs/cgroup/memory/memory.limit_in_bytes':512 * MiB,'/sys/fs/cgroup/memory/memory.usage_in_bytes':478 * MiB,
    '/sys/fs/cgroup/memory/memory.stat':`total_cache ${340 * MiB}\ntotal_inactive_file ${330 * MiB}\ntotal_dirty ${10 * MiB}\ntotal_writeback ${10 * MiB}\ntotal_shmem ${20 * MiB}`});
  assert.equal(availableMemory(undefined,dependencies),184 * MiB);
  assert.equal(availableMemory(undefined,fakeMemory({'/sys/fs/cgroup/memory.max':512 * MiB,'/sys/fs/cgroup/memory.current':478 * MiB})),34 * MiB);
  assert.equal(availableMemory(undefined,{...fakeMemory({'/proc/meminfo':'MemAvailable:    131072 kB\n'}),freeMemory:() => 16 * MiB}),128 * MiB);
  assert.equal(availableMemory(undefined,fakeMemory({'/sys/fs/cgroup/memory.max':'max','/sys/fs/cgroup/memory.current':400 * MiB})),8192 * MiB);
});

test('Responses encrypted reasoning supports exact request, JSON, event and WebSocket paths without rewriting opaque bytes', () => {
  const input = JSON.stringify({model:'gpt-6.1-sol',input:[reasoning(),{role:'user',content:'contact alice@example.com'}]});
  const response = JSON.stringify({object:'response',status:'completed',output:[reasoning()]});
  const outputs = [mask(raw(input,response)),mask(raw('{}',sse([{type:'response.output_item.added',output_index:0,item:reasoning()},terminal()]))),
    mask(raw('{}',sse([{...terminal(),response:{...terminal().response,output:[reasoning()]}}]))),
    mask(raw('','',[
      {direction:'out',at:0,binary:false,body:Buffer.from(JSON.stringify({type:'response.create',response:{input:[reasoning()]}}))},
      {direction:'in',at:1,binary:false,body:Buffer.from(JSON.stringify({type:'response.output_item.done',item:reasoning()}))}
    ]))];
  for (const result of outputs) {
    assert.deepEqual(result.warnings,['OPAQUE_ENCRYPTED_REASONING']);
    for (const body of [result.payload.request,result.payload.response,...result.payload.frames.map(frame => frame.body)]) {
      assert(!body.toString().includes('alice@example.com')); if (body.length > 10 && body.toString().includes('encrypted_content')) assert(body.includes(encrypted));
    }
  }
  const lexical = input.replace('"encrypted_content":','"encrypted_content" : ').replace('gAAAAAB_','gAAAAAB\\u005f');
  assert(mask(raw(lexical)).payload.request.toString().includes('"encrypted_content" : "gAAAAAB\\u005f'));
  const item = JSON.parse(outputs[0].payload.request).input[0];
  assert.equal(item.id,reasoning().id);assert.equal(item.type,'reasoning');assert.equal(item.status,'completed');assert.equal(item.summary[0].type,'summary_text');
  const responseItem = JSON.parse(outputs[0].payload.response).output[0];assert.equal(responseItem.id,item.id);
  const events = [{type:'response.output_item.added',item:reasoning()},{type:'response.reasoning_summary_text.delta',item_id:reasoning().id,delta:'alice@example.com'}];
  const eventOutput = mask(raw('{}',sse(events))).payload.response.toString().split('\r\n\r\n').filter(Boolean).map(value => JSON.parse(value.split('\r\n')[1].slice(6)));
  assert.equal(eventOutput[0].item.id,eventOutput[1].item_id);assert.equal(eventOutput[0].item.id,reasoning().id);
  const business = JSON.parse(mask(raw(JSON.stringify({customer:{type:'reasoning',id:'private-customer-id'}}))).payload.request);
  assert.match(business.customer.id,/^<IDENTITY_/);
});

test('encrypted reasoning exemptions do not pass arbitrary keys, paths, nested tool JSON or custom rewrites', () => {
  for (const value of [{encrypted_content:encrypted},{item:reasoning()},{type:'unrecognized',item:reasoning()},
    {model:'example',input:[{...reasoning(),type:'message'}]}, {metadata:{type:'response.output_item.added',item:reasoning()}},
    {type:'response.output_item.added',item:{...reasoning(),encrypted_content:'alice@example.com'}},
    {messages:[{role:'tool',content:JSON.stringify({type:'response.output_item.added',item:reasoning()})}]}]) {
    assert.throws(() => mask(raw(JSON.stringify(value))),/UNINSPECTABLE_CONTENT/);
  }
  assert.throws(() => maskPayload(raw(JSON.stringify({model:'gpt-6.1-sol',input:[reasoning()]})),{...defaults,custom:[{from:'fictional-encrypted',to:'changed'}]},Buffer.alloc(32,1)),/PROTECTED_FIELD_MATCH/);
  for (const from of [reasoning().id,'summary_text']) assert.throws(() => maskPayload(raw(JSON.stringify({model:'gpt-6.1-sol',input:[reasoning()]})),{...defaults,custom:[{from,to:'changed'}]},Buffer.alloc(32,1)),/PROTECTED_FIELD_MATCH/);
});

test('business file IDs in real tool results and streamed arguments are consistently masked, while actual references stay protected', () => {
  const data = JSON.stringify([{file_id:'123456789',email:'alice@example.com',note:'reference 123456789'}]);
  const value = {model:'example',messages:[{role:'tool',tool_call_id:'call_demo',content:data},{role:'user',content:'reference 123456789'}]};
  const result = mask(raw(JSON.stringify(value))), out = JSON.parse(result.payload.request), business = JSON.parse(out.messages[0].content);
  assert.deepEqual(result.warnings,[]); assert.match(business[0].file_id,/^<IDENTITY_/); assert(business[0].note.includes(business[0].file_id));
  assert(out.messages[1].content.includes(business[0].file_id)); assert.equal(out.messages[0].tool_call_id,'call_demo');
  const stream = [data.slice(0,16),data.slice(16)].map(delta => ({type:'response.function_call_arguments.delta',item_id:'item_demo',delta}));
  const masked = mask(raw('{}',sse(stream))).payload.response.toString();
  assert(!masked.includes('123456789')); assert(!masked.includes('alice@example.com'));
  for (const body of [{file_id:'123456789'},{content:JSON.stringify({file_id:'123456789'})},
    {messages:[{role:'tool',content:JSON.stringify({file_id:'file_private-reference'})}]},
    {messages:[{role:'tool',content:JSON.stringify({type:'input_file',file_id:'123456789'})}]},
    {messages:[{role:'tool',content:JSON.stringify({file:{file_id:'123456789'}})}]}]) {
    assert.throws(() => mask(raw(JSON.stringify(body))),/UNINSPECTABLE_CONTENT/);
  }
});

test('temporary memory pressure and fixed sensitive-value limits remain distinct without truncating the fallback', t => {
  const f = fixture({processingLimits:() => ({maxOutputBytes:128})}); t.after(() => f.close());
  const row = event('pressure',{request:Buffer.from('{}').toString('base64'),response:zlib.gzipSync(Buffer.from('x'.repeat(2000))).toString('base64'),encoding:'gzip'});
  assert(f.store.ingest(row).accepted); assert.equal(f.store.detail(row.id).processing_error,'REDACTION_MEMORY_PRESSURE');
  assert.equal(f.store.payload(row.id,'original','response').body.toString('base64'),row.response);
  f.store.processingLimits = () => ({});
  const many = event('value-limit',{request:Buffer.from(JSON.stringify(Array.from({length:257},(_,i) => ({name:'Private Customer ' + i})))).toString('base64')});
  assert(f.store.ingest(many).accepted); assert.equal(f.store.detail(many.id).processing_error,'REDACTION_VALUE_LIMIT');
  assert.equal(f.store.payload(many.id,'original','request').body.toString('base64'),many.request);
});

test('application completion parses valid terminal events and preserves original transport and push restrictions', t => {
  const f = fixture();t.after(() => f.close()); const push = new ConversationPushStore(f.store).initialize();
  const row = event('terminal-with-read-error',{protocol:'SSE',complete:false,reason:'read_error',response:Buffer.from(sse([terminal()])).toString('base64')});
  f.store.ingest(row); const saved = f.store.detail(row.id);
  assert.equal(saved.upstream_status,'completed'); assert.equal(saved.upstream_evidence,'response.completed'); assert.equal(saved.completion_source,'original');
  assert(!saved.complete);assert.equal(saved.reason,'read_error'); assert(!push.copyReady(push.metadata(row.id),'original',f.store.policy()));
  assert.equal(f.store.list().items[0].upstream_status,'completed');
});

test('completion evidence rejects forged strings, malformed SSE, contradictory events and unterminated tails', () => {
  assert.equal(inspect(sse([terminal()])).upstream_status,'completed');
  for (const text of [sse([{type:'response.output_text.delta',delta:JSON.stringify(terminal())}]),'data: [DONE]\n\n']) assert.equal(inspect(text).upstream_status,'unknown');
  for (const text of [sse([terminal()]) + 'data: {"type":',sse([terminal()]).trimEnd(),sse([terminal()]) + 'data: not-json\n\n',
    'event: response.failed\ndata: ' + JSON.stringify(terminal()) + '\n\n',sse([{...terminal(),response:{status:'failed'}}])]) assert.equal(inspect(text).upstream_status,'unverified');
  assert.equal(inspect(sse([terminal(),{type:'response.created',response:{id:'second',status:'in_progress'}}])).upstream_status,'unknown');
  assert.equal(inspect(sse([terminal(),terminal('failed')])).upstream_status,'failed');
  assert.equal(inspect(sse([terminal('incomplete'),terminal()])).upstream_status,'incomplete');
  assert.equal(inspect(sse([terminal('failed'),terminal()])).upstream_evidence,'response.failed');
  const privateStatus = inspect(JSON.stringify({object:'response',status:'private-user-value'}),{protocol:'JSON'});
  assert.equal(privateStatus.upstream_status,'unverified');assert(!JSON.stringify(privateStatus).includes('private-user-value'));
});

test('JSON, compressed SSE, chat choices, Claude, Gemini and all incoming WS frames receive independent completion evidence', () => {
  assert.equal(inspect(JSON.stringify(terminal().response),{protocol:'JSON'}).upstream_status,'completed');
  assert.equal(inspect(zlib.gzipSync(Buffer.from(sse([terminal()]))),{encoding:'gzip'}).upstream_status,'completed');
  assert.equal(inspect(sse([terminal()]),{}, {maxOutputBytes:1}).upstream_evidence,'resource');
  assert.equal(inspect('{}',{protocol:'JSON',status:503}).upstream_status,'failed');
  const choices = [{object:'chat.completion.chunk',id:'chat_demo',choices:[{index:0,finish_reason:null,delta:{content:'text'}}]},
    {object:'chat.completion.chunk',id:'chat_demo',choices:[{index:0,finish_reason:'stop',delta:{}}]}];
  const chat = choices.map(value => 'data: ' + JSON.stringify(value) + '\n\n').join('') + 'data: [DONE]\n\n';
  assert.equal(inspect(chat).upstream_status,'completed'); choices[1].choices[0].finish_reason = 'length';
  assert.equal(inspect(JSON.stringify(choices[1]),{protocol:'JSON'}).upstream_status,'incomplete');
  assert.equal(inspect(sse([{type:'message_start',message:{type:'message'}},{type:'message_stop'}])).upstream_status,'completed');
  assert.equal(inspect(JSON.stringify({candidates:[{index:0,finishReason:'STOP',content:{parts:[{text:'okay'}]}}]}),{protocol:'JSON'}).upstream_status,'completed');
  const frames = [terminal(),{type:'response.created',response:{id:'second',status:'in_progress'}}].map(value => ({direction:'in',binary:false,body:Buffer.from(JSON.stringify(value))}));
  assert.equal(inspectCompletion(raw('','',frames),{protocol:'WebSocket',status:101}).upstream_status,'unknown');
  frames.pop(); assert.equal(inspectCompletion(raw('','',frames),{protocol:'WebSocket',status:101}).upstream_status,'completed');
  assert.equal(inspectCompletion(raw('','',[{direction:'out',binary:false,body:Buffer.from(JSON.stringify(terminal()))}]),{protocol:'WebSocket',status:101}).upstream_status,'unknown');
  frames.push({direction:'in',binary:true,body:Buffer.from([1])}); assert.equal(inspectCompletion(raw('','',frames),{protocol:'WebSocket',status:101}).upstream_evidence,'binary');
});

test('encrypted reasoning retains exact original in masked mode and stays ineligible for masked export', t => {
  const f = fixture(); t.after(() => f.close()); const policy = f.store.configure({...f.store.policy(),mode:'masked'});
  const row = event('opaque-reasoning',{policy_version:policy.version,request:Buffer.from(JSON.stringify({model:'gpt-6.1-sol',input:[reasoning()]})).toString('base64')});
  f.store.ingest(row); const saved = f.store.detail(row.id); assert(!saved.processing_error);assert(saved.original && saved.masked);
  assert.deepEqual(saved.inspection_warnings,['OPAQUE_ENCRYPTED_REASONING']);assert.equal(f.store.payload(row.id,'original','request').body.toString('base64'),row.request);
  const push = new ConversationPushStore(f.store).initialize(); assert(!push.copyReady(push.metadata(row.id),'masked',policy)); assert(push.copyReady(push.metadata(row.id),'original',policy));
});

test('additive completion migration never decodes history at startup or changes archived ciphertext', t => {
  const f = fixture();t.after(() => {f.store.close();f.close();});const row = event('schema-completion');f.store.ingest(row);
  const before = f.store.db.prepare('SELECT original,masked,complete,reason,processed_at FROM cl_records WHERE id=?').get(row.id);
  for (const field of ['upstream_status','upstream_evidence','completion_version','completion_source']) f.store.db.exec('ALTER TABLE cl_records DROP COLUMN ' + field);
  f.store.close(); f.store = new ConversationLogStore(f.directory).initialize();
  assert.deepEqual(f.store.db.prepare('SELECT original,masked,complete,reason,processed_at FROM cl_records WHERE id=?').get(row.id),before);
  assert.equal(f.store.detail(row.id).completion_version,0);
});
