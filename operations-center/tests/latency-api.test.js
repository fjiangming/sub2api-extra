'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config');
const { AuthService } = require('../src/auth');
const { ProviderMonitorClient } = require('../src/provider-monitor-client');

test('latency query APIs require an admin session and ingestion requires its separate service token', async (t) => {
  const token = 'telemetry-service-token-0123456789abcdef';
  const config = loadConfig({ NODE_ENV: 'test', OPERATIONS_CENTER_ADMIN_PASSWORD: 'test-password-123', LATENCY_TELEMETRY_TOKEN: token });
  const auth = new AuthService(config); t.after(() => auth.close());
  let ingested = 0, queried = 0;
  const app = createApp({ config, auth, database: {},
    latency: { options: async () => ({}), report: async () => { queried += 1; return { items: [] }; }, detail: async (id) => ({ id }) },
    telemetry: { ingest: () => { ingested += 1; return { accepted: 1 }; }, recent: () => [], status: () => ({}), resources: () => [] }
  });
  const server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/latency/requests`)).status, 401);
  assert.equal(queried, 0);
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-password-123' }) });
  const session = await login.json();
  const headers = { authorization: `Session ${session.sessionToken}`, 'content-type': 'application/json' };
  assert.equal((await fetch(`${base}/api/latency/requests`, { headers })).status, 200);
  assert.equal((await fetch(`${base}/api/latency/ingest`, { method: 'POST', headers, body: '{}' })).status, 401);
  const integrationHeaders = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  assert.equal((await fetch(`${base}/api/latency/ingest`, { method: 'POST', headers: integrationHeaders, body: '{}' })).status, 200);
  assert.equal(ingested, 1);
  assert.equal((await fetch(`${base}/api/latency/requests`, { headers: integrationHeaders })).status, 401);
});

test('upstream sample client uses the scoped integration path or administrator SSO', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(url.endsWith('/api/auth/sso') ? { sessionToken: 'session' } : { items: [] }),
      { headers: { 'content-type': 'application/json' } });
  };
  const config = { providerMonitorBaseUrl: 'https://monitor.example', providerMonitorIntegrationToken: 'service-token', providerMonitorRequestTimeoutMs: 1000 };
  const query = { accountId: '270', from: '2026-10-20T00:00:00Z', to: '2026-10-20T01:00:00Z' };
  await new ProviderMonitorClient(config, fetchImpl).getLatencySamples(query);
  assert.ok(calls[0].url.includes('/api/integrations/latency-samples?accountId=270'));
  assert.equal(calls[0].options.headers.authorization, 'Bearer service-token');
  calls.length = 0;
  await new ProviderMonitorClient({ ...config, providerMonitorIntegrationToken: null }, fetchImpl).getLatencySamples(query, 'admin-token');
  assert.equal(calls[0].url, 'https://monitor.example/api/auth/sso');
  assert.equal(calls[1].options.headers.authorization, 'Session session');
});
