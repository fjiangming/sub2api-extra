'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');
const { ProviderRepository } = require('../src/repositories/provider-repository');
const { LatencySamplesService } = require('../src/services/latency-samples-service');
const { createApplication } = require('../src/server');

test('latency integration scopes samples to the mapped provider key and exposes no credentials', async (t) => {
  const token = 'latency-integration-token-0123456789abcdef';
  const context = createTestContext({ PROVIDER_MONITOR_INTEGRATION_TOKEN: token });
  const provider = new ProviderRepository(context.db, context.config).create({
    name: 'Latency Vendor', adapterType: 'custom', baseUrl: 'https://provider.example', authMode: 'api_key',
    credentials: { apiKey: 'must-not-leak' }, enabled: true
  });
  const at = '2026-10-20T00:00:00.000Z';
  for (const key of ['mapped', 'other']) context.db.prepare(`INSERT INTO remote_keys
    (id, connection_id, remote_id, name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(key, provider.id, key, key, at, at);
  context.db.prepare(`INSERT INTO sub2api_mappings (id, connection_id, key_id, account_id, created_at, updated_at)
    VALUES ('mapping', ?, 'mapped', 270, ?, ?)`).run(provider.id, at, at);
  for (const [key, source] of [['mapped', '1'], ['mapped', '2'], ['other', '3']]) {
    context.db.prepare(`INSERT INTO provider_request_samples
      (connection_id, key_id, source_log_id, request_id, model, stream, status, duration_ms, first_token_ms, created_at, ingested_at)
      VALUES (?, ?, ?, ?, 'gpt', 1, 'success', 32940, 21610, ?, ?)`).run(provider.id, key, source, `remote-${source}`, at, at);
  }
  const service = new LatencySamplesService(context.db);
  const query = { accountId: '270', from: '2026-10-19T23:59:00Z', to: '2026-10-20T01:00:00Z' };
  assert.equal(service.query(query).items.length, 2);
  assert.equal(service.query({ ...query, accountId: '271' }).items.length, 0);
  assert.equal(service.query({ ...query, limit: '1' }).truncated, true);
  assert.throws(() => service.query({ ...query, accountId: '270 OR 1=1' }));
  assert.throws(() => service.query({ ...query, to: '2026-11-20T00:00:00Z' }));
  const app = createApplication({ config: context.config, db: context.db, startBackground: false });
  const server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await app.locals.close(); context.cleanup(); });
  const url = `http://127.0.0.1:${server.address().port}/api/integrations/latency-samples?${new URLSearchParams(query)}`;
  assert.equal((await fetch(url)).status, 401);
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(text.includes('must-not-leak'), false);
  assert.equal(text.includes('provider.example'), false);
  assert.equal(text.includes('remote-3'), false);
  assert.equal(JSON.parse(text).items.length, 2);
});

test('historical mappings only expose samples from the interval when the account used that key', (t) => {
  const context = createTestContext(); t.after(() => context.cleanup());
  const provider = new ProviderRepository(context.db, context.config).create({
    name: 'Historical Vendor', adapterType: 'custom', baseUrl: 'https://provider.example', authMode: 'api_key',
    credentials: { apiKey: 'key' }, enabled: true
  });
  const start = '2026-10-20T00:00:00.000Z', change = '2026-10-20T00:30:00.000Z';
  for (const key of ['before', 'after']) context.db.prepare(`INSERT INTO remote_keys
    (id, connection_id, remote_id, name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(key, provider.id, key, key, start, start);
  context.db.prepare(`INSERT INTO sub2api_mappings (id, connection_id, key_id, account_id, created_at, updated_at)
    VALUES ('mapping', ?, 'before', 270, ?, ?)`).run(provider.id, start, start);
  context.db.prepare("UPDATE sub2api_mappings SET key_id = 'after', updated_at = ? WHERE id = 'mapping'").run(change);
  for (const [key, logId, at] of [
    ['before', 'valid-before', '2026-10-20T00:15:00.000Z'], ['after', 'too-early', '2026-10-20T00:15:00.000Z'],
    ['before', 'too-late', '2026-10-20T00:45:00.000Z'], ['after', 'valid-after', '2026-10-20T00:45:00.000Z']
  ]) context.db.prepare(`INSERT INTO provider_request_samples
    (connection_id, key_id, source_log_id, request_id, created_at, ingested_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(provider.id, key, logId, logId, at, at);
  const result = new LatencySamplesService(context.db).query({ accountId: '270', from: start, to: '2026-10-20T01:00:00Z' });
  assert.deepEqual(result.items.map((row) => row.request_id).sort(), ['valid-after', 'valid-before']);
  assert.equal(result.mappings.every((row) => row.scope === 'history'), true);
});
