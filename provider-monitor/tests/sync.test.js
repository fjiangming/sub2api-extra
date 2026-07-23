const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createTestContext } = require('./helpers');
const { ProviderRepository } = require('../src/repositories/provider-repository');
const { HttpClient } = require('../src/http/client');
const { SyncService } = require('../src/services/sync-service');
const { QueryService } = require('../src/services/query-service');
const { AppError } = require('../src/errors');
const { nowIso } = require('../src/db');

function json(res, body) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

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
      dynamicRouteRate: { enabled: true, statistic: 'latest', lookbackDays: 30, minimumSamples: 1 }
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
