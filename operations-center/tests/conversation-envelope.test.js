'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { formatBodies, deliveryBody } = require('../src/services/conversation-envelope');
const { exportBodyBytes } = require('./conversation-logs-fixture');
const { jsonlChunks } = require('../src/services/conversation-jsonl-format');

const encoded = value => Buffer.from(value).toString('base64');
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
  assert.throws(()=>formatBodies(raw,{version:4}),/UNSUPPORTED_ENVELOPE_VERSION/);
});

function current(raw, encoding = '') {
  return {schema:'sub2api.conversation.v3',delivery_id:'private-id',source:'original',metadata:{encoding,user_id:123},...formatBodies(raw,{encoding})};
}

test('public JSON has exactly two fields and preserves compressed text without parsing vendor JSON', () => {
  const text='\uFEFF{\r\n "id":9007199254740993,"n":1.2300,"text":"\u4e2d\u6587"\r\n}\r\n';
  for (const [encoding,compress] of [['gzip',zlib.gzipSync],['br',zlib.brotliCompressSync],['deflate',zlib.deflateSync],['zstd',zlib.zstdCompressSync]]) {
    const raw={request:encoded(text),response:compress(Buffer.from(text)).toString('base64'),frames:[]};
    const envelope=current(raw,encoding),body=deliveryBody(envelope);
    assert.deepEqual(body,{request:text,response:text});assert.deepEqual(Object.keys(body),['request','response']);
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
  assert.deepEqual(body,{request:['handshake request','{ "n":1.2300 }',''],
    response:['handshake response','data:application/octet-stream;base64,AP8B','data: [DONE]\r\n\r\n']});
  assert.deepEqual(Object.keys(body),['request','response']);
});

test('invalid text, damaged compression, unknown encoding and unconsumed tails retain original wire bytes', () => {
  const bad=encoded([255,192]);
  assert.equal(deliveryBody(current({request:bad,response:'',frames:[]})).request,'data:application/octet-stream;base64,'+bad);
  for(const [encoding,bytes] of [['gzip',Buffer.from('broken')],['br',Buffer.concat([zlib.brotliCompressSync(Buffer.from('hello')),Buffer.from('tail')])],['unknown',Buffer.from('opaque')]]) {
    const body=deliveryBody(current({request:'',response:bytes.toString('base64'),frames:[]},encoding));
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
