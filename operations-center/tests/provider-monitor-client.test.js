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

test('daily supplier costs use the read-only integration API with explicit dates, currency and timezone', async () => {
  const calls = [];
  const client = new ProviderMonitorClient({ providerMonitorBaseUrl: 'https://monitor.example',
    providerMonitorIntegrationToken: 'integration', providerMonitorRequestTimeoutMs: 1000
  }, async (url, options) => {
    calls.push({ url, options });
    return response(200, { source: 'provider_cost_ledger', items: [] });
  });
  const query = { from: '2026-01-01', to: '2026-01-02', currency: 'CNY', timezone: 'Asia/Shanghai' };
  assert.equal((await client.getDailyCosts(query, 'browser-token')).source, 'provider_cost_ledger');
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/api/integrations/daily-costs');
  assert.deepEqual(Object.fromEntries(url.searchParams), query);
  assert.equal(calls[0].options.headers.authorization, 'Bearer integration');
  assert.equal(calls.length, 1);
});

test('daily supplier costs exchange SSO and reject missing configuration or invalid sessions', async () => {
  const calls = [];
  const config = { providerMonitorBaseUrl: 'https://monitor.example', providerMonitorRequestTimeoutMs: 1000 };
  const client = new ProviderMonitorClient(config, async (url, options) => {
    calls.push({ url, options });
    return response(200, url.endsWith('/api/auth/sso') ? { sessionToken: 'monitor-session' } : { items: [] });
  });
  await client.getDailyCosts({ from: '2026-01-01' }, 'sub2api-sso');
  assert.deepEqual(calls.map((call) => call.options.headers.authorization), [
    'Bearer sub2api-sso', 'Session monitor-session'
  ]);
  assert.match(calls[1].url, /\/api\/daily-costs\?/);
  await assert.rejects(client.getDailyCosts({}), { code: 'PROVIDER_MONITOR_AUTH_NOT_CONFIGURED' });
  await assert.rejects(new ProviderMonitorClient({}).getDailyCosts({}), { code: 'PROVIDER_MONITOR_NOT_CONFIGURED' });
  const invalid = new ProviderMonitorClient(config, async () => response(200, {}));
  await assert.rejects(invalid.getDailyCosts({}, 'sso'), { code: 'PROVIDER_MONITOR_INVALID_RESPONSE' });
  const oldMonitor = new ProviderMonitorClient(config, async () => response(404, {}));
  await assert.rejects(oldMonitor.getDailyCosts({}, 'sso'), (error) =>
    error.code === 'PROVIDER_MONITOR_REQUEST_FAILED' && error.details.upstreamStatus === 404);
});
