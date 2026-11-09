'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Store } = require('../src/store');
const { ModelStore } = require('../src/model-store');
const { ModelDetection } = require('../src/model-detection');
const { CredentialVault } = require('../src/credential-vault');
const { defaultModelPlatform, modelGroupContext, modelPlatformSchema } = require('../src/model-config');
const { demoFingerprintResponse } = require('../src/fingerpoint-fixture');
const { fingerprintComparison } = require('../src/model-results');
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

test('Fingerpoint compares reference names and version aliases without merging different models or ambiguous names', () => {
  const analysis = { decision: 'scored', prediction: 'claude-opus-5.5', prediction_name: 'claude-opus-5.5', results: [
    { model: 'claude-opus-5.5', display_name: 'claude-opus-5.5' },
    { model: 'claude-sonnet-5.5', display_name: 'claude-sonnet-5.5' },
    { model: 'claude-opus-5', display_name: 'claude-opus-5' }
  ] };
  assert.equal(fingerprintComparison(analysis, 'claude-opus-5.5').comparison.method, 'exact_id');
  assert.deepEqual(fingerprintComparison(analysis, 'claude-opus-5-5'), { verdictKey: 'candidate_match', comparison: { version: 1, method: 'version_separator' } });
  assert.equal(fingerprintComparison(analysis, ' CLAUDE-OPUS-5-5 ').verdictKey, 'candidate_match');
  for (const model of ['claude-sonnet-5-5', 'claude-opus-5', 'claude-opus-55', 'claude-opus-5-4', 'claude-opus-5-5-thinking', 'claude-opus-5-5-20261101']) {
    assert.equal(fingerprintComparison(analysis, model).verdictKey, 'candidate_differs', model);
  }
  const named = { decision: 'scored', prediction: 'reference-model-id', results: [{ model: 'reference-model-id', display_name: 'model-5.5' }] };
  assert.equal(fingerprintComparison(named, 'model-5.5').comparison.method, 'reference_name');
  assert.equal(fingerprintComparison(named, 'model-5-5').verdictKey, 'candidate_match');
  named.results.push({ model: 'another-id', display_name: 'model-5.5' });
  assert.equal(fingerprintComparison(named, 'model-5-5').verdictKey, 'scored');
  assert.equal(fingerprintComparison(named, 'model-5.5').comparison.method, 'ambiguous');
  named.results.push({ model: 'model-5-5', display_name: 'Distinct exact model ID' });
  assert.equal(fingerprintComparison(named, 'model-5-5').verdictKey, 'candidate_differs');
  assert.equal(fingerprintComparison({ decision: 'scored', prediction: 'model-3.8b' }, 'model-3-8b').verdictKey, 'candidate_differs');
  assert.equal(fingerprintComparison({ decision: 'scored' }, 'claude-opus-5-5').verdictKey, 'scored');
  for (const decision of ['partial', 'unscorable', 'not_model']) {
    assert.equal(fingerprintComparison({ ...analysis, decision }, 'claude-opus-5-5').verdictKey, decision);
  }
});

test('Fingerpoint fixes the real Claude version alias while keeping requests and SDK analyses unchanged', async t => {
  const { service, models } = setup(t);
  models.db.prepare('UPDATE model_groups SET models_json=? WHERE group_id=?').run(JSON.stringify({ fingerpoint: 'claude-opus-5-5' }), '1');
  const official = demoFingerprintResponse('claude-opus-5.5', 'anthropic', { rounds: 3 });
  official.analysis.probability = 1;
  let calls = 0;
  service.runFingerprint = async (input, _signal, onEvent) => {
    calls++; assert.equal(input.model, 'claude-opus-5-5');
    for (const round of official.rounds) onEvent({ type: 'round', result: round });
  };
  const run = service.enqueue('1')[0]; await service.execute(models.run(run.id));
  const row = models.run(run.id); const response = JSON.parse(row.response_json);
  assert.equal(calls, 1); assert.equal(row.conclusion, 'candidate_match');
  assert.equal(response.requested_model, 'claude-opus-5-5');
  assert.equal(response.comparison.method, 'version_separator');
  assert.deepEqual(response.analysis, official.analysis);
  assert.deepEqual(response.rounds.map(round => round.analysis), official.rounds.map(round => round.analysis));
  assert.equal(models.history('1', 'fingerpoint')[0].conclusion, 'candidate_match');
});

test('existing Fingerpoint comparisons migrate once in bounded batches without rerunning or changing SDK evidence', t => {
  const { models, store, state } = setup(t);
  const saved = [];
  for (let i = 0; i < 53; i++) {
    const run = models.create(models.group('1'), 'fingerpoint', 'manual');
    const response = demoFingerprintResponse('claude-opus-5.5', 'anthropic', { rounds: 1 });
    response.requested_model = i === 52 ? 'claude-sonnet-5-5' : 'claude-opus-5-5';
    response.verdictKey = 'candidate_differs';
    models.db.prepare('UPDATE model_runs SET model=? WHERE id=?').run(response.requested_model, run.id);
    models.updateResponse(run.id, response, 'completed'); models.finish(run.id, 'completed', '3 rounds complete');
    saved.push(models.run(run.id));
  }
  const archived = models.create(models.group('1'), 'fingerpoint', 'manual');
  models.updateResponse(archived.id, { verdictKey: 'candidate_differs' }, 'completed'); models.finish(archived.id, 'completed');
  models.db.prepare('UPDATE model_runs SET response_json=NULL WHERE id=?').run(archived.id);
  const other = models.create(models.group('1'), 'cctest', 'manual');
  models.updateResponse(other.id, { verdictKey: 'candidate_differs' }, 'completed'); models.finish(other.id, 'completed');
  const originalOther = models.run(other.id);
  const active = models.create(models.group('1'), 'fingerpoint', 'manual');
  models.db.prepare('DROP TABLE model_result_migrations').run();
  const reopened = new ModelStore(store);
  for (const [index, before] of saved.entries()) {
    const after = reopened.run(before.id); const response = JSON.parse(after.response_json);
    const expected = index === 52 ? 'candidate_differs' : 'candidate_match';
    assert.equal(after.conclusion, expected); assert.equal(response.verdictKey, expected);
    const { verdictKey: _verdict, comparison: _comparison, ...evidence } = response;
    const { verdictKey: _oldVerdict, ...oldEvidence } = JSON.parse(before.response_json);
    assert.deepEqual(evidence, oldEvidence);
    assert.deepEqual({ ...after, response_json: before.response_json, conclusion: before.conclusion }, before);
  }
  assert.equal(reopened.history('1', 'fingerpoint', archived.id, 100).filter(run => run.conclusion === 'candidate_match').length, 52);
  assert.equal(reopened.run(archived.id).conclusion, 'candidate_differs');
  assert.equal(reopened.run(active.id).status, 'queued'); assert.deepEqual(reopened.run(other.id), originalOther);
  const changes = models.db.prepare('SELECT total_changes() AS n').get().n;
  new ModelStore(store);
  assert.equal(models.db.prepare('SELECT total_changes() AS n').get().n, changes);
  assert.equal(state.calls, 0);
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
