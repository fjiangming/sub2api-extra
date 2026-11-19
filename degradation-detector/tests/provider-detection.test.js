'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Store } = require('../src/store');
const { ProviderStore } = require('../src/provider-store');
const { ProviderDetection } = require('../src/provider-detection');
const { CredentialVault } = require('../src/credential-vault');
const { channels, defaultConfiguration, configurationSchema, keyContext } = require('../src/provider-config');
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

test('Manxue reasoning efforts preserve all presets, custom defaults and group overrides in saved settings and requests', async t => {
  const posts = [];
  const { service, providers } = setup(t, { request: async (_url, options) => {
    posts.push(options.body);
    return options.body.benchmark === 'candy'
      ? { id: 'candy', status: 'succeeded', candy: { status: 'passed' } }
      : { id: 'pelican', status: 'succeeded', assessment: { quality: 'normal' } };
  } });
  for (const channel of ['candy', 'pelican']) {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'future-effort-v2']) {
      const next = input(providers.configuration().revision);
      next.channels[channel].defaults.reasoning_effort = ` ${effort} `;
      next.groups.find(group => group.id === '2' && group.channel === channel).override = {
        ...next.channels[channel].defaults, reasoning_effort: 'group-effort-v3'
      };
      const prepared = service.prepareConfiguration(next, groups);
      assert(providers.save(prepared.input, prepared.groups));
      assert.equal(providers.configuration().channels[channel].defaults.reasoning_effort, effort);
      const run = service.enqueue('1', channel);
      await service.execute(providers.run(run.id));
      assert.equal(providers.run(run.id).conclusion, 'passed');
      assert.equal(JSON.parse(providers.run(run.id).snapshot_json).reasoning_effort, effort);
      assert.equal(posts.at(-1).reasoning_effort, effort);
      const overridden = service.enqueue('2', channel);
      await service.execute(providers.run(overridden.id));
      assert.equal(posts.at(-1).reasoning_effort, 'group-effort-v3');
      assert.equal(JSON.parse(providers.run(overridden.id).snapshot_json).reasoning_effort, 'group-effort-v3');
      assert.equal(JSON.parse(providers.run(run.id).snapshot_json).reasoning_effort, effort);
    }
  }
  for (const effort of ['', '   ', 'x'.repeat(65), 'high\ninvalid', null]) {
    const invalid = input(providers.configuration().revision);
    invalid.channels.pelican.defaults.reasoning_effort = effort;
    assert.throws(() => service.prepareConfiguration(invalid, groups), /推理程度|reasoning_effort/);
  }
  let rejectedPosts = 0;
  service.request = async (_url, options) => {
    rejectedPosts++;
    assert.equal(options.body.reasoning_effort, 'future-effort-v2');
    throw Object.assign(new Error('unsupported reasoning effort'), { httpStatus: 400 });
  };
  const rejected = service.enqueue('1', 'pelican');
  await service.execute(providers.run(rejected.id));
  assert.equal(rejectedPosts, 1, 'an upstream rejection must not retry with a lower effort');
  assert.equal(providers.run(rejected.id).status, 'error');
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

test('config validation retains keys after address edits, rejects duplicates and cannot change saved config on failure', t => {
  const { service, providers } = setup(t);
  const next = input(1);
  next.groups.forEach(group => delete group.key);
  next.channels.candy.defaults.target_url = 'https://other.example.com/v1';
  const changed = service.prepareConfiguration(next, groups);
  assert.equal(changed.groups[0].key_cipher, providers.group('1', 'candy').key_cipher);
  assert.equal(providers.configuration().revision, 1);
  next.channels.candy.defaults.target_url = 'https://relay.example.com/v1';
  next.groups.find(group => group.id === '2' && group.channel === 'candy').key = 'sk-provider-candy-1-1234567890';
  assert.throws(() => service.prepareConfiguration(next, groups), /不能共用/);
  const valid = input(1); valid.channels.pelican.defaults.reasoning_effort = 'ultra';
  assert.equal(service.prepareConfiguration(valid, groups).input.channels.pelican.defaults.reasoning_effort, 'ultra');
  const stale = input(0);
  assert.throws(() => service.prepareConfiguration(stale, groups), /其他管理员/);
  assert.throws(() => service.prepareConfiguration({ ...input(1), groups: [...input(1).groups, input(1).groups[0]] }, groups), /重复/);
});

test('website and upstream edits retain legacy keys including omitted groups, use new destinations and preserve old snapshots', async t => {
  const posts = [];
  const { service, providers, store, vault } = setup(t, { request: async (url, options) => {
    if (options.method === 'POST') {
      posts.push({ url, body: options.body });
      return options.body.mode ? { job_id: 'iq-job' } : { id: 'done', status: 'succeeded', candy: { status: 'passed' }, assessment: { quality: 'normal' } };
    }
    return { mode: 'iq', engines: { iq: { level: 'high' } } };
  } });
  providers.db.prepare("UPDATE degradation_provider_groups SET key_destination='legacy-mismatched-destination'").run();
  const previous = providers.groups();
  assert(previous.every(group => providers.enabled(group)), 'old destination metadata must not gate existing credentials');
  const historical = providers.create(providers.group('2', 'candy'));
  providers.response(historical.id, { candy: { status: 'passed' } }); providers.finish(historical.id, 'completed');
  const oldSnapshot = providers.run(historical.id).snapshot_json;
  const stale = service.enqueue('1', 'candy');
  const next = input(1); next.groups = [];
  next.providers.manxue.api_url = 'https://new-manxue.example.com/tests';
  next.providers.testllm.api_url = 'https://new-testllm.example.com';
  for (const channel of channels) next.channels[channel].defaults.target_url = 'https://new-relay.example.com/v1';
  next.channels.testllm.defaults.cache_test = false; next.channels.testllm.defaults.thinking_test = false;
  const prepared = service.prepareConfiguration(next, groups);
  assert(providers.save(prepared.input, prepared.groups));
  new ProviderStore(store);
  for (const old of previous) {
    const saved = providers.group(old.group_id, old.channel);
    assert.equal(saved.key_cipher, old.key_cipher); assert.equal(saved.key_fingerprint, old.key_fingerprint);
    assert(providers.enabled(saved));
    assert.equal(vault.decrypt(keyContext(old.channel, old.group_id), saved.key_cipher), `sk-provider-${old.channel}-${old.group_id}-1234567890`);
  }
  await service.execute(providers.run(stale.id));
  assert.equal(providers.run(stale.id).error_code, 'PROVIDER_CONFIG_CHANGED');
  assert.equal(posts.length, 0);
  for (const channel of channels) {
    const run = service.enqueue('1', channel);
    await service.execute(providers.run(run.id));
    const saved = providers.run(run.id);
    assert.equal(saved.status, 'completed');
    assert.equal(JSON.parse(saved.snapshot_json).target_url, 'https://new-relay.example.com/v1');
    assert.equal(posts.at(-1).url, channel === 'testllm' ? 'https://new-testllm.example.com/api/detect' : 'https://new-manxue.example.com/tests');
    assert.equal(posts.at(-1).body.base_url, 'https://new-relay.example.com/v1');
    assert.equal(posts.at(-1).body.api_key, `sk-provider-${channel}-1-1234567890`);
  }
  assert.equal(providers.run(historical.id).snapshot_json, oldSnapshot);
  assert.equal(store.db.serialize().includes(Buffer.from('sk-provider-candy-1-1234567890')), false);
});

test('AI platform parameters govern all its groups and detectors while isolating other platforms and retaining credentials', async t => {
  const posts = [];
  const { service, providers } = setup(t, { request: async (_url, options) => {
    if (options.method === 'POST') {
      posts.push(options.body);
      return options.body.mode ? { job_id: 'iq-job' } : { id: 'done', status: 'succeeded', candy: { status: 'passed' }, assessment: { quality: 'normal' } };
    }
    return { mode: 'iq', engines: { iq: { level: 'high' } } };
  } });
  const discovered = [...groups, { id: '3', name: 'GPT third', platform: 'openai' }];
  const legacy = input(1);
  for (const channel of channels) {
    legacy.groups.find(group => group.id === '1' && group.channel === channel).override = { ...legacy.channels[channel].defaults, model: `legacy-${channel}` };
    legacy.groups.push({ id: '3', channel, enabled: true, override: null, key: `sk-provider-${channel}-3-1234567890` });
  }
  let prepared = service.prepareConfiguration(legacy, discovered); providers.save(prepared.input, prepared.groups);
  const before = providers.groups();
  const next = { ...providers.configuration(), groups: [], platforms: ['openai', 'anthropic'].map(id => ({ id, params: {
    ...legacy.channels.candy.defaults, target_url: `https://${id}.example.com/v1`, model: `${id}-shared`, reasoning_effort: `${id}-custom`,
    service_tier: 'priority', cache_test: false, thinking_test: false
  } })) };
  prepared = service.prepareConfiguration(next, discovered); providers.save(prepared.input, prepared.groups);
  for (const group of discovered) for (const channel of channels) {
    const saved = providers.group(group.id, channel);
    assert.equal(saved.override_json, null, 'omitted legacy overrides must be cleared when the platform is unified');
    assert.equal(saved.key_cipher, before.find(old => old.group_id === group.id && old.channel === channel).key_cipher);
    const run = service.enqueue(group.id, channel); await service.execute(providers.run(run.id));
    const snapshot = JSON.parse(providers.run(run.id).snapshot_json);
    assert.equal(snapshot.model, `${group.platform}-shared`); assert.equal(snapshot.reasoning_effort, `${group.platform}-custom`);
    assert.equal(snapshot.target_url, `https://${group.platform}.example.com/v1`);
    assert.equal(posts.at(-1).model, snapshot.model); assert.equal(posts.at(-1).base_url, snapshot.target_url);
    if (channel === 'testllm') assert.equal(posts.at(-1).protocol, group.platform === 'openai' ? 'gpt' : 'claude');
    else { assert.equal(posts.at(-1).reasoning_effort, snapshot.reasoning_effort); assert.equal(posts.at(-1).service_tier, 'priority'); }
  }
  const another = { ...providers.configuration(), groups: [{ id: '1', channel: 'candy', enabled: true, override: legacy.channels.candy.defaults }] };
  prepared = service.prepareConfiguration(another, discovered); providers.save(prepared.input, prepared.groups);
  assert.equal(providers.group('1', 'candy').override_json, null, 'legacy clients cannot replace configured common platform parameters');
  assert.equal(providers.effective(providers.group('1', 'candy')).model, 'openai-shared');
});

test('legacy configurations and independent models survive unrelated saves until explicitly applying shared platform parameters', t => {
  const { service, providers, store } = setup(t);
  const legacy = input(1); delete legacy.platforms;
  legacy.groups.forEach(group => delete group.key);
  legacy.groups[0].override = { ...legacy.channels.candy.defaults, model: 'legacy-group-model' };
  let prepared = service.prepareConfiguration(legacy, groups); providers.save(prepared.input, prepared.groups);
  const stored = providers.configuration(); delete stored.revision; delete stored.platforms;
  providers.db.prepare('UPDATE degradation_provider_settings SET config_json=? WHERE id=1').run(JSON.stringify(stored));
  assert.deepEqual(new ProviderStore(store).configuration().platforms, []);
  const originalModel = store.getPlatformTest.bind(store);
  store.getPlatformTest = (platform, ...args) => platform === 'anthropic' ? { model: 'legacy-inherited-claude' } : originalModel(platform, ...args);
  const keys = providers.groups().map(group => group.key_cipher);
  const unchanged = { ...providers.configuration(), groups: [] }; delete unchanged.platforms;
  unchanged.providers.manxue.api_url = 'https://updated.example.com/tests';
  prepared = service.prepareConfiguration(unchanged, groups); providers.save(prepared.input, prepared.groups);
  assert.equal(providers.effective(providers.group('1', 'candy')).model, 'legacy-group-model');
  assert.equal(providers.effective(providers.group('2', 'testllm')).model, 'legacy-inherited-claude');
  assert.deepEqual(providers.groups().map(group => group.key_cipher), keys);
  const unified = { ...providers.configuration(), groups: [], platforms: [{ id: 'openai', params: { ...legacy.channels.candy.defaults, model: 'common-gpt' } }] };
  prepared = service.prepareConfiguration(unified, groups); providers.save(prepared.input, prepared.groups);
  assert.equal(providers.effective(providers.group('1', 'candy')).model, 'common-gpt');
  assert.equal(providers.effective(providers.group('1', 'testllm')).model, 'common-gpt');
  assert.equal(providers.effective(providers.group('2', 'testllm')).model, 'legacy-inherited-claude');
});

test('invalid shared platform settings fail atomically and still require valid group credentials', t => {
  const { service, providers } = setup(t);
  const before = providers.configuration(); const rows = providers.groups();
  const next = { ...before, groups: [], platforms: [{ id: 'openai', params: { ...before.channels.candy.defaults } }] };
  for (const invalid of [
    { ...next, platforms: [...next.platforms, ...next.platforms] },
    { ...next, platforms: [{ id: 'openai', params: { ...next.platforms[0].params, target_url: '' } }] },
    { ...next, platforms: [{ id: 'openai', params: { ...next.platforms[0].params, model: '' } }] },
    { ...next, platforms: [{ id: 'openai', params: { ...next.platforms[0].params, target_url: 'https://127.0.0.1' } }] },
    { ...next, platforms: [{ id: 'openai', params: { ...next.platforms[0].params, model_source: 'group' } }] },
    { ...next, groups: [{ id: '1', channel: 'candy', enabled: true, override: null, clear_key: true }] }
  ]) {
    assert.throws(() => service.prepareConfiguration(invalid, groups));
    assert.deepEqual(providers.configuration(), before); assert.deepEqual(providers.groups(), rows);
  }
  providers.db.prepare("UPDATE degradation_provider_groups SET key_cipher='corrupted' WHERE group_id='1' AND channel='candy'").run();
  assert.throws(() => service.prepareConfiguration(next, groups), { code: 'DETECTION_KEY_UNREADABLE' });
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
  omitted.channels.pelican.defaults.model = '';
  assert.throws(() => service.prepareConfiguration(omitted, groups), /模型/);
  omitted.channels.pelican.defaults.model = 'gpt-6-astra';
  omitted.providers.manxue.api_url = 'https://other.example.com/api';
  assert.equal(service.prepareConfiguration(omitted, groups).input.providers.manxue.api_url, 'https://other.example.com/api');
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
