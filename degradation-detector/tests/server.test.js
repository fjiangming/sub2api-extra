'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const { artifactMime, createApp, PREVIEW_CSP } = require('../src/server');
const { defaultTests, listen, testConfig } = require('./helpers');

class FakeSub2Api {
  constructor() {
    this.tokenARole = 'admin';
  }

  async verifyUser(token) {
    return {
      id: token === 'token-c' ? 'user-c' : token === 'token-b' ? 'user-b' : 'user-a',
      name: token === 'token-c' ? 'User C' : token === 'token-b' ? 'User B' : 'User A',
      email: '',
      role: token === 'token-a' ? this.tokenARole : 'user'
    };
  }

  async listAvailableGroups(token) {
    if (token === 'token-c') {
      return [{ id: '9', name: 'Other OpenAI Group', platform: 'openai', status: 'active' }];
    }
    return [
      { id: '1', name: 'OpenAI Group', platform: 'openai', status: 'active' },
      { id: '3', name: 'Second OpenAI Group', platform: 'openai', status: 'active' },
      { id: '2', name: 'Other Platform Group', platform: 'other', status: 'active' }
    ];
  }
}

async function session(baseUrl, token) {
  const response = await fetch(`${baseUrl}/api/auth/sso`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}'
  });
  assert.equal(response.status, 200);
  return response.json();
}

function headers(auth, csrf = '') {
  return {
    authorization: `Session ${auth.sessionToken}`,
    ...(csrf ? { 'x-csrf-token': csrf } : {}),
    'content-type': 'application/json'
  };
}

function configuration(groups, scheduleTime = '07:45') {
  return {
    schedule_time: scheduleTime,
    platforms: [{
      id: 'openai',
      enabled: true,
      test: defaultTests.openai,
      groups
    }]
  };
}

test('admin configuration and shared results enforce role, CSRF, group, and preview boundaries', async (t) => {
  const config = testConfig(t);
  const runner = { execute: async () => null };
  const sub2api = new FakeSub2Api();
  const { app, runtime } = createApp(config, { sub2api, runner, startScheduler: false });
  const http = await listen(app);
  t.after(async () => {
    await http.close();
    await runtime.scheduler.close();
    runtime.auth.close();
    runtime.store.close();
  });

  const authA = await session(http.baseUrl, 'token-a');
  const authB = await session(http.baseUrl, 'token-b');
  const authC = await session(http.baseUrl, 'token-c');
  assert.equal(authA.canOperate, true);
  assert.equal(authB.canOperate, false);

  const resultsPage = await fetch(`${http.baseUrl}/results`);
  assert.equal(resultsPage.status, 200);
  const resultsPageHtml = await resultsPage.text();
  assert.match(resultsPageHtml, /降智检测/);
  assert.doesNotMatch(resultsPageHtml, /admin\/config|run-button|立即检测/);

  const anonymousPage = await fetch(`${http.baseUrl}/admin/config`);
  assert.equal(anonymousPage.status, 401);
  const directAdminEntry = await fetch(`${http.baseUrl}/admin/config?token=token-a&theme=dark`, {
    redirect: 'manual'
  });
  assert.equal(directAdminEntry.status, 303);
  assert.equal(directAdminEntry.headers.get('location'), '/admin/config?theme=dark');
  assert.match(directAdminEntry.headers.get('set-cookie'), /dd_session=/);
  const directReadOnlyEntry = await fetch(`${http.baseUrl}/admin/config?token=token-b`, {
    redirect: 'manual'
  });
  assert.equal(directReadOnlyEntry.status, 403);
  assert.equal(directReadOnlyEntry.headers.get('set-cookie'), null);
  assert.equal((await directReadOnlyEntry.json()).error.code, 'ADMIN_REQUIRED');
  const readOnlyPage = await fetch(`${http.baseUrl}/admin/config`, { headers: headers(authB) });
  assert.equal(readOnlyPage.status, 403);
  const readOnlyAsset = await fetch(`${http.baseUrl}/admin/config.js`, { headers: headers(authB) });
  assert.equal(readOnlyAsset.status, 403);
  const readOnlyStyles = await fetch(`${http.baseUrl}/admin/config.css`, { headers: headers(authB) });
  assert.equal(readOnlyStyles.status, 403);
  const readOnlyConfig = await fetch(`${http.baseUrl}/api/admin/config`, { headers: headers(authB) });
  assert.equal(readOnlyConfig.status, 403);
  const readOnlyWrite = await fetch(`${http.baseUrl}/api/admin/config`, {
    method: 'PUT',
    headers: headers(authB, authB.csrfToken),
    body: JSON.stringify(configuration([]))
  });
  assert.equal(readOnlyWrite.status, 403);

  const adminPage = await fetch(`${http.baseUrl}/admin/config`, { headers: headers(authA) });
  assert.equal(adminPage.status, 200);
  assert.match(adminPage.headers.get('cache-control'), /no-store/);
  assert.match(await adminPage.text(), /降智检测配置/);

  const initialConfigResponse = await fetch(`${http.baseUrl}/api/admin/config`, { headers: headers(authA) });
  assert.equal(initialConfigResponse.status, 200);
  const initialConfig = await initialConfigResponse.json();
  assert.deepEqual(initialConfig.platforms.map((platform) => platform.id), ['openai', 'other']);
  assert.deepEqual(initialConfig.platforms[0].groups.map((group) => group.id), ['1', '3']);
  assert.doesNotMatch(JSON.stringify(initialConfig), /key_cipher|key_fingerprint|sk-/i);

  const missingCsrf = await fetch(`${http.baseUrl}/api/admin/config`, {
    method: 'PUT',
    headers: headers(authA),
    body: JSON.stringify(configuration([]))
  });
  assert.equal(missingCsrf.status, 403);
  assert.equal((await missingCsrf.json()).error.code, 'CSRF_INVALID');

  const forgedGroup = await fetch(`${http.baseUrl}/api/admin/config`, {
    method: 'PUT',
    headers: headers(authA, authA.csrfToken),
    body: JSON.stringify(configuration([
      { id: '999', enabled: true, key: 'sk-forged-dedicated-key-1234567890' }
    ]))
  });
  assert.equal(forgedGroup.status, 400);
  assert.equal((await forgedGroup.json()).error.code, 'GROUP_NOT_AVAILABLE');

  const duplicatedKey = 'sk-duplicate-dedicated-key-1234567890';
  const duplicateResponse = await fetch(`${http.baseUrl}/api/admin/config`, {
    method: 'PUT',
    headers: headers(authA, authA.csrfToken),
    body: JSON.stringify(configuration([
      { id: '1', enabled: true, key: duplicatedKey },
      { id: '3', enabled: true, key: duplicatedKey }
    ]))
  });
  assert.equal(duplicateResponse.status, 400);
  assert.equal((await duplicateResponse.json()).error.code, 'DETECTION_KEY_DUPLICATED');

  const dedicatedKey = 'sk-service-group-1-1234567890';
  const savedResponse = await fetch(`${http.baseUrl}/api/admin/config`, {
    method: 'PUT',
    headers: headers(authA, authA.csrfToken),
    body: JSON.stringify(configuration([
      { id: '1', enabled: true, key: dedicatedKey },
      { id: '3', enabled: false, key: '' }
    ]))
  });
  assert.equal(savedResponse.status, 200);
  const saved = await savedResponse.json();
  assert.equal(saved.schedule_time, '07:45');
  assert.equal(saved.platforms[0].groups[0].key_configured, true);
  assert.equal(saved.platforms[0].groups[0].enabled, true);
  assert.doesNotMatch(JSON.stringify(saved), new RegExp(dedicatedKey));

  const storedMonitor = runtime.store.getMonitor(config.serviceOwnerId, '1');
  assert.match(storedMonitor.key_cipher, /^v1\./);
  assert.notEqual(storedMonitor.key_cipher, dedicatedKey);
  assert.notEqual(storedMonitor.key_fingerprint, dedicatedKey);
  assert.equal(runtime.vault.decrypt('1', storedMonitor.key_cipher), dedicatedKey);
  assert.equal(runtime.store.getMonitor(config.serviceOwnerId, '3'), null);

  const resultsResponse = await fetch(`${http.baseUrl}/api/results`, { headers: headers(authA) });
  assert.equal(resultsResponse.status, 200);
  const results = await resultsResponse.json();
  assert.deepEqual(results.groups.map((group) => group.id), ['1']);
  assert.deepEqual(results.platforms.map((platform) => platform.id), ['openai']);
  assert.equal(results.schedule_time, '07:45');
  assert.equal('can_operate' in results, false);
  assert.equal('key_configured' in results.groups[0], false);
  assert.equal('monitor_id' in results.groups[0], false);

  const readOnlyResults = await fetch(`${http.baseUrl}/api/results`, { headers: headers(authB) });
  assert.equal(readOnlyResults.status, 200);
  assert.deepEqual((await readOnlyResults.json()).groups.map((group) => group.id), ['1']);

  const readOnlyRun = await fetch(`${http.baseUrl}/api/admin/groups/1/runs`, {
    method: 'POST', headers: headers(authB, authB.csrfToken), body: '{}'
  });
  assert.equal(readOnlyRun.status, 403);
  assert.equal((await readOnlyRun.json()).error.code, 'ADMIN_REQUIRED');

  sub2api.tokenARole = 'user';
  const demotedConfig = await fetch(`${http.baseUrl}/api/admin/config`, { headers: headers(authA) });
  assert.equal(demotedConfig.status, 403);
  const demotedRun = await fetch(`${http.baseUrl}/api/admin/groups/1/runs`, {
    method: 'POST', headers: headers(authA, authA.csrfToken), body: '{}'
  });
  assert.equal(demotedRun.status, 403);
  sub2api.tokenARole = 'admin';

  const missingRunCsrf = await fetch(`${http.baseUrl}/api/admin/groups/1/runs`, {
    method: 'POST', headers: headers(authA), body: '{}'
  });
  assert.equal(missingRunCsrf.status, 403);
  assert.equal((await missingRunCsrf.json()).error.code, 'CSRF_INVALID');
  const unselectedRun = await fetch(`${http.baseUrl}/api/admin/groups/3/runs`, {
    method: 'POST', headers: headers(authA, authA.csrfToken), body: '{}'
  });
  assert.equal(unselectedRun.status, 404);

  const removedPublicRun = await fetch(`${http.baseUrl}/api/groups/1/runs`, {
    method: 'POST', headers: headers(authA, authA.csrfToken), body: '{}'
  });
  assert.equal(removedPublicRun.status, 404);

  const accepted = await fetch(`${http.baseUrl}/api/admin/groups/1/runs`, {
    method: 'POST', headers: headers(authA, authA.csrfToken), body: '{}'
  });
  assert.equal(accepted.status, 202);
  assert.equal(runtime.store.getMonitor('user-a', '1'), null);

  const monitor = runtime.store.getMonitor(config.serviceOwnerId, '1');
  const sharedRun = runtime.store.createRun(monitor, runtime.store.getPlatformTest('openai'), 'test');
  runtime.store.markRunRunning(sharedRun.id);
  runtime.store.completeRun(sharedRun.id, {
    status: 'normal',
    quality: 'normal',
    reason: 'ok',
    source: 'test',
    outputText: '<!doctype html><html><body>shared</body></html>',
    artifactMime: 'text/html',
    previewToken: 'preview_token_for_service_123456'
  }, runtime.store.nextScheduledAt());

  const sharedDetail = await fetch(`${http.baseUrl}/api/results/${sharedRun.id}`, { headers: headers(authB) });
  assert.equal(sharedDetail.status, 200);
  assert.equal((await sharedDetail.json()).preview_url, '/api/previews/preview_token_for_service_123456');
  const forbiddenDetail = await fetch(`${http.baseUrl}/api/results/${sharedRun.id}`, { headers: headers(authC) });
  assert.equal(forbiddenDetail.status, 404);
  const anonymousPreview = await fetch(`${http.baseUrl}/api/previews/preview_token_for_service_123456`);
  assert.equal(anonymousPreview.status, 401);
  const forbiddenPreview = await fetch(`${http.baseUrl}/api/previews/preview_token_for_service_123456`, { headers: headers(authC) });
  assert.equal(forbiddenPreview.status, 404);
  const preview = await fetch(`${http.baseUrl}/api/previews/preview_token_for_service_123456`, { headers: headers(authB) });
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('content-security-policy'), PREVIEW_CSP);
  assert.match(await preview.text(), /<body>shared<\/body>/);

  const disabledResponse = await fetch(`${http.baseUrl}/api/admin/config`, {
    method: 'PUT',
    headers: headers(authA, authA.csrfToken),
    body: JSON.stringify(configuration([{ id: '1', enabled: false, key: '' }]))
  });
  assert.equal(disabledResponse.status, 200);
  assert.equal(runtime.store.getMonitor(config.serviceOwnerId, '1').key_cipher, null);
  const revokedPreview = await fetch(`${http.baseUrl}/api/previews/preview_token_for_service_123456`, { headers: headers(authB) });
  assert.equal(revokedPreview.status, 404);
});

test('frontends keep authentication and administrator controls separated', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const adminSource = fs.readFileSync(path.join(__dirname, '..', 'admin', 'app.js'), 'utf8');
  assert.match(mainSource, /params\.get\('token'\) \|\| params\.get\('access_token'\)/);
  assert.match(mainSource, /\['token', 'access_token'\]/);
  assert.match(mainSource, /state\.sessionToken && !headers\.Authorization/);
  assert.doesNotMatch(mainSource, /canOperate|csrfToken|config-button|run-button|立即检测|\/api\/admin/);
  assert.doesNotMatch(mainSource, /\/monitor|monitor-toggle|打开即/);
  assert.match(adminSource, /session\.canOperate !== true/);
  assert.match(adminSource, /api\('\/api\/admin\/config'/);
  assert.match(adminSource, /\/api\/admin\/groups\/\$\{encodeURIComponent\(groupId\)\}\/runs/);
  assert.match(adminSource, /'X-CSRF-Token'/);
  assert.doesNotMatch(adminSource, /key_cipher|key_fingerprint/);
});

test('artifact MIME values are normalized before being used as response headers', () => {
  assert.equal(artifactMime('Image/PNG; charset=binary'), 'image/png');
  assert.equal(artifactMime('text/html\r\nx-unsafe: yes'), 'application/octet-stream');
});
