'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createTestContext } = require('./helpers');
const { createDatabase } = require('../src/db');
const { ProviderRepository } = require('../src/repositories/provider-repository');
const { SyncService } = require('../src/services/sync-service');
const { LatencySamplesService } = require('../src/services/latency-samples-service');
const { Sub2ApiAdapter } = require('../src/adapters/sub2api');
const { OneApiFamilyAdapter } = require('../src/adapters/one-api-family');
const { createApplication } = require('../src/server');

function mapped(context) {
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({ name: 'Reconciliation vendor', adapterType: 'new-api',
    baseUrl: 'https://vendor.example', authMode: 'system_token', remoteUserId: '7',
    credentials: { systemToken: 'private-credential' }, enabled: true });
  const at = new Date(Date.now() - 3 * 3600000).toISOString();
  context.db.prepare(`INSERT INTO remote_keys(id,connection_id,remote_id,name,first_seen_at,last_seen_at)
    VALUES('mapped',?,'9','business-key',?,?)`).run(provider.id, at, at);
  context.db.prepare(`INSERT INTO sub2api_mappings(id,connection_id,key_id,account_id,created_at,updated_at)
    VALUES('billing-mapping',?,'mapped',3,?,?)`).run(provider.id, at, at);
  return { providers, provider };
}

test('targeted refresh reads historical mapped business logs, retains final tokens and never runs inference', async t => {
  const context = createTestContext(); t.after(() => context.cleanup());
  const { providers, provider } = mapped(context); const calls = [];
  const occurred = Math.floor((Date.now() - 30 * 60000) / 1000);
  const http = { requestJson: async input => {
    const url = new URL(input); calls.push(url.pathname);
    if (url.pathname === '/api/status') return { data: { success: true, data: { quota_per_unit: 500000 } } };
    assert.equal(url.pathname, '/api/log/self');
    return { data: { success: true, data: { total: 2, items: [
      { id: 1, token_id: 9, token_name: 'business-key', request_id: 'client:dispatch',
        created_at: occurred, model_name: 'test', prompt_tokens: 30, completion_tokens: 40, quota: 100 },
      { id: 2, token_id: 10, token_name: 'business-key', request_id: 'other-user',
        created_at: occurred, model_name: 'test', prompt_tokens: 99, completion_tokens: 99, quota: 200 }
    ] } } };
  } };
  const sync = new SyncService({ db: context.db, config: context.config, providers, http });
  const query = { accountId: '3', from: new Date(Date.now() - 3600000).toISOString(), to: new Date().toISOString() };
  const result = await sync.refreshBillingSamples(query);
  assert.equal(result.results[0].count, 1);
  const row = context.db.prepare('SELECT * FROM provider_request_samples').get();
  assert.equal(row.key_id, 'mapped'); assert.equal(row.input_tokens, 30); assert.equal(row.output_tokens, 40);
  assert.equal(row.usage_complete, 1); assert.equal(row.actual_cost, 0.0002);
  assert.equal(context.db.prepare('SELECT count(*) n FROM provider_request_log_sync_state').get().n, 0,
    'targeted reads must not claim the entire provider was synchronized');
  const samples = new LatencySamplesService(context.db).query(query);
  assert.equal(samples.items.length, 1); assert.equal(samples.items[0].usage_complete, 1);
  assert.equal(samples.billingCoverageComplete, true);
  const count = calls.length;
  assert.equal((await sync.refreshBillingSamples(query)).results[0].status, 'cooldown');
  assert.equal(calls.length, count);
  context.db.prepare(`UPDATE provider_request_key_sync_state SET last_error_code='RATE_LIMITED',updated_at=?`)
    .run(new Date(Date.now() - 4 * 60000).toISOString());
  assert.equal((await sync.refreshBillingSamples(query)).results[0].status, 'cooldown');
  sync.inFlight.set(provider.id, Promise.resolve());
  assert.equal((await sync.refreshBillingSamples(query)).results[0].status, 'busy');
  sync.inFlight.delete(provider.id);
  assert.equal((await sync.refreshBillingSamples({ ...query, accountId: '4' })).status, 'mapping_missing');
  assert.ok(calls.every(url => ['/api/status', '/api/log/self'].includes(url)));
});

test('usage completeness migration preserves existing samples and leaves legacy token certainty unknown', t => {
  const context = createTestContext(); let reopened;
  t.after(() => { reopened?.close(); context.cleanup(); });
  const { provider } = mapped(context);
  const at = new Date().toISOString();
  context.db.prepare(`INSERT INTO provider_request_samples(connection_id,key_id,source_log_id,input_tokens,output_tokens,created_at,ingested_at)
    VALUES(?,'mapped','old-log',30,40,?,?)`).run(provider.id, at, at);
  context.db.exec('ALTER TABLE provider_request_samples DROP COLUMN usage_complete; DELETE FROM schema_migrations WHERE version=33');
  context.db.close(); reopened = createDatabase(path.join(context.directory, 'test.db'));
  const row = reopened.prepare("SELECT input_tokens,output_tokens,usage_complete FROM provider_request_samples WHERE source_log_id='old-log'").get();
  assert.deepEqual(row, { input_tokens: 30, output_tokens: 40, usage_complete: null });
  assert.equal(reopened.prepare('SELECT count(*) n FROM schema_migrations WHERE version=33').get().n, 1);
});

test('Sub2API targeted pagination stops below the requested window instead of downloading a full day', async () => {
  const now = Date.now(); let pages = 0;
  const rows = Array.from({ length: 100 }, (_, index) => ({ id: index, api_key_id: 9, input_tokens: 10,
    output_tokens: index === 0 ? undefined : 2, created_at: new Date(now - (index + 1) * 60000).toISOString() }));
  const adapter = new Sub2ApiAdapter({ connection: { base_url: 'https://vendor.example', auth_mode: 'token_pair', type_config_json: {} },
    credentials: { accessToken: 'test', tokenExpiresAt: now + 3600000 }, config: { timezone: 'UTC' },
    http: { requestJson: async input => {
      const url = new URL(input); assert.equal(url.pathname, '/api/v1/usage');
      assert.equal(url.searchParams.get('sort_order'), 'desc'); pages++;
      return { data: { code: 0, data: { total: 20000, items: rows } } };
    } } });
  const result = await adapter.getRequestLogs({ keys: [{ remoteId: '9', name: 'mapped' }],
    since: new Date(now - 5 * 60000).toISOString(), until: new Date(now).toISOString(), maxRecords: 1000 });
  assert.equal(pages, 1); assert.equal(result.items.length, 5); assert.equal(result.truncated, false);
  assert.equal(result.items[0].usageComplete, false); assert.equal(result.items[1].usageComplete, true);
});

test('billing sample refresh enforces integration authorization and validates time windows', async t => {
  const token = 'billing-integration-token-0123456789abcdef';
  const context = createTestContext({ PROVIDER_MONITOR_INTEGRATION_TOKEN: token });
  const app = createApplication({ config: context.config, db: context.db, startBackground: false });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await app.locals.close(); context.cleanup(); });
  const url = `http://127.0.0.1:${server.address().port}/api/integrations/billing-samples/refresh`;
  const headers = { 'content-type': 'application/json' };
  assert.equal((await fetch(url, { method: 'POST', headers, body: '{}' })).status, 401);
  headers.authorization = `Bearer ${token}`;
  assert.equal((await fetch(url, { method: 'POST', headers, body: '{}' })).status, 400);
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ accountId: '3',
    from: '2026-10-20T00:00:00Z', to: '2026-10-20T01:00:00Z' }) });
  assert.equal(response.status, 200); assert.equal((await response.json()).status, 'mapping_missing');
  assert.equal((await fetch(url.replace('/integrations', ''), { method: 'POST', headers, body: '{}' })).status, 401);
});

test('provider billing samples never confirm rounded, negative or malformed token dimensions', async () => {
  const now = Date.now();
  const subRows = [
    { input_tokens: 10.5, output_tokens: 2 },
    { input_tokens: true, output_tokens: 2 },
    { input_tokens: 10, output_tokens: 2, cache_read_tokens: 'unknown' },
    { input_tokens: 10, output_tokens: 2, cache_creation_tokens: -1 },
    { input_tokens: 10, output_tokens: 2, cache_read_tokens: 0 }
  ].map((row, index) => ({ ...row, id: index, api_key_id: 9, created_at: new Date(now - 60000).toISOString() }));
  const common = { connection: { base_url: 'https://vendor.example', auth_mode: 'token_pair', type_config_json: {} },
    credentials: { accessToken: 'test', tokenExpiresAt: now + 3600000 }, config: { timezone: 'UTC' } };
  const sub = new Sub2ApiAdapter({ ...common, http: { requestJson: async () =>
    ({ data: { code: 0, data: { total: subRows.length, items: subRows } } }) } });
  const result = await sub.getRequestLogs({ keys: [{ remoteId: '9', name: 'mapped' }], maxRecords: 100 });
  assert.deepEqual(result.items.map(row => row.usageComplete), [false, false, false, false, true]);
  const apiRows = [
    { prompt_tokens: 10, completion_tokens: 2.5 },
    { prompt_tokens: 10, completion_tokens: 2, other: { cache_tokens: 11 } },
    { prompt_tokens: 10, completion_tokens: 2, other: { cache_creation_tokens: 5 } },
    { prompt_tokens: '10', completion_tokens: '2', other: { cache_tokens: '3' } }
  ].map((row, index) => ({ ...row, id: index, token_id: 9, created_at: Math.floor((now - 60000) / 1000) }));
  const api = new OneApiFamilyAdapter({ ...common, connection: { ...common.connection, adapter_type: 'new-api' },
    http: { requestJson: async input => ({ data: input.includes('/api/status')
      ? { success: true, data: { quota_per_unit: 500000 } }
      : { success: true, data: { total: apiRows.length, items: apiRows } } }) } });
  assert.deepEqual((await api.getRequestLogs({ keys: [{ remoteId: '9' }], restrictToKeys: true }))
    .items.map(row => row.usageComplete), [false, false, false, true]);
});
