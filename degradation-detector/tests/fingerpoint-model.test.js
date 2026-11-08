'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Store } = require('../src/store');
const { ModelStore } = require('../src/model-store');
const { ModelDetection } = require('../src/model-detection');
const { CredentialVault } = require('../src/credential-vault');
const { defaultModelPlatform, modelGroupContext, modelPlatformSchema } = require('../src/model-config');
const { demoFingerprintResponse } = require('../src/fingerpoint-fixture');
const { createApp } = require('../src/server');
const { runFingerprintWorker } = require('../src/fingerpoint-runner');
const { defaultTests, testConfig, listen } = require('./helpers');

function setup(t, overrides = {}) {
  const config = testConfig(t); const store = new Store(config); const models = new ModelStore(store); const vault = new CredentialVault(config);
  const platform = defaultModelPlatform('openai', 'gpt-test');
  Object.assign(platform, { enabled: true, target_url: 'https://relay.example.com/v1' });
  Object.assign(platform.channels.fingerpoint, { enabled: true, rounds: 2 });
  models.save({ platforms: [{ id: 'openai', config: platform, groups: [{ id: '1', name: 'One', enabled: true, models: { fingerpoint: 'gpt-group' }, keyCipher: vault.encrypt(modelGroupContext('1'), 'sk-fingerpoint-dedicated-123456'), keyFingerprint: vault.fingerprint('sk-fingerpoint-dedicated-123456') }] }] });
  const state = { released: 0, calls: 0 };
  const fingerprintData = { acquire: async () => ({ directory: 'isolated-test-directory', sdk_version: '0.2.0', built_at: '2026-11-03T12:00:00Z', models: 66, hash: 'a'.repeat(64), release: async () => { state.released++; } }), close: async () => {} };
  const service = new ModelDetection({ config, store, modelStore: models, vault, fingerprintData, runFingerprint: async (input, _signal, onEvent) => {
    state.calls++; state.input = input;
    const response = demoFingerprintResponse(input.model, 'openai', input);
    for (const round of response.rounds) onEvent({ type: 'round', result: round });
  }, ...overrides });
  t.after(async () => { await service.close(); store.close(); });
  return { config, store, models, vault, platform, service, state };
}

test('Fingerpoint-only configs validate alongside legacy two-channel configs and enforce sampling bounds', () => {
  const platform = defaultModelPlatform('openai', 'gpt-test');
  platform.enabled = true; platform.target_url = 'https://relay.example.com'; platform.channels.fingerpoint.enabled = true;
  assert.equal(modelPlatformSchema.safeParse(platform).success, true);
  platform.channels.fingerpoint.count = 1; platform.channels.fingerpoint.parallel = 2;
  assert.equal(modelPlatformSchema.safeParse(platform).success, false);
  platform.channels.fingerpoint.parallel = 1; platform.channels.fingerpoint.strict = true;
  assert.equal(modelPlatformSchema.safeParse(platform).success, false);
  platform.channels.fingerpoint.count = 3; platform.channels.fingerpoint.effort = 'max';
  assert.equal(modelPlatformSchema.safeParse(platform).success, true);
  platform.channels.fingerpoint.key_cipher = 'injected';
  assert.equal(modelPlatformSchema.safeParse(platform).success, false);
  delete platform.channels.fingerpoint;
  platform.channels.cctest.enabled = true;
  assert.equal(modelPlatformSchema.safeParse(platform).success, true);
});

test('official SDK builds all supported protocol requests and challenge sets without contacting a model', async () => {
  const sdk = await import('lmfpd-sdk');
  const suffixes = { responses: '/responses', chat_completions: '/chat/completions', messages: '/messages' };
  for (const [api, suffix] of Object.entries(suffixes)) {
    const request = sdk.buildRequest({ baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-offline-contract-123456', model: 'test-model', api, effort: 'max', count: 3, parallel: 1, strict: false, stream: true }, 'challenge');
    assert.equal(request.error, undefined); assert(request.url.endsWith(suffix));
    assert.equal(request.body.stream, true); assert.equal(request.body.model, 'test-model');
    assert.equal(api === 'messages' ? request.headers['x-api-key'] : request.headers.Authorization, api === 'messages' ? 'sk-offline-contract-123456' : 'Bearer sk-offline-contract-123456');
  }
  const challenges = sdk.generateChallenges(3);
  assert.equal(challenges.length, 3); assert(challenges.every(challenge => challenge.prompt && Number.isSafeInteger(challenge.expected_count)));
});

test('SDK worker failures and cancellation settle without issuing requests or leaving workers running', async t => {
  const config = testConfig(t);
  const input = { target_url: 'https://relay.example.com/v1', key: 'sk-worker-offline-123456', model: 'test', api: 'responses', effort: 'high', count: 3, parallel: 1, rounds: 1, timeout_seconds: 30, strict: false, directory: config.dataDir };
  await assert.rejects(runFingerprintWorker(input, new AbortController().signal, () => {}), /FINGERPOINT_EXECUTION_FAILED/);
  const controller = new AbortController();
  const pending = runFingerprintWorker(input, controller.signal, () => {});
  controller.abort(); await assert.rejects(pending, /MODEL_TIMEOUT/);
});

test('Fingerpoint uses the group dedicated key and override, retains every round and immutable reference metadata', async t => {
  const { service, models, state, store } = setup(t);
  const run = service.enqueue('1')[0];
  assert.equal(run.channel, 'fingerpoint'); assert.equal(run.model, 'gpt-group');
  await service.execute(models.run(run.id));
  const row = models.run(run.id); const response = JSON.parse(row.response_json);
  assert.equal(row.status, 'completed'); assert.equal(row.item_count, response.analysis.results.length);
  assert.equal(state.input.key, 'sk-fingerpoint-dedicated-123456'); assert.equal(state.input.model, 'gpt-group');
  assert.equal(response.rounds.length, 2); assert.equal(response.rounds[0].samples.length, 3);
  assert.equal(response.sdk_version, '0.2.0'); assert.equal(response.data.hash, 'a'.repeat(64));
  assert.match(response.rounds[0].samples[0].prompt, /整数|integer|number/i);
  assert.equal(response.progress, 1); assert.equal(row.total, null); assert.equal(state.released, 1);
  assert.equal(store.db.serialize().includes(Buffer.from(state.input.key)), false);
  assert.equal(models.counts('1', 'cctest').total, 0);
});

test('Fingerpoint partial, unscorable and missing analyses never turn into a confirmed match', async t => {
  const { service, models } = setup(t);
  for (const decision of ['partial', 'unscorable', 'not_model', null]) {
    service.runFingerprint = async (_input, _signal, onEvent) => onEvent({ type: 'round', result: { round: 1, challenges: [], samples: [], analysis: decision ? { decision, probability: null, results: [], used_outputs: decision === 'partial' ? 1 : 0 } : null, error: 'Scoring not available' } });
    const run = service.enqueue('1')[0]; await service.execute(models.run(run.id)); const row = models.run(run.id);
    assert.equal(row.conclusion, decision || 'unscorable'); assert.equal(row.item_count, 0); assert.equal(row.total, null);
    assert.equal(JSON.parse(row.response_json).analysis?.probability ?? null, null);
  }
});

test('interrupted Fingerpoint keeps completed samples without replaying model requests after restart', async t => {
  const { service, models, store, state } = setup(t);
  service.runFingerprint = async (_input, _signal, onEvent) => {
    state.calls++;
    onEvent({ type: 'sample', round: 1, index: 2, sample: { state: 'complete', raw_text: '1, 2, 3 sk-fingerpoint-dedicated-123456', expected_count: 3, count: 3 } });
    throw new Error('FINGERPOINT_EXECUTION_FAILED');
  };
  const run = service.enqueue('1')[0]; await service.execute(models.run(run.id)); const row = models.run(run.id);
  assert.equal(row.status, 'error'); assert.equal(state.calls, 1); assert.equal(state.released, 1);
  const response = JSON.parse(row.response_json);
  assert.equal(response.rounds[0].samples[0].state, 'queued');
  assert.match(response.rounds[0].samples[2].raw_text, /已隐藏/);
  const interrupted = models.create(models.group('1'), 'fingerpoint', 'manual');
  models.markRunning(interrupted.id); models.markSubmitted(interrupted.id);
  new ModelStore(store);
  assert.equal(models.run(interrupted.id).error_code, 'SERVICE_RESTARTED');
  assert.equal(state.calls, 1);
});

test('reference failures stop before target dispatch, and configuration changes cancel active Fingerpoint', async t => {
  const { service, models, state } = setup(t);
  service.fingerprintData.acquire = async () => { throw Object.assign(new Error('unavailable'), { code: 'FINGERPOINT_DATA_UNAVAILABLE' }); };
  const run = service.enqueue('1')[0]; await service.execute(models.run(run.id));
  assert.equal(state.calls, 0); assert.equal(models.run(run.id).submitted_at, null);
  assert.match(models.run(run.id).reason, /未发起模型请求/);
  let started;
  service.fingerprintData.acquire = async () => ({ directory: 'test', release: async () => {} });
  service.runFingerprint = async (_input, signal) => { started(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); throw new Error('MODEL_TIMEOUT'); };
  const begin = new Promise(resolve => { started = resolve; });
  service.pump();
  service.enqueue('1'); service.pump(); await begin;
  models.db.prepare('UPDATE model_groups SET enabled=0 WHERE group_id=?').run('1');
  const pending = [...service.active.values()].map(active => active.promise);
  service.configurationChanged(); await Promise.all(pending);
  assert.equal(models.latest('1', 'fingerpoint').status, 'error');
  assert.equal(models.run(models.latest('1', 'fingerpoint').id).error_code, 'MODEL_CONFIG_CHANGED');
});

test('Fingerpoint-only automatic plans enqueue independent scheduled runs without changing IQ settings', async t => {
  const { service, models, store, state } = setup(t);
  const schedule = { enabled: true, mode: 'interval', times: ['09:30'], interval_minutes: 60 };
  models.db.prepare('UPDATE model_settings SET schedule_json=? WHERE id=1').run(JSON.stringify(schedule));
  models.db.prepare('UPDATE model_groups SET next_run_at=? WHERE group_id=?').run(Date.now() - 1, '1');
  const original = store.getServiceSettings().schedule_times;
  service.tick();
  await Promise.all([...service.active.values()].map(item => item.promise));
  const run = models.latest('1', 'fingerpoint');
  assert.equal(run.trigger_type, 'scheduled'); assert.equal(run.status, 'completed'); assert.equal(state.calls, 1);
  assert(models.group('1').next_run_at > Date.now()); assert.deepEqual(store.getServiceSettings().schedule_times, original);
  assert.equal(models.counts('1', 'bazaarlink').total, 0);
});

test('third-channel results and background data management enforce live admin, CSRF and group permissions', async t => {
  let isAdmin = true; let visible = true; let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let downloads = 0;
  const groups = [{ id: '1', name: 'First', platform: 'openai' }, { id: '2', name: 'Second', platform: 'openai' }];
  const { app, runtime } = createApp(testConfig(t), { startScheduler: false, sub2api: {
    verifyUser: async token => ({ id: token, name: token, role: token === 'admin' && isAdmin ? 'admin' : 'user' }),
    listAvailableGroups: async token => token === 'admin' ? groups : visible ? [groups[0]] : []
  }, fingerprintDependencies: { download: async () => { downloads++; await blocked; throw new Error('private network diagnostics'); } }, modelDependencies: { runFingerprint: async (input, _signal, onEvent) => { const data = demoFingerprintResponse(input.model, 'openai', input); onEvent({ type: 'round', result: data.rounds[0] }); } } });
  const http = await listen(app);
  t.after(async () => { release(); await http.close(); await runtime.scheduler.close(); runtime.auth.close(); await runtime.groupMetrics.close(); runtime.store.close(); });
  const session = async token => (await fetch(http.baseUrl + '/api/auth/sso', { method: 'POST', headers: { authorization: `Bearer ${token}` } })).json();
  const a = await session('admin'); const u = await session('ordinary');
  const call = (url, who = u, method = 'GET', body, csrf = true) => fetch(http.baseUrl + url, { method, headers: { authorization: `Session ${who.sessionToken}`, 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': who.csrfToken } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await call('/api/admin/fingerpoint/data')).status, 403);
  for (const action of ['check','apply','rollback']) {
    assert.equal((await call(`/api/admin/fingerpoint/data/${action}`, u, 'POST', {})).status, 403);
    assert.equal((await call(`/api/admin/fingerpoint/data/${action}`, a, 'POST', {}, false)).status, 403);
  }
  assert.equal(downloads, 0);
  const config = defaultModelPlatform('openai', 'gpt-test'); config.enabled = true; config.target_url = 'https://relay.example.com';
  for (const channel of Object.values(config.channels)) channel.enabled = true;
  config.channels.cctest.api_key = 'cct-only-site-123456';
  const payload = { schedule_mode: 'daily', schedule_times: ['09:00'], schedule_interval_minutes: 60, fingerprint_data: { automatic: true, interval_hours: 12, application: 'manual', source: 'mirror' }, platforms: [{ id: 'openai', enabled: false, test: defaultTests.openai, model_detection: config, groups: groups.map(group => ({ id: group.id, enabled: false, model_detection: { enabled: true, key: `sk-dedicated-group-${group.id}-123456`, models: { fingerpoint: 'gpt-group' } } })) }] };
  const saved = await call('/api/admin/config', a, 'PUT', payload); assert.equal(saved.status, 200, await saved.clone().text());
  const status = await (await call('/api/admin/fingerpoint/data', a)).json(); assert.equal(status.application, 'manual'); assert.equal(status.interval_hours, 12);
  const results = await (await call('/api/model-results')).json(); assert.equal(results.groups.length, 1); assert.equal(Object.keys(results.groups[0].channels).length, 3);
  assert.equal(results.groups[0].channels.fingerpoint.model, 'gpt-group');
  assert.doesNotMatch(JSON.stringify(results), /relay\.example|sk-dedicated|cct-only|key_cipher/);
  const other = runtime.modelDetection.enqueue('2', 'manual', ['fingerpoint'])[0];
  assert.equal((await call(`/api/model-results/${other.id}`)).status, 404);
  assert.equal((await call('/api/model/groups/2/channels/fingerpoint/runs')).status, 404);
  assert.equal((await call('/api/admin/groups/1/model-runs', u, 'POST', { channels: ['fingerpoint'] })).status, 403);
  const pending = await call('/api/admin/fingerpoint/data/check', a, 'POST', {});
  assert.equal(pending.status, 202); assert.equal((await pending.json()).busy, true);
  assert.equal((await call('/api/admin/fingerpoint/data/apply', a, 'POST', {})).status, 409);
  release(); await runtime.fingerprintData.pending.catch(() => {}); await new Promise(resolve => setImmediate(resolve));
  const failed = await (await call('/api/admin/fingerpoint/data', a)).json();
  assert.equal(failed.busy, false); assert.match(failed.last_error, /保留/); assert.doesNotMatch(JSON.stringify(failed), /private network/);
  visible = false; assert.equal((await (await call('/api/model-results')).json()).groups.length, 0);
  isAdmin = false; assert.equal((await call('/api/admin/fingerpoint/data', a)).status, 403);
  assert.equal((await call('/api/admin/fingerpoint/data/check', a, 'POST', {})).status, 403);
});
