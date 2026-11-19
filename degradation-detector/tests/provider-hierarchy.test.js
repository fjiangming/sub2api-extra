'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/store');
const { ProviderStore } = require('../src/provider-store');
const { ProviderDetection } = require('../src/provider-detection');
const { CredentialVault } = require('../src/credential-vault');
const { channels, defaultConfiguration, providerParams, configurationSchema } = require('../src/provider-config');
const { testConfig } = require('./helpers');

const discovered = [
  { id: '1', platform: 'openai', name: 'GPT one' }, { id: '3', platform: 'openai', name: 'GPT three' },
  { id: '2', platform: 'anthropic', name: 'Claude two' }
];
function setup(t, dependencies = {}) {
  const config = testConfig(t);
  const store = new Store(config);
  const providers = new ProviderStore(store);
  const generations = [];
  const service = new ProviderDetection({ config, providerStore: providers, vault: new CredentialVault(config), resolve: async () => ({}), pollMs: 1,
    generate: async options => { generations.push(options); return { html: '<!doctype html><html><body>hierarchy artwork</body></html>' }; }, ...dependencies });
  const initial = { revision: 0, ...defaultConfiguration(), groups: [] };
  for (const provider of Object.values(initial.providers)) provider.enabled = true;
  for (const channel of channels) {
    initial.channels[channel].enabled = true;
    initial.channels[channel].defaults.target_url = 'https://legacy.example.com/v1';
    for (const group of discovered) initial.groups.push({ id: group.id, channel, enabled: true, override: null, key: `sk-hierarchy-${channel}-${group.id}` });
  }
  const save = value => { const prepared = service.prepareConfiguration(value, discovered); assert(providers.save(prepared.input, prepared.groups)); };
  save(initial);
  const input = () => ({ ...providers.configuration(), groups: [] });
  const hierarchy = () => {
    const value = input(); value.provider_platforms = providers.hierarchyPlatforms(discovered);
    return value;
  };
  t.after(async () => { await service.close(); store.close(); });
  return { config, store, providers, service, save, input, hierarchy, generations };
}

test('provider-specific platform schemas separate parameters and reject duplicates and unsupported TestLLM platforms', t => {
  const { hierarchy, save, providers } = setup(t);
  const value = hierarchy();
  assert.equal(value.provider_platforms.length, 4);
  assert.equal(configurationSchema.safeParse(value).success, true);
  const manxue = value.provider_platforms.find(scope => scope.provider === 'manxue');
  const testllm = value.provider_platforms.find(scope => scope.provider === 'testllm');
  assert.equal(manxue.params.protocol, undefined); assert.equal(testllm.params.reasoning_effort, undefined);
  for (const [entry, extra] of [[manxue, { protocol: 'gpt' }], [testllm, { service_tier: 'priority' }], [testllm, { reasoning_effort: 'ultra' }]]) {
    const forged = structuredClone(value);
    Object.assign(forged.provider_platforms.find(scope => scope.provider === entry.provider && scope.id === entry.id).params, extra);
    assert.equal(configurationSchema.safeParse(forged).success, false);
  }
  const before = providers.configuration();
  assert.throws(() => save({ ...value, provider_platforms: [...value.provider_platforms, manxue] }), /不能重复/);
  assert.deepEqual(providers.configuration(), before);
  const unsupported = structuredClone(value); unsupported.provider_platforms.find(scope => scope.provider === 'testllm').id = 'gemini';
  assert.equal(configurationSchema.safeParse(unsupported).success, false);
  for (const change of [
    config => { config.provider_platforms.find(scope => scope.provider === 'testllm').test_params = manxue.test_params; },
    config => { config.provider_platforms[0].test_params.pelican.reasoning_effort = ' '; },
    config => { config.provider_platforms[0].test_params.candy.protocol = 'gpt'; },
    config => { config.provider_platforms[0].test_params.other = manxue.test_params.candy; }
  ]) {
    const forged = structuredClone(value); change(forged);
    assert.equal(configurationSchema.safeParse(forged).success, false);
  }
});

test('provider and AI platform settings, group overrides and actual submitted parameters stay isolated', async t => {
  const posts = [];
  const { service, providers, hierarchy, save, input, generations } = setup(t, { request: async (url, options) => {
    if (options.method === 'POST') {
      posts.push({ url, body: options.body });
      return options.body.mode ? { job_id: 'iq' } : { id: 'done', benchmark: options.body.benchmark, status: 'succeeded', candy: { status: 'passed' }, assessment: { quality: 'normal' } };
    }
    return { mode: 'iq', engines: { iq: { level: 'excellent' } } };
  } });
  const value = hierarchy();
  for (const scope of value.provider_platforms) {
    delete scope.test_params;
    scope.params.model = `${scope.provider}-${scope.id}`;
    scope.params.target_url = `https://${scope.provider}-${scope.id}.example.com/v1`;
    if (scope.provider === 'testllm') { scope.params.cache_test = false; scope.params.thinking_test = false; }
    else { scope.params.reasoning_effort = 'custom-effort'; scope.params.service_tier = 'priority'; }
  }
  const base = value.provider_platforms.find(scope => scope.provider === 'manxue' && scope.id === 'openai').params;
  value.groups.push({ id: '1', channel: 'pelican', enabled: true, override: { ...base, model: 'group-model', timeout_seconds: 123 } });
  save(value);
  const historical = [];
  for (const group of discovered) for (const channel of channels) {
    const run = service.enqueue(group.id, channel); await service.execute(providers.run(run.id));
    const snapshot = JSON.parse(providers.run(run.id).snapshot_json);
    const provider = channel === 'testllm' ? 'testllm' : 'manxue';
    assert.equal(snapshot.model, group.id === '1' && channel === 'pelican' ? 'group-model' : `${provider}-${group.platform}`);
    const submitted = channel === 'pelican' ? generations.at(-1).snapshot : posts.at(-1).body;
    assert.equal(submitted.model, snapshot.model);
    assert.equal(channel === 'pelican' ? generations.at(-1).key : submitted.api_key, `sk-hierarchy-${channel}-${group.id}`);
    assert.equal(snapshot.timeout_seconds, group.id === '1' && channel === 'pelican' ? 123 : 900);
    assert.equal(providers.run(run.id).status, 'completed');
    if (channel === 'testllm') { assert.equal(snapshot.reasoning_effort, undefined); assert.equal(posts.at(-1).body.protocol, group.platform === 'anthropic' ? 'claude' : 'gpt'); }
    else { assert.equal(snapshot.cache_test, undefined); assert.equal(submitted.reasoning_effort, 'custom-effort'); }
    historical.push(providers.run(run.id).snapshot_json);
  }
  const changed = input();
  changed.provider_platforms.find(scope => scope.provider === 'manxue' && scope.id === 'openai').params.model = 'shared-changed';
  save(changed);
  assert.equal(providers.effective(providers.group('1', 'pelican')).model, 'group-model', 'omitted overrides survive shared edits');
  assert.equal(providers.effective(providers.group('3', 'candy')).model, 'shared-changed');
  assert.equal(providers.effective(providers.group('3', 'testllm')).model, 'testllm-openai');
  assert.equal(providers.effective(providers.group('2', 'candy')).model, 'manxue-anthropic');
  assert.deepEqual(providers.db.prepare('SELECT snapshot_json FROM degradation_provider_runs ORDER BY id').all().map(row => row.snapshot_json), historical);
  const inherit = input(); inherit.groups = [{ id: '1', channel: 'pelican', enabled: true, override: null }]; save(inherit);
  assert.equal(providers.effective(providers.group('1', 'pelican')).model, 'shared-changed');
  assert.equal(providers.effective(providers.group('1', 'pelican')).timeout_seconds, 900);
});

test('each question submits its own AI platform model and effort, with independent group inheritance and preserved history', async t => {
  const posts = [];
  const { service, providers, hierarchy, input, save, store, generations } = setup(t, { request: async (_url, options) => {
    posts.push(options.body);
    return { id: options.body.benchmark, benchmark: options.body.benchmark, status: 'succeeded', candy: { status: 'passed' }, assessment: { quality: 'normal' } };
  } });
  const value = hierarchy();
  for (const scope of value.provider_platforms.filter(scope => scope.provider === 'manxue')) {
    scope.params.model = 'unused-legacy-model'; scope.params.reasoning_effort = 'max';
    scope.test_params = {
      candy: { model: `${scope.id}-candy`, reasoning_effort: 'candy-custom' },
      pelican: { model: `${scope.id}-pelican`, reasoning_effort: 'high' }
    };
  }
  const openai = value.provider_platforms.find(scope => scope.provider === 'manxue' && scope.id === 'openai');
  value.groups = [{ id: '1', channel: 'pelican', enabled: true,
    override: { ...openai.params, model: 'group-pelican', reasoning_effort: 'low' } }];
  save(value);
  const before = providers.groups(); const snapshots = [];
  for (const group of discovered) for (const channel of ['candy', 'pelican']) {
    const run = service.enqueue(group.id, channel); await service.execute(providers.run(run.id));
    const expected = group.id === '1' && channel === 'pelican'
      ? { model: 'group-pelican', reasoning_effort: 'low' }
      : { model: `${group.platform}-${channel}`, reasoning_effort: channel === 'candy' ? 'candy-custom' : 'high' };
    assert.equal(posts.at(-1).benchmark, channel === 'pelican' ? 'html' : channel);
    const submitted = channel === 'pelican' ? generations.at(-1).snapshot : posts.at(-1);
    assert.equal(submitted.model, expected.model); assert.equal(submitted.reasoning_effort, expected.reasoning_effort);
    assert.equal(providers.run(run.id).model, expected.model);
    assert.equal(JSON.parse(providers.run(run.id).snapshot_json).reasoning_effort, expected.reasoning_effort);
    snapshots.push(providers.run(run.id).snapshot_json);
  }
  const changed = input();
  const changedScope = changed.provider_platforms.find(scope => scope.provider === 'manxue' && scope.id === 'openai');
  changedScope.test_params.candy = { model: 'changed-candy', reasoning_effort: 'ultra' };
  changedScope.test_params.pelican = { model: 'changed-pelican', reasoning_effort: 'medium' };
  save(changed);
  assert.equal(providers.effective(providers.group('1', 'candy')).model, 'changed-candy');
  assert.equal(providers.effective(providers.group('1', 'pelican')).model, 'group-pelican');
  assert.equal(providers.effective(providers.group('3', 'pelican')).model, 'changed-pelican');
  assert.equal(providers.effective(providers.group('2', 'pelican')).model, 'anthropic-pelican');
  const inherit = input(); inherit.groups = [{ id: '1', channel: 'pelican', enabled: true, override: null }]; save(inherit);
  assert.equal(providers.effective(providers.group('1', 'pelican')).model, 'changed-pelican');
  assert.equal(providers.effective(providers.group('1', 'pelican')).reasoning_effort, 'medium');
  assert.deepEqual(providers.groups().map(group => [group.key_cipher, group.next_run_at]), before.map(group => [group.key_cipher, group.next_run_at]));
  assert.deepEqual(providers.db.prepare('SELECT snapshot_json FROM degradation_provider_runs ORDER BY id').all().map(row => row.snapshot_json), snapshots);
  const reopened = new ProviderStore(store);
  assert.equal(reopened.effective(reopened.group('1', 'pelican')).model, 'changed-pelican');
  assert.equal(reopened.effective(reopened.group('3', 'candy')).reasoning_effort, 'ultra');
});

test('editing one question does not invalidate other questions or platforms and validates only enabled question defaults', t => {
  const { service, providers, hierarchy, input, save } = setup(t);
  save(hierarchy());
  const candy = service.enqueue('1', 'candy'); const pelican = service.enqueue('1', 'pelican');
  const testllm = service.enqueue('1', 'testllm'); const claude = service.enqueue('2', 'candy');
  const change = input();
  const scope = change.provider_platforms.find(scope => scope.provider === 'manxue' && scope.id === 'openai');
  scope.test_params.candy = { model: 'new-candy-model', reasoning_effort: 'ultra' }; save(change);
  assert.equal(providers.current(providers.run(candy.id)), false);
  for (const run of [pelican, testllm, claude]) assert.equal(providers.current(providers.run(run.id)), true);
  const before = providers.configuration(); const invalid = input();
  invalid.provider_platforms.find(scope => scope.provider === 'manxue' && scope.id === 'openai').test_params.pelican.model = '';
  assert.throws(() => save(invalid), /鹈鹕检测.*模型/);
  assert.deepEqual(providers.configuration(), before);
  invalid.provider_platforms.find(scope => scope.provider === 'manxue' && scope.id === 'openai').tests.pelican = false;
  save(invalid);
  assert.equal(providers.effective(providers.group('1', 'candy')).model, 'new-candy-model');
  assert.equal(providers.enabled(providers.group('1', 'pelican')), false);
});

test('scoped switches stop only their own work and destination changes retain credentials and historical snapshots', async t => {
  const { providers, service, hierarchy, save, input } = setup(t);
  save(hierarchy());
  const before = providers.groups();
  const candy = service.enqueue('1', 'candy'); const pelican = service.enqueue('1', 'pelican');
  const testllm = service.enqueue('1', 'testllm'); const claude = service.enqueue('2', 'candy');
  const value = input(); value.provider_platforms.find(scope => scope.provider === 'manxue' && scope.id === 'openai').tests.pelican = false;
  save(value);
  assert(providers.current(providers.run(candy.id))); assert(!providers.current(providers.run(pelican.id)));
  assert(providers.current(providers.run(testllm.id))); assert(providers.current(providers.run(claude.id)));
  await service.execute(providers.run(pelican.id)); assert.equal(providers.run(pelican.id).error_code, 'PROVIDER_CONFIG_CHANGED');
  const destination = input(); destination.providers.manxue.api_url = 'https://new-provider.example.com/tests';
  destination.provider_platforms.find(scope => scope.provider === 'manxue' && scope.id === 'openai').params.target_url = 'https://new-upstream.example.com/v1';
  save(destination);
  assert.deepEqual(providers.groups().map(group => group.key_cipher), before.map(group => group.key_cipher));
  assert.equal(JSON.parse(providers.run(candy.id).snapshot_json).target_url, 'https://legacy.example.com/v1');
  assert.equal(providers.effective(providers.group('1', 'candy')).target_url, 'https://new-upstream.example.com/v1');
  assert(!providers.current(providers.run(candy.id))); assert(providers.current(providers.run(testllm.id)));
});

test('schedules belong to each provider and AI platform, preserve per-group exceptions and survive reopening', t => {
  const { providers, store, hierarchy, save, input } = setup(t);
  const value = hierarchy();
  value.provider_platforms.find(scope => scope.provider === 'manxue' && scope.id === 'openai').schedule = { enabled: true, mode: 'interval', times: ['09:30'], interval_minutes: 60 };
  value.groups = [{ id: '1', channel: 'pelican', enabled: true, override: null,
    schedule_override: { enabled: true, mode: 'interval', times: ['09:30'], interval_minutes: 180 } }];
  save(value);
  const before = providers.group('1', 'candy').next_run_at;
  assert(before > Date.now());
  assert(providers.group('1', 'pelican').next_run_at > before + 119 * 60000);
  assert.equal(providers.group('2', 'candy').next_run_at, null); assert.equal(providers.group('1', 'testllm').next_run_at, null);
  const changed = input(); changed.provider_platforms.find(scope => scope.provider === 'manxue' && scope.id === 'openai').schedule.interval_minutes = 120;
  save(changed);
  assert(providers.group('1', 'candy').next_run_at > before + 59 * 60000);
  assert.equal(providers.schedule(providers.group('1', 'pelican')).interval_minutes, 180);
  const reopen = new ProviderStore(store);
  assert.equal(reopen.schedule(reopen.group('1', 'pelican')).interval_minutes, 180);
  const inherit = input(); inherit.groups = [{ id: '1', channel: 'pelican', enabled: true, override: null, schedule_override: null }]; save(inherit);
  assert.equal(providers.schedule(providers.group('1', 'pelican')).interval_minutes, 120);
  providers.advance(providers.group('1', 'pelican'));
  assert(providers.group('1', 'pelican').next_run_at > Date.now());
});

test('scoped concurrency is shared by candy and pelican, isolates AI platforms and obeys the total limit', async t => {
  const { providers, service, hierarchy, save } = setup(t, { request: async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }) });
  const value = hierarchy(); value.provider_platforms.forEach(scope => { scope.concurrency = 1; }); save(value);
  service.config.concurrency = 3;
  for (const [id, channel] of [['1', 'candy'], ['1', 'pelican'], ['3', 'candy'], ['2', 'candy'], ['1', 'testllm']]) service.enqueue(id, channel);
  service.pump();
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.active.size, 3);
  assert.deepEqual([...service.active.values()].map(value => value.scope).sort(), ['manxue:anthropic', 'manxue:openai', 'testllm:openai']);
  assert.equal(providers.queued().filter(run => run.status === 'queued').length, 2);
  await service.close();
});

test('group credential and parameter validation remains atomic across hidden groups and scoped changes', t => {
  const { providers, service, save, hierarchy, input } = setup(t);
  save(hierarchy()); const before = providers.configuration(); const rows = providers.groups();
  const invalid = input(); invalid.groups = [{ id: '1', channel: 'candy', enabled: true, override: null, clear_key: true }];
  assert.throws(() => save(invalid), /专用 Key/);
  const duplicate = input(); duplicate.groups = [{ id: '3', channel: 'candy', enabled: true, override: null, key: 'sk-hierarchy-candy-1' }];
  assert.throws(() => save(duplicate), /不能共用/);
  const missing = input(); missing.provider_platforms.find(scope => scope.provider === 'testllm' && scope.id === 'openai').params.model = '';
  assert.throws(() => service.prepareConfiguration(missing, discovered.filter(group => group.id !== '1')), /模型/);
  assert.deepEqual(providers.configuration(), before); assert.deepEqual(providers.groups(), rows);
  assert.equal(providers.db.serialize().includes(Buffer.from('sk-hierarchy-candy-1')), false);
  const narrow = input(); narrow.groups = [{ id: '1', channel: 'testllm', enabled: true, override: providerParams('manxue', before.provider_platforms[0].params) }];
  assert.throws(() => save(narrow), { code: 'VALIDATION_ERROR' });
});

test('suspending a group preserves selected projects, overrides, credentials and schedules for re-enabling', t => {
  const { providers, service, save, hierarchy, input } = setup(t);
  const value = hierarchy();
  const params = value.provider_platforms.find(scope => scope.provider === 'manxue' && scope.id === 'openai').params;
  value.groups = [{ id: '1', channel: 'candy', enabled: true, override: { ...params, model: 'preserved-model' },
    schedule_override: { enabled: true, mode: 'interval', times: ['09:30'], interval_minutes: 45 } },
  { id: '1', channel: 'pelican', enabled: false, override: null }];
  save(value); const key = providers.group('1', 'candy').key_cipher;
  const disabled = input(); disabled.groups = ['candy', 'pelican'].map(channel => ({ id: '1', channel,
    enabled: channel === 'candy', group_enabled: false, override: channel === 'candy' ? { ...params, model: 'preserved-model' } : null }));
  save(disabled);
  assert.equal(providers.group('1', 'candy').enabled, 1);
  assert.equal(providers.enabled(providers.group('1', 'candy')), false);
  assert.equal(providers.group('1', 'candy').next_run_at, null);
  assert.throws(() => service.enqueue('1', 'candy'), { code: 'PROVIDER_GROUP_NOT_CONFIGURED' });
  const enabled = input(); enabled.groups = disabled.groups.map(group => ({ ...group, group_enabled: true })); save(enabled);
  assert(providers.enabled(providers.group('1', 'candy'))); assert.equal(providers.enabled(providers.group('1', 'pelican')), false);
  assert.equal(providers.effective(providers.group('1', 'candy')).model, 'preserved-model');
  assert.equal(providers.group('1', 'candy').key_cipher, key); assert.equal(providers.schedule(providers.group('1', 'candy')).interval_minutes, 45);
  assert(providers.group('1', 'candy').next_run_at > Date.now());
});
