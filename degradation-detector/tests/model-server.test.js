'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createApp } = require('../src/server');
const { defaultModelPlatform } = require('../src/model-config');
const { defaultTests, listen, testConfig } = require('./helpers');

test('model admin APIs enforce live role, CSRF, group scope, encryption, atomic saves and read-only results', async t => {
  let admin = true; let visible = true;
  const allGroups = [{ id: '1', name: 'First group', platform: 'openai' }, { id: '2', name: 'Second group', platform: 'openai' }];
  const calls = [];
  const { app, runtime } = createApp(testConfig(t), { startScheduler: false, sub2api: {
    verifyUser: async token => ({ id: token, role: token === 'admin-token' && admin ? 'admin' : 'user', name: token }),
    listAvailableGroups: async token => token === 'admin-token' ? allGroups : visible ? [allGroups[0]] : []
  }, modelDependencies: { pollMs: 1, resolve: async () => ({}), request: async (url, options) => {
    calls.push({ url, ...options });
    if (options.method === 'POST') return { runId: 'safe-probe', taskId: 'safe-check' };
    return url.includes('/probe/') ? { runId: 'safe-probe', status: 'completed', items: [{ probeId: 'extra', passed: 'warning', response: 'sk-only-model-one-123456', responseHeaders: { server: 'private' } }], identityAssessment: { status: 'match', verdict: { status: 'clean_match_family_only', trueModel: null } }, userKey: 'private', reportUrl: '/private-report' }
      : { status: 'done', scores: { known: 0, future: null }, verdictKey: null, total: null };
  } } });
  const http = await listen(app);
  t.after(async () => { await http.close(); await runtime.scheduler.close(); runtime.auth.close(); await runtime.groupMetrics.close(); runtime.store.close(); });
  const session = async token => (await fetch(http.baseUrl + '/api/auth/sso', { method: 'POST', headers: { authorization: `Bearer ${token}` } })).json();
  const a = await session('admin-token'); const u = await session('user-token');
  const headers = (session, csrf = false) => ({ authorization: `Session ${session.sessionToken}`, 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': session.csrfToken } : {}) });
  const get = (url, who = u) => fetch(http.baseUrl + url, { headers: headers(who) });
  const send = (url, body, who = a, csrf = true, method = 'POST') => fetch(http.baseUrl + url, { method, headers: headers(who, csrf), body: JSON.stringify(body) });
  assert.equal((await (await get('/api/model-results')).json()).groups.length, 0);
  assert.equal((await get('/admin/model-config.js')).status, 403);
  assert.equal((await get('/admin/model-config.css')).status, 403);
  assert.equal((await fetch(http.baseUrl + '/api/model-results')).status, 401);
  const platform = defaultModelPlatform('openai', 'gpt-5'); platform.enabled = true; platform.target_url = 'https://relay.example.com';
  for (const key of ['bazaarlink','cctest']) platform.channels[key].enabled = true;
  platform.channels.cctest.api_key = 'cct-dedicated-site-key-123456';
  const payload = {
    schedule_mode: 'daily', schedule_times: ['08:00'], schedule_interval_minutes: 60,
    model_schedule: { enabled: false, mode: 'daily', times: ['09:30','21:30'], interval_minutes: 360 },
    platforms: [{ id: 'openai', enabled: false, test: defaultTests.openai, model_detection: platform, groups: allGroups.map((group, i) => ({ id: group.id, enabled: false, model_detection: { enabled: true, key: i ? 'sk-only-model-two-123456' : 'sk-only-model-one-123456', models: {} } })) }]
  };
  assert.equal((await send('/api/admin/config', payload, u, true, 'PUT')).status, 403);
  assert.equal((await send('/api/admin/config', payload, a, false, 'PUT')).status, 403);
  const saved = await send('/api/admin/config', payload, a, true, 'PUT');
  assert.equal(saved.status, 200, JSON.stringify(await saved.clone().json()));
  const configuration = await saved.json();
  assert.equal(configuration.platforms[0].model_detection.channels.cctest.key_configured, true);
  assert.equal(configuration.platforms[0].groups[0].model_detection.key_configured, true);
  assert.doesNotMatch(JSON.stringify(configuration), /sk-only|cct-dedicated|key_cipher|key_context|key_fingerprint/);
  assert.equal(runtime.store.listEnabledMonitors(runtime.config.serviceOwnerId).length, 0, 'IQ remains disabled while model detection works');
  const results = await (await get('/api/model-results')).json();
  assert.deepEqual(results.groups.map(group => group.id), ['1']);
  assert.equal(Object.keys(results.groups[0].channels).length, 2);
  assert.doesNotMatch(JSON.stringify(results), /relay\.example|key_cipher|key_fingerprint|cct-dedicated/);
  assert.equal((await send('/api/admin/groups/1/model-runs', {}, u)).status, 403);
  assert.equal((await send('/api/admin/groups/1/model-runs', {}, a, false)).status, 403);
  assert.equal((await send('/api/admin/groups/9/model-runs', {})).status, 404);
  const queuedResponse = await send('/api/admin/groups/1/model-runs', {});
  assert.equal(queuedResponse.status, 202);
  const queued = (await queuedResponse.json()).runs;
  assert.equal(queued.length, 2);
  assert.deepEqual((await (await send('/api/admin/groups/1/model-runs', {})).json()).runs.map(row => row.id), queued.map(row => row.id));
  for (const run of queued) await runtime.modelDetection.execute(runtime.modelStore.run(run.id));
  assert.equal(calls.filter(call => call.method === 'POST').length, 2);
  assert.equal(calls[0].body.apiKey, 'sk-only-model-one-123456');
  const detail = await (await get(`/api/model-results/${queued[0].id}`)).json();
  assert.equal(detail.response.items.length, 1);
  assert.equal(detail.conclusion, 'clean_match_family_only');
  assert.doesNotMatch(JSON.stringify(detail), /safe-probe|private-report|sk-only|responseHeaders":\{/);
  const second = runtime.modelDetection.enqueue('2', 'manual', ['bazaarlink'])[0];
  assert.equal((await get(`/api/model-results/${second.id}`)).status, 404);
  assert.equal((await get('/api/model/groups/2/channels/bazaarlink/runs')).status, 404);
  assert.equal((await get(`/api/admin/model-results/${queued[0].id}`)).status, 403);
  const retained = await get('/api/model/groups/1/channels/bazaarlink/runs');
  assert.equal((await retained.json()).runs.length, 1);
  assert.equal((await send('/api/admin/groups/1/model-runs/bazaarlink', { ids: [second.id] }, a, true, 'DELETE')).status, 409);
  assert.equal((await send('/api/admin/groups/1/model-runs/bazaarlink', { all: true }, u, true, 'DELETE')).status, 403);
  visible = false;
  assert.equal((await get(`/api/model-results/${queued[0].id}`)).status, 404);
  assert.equal((await (await get('/api/model-results')).json()).groups.length, 0);
  visible = true;

  const oldClient = { schedule_mode: 'daily', schedule_times: ['10:00'], schedule_interval_minutes: 60, platforms: [{ id: 'openai', enabled: false, test: defaultTests.openai, groups: allGroups.map(group => ({ id: group.id, enabled: false })) }] };
  assert.equal((await send('/api/admin/config', oldClient, a, true, 'PUT')).status, 200);
  assert.equal(runtime.modelStore.group('1').enabled, 1, 'older IQ-only saves cannot erase model configuration');
  const bad = structuredClone(payload); bad.schedule_times = ['11:00']; bad.platforms[0].model_detection.target_url = 'https://127.0.0.1';
  assert.equal((await send('/api/admin/config', bad, a, true, 'PUT')).status, 400);
  assert.deepEqual(runtime.store.getServiceSettings().schedule_times, ['10:00']);
  const changedDestination = structuredClone(payload); changedDestination.platforms[0].model_detection.target_url = 'https://new-relay.example.com';
  changedDestination.platforms[0].groups.forEach(group => { group.model_detection.key = ''; });
  assert.equal((await send('/api/admin/config', changedDestination, a, true, 'PUT')).status, 400);
  assert.equal(runtime.modelStore.platform('openai').target_url, 'https://relay.example.com');
  assert.equal((await send('/api/admin/groups/1/model-runs/bazaarlink', { ids: [queued[0].id] }, a, true, 'DELETE')).status, 200);
  assert.equal(runtime.modelStore.run(queued[1].id).status, 'completed', 'other channel history is preserved');
  admin = false;
  assert.equal((await get('/api/admin/config', a)).status, 403);
  assert.equal((await send('/api/admin/groups/1/model-runs', {})).status, 403);
});
