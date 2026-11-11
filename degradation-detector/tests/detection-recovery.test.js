'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const { Sub2ApiClient, isTransientModelFailure, retryAfterMs } = require('../src/sub2api-client');
const { DetectionRunner } = require('../src/detection-runner');
const { Store, publicRun } = require('../src/store');
const { testConfig, defaultTests, seedRuntime } = require('./helpers');
const { CredentialVault } = require('../src/credential-vault');

const question = { api: 'responses', model: 'unchanged-model', prompt: 'unchanged question',
  output_type: 'text', reasoning_effort: 'max', max_output_tokens: 512 };
const durationMessage = 'Upstream response exceeded the maximum stream duration';
const completed = { type: 'response.completed', response: { id: 'resp_done', status: 'completed', output_text: '1161' } };

function sse(events, headers = {}) {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream', ...headers } });
}

function harness(fetch, overrides = {}) {
  const config = { sub2apiBaseUrl: 'https://synthetic.invalid', requestTimeoutMs: 60000,
    recoveryTimeoutMs: 180000, recoveryRetries: 2, maxResponseBytes: 1048576, ...overrides };
  let now = 0;
  const calls = [], waits = [], snapshots = [];
  const client = new Sub2ApiClient(config, async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body), signal: options.signal, headers: options.headers });
    return fetch(calls.length, options);
  });
  const runner = new DetectionRunner({ config, store: {}, vault: {}, sub2api: client, randomFn: () => 0,
    nowFn: () => now, sleepFn: async ms => { waits.push(ms); now += ms; } });
  return { runner, calls, waits, snapshots, context: { onAttempts: attempts => snapshots.push(structuredClone(attempts)) },
    advance: ms => { now += ms; } };
}

test('stream duration failure and nested upstream errors recover with identical inference settings', async () => {
  const h = harness(number => number < 3 ? sse([{ type: 'error', error: { code: 'upstream_error', message: durationMessage } }]) : sse([completed]));
  const payload = await h.runner.callModelWithRetry(question, 'synthetic-key', h.context);
  assert.equal(payload.output_text, '1161');
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.waits, [10000, 30000]);
  assert.deepEqual(h.calls.map(call => call.body), Array(3).fill(h.calls[0].body));
  assert.equal(h.calls[0].body.reasoning.effort, 'max');
  const attempts = h.snapshots.at(-1);
  assert.deepEqual(attempts.map(a => a.kind), ['initial', 'recovery', 'recovery']);
  assert.deepEqual(attempts.map(a => a.state), ['failed', 'failed', 'completed']);
  assert.equal(attempts[0].upstream_code, 'upstream_error');
});

test('production HTTP2 and stream interruption terminal errors get one cooled recovery', async () => {
  for (const [code, message] of [
    ['upstream_http2_stream_error', 'Upstream HTTP/2 stream failed'],
    ['upstream_stream_read_error', 'Upstream response stream was interrupted'],
    ['upstream_stream_truncated', 'Upstream response stream ended before completion']
  ]) {
    for (const failed of [
      { type: 'error', code, message },
      { type: 'response.failed', response: { error: { code, message } } }
    ]) {
      const h = harness(number => number === 1 ? sse([
        { type: 'response.output_text.delta', delta: 'abandoned partial' }, failed
      ]) : sse([completed]));
      const result = await h.runner.callModelWithRetry(question, 'key', h.context);
      assert.equal(result.output_text, '1161');
      assert.deepEqual(h.waits, [30000]);
      assert.equal(h.snapshots.at(-1)[0].outcome_unknown, true);
      assert.deepEqual(h.calls[0].body, h.calls[1].body);
    }
    const repeated = harness(() => sse([{ type: 'error', code, message }]));
    await assert.rejects(repeated.runner.callModelWithRetry(question, 'key'), error =>
      error.recoveryAttempts === 1 && error.retryAttempts === 0);
    assert.equal(repeated.calls.length, 2);
  }
});

test('HTTP2 errors in HTTP error bodies never enter the five safe reconnects', async () => {
  for (const status of [200, 500, 502, 503]) {
    const h = harness(() => new Response(JSON.stringify({ error: {
      code: 'upstream_http2_stream_error', message: 'Upstream HTTP/2 stream failed'
    } }), { status, headers: { 'content-type': 'application/json' } }));
    await assert.rejects(h.runner.callModelWithRetry(question, 'key'), error =>
      error.recoveryAttempts === 1 && error.retryAttempts === 0);
    assert.equal(h.calls.length, 2, `HTTP ${status}`);
    assert.deepEqual(h.waits, [30000]);
  }
});

test('Responses recoveries use native sessions without changing inference or requiring gateway extensions', async () => {
  const h = harness(number => sse(number === 3 ? [completed] : [{ type: 'error', code: 'stream_timeout', message: durationMessage }], {
    'x-sub2api-recovery-token': 'legacy-unused', 'x-sub2api-recovery-applied': '1'
  }));
  await h.runner.callModelWithRetry(question, 'key', h.context);
  const sessions = h.calls.map(c => c.headers['session-id']);
  assert.equal(new Set(sessions).size, 3);
  for (const session of sessions) assert.match(session, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(h.calls.every(c => !Object.keys(c.headers).some(key => key.startsWith('x-sub2api-recovery'))));
  assert.ok(h.calls.every(c => JSON.stringify(c.body) === JSON.stringify(h.calls[0].body)));
  assert.ok(h.snapshots.at(-1).every(attempt => !Object.hasOwn(attempt, 'route_recovery')));
  for (const session of sessions) assert.ok(!JSON.stringify(h.snapshots).includes(session));
});

test('safe reconnects preserve native session identity and paid recoveries reset it', async () => {
  const h = harness(number => {
    if (number === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    if (number === 2) return sse([{ type: 'error', code: 'stream_timeout', message: durationMessage }]);
    if (number === 3) return new Response('{"error":{"message":"overloaded"}}', { status: 503 });
    return sse([completed]);
  });
  const result = await h.runner.callModelWithRetry(question, 'key', h.context);
  assert.equal(result.output_text, '1161');
  const sessions = h.calls.map(c => c.headers['session-id']);
  assert.equal(sessions[0], sessions[1]);
  assert.notEqual(sessions[1], sessions[2]);
  assert.equal(sessions[2], sessions[3]);
  assert.deepEqual(h.waits, [1000, 10000, 2000]);
  assert.ok(h.calls.every(c => JSON.stringify(c.body) === JSON.stringify(h.calls[0].body)));
});

test('independent Responses detections do not reuse a content-derived sticky session', async () => {
  const h = harness(() => sse([completed]));
  await h.runner.callModelWithRetry(question, 'key');
  await h.runner.callModelWithRetry(question, 'key');
  assert.notEqual(h.calls[0].headers['session-id'], h.calls[1].headers['session-id']);
  assert.deepEqual(h.calls[0].body, h.calls[1].body);
});

test('native Responses session handling does not change other detection protocols', async () => {
  for (const [api, payload] of [
    ['chat_completions', { choices: [{ message: { content: '1161' }, finish_reason: 'stop' }] }],
    ['anthropic_messages', { content: [{ type: 'text', text: '1161' }], stop_reason: 'end_turn' }],
    ['gemini_generate_content', { candidates: [{ content: { parts: [{ text: '1161' }] }, finishReason: 'STOP' }] }]
  ]) {
    const h = harness(number => new Response(JSON.stringify(number === 1 ? { error: {
      code: 'upstream_http2_stream_error', message: 'Upstream HTTP/2 stream failed'
    } } : payload), { headers: { 'content-type': 'application/json' } }));
    await h.runner.callModelWithRetry({ ...question, api }, 'key', h.context);
    assert.equal(h.calls.length, 2, api);
    assert.deepEqual(h.waits, [30000], api);
    assert.deepEqual(h.calls[0].body, h.calls[1].body, api);
    assert.ok(h.calls.every(call => !Object.keys(call.headers).some(key => /session|sub2api-recovery/i.test(key))), api);
  }
});

test('HTTP2 transport errors recover but authentication failures still stop immediately', async () => {
  const interrupted = harness(() => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ERR_HTTP2_STREAM_ERROR' } }); });
  await assert.rejects(interrupted.runner.callModelWithRetry(question, 'key'), error => error.recoveryAttempts === 1);
  assert.deepEqual(interrupted.waits, [30000]);
  for (const message of ['Upstream authentication failed', 'insufficient quota', 'content filter rejected']) {
    const h = harness(() => sse([{ type: 'error', code: 'upstream_http2_stream_error', message }]));
    await assert.rejects(h.runner.callModelWithRetry(question, 'key'));
    assert.equal(h.calls.length, 1);
  }
});

test('an accepted completed event survives broken or permanently open transport tails', async () => {
  for (const tail of ['throw', 'hang']) {
    let tailRead = false;
    const h = harness(() => ({ ok: true, status: 200, headers: { get: () => 'text/event-stream' }, body: {
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(`event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`);
        tailRead = true;
        if (tail === 'throw') throw new Error('connection reset after completion');
        await new Promise(() => {});
      }
    } }));
    const result = await h.runner.callModelWithRetry(question, 'synthetic-key');
    assert.equal(result.output_text, '1161');
    assert.equal(tailRead, false);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].signal.aborted, true);
  }
});

test('ambiguous Responses and JSON body interruptions get at most one cooled recovery', async () => {
  for (const api of ['responses', 'chat_completions', 'anthropic_messages', 'gemini_generate_content']) {
    const h = harness(() => ({ ok: true, status: 200,
      headers: { get: key => key === 'content-type' ? api === 'responses' ? 'text/event-stream' : 'application/json' : null },
      body: { async *[Symbol.asyncIterator]() { throw new TypeError('socket reset after acceptance'); } }
    }));
    await assert.rejects(h.runner.callModelWithRetry({ ...question, api }, 'synthetic-key', h.context), error => error.recoveryAttempts === 1 && error.retryAttempts === 0);
    assert.equal(h.calls.length, 2, api);
    assert.deepEqual(h.waits, [30000], api);
    assert.equal(h.snapshots.at(-1)[0].outcome_unknown, true);
  }
});

test('unknown outcomes can recover successfully and recovered output excludes abandoned deltas', async () => {
  const h = harness(number => number === 1 ? sse([
    { type: 'response.created', response: { id: 'resp_abandoned' } },
    { type: 'response.output_text.delta', delta: 'abandoned partial' }
  ]) : sse([
    { type: 'response.output_text.delta', delta: '1161' },
    { type: 'response.completed', response: { id: 'resp_done', status: 'completed', output: [] } }
  ]));
  const result = await h.runner.callModelWithRetry(question, 'synthetic-key');
  assert.equal(result.output_text, '1161');
  assert.deepEqual(h.waits, [30000]);
});

test('explicit failures obey the recovery count, opt-out and total deadline', async () => {
  const failed = () => sse([{ type: 'response.failed', response: { error: { code: 'upstream_error', message: durationMessage } } }]);
  const bounded = harness(failed);
  await assert.rejects(bounded.runner.callModelWithRetry(question, 'key'), error => error.recoveryAttempts === 2);
  assert.equal(bounded.calls.length, 3);
  const disabled = harness(failed, { recoveryRetries: 0 });
  await assert.rejects(disabled.runner.callModelWithRetry(question, 'key'), error => error.recoveryAttempts === 0);
  assert.equal(disabled.calls.length, 1);
  const deadline = harness(failed, { recoveryTimeoutMs: 9000 });
  await assert.rejects(deadline.runner.callModelWithRetry(question, 'key'));
  assert.equal(deadline.calls.length, 1);
  assert.deepEqual(deadline.waits, []);
});

test('Retry-After is honored for seconds and dates and never exceeds the total budget', async () => {
  assert.equal(retryAfterMs('90'), 90000);
  assert.equal(retryAfterMs('Tue, 10 Nov 2026 00:01:30 GMT', Date.parse('2026-11-10T00:00:00Z')), 90000);
  for (const [seconds, expectedCalls] of [['12', 2], ['600', 1]]) {
    const h = harness(number => number === 1 ? new Response('{"error":{"message":"overloaded"}}',
      { status: 503, headers: { 'retry-after': seconds } }) : sse([completed]));
    if (expectedCalls === 2) {
      await h.runner.callModelWithRetry(question, 'key');
      assert.deepEqual(h.waits, [12000]);
    } else await assert.rejects(h.runner.callModelWithRetry(question, 'key'));
    assert.equal(h.calls.length, expectedCalls);
  }
});

test('permanent upstream errors, truncated answers and malformed streams do not trigger paid recovery', async () => {
  const cases = [
    () => new Response('{"error":{"code":"insufficient_quota","message":"quota exhausted"}}', { status: 503 }),
    () => new Response('{"error":{"code":"invalid_request_error","message":"invalid parameter"}}', { status: 502 }),
    () => new Response('{"error":{"message":"unauthorized"}}', { status: 401 }),
    () => sse([{ type: 'error', error: { code: 'upstream_error', message: 'Upstream authentication failed' } }]),
    () => sse([{ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }]),
    () => sse([{ ...completed, response: { ...completed.response, status: 'failed' } }]),
    () => new Response('data: [invalid]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  ];
  for (const response of cases) {
    const h = harness(response);
    await assert.rejects(h.runner.callModelWithRetry(question, 'key'));
    assert.equal(h.calls.length, 1);
  }
  assert.equal(isTransientModelFailure('upstream_error', 'context length exceeded'), false);
  const h = harness(() => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: 'partial' } }] })));
  await assert.rejects(h.runner.callModelWithRetry({ ...question, api: 'chat_completions' }, 'key'), { code: 'MODEL_RESPONSE_INCOMPLETE' });
  assert.equal(h.calls.length, 1);
});

test('configuration cancellation during backoff and closing prevent subsequent requests', async () => {
  const h = harness(() => sse([{ type: 'error', error: { code: 'upstream_error', message: durationMessage } }]));
  const controller = new AbortController();
  h.runner.sleep = async () => controller.abort();
  await assert.rejects(h.runner.callModelWithRetry(question, 'key', { signal: controller.signal }), { code: 'DETECTION_CANCELLED' });
  assert.equal(h.calls.length, 1);
  h.runner.close();
  await assert.rejects(h.runner.callModelWithRetry(question, 'key'), { code: 'DETECTION_CANCELLED' });
  assert.equal(h.calls.length, 1);
});

test('one slow attempt leaves time for recovery without resetting the overall deadline', async () => {
  const h = harness(number => {
    h.advance(60000);
    return number === 1 ? sse([{ type: 'error', error: { code: 'upstream_error', message: durationMessage } }]) : sse([completed]);
  });
  const result = await h.runner.callModelWithRetry(question, 'key');
  assert.equal(result.output_text, '1161');
  assert.equal(h.calls.length, 2);
  const late = harness(() => sse([{ type: 'error', error: { code: 'upstream_error', message: durationMessage } }]));
  late.runner.sleep = async () => late.advance(180000);
  await assert.rejects(late.runner.callModelWithRetry(question, 'key'));
  assert.equal(late.calls.length, 1);
});

test('disabling a group aborts an executing detection before recovery is sent', async t => {
  const config = testConfig(t);
  const store = new Store(config);
  t.after(() => store.close());
  const vault = new CredentialVault(config);
  seedRuntime({ config, store, vault }, [{ id: '42', name: 'Group', platform: 'openai' }]);
  const monitor = store.getMonitor(config.serviceOwnerId, '42');
  const run = store.createRun(monitor, store.getMonitorTest(monitor), 'manual');
  const h = harness(() => sse([{ type: 'error', error: { code: 'upstream_error', message: durationMessage } }]));
  h.runner.store = store;
  h.runner.vault = vault;
  h.runner.sleep = async () => {
    store.setMonitorEnabled(config.serviceOwnerId, '42', false);
    h.runner.configurationChanged();
  };
  const result = await h.runner.execute(run.id, monitor);
  assert.equal(result.status, 'error');
  assert.equal(result.error_code, 'DETECTION_CANCELLED');
  assert.equal(h.calls.length, 1);
  assert.equal(store.getMonitor(config.serviceOwnerId, '42').next_run_at, null);
  assert.equal(h.runner.executions.size, 0);
});

test('TLS and redirect configuration failures never initiate paid recovery', async () => {
  for (const code of ['CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UND_ERR_INVALID_ARG']) {
    const h = harness(() => { throw Object.assign(new TypeError('fetch failed'), { cause: { code } }); });
    await assert.rejects(h.runner.callModelWithRetry(question, 'key'));
    assert.equal(h.calls.length, 1);
  }
});

test('closing an active manual run delays its next schedule even if the old schedule was already due', async t => {
  const config = testConfig(t);
  const store = new Store(config);
  t.after(() => store.close());
  const vault = new CredentialVault(config);
  seedRuntime({ config, store, vault }, [{ id: '42', name: 'Group', platform: 'openai' }]);
  const monitor = store.getMonitor(config.serviceOwnerId, '42');
  store.db.prepare('UPDATE monitors SET next_run_at = ? WHERE id = ?').run(Date.now() - 1000, monitor.id);
  const run = store.createRun(monitor, store.getMonitorTest(monitor), 'manual');
  const h = harness(() => sse([{ type: 'error', error: { code: 'upstream_error', message: durationMessage } }]));
  h.runner.store = store;
  h.runner.vault = vault;
  h.runner.sleep = async () => h.runner.close();
  const started = Date.now();
  const result = await h.runner.execute(run.id, monitor);
  assert.equal(result.error_code, 'DETECTION_CANCELLED');
  assert.ok(store.getMonitor(config.serviceOwnerId, '42').next_run_at >= started + h.runner.config.requestTimeoutMs);
  assert.equal(h.calls.length, 1);
});

test('attempts persist across SQLite reopen without keys, raw messages or request bodies', async t => {
  const config = testConfig(t);
  let store = new Store(config);
  t.after(() => { if (store.db.open) store.close(); });
  const vault = new CredentialVault(config);
  const group = { id: '42', name: 'Test Group', platform: 'openai' };
  seedRuntime({ config, store, vault }, [group], { openai: { ...defaultTests.openai, output_type: 'text',
    validation: { min_bytes: 1, required_patterns: ['^1161$'] } } });
  const monitor = store.getMonitor(config.serviceOwnerId, group.id);
  const run = store.createRun(monitor, store.getMonitorTest(monitor), 'manual');
  const h = harness(number => sse(number === 1 ? [{ type: 'error', error: { code: 'upstream_error', message: durationMessage } }] : [completed]));
  h.runner.store = store;
  h.runner.vault = vault;
  h.runner.config.artifactDir = config.artifactDir;
  const result = await h.runner.execute(run.id, monitor);
  assert.equal(result.status, 'normal');
  assert.match(result.reason, /自动补测 1 次/);
  const saved = publicRun(store.getRun(run.id)).request_attempts;
  assert.deepEqual(saved.map(a => a.state), ['failed', 'completed']);
  assert.ok(saved.every(attempt => !Object.hasOwn(attempt, 'route_recovery')));
  for (const call of h.calls) assert.ok(!store.getRun(run.id).request_attempts_json.includes(call.headers['session-id']));
  assert.doesNotMatch(JSON.stringify(saved), /sk-test|synthetic|question|prompt|duration|https:/);
  store.close();
  store = new Store(config);
  assert.deepEqual(publicRun(store.getRun(run.id)).request_attempts, saved);
});

test('real HTTP streaming completion releases the socket without waiting for upstream EOF', async t => {
  const sockets = new Set();
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify(completed)}\n\n`);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { sub2apiBaseUrl: `http://127.0.0.1:${server.address().port}`, requestTimeoutMs: 3000, maxResponseBytes: 1048576 };
  const client = new Sub2ApiClient(config);
  t.after(async () => { for (const socket of sockets) socket.destroy(); await client.close(); await new Promise(resolve => server.close(resolve)); });
  const runner = new DetectionRunner({ config, store: {}, vault: {}, sub2api: client });
  const started = Date.now();
  const result = await runner.callModelWithRetry(question, 'synthetic-key');
  assert.equal(result.output_text, '1161');
  assert.ok(Date.now() - started < 2000);
});

test('real HTTP recovery resets a native sticky session without gateway extensions', async t => {
  const sockets = new Set(), calls = [], waits = [], snapshots = [];
  const routes = new Map();
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const session = req.headers['session-id'];
    if (!routes.has(session)) routes.set(session, routes.size === 0 ? 'primary' : 'backup');
    const account = routes.get(session);
    calls.push({ body: JSON.parse(Buffer.concat(chunks)), headers: req.headers, account });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (account === 'backup') res.write(`data: ${JSON.stringify(completed)}\n\n`);
    else res.end(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'discard me' })}\n\n` +
      `data: ${JSON.stringify({ type: 'error', code: 'upstream_http2_stream_error', message: 'Upstream HTTP/2 stream failed' })}\n\n`);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { sub2apiBaseUrl: `http://127.0.0.1:${server.address().port}`, requestTimeoutMs: 10000,
    recoveryTimeoutMs: 120000, recoveryRetries: 2, maxResponseBytes: 1048576 };
  const client = new Sub2ApiClient(config);
  t.after(async () => { for (const socket of sockets) socket.destroy(); await client.close(); await new Promise(resolve => server.close(resolve)); });
  const runner = new DetectionRunner({ config, store: {}, vault: {}, sub2api: client, randomFn: () => 0,
    sleepFn: async ms => { waits.push(ms); } });
  const result = await runner.callModelWithRetry(question, 'synthetic-key', {
    onAttempts: attempts => snapshots.push(structuredClone(attempts))
  });
  assert.equal(result.output_text, '1161');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].body, calls[1].body);
  assert.notEqual(calls[0].headers['session-id'], calls[1].headers['session-id']);
  assert.deepEqual(calls.map(call => call.account), ['primary', 'backup']);
  assert.ok(calls.every(call => !Object.keys(call.headers).some(key => key.startsWith('x-sub2api-recovery'))));
  assert.deepEqual(waits, [30000]);
  assert.deepEqual(snapshots.at(-1).map(attempt => attempt.state), ['failed', 'completed']);
  for (const call of calls) assert.ok(!JSON.stringify(snapshots).includes(call.headers['session-id']));
});
