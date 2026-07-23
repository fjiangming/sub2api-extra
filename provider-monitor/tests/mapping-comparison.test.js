const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createTestContext } = require('./helpers');
const { nowIso } = require('../src/db');
const { ProviderRepository } = require('../src/repositories/provider-repository');
const { QueryService } = require('../src/services/query-service');
const { MappingService } = require('../src/services/mapping-service');
const { AlertService } = require('../src/services/alert-service');

test('mapping comparison persists Sub2API composite-rate drift and drives alert recovery', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'Supplier A',
    adapterType: 'new-api',
    baseUrl: 'https://supplier.example',
    authMode: 'system_token',
    credentials: { systemToken: 'secret', userId: '1' },
    rechargeMultiplier: 10,
    enabled: true
  });
  const groupId = crypto.randomUUID();
  const now = nowIso();
  context.db.prepare(`
    INSERT INTO remote_groups(
      id, connection_id, remote_id, group_type, name, ratio, status,
      metadata_json, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, 'key_route_group', ?, ?, 'active', '{}', ?, ?)
  `).run(groupId, provider.id, 'supplier-low-cost', 'Supplier Low Cost', 0.8, now, now);

  let baseRate = 1.2;
  let baseGroups = [{ id: 7, name: 'Retail', status: 'active', rate_multiplier: baseRate }];
  const sub2api = {
    authenticationStatus: () => ({ available: true, source: 'test' }),
    async listAll(endpoint) {
      if (endpoint === '/api/v1/admin/channel-monitors') {
        const error = new Error('Not supported');
        error.status = 404;
        throw error;
      }
      throw new Error(`Unexpected list endpoint: ${endpoint}`);
    },
    async data(endpoint) {
      if (endpoint === '/api/v1/admin/groups/all') {
        return baseGroups.map((group) => ({ ...group, rate_multiplier: baseRate }));
      }
      if (endpoint === '/api/v1/groups/rates') return { 7: baseRate };
      throw new Error(`Unexpected data endpoint: ${endpoint}`);
    }
  };
  const mappings = new MappingService({ db: context.db, config: context.config, sub2api });
  assert.deepEqual((await mappings.channelMonitors()).items, []);
  const mapping = mappings.save({
    connectionId: provider.id,
    groupId: 7,
    enabled: true,
    config: { upstreamGroupRef: 'supplier-low-cost', rateToleranceRatio: 0.05 }
  });

  let comparison = await mappings.refreshComparisons();
  assert.equal(comparison.items[0].comparison.status, 'rate_mismatch');
  assert.equal(comparison.summary.warning, 1);
  assert.equal(comparison.items[0].comparison.providerRate, 0.8);
  assert.equal(comparison.items[0].comparison.baseGroupRate, 1.2);
  assert.equal(comparison.items[0].comparison.baseGroupId, 7);
  assert.equal(comparison.items[0].comparison.rechargeMultiplier, 10);
  assert.equal(comparison.items[0].comparison.rechargeSource, 'manual');
  assert.ok(Math.abs(comparison.items[0].comparison.compositeRate - 0.08) < 1e-12);
  assert.equal('inferredBaseGroup' in comparison.items[0].comparison.details, false);
  assert.equal(comparison.items[0].comparison.details.providerGroupSource, 'mapping_explicit');
  assert.equal(comparison.items[0].comparison.details.providerRateScope, 'group_multiplier');
  assert.equal(comparison.items[0].comparison.details.compositeFormula, 'provider_rate/recharge_multiplier');
  assert.equal(comparison.items[0].comparison.details.differenceRateScope, 'composite_rate');
  assert.equal(comparison.items[0].comparison.details.differenceFormula, '(base_group_rate-composite_rate)/abs(composite_rate)');
  assert.equal(comparison.items[0].comparison.details.channelCostVerified, false);
  assert.ok(Math.abs(comparison.items[0].comparison.differenceRatio - 14) < 1e-9);

  mappings.save({
    config: { upstreamGroupRef: 'removed-supplier-group', rateToleranceRatio: 0.05 }
  }, mapping.id);
  comparison = await mappings.refreshComparisons({ force: true });
  assert.equal(comparison.items[0].comparison.status, 'missing_provider_group');
  mappings.save({
    config: { upstreamGroupRef: 'supplier-low-cost', rateToleranceRatio: 0.05 }
  }, mapping.id);
  comparison = await mappings.refreshComparisons({ force: true });

  const delivered = [];
  const alerts = new AlertService({
    db: context.db,
    config: context.config,
    queries: new QueryService(context.db, context.config),
    notifications: { dispatch: async (event) => delivered.push(event) }
  });
  alerts.saveRule({
    name: 'Sub2API rate drift',
    ruleType: 'rate_mismatch',
    connectionId: provider.id,
    enabled: true,
    consecutiveMatches: 1,
    cooldownMinutes: 60
  });
  const active = await alerts.evaluateConnection(provider.id);
  assert.equal(active[0].status, 'active');
  assert.equal(active[0].details.mappingId, mapping.id);
  assert.equal(active[0].details.rechargeMultiplier, 10);
  assert.ok(Math.abs(active[0].details.compositeRate - 0.08) < 1e-12);
  assert.equal(active[0].details.differenceRateScope, 'composite_rate');

  baseRate = 0.082;
  comparison = await mappings.refreshComparisons({ force: true });
  assert.equal(comparison.items[0].comparison.status, 'aligned');
  const resolved = await alerts.evaluateConnection(provider.id);
  assert.equal(resolved[0].status, 'resolved');
  assert.equal(delivered.length, 2);

  context.db.prepare('UPDATE remote_groups SET ratio = 0 WHERE id = ?').run(groupId);
  comparison = await mappings.refreshComparisons({ force: true });
  assert.equal(comparison.items[0].comparison.status, 'invalid_provider_rate');
  assert.equal(comparison.summary.warning, 1);
  context.db.prepare('UPDATE remote_groups SET ratio = 0.8 WHERE id = ?').run(groupId);

  baseGroups = [];
  comparison = await mappings.refreshComparisons({ force: true });
  assert.equal(comparison.items[0].comparison.status, 'missing_base_group');
  assert.equal(comparison.summary.error, 1);
});

test('mapping comparison prefers configured per-key dynamic route rates over nominal groups', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'Dynamic Supplier',
    adapterType: 'new-api',
    baseUrl: 'https://dynamic.example',
    authMode: 'system_token',
    credentials: { systemToken: 'secret', userId: '1' },
    typeConfig: {
      dynamicRouteRate: { enabled: true, statistic: 'median', lookbackDays: 30, minimumSamples: 3 }
    },
    enabled: true
  });
  const now = nowIso();
  const groupId = crypto.randomUUID();
  const keyId = crypto.randomUUID();
  context.db.prepare(`
    INSERT INTO remote_groups(
      id, connection_id, remote_id, group_type, name, ratio, status,
      metadata_json, first_seen_at, last_seen_at
    ) VALUES (?, ?, 'default', 'key_route_group', 'default', 1, 'active', '{}', ?, ?)
  `).run(groupId, provider.id, now, now);
  context.db.prepare(`
    INSERT INTO remote_keys(
      id, connection_id, remote_id, name, masked_key, status, primary_group_ref,
      unlimited, metadata_json, first_seen_at, last_seen_at
    ) VALUES (?, ?, '2141', 'route-key', 'sk-a...1234', 'enabled', 'default', 1, '{}', ?, ?)
  `).run(keyId, provider.id, now, now);
  context.db.prepare(`
    INSERT INTO provider_dynamic_route_rates(
      key_id, connection_id, selected_multiplier, statistic, sample_count,
      min_multiplier, median_multiplier, p90_multiplier, max_multiplier,
      weighted_average_multiplier, latest_multiplier, status, summary_json,
      observed_from, observed_to, checked_at, updated_at
    ) VALUES (?, ?, 0.024, 'median', 57, 0.0102, 0.024, 0.024293, 0.0534,
      0.022, 0.030664, 'detected', ?, ?, ?, ?, ?)
  `).run(
    keyId,
    provider.id,
    JSON.stringify({ latest: { channelName: 'Latest route', model: 'gpt-test' } }),
    now,
    now,
    now,
    now
  );
  const sub2api = {
    authenticationStatus: () => ({ available: true, source: 'test' }),
    async data(endpoint) {
      if (endpoint === '/api/v1/admin/groups/all') {
        return [{ id: 7, name: 'Retail', status: 'active', rate_multiplier: 0.12 }];
      }
      if (endpoint === '/api/v1/groups/rates') return { 7: 0.12 };
      throw new Error(`Unexpected data endpoint: ${endpoint}`);
    }
  };
  const mappings = new MappingService({ db: context.db, config: context.config, sub2api });
  mappings.save({
    connectionId: provider.id,
    keyId,
    groupId: 7,
    enabled: true,
    config: { upstreamGroupRef: 'default', rateToleranceRatio: 0.05 }
  });

  let result = await mappings.refreshComparisons();
  let comparison = result.items[0].comparison;
  assert.equal(comparison.providerRate, 0.024);
  assert.equal(comparison.compositeRate, 0.024);
  assert.equal(comparison.details.providerGroupRate, 1);
  assert.equal(comparison.details.providerRateScope, 'dynamic_route_history');
  assert.equal(comparison.details.dynamicRouteRate.sampleCount, 57);
  assert.equal(comparison.details.dynamicRouteRate.summary.latest.channelName, 'Latest route');
  assert.equal(comparison.details.requestBillingVerified, true);
  assert.ok(Math.abs(comparison.differenceRatio - 4) < 1e-12);

  context.db.prepare('DELETE FROM provider_dynamic_route_rates WHERE key_id = ?').run(keyId);
  result = await mappings.refreshComparisons({ force: true });
  comparison = result.items[0].comparison;
  assert.equal(comparison.status, 'missing_dynamic_route_rate');
  assert.equal(comparison.providerRate, null);
  assert.equal(comparison.compositeRate, null);
});

test('rate alerts are tracked and recovered independently for every mapping', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'Supplier B',
    adapterType: 'new-api',
    baseUrl: 'https://supplier-b.example',
    authMode: 'system_token',
    credentials: { systemToken: 'secret', userId: '1' },
    enabled: true
  });
  const now = nowIso();
  const mappingIds = [crypto.randomUUID(), crypto.randomUUID()];
  const insertMapping = context.db.prepare(`
    INSERT INTO sub2api_mappings(
      id, connection_id, account_id, group_id, role, enabled,
      models_json, config_json, created_at, updated_at
    ) VALUES (?, ?, ?, 7, 'primary', 1, '[]', '{}', ?, ?)
  `);
  const insertState = context.db.prepare(`
    INSERT INTO sub2api_mapping_states(
      mapping_id, status, provider_group_name, provider_rate,
      base_group_id, base_group_name, base_group_rate,
      difference_ratio, tolerance_ratio, details_json, checked_at
    ) VALUES (?, 'rate_mismatch', 'Supplier', 0.8, 7, 'Retail', 1.2, 0.5, 0.05, '{}', ?)
  `);
  mappingIds.forEach((mappingId, index) => {
    insertMapping.run(mappingId, provider.id, 101 + index, now, now);
    insertState.run(mappingId, now);
  });
  const listedMappings = new MappingService({ db: context.db, config: context.config, sub2api: {} }).list();
  assert.equal(listedMappings[0].comparison.rechargeMultiplier, 1);
  assert.equal(listedMappings[0].comparison.rechargeSource, 'default');
  assert.equal(listedMappings[0].comparison.compositeRate, 0.8);

  const delivered = [];
  const alerts = new AlertService({
    db: context.db,
    config: context.config,
    queries: new QueryService(context.db, context.config),
    notifications: { dispatch: async (event) => delivered.push(event) }
  });
  const rule = alerts.saveRule({
    name: 'Every mapped group account',
    ruleType: 'rate_mismatch',
    connectionId: provider.id,
    enabled: true,
    consecutiveMatches: 1,
    cooldownMinutes: 60
  });

  const active = await alerts.evaluateConnection(provider.id);
  assert.deepEqual(active.map((event) => event.details.mappingId).sort(), [...mappingIds].sort());
  assert.equal(context.db.prepare(`SELECT COUNT(*) count FROM alert_events WHERE rule_id = ? AND status = 'active'`).get(rule.id).count, 2);
  assert.equal(delivered.length, 2);

  context.db.prepare(`
    UPDATE sub2api_mapping_states
    SET status = 'aligned', base_group_rate = 0.82, difference_ratio = 0.025, checked_at = ?
    WHERE mapping_id = ?
  `).run(nowIso(), mappingIds[0]);
  const partiallyResolved = await alerts.evaluateConnection(provider.id);
  assert.ok(partiallyResolved.some((event) => event.id && event.status === 'resolved'));
  assert.equal(context.db.prepare(`SELECT COUNT(*) count FROM alert_events WHERE rule_id = ? AND status = 'active'`).get(rule.id).count, 1);
  assert.equal(delivered.length, 3);

  context.db.prepare('DELETE FROM sub2api_mappings WHERE id = ?').run(mappingIds[1]);
  const fullyResolved = await alerts.evaluateConnection(provider.id);
  assert.equal(fullyResolved.filter((event) => event.status === 'resolved').length, 1);
  assert.equal(context.db.prepare(`SELECT COUNT(*) count FROM alert_events WHERE rule_id = ? AND status != 'resolved'`).get(rule.id).count, 0);
  assert.equal(delivered.length, 4);
});
