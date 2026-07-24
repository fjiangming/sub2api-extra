const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createTestContext } = require('./helpers');
const { createApplication } = require('../src/server');

async function login(base) {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-password' })
  });
  assert.equal(response.status, 200);
  return {
    session: await response.json(),
    cookie: response.headers.get('set-cookie').split(';')[0]
  };
}

function mutationHeaders(auth) {
  return {
    Cookie: auth.cookie,
    'Content-Type': 'application/json',
    'X-CSRF-Token': auth.session.csrfToken
  };
}

test('recharge alert simulation sends the selected mobile notification without creating a real alert', async (t) => {
  const received = [];
  const receiver = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.writeHead(204).end();
    });
  });
  receiver.listen(0, '127.0.0.1');
  await new Promise((resolve) => receiver.once('listening', resolve));

  const context = createTestContext({
    PROVIDER_MONITOR_PUBLIC_URL: 'https://monitor.example'
  });
  const app = createApplication({ config: context.config, db: context.db, startBackground: false });
  const { providers, notifications } = app.locals.services;
  const sub2api = providers.create({
    name: 'Sub2API Mobile Wallet',
    adapterType: 'sub2api',
    baseUrl: 'https://sub2api.example',
    authMode: 'token_pair',
    credentials: {
      accessToken: 'simulation-access-token',
      tokenExpiresAt: Date.now() + 3600000
    },
    enabled: false,
    warningThreshold: 20,
    thresholdCurrency: 'USD',
    rechargeUrl: 'https://sub2api.example/purchase',
    typeConfig: { rechargeLogin: { enabled: true } }
  });
  const directProvider = providers.create({
    name: 'Custom Direct Wallet',
    adapterType: 'custom',
    baseUrl: 'https://custom.example',
    authMode: 'api_key',
    credentials: { apiKey: 'custom-key' },
    enabled: false,
    rechargeUrl: 'https://custom.example/billing',
    typeConfig: { rechargeLogin: { enabled: true } }
  });
  const missingRechargeProvider = providers.create({
    name: 'Missing Recharge Wallet',
    adapterType: 'custom',
    baseUrl: 'https://missing.example',
    authMode: 'api_key',
    credentials: { apiKey: 'missing-key' },
    enabled: false
  });
  const channel = notifications.save({
    name: 'Disabled mobile receiver',
    type: 'webhook',
    enabled: false,
    config: { url: `http://127.0.0.1:${receiver.address().port}/mobile-alert` }
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await app.locals.close();
    await new Promise((resolve) => receiver.close(resolve));
    context.cleanup();
  });

  const auth = await login(base);
  const beforeReauth = await fetch(`${base}/api/simulations/recharge-alert`, {
    method: 'POST',
    headers: mutationHeaders(auth),
    body: JSON.stringify({ connectionId: sub2api.id, channelId: channel.id })
  });
  assert.equal(beforeReauth.status, 403);
  assert.equal((await beforeReauth.json()).error.code, 'REAUTH_REQUIRED');
  assert.equal(received.length, 0);

  const reauth = await fetch(`${base}/api/auth/reauth`, {
    method: 'POST',
    headers: mutationHeaders(auth),
    body: JSON.stringify({ username: 'admin', password: 'test-password' })
  });
  assert.equal(reauth.status, 200);

  const automatic = await fetch(`${base}/api/simulations/recharge-alert`, {
    method: 'POST',
    headers: mutationHeaders(auth),
    body: JSON.stringify({ connectionId: sub2api.id, channelId: channel.id })
  });
  assert.equal(automatic.status, 200);
  assert.match(automatic.headers.get('cache-control'), /no-store/);
  const automaticResult = await automatic.json();
  assert.equal(automaticResult.status, 'delivered');
  assert.equal(automaticResult.simulated, true);
  assert.equal(automaticResult.channel.enabled, false);
  assert.equal(automaticResult.recharge.mode, 'adapter');
  assert.equal(automaticResult.recharge.targetHost, 'monitor.example');
  assert.ok(automaticResult.recharge.expiresAt);
  assert.equal(Object.hasOwn(automaticResult.recharge, 'url'), false);
  assert.equal(automaticResult.mobilePreview.mode, 'adapter');
  assert.match(automaticResult.mobilePreview.url, /^https:\/\/monitor\.example\/recharge-entry\?ticket=/);

  assert.equal(received.length, 1);
  assert.equal(received[0].details.test, true);
  assert.equal(received[0].details.simulation, 'recharge_alert');
  assert.match(received[0].message, /\[模拟测试\]/);
  assert.match(received[0].details.rechargeUrl, /^https:\/\/monitor\.example\/recharge-entry\?ticket=/);
  assert.match(received[0].message, /monitor\.example\/recharge-entry\?ticket=/);
  assert.notEqual(automaticResult.mobilePreview.url, received[0].details.rechargeUrl);

  const direct = await fetch(`${base}/api/simulations/recharge-alert`, {
    method: 'POST',
    headers: mutationHeaders(auth),
    body: JSON.stringify({ connectionId: directProvider.id, channelId: channel.id })
  });
  assert.equal(direct.status, 200);
  const directResult = await direct.json();
  assert.equal(directResult.recharge.mode, 'direct');
  assert.equal(directResult.recharge.reason, 'adapter_unsupported');
  assert.equal(directResult.recharge.targetHost, 'custom.example');
  assert.equal(directResult.mobilePreview.url, 'https://custom.example/billing');
  assert.equal(received[1].details.rechargeUrl, 'https://custom.example/billing');

  const missingRecharge = await fetch(`${base}/api/simulations/recharge-alert`, {
    method: 'POST',
    headers: mutationHeaders(auth),
    body: JSON.stringify({ connectionId: missingRechargeProvider.id, channelId: channel.id })
  });
  assert.equal(missingRecharge.status, 409);
  assert.equal((await missingRecharge.json()).error.code, 'RECHARGE_URL_MISSING');
  assert.equal(received.length, 2);

  assert.equal(context.db.prepare('SELECT COUNT(*) count FROM alert_events').get().count, 0);
  assert.equal(context.db.prepare('SELECT COUNT(*) count FROM notification_deliveries').get().count, 0);
  assert.equal(context.db.prepare('SELECT COUNT(*) count FROM recharge_access_tickets').get().count, 2);
  assert.equal(
    context.db.prepare("SELECT COUNT(*) count FROM audit_logs WHERE action = 'simulation.recharge_alert'").get().count,
    2
  );
  assert.equal(
    context.db.prepare("SELECT COUNT(*) count FROM audit_logs WHERE details_json LIKE '%ticket=%'").get().count,
    0
  );
});
