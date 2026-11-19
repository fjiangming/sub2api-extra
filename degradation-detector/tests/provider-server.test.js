'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/server');
const { defaultConfiguration, channels, providerParams, PELICAN_PROMPT, PELICAN_METHOD } = require('../src/provider-config');
const { demoResponse } = require('../src/provider-detection');
const { listen, testConfig } = require('./helpers');

async function setup(t) {
  const access = { admin: true, visible: true, platform: 'openai' };
  const groups = [{ id: '1', name: 'One', platform: 'openai' }, { id: '2', name: 'Two', platform: 'anthropic' }];
  const { app, runtime } = createApp(testConfig(t), {
    startScheduler: false,
    sub2api: {
      verifyUser: async token => ({ id: token, name: token, role: token === 'admin' && access.admin ? 'admin' : 'user' }),
      listAvailableGroups: async token => token === 'admin' ? groups : access.visible ? [{ ...groups[0], platform: access.platform }] : []
    },
    providerDependencies: { resolve: async () => { throw new Error('No real network'); } }
  });
  const http = await listen(app);
  t.after(async () => { await http.close(); await runtime.scheduler.close(); runtime.auth.close(); await runtime.groupMetrics.close(); runtime.store.close(); });
  const login = async token => (await fetch(http.baseUrl + '/api/auth/sso', { method: 'POST', headers: { authorization: `Bearer ${token}` } })).json();
  const admin = await login('admin'); const user = await login('reader');
  const headers = (who, csrf) => ({ authorization: `Session ${who.sessionToken}`, 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': who.csrfToken } : {}) });
  const get = (path, who = user, extra = {}) => fetch(http.baseUrl + path, { headers: { ...headers(who), ...extra } });
  const send = (path, body, who = admin, csrf = true, method = 'POST') => fetch(http.baseUrl + path, { method, headers: headers(who, csrf), body: JSON.stringify(body) });
  const input = { revision: 0, ...defaultConfiguration(), groups: [] };
  for (const provider of Object.values(input.providers)) provider.enabled = true;
  for (const channel of channels) {
    input.channels[channel].enabled = true;
    input.channels[channel].defaults.target_url = 'https://relay.example.com/v1';
    for (const group of groups) input.groups.push({ id: group.id, channel, enabled: true, override: null, key: `sk-private-${channel}-${group.id}-123456` });
  }
  return { ...http, access, groups, runtime, admin, user, get, send, input };
}

test('provider configuration and task writes enforce admin role, CSRF, scope, strict schemas and atomic revision checks', async t => {
  const { get, send, runtime, admin, user, input, access, baseUrl } = await setup(t);
  assert.equal((await fetch(baseUrl + '/api/provider-results')).status, 401);
  assert.equal((await get('/api/admin/provider-config')).status, 403);
  assert.equal((await get('/admin/provider-config.js')).status, 403);
  assert.equal((await get('/admin/provider-config.css')).status, 403);
  assert.equal((await send('/api/admin/provider-config', input, user, true, 'PUT')).status, 403);
  assert.equal((await send('/api/admin/provider-config', input, admin, false, 'PUT')).status, 403);
  assert.equal((await (await get('/api/provider-results')).json()).groups.length, 0);
  input.channels.pelican.defaults.reasoning_effort = 'custom-pelican-default';
  input.groups.find(group => group.id === '1' && group.channel === 'pelican').override = {
    ...input.channels.pelican.defaults, reasoning_effort: 'custom-pelican-group'
  };
  const saved = await send('/api/admin/provider-config', input, admin, true, 'PUT');
  assert.equal(saved.status, 200, await saved.clone().text());
  const payload = await saved.json();
  assert.equal(payload.revision, 1);
  assert.equal(payload.channels.pelican.defaults.reasoning_effort, 'custom-pelican-default');
  assert.equal(payload.groups.find(group => group.id === '1').configurations.pelican.override.reasoning_effort, 'custom-pelican-group');
  const reloaded = await (await get('/api/admin/provider-config', admin)).json();
  assert.equal(reloaded.channels.pelican.defaults.reasoning_effort, 'custom-pelican-default');
  assert(payload.groups.every(group => group.configurations.candy.key_configured));
  assert.doesNotMatch(JSON.stringify(payload), /sk-private|key_cipher|key_context|key_fingerprint|key_destination/);
  assert.equal(runtime.store.listEnabledMonitors(runtime.config.serviceOwnerId).length, 0);
  assert.equal((await send('/api/admin/provider-config', input, admin, true, 'PUT')).status, 409);
  const forged = structuredClone(input); forged.revision = 1; forged.groups[0].key_cipher = 'injected';
  assert.equal((await send('/api/admin/provider-config', forged, admin, true, 'PUT')).status, 400);
  const outOfScope = structuredClone(input); outOfScope.revision = 1; outOfScope.groups[0].id = '9';
  assert.equal((await send('/api/admin/provider-config', outOfScope, admin, true, 'PUT')).status, 400);
  assert.equal(runtime.providerStore.configuration().revision, 1);
  assert.equal((await send('/api/admin/provider/groups/1/candy/runs', {}, user)).status, 403);
  assert.equal((await send('/api/admin/provider/groups/1/candy/runs', {}, admin, false)).status, 403);
  assert.equal((await send('/api/admin/provider/groups/9/candy/runs', {})).status, 404);
  assert.equal((await send('/api/admin/provider/groups/1/candy/runs', { model: 'injected' })).status, 400);
  const queued = await send('/api/admin/provider/groups/1/candy/runs', {});
  assert.equal(queued.status, 202);
  const first = (await queued.json()).run;
  assert.equal((await (await send('/api/admin/provider/groups/1/candy/runs', {})).json()).run.id, first.id);
  assert.equal(runtime.providerStore.counts('2', 'candy').total, 0);
  access.admin = false;
  assert.equal((await get('/api/admin/provider-config', admin)).status, 403);
  assert.equal((await send('/api/admin/provider/groups/1/candy/runs', {})).status, 403);
});

test('shared AI platform settings and changed destinations save through HTTP without resupplying credentials', async t => {
  const { get, send, runtime, input, admin } = await setup(t);
  assert.equal((await send('/api/admin/provider-config', input, admin, true, 'PUT')).status, 200);
  const previous = runtime.providerStore.groups();
  const next = structuredClone(input); next.revision = 1;
  next.groups.forEach(group => delete group.key);
  next.providers.manxue.api_url = 'https://updated.example.com/tests';
  next.providers.testllm.api_url = 'https://updated-testllm.example.com';
  next.platforms = ['openai', 'anthropic'].map(id => ({ id, params: {
    ...next.channels.candy.defaults, target_url: `https://${id}.example.com/v1`, model: `${id}-shared`, reasoning_effort: 'custom-platform-effort'
  } }));
  const response = await send('/api/admin/provider-config', next, admin, true, 'PUT');
  assert.equal(response.status, 200, await response.clone().text());
  const payload = await response.json();
  assert.equal(payload.platforms.length, 2);
  for (const group of payload.groups) for (const channel of channels) {
    const value = group.configurations[channel];
    assert.equal(value.model, `${group.platform}-shared`); assert(value.key_configured); assert.equal(value.override, null);
    assert.equal(runtime.providerStore.group(group.id, channel).key_cipher, previous.find(old => old.group_id === group.id && old.channel === channel).key_cipher);
  }
  const reloaded = await (await get('/api/admin/provider-config', admin)).json();
  assert.deepEqual(reloaded.platforms, payload.platforms);
  assert.doesNotMatch(JSON.stringify(reloaded), /sk-private|key_cipher|key_context|key_fingerprint|key_destination|key_reconfirm_required/);
  const queued = await send('/api/admin/provider/groups/1/pelican/runs', {});
  assert.equal(queued.status, 202);
  const snapshot = JSON.parse(runtime.providerStore.run((await queued.json()).run.id).snapshot_json);
  assert.equal(snapshot.api_url, 'https://updated.example.com/tests'); assert.equal(snapshot.target_url, 'https://openai.example.com/v1');
  assert.equal(snapshot.model, 'openai-shared'); assert.equal(snapshot.reasoning_effort, 'custom-platform-effort');
});

test('batch detection filters the requested AI platform and retains schema, access and CSRF boundaries', async t => {
  const { send, runtime, input, admin, user, access } = await setup(t);
  await send('/api/admin/provider-config', input, admin, true, 'PUT');
  assert.equal((await send('/api/admin/provider/candy/runs', { platform: 'openai' }, user)).status, 403);
  assert.equal((await send('/api/admin/provider/candy/runs', { platform: 'openai' }, admin, false)).status, 403);
  for (const body of [{ platform: '' }, { platform: null }, { platform: 1 }, { platform: 'openai', model: 'forged' }, []]) {
    assert.equal((await send('/api/admin/provider/candy/runs', body)).status, 400);
  }
  assert.equal((await send('/api/admin/provider/candy/runs', { platform: 'missing' })).status, 404);
  const response = await send('/api/admin/provider/candy/runs', { platform: 'openai' });
  assert.equal(response.status, 202);
  assert.deepEqual((await response.json()).runs.map(run => run.group_id), ['1']);
  assert.equal(runtime.providerStore.counts('2', 'candy').total, 0);
  const legacy = await send('/api/admin/provider/pelican/runs', {});
  assert.equal(legacy.status, 202); assert.equal((await legacy.json()).runs.length, 2);
  access.admin = false;
  assert.equal((await send('/api/admin/provider/candy/runs', { platform: 'anthropic' })).status, 403);
});

test('read-only results, details, 24h history and signed sandbox previews recheck current group and platform access', async t => {
  const { get, send, runtime, input, access, user } = await setup(t);
  await send('/api/admin/provider-config', input, undefined, true, 'PUT');
  const store = runtime.providerStore;
  const seed = (id, channel) => { const run = store.create(store.group(id, channel)); store.response(run.id, demoResponse(channel)); store.finish(run.id, 'completed'); return run; };
  const old = seed('1', 'pelican');
  store.db.prepare('UPDATE degradation_provider_runs SET created_at=? WHERE id=?').run(Date.now() - 25 * 3600000, old.id);
  const run = seed('1', 'pelican'); const hidden = seed('2', 'pelican');
  const result = await (await get('/api/provider-results?channel=pelican')).json();
  assert.deepEqual(result.groups.map(group => group.id), ['1']);
  assert.equal(result.groups[0].latest.id, run.id);
  assert.doesNotMatch(JSON.stringify(result), /relay\.example|key_cipher|sk-private|<html>/);
  const history = await (await get('/api/provider/groups/1/pelican/runs?window=24h')).json();
  assert.deepEqual(history.runs.map(run => run.id), [run.id]);
  assert.equal((await get('/api/provider/groups/1/pelican/runs?window=week')).status, 400);
  assert.equal((await get('/api/provider/groups/1/pelican/runs?before=0')).status, 400);
  const detailResponse = await get(`/api/provider-results/${run.id}`, user, { 'x-preview-ancestors': '["https://console.example.com"]' });
  const detail = await detailResponse.json();
  assert(detail.preview_url.includes('signature='));
  assert.doesNotMatch(JSON.stringify(detail), /sk-private|key_cipher|relay\.example|key_context/);
  const preview = await get(detail.preview_url);
  assert.equal(preview.status, 200);
  const csp = preview.headers.get('content-security-policy');
  assert.match(csp, /sandbox allow-scripts/); assert.match(csp, /connect-src 'none'/); assert.match(csp, /frame-ancestors 'self' https:\/\/console.example.com/);
  assert.match(await preview.text(), /演示作品/);
  assert.equal((await get(detail.preview_url.replace('console', 'evil'))).status, 200, 'origin is encoded and signed, not a mutable raw query value');
  const tampered = detail.preview_url.replace(/signature=[^&]+/, 'signature=' + 'a'.repeat(43));
  assert.equal((await get(tampered)).status, 404);
  assert.equal((await get(`/api/provider-results/${hidden.id}`)).status, 404);
  access.platform = 'anthropic';
  assert.equal((await get(`/api/provider-results/${run.id}`)).status, 404);
  assert.equal((await (await get('/api/provider-results?channel=pelican')).json()).groups.length, 0);
  access.platform = 'openai'; access.visible = false;
  assert.equal((await get(detail.preview_url)).status, 404, 'signed URL does not bypass current permissions');
  assert.equal((await get('/api/provider/groups/1/pelican/runs')).status, 404);
});

test('locally generated pelican artwork and prompt remain available after classification failure, with diagnostics restricted to administrators', async t => {
  const { get, send, runtime, input, admin, user, access } = await setup(t);
  await send('/api/admin/provider-config', input, admin, true, 'PUT');
  const detector = runtime.providerDetection, store = runtime.providerStore;
  const source = '<!doctype html><html><body><svg><text>HTTP artwork</text></svg><script>window.artwork = 1;</script></body></html>';
  let generations = 0, submissions = 0;
  detector.resolve = async () => ({});
  detector.generate = async ({ snapshot }) => {
    generations++; assert.equal(snapshot.prompt, PELICAN_PROMPT);
    return { html: source, input_tokens: 100, output_tokens: 2000, first_token_ms: 30, duration_ms: 300 };
  };
  detector.request = async (_url, options) => {
    assert.equal(options.method, 'POST'); submissions++;
    assert.equal(options.body.benchmark, 'html'); assert.equal(options.body.html, source);
    assert.doesNotMatch(JSON.stringify(options.body), /sk-private|relay\.example/);
    return { id: 'fixture-failed', benchmark: 'html', status: 'failed', error: {
      code: 'UPSTREAM_READ', message: 'fixture read failed sk-private-pelican-1-123456 https://private.example.com/api'
    } };
  };
  const run = detector.enqueue('1', 'pelican'); await detector.execute(store.run(run.id));
  assert.equal(generations, 1); assert.equal(submissions, 1);
  for (const [prefix, who] of [['/api', user], ['/api/admin', admin]]) {
    const response = await get(`${prefix}/provider-results/${run.id}`, who); assert.equal(response.status, 200);
    const detail = await response.json();
    assert.equal(detail.conclusion, 'error'); assert.equal(detail.status, 'error');
    assert.equal(detail.method, PELICAN_METHOD); assert.equal(detail.settings.execution_method, PELICAN_METHOD);
    assert.equal(detail.response.prompt, PELICAN_PROMPT); assert.equal(detail.response.result.html, source);
    assert.equal(detail.output_tokens, 2000); assert.equal(detail.response.result.first_token_ms, 30);
    assert.equal(detail.response.diagnostic, undefined);
    if (who === admin) {
      assert.equal(detail.diagnostic.stage, 'poll'); assert.equal(detail.diagnostic.provider_code, 'UPSTREAM_READ');
      assert.match(detail.diagnostic.provider_message, /fixture read failed/);
    } else assert.equal(detail.diagnostic, undefined);
    assert.doesNotMatch(JSON.stringify(detail), /sk-private|private\.example|relay\.example|key_cipher/);
    const preview = await get(detail.preview_url, who); assert.equal(preview.status, 200);
    assert.equal(await preview.text(), source);
    assert.match(preview.headers.get('content-security-policy'), /sandbox allow-scripts/);
    assert.match(preview.headers.get('content-security-policy'), /connect-src 'none'/);
  }
  const listing = await (await get('/api/provider-results?channel=pelican')).json();
  assert.equal(listing.groups[0].latest.conclusion, 'error'); assert.equal(listing.groups[0].latest.method, PELICAN_METHOD);
  assert.doesNotMatch(JSON.stringify(listing), /fixture read failed|diagnostic|HTTP artwork/);
  assert.equal((await get(`/api/admin/provider-results/${run.id}`, user)).status, 403);
  store.db.prepare("UPDATE degradation_provider_runs SET snapshot_json='{}',response_json=NULL,parts_json='{}' WHERE id=?").run(run.id);
  const retired = await (await get(`/api/provider-results/${run.id}`)).json();
  assert.equal(retired.method, PELICAN_METHOD); assert.equal(retired.settings.execution_method, PELICAN_METHOD);
  assert.equal(retired.response, null); assert.equal(retired.preview_url, null);
  access.visible = false;
  assert.equal((await get(`/api/provider-results/${run.id}`)).status, 404);
});

test('disabled categories hide public history while admins retain access; deletion never crosses group/category or active jobs', async t => {
  const { get, send, runtime, input, admin, user } = await setup(t);
  await send('/api/admin/provider-config', input, admin, true, 'PUT');
  const store = runtime.providerStore;
  const first = store.create(store.group('1', 'candy')); store.response(first.id, demoResponse('candy')); store.finish(first.id, 'completed');
  const second = store.create(store.group('2', 'candy')); store.finish(second.id, 'error');
  const active = store.create(store.group('1', 'pelican'));
  assert.equal((await send('/api/admin/provider/groups/1/candy/runs', { ids: [second.id] }, admin, true, 'DELETE')).status, 409);
  assert.equal((await send('/api/admin/provider/groups/1/candy/runs', { ids: [active.id] }, admin, true, 'DELETE')).status, 409);
  assert.equal((await send('/api/admin/provider/groups/1/candy/runs', { all: true }, user, true, 'DELETE')).status, 403);
  const next = structuredClone(input); next.revision = 1; next.channels.candy.enabled = false;
  next.groups.forEach(group => delete group.key);
  assert.equal((await send('/api/admin/provider-config', next, admin, true, 'PUT')).status, 200);
  assert.equal((await get(`/api/provider-results/${first.id}`)).status, 404);
  assert.equal((await get(`/api/admin/provider-results/${first.id}`, admin)).status, 200);
  const removed = await send('/api/admin/provider/groups/1/candy/runs', { all: true }, admin, true, 'DELETE');
  assert.equal((await removed.json()).deleted, 1);
  assert(store.run(second.id)); assert(store.run(active.id));
  assert.equal(store.run(active.id).status, 'queued');
});

function hierarchyInput(payload) {
  return { revision: payload.revision, providers: payload.providers, channels: payload.channels, platforms: payload.platforms,
    provider_platforms: payload.hierarchy_platforms,
    groups: payload.groups.flatMap(group => channels.map(channel => ({ id: group.id, channel,
      enabled: group.configurations[channel].enabled, override: group.configurations[channel].hierarchy_override,
      schedule_override: group.configurations[channel].schedule_override }))) };
}

test('selected result deletion is atomic and clearing retains active work, credentials, configuration and other categories', async t => {
  const { get, send, runtime, input, admin } = await setup(t);
  await send('/api/admin/provider-config', input, admin, true, 'PUT');
  const store = runtime.providerStore;
  const finished = (id, channel, status) => { const run = store.create(store.group(id, channel)); store.finish(run.id, status); return run; };
  const first = finished('1', 'candy', 'completed'), second = finished('1', 'candy', 'error');
  const otherGroup = finished('2', 'candy', 'error'), otherChannel = finished('1', 'pelican', 'error');
  const active = store.create(store.group('1', 'candy')); store.markRunning(active.id);
  store.db.prepare('INSERT INTO degradation_provider_archives VALUES (?,?,?,?)').run('1', 'candy', 'openai', 7);
  const configuration = store.configuration(), groups = store.groups();
  const path = '/api/admin/provider/groups/1/candy/runs';
  for (const body of [{ ids: [] }, { ids: Array.from({ length: 101 }, (_, index) => index + 1) }, { all: true, ids: [first.id] }]) {
    assert.equal((await send(path, body, admin, true, 'DELETE')).status, 400);
  }
  assert.equal((await send(path, { ids: [first.id] }, admin, false, 'DELETE')).status, 403);
  for (const id of [otherGroup.id, otherChannel.id, active.id, 999999]) {
    assert.equal((await send(path, { ids: [first.id, id] }, admin, true, 'DELETE')).status, 409);
    assert(store.run(first.id), 'a conflicting selection must not partially delete');
  }
  const removed = await send(path, { ids: [first.id, second.id, first.id] }, admin, true, 'DELETE');
  assert.equal(removed.status, 200); assert.equal((await removed.json()).deleted, 2);
  assert.equal(store.run(first.id), undefined); assert.equal(store.run(second.id), undefined);
  assert.equal(store.counts('1', 'candy').archived, 7);
  assert.equal((await get(`/api/admin/provider-results/${first.id}`, admin)).status, 404);
  const last = finished('2', 'pelican', 'completed');
  const cleared = await send(path, { all: true }, admin, true, 'DELETE');
  assert.equal(cleared.status, 200); assert.equal((await cleared.json()).deleted, 0);
  assert.equal(store.counts('1', 'candy').archived, 0);
  assert.equal(store.run(active.id).status, 'running');
  for (const run of [otherGroup, otherChannel, last]) assert(store.run(run.id));
  assert.deepEqual(store.configuration(), configuration); assert.deepEqual(store.groups(), groups);
});

test('hierarchy conversion preserves legacy category and group differences, credentials, schedules and existing history through HTTP', async t => {
  const { input, send, get, admin, runtime } = await setup(t);
  input.channels.pelican.defaults.reasoning_effort = 'legacy-pelican-ultra';
  input.channels.pelican.timeout_seconds = 120;
  input.channels.pelican.schedule = { enabled: true, mode: 'interval', times: ['10:30'], interval_minutes: 45 };
  input.groups.find(group => group.id === '1' && group.channel === 'candy').override = { ...input.channels.candy.defaults, model: 'legacy-special-model' };
  assert.equal((await send('/api/admin/provider-config', input, admin, true, 'PUT')).status, 200);
  const store = runtime.providerStore;
  const previous = store.groups().map(group => ({ ...group, effective: providerParams(group.channel === 'testllm' ? 'testllm' : 'manxue', store.effective(group)), schedule: store.schedule(group) }));
  const historical = store.create(store.group('1', 'candy')); store.response(historical.id, demoResponse('candy')); store.finish(historical.id, 'completed');
  const oldSnapshot = store.run(historical.id).snapshot_json;
  const payload = await (await get('/api/admin/provider-config', admin)).json();
  assert.equal(payload.provider_platforms.length, 0, 'reading does not write or migrate configuration');
  assert.equal(payload.hierarchy_platforms.length, 4);
  assert.equal(payload.groups.find(group => group.id === '1').configurations.candy.hierarchy_override.model, 'legacy-special-model');
  assert.equal(payload.hierarchy_platforms.find(scope => scope.provider === 'manxue' && scope.id === 'anthropic').test_params.pelican.reasoning_effort, 'legacy-pelican-ultra');
  assert.equal(payload.groups.find(group => group.id === '2').configurations.pelican.hierarchy_override.timeout_seconds, 120);
  assert.equal(payload.groups[0].configurations.pelican.schedule_override.interval_minutes, 45);
  const converted = await send('/api/admin/provider-config', hierarchyInput(payload), admin, true, 'PUT');
  assert.equal(converted.status, 200, await converted.clone().text());
  for (const old of previous) {
    const group = store.group(old.group_id, old.channel);
    assert.deepEqual(providerParams(old.channel === 'testllm' ? 'testllm' : 'manxue', store.effective(group)), old.effective);
    assert.deepEqual(store.schedule(group), old.schedule);
    assert.equal(group.key_cipher, old.key_cipher);
    assert.equal(group.next_run_at, old.next_run_at);
  }
  assert.equal(store.run(historical.id).snapshot_json, oldSnapshot);
  const reloaded = await (await get('/api/admin/provider-config', admin)).json();
  assert.equal(reloaded.hierarchy_platforms.length, 4);
  assert.equal(reloaded.groups.find(group => group.id === '1').configurations.candy.hierarchy_override.model, 'legacy-special-model');
  assert.doesNotMatch(JSON.stringify(reloaded), /sk-private|key_cipher|key_fingerprint|key_context/);
  const publicResult = await (await get('/api/provider-results?channel=pelican')).json();
  assert.equal(publicResult.groups[0].schedule.interval_minutes, 45);
  assert.doesNotMatch(JSON.stringify(publicResult), /hierarchy_platforms|override|relay\.example|sk-private/);
});

test('question defaults save, reload and enqueue independently through HTTP while older shared scopes remain readable', async t => {
  const { input, send, get, admin, runtime } = await setup(t);
  await send('/api/admin/provider-config', input, admin, true, 'PUT');
  const payload = await (await get('/api/admin/provider-config', admin)).json();
  const next = hierarchyInput(payload);
  const scope = next.provider_platforms.find(scope => scope.provider === 'manxue' && scope.id === 'openai');
  scope.test_params = { candy: { model: 'candy-model', reasoning_effort: 'max' }, pelican: { model: 'pelican-model', reasoning_effort: 'high' } };
  const saved = await send('/api/admin/provider-config', next, admin, true, 'PUT');
  assert.equal(saved.status, 200, await saved.clone().text());
  const reloaded = await (await get('/api/admin/provider-config', admin)).json();
  assert.deepEqual(reloaded.provider_platforms.find(scope => scope.provider === 'manxue' && scope.id === 'openai').test_params, scope.test_params);
  for (const channel of ['candy', 'pelican']) {
    assert.equal(reloaded.groups.find(group => group.id === '1').configurations[channel].hierarchy_override, null);
    const queued = await send(`/api/admin/provider/groups/1/${channel}/runs`, {});
    assert.equal(queued.status, 202);
    const run = (await queued.json()).run;
    const snapshot = JSON.parse(runtime.providerStore.run(run.id).snapshot_json);
    assert.equal(snapshot.model, scope.test_params[channel].model);
    assert.equal(snapshot.reasoning_effort, scope.test_params[channel].reasoning_effort);
    const publicResults = await (await get(`/api/provider-results?channel=${channel}`)).json();
    assert.equal(publicResults.groups[0].model, scope.test_params[channel].model);
  }
  assert.doesNotMatch(JSON.stringify(reloaded), /sk-private|key_cipher|key_fingerprint/);
  const legacy = hierarchyInput(reloaded);
  const oldScope = legacy.provider_platforms.find(scope => scope.provider === 'manxue' && scope.id === 'openai');
  delete oldScope.test_params; oldScope.params.model = 'legacy-shared-model'; oldScope.params.reasoning_effort = 'low';
  assert.equal((await send('/api/admin/provider-config', legacy, admin, true, 'PUT')).status, 200);
  const oldPayload = await (await get('/api/admin/provider-config', admin)).json();
  const defaults = oldPayload.hierarchy_platforms.find(scope => scope.provider === 'manxue' && scope.id === 'openai').test_params;
  assert.deepEqual(defaults.candy, { model: 'legacy-shared-model', reasoning_effort: 'low' });
  assert.deepEqual(defaults.pelican, defaults.candy);
  assert.equal(oldPayload.provider_platforms.find(scope => scope.provider === 'manxue' && scope.id === 'openai').test_params, undefined, 'GET does not migrate stored legacy scopes');
});

test('hierarchy group and batch actions queue all enabled tests only in the requested provider, platform and authorized group', async t => {
  const { input, send, get, admin, user, runtime } = await setup(t);
  await send('/api/admin/provider-config', input, admin, true, 'PUT');
  const payload = await (await get('/api/admin/provider-config', admin)).json();
  assert.equal((await send('/api/admin/provider-config', hierarchyInput(payload), admin, true, 'PUT')).status, 200);
  const path = '/api/admin/provider-platforms/manxue/openai/runs';
  assert.equal((await send(path, {}, user)).status, 403);
  assert.equal((await send(path, {}, admin, false)).status, 403);
  for (const body of [[], { model: 'forged' }]) assert.equal((await send(path, body)).status, 400);
  assert.equal((await send('/api/admin/provider-platforms/other/openai/runs', {})).status, 400);
  assert.equal((await send('/api/admin/provider-platforms/manxue/openai/groups/2/runs', {})).status, 404);
  const response = await send(path, {}); assert.equal(response.status, 202);
  const runs = (await response.json()).runs;
  assert.deepEqual(runs.map(run => [run.group_id, run.channel]), [['1', 'candy'], ['1', 'pelican']]);
  assert.equal(runtime.providerStore.counts('2', 'candy').total, 0);
  assert.equal(runtime.providerStore.counts('1', 'testllm').total, 0);
  const again = await send('/api/admin/provider-platforms/manxue/openai/groups/1/runs', {});
  assert.deepEqual((await again.json()).runs.map(run => run.id), runs.map(run => run.id));
  const testllm = await send('/api/admin/provider-platforms/testllm/anthropic/groups/2/runs', {});
  assert.deepEqual((await testllm.json()).runs.map(run => [run.group_id, run.channel]), [['2', 'testllm']]);
});

test('legacy group-only configurations can adopt the hierarchy without filling unused AI platforms or losing explicit overrides', async t => {
  const { input, send, get, admin, runtime } = await setup(t);
  for (const channel of channels) {
    input.channels[channel].defaults.target_url = '';
    input.groups.find(group => group.id === '1' && group.channel === channel).override = {
      ...input.channels[channel].defaults, target_url: 'https://only-group.example.com/v1', model_source: 'default'
    };
    input.groups.find(group => group.id === '2' && group.channel === channel).enabled = false;
  }
  assert.equal((await send('/api/admin/provider-config', input, admin, true, 'PUT')).status, 200);
  const payload = await (await get('/api/admin/provider-config', admin)).json();
  assert(payload.hierarchy_platforms.filter(scope => scope.id === 'openai').every(scope => scope.enabled));
  assert(payload.hierarchy_platforms.filter(scope => scope.id === 'anthropic').every(scope => !scope.enabled));
  assert(payload.groups.find(group => group.id === '1').configurations.candy.hierarchy_override);
  const saved = await send('/api/admin/provider-config', hierarchyInput(payload), admin, true, 'PUT');
  assert.equal(saved.status, 200, await saved.clone().text());
  assert.equal(runtime.providerStore.effective(runtime.providerStore.group('1', 'candy')).target_url, 'https://only-group.example.com/v1');
  assert(runtime.providerStore.group('1', 'candy').override_json, 'an explicit legacy override stays independent even if it matches the suggested shared value');
  assert(runtime.providerStore.enabled(runtime.providerStore.group('1', 'candy')));
  assert.equal(runtime.providerStore.enabled(runtime.providerStore.group('2', 'candy')), false);
});
