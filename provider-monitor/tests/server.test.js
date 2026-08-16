const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { createTestContext } = require('./helpers');
const { createApplication } = require('../src/server');

test('HTTP API enforces login and CSRF while serving the operational frontend', async (t) => {
  const context = createTestContext();
  const app = createApplication({ config: context.config, db: context.db, startBackground: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await app.locals.close();
    context.cleanup();
  });

  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  const index = await fetch(base);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('cache-control'), /no-store/);
  assert.match(await index.text(), /Provider Monitor/);
  const applicationScript = await fetch(`${base}/app.js`);
  assert.equal(applicationScript.status, 200);
  assert.match(applicationScript.headers.get('cache-control'), /no-store/);
  const unauthorized = await fetch(`${base}/api/summary`);
  assert.equal(unauthorized.status, 401);

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-password' })
  });
  assert.equal(login.status, 200);
  const session = await login.json();
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.ok(session.csrfToken);
  const summary = await fetch(`${base}/api/summary`, { headers: { Cookie: cookie } });
  assert.equal(summary.status, 200);

  const csrfFailure = await fetch(`${base}/api/alert-rules`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Rule', ruleType: 'sync_failed' })
  });
  assert.equal(csrfFailure.status, 403);
  const createRule = await fetch(`${base}/api/alert-rules`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
    body: JSON.stringify({ name: 'Sync failures', ruleType: 'sync_failed', enabled: true })
  });
  assert.equal(createRule.status, 201);

  const incompleteBalanceRule = await fetch(`${base}/api/alert-rules`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
    body: JSON.stringify({ name: 'Incomplete balance rule', ruleType: 'low_balance', currency: 'USD' })
  });
  assert.equal(incompleteBalanceRule.status, 400);

  const completeBalanceRule = await fetch(`${base}/api/alert-rules`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
    body: JSON.stringify({
      name: 'Complete balance rule', ruleType: 'low_balance', scope: 'account',
      threshold: 20, currency: 'USD', consecutiveMatches: 2, cooldownMinutes: 60
    })
  });
  assert.equal(completeBalanceRule.status, 201);

  const signedRateRule = await fetch(`${base}/api/alert-rules`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
    body: JSON.stringify({
      name: 'Negative group margin', ruleType: 'rate_mismatch', threshold: -5,
      config: { comparisonOperator: 'lt', groupId: 7 }
    })
  });
  assert.equal(signedRateRule.status, 201);
  const savedSignedRateRule = await signedRateRule.json();
  assert.equal(savedSignedRateRule.threshold, -5);
  assert.deepEqual(savedSignedRateRule.config, { comparisonOperator: 'lt', groupId: 7 });

  const invalidRateRule = await fetch(`${base}/api/alert-rules`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
    body: JSON.stringify({
      name: 'Invalid margin operator', ruleType: 'rate_mismatch', threshold: -5,
      config: { comparisonOperator: 'outside', groupId: 7 }
    })
  });
  assert.equal(invalidRateRule.status, 400);

  const keyInventoryServer = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer inventory-session-token');
    assert.match(req.url, /^\/api\/v1\/keys\?/);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 0, data: { items: [
      { id: 41, name: 'Remote key', key: 'sk-remote-server-secret-12345678', status: 'active', group_id: 9 }
    ], total: 1 } }));
  });
  await new Promise((resolve) => keyInventoryServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => keyInventoryServer.close(resolve)));
  const keyOptions = await fetch(`${base}/api/providers/key-options`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
    body: JSON.stringify({
      baseUrl: `http://127.0.0.1:${keyInventoryServer.address().port}`,
      credentials: { accessToken: 'inventory-session-token', tokenExpiresAt: Date.now() + 3600000 }
    })
  });
  assert.equal(keyOptions.status, 200);
  const keyOptionBody = await keyOptions.json();
  assert.deepEqual(keyOptionBody.items.map((item) => [item.remote_id, item.name, item.status]), [
    ['41', 'Remote key', 'active']
  ]);
  assert.doesNotMatch(JSON.stringify(keyOptionBody), /remote-server-secret/);

  const createProvider = await fetch(`${base}/api/providers`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
    body: JSON.stringify({
      name: 'Manual recharge supplier', adapterType: 'custom', baseUrl: 'https://supplier.example',
      authMode: 'api_key', credentials: { apiKey: 'secret' }, enabled: false,
      warningThreshold: 20, secondaryWarningThreshold: 5, thresholdCurrency: 'USD',
      rechargeUrl: 'https://supplier.example/account/recharge'
    })
  });
  assert.equal(createProvider.status, 201);
  const createdProvider = (await createProvider.json()).provider;
  assert.equal(createdProvider.rechargeUrl, 'https://supplier.example/account/recharge');
  assert.equal(createdProvider.secondary_warning_threshold, 5);

  const createMultiKeyProvider = await fetch(`${base}/api/providers`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
    body: JSON.stringify({
      name: 'Multi-key gateway', adapterType: 'sub2api', baseUrl: 'https://gateway.example',
      authMode: 'api_key', enabled: false,
      credentials: {
        apiKeys: [
          { id: 'primary', name: 'Primary', key: 'sk-primary-server-secret' },
          { id: 'backup', name: 'Backup', key: 'sk-backup-server-secret' }
        ]
      }
    })
  });
  assert.equal(createMultiKeyProvider.status, 201);
  const multiKeyProvider = (await createMultiKeyProvider.json()).provider;
  assert.deepEqual(multiKeyProvider.configuredApiKeys.map((entry) => entry.id), ['primary', 'backup']);
  assert.doesNotMatch(JSON.stringify(multiKeyProvider), /server-secret/);
  const multiKeyAudit = context.db.prepare(`
    SELECT details_json FROM audit_logs
    WHERE action = 'provider.create' AND target_id = ?
  `).get(multiKeyProvider.id);
  assert.doesNotMatch(multiKeyAudit.details_json, /server-secret/);

  const createMapping = await fetch(`${base}/api/mappings`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
    body: JSON.stringify({ connectionId: createdProvider.id, groupId: 7 })
  });
  assert.equal(createMapping.status, 201);
  const deleteMappings = await fetch(`${base}/api/mappings`, {
    method: 'DELETE',
    headers: { Cookie: cookie, 'X-CSRF-Token': session.csrfToken }
  });
  assert.equal(deleteMappings.status, 200);
  assert.deepEqual(await deleteMappings.json(), {
    deletedMappings: 1,
    deletedComparisonStates: 0,
    deletedReconciliations: 0
  });
  const mappingsAfterDelete = await fetch(`${base}/api/mappings`, { headers: { Cookie: cookie } });
  assert.deepEqual((await mappingsAfterDelete.json()).items, []);
  assert.equal(context.db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'mapping.delete_all'").get().count, 1);

  const invalidThresholdUpdate = await fetch(`${base}/api/providers/${createdProvider.id}`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
    body: JSON.stringify({ secondaryWarningThreshold: 25 })
  });
  assert.equal(invalidThresholdUpdate.status, 400);

  const invalidRechargeUrl = await fetch(`${base}/api/providers`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
    body: JSON.stringify({
      name: 'Invalid recharge link', adapterType: 'custom', baseUrl: 'https://invalid.example',
      authMode: 'api_key', credentials: { apiKey: 'secret' }, enabled: false,
      rechargeUrl: 'javascript:alert(1)'
    })
  });
  assert.equal(invalidRechargeUrl.status, 400);

  const createServerChan = await fetch(`${base}/api/notification-channels`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
    body: JSON.stringify({
      name: 'Personal WeChat', type: 'serverchan', enabled: false,
      config: {}, credentials: { sendKey: 'SCT_TEST_KEY' }
    })
  });
  assert.equal(createServerChan.status, 201);
  assert.equal((await createServerChan.json()).type, 'serverchan');

  const createRechargeRule = await fetch(`${base}/api/automation-rules`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
    body: JSON.stringify({
      name: 'Recharge account', triggerType: 'low_balance', enabled: true, dryRun: true,
      config: {
        action: 'trigger_recharge_webhook', threshold: 20, currency: 'USD',
        webhookUrl: 'https://recharge.example/hook'
      }
    })
  });
  assert.equal(createRechargeRule.status, 201);
  assert.equal(Object.hasOwn((await createRechargeRule.json()).config, 'channelIds'), false);

  const createAccountRuleWithoutAccount = await fetch(`${base}/api/automation-rules`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
    body: JSON.stringify({
      name: 'Disable account', triggerType: 'low_balance', enabled: true, dryRun: true,
      config: { action: 'disable_sub2api_account', channelIds: [7], threshold: 20, currency: 'USD' }
    })
  });
  assert.equal(createAccountRuleWithoutAccount.status, 400);

  const incompleteScheduledRule = await fetch(`${base}/api/automation-rules`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
    body: JSON.stringify({
      name: 'Rebuild mappings', triggerType: 'scheduled', enabled: true, dryRun: true,
      config: { action: 'rebuild_sub2api_mappings' }
    })
  });
  assert.equal(incompleteScheduledRule.status, 400);

  const incompleteScheduledWorkflow = await fetch(`${base}/api/automation-rules`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
    body: JSON.stringify({
      name: 'Incomplete mapping workflow', triggerType: 'scheduled', enabled: true, dryRun: true,
      config: {
        action: 'rebuild_sub2api_mappings',
        scheduleIntervalMinutes: 1440,
        condition: { type: 'composite_rate_difference', operator: 'lt', threshold: 0 },
        targetMode: 'matched_mapping_accounts'
      }
    })
  });
  assert.equal(incompleteScheduledWorkflow.status, 400);

  const scheduledRule = await fetch(`${base}/api/automation-rules`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
    body: JSON.stringify({
      name: 'Rebuild mappings daily', triggerType: 'scheduled', enabled: true, dryRun: true,
      connectionId: null,
      config: {
        action: 'rebuild_sub2api_mappings',
        scheduleIntervalMinutes: 1440,
        condition: { type: 'composite_rate_difference', operator: 'lt', threshold: 0 },
        onMatchAction: 'disable_sub2api_account',
        targetMode: 'matched_mapping_accounts'
      }
    })
  });
  assert.equal(scheduledRule.status, 201);
  const scheduledRuleBody = await scheduledRule.json();
  assert.equal(scheduledRuleBody.config.condition.threshold, 0);
  assert.equal(scheduledRuleBody.config.onMatchAction, 'disable_sub2api_account');
  const renamedScheduledRule = await fetch(`${base}/api/automation-rules/${scheduledRuleBody.id}`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
    body: JSON.stringify({ name: 'Renamed mapping rebuild' })
  });
  assert.equal(renamedScheduledRule.status, 200);
  assert.equal((await renamedScheduledRule.json()).name, 'Renamed mapping rebuild');
  const incompatibleScheduledUpdate = await fetch(`${base}/api/automation-rules/${scheduledRuleBody.id}`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
    body: JSON.stringify({
      config: { action: 'disable_sub2api_account', accountIds: [17] }
    })
  });
  assert.equal(incompatibleScheduledUpdate.status, 400);

  const unifiedRules = await fetch(`${base}/api/rules`, { headers: { Cookie: cookie } });
  assert.equal(unifiedRules.status, 200);
  const unifiedRuleItems = (await unifiedRules.json()).items;
  const alertRule = unifiedRuleItems.find((rule) => rule.kind === 'alert' && rule.name === 'Sync failures');
  assert.equal(alertRule.triggerType, 'sync_failed');
  assert.equal(alertRule.actionType, 'create_alert_event');
  assert.equal(alertRule.executionMode, 'event');
  const automationRule = unifiedRuleItems.find((rule) => rule.id === scheduledRuleBody.id);
  assert.equal(automationRule.kind, 'automation');
  assert.equal(automationRule.triggerType, 'scheduled');
  assert.equal(automationRule.actionType, 'rebuild_sub2api_mappings');
  assert.equal(automationRule.executionMode, 'dry_run');

  const dynamicProvider = app.locals.services.providers.create({
    name: 'Dynamic settings test', adapterType: 'new-api',
    baseUrl: 'https://dynamic-settings.example', authMode: 'system_token',
    credentials: { systemToken: 'dynamic-token', userId: '1' },
    typeConfig: { dynamicRouteRate: { enabled: true, statistic: 'latest' } },
    enabled: true
  });
  const dynamicKeyId = crypto.randomUUID();
  const dynamicNow = new Date().toISOString();
  context.db.prepare(`
    INSERT INTO remote_keys(
      id, connection_id, remote_id, name, masked_key, status, unlimited,
      metadata_json, first_seen_at, last_seen_at
    ) VALUES (?, ?, 'dynamic-key', 'Dynamic key', 'sk-...test', 'enabled', 1, '{}', ?, ?)
  `).run(dynamicKeyId, dynamicProvider.id, dynamicNow, dynamicNow);
  context.db.prepare(`
    INSERT INTO provider_dynamic_route_rates(
      key_id, connection_id, selected_multiplier, statistic, sample_count,
      status, summary_json, checked_at, updated_at
    ) VALUES (?, ?, 0.1, 'latest', 2, 'detected',
      '{"priceBasis":"official_relative"}', ?, ?)
  `).run(dynamicKeyId, dynamicProvider.id, dynamicNow, dynamicNow);
  const enqueuedSettingsJobs = [];
  const originalEnqueue = app.locals.services.queue.enqueue.bind(app.locals.services.queue);
  app.locals.services.queue.enqueue = (type, options) => {
    enqueuedSettingsJobs.push({ type, options });
    return 'settings-test-job';
  };

  const updateSettings = await fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
    body: JSON.stringify({
      automationEnabled: true,
      allowedOrigins: ['https://console.example'],
      allowedHosts: ['supplier.internal'],
      allowPrivateNetworks: true,
      officialModelPrices: {
        'model-a': { input: 5, output: 30 },
        'route-a': { model: 'model-a' }
      }
    })
  });
  app.locals.services.queue.enqueue = originalEnqueue;
  assert.equal(updateSettings.status, 200);
  assert.deepEqual((await updateSettings.clone().json()).officialModelPrices, {
    'model-a': { input: 5, output: 30 },
    'route-a': { model: 'model-a' }
  });
  const invalidatedRate = context.db.prepare(`
    SELECT selected_multiplier, sample_count, status
    FROM provider_dynamic_route_rates WHERE key_id = ?
  `).get(dynamicKeyId);
  assert.deepEqual(invalidatedRate, {
    selected_multiplier: null,
    sample_count: 0,
    status: 'recalculation_required'
  });
  assert.deepEqual(enqueuedSettingsJobs, [{
    type: 'provider_sync',
    options: { connectionId: dynamicProvider.id, priority: 20 }
  }]);
  assert.equal(app.locals.services.config.automationEnabled, true);
  const updatedIndex = await fetch(base);
  assert.match(updatedIndex.headers.get('content-security-policy'), /frame-ancestors[^;]*https:\/\/console\.example/);
  const cors = await fetch(`${base}/api/auth/config`, {
    headers: { Origin: 'https://console.example' }
  });
  assert.equal(cors.headers.get('access-control-allow-origin'), 'https://console.example');

  const backupWithoutReauth = await fetch(`${base}/api/backups`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
    body: JSON.stringify({ label: 'test' })
  });
  assert.equal(backupWithoutReauth.status, 403);
  const reauth = await fetch(`${base}/api/auth/reauth`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
    body: JSON.stringify({ username: 'admin', password: 'test-password' })
  });
  assert.equal(reauth.status, 200);
  const backup = await fetch(`${base}/api/backups`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
    body: JSON.stringify({ label: 'test' })
  });
  assert.equal(backup.status, 201);
});
