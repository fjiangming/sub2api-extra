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

test('monitor timeouts cover hanging fetches, response bodies and caller cancellation without trapping later reads', async () => {
  let mode = 'headers';
  const signals = [];
  const client = new ProviderMonitorClient({ providerMonitorBaseUrl: 'http://monitor.example',
    providerMonitorIntegrationToken: 'synthetic', providerMonitorRequestTimeoutMs: 45 }, async (_, options) => {
    signals.push(options.signal);
    if (mode === 'headers') return new Promise(() => {});
    if (mode === 'body') return { ok: true, text: () => new Promise(() => {}) };
    return response(200, { source: 'upstream_daily_summary', items: [] });
  });
  const read = await client.createDailyCostsReader();
  await assert.rejects(read({ from: '2026-10-30' }), { code: 'PROVIDER_MONITOR_TIMEOUT' });
  assert.equal(signals[0].aborted, true);
  mode = 'body';
  await assert.rejects(read({ from: '2026-10-30' }), { code: 'PROVIDER_MONITOR_TIMEOUT' });
  const abort = new AbortController();
  const pending = read({}, { signal: abort.signal });
  abort.abort();
  await assert.rejects(pending, { code: 'PROVIDER_MONITOR_TIMEOUT' });
  mode = 'healthy';
  assert.equal((await read({ from: '2026-10-30' })).source, 'upstream_daily_summary');
});

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
    return response(200, { source: 'upstream_daily_summary', scope: 'account', items: [] });
  });
  const query = { from: '2026-01-01', to: '2026-01-02', currency: 'CNY', timezone: 'Asia/Shanghai' };
  assert.equal((await client.getDailyCosts(query, 'browser-token')).source, 'upstream_daily_summary');
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

test('daily readers authenticate once for a month and keep administrator sessions scoped to each reader', async () => {
  const requests = [];
  let logins = 0;
  const client = new ProviderMonitorClient({ providerMonitorBaseUrl: 'https://monitor.example',
    providerMonitorRequestTimeoutMs: 1000
  }, async (url, options) => {
    requests.push({ url, authorization: options.headers.authorization });
    if (url.endsWith('/api/auth/sso')) {
      logins += 1;
      return response(200, { sessionToken: `session-${logins}` });
    }
    return response(200, { items: [] });
  });
  const first = await client.createDailyCostsReader('administrator-a');
  for (let day = 1; day <= 31; day += 1) {
    const date = `2026-10-${String(day).padStart(2, '0')}`;
    await first({ from: date, to: date, currency: 'CNY', timezone: 'Asia/Shanghai' });
  }
  assert.equal(logins, 1);
  assert.equal(requests.length, 32);
  assert.ok(requests.slice(1).every((request) => request.authorization === 'Session session-1'));
  const second = await client.createDailyCostsReader('administrator-b');
  await second({ from: '2026-10-31', to: '2026-10-31' });
  assert.equal(logins, 2);
  assert.equal(requests.at(-2).authorization, 'Bearer administrator-b');
  assert.equal(requests.at(-1).authorization, 'Session session-2');
  await first({ from: '2026-10-31', to: '2026-10-31' });
  assert.equal(requests.at(-1).authorization, 'Session session-1');
});

test('financial balance snapshot clients use integration auth or admin SSO without upstream sync writes', async () => {
  for (const integrationToken of ['synthetic-integration', null]) {
    const calls = [];
    const client = new ProviderMonitorClient({ providerMonitorBaseUrl: 'https://monitor.example', providerMonitorIntegrationToken: integrationToken, providerMonitorRequestTimeoutMs: 1000 }, async (url, options) => {
      calls.push({ url, options });
      return response(200, url.endsWith('/api/auth/sso') ? { sessionToken: 'scoped-admin' } : { currency: 'CNY', total: 100, complete: true, items: [] });
    });
    assert.equal((await client.getFinancialBalances('synthetic-sso')).total, 100);
    assert.equal(calls.at(-1).options.headers.authorization, integrationToken ? 'Bearer synthetic-integration' : 'Session scoped-admin');
    assert.match(calls.at(-1).url, /financial-balances$/);
    assert.equal(calls.filter(call => call.options.method === 'POST').length, integrationToken ? 0 : 1);
  }
  await assert.rejects(new ProviderMonitorClient({}).getFinancialBalances(), { code: 'PROVIDER_MONITOR_NOT_CONFIGURED' });
  await assert.rejects(new ProviderMonitorClient({ providerMonitorBaseUrl: 'https://monitor.example' }).getFinancialBalances(), { code: 'PROVIDER_MONITOR_AUTH_NOT_CONFIGURED' });
});

test('error mappings use integration or administrator-scoped SSO and pass the bounded historical interval', async () => {
  for (const integrationToken of ['synthetic-integration', null]) {
    const calls = [], query = { from: '2026-11-01', to: '2026-11-04' };
    const client = new ProviderMonitorClient({ providerMonitorBaseUrl: 'https://monitor.example',
      providerMonitorIntegrationToken: integrationToken, providerMonitorRequestTimeoutMs: 1000 }, async (url, options) => {
      calls.push({ url, options });
      return response(200, url.endsWith('/api/auth/sso') ? { sessionToken: 'error-admin-session' } : { items: [], source: 'verified_mapping_history' });
    });
    await client.getRequestErrorMappings(query, 'admin-sso');
    assert.equal(calls.at(-1).options.headers.authorization, integrationToken ? 'Bearer synthetic-integration' : 'Session error-admin-session');
    assert.deepEqual(Object.fromEntries(new URL(calls.at(-1).url).searchParams), query);
    assert.equal(calls.filter(c => c.options.method === 'POST').length, integrationToken ? 0 : 1);
  }
  await assert.rejects(new ProviderMonitorClient({}).getRequestErrorMappings({}), { code: 'PROVIDER_MONITOR_NOT_CONFIGURED' });
});
