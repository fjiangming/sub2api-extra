'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { formatBodies, deliveryBody, deliveryBodyFromRaw, formatDeliveryBodies } = require('../src/services/conversation-envelope');
const { exportBodyBytes } = require('./conversation-logs-fixture');
const { jsonlChunks } = require('../src/services/conversation-jsonl-format');

const encoded = value => Buffer.from(value).toString('base64');
const requestId = '0123456789abcdef0123456789abcdef';
function verify(envelope, side, input, index) {
  const bytes = exportBodyBytes(envelope, side, index);
  assert.deepEqual(bytes, Buffer.from(input, 'base64'));
  const checksum = side === 'frames' ? envelope.checksums.frames[index] : envelope.checksums[side];
  assert.deepEqual(checksum, { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
}

test('decoded JSON, SSE and text frames preserve BOM, Unicode, precision, escapes and line boundaries', () => {
  const request = '\uFEFF{\r\n "big":9007199254740993,"decimal":1.2300,"text":"\u4e2d\u6587 \uD83D\uDE00","literal":"\\n"\r\n}\r\n';
  const response = ': keepalive\r\nevent: delta\r\ndata: {"delta":"\u4e2d\u6587","n":1.2300}\r\n\r\ndata: [DONE]\r\n\r\n';
  const raw = { request: encoded(request), response: encoded(response), frames: [{ direction: 'in', at: 10, binary: false, body: encoded(response) }] };
  const envelope = formatBodies(raw);
  assert.equal(envelope.body_encoding, 'utf-8');assert.deepEqual(envelope.body_encodings,{request:'utf-8',response:'utf-8',frames:['utf-8']});
  assert.equal(envelope.request, request);assert.equal(envelope.response, response);assert.equal(envelope.frames[0].body, response);
  assert(!envelope.body_encoding_reasons);assert.equal(raw.request, encoded(request));
  verify(envelope,'request',raw.request);verify(envelope,'response',raw.response);verify(envelope,'frames',raw.frames[0].body,0);
  const jsonl = [...jsonlChunks(envelope)].join('');
  assert.equal(jsonl.split('\n').length,2);assert.deepEqual(JSON.parse(jsonl),envelope);
});

test('invalid UTF-8, compressed responses and binary frames stay lossless and explicitly encoded', () => {
  const raw = {request:encoded([0xc0,0xaf,0xff]),response:zlib.gzipSync(Buffer.from('data: [DONE]\n\n')).toString('base64'),
    frames:[{direction:'in',at:0,binary:true,body:encoded('binary ASCII')},{direction:'out',at:1,binary:false,body:encoded('readable')},
      {direction:'in',at:2,binary:false,body:encoded([0xff,0xfe])}]};
  const envelope = formatBodies(raw,{encoding:'gzip'});
  assert.equal(envelope.body_encoding,'mixed');assert.equal(envelope.request,raw.request);assert.equal(envelope.response,raw.response);
  assert.deepEqual(envelope.body_encodings,{request:'base64',response:'base64',frames:['base64','utf-8','base64']});
  assert.deepEqual(envelope.body_encoding_reasons,{request:'INVALID_UTF8',response:'COMPRESSED_CONTENT',frames:['BINARY_FRAME','','INVALID_UTF8']});
  verify(envelope,'request',raw.request);verify(envelope,'response',raw.response);
  raw.frames.forEach((frame,index)=>verify(envelope,'frames',frame.body,index));
});

test('empty and identity bodies use text while compressed headers never produce misleading text', () => {
  const empty = formatBodies({request:'',response:'',frames:[]});assert.equal(empty.body_encoding,'utf-8');assert.equal(empty.request,'');
  const raw = {request:encoded('{}'),response:encoded('ASCII still declared compressed'),frames:[]};
  assert.equal(formatBodies(raw,{encoding:'identity'}).response,'ASCII still declared compressed');
  for (const encoding of ['gzip','br','deflate','zstd','unknown','gzip, br']) {
    const envelope = formatBodies(raw,{encoding});assert.equal(envelope.response,raw.response);assert.equal(envelope.body_encodings.response,'base64');
  }
});

test('legacy formatting retains the exact old property order and Base64 payload for resumable deliveries', () => {
  const raw = {request:encoded('{ "n":1.2300 }'),response:encoded('data: [DONE]\n\n'),frames:[]};
  const envelope = formatBodies(raw,{version:1});
  assert.deepEqual(Object.keys(envelope),['body_encoding','request','response','frames','checksums']);
  assert.equal(envelope.body_encoding,'base64');assert.equal(envelope.request,raw.request);assert.equal(envelope.response,raw.response);
  assert(!envelope.body_encodings);verify(envelope,'request',raw.request);verify(envelope,'response',raw.response);
  assert.throws(()=>formatBodies(raw,{version:5}),/UNSUPPORTED_ENVELOPE_VERSION/);
});

function current(raw, encoding = '') {
  return {schema:'sub2api.conversation.v4',delivery_id:'private-id',source:'original',metadata:{request_id:requestId,encoding,user_id:123},...formatBodies(raw,{encoding})};
}

test('public JSON retains the gateway request ID and exact compressed text with only three fields', () => {
  const text='\uFEFF{\r\n "id":9007199254740993,"n":1.2300,"text":"\u4e2d\u6587"\r\n}\r\n';
  for (const [encoding,compress] of [['gzip',zlib.gzipSync],['br',zlib.brotliCompressSync],['deflate',zlib.deflateSync],['zstd',zlib.zstdCompressSync]]) {
    const raw={request:encoded(text),response:compress(Buffer.from(text)).toString('base64'),frames:[]};
    const envelope=current(raw,encoding),body=deliveryBody(envelope);
    assert.deepEqual(body,{request_id:requestId,request:text,response:text});assert.deepEqual(Object.keys(body),['request_id','request','response']);
    assert.deepEqual(JSON.parse([...jsonlChunks(body)].join('')),body);
    assert.equal(envelope.metadata.user_id,123);assert.equal(envelope.response,raw.response);
  }
});

test('public WebSocket sides preserve every message, empty frames, binary bytes and handshake bodies', () => {
  const raw={request:encoded('handshake request'),response:encoded('handshake response'),frames:[
    {direction:'out',at:0,binary:false,body:encoded('{ "n":1.2300 }')},
    {direction:'in',at:1,binary:true,body:encoded([0,255,1])},
    {direction:'out',at:2,binary:false,body:''},
    {direction:'in',at:3,binary:false,body:encoded('data: [DONE]\r\n\r\n')}]};
  const body=deliveryBody(current(raw));
  assert.deepEqual(body,{request_id:requestId,request:['handshake request','{ "n":1.2300 }',''],
    response:['handshake response','data:application/octet-stream;base64,AP8B','data: [DONE]\r\n\r\n']});
  assert.deepEqual(Object.keys(body),['request_id','request','response']);
});

test('new delivery never substitutes vendor, archive or delivery IDs for a missing gateway request ID', () => {
  const raw={request:encoded('{"request_id":"vendor-request"}'),response:encoded('{"id":"resp_supplier"}'),frames:[]};
  for(const value of [undefined,null,'','resp_supplier','0123456789abcdef',requestId.toUpperCase(),123]) {
    const envelope=current(raw);envelope.metadata.request_id=value;envelope.metadata.id=requestId;
    assert.throws(()=>deliveryBody(envelope),{code:'EXPORT_REQUEST_ID'});
  }
  const missing=current(raw);delete missing.metadata;assert.throws(()=>deliveryBody(missing),{code:'EXPORT_REQUEST_ID'});
  assert.deepEqual(deliveryBody(current(raw)),{request_id:requestId,request:Buffer.from(raw.request,'base64').toString(),response:'{"id":"resp_supplier"}'});
});

test('legacy v3 preserves its exact two-field delivery bytes even when gateway metadata contains a request ID', () => {
  const raw={request:encoded(' {"n":1.2300}\r\n'),response:encoded('data: [DONE]\r\n\r\n'),frames:[]};
  const envelope={...current(raw),schema:'sub2api.conversation.v3',...formatBodies(raw,{version:3})};
  assert.equal(JSON.stringify(deliveryBody(envelope)),JSON.stringify({request:' {"n":1.2300}\r\n',response:'data: [DONE]\r\n\r\n'}));
  delete envelope.metadata.request_id;
  assert.deepEqual(Object.keys(deliveryBody(envelope)),['request','response']);
  const ws={...envelope,...formatBodies({...raw,frames:[{direction:'out',at:0,binary:false,body:''}]},{version:3})};
  assert.deepEqual(deliveryBody(ws),{request:[' {"n":1.2300}\r\n',''],response:['data: [DONE]\r\n\r\n']});
});

test('invalid text, damaged compression, unknown encoding and unconsumed tails retain original wire bytes', () => {
  const bad=encoded([255,192]);
  const binary=deliveryBody(current({request:bad,response:'',frames:[]}));
  assert.equal(binary.request,'data:application/octet-stream;base64,'+bad);assert.equal(binary.request_id,requestId);
  for(const [encoding,bytes] of [['gzip',Buffer.from('broken')],['br',Buffer.concat([zlib.brotliCompressSync(Buffer.from('hello')),Buffer.from('tail')])],['unknown',Buffer.from('opaque')]]) {
    const body=deliveryBody(current({request:'',response:bytes.toString('base64'),frames:[]},encoding));
    assert.equal(body.request_id,requestId);
    assert.equal(body.response,`data:application/octet-stream;content-encoding=${encoding};base64,${bytes.toString('base64')}`);
    assert.deepEqual(Buffer.from(body.response.split(',')[1],'base64'),bytes);
  }
});

test('decompression memory refusal never changes payload bytes or silently returns a shortened response', () => {
  const raw={request:'',response:zlib.gzipSync(Buffer.from('x'.repeat(10000))).toString('base64'),frames:[]},envelope=current(raw,'gzip');
  assert.throws(()=>deliveryBody(envelope,{maxOutputBytes:100}),{code:'EXPORT_MEMORY'});
  assert.throws(()=>deliveryBody(envelope,{maxOutputBytes:0}),{code:'EXPORT_MEMORY'});
  assert.equal(deliveryBody(envelope,{maxOutputBytes:20000}).response.length,10000);assert.equal(envelope.response,raw.response);
  for(const version of [1,2]) {
    const legacy={schema:'sub2api.conversation.v'+version,metadata:{encoding:'gzip'},...formatBodies(raw,{version,encoding:'gzip'})};
    assert.equal(deliveryBody(legacy),legacy);
  }
});

test('direct push decoding uses its admitted output budget without changing compressed content on refusal', () => {
  const text = 'x'.repeat(10000), raw = {request:'',response:zlib.gzipSync(Buffer.from(text)).toString('base64'),frames:[]};
  const original = raw.response, options = {version:4,requestId,encoding:'gzip'};
  assert.throws(() => formatDeliveryBodies(raw,{...options,maxOutputBytes:100}),{code:'EXPORT_MEMORY'});
  assert.equal(raw.response,original);
  assert.equal(formatDeliveryBodies(raw,{...options,maxOutputBytes:20000}).response,text);
});

test('direct raw downloads retain the exact shared delivery bytes for text, compression and WebSocket content', () => {
  const text='\uFEFF{\r\n "n":9007199254740993,"decimal":1.2300,"text":"\u4e2d\u6587 \uD83D\uDE00","literal":"\\n"\r\n}\r\n';
  const cases=[{raw:{request:encoded(text),response:encoded('data: [DONE]\r\n\r\n'),frames:[]}},
    {raw:{request:'',response:'',frames:[]}},
    {raw:{request:encoded([255,192]),response:encoded([0,255]),frames:[]}},
    {raw:{request:encoded(text),response:encoded(text),frames:[]},encoding:'identity'},
    {raw:{request:'',response:encoded('invalid compressed data'),frames:[]},encoding:'gzip'},
    {raw:{request:'',response:encoded('opaque bytes'),frames:[]},encoding:'gzip, br'},
    {raw:{request:'',response:Buffer.concat([zlib.brotliCompressSync(Buffer.from(text)),Buffer.from('tail')]).toString('base64'),frames:[]},encoding:'br'},
    {raw:{request:encoded('handshake request'),response:encoded('handshake response'),frames:[
      {direction:'out',at:0,binary:false,body:encoded(text)}, {direction:'in',at:1,binary:true,body:encoded([0,255,1])},
      {direction:'out',at:2,binary:false,body:''}, {direction:'in',at:3,binary:false,body:encoded([255,192])}]}}];
  for (const [encoding,compress] of [['gzip',zlib.gzipSync],['br',zlib.brotliCompressSync],['deflate',zlib.deflateSync],['zstd',zlib.zstdCompressSync]]) {
    cases.push({raw:{request:encoded(text),response:compress(Buffer.from(text)).toString('base64'),frames:[]},encoding});
  }
  for (const version of [3,4]) for (const {raw,encoding=''} of cases) {
    const before=JSON.stringify(raw),options={version,encoding,requestId};
    const envelope={schema:'sub2api.conversation.v'+version,metadata:{request_id:requestId,encoding},...formatBodies(raw,options)};
    assert.equal([...jsonlChunks(deliveryBodyFromRaw(raw,options))].join(''),[...jsonlChunks(deliveryBody(envelope))].join(''));
    const optimized={...envelope,...formatDeliveryBodies(raw,options)};
    assert.equal([...jsonlChunks(deliveryBody(optimized))].join(''),[...jsonlChunks(deliveryBody(envelope))].join(''));
    assert.equal(JSON.stringify(raw),before);
  }
  for (const version of [1,2]) for (const {raw,encoding=''} of cases) {
    assert.deepEqual(formatDeliveryBodies(raw,{version,encoding}),formatBodies(raw,{version,encoding}));
  }
});

test('direct raw downloads enforce request identity and decompression memory protection without dropping content', () => {
  const raw={request:'',response:zlib.gzipSync(Buffer.from('x'.repeat(10000))).toString('base64'),frames:[]};
  const options={version:4,encoding:'gzip',requestId},before=JSON.stringify(raw);
  for (const value of [undefined,null,'',123,requestId.toUpperCase()]) {
    assert.throws(()=>deliveryBodyFromRaw(raw,{...options,requestId:value}),{code:'EXPORT_REQUEST_ID'});
  }
  for (const maxOutputBytes of [0,100]) assert.throws(()=>deliveryBodyFromRaw(raw,options,{maxOutputBytes}),{code:'EXPORT_MEMORY'});
  assert.deepEqual(deliveryBodyFromRaw(raw,options,{maxOutputBytes:20000}),{request_id:requestId,request:'',response:'x'.repeat(10000)});
  assert.deepEqual(deliveryBodyFromRaw(raw,{...options,version:3,requestId:undefined},{maxOutputBytes:20000}),{request:'',response:'x'.repeat(10000)});
  assert.throws(()=>deliveryBodyFromRaw(raw,{...options,version:5}),/UNSUPPORTED_ENVELOPE_VERSION/);
  assert.equal(JSON.stringify(raw),before);
});
