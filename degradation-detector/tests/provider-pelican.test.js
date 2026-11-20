'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { Store } = require('../src/store');
const { ProviderStore } = require('../src/provider-store');
const { ProviderDetection } = require('../src/provider-detection');
const { CredentialVault } = require('../src/credential-vault');
const { defaultConfiguration } = require('../src/provider-config');
const { cleanManxue } = require('../src/provider-results');
const { generatePelican, PELICAN_METHOD, PELICAN_PROMPT } = require('../src/provider-pelican');
const { requestReviewEvents, ReviewError } = require('../src/review-http');
const { testConfig } = require('./helpers');

const html = '<!doctype html><html><body><svg><text>完整作品</text></svg><script>window.artwork = 1;</script></body></html>';
const key = 'sk-pelican-fixture-only-1234567890';
const snapshot = { target_url: 'https://relay.example.com/custom/v1/', model: 'gpt-fixture', reasoning_effort: 'high', service_tier: 'priority', prompt: PELICAN_PROMPT };
const complete = (source = html) => ({ type: 'response.completed', response: { object: 'response', id: 'resp-fixture', status: 'completed', output_text: source, usage: { input_tokens: 111, output_tokens: 12000 } } });
const frame = event => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`;
function streamTransport(chunks, { status = 200, type = 'text/event-stream', open = false } = {}) {
  const calls = [];
  let response;
  const request = (url, options, receive) => {
    const call = { url: String(url), options }; calls.push(call);
    const connection = new EventEmitter();
    connection.end = raw => {
      call.body = JSON.parse(raw.toString());
      response = open ? new Readable({ read() {} }) : Readable.from(chunks);
      response.statusCode = status; response.headers = { 'content-type': type };
      receive(response);
      if (open) for (const chunk of chunks) response.push(chunk);
    };
    return connection;
  };
  return { calls, request, get response() { return response; } };
}
async function generate(transport, overrides = {}, lookup = async () => [{ address: '8.8.8.8', family: 4 }]) {
  return generatePelican({ snapshot, key, signal: AbortSignal.timeout(2000), maxResponseBytes: 20 * 1024 * 1024, ...overrides },
    (url, options, onEvent) => requestReviewEvents(url, options, onEvent, { lookup, request: transport.request }));
}

test('local generation reuses the Responses stream parser for large UTF-8 frames and stops at completed without EOF', async () => {
  const source = html.replace('完整作品', '鹈鹕动画'.repeat(8000));
  const raw = Buffer.from(': heartbeat\r\n\r\n' + frame({ type: 'response.output_text.delta', delta: source }) + frame(complete(source)));
  const chunks = []; for (let i = 0; i < raw.length; i += 1003) chunks.push(raw.subarray(i, i + 1003));
  const transport = streamTransport(chunks, { open: true });
  const result = await generate(transport);
  assert.equal(result.html, source); assert.equal(result.input_tokens, 111); assert.equal(result.output_tokens, 12000);
  assert(result.first_token_ms >= 0); assert(transport.response.destroyed);
  assert.equal(transport.calls.length, 1);
  const call = transport.calls[0];
  assert.equal(call.url, 'https://relay.example.com/custom/v1/responses');
  assert.equal(call.options.headers.authorization, `Bearer ${key}`);
  assert.equal(call.options.headers.accept, 'text/event-stream'); assert.equal(call.options.headers['accept-encoding'], 'identity');
  call.options.lookup('', {}, (_error, address) => assert.equal(address, '8.8.8.8'));
  assert.deepEqual(call.body, { model: 'gpt-fixture', input: [{ role: 'user', content: [{ type: 'input_text', text: PELICAN_PROMPT }] }], stream: true, reasoning: { effort: 'high' }, service_tier: 'priority' });
});

test('generation accepts a completed JSON response and an output carried only by stream deltas without inventing tokens', async () => {
  const json = streamTransport([Buffer.from(JSON.stringify(complete().response))], { type: 'application/json' });
  const result = await generate(json, { snapshot: { ...snapshot, target_url: 'https://relay.example.com/', service_tier: '', reasoning_effort: 'custom-effort' } });
  assert.equal(json.calls[0].url, 'https://relay.example.com/responses');
  assert.equal(json.calls[0].body.service_tier, undefined); assert.equal(json.calls[0].body.reasoning.effort, 'custom-effort');
  assert.equal(result.html, html); assert.equal(result.first_token_ms, null);
  const streamed = streamTransport([Buffer.from(frame({ type: 'response.output_text.delta', delta: html }) + frame({ type: 'response.completed', response: { status: 'completed' } }))]);
  const fallback = await generate(streamed);
  assert.equal(fallback.html, html); assert.equal(fallback.output_tokens, null);
});

test('partial, failed, malformed and excessive generation responses never become complete artwork with recovery disabled', async () => {
  for (const [raw, expected, options] of [
    [frame({ type: 'response.output_text.delta', delta: html }), /GENERATION_INCOMPLETE/],
    [frame({ type: 'response.incomplete', response: { status: 'incomplete', output_text: html } }), /GENERATION_FAILED/],
    [frame({ type: 'response.completed', response: { status: 'failed', output_text: html } }), /GENERATION_FAILED/],
    [frame({ type: 'response.failed', response: { error: { message: 'failure' } } }), /GENERATION_FAILED/],
    ['data: broken\n\n', /STREAM_INVALID/],
    [frame(complete()), /TOO_LARGE/, { maxResponseBytes: 30 }],
    [frame(complete('x'.repeat(1024 * 1024 + 1))), /INPUT_TOO_LARGE/]
  ]) {
    const transport = streamTransport([Buffer.from(raw)]);
    await assert.rejects(generate(transport, { config: { recoveryRetries: 0 }, ...options }), error => expected.test(error.code || error.message));
    assert.equal(transport.calls.length, 1); assert(transport.response.destroyed);
  }
});

test('generation pins public addresses, rejects mixed DNS before sending credentials and does not follow redirects', async () => {
  const transport = streamTransport([]);
  await assert.rejects(generate(transport, {}, async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]), /URL_UNSAFE/);
  assert.equal(transport.calls.length, 0);
  const redirect = streamTransport([], { status: 302 });
  await assert.rejects(generate(redirect), error => error.httpStatus === 302);
  assert.equal(redirect.calls.length, 1);
});

test('generation cancellation bounds DNS and a stalled stream without retrying the model POST', async () => {
  const dnsAbort = new AbortController(), dnsTransport = streamTransport([]);
  const resolving = generate(dnsTransport, { signal: dnsAbort.signal }, async () => new Promise(() => {}));
  dnsAbort.abort(); await assert.rejects(resolving, error => error.code === 'REVIEW_TIMEOUT' || error === dnsAbort.signal.reason);
  assert.equal(dnsTransport.calls.length, 0);
  const streamAbort = new AbortController(), stalled = streamTransport([], { open: true });
  const result = generate(stalled, { signal: streamAbort.signal });
  await new Promise(resolve => setImmediate(resolve));
  streamAbort.abort();
  stalled.response.destroy(new Error('aborted fixture connection'));
  await assert.rejects(result); assert.equal(stalled.calls.length, 1); assert(stalled.response.destroyed);
});

function setup(t, dependencies = {}) {
  const config = testConfig(t), store = new Store(config), providers = new ProviderStore(store), vault = new CredentialVault(config);
  const generations = [], calls = [];
  const service = new ProviderDetection({ config, providerStore: providers, vault, pollMs: 1, resolve: async () => ({}),
    generate: async options => { generations.push(options); return { html, input_tokens: 111, output_tokens: 12000, first_token_ms: 20, duration_ms: 80 }; },
    request: async (url, options) => {
      calls.push({ url, ...options });
      return options.method === 'POST' ? { id: 'classified', status: 'running', benchmark: 'html' }
        : { id: 'classified', status: 'succeeded', benchmark: 'html', assessment: { quality: 'normal', reason: 'classifier result' } };
    }, ...dependencies });
  const input = { revision: 0, ...defaultConfiguration(), groups: [{ id: '1', channel: 'pelican', enabled: true, override: null, key }] };
  input.providers.manxue.enabled = true; input.channels.pelican.enabled = true;
  Object.assign(input.channels.pelican.defaults, snapshot);
  delete input.channels.pelican.defaults.prompt;
  const prepared = service.prepareConfiguration(input, [{ id: '1', name: 'Pelican fixture', platform: 'openai' }]);
  providers.save(prepared.input, prepared.groups);
  t.after(async () => { await service.close(); store.close(); });
  const enqueue = () => service.enqueue('1', 'pelican');
  return { config, store, providers, service, generations, calls, enqueue };
}

test('pelican saves the exact prompt and full artwork before classification, keeps real usage and sends no generation credential to Manxue', async t => {
  const { providers, service, generations, calls, enqueue } = setup(t);
  const request = service.request;
  service.request = async (url, options) => {
    const saved = JSON.parse(providers.run(run.id).response_json);
    assert.equal(saved.result.html, html); assert.equal(saved.prompt, PELICAN_PROMPT);
    assert.equal(JSON.parse(providers.run(run.id).parts_json).generation.state, 'done');
    return request(url, options);
  };
  const run = enqueue(); await service.execute(providers.run(run.id));
  const saved = providers.run(run.id), result = JSON.parse(saved.response_json);
  assert.equal(saved.conclusion, 'passed'); assert.equal(result.method, PELICAN_METHOD);
  assert.equal(generations.length, 1); assert.equal(generations[0].snapshot.prompt, PELICAN_PROMPT);
  assert.equal(result.result.output_tokens, 12000); assert.equal(result.result.first_token_ms, 20);
  assert.equal(calls.length, 2); assert.equal(calls[0].body.benchmark, 'html'); assert.equal(calls[0].body.model, 'gpt-6-astra');
  assert.equal(calls[0].body.html, html); assert.equal(calls[0].body.api_key, 'not-used-for-html-classification');
  assert.equal(calls[0].apiKey, undefined); assert.equal(calls[1].body, undefined);
  assert(!JSON.stringify(calls.map(({ body, apiKey }) => ({ body, apiKey }))).includes(key));
  assert(!storeContainsKey(providers, key));
});
function storeContainsKey(providers, value) { return providers.db.serialize().includes(Buffer.from(value)); }

test('pelican persists recovery progress before waiting and classifies only the final complete artwork once', async t => {
  const { providers, service, calls, enqueue } = setup(t);
  const run = enqueue();
  let now = Date.now(), requests = 0, waits = 0;
  service.generate = options => generatePelican(options, async (_url, _options, onEvent) => {
    requests++;
    if (requests === 1) {
      onEvent({ type: 'response.output_text.delta', delta: 'abandoned partial' });
      onEvent({ type: 'error', code: 'upstream_stream_read_error', message: `Upstream response stream was interrupted ${key}` });
    } else { onEvent({ type: 'response.output_text.delta', delta: html }); onEvent(complete()); }
  }, { now: () => now, random: () => 0, sleep: async ms => {
    waits++; now += ms;
    const saved = JSON.parse(providers.run(run.id).response_json);
    assert.equal(saved.generation_attempts.length, 1);
    assert.equal(saved.generation_attempts[0].next_action, 'recovery');
    assert.equal(saved.generation_attempts[0].delay_ms, 30000);
    assert.equal(saved.prompt, PELICAN_PROMPT); assert.equal(saved.result, null);
    assert.equal(JSON.parse(providers.run(run.id).parts_json).generation.state, 'submitting');
    assert.equal(calls.length, 0);
  } });
  await service.execute(providers.run(run.id));
  const saved = providers.run(run.id), response = JSON.parse(saved.response_json);
  assert.equal(saved.conclusion, 'passed'); assert.equal(requests, 2); assert.equal(waits, 1);
  assert.equal(response.result.html, html); assert.equal(response.result.output_tokens, 12000);
  assert.deepEqual(response.generation_attempts.map(attempt => attempt.state), ['failed', 'completed']);
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  assert.ok(!storeContainsKey(providers, key));
});

test('repeated stream interruption preserves the real recovery count and disabling a group prevents further generation', async t => {
  for (const disable of [false, true]) {
    const { providers, service, calls, enqueue } = setup(t);
    const run = enqueue();
    let now = Date.now(), requests = 0;
    service.generate = options => generatePelican(options, async (_url, _options, onEvent) => {
      requests++;
      onEvent({ type: 'error', code: 'upstream_stream_read_error', message: 'Upstream response stream was interrupted' });
    }, { now: () => now, random: () => 0, sleep: async ms => {
      now += ms;
      if (disable) providers.db.prepare("UPDATE degradation_provider_groups SET enabled=0 WHERE group_id='1' AND channel='pelican'").run();
    } });
    await service.execute(providers.run(run.id));
    const saved = providers.run(run.id), response = JSON.parse(saved.response_json);
    assert.equal(saved.status, 'error'); assert.equal(calls.length, 0); assert.equal(requests, disable ? 1 : 2);
    assert.equal(response.result, null); assert.equal(response.generation_attempts.length, disable ? 1 : 2);
    if (disable) assert.equal(saved.error_code, 'PROVIDER_CONFIG_CHANGED');
    else {
      assert.match(saved.reason, /已自动补测 1 次/); assert.doesNotMatch(saved.reason, /未自动重发/);
      assert.equal(response.diagnostic.provider_code, 'upstream_stream_read_error');
    }
  }
});

test('classification failures preserve the generated work and sanitize original diagnostics without repeating generation or submission', async t => {
  for (const reply of [
    { id: 'classified', benchmark: 'html', status: 'failed', error: `read failure ${key} https://private.example.com/path` },
    { id: 'wrong-task', benchmark: 'html', status: 'succeeded', assessment: { quality: 'normal' } },
    { id: 'classified', benchmark: 'pelican', status: 'succeeded', assessment: { quality: 'normal' } },
    { id: 'classified', benchmark: 'html', status: 'succeeded', assessment: { quality: 'unknown' } }
  ]) {
    const { providers, service, generations, enqueue } = setup(t); let posts = 0, reads = 0;
    service.request = async (_url, options) => {
      if (options.method === 'POST') { posts++; return { id: 'classified', benchmark: 'html', status: 'running' }; }
      reads++; return reply;
    };
    const run = enqueue(); await service.execute(providers.run(run.id));
    const saved = providers.run(run.id), result = JSON.parse(saved.response_json);
    assert.equal(saved.status, 'error'); assert.equal(saved.conclusion, 'error');
    assert.equal(result.result.html, html); assert.equal(result.prompt, PELICAN_PROMPT);
    assert.equal(generations.length, 1); assert.equal(posts, 1); assert.equal(reads, 1);
    assert.doesNotMatch(saved.response_json, /sk-pelican|private\.example/);
    if (reply.status === 'failed') { assert.equal(result.diagnostic.stage, 'poll'); assert.match(result.diagnostic.provider_message, /read failure/); }
  }
});

test('classification accepts an ID-only submission and maps both explicit verdicts without regenerating', async t => {
  for (const quality of ['normal', 'degraded']) {
    const { providers, service, generations, enqueue } = setup(t); const methods = [];
    service.request = async (_url, options) => {
      methods.push(options.method);
      return options.method === 'POST' ? { id: 'id-only' } : { id: 'id-only', benchmark: 'html', status: 'succeeded', assessment: { quality } };
    };
    const run = enqueue(); await service.execute(providers.run(run.id));
    assert.equal(providers.run(run.id).conclusion, quality === 'normal' ? 'passed' : 'failed');
    assert.equal(generations.length, 1); assert.deepEqual(methods, ['POST', 'GET']);
  }
});

test('generation HTTP failures preserve the prompt and stage without classifying or throttling the classifier service', async t => {
  for (const status of [401, 429, 503]) {
    let attempts = 0;
    const { providers, service, calls, enqueue } = setup(t, { generate: async () => {
      attempts++;
      throw new ReviewError('REVIEW_HTTP_ERROR', { httpStatus: status, diagnostic: { provider_message: `model fixture ${key}` } });
    } });
    const run = enqueue(); await service.execute(providers.run(run.id));
    const saved = providers.run(run.id), result = JSON.parse(saved.response_json);
    assert.equal(attempts, 1); assert.equal(calls.length, 0); assert.equal(providers.throttled('pelican'), false);
    assert.equal(saved.conclusion, 'error'); assert.equal(result.prompt, PELICAN_PROMPT);
    assert.equal(result.diagnostic.stage, 'generate'); assert.equal(result.diagnostic.http_status, status);
    assert.doesNotMatch(saved.response_json, /sk-pelican/);
    if (status === 401) assert.match(saved.reason, /作品生成鉴权失败/);
  }
});

test('restart resumes saved artwork or a known classifier ID, while uncertain generation and classification POSTs never replay', async t => {
  const { providers, service, generations, calls, enqueue, store } = setup(t);
  const seedArtwork = run => {
    providers.markRunning(run.id); providers.part(run.id, 'generation', { state: 'done' });
    providers.response(run.id, { method: PELICAN_METHOD, status: 'running', prompt: PELICAN_PROMPT, result: { html } });
  };
  const generated = enqueue(); seedArtwork(generated); new ProviderStore(store);
  await service.execute(providers.run(generated.id));
  assert.equal(generations.length, 0); assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  const submitted = enqueue(); seedArtwork(submitted);
  providers.part(submitted.id, 'pelican', { state: 'submitted', remote_id: 'classified', benchmark: 'html' }); new ProviderStore(store);
  const before = calls.length; await service.execute(providers.run(submitted.id));
  assert.equal(generations.length, 0); assert.deepEqual(calls.slice(before).map(call => call.method), ['GET']);
  for (const phase of ['generation', 'pelican']) {
    const uncertain = enqueue(); seedArtwork(uncertain); providers.part(uncertain.id, phase, { state: 'submitting' });
    new ProviderStore(store);
    assert.equal(providers.run(uncertain.id).error_code, 'SERVICE_RESTARTED');
    assert.equal(JSON.parse(providers.run(uncertain.id).response_json).result.html, html);
  }
  const missing = enqueue(); providers.part(missing.id, 'generation', { state: 'done' });
  await service.execute(providers.run(missing.id));
  assert.equal(providers.run(missing.id).error_code, 'PROVIDER_ARTIFACT_MISSING'); assert.equal(generations.length, 0);
});

test('ambiguous classifier POST retains source and prompt and model cancellation never submits a classification', async t => {
  const { providers, service, generations, enqueue } = setup(t); let posts = 0;
  service.request = async () => { posts++; throw new Error('ECONNRESET'); };
  const uncertain = enqueue(); await service.execute(providers.run(uncertain.id));
  assert.equal(posts, 1); assert.equal(generations.length, 1); assert.match(providers.run(uncertain.id).reason, /未自动重发/);
  assert.equal(JSON.parse(providers.run(uncertain.id).response_json).result.html, html);
  await service.execute(providers.run(uncertain.id));
  assert.equal(posts, 1); assert.equal(generations.length, 1);
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  service.generate = async ({ signal }) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); started(); });
  const cancelled = enqueue(), controller = new AbortController();
  const executing = service.execute(providers.run(cancelled.id), controller);
  await ready; controller.abort(new Error('PROVIDER_TIMEOUT')); await executing;
  assert.equal(posts, 1); assert.equal(providers.run(cancelled.id).error_code, 'PROVIDER_TIMEOUT');
  assert.equal(JSON.parse(providers.run(cancelled.id).response_json).prompt, PELICAN_PROMPT);
  assert.match(providers.run(cancelled.id).reason, /作品生成超时/);
});

test('old remote pelican snapshots continue polling their original benchmark without local generation or rewriting history', async t => {
  const { providers, service, enqueue, store, generations } = setup(t);
  const run = enqueue(), old = JSON.parse(providers.run(run.id).snapshot_json);
  delete old.execution_method; delete old.prompt;
  providers.db.prepare('UPDATE degradation_provider_runs SET snapshot_json=? WHERE id=?').run(JSON.stringify(old), run.id);
  providers.markRunning(run.id); providers.part(run.id, 'pelican', { state: 'submitted', remote_id: 'legacy-task' });
  new ProviderStore(store); let reads = 0;
  service.request = async (url, options) => { reads++; assert.equal(options.method, 'GET'); assert.match(url, /legacy-task$/); return { id: 'legacy-task', benchmark: 'pelican', status: 'succeeded', result: { html, prompt: 'Legacy prompt' }, assessment: { quality: 'normal' } }; };
  await service.execute(providers.run(run.id));
  assert.equal(reads, 1); assert.equal(generations.length, 0); assert.equal(providers.run(run.id).conclusion, 'passed');
  assert.equal(providers.run(run.id).snapshot_json, JSON.stringify(old));
  const result = JSON.parse(providers.run(run.id).response_json);
  assert.equal(result.prompt, 'Legacy prompt'); assert.equal(result.method, undefined);
  assert.equal(cleanManxue({ result: { prompt: 'legacy fallback' } }).prompt, 'legacy fallback');
});
