'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { fixture, event } = require('./conversation-logs-fixture');
const { ConversationLogStore, defaults } = require('../src/conversation-log-store');
const { ConversationPushStore } = require('../src/conversation-push-store');
const { ConversationPushService } = require('../src/services/conversation-push-service');
const { maskPayload } = require('../src/services/conversation-redaction');

const signature = 'ZmljdGlvbmFsLXByb3RvY29sLXNpZ25hdHVyZQ==';
const signed = () => JSON.stringify({ model:'example-model', messages:[
  {role:'assistant',content:[{type:'thinking',thinking:'contact alice@example.com',signature},{type:'text',text:'reply'}]},
  {role:'user',content:'reply to alice@example.com'}
] });
const raw = text => Buffer.from(text).toString('base64');
const mask = (request, response = '{}', frames = [], policy = defaults) => maskPayload({ request:Buffer.from(request), response:Buffer.from(response), frames }, policy, Buffer.alloc(32, 1));
const expected = (f, id) => ({policy_version:f.store.policy().version,processed_at:f.store.detail(id).processed_at});

test('ordinary URL fields retain lexical components and mask credentials and encoded values', () => {
  const safe = 'HTTPS://Service.Example/a%2Fb/../ref?next=unchanged&value=one+two#overview';
  const url = 'https://alice:private-pass@service.example/u/alice+tag@example.com?email=alice@example.com&phone=%2B12025550148&token=private-token&keep=one+two#access_token=private-fragment';
  const source = '{ "url":' + JSON.stringify(safe) + ',"message":{"url":' + JSON.stringify(url) + '},"n":1.2300,"big":9007199254740993 }';
  const result = mask(source), output = result.payload.request.toString(), parsed = JSON.parse(output);
  assert.deepEqual(result.warnings,[]); assert.equal(parsed.url,safe);
  assert.match(parsed.message.url,/^https:\/\/%3CSECRET_[A-F0-9]{12}%3E@service\.example\/u\/%3CEMAIL_[A-F0-9]{12}%3E\?email=%3CEMAIL_/);
  assert(parsed.message.url.includes('&keep=one+two#access_token=%3CSECRET_'));
  for (const value of ['alice','private-pass','private-token','private-fragment','12025550148']) assert(!output.includes(value),value);
  assert(output.includes('"n":1.2300')); assert(output.includes('"big":9007199254740993'));
  const nested = JSON.parse(mask(JSON.stringify({ arguments:JSON.stringify({url:'https://service.example/?email=alice%40example.com&keep=yes'}) })).payload.request);
  assert.match(JSON.parse(nested.arguments).url,/^https:\/\/service\.example\/\?email=%3CEMAIL_[A-F0-9]{12}%3E&keep=yes$/);
});

test('links in plain and streamed text keep URL structure without fetching external content', () => {
  const url = 'https://service.example/contact?email=alice@example.com&keep=ok';
  const sse = 'data: {"type":"response.output_text.delta","item_id":"item_demo","delta":"https://service.example/contact?email=alice@"}\r\n\r\n' +
    'data: {"type":"response.output_text.delta","item_id":"item_demo","delta":"example.com&keep=ok"}\r\n\r\ndata: [DONE]\r\n\r\n';
  const result = mask('see ' + url + ' please',sse);
  assert.match(result.payload.request.toString(),/^see https:\/\/service\.example\/contact\?email=%3CEMAIL_[A-F0-9]{12}%3E&keep=ok please$/);
  const events = result.payload.response.toString().split('\r\n\r\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
  assert.match(events.map(row => row.delta).join(''),/^https:\/\/service\.example\/contact\?email=%3CEMAIL_[A-F0-9]{12}%3E&keep=ok$/);
  assert.equal(events.length,2); assert(result.payload.response.toString().endsWith('data: [DONE]\r\n\r\n'));
});

test('recognized Claude signatures stay exact while message text and numeric spelling remain intact', () => {
  const request = signed().replace('"signature":"' + signature + '"','"signature" : "Zmlj\\u0064GlvbmFsLXByb3RvY29sLXNpZ25hdHVyZQ=="');
  const response = '{"type":"message","role":"assistant","content":[{"type":"thinking","thinking":"alice@example.com","signature":"' + signature + '"}],"n":1.2300}';
  const result = mask(request,response), text = result.payload.request.toString();
  assert.deepEqual(result.warnings,['OPAQUE_SIGNATURE']); assert(!text.includes('alice@example.com'));
  assert(text.includes('"signature" : "Zmlj\\u0064GlvbmFsLXByb3RvY29sLXNpZ25hdHVyZQ=="'));
  const message = JSON.parse(text).messages;
  assert.deepEqual(message.map(row => row.role),['assistant','user']); assert.equal(message[0].content.length,2);
  assert.equal(JSON.parse(result.payload.response).content[0].signature,signature); assert(result.payload.response.toString().includes('"n":1.2300'));
});

test('Claude signature delta fragments and start blocks do not disrupt streaming text redaction', () => {
  const entries = [
    {type:'content_block_start',index:0,content_block:{type:'thinking',thinking:'',signature}},
    {type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'alice@'}},
    {type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'example.com'}},
    {type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'123456789012345678901234567890'}},
    {type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'=='}},
    {type:'message_stop'}
  ];
  const frames = entries.map((value,index) => ({direction:'in',at:index,body:Buffer.from(JSON.stringify(value)),binary:false}));
  const result = mask('{}','',frames), out = result.payload.frames.map(frame => JSON.parse(frame.body));
  assert.deepEqual(result.warnings,['OPAQUE_SIGNATURE']); assert.equal(out.length,entries.length);
  assert.equal(out[0].content_block.signature,signature); assert.deepEqual(out[3],entries[3]); assert.deepEqual(out[4],entries[4]);
  assert.match(out[1].delta.thinking + out[2].delta.thinking,/^<EMAIL_[A-F0-9]{12}>$/);
  assert.deepEqual(result.payload.frames.map(({body,...frame}) => frame),frames.map(({body,...frame}) => frame));
});

test('Gemini thought signatures in requests, candidates and response wrappers remain opaque', () => {
  for (const document of [
    {contents:[{role:'model',parts:[{text:'alice@example.com',thoughtSignature:signature},{functionCall:{name:'lookup',args:{email:'alice@example.com'}},thought_signature:'skip_thought_signature_validator'}]}]},
    {candidates:[{content:{role:'model',parts:[{text:'alice@example.com',thoughtSignature:signature}]}}]},
    {response:{candidates:[{content:{parts:[{text:'alice@example.com',thoughtSignature:signature}]}}]}}
  ]) {
    const result = mask(JSON.stringify(document)), text = result.payload.request.toString();
    assert.deepEqual(result.warnings,['OPAQUE_SIGNATURE']); assert(!text.includes('alice@example.com')); assert(text.includes(signature));
  }
  const tools = {tools:[{functionDeclarations:[{name:'lookup'}]}],contents:[{role:'model',parts:[
    {functionCall:{id:'call_12345678901234567890',name:'lookup',args:{name:'张三',email:'alice@example.com'}},thoughtSignature:signature},
    {functionResponse:{id:'call_12345678901234567890',name:'lookup',response:{name:'张三',id:'private-customer-id'}},thoughtSignature:signature}
  ]}]};
  const result = JSON.parse(mask(JSON.stringify(tools)).payload.request);
  assert.equal(result.tools[0].functionDeclarations[0].name,'lookup');
  assert.equal(result.contents[0].parts[0].functionCall.name,'lookup');assert.equal(result.contents[0].parts[1].functionResponse.name,'lookup');
  assert.equal(result.contents[0].parts[0].functionCall.id,result.contents[0].parts[1].functionResponse.id);
  assert.equal(result.contents[0].parts[0].functionCall.id,'call_12345678901234567890');
  assert.match(result.contents[0].parts[0].functionCall.args.name,/^<PERSONAL_/);assert.match(result.contents[0].parts[1].functionResponse.response.id,/^<IDENTITY_/);
});

test('unrecognized signatures, encrypted content and actual media still keep only the exact fallback', t => {
  const f=fixture();t.after(()=>f.close());const p=f.store.configure({...f.store.policy(),mode:'masked'});
  const examples = [
    {url:'https://files.example/private.png',type:'input_image'},
    {content:[{type:'image',source:{type:'url',url:'https://files.example/private.png'}}]},
    {image_url:{url:'https://files.example/private.png'}},
    {contents:[{parts:[{fileData:{mimeType:'application/pdf',fileUri:'gs://private-bucket/private.pdf'}}]}]},
    {contents:[{parts:[{inlineData:{mimeType:'image/png',data:'aGVsbG8='}}]}]},
    {encrypted_content:'opaque-private-content'}, {thinking:{signature}},
    {messages:[{role:'assistant',content:[{type:'thinking',thinking:'text',signature:'alice@example.com'}]}]},
    {arguments:JSON.stringify({messages:[{role:'assistant',content:[{type:'thinking',signature}]}]})},
    {url:'https://service.example/?email=alice%XXexample.com'}
  ];
  for (const [index,document] of examples.entries()) {
    const source=JSON.stringify(document),row=event('fallback-'+index,{policy_version:p.version,request:raw(source)});assert(f.store.ingest(row).accepted);
    const detail=f.store.detail(row.id);assert.equal(detail.processing_error,'UNINSPECTABLE_CONTENT');assert(detail.original);assert(!detail.masked);
    assert.deepEqual(detail.inspection_warnings,[]);assert.equal(f.store.payload(row.id,'original','request').text,source);assert(detail.complete);
  }
});

test('custom rules cannot rewrite a protected vendor signature', t => {
  const f=fixture();t.after(()=>f.close());const p=f.store.configure({...f.store.policy(),mode:'masked',custom:[{from:'ZmljdGlv',to:'changed'}]});
  const row=event('signature-custom',{policy_version:p.version,request:raw(signed())});f.store.ingest(row);
  const detail=f.store.detail(row.id);assert.equal(detail.processing_error,'PROTECTED_FIELD_MATCH');assert(detail.original);assert(!detail.masked);
  assert.equal(f.store.payload(row.id,'original','request').text,signed());
});

test('limited inspection persists independently, retains masked-only originals and never alters capture completeness', t => {
  const f=fixture();t.after(()=>f.close());const p=f.store.configure({...f.store.policy(),mode:'masked'});
  const row=event('limited',{policy_version:p.version,request:raw(signed()),complete:false,reason:'read_error'});f.store.ingest(row);
  const before=f.store.detail(row.id);assert.equal(before.processing_error,'');assert.deepEqual(before.inspection_warnings,['OPAQUE_SIGNATURE']);
  assert(before.original&&before.masked&&before.retry_available);assert(!before.complete);assert.equal(before.reason,'read_error');
  assert.deepEqual(f.store.list().items[0].inspection_warnings,['OPAQUE_SIGNATURE']);
  assert.equal(f.store.payload(row.id,'original','request').text,signed());assert(!f.store.payload(row.id,'masked','request').text.includes('alice@example.com'));
  const retried=f.store.retry(row.id,expected(f,row.id));assert(retried.original&&retried.masked);assert.deepEqual(retried.inspection_warnings,['OPAQUE_SIGNATURE']);
  assert(!retried.complete);assert.equal(retried.reason,'read_error');assert(retried.processed_at>before.processed_at);
  assert(!JSON.stringify(retried).includes(signature));
});

test('old schema and failed URL/signature history migrate without rewriting originals or policy', t => {
  const f=fixture();t.after(()=>{f.store.close();f.close();});const p=f.store.configure({...f.store.policy(),mode:'dual'});
  const link=event('legacy-link',{policy_version:p.version,request:raw('{"url":"https://service.example/?email=alice%40example.com&keep=ok"}')});
  const sig=event('legacy-signature',{policy_version:p.version,request:raw(signed())});
  for(const row of [link,sig])f.store.ingest(row);
  f.store.db.exec("UPDATE cl_records SET mode='masked',masked=NULL,processing_error='UNINSPECTABLE_CONTENT',redaction_version=0,redaction_policy_hash=''");
  const encrypted=f.store.db.prepare('SELECT id,original FROM cl_records ORDER BY id').all(),key=Buffer.from(f.store.key);
  f.store.db.exec('ALTER TABLE cl_records DROP COLUMN inspection_warnings');f.store.close();f.store=new ConversationLogStore(f.directory).initialize();
  assert.deepEqual(f.store.key,key);assert.deepEqual(f.store.policy(),p);assert.deepEqual(f.store.db.prepare('SELECT id,original FROM cl_records ORDER BY id').all(),encrypted);
  assert.deepEqual(f.store.detail(link.id).inspection_warnings,[]);
  const linkDone=f.store.retry(link.id,expected(f,link.id));assert(!linkDone.original);assert(linkDone.masked);assert.equal(linkDone.processing_error,'');assert.deepEqual(linkDone.inspection_warnings,[]);
  const sigDone=f.store.retry(sig.id,expected(f,sig.id));assert(sigDone.original&&sigDone.masked);assert.equal(sigDone.processing_error,'');assert.deepEqual(sigDone.inspection_warnings,['OPAQUE_SIGNATURE']);
  assert.equal(f.store.payload(sig.id,'original','request').text,signed());assert.equal(sigDone.redaction_version,3);
});

test('masked push previews, automatic queues and existing JSONL members reject uninspected signatures', async t => {
  const f=fixture(),push=new ConversationPushStore(f.store).initialize(),service=new ConversationPushService(push);t.after(async()=>{await service.stop();f.close();});
  const p=push.policy();push.configure({...p,enabled:true,automatic:true,source:'masked',webhook:{...p.webhook,enabled:true,url:'https://receiver.example/logs'},s3:{...p.s3,enabled:true,endpoint:'https://s3.example',bucket:'fixture-bucket',accessKeyId:'fictional',secretAccessKey:'fictional'}});
  const normal=event('normal-export'),limited=event('limited-export',{request:raw(signed())});f.store.ingest(normal);f.store.ingest(limited);
  assert.equal(push.scanAutomatic().created,2);assert(push.list().items.every(row=>row.record_id===normal.id));
  const preview=push.preview({filter:{},destinations:['webhook','s3']});assert.equal(preview.eligible,1);assert.equal(preview.unavailable,1);
  service.jsonl.store.assignOne();const file=service.jsonl.store.db.prepare('SELECT * FROM cl_push_jsonl_files LIMIT 1').get();assert(file);
  f.store.db.prepare('UPDATE cl_records SET inspection_warnings=? WHERE id=?').run('["OPAQUE_SIGNATURE"]',normal.id);
  const job=push.db.prepare("SELECT * FROM cl_push_jobs WHERE record_id=? AND destination='webhook'").get(normal.id);
  assert.equal(push.validJob(job).cancel,'INSPECTION_INCOMPLETE');assert.equal(service.jsonl.store.invalidReason(file,{full:true}),'INSPECTION_INCOMPLETE');
  const current=push.policy();push.configure({...current,source:'original'});
  const input={filter:{},destinations:['webhook']},selected=push.preview(input);assert.equal(selected.eligible,2);
  push.enqueue({...input,previewToken:selected.previewToken,batchId:crypto.randomUUID()});
  const original=push.db.prepare("SELECT * FROM cl_push_jobs WHERE record_id=? AND source='original'").get(limited.id),envelope=push.envelope(original);
  assert.deepEqual(envelope.metadata.inspection_warnings,['OPAQUE_SIGNATURE']);assert.equal(Buffer.from(envelope.request,'base64').toString(),signed());
});
