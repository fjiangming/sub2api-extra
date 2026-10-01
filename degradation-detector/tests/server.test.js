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

function configuration(groups, scheduleTime = '07:45', testOverrides = {}) {
  return {
    schedule_mode: 'daily',
    schedule_times: [scheduleTime, '19:15'],
    schedule_interval_minutes: 90,
    platforms: [{
      id: 'openai',
      enabled: true,
      test: { ...defaultTests.openai, ...testOverrides },
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
  assert.match(resultsPage.headers.get('content-security-policy'), /frame-src 'self'/);
  assert.match(resultsPage.headers.get('content-security-policy'), /media-src 'self' blob:/);
  const resultsPageHtml = await resultsPage.text();
  assert.match(resultsPageHtml, /降智检测/);
  assert.doesNotMatch(resultsPageHtml, /admin\/config|run-button|立即检测/);
  const publicAssetVersion = resultsPageHtml.match(/\/styles\.css\?v=([a-f0-9]{12})/)?.[1];
  assert.ok(publicAssetVersion);
  assert.match(resultsPageHtml, new RegExp(`/app\\.js\\?v=${publicAssetVersion}`));

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
  const adminPageHtml = await adminPage.text();
  assert.match(adminPageHtml, /降智检测配置/);
  assert.match(adminPageHtml, new RegExp(`/styles\\.css\\?v=${publicAssetVersion}`));
  assert.match(adminPageHtml, new RegExp(`/admin/config\\.css\\?v=${publicAssetVersion}`));
  assert.match(adminPageHtml, new RegExp(`/admin/config\\.js\\?v=${publicAssetVersion}`));

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
  const validation = structuredClone(initialConfig.platforms[0].test.validation);
  validation.svg_math = { enabled: true, samples: 12, pass_ratio: 0.9 };
  validation.rules.push({
    id: 'foot_contact', label: '脚踏接触', type: 'svg_geometry', severity: 'hard', weight: 20,
    geometry_operation: 'distance_lte', source_selector: '#left-foot', target_selector: '#left-pedal',
    geometry_threshold_basis: 'viewbox_min', geometry_threshold: 0.01, case_sensitive: false
  });
  const groupTest = structuredClone(initialConfig.platforms[0].test);
  groupTest.label = 'OpenAI 独立分组';
  groupTest.model = 'gpt-group-specific';
  groupTest.prompt = 'group-specific prompt';
  groupTest.reasoning_effort = 'max';
  const savedResponse = await fetch(`${http.baseUrl}/api/admin/config`, {
    method: 'PUT',
    headers: headers(authA, authA.csrfToken),
    body: JSON.stringify(configuration([
      { id: '1', enabled: true, key: dedicatedKey, test: groupTest },
      { id: '3', enabled: false, key: '' }
    ], '07:45', { reasoning_effort: 'xhigh', validation }))
  });
  assert.equal(savedResponse.status, 200);
  const saved = await savedResponse.json();
  assert.equal(saved.schedule_time, '07:45');
  assert.equal(saved.schedule_mode, 'daily');
  assert.deepEqual(saved.schedule_times, ['07:45', '19:15']);
  assert.equal(saved.schedule_interval_minutes, 90);
  assert.equal(saved.platforms[0].groups[0].key_configured, true);
  assert.equal(saved.platforms[0].groups[0].enabled, true);
  assert.equal(saved.platforms[0].groups[0].test.model, 'gpt-group-specific');
  assert.equal(saved.platforms[0].groups[0].test.reasoning_effort, 'max');
  assert.deepEqual(saved.platforms[0].test.validation.svg_math, {
    enabled: true, samples: 12, pass_ratio: 0.9
  });
  assert.equal(saved.platforms[0].test.validation.rules.at(-1).type, 'svg_geometry');
  assert.equal(runtime.store.getPlatformTest('openai').validation.rules.at(-1).geometry_threshold_basis, 'viewbox_min');
  assert.equal(runtime.store.getPlatformTest('openai').validation.rules.at(-1).geometry_threshold, 0.01);
  assert.doesNotMatch(JSON.stringify(saved), new RegExp(dedicatedKey));

  const storedMonitor = runtime.store.getMonitor(config.serviceOwnerId, '1');
  assert.match(storedMonitor.key_cipher, /^v1\./);
  assert.notEqual(storedMonitor.key_cipher, dedicatedKey);
  assert.notEqual(storedMonitor.key_fingerprint, dedicatedKey);
  assert.equal(runtime.vault.decrypt('1', storedMonitor.key_cipher), dedicatedKey);
  assert.equal(runtime.store.getMonitorTest(storedMonitor).model, 'gpt-group-specific');
  assert.equal(runtime.store.getMonitor(config.serviceOwnerId, '3').enabled, 0);

  const resultsResponse = await fetch(`${http.baseUrl}/api/results`, { headers: headers(authA) });
  assert.equal(resultsResponse.status, 200);
  const results = await resultsResponse.json();
  assert.deepEqual(results.groups.map((group) => group.id), ['1']);
  assert.deepEqual(results.platforms.map((platform) => platform.id), ['openai']);
  assert.equal(results.schedule_time, '07:45');
  assert.equal(results.schedule_mode, 'daily');
  assert.deepEqual(results.schedule_times, ['07:45', '19:15']);
  assert.equal(results.schedule_interval_minutes, 90);
  assert.equal(results.groups[0].model, 'gpt-group-specific');
  assert.equal(results.groups[0].reasoning_effort, 'max');
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
  assert.equal((await accepted.json()).model, 'gpt-group-specific');
  assert.equal(runtime.store.getMonitor('user-a', '1'), null);

  const monitor = runtime.store.getMonitor(config.serviceOwnerId, '1');
  const sharedTest = {
    ...runtime.store.getPlatformTest('openai'),
    prompt: 'private prompt must never be returned',
    validation: {
      version: 2,
      normal_threshold: 90,
      degraded_threshold: 50,
      svg_math: { enabled: true, samples: 12, pass_ratio: 0.9 },
      confirmation: { window: 3, required_failures: 2, recovery_passes: 2 },
      rules: [{
        id: 'private_rule',
        label: '公开规则名称',
        type: 'contains',
        severity: 'hard',
        weight: 100,
        value: 'private rule value must never be returned',
        case_sensitive: false
      }, {
        id: 'private_geometry',
        label: '脚踏接触证据',
        type: 'svg_geometry',
        severity: 'hard',
        weight: 100,
        geometry_operation: 'distance_lte',
        source_selector: '#private-foot-selector',
        target_selector: '#private-pedal-selector',
        geometry_threshold: 2,
        case_sensitive: false
      }]
    }
  };
  const sharedRun = runtime.store.createRun(monitor, sharedTest, 'test');
  runtime.store.markRunRunning(sharedRun.id);
  runtime.store.completeRun(sharedRun.id, {
    status: 'normal',
    quality: 'normal',
    score: 100,
    reason: 'ok',
    source: 'test',
    validationResult: {
      version: 2,
      score: 100,
      passed: 1,
      total: 2,
      hard_failures: 0,
      indeterminate: 1,
      integrity_failures: [],
      results: [{
        id: 'private_rule',
        label: '公开规则名称',
        type: 'contains',
        severity: 'hard',
        weight: 100,
        passed: true,
        message: '已包含预期文本'
      }, {
        id: 'private_geometry',
        label: '脚踏接触证据',
        type: 'svg_geometry',
        severity: 'hard',
        weight: 100,
        passed: false,
        indeterminate: true,
        message: '检测到不支持的动画，无法计算'
      }]
    },
    outputText: '<!doctype html><html><body>shared</body></html>',
    artifactMime: 'text/html',
    previewToken: 'preview_token_for_service_123456'
  }, runtime.store.nextScheduledAt());

  const sharedDetail = await fetch(`${http.baseUrl}/api/results/${sharedRun.id}`, {
    headers: { ...headers(authB), 'x-preview-ancestors': '["https://aihub.example.test"]' }
  });
  assert.equal(sharedDetail.status, 200);
  const sharedPayload = await sharedDetail.json();
  assert.equal(sharedPayload.reasoning_effort, 'xhigh');
  assert.equal(sharedPayload.html, '<!doctype html><html><body>shared</body></html>');
  assert.equal(sharedPayload.validation.score, 100);
  assert.equal(sharedPayload.validation.indeterminate, 1);
  assert.equal(sharedPayload.validation.rules[0].label, '公开规则名称');
  assert.equal(sharedPayload.validation.rules[1].indeterminate, true);
  assert.equal('test_snapshot' in sharedPayload, false);
  assert.equal('validation_snapshot' in sharedPayload, false);
  assert.doesNotMatch(JSON.stringify(sharedPayload), /private prompt|private rule value|private-foot-selector|private-pedal-selector/);
  assert.match(sharedPayload.preview_url, /^\/api\/previews\/preview_token_for_service_123456\?ancestors=.+&signature=.+/);
  const forbiddenDetail = await fetch(`${http.baseUrl}/api/results/${sharedRun.id}`, { headers: headers(authC) });
  assert.equal(forbiddenDetail.status, 404);
  const anonymousPreview = await fetch(`${http.baseUrl}/api/previews/preview_token_for_service_123456`);
  assert.equal(anonymousPreview.status, 401);
  const forbiddenPreview = await fetch(`${http.baseUrl}/api/previews/preview_token_for_service_123456`, { headers: headers(authC) });
  assert.equal(forbiddenPreview.status, 404);
  const preview = await fetch(`${http.baseUrl}/api/previews/preview_token_for_service_123456`, { headers: headers(authB) });
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('content-security-policy'), PREVIEW_CSP);
  assert.match(PREVIEW_CSP, /frame-ancestors 'self'/);
  assert.match(await preview.text(), /<body>shared<\/body>/);
  const embeddedPreview = await fetch(`${http.baseUrl}${sharedPayload.preview_url}`, { headers: headers(authB) });
  assert.equal(embeddedPreview.status, 200);
  assert.match(
    embeddedPreview.headers.get('content-security-policy'),
    /frame-ancestors 'self' https:\/\/aihub\.example\.test/
  );
  const crossSessionPreview = await fetch(`${http.baseUrl}${sharedPayload.preview_url}`, { headers: headers(authA) });
  assert.equal(crossSessionPreview.status, 404);
  const tamperedPreviewUrl = sharedPayload.preview_url.replace('ancestors=', 'ancestors=e30');
  const tamperedPreview = await fetch(`${http.baseUrl}${tamperedPreviewUrl}`, { headers: headers(authB) });
  assert.equal(tamperedPreview.status, 404);

  fs.mkdirSync(config.artifactDir, { recursive: true });
  const artifactPath = path.join(config.artifactDir, 'shared-result.txt');
  fs.writeFileSync(artifactPath, 'shared artifact', 'utf8');
  const artifactRun = runtime.store.createRun(monitor, {
    ...runtime.store.getPlatformTest('openai'),
    output_type: 'file'
  }, 'test');
  runtime.store.markRunRunning(artifactRun.id);
  runtime.store.completeRun(artifactRun.id, {
    status: 'normal',
    quality: 'normal',
    reason: 'ok',
    source: 'test',
    artifactPath,
    artifactName: 'shared-result.txt',
    artifactMime: 'text/plain',
    previewToken: 'artifact_token_for_service_12345'
  }, runtime.store.nextScheduledAt());

  const artifactDetail = await fetch(`${http.baseUrl}/api/results/${artifactRun.id}`, { headers: headers(authB) });
  assert.equal(artifactDetail.status, 200);
  const artifactPayload = await artifactDetail.json();
  assert.equal(artifactPayload.artifact.content_url, '/api/artifacts/artifact_token_for_service_12345');
  assert.equal(artifactPayload.artifact.download_url, '/api/artifacts/artifact_token_for_service_12345?download=1');
  const anonymousArtifact = await fetch(`${http.baseUrl}${artifactPayload.artifact.content_url}`);
  assert.equal(anonymousArtifact.status, 401);
  const forbiddenArtifact = await fetch(`${http.baseUrl}${artifactPayload.artifact.content_url}`, { headers: headers(authC) });
  assert.equal(forbiddenArtifact.status, 404);
  const artifact = await fetch(`${http.baseUrl}${artifactPayload.artifact.content_url}`, { headers: headers(authB) });
  assert.equal(artifact.status, 200);
  assert.equal(artifact.headers.get('content-type'), 'text/plain');
  assert.equal(await artifact.text(), 'shared artifact');

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
  const mainHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const mainStyles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const adminSource = fs.readFileSync(path.join(__dirname, '..', 'admin', 'app.js'), 'utf8');
  const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'admin', 'index.html'), 'utf8');
  const adminStyles = fs.readFileSync(path.join(__dirname, '..', 'admin', 'styles.css'), 'utf8');
  assert.match(mainSource, /params\.get\('token'\) \|\| params\.get\('access_token'\)/);
  assert.match(mainSource, /\['token', 'access_token'\]/);
  assert.match(mainSource, /state\.sessionToken && !headers\.Authorization/);
  assert.match(mainHtml, /class="capability-note" role="note"/);
  assert.match(mainHtml, /疑似降智 ≠ 不可用：多数日常任务仍可胜任，本检测主要为对模型能力上限要求较高的用户提供参考。/);
  assert.match(mainStyles, /\.capability-note\s*\{/);
  assert.match(mainSource, /URL\.createObjectURL/);
  assert.match(mainSource, /window\.location\.ancestorOrigins/);
  assert.match(mainSource, /X-Preview-Ancestors/);
  assert.match(mainSource, /createPreviewFrame\(detail\.preview_url, title, 'allow-scripts'\)/);
  assert.match(mainSource, /detail\.artifact\.content_url/);
  assert.doesNotMatch(mainSource, /frame\.src = detail\.preview_url/);
  assert.doesNotMatch(mainSource, /canOperate|csrfToken|config-button|run-button|立即检测|\/api\/admin/);
  assert.doesNotMatch(mainSource, /\/monitor|monitor-toggle|打开即/);
  assert.match(adminSource, /session\.canOperate !== true/);
  assert.match(adminSource, /api\('\/api\/admin\/config'/);
  assert.match(adminSource, /\/api\/admin\/groups\/\$\{encodeURIComponent\(groupId\)\}\/runs/);
  assert.match(adminSource, /'X-CSRF-Token'/);
  assert.match(adminSource, /method: 'DELETE'/);
  assert.match(adminSource, /run_ids: ids/);
  assert.match(mainSource, /reasoningLabel\(group\.reasoning_effort, '默认'\)/);
  assert.match(mainSource, /recorded && recorded !== 'none' \? recorded : group\?\.reasoning_effort/);
  assert.match(mainSource, /resultReasoningLabel\(run\)/);
  assert.match(mainSource, /run\.review\?\.reviewed_at/);
  assert.match(mainSource, /<details class="validation-evidence">/);
  assert.doesNotMatch(mainSource, /<details class="validation-evidence"\s+open/);
  assert.match(mainSource, /规则判定为正常；单次结果不能证明模型身份或整体能力/);
  assert.match(mainSource, /controls\.classList\.add\('yzai-pelican-controls--html'\)/);
  assert.match(mainStyles, /\.yzai-pelican-controls--html\s*\{[^}]*position: absolute;/s);
  assert.match(mainStyles, /\.yzai-pelican-frame\s*\{[^}]*height: clamp\(420px, calc\(64dvh - 12px\), 668px\);/s);
  assert.match(adminSource, /svg_geometry: 'SVG 数学关系'/);
  assert.match(adminSource, /data-svg-math="enabled"/);
  assert.match(adminSource, /geometry_threshold/);
  assert.match(adminSource, /geometry_threshold_basis/);
  assert.match(adminSource, /geometryTargetOperations/);
  assert.match(adminSource, /target\.required = needsTarget/);
  assert.match(adminHtml, /id="group-config-dialog"/);
  assert.match(adminSource, /group\.test = collectTest/);
  assert.match(adminHtml, /恢复平台默认/);
  assert.match(adminStyles, /\.group-config-modal/);
  assert.doesNotMatch(mainSource, /reasoningLabel\(run\.reasoning_effort\)/);
  assert.doesNotMatch(mainSource, /未记录/);
  assert.match(mainSource, /const HISTORY_CHART_LENGTH = 60/);
  assert.match(mainSource, /<span>PAST \$\{group\.history\.length \|\| 0\} RESULTS<\/span><span>NOW<\/span>/);
  assert.match(mainStyles, /\.history-chart\s*\{[^}]*display: flex;[^}]*gap: 2px;[^}]*height: 33px;/s);
  assert.match(mainStyles, /\.history-point\[data-status="normal"\]\s*\{[^}]*height: 100%;[^}]*background: #10b981;/s);
  assert.match(mainSource, /validation\?\.score_min/);
  assert.match(mainSource, /可计算覆盖率/);
  assert.match(mainStyles, /\.dark \.history-point\[data-status="empty"\]\s*\{[^}]*background: #475569;/s);
  assert.doesNotMatch(mainStyles, /\.dark \.history-point\s*\{/);
  assert.match(adminHtml, /id="history-dialog"/);
  assert.match(adminHtml, /id="history-delete-selected"/);
  assert.match(adminHtml, /id="history-clear-all"/);
  assert.match(adminHtml, /id="review-dialog"/);
  assert.match(adminHtml, /id="review-reason"/);
  assert.match(adminSource, /method: 'PATCH'/);
  assert.match(adminSource, /\/runs\/\$\{state\.reviewRunId\}\/review/);
  assert.match(mainSource, /人工复核结论/);
  assert.match(adminStyles, /\.review-status-options\s*\{[^}]*grid-template-columns: repeat\(3,/s);
  assert.match(adminStyles, /@media \(max-width: 430px\)[\s\S]*\.review-status-options \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.doesNotMatch(adminSource, /key_cipher|key_fingerprint/);
});

test('administrators can delete selected or all completed group history without crossing boundaries', async (t) => {
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

  const admin = await session(http.baseUrl, 'token-a');
  const ordinary = await session(http.baseUrl, 'token-b');
  const saved = await fetch(`${http.baseUrl}/api/admin/config`, {
    method: 'PUT',
    headers: headers(admin, admin.csrfToken),
    body: JSON.stringify(configuration([{
      id: '1', enabled: true, key: 'sk-history-dedicated-12345678901234567890'
    }]))
  });
  assert.equal(saved.status, 200);
  const monitor = runtime.store.getMonitor(config.serviceOwnerId, '1');
  const testCase = runtime.store.getPlatformTest('openai');
  const artifactPath = path.join(config.artifactDir, 'history-api-result.txt');
  fs.writeFileSync(artifactPath, 'history artifact', 'utf8');

  const artifactRun = runtime.store.createRun(monitor, testCase, 'manual');
  runtime.store.markRunRunning(artifactRun.id);
  runtime.store.completeRun(artifactRun.id, {
    status: 'normal', quality: 'normal', reason: 'artifact result', source: 'test',
    artifactPath, artifactName: 'history-api-result.txt', artifactMime: 'text/plain',
    previewToken: 'history_artifact_preview_token_12345'
  }, runtime.store.nextScheduledAt());
  const textRun = runtime.store.createRun(monitor, testCase, 'scheduled');
  runtime.store.markRunRunning(textRun.id);
  runtime.store.completeRun(textRun.id, {
    status: 'degraded', quality: 'degraded', reason: 'text result', source: 'test', outputText: 'text'
  }, runtime.store.nextScheduledAt());

  const ordinaryList = await fetch(`${http.baseUrl}/api/admin/groups/1/runs`, { headers: headers(ordinary) });
  assert.equal(ordinaryList.status, 403);
  const missingCsrf = await fetch(`${http.baseUrl}/api/admin/groups/1/runs`, {
    method: 'DELETE', headers: headers(admin), body: JSON.stringify({ run_ids: [artifactRun.id] })
  });
  assert.equal(missingCsrf.status, 403);
  const ambiguousDelete = await fetch(`${http.baseUrl}/api/admin/groups/1/runs`, {
    method: 'DELETE',
    headers: headers(admin, admin.csrfToken),
    body: JSON.stringify({ all: true, run_ids: [artifactRun.id] })
  });
  assert.equal(ambiguousDelete.status, 400);
  assert.ok(runtime.store.getRun(artifactRun.id));
  const list = await fetch(`${http.baseUrl}/api/admin/groups/1/runs?limit=1`, { headers: headers(admin) });
  assert.equal(list.status, 200);
  const firstPage = await list.json();
  assert.equal(firstPage.total, 2);
  assert.equal(firstPage.deletable_count, 2);
  assert.equal(firstPage.runs.length, 1);
  assert.equal(firstPage.next_cursor, textRun.id);

  const crossGroup = await fetch(`${http.baseUrl}/api/admin/groups/3/runs`, {
    method: 'DELETE',
    headers: headers(admin, admin.csrfToken),
    body: JSON.stringify({ run_ids: [artifactRun.id] })
  });
  assert.equal(crossGroup.status, 404);
  assert.ok(runtime.store.getRun(artifactRun.id));

  const selected = await fetch(`${http.baseUrl}/api/admin/groups/1/runs`, {
    method: 'DELETE',
    headers: headers(admin, admin.csrfToken),
    body: JSON.stringify({ run_ids: [artifactRun.id] })
  });
  assert.equal(selected.status, 200);
  assert.equal((await selected.json()).deleted, 1);
  assert.equal(runtime.store.getRun(artifactRun.id), null);
  assert.equal(fs.existsSync(artifactPath), false);
  const revokedPreview = await fetch(`${http.baseUrl}/api/previews/history_artifact_preview_token_12345`, {
    headers: headers(admin)
  });
  assert.equal(revokedPreview.status, 404);

  const active = runtime.store.createRun(monitor, testCase, 'manual');
  const activeDelete = await fetch(`${http.baseUrl}/api/admin/groups/1/runs`, {
    method: 'DELETE',
    headers: headers(admin, admin.csrfToken),
    body: JSON.stringify({ run_ids: [active.id] })
  });
  assert.equal(activeDelete.status, 409);
  const clearAll = await fetch(`${http.baseUrl}/api/admin/groups/1/runs`, {
    method: 'DELETE',
    headers: headers(admin, admin.csrfToken),
    body: JSON.stringify({ all: true })
  });
  assert.equal(clearAll.status, 200);
  const cleared = await clearAll.json();
  assert.equal(cleared.deleted, 1);
  assert.equal(cleared.total, 1);
  assert.equal(cleared.deletable_count, 0);
  assert.equal(runtime.store.getRun(textRun.id), null);
  assert.ok(runtime.store.getRun(active.id));

  const publicResults = await fetch(`${http.baseUrl}/api/results`, { headers: headers(admin) });
  const group = (await publicResults.json()).groups.find((item) => item.id === '1');
  assert.deepEqual(group.totals, { passed: 0, valid: 0, attempts: 0 });
  assert.equal(group.history.length, 1);
  assert.equal(group.history[0].status, 'queued');
});

test('only administrators can review completed verdicts within their group boundary', async (t) => {
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

  const admin = await session(http.baseUrl, 'token-a');
  const ordinary = await session(http.baseUrl, 'token-b');
  const saved = await fetch(`${http.baseUrl}/api/admin/config`, {
    method: 'PUT',
    headers: headers(admin, admin.csrfToken),
    body: JSON.stringify(configuration([{
      id: '1', enabled: true, key: 'sk-review-dedicated-12345678901234567890'
    }]))
  });
  assert.equal(saved.status, 200);
  const monitor = runtime.store.getMonitor(config.serviceOwnerId, '1');
  const testCase = runtime.store.getPlatformTest('openai');
  const run = runtime.store.createRun(monitor, testCase, 'manual');
  runtime.store.markRunRunning(run.id);
  runtime.store.completeRun(run.id, {
    status: 'degraded', quality: 'degraded', reason: 'automatic verdict', source: 'test',
    outputText: '<!doctype html><html><body>review me</body></html>', artifactMime: 'text/html'
  }, runtime.store.nextScheduledAt());
  const endpoint = `${http.baseUrl}/api/admin/groups/1/runs/${run.id}/review`;

  const ordinaryReview = await fetch(endpoint, {
    method: 'PATCH', headers: headers(ordinary, ordinary.csrfToken),
    body: JSON.stringify({ status: 'normal', reason: '普通用户越权尝试' })
  });
  assert.equal(ordinaryReview.status, 403);
  const missingCsrf = await fetch(endpoint, {
    method: 'PATCH', headers: headers(admin),
    body: JSON.stringify({ status: 'normal', reason: '缺少 CSRF' })
  });
  assert.equal(missingCsrf.status, 403);
  const crossGroup = await fetch(`${http.baseUrl}/api/admin/groups/3/runs/${run.id}/review`, {
    method: 'PATCH', headers: headers(admin, admin.csrfToken),
    body: JSON.stringify({ status: 'normal', reason: '跨分组尝试' })
  });
  assert.equal(crossGroup.status, 404);
  const invalidStatus = await fetch(endpoint, {
    method: 'PATCH', headers: headers(admin, admin.csrfToken),
    body: JSON.stringify({ status: 'error', reason: '试图伪造异常状态' })
  });
  assert.equal(invalidStatus.status, 400);
  const missingReason = await fetch(endpoint, {
    method: 'PATCH', headers: headers(admin, admin.csrfToken),
    body: JSON.stringify({ status: 'normal', reason: '' })
  });
  assert.equal(missingReason.status, 400);

  const active = runtime.store.createRun(monitor, testCase, 'manual');
  const activeReview = await fetch(`${http.baseUrl}/api/admin/groups/1/runs/${active.id}/review`, {
    method: 'PATCH', headers: headers(admin, admin.csrfToken),
    body: JSON.stringify({ status: 'normal', reason: '任务还未完成' })
  });
  assert.equal(activeReview.status, 409);

  const reviewedResponse = await fetch(endpoint, {
    method: 'PATCH', headers: headers(admin, admin.csrfToken),
    body: JSON.stringify({ status: 'normal', reason: '人工确认作品满足题目要求' })
  });
  assert.equal(reviewedResponse.status, 200);
  const reviewed = (await reviewedResponse.json()).run;
  assert.equal(reviewed.status, 'normal');
  assert.equal(reviewed.automatic_status, 'degraded');
  assert.equal(reviewed.automatic_reason, 'automatic verdict');
  assert.equal(reviewed.review.reason, '人工确认作品满足题目要求');
  assert.equal(reviewed.review.reviewed_by, 'user-a');
  assert.equal(runtime.store.getRun(run.id).status, 'degraded');
  assert.equal(runtime.store.getRun(run.id).manual_status, 'normal');

  const publicResults = await fetch(`${http.baseUrl}/api/results`, { headers: headers(ordinary) });
  assert.equal(publicResults.status, 200);
  const publicGroup = (await publicResults.json()).groups.find((item) => item.id === '1');
  const publicRun = publicGroup.history.find((item) => item.id === run.id);
  assert.equal(publicRun.status, 'normal');
  assert.equal(publicRun.review.automated_status, 'degraded');
  assert.equal('reviewed_by' in publicRun.review, false);
  assert.deepEqual(publicGroup.totals, { passed: 1, valid: 1, attempts: 1 });

  const publicDetail = await fetch(`${http.baseUrl}/api/results/${run.id}`, { headers: headers(ordinary) });
  assert.equal(publicDetail.status, 200);
  const detail = await publicDetail.json();
  assert.equal(detail.status, 'normal');
  assert.equal(detail.reason, '人工复核：人工确认作品满足题目要求');
  assert.equal('reviewed_by' in detail.review, false);

  const clearedResponse = await fetch(endpoint, {
    method: 'PATCH', headers: headers(admin, admin.csrfToken),
    body: JSON.stringify({ status: null })
  });
  assert.equal(clearedResponse.status, 200);
  const cleared = (await clearedResponse.json()).run;
  assert.equal(cleared.status, 'degraded');
  assert.equal(cleared.review, null);
  assert.equal(runtime.store.getRun(run.id).manual_status, null);
});

test('artifact MIME values are normalized before being used as response headers', () => {
  assert.equal(artifactMime('Image/PNG; charset=binary'), 'image/png');
  assert.equal(artifactMime('text/html\r\nx-unsafe: yes'), 'application/octet-stream');
});
