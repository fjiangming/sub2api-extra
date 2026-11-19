'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { waitForTestLLM } = require('../src/provider-http');

const signal = () => AbortSignal.timeout(1000);
const lookup = async () => [{ address: '8.8.8.8', family: 4 }];
function transport(chunks, status = 200, type = 'text/event-stream') {
  return (_url, options, callback) => {
    assert.equal(options.method, 'GET');
    assert.equal(options.agent, false);
    assert.equal(options.headers.authorization, undefined);
    options.lookup('', {}, (_error, address) => assert.equal(address, '8.8.8.8'));
    const request = new EventEmitter();
    request.end = () => {
      const response = Readable.from(chunks.map(chunk => Buffer.from(chunk)));
      response.statusCode = status; response.headers = { 'content-type': type };
      callback(response);
    };
    return request;
  };
}
test('TestLLM SSE handles fragmented frames, CRLF, comments and terminates only on done', async () => {
  await waitForTestLLM('https://testllm.ai/api/jobs/one/events', { signal: signal() }, { lookup, request: transport([': keepalive\r\n\r\ndata: {"step":"run', 'ning","message":"思考"}\r\n\r\ndata: {"step":"done"}\r', '\n\r\n']) });
});
test('TestLLM SSE rejects redirects, JSON masquerading as events, malformed, interrupted and remote failed streams', async () => {
  for (const [chunks, status, type, expected] of [
    [[], 302, 'text/event-stream', /HTTP/],
    [['{}'], 200, 'application/json', /INVALID/],
    [['data: not-json\n\n'], 200, 'text/event-stream', /INVALID/],
    [['data: {"step":"running"}\n\n'], 200, 'text/event-stream', /INTERRUPTED/],
    [['data: {"step":"error","message":"private"}\n\n'], 200, 'text/event-stream', /REMOTE_FAILED/],
    [['x'.repeat(65537)], 200, 'text/event-stream', /TOO_LARGE/]
  ]) await assert.rejects(waitForTestLLM('https://testllm.ai/api/jobs/one/events', { signal: signal() }, { lookup, request: transport(chunks, status, type) }), expected);
});
test('TestLLM SSE pins public DNS results and rejects private or mixed resolutions before opening a connection', async () => {
  let calls = 0;
  await assert.rejects(waitForTestLLM('https://testllm.ai/api/jobs/one/events', { signal: signal() }, {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }],
    request: () => { calls++; }
  }), /UNSAFE/);
  assert.equal(calls, 0);
});
