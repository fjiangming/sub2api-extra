const test = require('node:test');
const assert = require('node:assert/strict');
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
  assert.match(await index.text(), /Provider Monitor/);
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

  const createProvider = await fetch(`${base}/api/providers`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
    body: JSON.stringify({
      name: 'Manual recharge supplier', adapterType: 'custom', baseUrl: 'https://supplier.example',
      authMode: 'api_key', credentials: { apiKey: 'secret' }, enabled: false,
      warningThreshold: 20, thresholdCurrency: 'USD',
      rechargeUrl: 'https://supplier.example/account/recharge'
    })
  });
  assert.equal(createProvider.status, 201);
  assert.equal((await createProvider.json()).provider.rechargeUrl, 'https://supplier.example/account/recharge');

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

  const createChannelRuleWithoutChannel = await fetch(`${base}/api/automation-rules`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
    body: JSON.stringify({
      name: 'Disable channel', triggerType: 'low_balance', enabled: true, dryRun: true,
      config: { action: 'disable_sub2api_channel', threshold: 20, currency: 'USD' }
    })
  });
  assert.equal(createChannelRuleWithoutChannel.status, 400);

  const updateSettings = await fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
    body: JSON.stringify({
      automationEnabled: true,
      allowedOrigins: ['https://console.example'],
      allowedHosts: ['supplier.internal'],
      allowPrivateNetworks: true
    })
  });
  assert.equal(updateSettings.status, 200);
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
