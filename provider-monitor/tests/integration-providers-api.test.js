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
