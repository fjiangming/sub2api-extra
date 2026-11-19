'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Store } = require('../src/store');
const { ProviderStore } = require('../src/provider-store');
const { ProviderDetection } = require('../src/provider-detection');
const { CredentialVault } = require('../src/credential-vault');
const { channels, defaultConfiguration, configurationSchema } = require('../src/provider-config');
const { cleanReport, conclusion } = require('../src/provider-results');
const { testConfig } = require('./helpers');

const groups = [{ id: '1', name: 'GPT first', platform: 'openai' }, { id: '2', name: 'Claude second', platform: 'anthropic' }];
function input(revision = 0) {
  const value = { revision, ...defaultConfiguration(), groups: [] };
  for (const provider of Object.values(value.providers)) provider.enabled = true;
  for (const channel of channels) {
    value.channels[channel].enabled = true;
    value.channels[channel].defaults.target_url = 'https://relay.example.com/v1';
    for (const group of groups) value.groups.push({ id: group.id, channel, enabled: true, override: null, key: `sk-provider-${channel}-${group.id}-1234567890` });
  }
  return value;
}
function setup(t, dependencies = {}) {
  const config = testConfig(t);
  const store = new Store(config);
  const providers = new ProviderStore(store);
  const vault = new CredentialVault(config);
  const service = new ProviderDetection({ config, providerStore: providers, vault, resolve: async () => ({}), pollMs: 1, ...dependencies });
  const prepared = service.prepareConfiguration(input(), groups);
  providers.save(prepared.input, prepared.groups);
  t.after(async () => { await service.close(); store.close(); });
  return { config, store, providers, vault, service };
}

test('provider config is opt-in, strict, independent and rejects unsafe URLs and duplicate schedules', () => {
  const value = { revision: 0, ...defaultConfiguration(), groups: [] };
  assert.equal(value.providers.manxue.enabled, false);
  assert.equal(value.channels.testllm.schedule.enabled, false);
  for (const url of ['http://relay.example.com', 'https://127.0.0.1', 'https://user:pass@relay.example.com', 'https://relay.example.com?q=key', 'https://host.docker.internal', 'https://relay.example.com:8443']) {
    value.channels.candy.defaults.target_url = url;
    assert.equal(configurationSchema.safeParse(value).success, false, url);
  }
  value.channels.candy.defaults.target_url = '';
  value.channels.candy.schedule.times = ['09:30', '09:30'];
  assert.equal(configurationSchema.safeParse(value).success, false);
  value.channels.candy.schedule.times = ['09:30'];
  value.channels.candy.key_cipher = 'forged';
  assert.equal(configurationSchema.safeParse(value).success, false);
});

test('candy and pelican submit the direct benchmark contract, exclude errors and never infer a pass from succeeded', async t => {
  const calls = [];
  const { service, providers, store } = setup(t, { request: async (url, options) => {
    calls.push({ url, ...options });
    if (options.method === 'POST') return { id: options.body.benchmark, status: 'running' };
    if (url.endsWith('candy')) return { id: 'candy', status: 'succeeded', candy: { status: 'incorrect', answer: 'wrong sk-provider-candy-1-1234567890', duration_ms: 1000 }, api_key: 'echo-key' };
    return { id: 'pelican', status: 'succeeded', assessment: { quality: 'normal', reason: '正常' }, result: { html: '<html><body>sample</body></html>' }, headers: { authorization: 'secret' } };
  } });
  const candy = service.enqueue('1', 'candy');
  const pelican = service.enqueue('1', 'pelican');
  assert.equal(service.enqueue('1', 'candy').id, candy.id);
  await service.execute(providers.run(candy.id)); await service.execute(providers.run(pelican.id));
  assert.equal(providers.run(candy.id).conclusion, 'failed');
  assert.equal(providers.run(pelican.id).conclusion, 'passed');
  const posts = calls.filter(call => call.method === 'POST');
  assert.equal(posts.length, 2);
  assert.equal(posts[0].body.api_key, 'sk-provider-candy-1-1234567890');
  assert.equal(posts[0].body.base_url, 'https://relay.example.com/v1');
  assert.equal(posts[0].body.benchmark, 'candy');
  assert.equal(posts[0].body.reasoning_effort, 'low');
  assert.equal(posts[0].apiKey, undefined);
  assert.equal(posts[1].body.html, undefined, 'pelican is direct generation, not old HTML review');
  assert.equal(store.db.serialize().includes(Buffer.from('sk-provider-candy-1-1234567890')), false);
  assert.doesNotMatch(providers.run(candy.id).response_json, /echo-key/);
  assert.equal(conclusion('candy', { status: 'succeeded' }), 'unknown');
  assert.equal(conclusion('pelican', { assessment: { quality: 'unknown' } }), 'unknown');
  assert.equal(conclusion('candy', { candy: { status: 'error' } }), 'error');
});

test('TestLLM aggregates separate IQ/cache/thinking jobs, persists each remote ID and does not invent latency', async t => {
  const calls = [];
  const { service, providers } = setup(t, {
    events: async () => {},
    request: async (url, options) => {
      calls.push({ url, ...options });
      if (options.method === 'POST') return { job_id: `job-${options.body.mode}` };
      const mode = url.split('-').at(-1);
      return { job_id: `job-${mode}`, mode, engines: { [mode]: mode === 'iq' ? { level: 'excellent', duration: 21, level_label: '<img>', api_key: 'secret' } : mode === 'cache' ? { supported: true, total: 4, hit_rate: 85, request_hit_rate: 75, duration: 6 } : { has_thinking: true, has_signature: false, duration: 3 } } };
    }
  });
  const run = service.enqueue('2', 'testllm');
  await service.execute(providers.run(run.id));
  const saved = providers.run(run.id);
  assert.equal(saved.status, 'completed'); assert.equal(saved.conclusion, 'passed');
  const response = JSON.parse(saved.response_json);
  assert.equal(response.iq.duration, 21); assert.equal(response.cache.hit_rate, 85); assert.equal(response.think.has_signature, false);
  assert.equal(response.iq.ttft, undefined);
  const posts = calls.filter(call => call.method === 'POST');
  assert.deepEqual(posts.map(call => call.body.mode), ['iq', 'cache', 'think']);
  assert.equal(new Set(posts.map(call => call.taskKey)).size, 3);
  assert(posts.every(call => call.body.protocol === 'claude' && call.body.api_key === 'sk-provider-testllm-2-1234567890'));
  assert.equal(Object.values(JSON.parse(saved.parts_json)).filter(part => part.state === 'done').length, 3);
  assert.doesNotMatch(saved.response_json, /api_key|<img>/);
});

test('TestLLM waits for SSE completion and preserves a failed optional result independently', async t => {
  let ready = false; let eventCalls = 0;
  const { service, providers } = setup(t, {
    events: async url => { eventCalls++; assert.match(url, /\/api\/jobs\/iq-job\/events$/); ready = true; },
    request: async (url, options) => {
      if (options.method === 'POST') return { job_id: `${options.body.mode}-job` };
      if (url.includes('/iq-job') && !ready) throw Object.assign(new Error('waiting'), { httpStatus: 404 });
      if (url.includes('/cache-job')) throw Object.assign(new Error('bad'), { httpStatus: 400 });
      const mode = url.includes('/iq-job') ? 'iq' : 'think';
      return { mode, engines: { [mode]: mode === 'iq' ? { level: 'high', duration: 2 } : { has_thinking: true, has_signature: true } } };
    }
  });
  const run = service.enqueue('1', 'testllm');
  await service.execute(providers.run(run.id));
  assert.equal(eventCalls, 1);
  const saved = providers.run(run.id);
  assert.equal(saved.conclusion, 'passed');
  const response = JSON.parse(saved.response_json);
  assert.equal(response.cache, undefined);
  assert(response.errors.cache); assert(response.think.has_signature);
  assert.match(saved.reason, /部分检测/);
});

test('ambiguous POST is never retried, restart resumes only saved IDs, and completed TestLLM parts are not resubmitted', async t => {
  let posts = 0;
  const { service, providers, store } = setup(t, { request: async (_url, options) => { if (options.method === 'POST') { posts++; throw new Error('ECONNRESET'); } return { id: 'known-id', status: 'succeeded', candy: { status: 'passed' } }; } });
  const uncertain = service.enqueue('1', 'candy');
  await service.execute(providers.run(uncertain.id));
  assert.equal(posts, 1); assert.match(providers.run(uncertain.id).reason, /未自动重发/);
  const crash = service.enqueue('1', 'candy');
  providers.markRunning(crash.id); providers.part(crash.id, 'candy', { state: 'submitting' });
  const known = service.enqueue('2', 'candy');
  providers.markRunning(known.id); providers.part(known.id, 'candy', { state: 'submitted', remote_id: 'known-id' });
  new ProviderStore(store);
  assert.equal(providers.run(crash.id).status, 'error');
  await service.execute(providers.run(known.id));
  assert.equal(posts, 1); assert.equal(providers.run(known.id).conclusion, 'passed');
  const partial = service.enqueue('1', 'testllm');
  providers.markRunning(partial.id); providers.part(partial.id, 'iq', { state: 'done', remote_id: 'old-iq' });
  providers.response(partial.id, { iq: { level: 'excellent', duration: 3 } });
  const modes = [];
  service.request = async (url, options) => {
    if (options.method === 'POST') { modes.push(options.body.mode); return { job_id: options.body.mode }; }
    const mode = url.split('/').at(-1);
    return { mode, engines: { [mode]: mode === 'cache' ? { total: 2, supported: false } : { has_thinking: false, has_signature: false } } };
  };
  new ProviderStore(store);
  await service.execute(providers.run(partial.id));
  assert.deepEqual(modes, ['cache', 'think']);
  assert.equal(providers.run(partial.id).conclusion, 'passed');
});

test('config validation binds keys to destinations, rejects duplicates and cannot change saved config on failure', t => {
  const { service, providers } = setup(t);
  const next = input(1);
  next.groups.forEach(group => delete group.key);
  next.channels.candy.defaults.target_url = 'https://other.example.com/v1';
  assert.throws(() => service.prepareConfiguration(next, groups), /重新填写/);
  assert.equal(providers.configuration().revision, 1);
  next.channels.candy.defaults.target_url = 'https://relay.example.com/v1';
  next.groups.find(group => group.id === '2' && group.channel === 'candy').key = 'sk-provider-candy-1-1234567890';
  assert.throws(() => service.prepareConfiguration(next, groups), /不能共用/);
  const valid = input(1); valid.channels.pelican.defaults.reasoning_effort = 'ultra';
  assert.throws(() => service.prepareConfiguration(valid, groups), /只支持/);
  const stale = input(0);
  assert.throws(() => service.prepareConfiguration(stale, groups), /其他管理员/);
  assert.throws(() => service.prepareConfiguration({ ...input(1), groups: [...input(1).groups, input(1).groups[0]] }, groups), /重复/);
});

test('independent schedules, key rotation and configuration snapshots preserve historical parameters', async t => {
  const { service, providers } = setup(t, { request: async (_url, options) => options.method === 'POST' ? { id: 'one', status: 'running' } : { id: 'one', status: 'succeeded', candy: { status: 'passed' } } });
  const settings = input(1);
  settings.channels.candy.schedule = { enabled: true, mode: 'interval', times: ['09:30'], interval_minutes: 60 };
  const prepared = service.prepareConfiguration(settings, groups); providers.save(prepared.input, prepared.groups);
  assert.equal(providers.group('1', 'testllm').next_run_at, null);
  const next = providers.group('1', 'candy').next_run_at;
  const run = service.enqueue('1', 'candy'); await service.execute(providers.run(run.id));
  assert.equal(providers.group('1', 'candy').next_run_at, next);
  const oldSnapshot = providers.run(run.id).snapshot_json;
  const changed = input(2); changed.channels.candy.defaults.model = 'new-model';
  const save = service.prepareConfiguration(changed, groups); providers.save(save.input, save.groups);
  assert.equal(providers.run(run.id).snapshot_json, oldSnapshot);
  assert.equal(providers.history('1', 'candy')[0].model, 'gpt-6-astra');
  const queued = service.enqueue('1', 'candy');
  providers.db.prepare('UPDATE degradation_provider_groups SET enabled=0 WHERE group_id=? AND channel=?').run('1', 'candy');
  await service.execute(providers.run(queued.id));
  assert.equal(providers.run(queued.id).error_code, 'PROVIDER_CONFIG_CHANGED');
});

test('mismatched task identifiers, malformed reports, timeout and rate limiting cannot become a pass', async t => {
  const { service, providers } = setup(t, { request: async (_url, options) => options.method === 'POST' ? { id: 'correct' } : { id: 'wrong', status: 'succeeded', candy: { status: 'passed' } } });
  const mismatch = service.enqueue('1', 'candy'); await service.execute(providers.run(mismatch.id));
  assert.equal(providers.run(mismatch.id).error_code, 'PROVIDER_TASK_MISMATCH');
  const timed = service.enqueue('1', 'candy');
  providers.db.prepare('UPDATE degradation_provider_runs SET started_at=? WHERE id=?').run(Date.now() - 901000, timed.id);
  await service.execute(providers.run(timed.id));
  assert.equal(providers.run(timed.id).error_code, 'PROVIDER_TIMEOUT');
  service.request = async () => { throw Object.assign(new Error('limited'), { httpStatus: 429, retryAfterSeconds: 120 }); };
  const limited = service.enqueue('1', 'candy'); await service.execute(providers.run(limited.id));
  assert(providers.throttled('pelican')); assert.equal(providers.throttled('testllm'), false);
  assert.throws(() => service.enqueue('2', 'pelican'), /限流/);
  assert.throws(() => cleanReport({ mode: 'iq', engines: { iq: { level: 'future' } } }, 'iq'), /INVALID/);
  assert.throws(() => cleanReport({ mode: 'cache', engines: { iq: { level: 'high' } } }, 'iq'), /INVALID/);
});

test('bounded maintenance protects recent samples and active jobs, prunes payloads and keeps category history isolated', async t => {
  const { service, providers } = setup(t);
  for (let i = 0; i < 70; i++) {
    const run = providers.create(providers.group('1', 'candy'));
    providers.response(run.id, { candy: { status: 'passed', answer: '9' } }); providers.finish(run.id, 'completed');
  }
  const active = service.enqueue('1', 'candy');
  const other = providers.create(providers.group('1', 'pelican')); providers.finish(other.id, 'error');
  const result = await providers.maintain({ enabled: true, history_per_group: 60, history_days: 90, artifact_per_group: 60 });
  assert.equal(result.archived, 11);
  assert.equal(providers.counts('1', 'candy').total, 60);
  assert.equal(providers.counts('1', 'candy').archived, 11);
  assert.equal(providers.run(active.id).status, 'queued');
  assert.equal(providers.counts('1', 'pelican').total, 1);
  assert.equal(providers.deleteHistory('1', 'pelican', [active.id]), null);
  assert.equal(providers.deleteHistory('1', 'candy', [active.id]), null);
  assert.equal(providers.deleteHistory('1', 'pelican'), 1);
  assert.equal(providers.counts('1', 'candy').total, 60);
});

test('global edits also validate omitted groups and cache percentages retain zero without inventing out-of-range rates', t => {
  const { service, providers } = setup(t);
  const omitted = input(1); omitted.groups = [];
  omitted.channels.pelican.defaults.reasoning_effort = 'ultra';
  assert.throws(() => service.prepareConfiguration(omitted, groups), /只支持/);
  omitted.channels.pelican.defaults.reasoning_effort = 'low';
  omitted.providers.manxue.api_url = 'https://other.example.com/api';
  assert.throws(() => service.prepareConfiguration(omitted, groups), /重新填写/);
  assert.equal(providers.configuration().revision, 1);
  const cache = cleanReport({ mode: 'cache', engines: { cache: { supported: true, total: 4, hit_rate: 0, request_hit_rate: 125 } } }, 'cache');
  assert.equal(cache.hit_rate, 0); assert.equal(cache.request_hit_rate, null);
});

test('scheduler caps concurrency, only advances its own due category and shutdown resumes known IDs without replay', async t => {
  let posts = 0;
  let reads = 0;
  const { service, providers } = setup(t, { request: async (_url, options) => {
    if (options.method === 'POST') { posts++; return { id: `known-${posts}`, status: 'running' }; }
    reads++;
    await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  } });
  const next = input(1);
  next.channels.candy.schedule = { enabled: true, mode: 'interval', times: ['09:30'], interval_minutes: 60 };
  next.channels.candy.concurrency = 1;
  const prepared = service.prepareConfiguration(next, groups); providers.save(prepared.input, prepared.groups);
  providers.db.prepare("UPDATE degradation_provider_groups SET next_run_at=? WHERE channel='candy'").run(Date.now() - 1);
  service.tick();
  for (let i = 0; i < 20 && !reads; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(posts, 1); assert.equal(service.active.size, 1);
  assert.equal(providers.counts('1', 'testllm').total, 0);
  assert(providers.group('1', 'candy').next_run_at > Date.now());
  assert(providers.group('2', 'candy').next_run_at > Date.now());
  await service.close();
  const saved = providers.queued().find(run => run.status === 'running');
  assert(saved); assert.equal(JSON.parse(saved.parts_json).candy.state, 'submitted');
  const resumed = new ProviderDetection({ config: service.config, providerStore: providers, vault: service.vault, resolve: async () => ({}), pollMs: 1, request: async (_url, options) => {
    assert.equal(options.method, 'GET'); return { status: 'succeeded', candy: { status: 'passed' } };
  } });
  await resumed.execute(saved); await resumed.close();
  assert.equal(providers.run(saved.id).conclusion, 'passed'); assert.equal(posts, 1);
});

test('TestLLM group model inheritance snapshots the actual saved group test without reusing its credential', async t => {
  const { service, providers, store } = setup(t);
  const config = input(1);
  config.groups.find(group => group.id === '1' && group.channel === 'testllm').override = { ...config.channels.testllm.defaults, model_source: 'default', model: 'explicit-gpt' };
  const prepared = service.prepareConfiguration(config, groups); providers.save(prepared.input, prepared.groups);
  assert.equal(providers.effective(providers.group('1', 'testllm')).model, 'explicit-gpt');
  const original = store.getPlatformTest.bind(store);
  store.getPlatformTest = (platform, ...args) => platform === 'anthropic' ? { model: 'claude-inherited' } : original(platform, ...args);
  const run = service.enqueue('2', 'testllm');
  assert.equal(run.model, 'claude-inherited');
  const snapshot = JSON.parse(providers.run(run.id).snapshot_json);
  assert.equal(service.vault.decrypt(snapshot.key_context, snapshot.key_cipher), 'sk-provider-testllm-2-1234567890');
});
