const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createTestContext } = require('./helpers');
const { createApplication } = require('../src/server');
const { ProviderRepository } = require('../src/repositories/provider-repository');
const { NotificationService } = require('../src/services/notification-service');
const {
  RechargeLinkService,
  tokenHash,
  jsonLoginFormField
} = require('../src/services/recharge-link-service');

function ticketFrom(url) {
  return new URL(url).searchParams.get('ticket');
}

test('New API text form encoding produces a valid JSON login body', () => {
  const field = jsonLoginFormField({ username: 'user@example.com', password: 'p<"&word' });
  assert.deepEqual(JSON.parse(`${field.name}=${field.value}`), {
    username: 'user@example.com',
    password: 'p<"&word',
    _: '='
  });
});

test('recharge entry tickets are hashed, preview-safe and single use for Sub2API', async (t) => {
  const context = createTestContext({
    PROVIDER_MONITOR_PUBLIC_URL: 'http://127.0.0.1',
    PROVIDER_MONITOR_RECHARGE_LINK_TTL_MINUTES: '30'
  });
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'Sub2API Wallet',
    adapterType: 'sub2api',
    baseUrl: 'https://sub2api.example',
    authMode: 'token_pair',
    credentials: {
      accessToken: 'browser-access-token',
      refreshToken: 'server-only-refresh-token',
      tokenExpiresAt: Date.now() + 3600000
    },
    enabled: false,
    rechargeUrl: 'https://sub2api.example/purchase',
    typeConfig: { rechargeLogin: { enabled: true } }
  });
  const app = createApplication({ config: context.config, db: context.db, startBackground: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  context.config.providerMonitorPublicUrl = base;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await app.locals.close();
    context.cleanup();
  });

  const issued = app.locals.services.rechargeLinks.issue(provider.id, { alertEventId: null });
  const ticket = ticketFrom(issued.url);
  const stored = context.db.prepare('SELECT * FROM recharge_access_tickets').get();
  assert.equal(issued.mode, 'adapter');
  assert.ok(ticket);
  assert.equal(stored.token_hash, tokenHash(ticket));
  assert.equal(JSON.stringify(stored).includes(ticket), false);

  const firstPreview = await fetch(issued.url);
  assert.equal(firstPreview.status, 200);
  assert.match(firstPreview.headers.get('cache-control'), /no-store/);
  assert.match(await firstPreview.text(), /正在前往 Sub2API Wallet/);
  const secondPreview = await fetch(issued.url);
  assert.equal(secondPreview.status, 200);
  assert.equal(context.db.prepare('SELECT consumed_at FROM recharge_access_tickets').get().consumed_at, null);

  const consumed = await fetch(`${base}/recharge-entry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ticket }),
    redirect: 'manual'
  });
  assert.equal(consumed.status, 303);
  const location = consumed.headers.get('location');
  assert.match(location, /^https:\/\/sub2api\.example\/auth\/callback#/);
  assert.match(location, /access_token=browser-access-token/);
  assert.doesNotMatch(location, /server-only-refresh-token/);

  const replay = await fetch(`${base}/recharge-entry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ticket }),
    redirect: 'manual'
  });
  assert.equal(replay.status, 410);
  assert.match(await replay.text(), /已使用/);
});

test('New API recharge entry submits only its web login credentials to the provider origin', async (t) => {
  const context = createTestContext({ PROVIDER_MONITOR_PUBLIC_URL: 'http://127.0.0.1' });
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'New API Wallet',
    adapterType: 'new-api',
    baseUrl: 'https://new-api.example',
    authMode: 'system_token',
    credentials: {
      systemToken: 'never-render-system-token',
      userId: '7',
      webUsername: 'wallet-user',
      webPassword: 'wallet-password'
    },
    enabled: false,
    rechargeUrl: 'https://new-api.example/wallet',
    typeConfig: { rechargeLogin: { enabled: true } }
  });
  const app = createApplication({ config: context.config, db: context.db, startBackground: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  context.config.providerMonitorPublicUrl = base;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await app.locals.close();
    context.cleanup();
  });

  const issued = app.locals.services.rechargeLinks.issue(provider.id);
  const response = await fetch(`${base}/recharge-entry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ticket: ticketFrom(issued.url) })
  });
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /form-action 'self' https:\/\/new-api\.example/);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.match(html, /action="https:\/\/new-api\.example\/api\/user\/login"/);
  assert.match(html, /wallet-user/);
  assert.match(html, /wallet-password/);
  assert.doesNotMatch(html, /never-render-system-token/);
});

test('low-balance notifications replace the direct URL with a one-time recharge entry', async (t) => {
  let receivedPayload = null;
  const receiver = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      receivedPayload = JSON.parse(body);
      res.writeHead(204).end();
    });
  });
  receiver.listen(0, '127.0.0.1');
  await new Promise((resolve) => receiver.once('listening', resolve));

  const context = createTestContext({
    PROVIDER_MONITOR_PUBLIC_URL: 'https://monitor.example'
  });
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'Sub2API Alert Wallet',
    adapterType: 'sub2api',
    baseUrl: 'https://sub2api.example',
    authMode: 'token_pair',
    credentials: {
      accessToken: 'alert-access-token',
      tokenExpiresAt: Date.now() + 3600000
    },
    enabled: false,
    rechargeUrl: 'https://sub2api.example/purchase',
    typeConfig: { rechargeLogin: { enabled: true } }
  });
  const rechargeLinks = new RechargeLinkService({
    db: context.db,
    config: context.config,
    providers,
    http: {}
  });
  const notifications = new NotificationService({
    db: context.db,
    config: context.config,
    rechargeLinks
  });
  notifications.save({
    name: 'Test receiver',
    type: 'webhook',
    enabled: true,
    config: { url: `http://127.0.0.1:${receiver.address().port}/alerts` }
  });

  t.after(async () => {
    await new Promise((resolve) => receiver.close(resolve));
    context.cleanup();
  });

  const results = await notifications.dispatch({
    id: null,
    connection_id: provider.id,
    severity: 'warning',
    message: 'Balance is below the configured threshold.',
    triggered_at: new Date().toISOString(),
    details: { rechargeUrl: 'https://sub2api.example/purchase' }
  });

  assert.equal(results[0].status, 'fulfilled');
  assert.ok(receivedPayload);
  assert.match(receivedPayload.details.rechargeUrl, /^https:\/\/monitor\.example\/recharge-entry\?ticket=/);
  assert.match(receivedPayload.message, /monitor\.example\/recharge-entry\?ticket=/);
  assert.doesNotMatch(receivedPayload.message, /sub2api\.example\/purchase/);
  assert.equal(context.db.prepare('SELECT COUNT(*) count FROM recharge_access_tickets').get().count, 1);
});
