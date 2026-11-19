'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { availableMemory, processingBudget, processingBudgets } = require('../src/services/conversation-memory');
const { maskPayload } = require('../src/services/conversation-redaction');
const { inspectCompletion } = require('../src/services/conversation-completion');
const { fixture,event,removeMetadata } = require('./conversation-logs-fixture');
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
const compaction = () => ({type:'compaction',id:'cmp_12345678901234567890',encrypted_content:encrypted,metadata:{email:'alice@example.com'}});
const imageUrl = 'data:image/png;base64,aGVsbG8=';
const imageRequest = (image = imageUrl, model = 'gpt-6.1-sol') => ({model,input:[{role:'user',content:[{type:'input_text',text:'contact alice@example.com'},
  {type:'input_image',image_url:image,detail:'auto'}]}]});
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

test('process and heap headroom remain independent while legacy callers retain the stricter budget', () => {
  const dependencies = {...v2({anon:128},128),heapStatistics:() => ({heap_size_limit:192 * MiB,used_heap_size:48 * MiB})};
  assert.deepEqual(processingBudgets(undefined,dependencies),{memory:352 * MiB,heap:112 * MiB});
  assert.equal(processingBudget(undefined,dependencies),112 * MiB);
  assert.deepEqual(processingBudgets(80 * MiB,dependencies),{memory:48 * MiB,heap:112 * MiB});
  assert.equal(processingBudget(80 * MiB,dependencies),48 * MiB);
  assert.deepEqual(processingBudgets(16 * MiB,{...dependencies,heapStatistics:() => ({heap_size_limit:64 * MiB,used_heap_size:48 * MiB})}),
    {memory:0,heap:0});
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

test('Responses compaction preserves encrypted context and item identity across request, compact response, events and WebSocket', () => {
  const request = {model:'gpt-6.1-sol',input:[compaction(),{role:'user',content:'contact alice@example.com'}]};
  const response = {object:'response.compaction',output:[compaction()]};
  const events = [{type:'response.output_item.added',item:compaction()},{type:'response.output_item.done',item:compaction()},
    {...terminal(),response:{...terminal().response,output:[compaction()]}}];
  const results = [mask(raw(JSON.stringify(request),JSON.stringify(response))),mask(raw('{}',sse(events))),
    ...[{type:'response.create',...request},{type:'response.create',response:{input:request.input}}].map(document => mask(raw('','',[
      {direction:'out',at:0,binary:false,body:Buffer.from(JSON.stringify(document))},
      {direction:'in',at:1,binary:false,body:Buffer.from(JSON.stringify(events[1]))}
    ])))];
  for (const result of results) {
    assert.deepEqual(result.warnings,['OPAQUE_ENCRYPTED_COMPACTION']);
    for (const body of [result.payload.request,result.payload.response,...result.payload.frames.map(frame => frame.body)]) {
      assert(!body.includes('alice@example.com'));
      if (body.includes('encrypted_content')) { assert(body.includes(encrypted));assert(body.includes(compaction().id));assert(body.includes('"type":"compaction"')); }
    }
  }
  const parsed = JSON.parse(results[0].payload.request);assert.match(parsed.input[0].metadata.email,/^<EMAIL_/);
  const business = JSON.parse(mask(raw(JSON.stringify({customer:{type:'compaction',id:'private-customer-id'}}))).payload.request);
  assert.match(business.customer.id,/^<IDENTITY_/);
  const lexical = JSON.stringify(request).replace('"encrypted_content":','"encrypted_content" : ').replaceAll('gAAAAAB_','gAAAAAB\\u005f');
  assert(mask(raw(lexical)).payload.request.toString().includes('"encrypted_content" : "gAAAAAB\\u005f'));
  const combined = mask(raw(JSON.stringify({...request,input:[reasoning(),compaction(),...imageRequest().input]})));
  assert.deepEqual(combined.warnings,['OPAQUE_ENCRYPTED_COMPACTION','OPAQUE_ENCRYPTED_REASONING','OPAQUE_IMAGE']);
});

test('compaction compatibility rejects arbitrary ciphertext, tool impersonation, unknown paths and protected custom replacements', () => {
  for (const value of [{encrypted_content:encrypted},{...compaction()},{input:[compaction()]},{metadata:{model:'example',input:[compaction()]}},
    {type:'unknown',item:compaction()},{output:[compaction()]},{object:'unknown',output:[compaction()]},
    {model:'example',input:[{...compaction(),encrypted_content:'alice@example.com'}]},
    {model:'example',input:[{...compaction(),encrypted_data:'private-ciphertext'}]},
    {messages:[{role:'tool',content:JSON.stringify({model:'example',input:[compaction()]})}]}]) {
    assert.throws(() => mask(raw(JSON.stringify(value))),/UNINSPECTABLE_CONTENT/);
  }
  const request = JSON.stringify({model:'gpt-6.1-sol',input:[compaction()]});
  for (const from of [encrypted,compaction().id,'compaction']) {
    assert.throws(() => maskPayload(raw(request),{...defaults,custom:[{from,to:'changed'}]},Buffer.alloc(32,1)),/PROTECTED_FIELD_MATCH/);
  }
});

test('compaction history retains ciphertext and falls back to original for uninspected content', t => {
  const f = fixture();t.after(() => f.close());const policy = f.store.configure({...f.store.policy(),mode:'masked'});
  const request = JSON.stringify({model:'gpt-6.1-sol',input:[compaction()]}),row = event('legacy-compaction',{policy_version:policy.version,request:Buffer.from(request).toString('base64')});
  assert(f.store.ingest(row).accepted);
  const original = f.store.db.prepare('SELECT original FROM cl_records WHERE id=?').get(row.id).original,saved = f.store.detail(row.id);
  f.store.db.prepare("UPDATE cl_records SET masked=NULL,processing_error='UNINSPECTABLE_CONTENT',redaction_version=0,inspection_warnings='[]' WHERE id=?").run(row.id);
  const retried = f.store.retry(row.id,{policy_version:policy.version,processed_at:saved.processed_at});
  assert.equal(retried.processing_error,'');assert.equal(retried.redaction_version,6);assert(retried.original && retried.masked);
  assert.deepEqual(retried.inspection_warnings,['OPAQUE_ENCRYPTED_COMPACTION']);assert(retried.complete);assert.equal(retried.reason,'');
  assert.deepEqual(f.store.db.prepare('SELECT original FROM cl_records WHERE id=?').get(row.id).original,original);
  assert.equal(f.store.payload(row.id,'original','request').text,request);
  assert.equal(JSON.parse(f.store.payload(row.id,'masked','request').text).input[0].encrypted_content,encrypted);
  const push = new ConversationPushStore(f.store).initialize();assert.deepEqual(push.copySelection(push.metadata(row.id),'masked',policy),{source:'original',fallbackReason:'INSPECTION_INCOMPLETE',blocked:''});assert(push.copyReady(push.metadata(row.id),'original',policy));
});

test('Responses protocol images preserve every image byte while readable request and streamed response text is masked', () => {
  const input = JSON.stringify(imageRequest()).replace('"image_url":','"image_url" : ').replace('aGVsbG8=','aGVsbG8\\u003d');
  const events = [{type:'response.output_text.delta',item_id:'item_demo',delta:'alice@'},
    {type:'response.output_text.delta',item_id:'item_demo',delta:'example.com'},terminal()];
  const response = sse(events), result = mask(raw(input,response));
  assert.deepEqual(result.warnings,['OPAQUE_IMAGE']);
  assert(result.payload.request.toString().includes('"image_url" : "data:image/png;base64,aGVsbG8\\u003d"'));
  const parsed = JSON.parse(result.payload.request);assert.equal(parsed.input[0].content[1].image_url,imageUrl);
  assert.equal(parsed.input[0].content[1].type,'input_image');assert.equal(parsed.input[0].content[1].detail,'auto');
  assert(!result.payload.request.includes('alice@example.com'));
  const output = result.payload.response.toString().split('\r\n\r\n').filter(Boolean).map(value => JSON.parse(value.split('\r\n')[1].slice(6)));
  assert.equal(output.length,events.length);assert.match(output[0].delta + output[1].delta,/^<EMAIL_[A-F0-9]{12}>$/);
  assert.deepEqual(output[2],events[2]);
  const longImage = 'data:image/jpeg;base64,' + '1234'.repeat(256 * 1024);
  const large = mask(raw(JSON.stringify(imageRequest(longImage,'kimi-k3.1-pro'))));
  assert.deepEqual(large.warnings,['OPAQUE_IMAGE']);assert.equal(JSON.parse(large.payload.request).input[0].content[1].image_url,longImage);
});

test('known Chat and Claude image paths preserve embedded images and external references without fetching or rewriting them', () => {
  const reference = 'https://127.0.0.1:1/private.png?token=private-token&email=alice@example.com';
  for (const part of [{type:'image_url',image_url:{url:imageUrl}}, {type:'image_url',image_url:{url:reference}},
    {type:'image',source:{type:'base64',media_type:'image/png',data:'aGVsbG8='}},
    {type:'image',source:{type:'url',url:reference}}]) {
    const document = {model:'example-model',messages:[{role:'user',content:[{type:'text',text:'alice@example.com'},part]}]};
    const result = mask(raw(JSON.stringify(document))),parsed = JSON.parse(result.payload.request);
    assert.deepEqual(result.warnings,['OPAQUE_IMAGE']);assert.deepEqual(parsed.messages[0].content[1],part);
    assert.match(parsed.messages[0].content[0].text,/^<EMAIL_/);
  }
});

test('Responses multimodal function outputs preserve tool images and call association while redacting business data', () => {
  const source = {model:'gpt-6.1-sol',input:[{type:'function_call_output',call_id:'call_12345678901234567890',output:[
    {type:'input_text',text:'contact alice@example.com'},{type:'input_image',image_url:imageUrl,detail:'original'}]}]};
  for (const type of ['function_call_output','custom_tool_call_output']) {
    source.input[0].type = type;
    const result = mask(raw(JSON.stringify(source))),parsed = JSON.parse(result.payload.request);
    assert.deepEqual(result.warnings,['OPAQUE_IMAGE']);assert.equal(parsed.input[0].call_id,source.input[0].call_id);
    assert.equal(parsed.input[0].type,type);assert.deepEqual(parsed.input[0].output[1],source.input[0].output[1]);
    assert.match(parsed.input[0].output[0].text,/^contact <EMAIL_/);
  }
  for (const message of [{...source.input[0],type:'other'},{...source.input[0],call_id:undefined}]) {
    assert.throws(() => mask(raw(JSON.stringify({...source,input:[message]}))),/UNINSPECTABLE_CONTENT/);
  }
  assert.throws(() => mask(raw(JSON.stringify({model:'example',messages:[{role:'tool',content:JSON.stringify(source)}]}))),/UNINSPECTABLE_CONTENT/);
});

test('Claude tool-result images preserve content and tool association only at exact native protocol positions', () => {
  const image = {type:'image',source:{type:'base64',media_type:'image/png',data:'aGVsbG8='}};
  const tool = {type:'tool_result',tool_use_id:'toolu_12345678901234567890',content:[{type:'text',text:'alice@example.com'},image]};
  const document = {model:'claude-opus-5-5',messages:[{role:'user',content:[tool]}]};
  const result = mask(raw(JSON.stringify(document))),parsed = JSON.parse(result.payload.request),output = parsed.messages[0].content[0];
  assert.deepEqual(result.warnings,['OPAQUE_IMAGE']);assert.equal(output.tool_use_id,tool.tool_use_id);
  assert.deepEqual(output.content[1],image);assert.match(output.content[0].text,/^<EMAIL_/);
  for (const invalid of [{...tool,tool_use_id:undefined},{...tool,tool_use_id:123},{...tool,type:'other'}]) {
    assert.throws(() => mask(raw(JSON.stringify({...document,messages:[{role:'user',content:[invalid]}]}))),/UNINSPECTABLE_CONTENT/);
  }
  assert.throws(() => mask(raw(JSON.stringify({...document,messages:[{role:'assistant',content:[tool]}]}))),/UNINSPECTABLE_CONTENT/);
  assert.throws(() => mask(raw(JSON.stringify({model:'example',messages:[{role:'tool',content:JSON.stringify(document)}]}))),/UNINSPECTABLE_CONTENT/);
  for (const from of ['aGVsbG8','image/png']) {
    assert.throws(() => maskPayload(raw(JSON.stringify(document)),{...defaults,custom:[{from,to:'changed'}]},Buffer.alloc(32,1)),/PROTECTED_FIELD_MATCH/);
  }
});

test('WebSocket create wrappers support images and retain frames, encrypted reasoning and their independent inspection scopes', () => {
  for (const document of [{type:'response.create',...imageRequest()},{type:'response.create',response:imageRequest()}]) {
    const request = document.response || document;request.input.unshift(reasoning());
    const frames = [{direction:'out',at:0,binary:false,body:Buffer.from(JSON.stringify(document))},
      {direction:'in',at:1,binary:false,body:Buffer.from(JSON.stringify(terminal()))}];
    const result = mask(raw('','',frames)),parsed = JSON.parse(result.payload.frames[0].body),input = (parsed.response || parsed).input;
    assert.deepEqual(result.warnings,['OPAQUE_ENCRYPTED_REASONING','OPAQUE_IMAGE']);
    assert.equal(input[0].encrypted_content,encrypted);assert.equal(input[1].content[1].image_url,imageUrl);
    assert.match(input[1].content[0].text,/^contact <EMAIL_/);
    assert.deepEqual(result.payload.frames.map(({body,...metadata}) => metadata),frames.map(({body,...metadata}) => metadata));
    assert.deepEqual(result.payload.frames[1].body,frames[1].body);
  }
});

test('image compatibility does not allow fake protocol paths, nested tool JSON, unknown media or sensitive opaque siblings', () => {
  const document = imageRequest();
  for (const value of [{input:document.input}, {...document,input:[{...document.input[0],role:'tool'}]},
    {model:'example',input:[{role:'user',content:[{type:'input_file',image_url:imageUrl}]}]},
    {metadata:document},{model:'example',messages:[{role:'tool',content:JSON.stringify(document)}]},
    imageRequest('data:text/plain;base64,aGVsbG8='),imageRequest('data:image/png;base64,alice@example.com'),
    imageRequest('file:///private.png'),imageRequest('blob:private-reference'),
    {...document,encrypted_data:'private-ciphertext'},
    {model:'example',messages:[{role:'user',content:[{type:'image',source:{type:'base64',media_type:'application/pdf',data:'aGVsbG8='}}]}]}]) {
    assert.throws(() => mask(raw(JSON.stringify(value))),/UNINSPECTABLE_CONTENT/);
  }
  for (const from of ['aGVsbG8','input_image']) {
    assert.throws(() => maskPayload(raw(JSON.stringify(document)),{...defaults,custom:[{from,to:'changed'}]},Buffer.alloc(32,1)),/PROTECTED_FIELD_MATCH/);
  }
  const unchanged = maskPayload(raw(JSON.stringify(document)),{...defaults,custom:[{from:'aGVsbG8',to:'aGVsbG8'}]},Buffer.alloc(32,1));
  assert.deepEqual(unchanged.warnings,['OPAQUE_IMAGE']);
});

test('image history reprocesses with originals intact and selects a marked raw fallback', t => {
  const f = fixture();t.after(() => f.close());const policy = f.store.configure({...f.store.policy(),mode:'masked'});
  const row = event('image-legacy',{policy_version:policy.version,request:Buffer.from(JSON.stringify(imageRequest())).toString('base64')});
  assert(f.store.ingest(row).accepted);const saved = f.store.detail(row.id);
  assert.equal(saved.processing_error,'');assert(saved.original && saved.masked);assert.deepEqual(saved.inspection_warnings,['OPAQUE_IMAGE']);
  const original = f.store.db.prepare('SELECT original FROM cl_records WHERE id=?').get(row.id).original;
  f.store.db.prepare("UPDATE cl_records SET masked=NULL,processing_error='UNINSPECTABLE_CONTENT',redaction_version=0,inspection_warnings='[]' WHERE id=?").run(row.id);
  assert(!f.store.detail(row.id).masked);assert.equal(f.store.detail(row.id).processing_error,'UNINSPECTABLE_CONTENT');
  const retried = f.store.retry(row.id,{policy_version:policy.version,processed_at:saved.processed_at});
  assert.equal(retried.processing_error,'');assert.equal(retried.redaction_version,6);assert(retried.original && retried.masked);
  assert.deepEqual(retried.inspection_warnings,['OPAQUE_IMAGE']);assert(retried.complete);assert.equal(retried.reason,'');
  assert.deepEqual(f.store.db.prepare('SELECT original FROM cl_records WHERE id=?').get(row.id).original,original);
  assert.equal(f.store.payload(row.id,'original','request').body.toString('base64'),row.request);
  const push = new ConversationPushStore(f.store).initialize();
  assert.deepEqual(push.copySelection(push.metadata(row.id),'masked',policy),{source:'original',fallbackReason:'INSPECTION_INCOMPLETE',blocked:''});assert(push.copyReady(push.metadata(row.id),'original',policy));
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

test('completion checks recognize real SSE despite JSON metadata without accepting forged text or truncated events', () => {
  const response = sse([{type:'response.created',response:{id:'resp_demo',status:'in_progress'}},terminal()]);
  for (const prefix of ['',': ping\r\n\r\n','\r\n\r\n']) {
    const result = inspect(prefix + response,{protocol:'JSON'});
    assert.equal(result.upstream_status,'completed');assert.equal(result.upstream_evidence,'response.completed');assert.equal(result.completion_version,2);
  }
  assert.equal(inspect(zlib.gzipSync(Buffer.from(response)),{protocol:'JSON',encoding:'gzip'}).upstream_status,'completed');
  assert.equal(inspect(response,{protocol:'JSON'},{maxOutputBytes:1}).upstream_evidence,'resource');
  for (const text of [response.trimEnd(),response+'data: {"type":',response+'data: invalid\r\n\r\n',
    'event: response.failed\r\ndata: '+JSON.stringify(terminal())+'\r\n\r\n']) assert.equal(inspect(text,{protocol:'JSON'}).upstream_status,'unverified');
  for (const text of [JSON.stringify({text:response}),JSON.stringify({type:'response.output_text.delta',delta:response}),
    JSON.stringify({text:'prefix\n'+response})]) assert.equal(inspect(text,{protocol:'JSON'}).upstream_status,'unknown');
  assert.equal(inspect(sse([terminal('failed')]),{protocol:'JSON'}).upstream_status,'failed');
  assert.equal(inspect(sse([terminal('incomplete')]),{protocol:'JSON'}).upstream_status,'incomplete');
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

test('encrypted reasoning retains exact original in masked mode for a marked export fallback', t => {
  const f = fixture(); t.after(() => f.close()); const policy = f.store.configure({...f.store.policy(),mode:'masked'});
  const row = event('opaque-reasoning',{policy_version:policy.version,request:Buffer.from(JSON.stringify({model:'gpt-6.1-sol',input:[reasoning()]})).toString('base64')});
  f.store.ingest(row); const saved = f.store.detail(row.id); assert(!saved.processing_error);assert(saved.original && saved.masked);
  assert.deepEqual(saved.inspection_warnings,['OPAQUE_ENCRYPTED_REASONING']);assert.equal(f.store.payload(row.id,'original','request').body.toString('base64'),row.request);
  const push = new ConversationPushStore(f.store).initialize();assert.deepEqual(push.copySelection(push.metadata(row.id),'masked',policy),{source:'original',fallbackReason:'INSPECTION_INCOMPLETE',blocked:''});assert(push.copyReady(push.metadata(row.id),'original',policy));
});

test('additive completion migration never decodes history at startup or changes archived ciphertext', t => {
  const f = fixture();t.after(() => {f.store.close();f.close();});const row = event('schema-completion');f.store.ingest(row);
  const before = f.store.db.prepare('SELECT original,masked,complete,reason,processed_at FROM cl_records WHERE id=?').get(row.id);
  removeMetadata(f.store);
  for (const field of ['upstream_status','upstream_evidence','completion_version','completion_source']) f.store.db.exec('ALTER TABLE cl_records DROP COLUMN ' + field);
  f.store.close(); f.store = new ConversationLogStore(f.directory).initialize();
  assert.deepEqual(f.store.db.prepare('SELECT original,masked,complete,reason,processed_at FROM cl_records WHERE id=?').get(row.id),before);
  assert.equal(f.store.detail(row.id).completion_version,0);
});
