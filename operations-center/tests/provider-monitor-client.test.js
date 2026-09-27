'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ProviderMonitorClient } = require('../src/provider-monitor-client');

function response(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

test('provider monitor integration token reads and normalizes the safe provider list', async () => {
  const requests = [];
  const client = new ProviderMonitorClient({
    providerMonitorBaseUrl: 'http://provider-monitor:9871',
    providerMonitorIntegrationToken: 'integration-token-0123456789abcdef',
    providerMonitorRequestTimeoutMs: 1000
  }, async (url, options) => {
    requests.push({ url, options });
    return response(200, { items: [{ id: 7, name: 'Vendor', adapter_type: 'custom', enabled: 1, threshold_currency: 'usd' }] });
  });
  assert.deepEqual(await client.listProviders(), [{
    id: '7', name: 'Vendor', adapterType: 'custom', enabled: true, currency: 'USD'
  }]);
  assert.equal(requests[0].options.headers.authorization, 'Bearer integration-token-0123456789abcdef');
});

test('provider monitor client exchanges a Sub2API token when no integration token is configured', async () => {
  const requests = [];
  const client = new ProviderMonitorClient({
    providerMonitorBaseUrl: 'https://monitor.example',
    providerMonitorIntegrationToken: null,
    providerMonitorRequestTimeoutMs: 1000
  }, async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/api/auth/sso')) return response(200, { sessionToken: 'provider-session' });
    return response(200, { items: [{ id: 'p1', name: 'Vendor', adapterType: 'openrouter', enabled: false, currency: 'USD' }] });
  });
  const providers = await client.listProviders('sub2api-access-token');
  assert.equal(providers[0].id, 'p1');
  assert.deepEqual(requests.map((request) => request.options.headers.authorization), [
    'Bearer sub2api-access-token',
    'Session provider-session'
  ]);
});
