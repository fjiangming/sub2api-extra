'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');
const { createApplication } = require('../src/server');

test('read-only integration token exposes only the provider fields needed by cost analysis', async (t) => {
  const token = 'provider-integration-token-0123456789abcdef';
  const context = createTestContext({ PROVIDER_MONITOR_INTEGRATION_TOKEN: token });
  const app = createApplication({ config: context.config, db: context.db, startBackground: false });
  app.locals.services.providers.create({
    name: 'Cost Vendor',
    adapterType: 'custom',
    baseUrl: 'https://provider.example',
    authMode: 'api_key',
    credentials: { apiKey: 'must-not-leak' },
    enabled: true,
    thresholdCurrency: 'CNY'
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await app.locals.close();
    context.cleanup();
  });

  assert.equal((await fetch(`${baseUrl}/api/integrations/providers`)).status, 401);
  const response = await fetch(`${baseUrl}/api/integrations/providers`, {
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.items.length, 1);
  assert.deepEqual(Object.keys(payload.items[0]).sort(), ['adapterType', 'currency', 'enabled', 'id', 'name']);
  assert.equal(payload.items[0].name, 'Cost Vendor');
  assert.equal(payload.items[0].currency, 'CNY');
  assert.equal(JSON.stringify(payload).includes('must-not-leak'), false);
  assert.equal(JSON.stringify(payload).includes('provider.example'), false);
});

test('integration token proxies notification channel metadata and dispatch selection without exposing credentials', async (t) => {
  const token = 'provider-integration-token-notification-0123456789abcdef';
  const context = createTestContext({ PROVIDER_MONITOR_INTEGRATION_TOKEN: token });
  const app = createApplication({ config: context.config, db: context.db, startBackground: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await app.locals.close();
    context.cleanup();
  });
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  assert.equal((await fetch(`${baseUrl}/api/integrations/notification-channels`)).status, 401);
  const createdResponse = await fetch(`${baseUrl}/api/integrations/notification-channels`, {
    method: 'POST', headers, body: JSON.stringify({ name: 'Cost alerts', type: 'webhook', config: { url: 'https://alerts.example/hook' }, credentials: { secret: 'do-not-return' } })
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.name, 'Cost alerts');
  assert.equal(JSON.stringify(created).includes('do-not-return'), false);
  const listed = await fetch(`${baseUrl}/api/integrations/notification-channels`, { headers });
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).items[0].credentialFields[0].masked, 'do-n...turn');
  const dispatched = await fetch(`${baseUrl}/api/integrations/notifications/dispatch`, {
    method: 'POST', headers, body: JSON.stringify({ event: { title: 'test', severity: 'warning', message: 'test' }, channelIds: [] })
  });
  assert.equal(dispatched.status, 200);
  assert.deepEqual((await dispatched.json()).items, []);
});
