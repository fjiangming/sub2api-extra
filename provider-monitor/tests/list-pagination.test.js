const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');
const { ProviderRepository } = require('../src/repositories/provider-repository');
const { createApplication } = require('../src/server');

function seedLists(context, connectionId) {
  const baseTime = Date.parse('2026-07-25T10:00:00.000Z');
  const keyId = 'pagination-key';
  context.db.prepare(`
    INSERT INTO remote_keys(
      id, connection_id, remote_id, name, masked_key, status, unlimited,
      metadata_json, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, 'active', 0, '{}', ?, ?)
  `).run(keyId, connectionId, keyId, 'Pagination Key', 'sk-...test', new Date(baseTime).toISOString(), new Date(baseTime).toISOString());

  const insertGroup = context.db.prepare(`
    INSERT INTO remote_groups(
      id, connection_id, remote_id, group_type, name, ratio, status,
      metadata_json, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, 'key_route_group', ?, 1, 'active', '{}', ?, ?)
  `);
  const insertPrice = context.db.prepare(`
    INSERT INTO model_prices(
      connection_id, model_id, currency, billing_mode, input_per_million,
      raw_json, captured_at
    ) VALUES (?, ?, 'USD', 'token', ?, '{}', ?)
  `);
  const insertChange = context.db.prepare(`
    INSERT INTO asset_change_events(
      id, connection_id, asset_type, asset_id, remote_id, change_type,
      severity, before_json, after_json, detected_at
    ) VALUES (?, ?, 'key', ?, ?, 'updated', 'info', '{}', '{}', ?)
  `);
  const insertAnomaly = context.db.prepare(`
    INSERT INTO anomaly_events(
      id, connection_id, anomaly_type, severity, subject_type, subject_id,
      message, score, details_json, detected_at, resolved_at, fingerprint
    ) VALUES (?, ?, 'balance_drop', 'warning', 'account', ?, ?, 1, '{}', ?, ?, ?)
  `);
  const insertHealth = context.db.prepare(`
    INSERT INTO key_health_checks(
      id, connection_id, key_id, level, status, details_json, checked_at
    ) VALUES (?, ?, ?, 'metadata', ?, '{}', ?)
  `);
  const insertCheck = context.db.prepare(`
    INSERT INTO check_runs(
      id, job_type, connection_id, status, started_at, summary_json
    ) VALUES (?, 'provider_sync', ?, 'succeeded', ?, '{}')
  `);
  const insertJob = context.db.prepare(`
    INSERT INTO jobs(
      id, type, connection_id, payload_json, status, priority, run_after,
      created_at, updated_at
    ) VALUES (?, 'provider_sync', ?, '{}', 'succeeded', 0, ?, ?, ?)
  `);
  const insertAudit = context.db.prepare(`
    INSERT INTO audit_logs(actor_name, action, target_type, target_id, details_json, created_at)
    VALUES ('admin', 'pagination.test', 'provider', ?, '{}', ?)
  `);

  for (let index = 0; index < 5; index += 1) {
    const timestamp = new Date(baseTime - index * 1000).toISOString();
    const id = String(index);
    insertGroup.run(`group-${id}`, connectionId, `remote-group-${id}`, `Group ${id}`, timestamp, timestamp);
    insertPrice.run(connectionId, `model-${id}`, index + 1, timestamp);
    insertChange.run(`change-${id}`, connectionId, `key-${id}`, `remote-key-${id}`, timestamp);
    insertAnomaly.run(
      `anomaly-${id}`, connectionId, `account-${id}`, `Anomaly ${id}`, timestamp,
      index % 2 === 0 ? null : timestamp, `fingerprint-${id}`
    );
    insertHealth.run(`health-${id}`, connectionId, keyId, index % 2 === 0 ? 'passed' : 'failed', timestamp);
    insertCheck.run(`check-${id}`, connectionId, timestamp);
    insertJob.run(`job-${id}`, connectionId, timestamp, timestamp, timestamp);
    insertAudit.run(connectionId, timestamp);
  }
}

test('large operational list endpoints return bounded pages with totals', async (t) => {
  const context = createTestContext();
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'Pagination Provider',
    adapterType: 'custom',
    baseUrl: 'https://pagination.example',
    authMode: 'api_key',
    credentials: { apiKey: 'secret' },
    enabled: false
  });
  seedLists(context, provider.id);

  const app = createApplication({ config: context.config, db: context.db, startBackground: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await app.locals.close();
    context.cleanup();
  });

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-password' })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const request = async (path) => {
    const response = await fetch(`${base}${path}`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200, path);
    return response.json();
  };

  const paths = [
    '/api/groups?excludeMissing=true&page=2&pageSize=2',
    '/api/asset-changes?page=2&pageSize=2',
    '/api/anomalies?page=2&pageSize=2',
    '/api/key-health?page=2&pageSize=2',
    '/api/checks?page=2&pageSize=2',
    '/api/jobs?page=2&pageSize=2',
    '/api/audit-logs?page=2&pageSize=2'
  ];
  const results = await Promise.all(paths.map(request));
  for (const result of results) {
    assert.equal(result.items.length, 2);
    assert.deepEqual(
      {
        page: result.pagination.page,
        pageSize: result.pagination.pageSize,
        total: result.pagination.total,
        totalPages: result.pagination.totalPages
      },
      { page: 2, pageSize: 2, total: 5, totalPages: 3 }
    );
  }

  const prices = await request('/api/prices?page=99&pageSize=2');
  assert.equal(prices.items.length, 1);
  assert.equal(prices.pagination.page, 3);
  assert.equal(prices.pagination.total, 5);
  assert.equal(prices.summary.models, 5);

  const anomalies = results[2];
  assert.equal(anomalies.summary.active, 3);
  const health = results[3];
  assert.deepEqual(health.summary, { passed: 3, failed: 2 });

  const modelOptions = await request('/api/models/options?query=model&limit=2');
  assert.equal(modelOptions.items.length, 2);
  assert.equal(modelOptions.total, 5);

  const legacyJobs = await request('/api/jobs?limit=3');
  assert.equal(legacyJobs.items.length, 3);
  assert.equal(legacyJobs.pagination, undefined);

  const otherProvider = providers.create({
    name: 'Other Catalog Provider',
    adapterType: 'custom',
    baseUrl: 'https://other-catalog.example',
    authMode: 'api_key',
    credentials: { apiKey: 'other-secret' },
    enabled: false
  });
  const now = new Date().toISOString();
  const updateGroup = context.db.prepare(`
    UPDATE remote_groups SET ratio = ?, metadata_json = ? WHERE id = ?
  `);
  updateGroup.run(0.4, JSON.stringify({ platform: 'openai' }), 'group-0');
  updateGroup.run(0.8, JSON.stringify({ platform: 'openai' }), 'group-1');
  updateGroup.run(0.1, JSON.stringify({ platform: 'anthropic' }), 'group-2');
  context.db.prepare(`
    INSERT INTO remote_groups(
      id, connection_id, remote_id, group_type, name, ratio, status,
      metadata_json, first_seen_at, last_seen_at
    ) VALUES ('other-group', ?, 'other-group', 'key_route_group', 'Other Group',
      0.95, 'active', '{"platform":"openai"}', ?, ?)
  `).run(otherProvider.id, now, now);
  const insertNoRatioGroup = context.db.prepare(`
    INSERT INTO remote_groups(
      id, connection_id, remote_id, group_type, name, ratio, status,
      metadata_json, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, 'key_route_group', ?, NULL, 'active', ?, ?, ?)
  `);
  insertNoRatioGroup.run(
    'unresolved-derived-group', provider.id, '40', '40',
    JSON.stringify({ derivedFromKey: true }), now, now
  );
  insertNoRatioGroup.run(
    'inventory-only-group', provider.id, 'inventory-only', 'Inventory Only',
    '{}', now, now
  );

  const allAssetGroups = await request('/api/groups');
  assert.equal(allAssetGroups.items.some((item) => item.id === 'unresolved-derived-group'), true);
  const visibleAssetGroups = await request('/api/groups?excludeUnresolved=true');
  assert.equal(visibleAssetGroups.items.some((item) => item.id === 'unresolved-derived-group'), false);
  assert.equal(visibleAssetGroups.items.some((item) => item.id === 'inventory-only-group'), true);
  const pricedGroups = await request('/api/groups?excludeMissing=true&requireRatio=true&page=1&pageSize=20');
  assert.equal(pricedGroups.pagination.total, 6);
  assert.equal(pricedGroups.items.every((item) => item.ratio != null), true);

  const updatePrice = context.db.prepare(`
    UPDATE model_prices SET raw_json = ? WHERE connection_id = ? AND model_id = ?
  `);
  updatePrice.run(JSON.stringify({ platform: 'openai', groupRatio: 0.4 }), provider.id, 'model-0');
  updatePrice.run(JSON.stringify({ platform: 'openai', groupRatio: 0.8 }), provider.id, 'model-1');
  updatePrice.run(JSON.stringify({ platform: 'anthropic', groupRatio: 0.1 }), provider.id, 'model-2');
  context.db.prepare(`
    INSERT INTO model_prices(
      connection_id, model_id, currency, billing_mode, input_per_million,
      raw_json, captured_at
    ) VALUES (?, 'other-model', 'USD', 'token', 1,
      '{"platform":"openai","groupRatio":0.95}', ?)
  `).run(otherProvider.id, now);
  const insertRecharge = context.db.prepare(`
    INSERT INTO provider_recharge_rates(
      connection_id, manual_multiplier, status, metadata_json, updated_at
    ) VALUES (?, ?, 'manual', '{}', ?)
  `);
  insertRecharge.run(provider.id, 2, now);
  insertRecharge.run(otherProvider.id, 10, now);

  const combinedGroupQuery = new URLSearchParams({
    excludeMissing: 'true', page: '1', pageSize: '10', connectionId: provider.id,
    platform: 'openai', rateSort: 'desc'
  });
  const filteredGroups = await request(`/api/groups?${combinedGroupQuery}`);
  assert.equal(filteredGroups.pagination.total, 2);
  assert.deepEqual(filteredGroups.items.map((item) => item.ratio), [0.8, 0.4]);
  assert.deepEqual(filteredGroups.items.map((item) => item.compositeRate), [0.4, 0.2]);
  assert.equal(filteredGroups.items.every((item) => item.recharge.multiplier === 2), true);
  assert.equal(filteredGroups.items.every((item) => item.recharge.source === 'manual'), true);
  assert.equal(filteredGroups.items.every((item) => item.connection_id === provider.id), true);
  assert.equal(filteredGroups.items.every((item) => item.platform === 'openai'), true);
  assert.equal(filteredGroups.filterOptions.providers.some((item) => item.id === otherProvider.id), true);
  assert.equal(filteredGroups.filterOptions.platforms.includes('anthropic'), true);

  const includeNameQuery = new URLSearchParams({
    excludeMissing: 'true', requireRatio: 'true', page: '1', pageSize: '10',
    connectionId: provider.id, platform: 'openai', rateSort: 'desc',
    nameQuery: 'gRoUp 1', nameMode: 'include'
  });
  const includedGroups = await request(`/api/groups?${includeNameQuery}`);
  assert.equal(includedGroups.pagination.total, 1);
  assert.deepEqual(includedGroups.items.map((item) => item.name), ['Group 1']);

  const excludeNameQuery = new URLSearchParams({
    excludeMissing: 'true', requireRatio: 'true', page: '1', pageSize: '10',
    connectionId: provider.id, platform: 'openai', rateSort: 'desc',
    nameQuery: 'GROUP 1', nameMode: 'exclude'
  });
  const excludedGroups = await request(`/api/groups?${excludeNameQuery}`);
  assert.equal(excludedGroups.pagination.total, 1);
  assert.deepEqual(excludedGroups.items.map((item) => item.name), ['Group 0']);

  const includeMultipleNames = new URLSearchParams({
    excludeMissing: 'true', requireRatio: 'true', page: '1', pageSize: '10',
    platform: 'openai', rateSort: 'desc',
    nameQuery: 'Group 0、Other', nameMode: 'include'
  });
  const multipleIncludedGroups = await request(`/api/groups?${includeMultipleNames}`);
  assert.deepEqual(multipleIncludedGroups.items.map((item) => item.name), ['Group 0', 'Other Group']);

  const excludeMultipleNames = new URLSearchParams({
    excludeMissing: 'true', requireRatio: 'true', page: '1', pageSize: '10',
    platform: 'openai', rateSort: 'desc',
    nameQuery: 'Group 0, Other', nameMode: 'exclude'
  });
  const multipleExcludedGroups = await request(`/api/groups?${excludeMultipleNames}`);
  assert.deepEqual(multipleExcludedGroups.items.map((item) => item.name), ['Group 1']);

  const combinedPriceQuery = new URLSearchParams({
    page: '1', pageSize: '10', connectionId: provider.id,
    platform: 'openai', rateSort: 'asc'
  });
  const filteredPrices = await request(`/api/prices?${combinedPriceQuery}`);
  assert.equal(filteredPrices.pagination.total, 2);
  assert.equal(filteredPrices.summary.models, 2);
  assert.deepEqual(filteredPrices.items.map((item) => item.groupRatio), [0.4, 0.8]);
  assert.deepEqual(filteredPrices.items.map((item) => item.compositeRate), [0.2, 0.4]);
  assert.equal(filteredPrices.items.every((item) => item.recharge.multiplier === 2), true);
  assert.equal(filteredPrices.items.every((item) => item.connection_id === provider.id), true);
  assert.equal(filteredPrices.items.every((item) => item.platform === 'openai'), true);
  assert.equal(filteredPrices.filterOptions.providers.some((item) => item.id === otherProvider.id), true);
  assert.equal(filteredPrices.filterOptions.platforms.includes('anthropic'), true);

  const crossProviderGroups = await request('/api/groups?excludeMissing=true&page=1&pageSize=10&platform=openai&rateSort=desc');
  assert.deepEqual(
    crossProviderGroups.items.map((item) => [item.name, item.compositeRate]),
    [['Group 1', 0.4], ['Group 0', 0.2], ['Other Group', 0.095]]
  );
  const crossProviderPrices = await request('/api/prices?page=1&pageSize=10&platform=openai&rateSort=desc');
  assert.deepEqual(
    crossProviderPrices.items.map((item) => [item.model_id, item.compositeRate]),
    [['model-1', 0.4], ['model-0', 0.2], ['other-model', 0.095]]
  );
});
