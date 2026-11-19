'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/server');
const { defaultConfiguration, channels } = require('../src/provider-config');
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
  const saved = await send('/api/admin/provider-config', input, admin, true, 'PUT');
  assert.equal(saved.status, 200, await saved.clone().text());
  const payload = await saved.json();
  assert.equal(payload.revision, 1);
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
