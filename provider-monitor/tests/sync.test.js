const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createTestContext } = require('./helpers');
const { ProviderRepository } = require('../src/repositories/provider-repository');
const { HttpClient } = require('../src/http/client');
const { SyncService } = require('../src/services/sync-service');
const { QueryService } = require('../src/services/query-service');
const { MappingService } = require('../src/services/mapping-service');
const { AppError } = require('../src/errors');
const { nowIso } = require('../src/db');

function json(res, body) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function setOfficialModelPrices(db, prices) {
  db.prepare(`
    INSERT INTO settings(key, value_json, updated_at) VALUES ('officialModelPrices', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(JSON.stringify(prices), nowIso());
}

test('HTTP client classifies a plain-text 404 before requiring JSON', async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 page not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const context = createTestContext();
  t.after(() => context.cleanup());

  const client = new HttpClient(context.config);
  await assert.rejects(
    client.requestJson(`http://127.0.0.1:${server.address().port}/missing`, { retries: 0 }),
    (error) => error.code === 'CAPABILITY_UNSUPPORTED' && error.status === 404
  );
});

test('New API sync persists account balance, key quota and key groups', async (t) => {
  let dynamicRouteFailure = false;
  const server = http.createServer((req, res) => {
    if (req.url === '/api/status') return json(res, { success: true, data: { version: 'test', quota_per_unit: 500000 } });
    if (req.url === '/api/user/self') return json(res, { success: true, data: { id: 42, username: 'alice', quota: 10000000, used_quota: 2500000, group: 'default', status: 1 } });
    if (req.url === '/api/user/self/groups') return json(res, { success: true, data: [{ id: 'premium', name: 'Premium', ratio: 1.2 }] });
    if (req.url.startsWith('/api/log/self/stat')) return json(res, { success: true, data: { quota: 2500000, rpm: 1, tpm: 10 } });
    if (req.url.startsWith('/api/log/self?')) {
      if (dynamicRouteFailure) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ message: 'temporary log failure' }));
      }
      return json(res, { success: true, data: { total: 1, items: [{
      created_at: Math.floor(Date.now() / 1000), token_id: 9, token_name: 'build-key',
      model_name: 'model-a', channel: 31, channel_name: 'Low route', quota: 20,
      prompt_tokens: 100, completion_tokens: 0,
      other: { request_final_status: 'success', model_ratio: 0.2, group_ratio: 1 }
      }] } });
    }
    if (req.url.startsWith('/api/token/')) return json(res, { success: true, data: { items: [{ id: 9, name: 'build-key', key: 'sk-example-secret', status: 1, group: 'premium', unlimited_quota: false, remain_quota: 1500000, used_quota: 500000, expired_time: -1 }], total: 1 } });
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'not found' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const context = createTestContext();
  t.after(() => context.cleanup());
  setOfficialModelPrices(context.db, {
    'model-a': { model: 'official-model-a', input: 2 }
  });
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'Local New API',
    adapterType: 'new-api',
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    authMode: 'system_token',
    remoteUserId: '42',
    credentials: { systemToken: 'system-token' },
    enabled: true,
    warningThreshold: 5,
    thresholdCurrency: 'USD',
    typeConfig: {
      dynamicRouteRate: {
        enabled: true,
        statistic: 'latest',
        lookbackDays: 30,
        minimumSamples: 1
      }
    }
  });
  const sync = new SyncService({
    db: context.db,
    config: context.config,
    providers,
    http: new HttpClient(context.config),
    metrics: null
  });
  const result = await sync.run(provider.id);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.balanceCount, 1);
  assert.equal(result.keyCount, 1);
  assert.equal(result.groupCount, 1);
  assert.equal(result.dynamicRouteKeyCount, 1);

  const queries = new QueryService(context.db, context.config);
  const summary = queries.summary();
  assert.equal(summary.accounts.length, 1);
  assert.equal(summary.accounts[0].available, 20);
  assert.equal(summary.accounts[0].used, 5);
  const keys = queries.keys({ connectionId: provider.id });
  assert.equal(keys.length, 1);
  assert.equal(keys[0].quota_remaining, 3);
  assert.equal(keys[0].primary_group_ref, 'premium');
  assert.deepEqual(keys[0].additionalGroups, ['Premium']);
  assert.equal(keys[0].masked_key.includes('example-secret'), false);
  const dynamicRate = context.db.prepare(`
    SELECT selected_multiplier, statistic, sample_count, status, summary_json
    FROM provider_dynamic_route_rates WHERE connection_id = ?
  `).get(provider.id);
  assert.equal(dynamicRate.selected_multiplier, 0.2);
  assert.equal(dynamicRate.statistic, 'latest');
  assert.equal(dynamicRate.sample_count, 1);
  assert.equal(dynamicRate.status, 'detected');
  assert.equal(JSON.parse(dynamicRate.summary_json).latest.channelName, 'Low route');
  assert.equal(JSON.parse(dynamicRate.summary_json).priceBasis, 'official_relative');
  dynamicRouteFailure = true;
  const partial = await sync.run(provider.id);
  assert.equal(partial.status, 'partial');
  assert.equal(partial.warnings.some((warning) => warning.capability === 'getDynamicRouteRates'), true);
  const cachedDynamicRate = context.db.prepare(`
    SELECT selected_multiplier, status, error_code FROM provider_dynamic_route_rates
    WHERE connection_id = ?
  `).get(provider.id);
  assert.equal(cachedDynamicRate.selected_multiplier, 0.2);
  assert.equal(cachedDynamicRate.status, 'unavailable');
  assert.equal(Boolean(cachedDynamicRate.error_code), true);
  context.db.prepare("UPDATE provider_connections SET last_error_code = 'REMOTE_SERVER_ERROR' WHERE id = ?").run(provider.id);
  assert.equal(queries.summary().accounts[0].status, 'error');
});

test('New API API Key mode monitors only the selected remote keys and their logs', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/status') return json(res, { success: true, data: { quota_per_unit: 500000 } });
    if (req.url === '/api/user/self') {
      return json(res, { success: true, data: { id: 2160, username: 'a6-user', quota: 1000000, used_quota: 1000, status: 1 } });
    }
    if (req.url === '/api/user/self/groups') {
      return json(res, { success: true, data: [
        { id: 'cheap', name: 'Cheap', ratio: 0.1 },
        { id: 'stable', name: 'Stable', ratio: 0.2 },
        { id: 'unused', name: 'Unused', ratio: 0.3 }
      ] });
    }
    if (req.url.startsWith('/api/token/')) {
      return json(res, { success: true, data: { total: 3, items: [
        { id: 1, name: 'cheap-key', key: 'sk-cheap-secret', status: 1, group: 'cheap', unlimited_quota: true },
        { id: 2, name: 'stable-key', key: 'sk-stable-secret', status: 1, group: 'stable', unlimited_quota: true },
        { id: 3, name: 'unused-key', key: 'sk-unused-secret', status: 1, group: 'unused', unlimited_quota: true }
      ] } });
    }
    if (req.url.startsWith('/api/log/self/stat')) {
      return json(res, { success: true, data: { quota: 1000 } });
    }
    if (req.url.startsWith('/api/log/self?')) {
      return json(res, { success: true, data: { total: 3, items: [
        { created_at: 100, token_id: 1, token_name: 'cheap-key', model_name: 'model-a', prompt_tokens: 10, completion_tokens: 0, other: { request_final_status: 'success', model_ratio: 0.1, group_ratio: 1 } },
        { created_at: 200, token_id: 2, token_name: 'stable-key', model_name: 'model-a', prompt_tokens: 10, completion_tokens: 0, other: { request_final_status: 'success', model_ratio: 0.2, group_ratio: 1 } },
        { created_at: 300, token_id: 3, token_name: 'unused-key', model_name: 'model-a', prompt_tokens: 10, completion_tokens: 0, other: { request_final_status: 'success', model_ratio: 0.3, group_ratio: 1 } }
      ] } });
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'not found' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const context = createTestContext();
  t.after(() => context.cleanup());
  setOfficialModelPrices(context.db, { 'model-a': { input: 2 } });
  const providers = new ProviderRepository(context.db, context.config);
  const dynamicRouteRate = {
    enabled: true,
    statistic: 'latest',
    lookbackDays: 30,
    minimumSamples: 1
  };
  const provider = providers.create({
    name: 'a6api', adapterType: 'new-api',
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    authMode: 'api_key', remoteUserId: '2160',
    credentials: { systemToken: 'system-token', userId: '2160' },
    typeConfig: { dynamicRouteRate }, enabled: true
  });
  const sync = new SyncService({
    db: context.db, config: context.config, providers,
    http: new HttpClient(context.config), metrics: null
  });
  const initial = await sync.run(provider.id);
  assert.equal(initial.keyCount, 3);
  assert.equal(initial.dynamicRouteKeyCount, 3);

  providers.update(provider.id, {
    typeConfig: { dynamicRouteRate, monitoredKeyIds: ['1', '2'] }
  });
  const selected = await sync.run(provider.id);
  assert.equal(selected.status, 'succeeded');
  assert.equal(selected.keyCount, 2);
  assert.equal(selected.dynamicRouteKeyCount, 2);
  const keys = context.db.prepare(`
    SELECT remote_id, status FROM remote_keys WHERE connection_id = ? ORDER BY remote_id
  `).all(provider.id);
  assert.deepEqual(keys, [
    { remote_id: '1', status: 'enabled' },
    { remote_id: '2', status: 'enabled' },
    { remote_id: '3', status: 'missing' }
  ]);
  const rates = context.db.prepare(`
    SELECT k.remote_id, dr.selected_multiplier, dr.status
    FROM provider_dynamic_route_rates dr JOIN remote_keys k ON k.id = dr.key_id
    WHERE dr.connection_id = ? ORDER BY k.remote_id
  `).all(provider.id);
  assert.deepEqual(rates, [
    { remote_id: '1', selected_multiplier: 0.1, status: 'detected' },
    { remote_id: '2', selected_multiplier: 0.2, status: 'detected' },
    { remote_id: '3', selected_multiplier: null, status: 'not_monitored' }
  ]);
});

test('Sub2API account modes monitor only the selected remote keys', async (t) => {
  let failedUsageKeyId = null;
  const requestedUsageKeyIds = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/api/v1/user/profile') {
      return json(res, { code: 0, data: { id: 7, username: 'sub2-user', balance: 20 } });
    }
    if (req.url === '/api/v1/groups/available') {
      return json(res, { code: 0, data: [
        { id: 10, name: 'Cheap', rate_multiplier: 0.1, status: 'active' },
        { id: 20, name: 'Stable', rate_multiplier: 0.2, status: 'active' },
        { id: 30, name: 'Unused', rate_multiplier: 0.3, status: 'active' }
      ] });
    }
    if (req.url === '/api/v1/groups/rates') {
      return json(res, { code: 0, data: { 10: 0.1, 20: 0.2, 30: 0.3 } });
    }
    if (req.url.startsWith('/api/v1/keys?')) {
      return json(res, { code: 0, data: { total: 3, items: [
        { id: 1, name: 'cheap-key', key: 'sk-cheap-secret', group_id: 10, status: 'active', quota: 0, quota_used: 1 },
        { id: 2, name: 'stable-key', key: 'sk-stable-secret', group_id: 20, status: 'active', quota: 0, quota_used: 2 },
        { id: 3, name: 'unused-key', key: 'sk-unused-secret', group_id: 30, status: 'active', quota: 0, quota_used: 3 }
      ] } });
    }
    if (req.url.startsWith('/api/v1/usage?')) {
      const url = new URL(req.url, 'http://provider.test');
      const keyId = url.searchParams.get('api_key_id');
      requestedUsageKeyIds.push(keyId);
      if (keyId === failedUsageKeyId) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ message: 'temporary usage failure' }));
      }
      return json(res, { code: 0, data: { total: keyId === '1' ? 1 : 0, items: keyId === '1' ? [{
        id: 1001,
        api_key_id: 1,
        request_id: 'request-1001',
        model: 'claude-test',
        stream: true,
        duration_ms: 1200,
        first_token_ms: 300,
        input_tokens: 20,
        output_tokens: 10,
        cache_read_tokens: 5,
        actual_cost: 0.01,
        created_at: new Date().toISOString()
      }] : [] } });
    }
    if (req.url.startsWith('/api/v1/usage/stats')) {
      return json(res, { code: 0, data: { total_cost: 6, total_requests: 3 } });
    }
    if (req.url === '/api/v1/payment/checkout-info') {
      return json(res, { code: 0, data: {} });
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'not found' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const context = createTestContext();
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'Selectable Sub2API',
    adapterType: 'sub2api',
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    authMode: 'token_pair',
    credentials: { accessToken: 'access-token', tokenExpiresAt: Date.now() + 3600000 },
    enabled: true
  });
  const sync = new SyncService({
    db: context.db,
    config: context.config,
    providers,
    http: new HttpClient(context.config),
    metrics: null
  });

  const initial = await sync.run(provider.id);
  assert.equal(initial.keyCount, 3);
  const mappedKeys = context.db.prepare(`
    SELECT id, remote_id FROM remote_keys WHERE connection_id = ? AND remote_id IN ('1', '2')
  `).all(provider.id);
  const insertMapping = context.db.prepare(`
    INSERT INTO sub2api_mappings(
      id, connection_id, key_id, account_id, group_id, role, enabled,
      models_json, config_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'primary', 1, '[]', '{}', ?, ?)
  `);
  for (const key of mappedKeys) {
    insertMapping.run(
      `mapping-${key.remote_id}`,
      provider.id,
      key.id,
      9000 + Number(key.remote_id),
      Number(key.remote_id) * 10,
      new Date().toISOString(),
      new Date().toISOString()
    );
  }
  const mappedOnly = await sync.run(provider.id);
  assert.equal(mappedOnly.keyCount, 3);
  assert.deepEqual([...new Set(requestedUsageKeyIds)].sort(), ['1', '2']);
  requestedUsageKeyIds.length = 0;
  providers.update(provider.id, { typeConfig: { monitoredKeyIds: ['1', '2'] } });

  const selected = await sync.run(provider.id);
  assert.equal(selected.status, 'succeeded');
  assert.equal(selected.keyCount, 2);
  assert.deepEqual(context.db.prepare(`
    SELECT remote_id, status FROM remote_keys WHERE connection_id = ? ORDER BY remote_id
  `).all(provider.id), [
    { remote_id: '1', status: 'active' },
    { remote_id: '2', status: 'active' },
    { remote_id: '3', status: 'missing' }
  ]);
  assert.deepEqual(context.db.prepare(`
    SELECT k.remote_id, g.remote_id AS group_id
    FROM remote_key_groups r
    JOIN remote_keys k ON k.id = r.key_id
    JOIN remote_groups g ON g.id = r.group_id
    WHERE k.connection_id = ? ORDER BY k.remote_id
  `).all(provider.id), [
    { remote_id: '1', group_id: '10' },
    { remote_id: '2', group_id: '20' }
  ]);
  assert.deepEqual(context.db.prepare(`
    SELECT k.remote_id, s.status, s.total_count
    FROM provider_request_key_sync_state s
    JOIN remote_keys k ON k.id = s.key_id
    WHERE k.connection_id = ? AND k.remote_id IN ('1', '2')
    ORDER BY k.remote_id
  `).all(provider.id), [
    { remote_id: '1', status: 'succeeded', total_count: 1 },
    { remote_id: '2', status: 'succeeded', total_count: 0 }
  ]);
  failedUsageKeyId = '2';
  const partial = await sync.run(provider.id, { manual: true });
  assert.equal(partial.status, 'partial');
  assert.equal(partial.warnings.some((warning) => warning.code === 'REQUEST_LOG_KEYS_PARTIAL'), true);
  assert.deepEqual(context.db.prepare(`
    SELECT k.remote_id, s.status
    FROM provider_request_key_sync_state s
    JOIN remote_keys k ON k.id = s.key_id
    WHERE k.connection_id = ? AND k.remote_id IN ('1', '2')
    ORDER BY k.remote_id
  `).all(provider.id), [
    { remote_id: '1', status: 'succeeded' },
    { remote_id: '2', status: 'unavailable' }
  ]);
});

test('Sub2API sync recovers a key-bound private group omitted from the available catalog', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'Private Group Provider', adapterType: 'sub2api', baseUrl: 'https://sub2api.example',
    authMode: 'token_pair',
    credentials: { accessToken: 'access-token', tokenExpiresAt: Date.now() + 3600000 }
  });
  let keyFailure = false;
  const sync = new SyncService({
    db: context.db,
    config: context.config,
    providers,
    http: {
      async requestJson(input) {
        const url = new URL(input);
        if (url.pathname === '/api/v1/user/profile') {
          return { data: { code: 0, data: { id: 7, username: 'user', balance: 10 } } };
        }
        if (url.pathname === '/api/v1/groups/available') {
          return { data: { code: 0, data: [{ id: 3, name: 'Public', rate_multiplier: 1, status: 'active' }] } };
        }
        if (url.pathname === '/api/v1/groups/rates') {
          return { data: { code: 0, data: { 3: 0.8 } } };
        }
        if (url.pathname === '/api/v1/keys') {
          if (keyFailure) {
            throw new AppError('REMOTE_SERVER_ERROR', 'temporary key failure', {
              status: 502, retryable: true
            });
          }
          return { data: { code: 0, data: { items: [{
            id: 9, name: 'Campaign Key', key: 'sk-private-secret', group_id: 40,
            status: 'active', quota: 0, quota_used: 0,
            group: {
              id: 40, name: 'Private Campaign', platform: 'openai',
              rate_multiplier: 0.5, status: 'inactive'
            }
          }], total: 1 } } };
        }
        if (url.pathname === '/api/v1/usage/stats') {
          return { data: { code: 0, data: { total_cost: 0, total_requests: 0 } } };
        }
        if (url.pathname === '/api/v1/usage') {
          return { data: { code: 0, data: { items: [], total: 0 } } };
        }
        if (url.pathname === '/api/v1/payment/checkout-info') {
          return { data: { code: 0, data: { balance_recharge_multiplier: 10 } } };
        }
        throw new Error(`Unexpected ${url.pathname}`);
      }
    }
  });

  const result = await sync.run(provider.id, { manual: true });
  assert.equal(result.status, 'succeeded');
  const group = context.db.prepare(`
    SELECT name, ratio, status, metadata_json FROM remote_groups
    WHERE connection_id = ? AND remote_id = '40'
  `).get(provider.id);
  assert.equal(group.name, 'Private Campaign');
  assert.equal(group.ratio, 0.5);
  assert.equal(group.status, 'inactive');
  assert.equal(JSON.parse(group.metadata_json).derivedFromKey, true);
  const [key] = new QueryService(context.db, context.config).keys({ connectionId: provider.id });
  assert.equal(key.primary_group_ref, '40');
  assert.deepEqual(key.additionalGroups, ['Private Campaign']);

  keyFailure = true;
  const partial = await sync.run(provider.id, { manual: true });
  assert.equal(partial.status, 'partial');
  assert.equal(partial.warnings.some((warning) => warning.capability === 'listKeys'), true);
  const preserved = context.db.prepare(`
    SELECT name, ratio, status FROM remote_groups
    WHERE connection_id = ? AND remote_id = '40'
  `).get(provider.id);
  assert.deepEqual(preserved, { name: 'Private Campaign', ratio: 0.5, status: 'inactive' });
});

test('Sub2API API Key sync keeps per-key rates, usage and mapping comparisons independent', async (t) => {
  let failedBillingToken = null;
  const requestedTokens = [];
  const fixtures = {
    'sk-low-12345678': { remaining: 9, used: 1, rate: 0.1 },
    'sk-high-12345678': { remaining: 17, used: 3, rate: 0.25 }
  };
  const server = http.createServer((req, res) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const fixture = fixtures[token];
    if (!fixture) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ message: 'invalid key' }));
    }
    requestedTokens.push(token);
    if (req.url === '/v1/usage') {
      return json(res, {
        isValid: true,
        remaining: fixture.remaining,
        unit: 'USD',
        usage: {
          today: {
            requests: 1,
            cost: fixture.used,
            actual_cost: fixture.used / 10,
            cache_creation_tokens: 2,
            cache_read_tokens: 8
          },
          total: {
            requests: 4,
            cost: fixture.used,
            actual_cost: fixture.used / 10,
            cache_creation_tokens: 5,
            cache_read_tokens: 20
          }
        }
      });
    }
    if (req.url === '/v1/sub2api/billing') {
      if (token === failedBillingToken) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ message: 'temporary billing failure' }));
      }
      return json(res, {
        billing_scope: 'token',
        effective_rate_multiplier: fixture.rate
      });
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'not found' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const context = createTestContext();
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'Multi-key gateway',
    adapterType: 'sub2api',
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    authMode: 'api_key',
    credentials: {
      apiKeys: [
        { id: 'low', name: 'Low route', key: 'sk-low-12345678' },
        { id: 'high', name: 'High route', key: 'sk-high-12345678' }
      ]
    },
    enabled: true
  });
  assert.deepEqual(provider.configuredApiKeys.map((entry) => entry.id), ['low', 'high']);

  const sync = new SyncService({
    db: context.db,
    config: context.config,
    providers,
    http: new HttpClient(context.config),
    metrics: null
  });
  const result = await sync.run(provider.id);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.keyCount, 2);
  assert.equal(result.groupCount, 2);
  assert.equal(result.usageCount, 4);

  const keys = context.db.prepare(`
    SELECT id, remote_id, primary_group_ref, quota_remaining
    FROM remote_keys WHERE connection_id = ? ORDER BY remote_id
  `).all(provider.id);
  assert.deepEqual(keys.map((key) => [key.remote_id, key.primary_group_ref, key.quota_remaining]), [
    ['high', 'configured-api-key:high', 17],
    ['low', 'configured-api-key:low', 9]
  ]);
  const groups = context.db.prepare(`
    SELECT remote_id, ratio FROM remote_groups
    WHERE connection_id = ? AND status != 'missing' ORDER BY remote_id
  `).all(provider.id);
  assert.deepEqual(groups, [
    { remote_id: 'configured-api-key:high', ratio: 0.25 },
    { remote_id: 'configured-api-key:low', ratio: 0.1 }
  ]);
  const usageSubjects = context.db.prepare(`
    SELECT DISTINCT subject_id FROM usage_snapshots
    WHERE connection_id = ? AND subject_type = 'key' ORDER BY subject_id
  `).all(provider.id).map((row) => row.subject_id);
  assert.deepEqual(usageSubjects, keys.map((key) => key.id).sort());
  const storedUsage = context.db.prepare(`
    SELECT cost, raw_json FROM usage_snapshots
    WHERE connection_id = ? AND subject_id = ? AND period = 'cumulative'
    ORDER BY captured_at DESC LIMIT 1
  `).get(provider.id, keys.find((key) => key.remote_id === 'low').id);
  const storedRaw = JSON.parse(storedUsage.raw_json);
  assert.equal(storedUsage.cost, 0.1);
  assert.equal(storedRaw.cache_read_tokens, '***');
  assert.equal(storedRaw.monitorMetrics.actualCost, 0.1);
  assert.equal(storedRaw.monitorMetrics.cacheCreationCount, 5);
  assert.equal(storedRaw.monitorMetrics.cacheReadCount, 20);
  assert.equal(storedRaw.monitorMetrics.averageDurationMs, null);
  assert.match(storedRaw.monitorMetrics.credentialIdentity, /^[a-f0-9]{64}$/);

  failedBillingToken = 'sk-high-12345678';
  const partial = await sync.run(provider.id);
  assert.equal(partial.status, 'partial');
  assert.equal(partial.warnings.some((warning) => warning.capability === 'configuredApiKey'), true);
  const preservedHighKey = context.db.prepare(`
    SELECT primary_group_ref FROM remote_keys
    WHERE connection_id = ? AND remote_id = 'high'
  `).get(provider.id);
  assert.equal(preservedHighKey.primary_group_ref, 'configured-api-key:high');
  assert.equal(context.db.prepare(`
    SELECT status FROM remote_groups
    WHERE connection_id = ? AND remote_id = 'configured-api-key:high'
  `).get(provider.id).status, 'active');

  const sub2api = {
    authenticationStatus: () => ({ available: true, source: 'test' }),
    async data(endpoint) {
      if (endpoint === '/api/v1/admin/groups/all') {
        return [
          { id: 7, name: 'Low target', status: 'active', rate_multiplier: 0.1 },
          { id: 8, name: 'High target', status: 'active', rate_multiplier: 0.25 }
        ];
      }
      if (endpoint === '/api/v1/groups/rates') return { 7: 0.1, 8: 0.25 };
      throw new Error(`Unexpected endpoint ${endpoint}`);
    }
  };
  const mappings = new MappingService({ db: context.db, config: context.config, sub2api });
  mappings.save({ connectionId: provider.id, keyId: keys.find((key) => key.remote_id === 'low').id, groupId: 7 });
  mappings.save({ connectionId: provider.id, keyId: keys.find((key) => key.remote_id === 'high').id, groupId: 8 });
  const comparison = await mappings.refreshComparisons();
  assert.deepEqual(comparison.items.map((item) => [
    item.key_name,
    item.comparison.providerGroupRef,
    item.comparison.providerRate,
    item.comparison.status
  ]).sort((left, right) => left[0].localeCompare(right[0])), [
    ['High route', 'configured-api-key:high', 0.25, 'aligned'],
    ['Low route', 'configured-api-key:low', 0.1, 'aligned']
  ]);

  failedBillingToken = null;
  requestedTokens.length = 0;
  providers.update(provider.id, { typeConfig: { monitoredKeyIds: ['low'] } });
  const selected = await sync.run(provider.id);
  assert.equal(selected.status, 'succeeded');
  assert.equal(selected.keyCount, 1);
  assert.equal(selected.groupCount, 1);
  assert.deepEqual([...new Set(requestedTokens)], ['sk-low-12345678']);
  assert.deepEqual(context.db.prepare(`
    SELECT remote_id, status FROM remote_keys WHERE connection_id = ? ORDER BY remote_id
  `).all(provider.id), [
    { remote_id: 'high', status: 'missing' },
    { remote_id: 'low', status: 'active' }
  ]);
  const selectedComparison = await mappings.refreshComparisons();
  const missingHigh = selectedComparison.items.find((item) => item.key_name === 'High route');
  assert.equal(missingHigh.comparison.status, 'missing_remote_key');
  assert.equal(missingHigh.comparison.providerRate, null);
});

test('missing optional group endpoint produces a partial sync without losing balance', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/status') return json(res, { success: true, data: { quota_per_unit: 500000 } });
    if (req.url === '/api/user/self') return json(res, { success: true, data: { id: 1, username: 'user', quota: 500000, used_quota: 0, status: 1 } });
    if (req.url.startsWith('/api/log/self/stat')) return json(res, { success: true, data: { quota: 0 } });
    if (req.url.startsWith('/api/token/')) return json(res, { success: true, data: { items: [], total: 0 } });
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'unsupported' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const context = createTestContext();
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'Partial API', adapterType: 'new-api', baseUrl: `http://127.0.0.1:${server.address().port}`,
    authMode: 'system_token', remoteUserId: '1', credentials: { systemToken: 'token' }
  });
  const sync = new SyncService({ db: context.db, config: context.config, providers, http: new HttpClient(context.config) });
  const result = await sync.run(provider.id);
  assert.equal(result.status, 'partial');
  assert.equal(result.balanceCount, 1);
  assert.equal(result.warnings[0].capability, 'listGroups');
});

test('optional key failure preserves previously synchronized groups and relations', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'OneHub', adapterType: 'one-hub', baseUrl: 'https://onehub.example',
    authMode: 'system_token', remoteUserId: '7', credentials: { systemToken: 'token' }
  });
  let keyFailure = false;
  const sync = new SyncService({
    db: context.db, config: context.config, providers,
    http: {
      async requestJson(input) {
        const url = new URL(input);
        if (url.pathname === '/api/status') return { data: { success: true, data: { quota_per_unit: 500000 } } };
        if (url.pathname === '/api/user/self') return { data: { success: true, data: { id: 7, username: 'user', quota: 5000000, used_quota: 0 } } };
        if (url.pathname === '/api/token/') {
          if (keyFailure) throw new AppError('REMOTE_SERVER_ERROR', 'temporary key endpoint failure', { status: 502, retryable: true });
          return { data: { success: true, data: { data: [{ id: 1, name: 'client', remain_quota: 1000000, used_quota: 0, group: 'primary', backup_group: 'backup' }], total_count: 1 } } };
        }
        if (url.pathname === '/api/log/self/stat') return { data: { success: true, data: { quota: 0 } } };
        throw new Error(`Unexpected ${url.pathname}`);
      }
    }
  });
  await sync.run(provider.id);
  keyFailure = true;
  const second = await sync.run(provider.id);
  assert.equal(second.status, 'partial');
  const assets = new QueryService(context.db, context.config).providerAssets(provider.id);
  assert.equal(assets.keys[0].status, 'enabled');
  assert.deepEqual(assets.keys[0].additionalGroups.sort(), ['backup', 'primary']);
  assert.deepEqual(assets.groups.map((group) => group.status), ['active', 'active']);
});

test('post-sync failure degrades the run without invalidating persisted balance', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'DeepSeek', adapterType: 'deepseek', baseUrl: 'https://api.deepseek.com',
    authMode: 'api_key', credentials: { apiKey: 'secret' }
  });
  const sync = new SyncService({
    db: context.db, config: context.config, providers,
    http: { async requestJson() { return { data: { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '8' }] } }; } },
    onCompleted: async () => { throw new Error('alert backend unavailable'); }
  });
  const result = await sync.run(provider.id);
  assert.equal(result.status, 'partial');
  assert.equal(result.warnings.some((warning) => warning.capability === 'postSync'), true);
  assert.equal(providers.get(provider.id).last_error_code, null);
  assert.equal(new QueryService(context.db, context.config).summary().accounts[0].available, 8);
});

test('detected recharge multiplier is retained while a manual override controls the effective value', (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'Recharge Supplier', adapterType: 'new-api', baseUrl: 'https://recharge.example',
    authMode: 'system_token', credentials: { systemToken: 'secret', userId: '7' }
  });

  let recharge = providers.get(provider.id).recharge;
  assert.equal(recharge.multiplier, 1);
  assert.equal(recharge.source, 'default');
  assert.equal(recharge.status, 'default');

  providers.recordRecharge(provider.id, {
    available: true,
    multiplier: 10,
    paidAmount: 1,
    creditedAmount: 10,
    paidCurrency: 'CNY',
    balanceCurrency: 'USD',
    source: 'provider_quote'
  });
  recharge = providers.get(provider.id).recharge;
  assert.equal(recharge.multiplier, 10);
  assert.equal(recharge.source, 'provider_quote');
  assert.equal(recharge.status, 'detected');

  providers.update(provider.id, { rechargeMultiplier: 8 });
  recharge = providers.get(provider.id).recharge;
  assert.equal(recharge.multiplier, 8);
  assert.equal(recharge.manualMultiplier, 8);
  assert.equal(recharge.detectedMultiplier, 10);
  assert.equal(recharge.source, 'manual');

  providers.recordRecharge(provider.id, {
    available: false,
    source: 'provider_quote',
    errorCode: 'REMOTE_REQUEST_FAILED'
  });
  providers.update(provider.id, { rechargeMultiplier: null });
  recharge = providers.get(provider.id).recharge;
  assert.equal(recharge.multiplier, 10);
  assert.equal(recharge.source, 'provider_quote');
  assert.equal(recharge.status, 'unavailable');
  assert.equal(recharge.errorCode, 'REMOTE_REQUEST_FAILED');
});

test('sync calls for one provider share in-flight work and scheduled circuit can be manually bypassed', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'DeepSeek', adapterType: 'deepseek', baseUrl: 'https://api.deepseek.com',
    authMode: 'api_key', credentials: { apiKey: 'secret' }
  });
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const sync = new SyncService({
    db: context.db, config: context.config, providers,
    http: { async requestJson() { calls += 1; await gate; return { data: { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '9' }] } }; } }
  });
  const first = sync.run(provider.id);
  const second = sync.run(provider.id);
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(firstResult.runId, secondResult.runId);

  const insert = context.db.prepare(`
    INSERT INTO check_runs(id, job_type, connection_id, status, started_at, completed_at, error_code)
    VALUES (?, 'provider_sync', ?, 'failed', ?, ?, 'REMOTE_SERVER_ERROR')
  `);
  for (let index = 0; index < 5; index += 1) {
    const at = new Date(Date.now() + 1000 + index).toISOString();
    insert.run(`failed-${index}`, provider.id, at, at);
  }
  await assert.rejects(sync.run(provider.id), (error) => error.code === 'CIRCUIT_OPEN');
  const manual = await sync.run(provider.id, { manual: true, jobType: 'manual_sync' });
  assert.equal(manual.status, 'succeeded');
});
