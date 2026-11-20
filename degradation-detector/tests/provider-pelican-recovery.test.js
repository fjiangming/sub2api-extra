'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { generatePelican, PELICAN_PROMPT } = require('../src/provider-pelican');
const { requestReviewEvents } = require('../src/review-http');
const { cleanGenerationAttempts } = require('../src/provider-results');

const html = '<!doctype html><html><body><svg><text>Recovered pelican</text></svg></body></html>';
const key = 'sk-recovery-fixture-only-1234567890';
const snapshot = { target_url: 'https://relay.example.com/custom/v1/', model: 'gpt-unchanged',
  reasoning_effort: 'high', service_tier: 'priority', prompt: PELICAN_PROMPT, timeout_seconds: 1800 };
const delta = { type: 'response.output_text.delta', delta: html };
const completed = { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 123, output_tokens: 456 } } };
const frame = event => `data: ${JSON.stringify(event)}\n\n`;
const success = { events: [delta, completed] };
const interrupted = { type: 'error', code: 'upstream_stream_read_error', message: 'Upstream response stream was interrupted' };

function harness(steps, options = {}) {
  let now = 0;
  const calls = [], waits = [], attempts = [];
  const controller = new AbortController();
  const request = (url, requestOptions, receive) => {
    const call = { url: String(url), ...requestOptions }; calls.push(call);
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    const connection = new EventEmitter();
    connection.end = raw => {
      call.body = JSON.parse(raw);
      if (step.preconnect) {
        queueMicrotask(() => connection.emit('error', Object.assign(new Error('synthetic preconnect failure'), { code: step.preconnect })));
        return;
      }
      const response = Readable.from((async function* () {
        if (step.raw != null) yield Buffer.from(step.raw);
        for (const event of step.events || []) yield Buffer.from(frame(event));
        if (step.transport) throw Object.assign(new Error('synthetic connection reset'), { code: step.transport });
      })());
      response.statusCode = step.status || 200;
      response.headers = { 'content-type': step.type || 'text/event-stream', ...step.headers };
      receive(response);
    };
    return connection;
  };
  const generate = overrides => generatePelican({ snapshot, key, signal: controller.signal, maxResponseBytes: 20 * 1024 * 1024,
    taskKey: 'pelican-generation-fixture', config: { recoveryRetries: 2, recoveryTimeoutMs: 3600000, ...options.config },
    onAttempts: value => attempts.push(structuredClone(value)), ...options.input, ...overrides },
  (url, requestOptions, onEvent) => requestReviewEvents(url, requestOptions, onEvent, {
    lookup: options.lookup || (async () => [{ address: '8.8.8.8', family: 4 }]), request
  }), { now: () => now, random: () => 0, sleep: async (ms, signal) => {
    waits.push(ms); now += ms;
    await options.onWait?.(ms, signal);
  } });
  return { generate, calls, waits, attempts, controller, advance: ms => { now += ms; } };
}

test('pelican recovers production stream error shapes once after cooling without changing inference or keeping partial deltas', async () => {
  for (const code of ['upstream_http2_stream_error', 'upstream_stream_read_error', 'upstream_stream_truncated']) {
    for (const terminal of [{ ...interrupted, code }, { type: 'response.failed', response: { error: { code, message: interrupted.message } } }]) {
      const h = harness([{ events: [{ type: 'response.output_text.delta', delta: 'abandoned partial artwork' }, terminal] }, success]);
      const result = await h.generate();
      assert.equal(result.html, html); assert.equal(result.output_tokens, 456);
      assert.deepEqual(h.waits, [30000]); assert.equal(h.calls.length, 2);
      assert.deepEqual(h.calls[0].body, h.calls[1].body);
      assert.equal(h.calls[1].body.model, snapshot.model);
      assert.equal(h.calls[1].body.reasoning.effort, 'high'); assert.equal(h.calls[1].body.max_output_tokens, undefined);
      assert.notEqual(h.calls[0].headers['session-id'], h.calls[1].headers['session-id']);
      assert.notEqual(h.calls[0].headers['Idempotency-Key'], h.calls[1].headers['Idempotency-Key']);
      assert.equal(h.attempts.at(-1)[0].upstream_code, code);
      assert.equal(h.attempts.at(-1)[0].outcome_unknown, true);
      assert.deepEqual(h.attempts.at(-1).map(attempt => attempt.kind), ['initial', 'recovery']);
      assert.equal(h.attempts.at(-1)[1].state, 'completed');
      for (const value of [key, PELICAN_PROMPT, h.calls[0].headers['session-id'], h.calls[1].headers['session-id']]) {
        assert.ok(!JSON.stringify(h.attempts).includes(value));
      }
    }
  }
});

test('pelican transport resets and clean early EOF each allow one cooled recovery and never loop on an unknown outcome', async () => {
  for (const failed of [{ events: [delta], transport: 'ECONNRESET' }, { events: [delta] }]) {
    const recovered = harness([failed, success]);
    assert.equal((await recovered.generate()).html, html); assert.deepEqual(recovered.waits, [30000]);
    const repeated = harness([failed], { config: { recoveryRetries: 3 } });
    await assert.rejects(repeated.generate(), error => error.recoveryAttempts === 1 && error.retryAttempts === 0);
    assert.equal(repeated.calls.length, 2); assert.deepEqual(repeated.waits, [30000]);
  }
});

test('pelican handles HTTP 200 JSON failure bodies and honors a real generation deadline without resending', async () => {
  const jsonFailure = harness([{ raw: JSON.stringify({ error: { code: 'upstream_stream_read_error', message: interrupted.message } }), type: 'application/json' }, success]);
  assert.equal((await jsonFailure.generate()).html, html); assert.deepEqual(jsonFailure.waits, [30000]);
  let calls = 0;
  await assert.rejects(generatePelican({ snapshot: { ...snapshot, timeout_seconds: 0.03 }, key,
    signal: new AbortController().signal, config: { recoveryRetries: 2, recoveryTimeoutMs: 3600000 } },
  async (_url, { signal }) => {
    calls++;
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }));
  assert.equal(calls, 1);
});

test('pelican safe preconnects preserve request identity, while accepted HTTP errors use bounded recovery', async () => {
  const h = harness([{ preconnect: 'ECONNREFUSED' }, { events: [interrupted] }, success]);
  await h.generate();
  assert.deepEqual(h.waits, [1000, 30000]);
  for (const header of ['session-id', 'Idempotency-Key']) {
    assert.equal(h.calls[0].headers[header], h.calls[1].headers[header]);
    assert.notEqual(h.calls[1].headers[header], h.calls[2].headers[header]);
  }
  assert.ok(h.calls.every(call => JSON.stringify(call.body) === JSON.stringify(h.calls[0].body)));
  const unavailable = harness([{ preconnect: 'ECONNREFUSED' }]);
  await assert.rejects(unavailable.generate(), error => error.retryAttempts === 5 && error.recoveryAttempts === 0);
  assert.equal(unavailable.calls.length, 6); assert.deepEqual(unavailable.waits, [1000, 2000, 4000, 8000, 16000]);
  for (const status of [500, 502, 503, 504, 524]) {
    const accepted = harness([{ status, raw: JSON.stringify({ error: { code: 'upstream_http2_stream_error', message: interrupted.message } }) }]);
    await assert.rejects(accepted.generate(), error => error.retryAttempts === 0 && error.recoveryAttempts === 1);
    assert.equal(accepted.calls.length, 2); assert.deepEqual(accepted.waits, [30000]);
  }
});

test('pelican transient failures obey default recovery limits, opt-out, retry-after and the original task deadline', async () => {
  const failure = { events: [{ type: 'error', code: 'upstream_error', message: 'Maximum stream duration exceeded' }] };
  const bounded = harness([failure]);
  await assert.rejects(bounded.generate(), error => error.recoveryAttempts === 2);
  assert.equal(bounded.calls.length, 3); assert.deepEqual(bounded.waits, [10000, 30000]);
  const disabled = harness([{ events: [interrupted] }], { config: { recoveryRetries: 0 } });
  await assert.rejects(disabled.generate(), error => error.recoveryAttempts === 0); assert.equal(disabled.calls.length, 1);
  const short = harness([{ events: [interrupted] }], { input: { deadline: 29999 } });
  await assert.rejects(short.generate()); assert.equal(short.calls.length, 1); assert.deepEqual(short.waits, []);
  const timed = harness([failure], { input: { snapshot: { ...snapshot, timeout_seconds: 35 } } });
  await assert.rejects(timed.generate()); assert.equal(timed.calls.length, 2); assert.deepEqual(timed.waits, [10000]);
  for (const retryAfter of ['45', new Date(Date.now() + 45000).toUTCString()]) {
    const delayed = harness([{ status: 503, headers: { 'retry-after': retryAfter }, raw: '{"error":{"code":"overloaded_error"}}' }, success]);
    await delayed.generate(); assert.equal(delayed.calls.length, 2);
    assert.ok(delayed.waits[0] >= 43000 && delayed.waits[0] <= 45000);
  }
  const oversizedWait = harness([{ status: 503, headers: { 'retry-after': '1800' } }]);
  await assert.rejects(oversizedWait.generate()); assert.equal(oversizedWait.calls.length, 1);
});

test('pelican stops before sending a recovery on cancellation, configuration change or exhausted waiting time', async () => {
  for (const reason of ['abort', 'changed', 'timeout']) {
    let current = true;
    const h = harness([{ events: [interrupted] }, success], { input: { ensureCurrent: () => {
      if (!current) throw new Error('PROVIDER_CONFIG_CHANGED');
    } }, onWait: () => {
      if (reason === 'abort') h.controller.abort(new Error('cancelled fixture'));
      if (reason === 'changed') current = false;
      if (reason === 'timeout') h.advance(1800000);
    } });
    await assert.rejects(h.generate()); assert.equal(h.calls.length, 1);
    assert.equal(h.attempts.at(-1).length, 1);
  }
});

test('pelican never repeats permanent model, TLS, DNS, redirect, malformed, incomplete or oversized output failures', async () => {
  for (const step of [
    { status: 401 }, { status: 403 }, { status: 302 },
    { status: 503, raw: '{"error":{"code":"insufficient_quota","message":"quota exhausted"}}' },
    { status: 502, raw: '{"error":{"code":"invalid_request_error","message":"invalid parameter"}}' },
    { events: [{ ...interrupted, message: 'Upstream authentication failed' }] },
    { events: [{ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }] },
    { events: [{ type: 'response.cancelled', response: { status: 'cancelled' } }] },
    { raw: 'data: broken\n\n' },
    { events: [{ type: 'response.completed', response: { status: 'completed', output_text: 'x'.repeat(1024 * 1024 + 1) } }] },
    { preconnect: 'CERT_HAS_EXPIRED' }
  ]) {
    const h = harness([step]); await assert.rejects(h.generate()); assert.equal(h.calls.length, 1);
    assert.deepEqual(h.waits, []);
  }
  const unsafe = harness([success], { lookup: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] });
  await assert.rejects(unsafe.generate(), { code: 'REVIEW_URL_UNSAFE' }); assert.equal(unsafe.calls.length, 0);
  const excessive = harness([success]); await assert.rejects(excessive.generate({ maxResponseBytes: 10 })); assert.equal(excessive.calls.length, 1);
});

test('generation attempt persistence retains only bounded progress and sanitized codes', () => {
  const clean = cleanGenerationAttempts(Array(20).fill({ kind: 'recovery', state: 'failed', number: 700,
    started_at: 100, finished_at: 200, code: key, upstream_code: 'upstream_stream_read_error', upstream_status: 502,
    outcome_unknown: true, next_action: 'recovery', delay_ms: 30000, sessionId: 'private-session', body: PELICAN_PROMPT,
    message: 'sensitive original message', authorization: key }), [key]);
  assert.equal(clean.length, 9);
  assert.deepEqual(clean[0], { number: 1, kind: 'recovery', state: 'failed', started_at: 100, finished_at: 200,
    upstream_code: 'upstream_stream_read_error', upstream_status: 502, outcome_unknown: true, next_action: 'recovery', delay_ms: 30000 });
  assert.ok(!JSON.stringify(clean).includes(key)); assert.ok(!JSON.stringify(clean).includes('sensitive'));
});
