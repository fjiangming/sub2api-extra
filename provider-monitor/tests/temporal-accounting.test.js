const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');
const { ProviderRepository } = require('../src/repositories/provider-repository');
const {
  recordBaseGroupRates,
  rebuildBaseCostRollups,
  refreshBaseCostAttributions
} = require('../src/services/accounting-context');

function createProvider(providers, name) {
  return providers.create({
    name,
    adapterType: 'new-api',
    baseUrl: `https://${name.toLowerCase().replaceAll(' ', '-')}.example`,
    authMode: 'system_token',
    credentials: { systemToken: `${name}-token` }
  });
}

test('temporal accounting keeps old costs on the old key after a mapping changes', (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const firstProvider = createProvider(providers, 'First Supplier');
  const secondProvider = createProvider(providers, 'Second Supplier');
  const now = Date.now();
  const t0 = new Date(now - 4 * 3600000).toISOString();
  const t1 = new Date(now - 3 * 3600000).toISOString();
  const t2 = new Date(now - 2 * 3600000).toISOString();
  const t3 = new Date(now - 1 * 3600000).toISOString();

  context.db.prepare(`
    INSERT INTO sub2api_monitored_accounts(
      account_id, name, platform, account_type, status, schedulable,
      metadata_json, first_seen_at, last_seen_at
    ) VALUES ('account-1', 'Mapped account', 'openai', 'apikey', 'active', 1,
      '{}', ?, ?)
  `).run(t0, t3);
  const insertKey = context.db.prepare(`
    INSERT INTO remote_keys(
      id, connection_id, remote_id, name, masked_key, status, unlimited,
      metadata_json, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, 'active', 1, '{}', ?, ?)
  `);
  insertKey.run('key-first', firstProvider.id, 'remote-first', 'First key', 'sk-f...1', t0, t3);
  insertKey.run('key-second', secondProvider.id, 'remote-second', 'Second key', 'sk-s...2', t0, t3);

  context.db.prepare(`
    INSERT INTO sub2api_mappings(
      id, connection_id, key_id, account_id, group_id, role, enabled,
      models_json, config_json, created_at, updated_at
    ) VALUES ('temporal-map', ?, 'key-first', 'account-1', 1, 'primary', 1,
      '[]', ?, ?, ?)
  `).run(
    firstProvider.id,
    JSON.stringify({ accounting: { effectiveFrom: t0 } }),
    t0,
    t0
  );
  context.db.prepare(`
    INSERT INTO sub2api_account_cost_ledger(
      source_log_id, account_id, currency, cost, request_count,
      occurred_at, ingested_at, updated_at, recharge_multiplier,
      recharge_source, cash_currency, cash_revenue, first_observed_at,
      last_observed_at
    ) VALUES ('old-cost', 'account-1', 'USD', 10, 1, ?, ?, ?, 2,
      'settings', 'USD', 5, ?, ?)
  `).run(t1, t1, t1, t1, t1);
  refreshBaseCostAttributions(context.db, ['account-1']);

  context.db.prepare(`
    UPDATE sub2api_mappings SET connection_id = ?, key_id = 'key-second',
      updated_at = ? WHERE id = 'temporal-map'
  `).run(secondProvider.id, t2);
  context.db.prepare(`
    UPDATE sub2api_account_monitor_settings
    SET base_recharge_multiplier = 4, updated_at = ? WHERE id = 1
  `).run(t2);
  context.db.prepare(`
    INSERT INTO sub2api_account_cost_ledger(
      source_log_id, account_id, currency, cost, request_count,
      occurred_at, ingested_at, updated_at, recharge_multiplier,
      recharge_source, cash_currency, cash_revenue, first_observed_at,
      last_observed_at
    ) VALUES ('new-cost', 'account-1', 'USD', 12, 1, ?, ?, ?, 4,
      'settings', 'USD', 3, ?, ?)
  `).run(t3, t3, t3, t3, t3);
  rebuildBaseCostRollups(context.db, ['account-1']);
  refreshBaseCostAttributions(context.db, ['account-1']);

  const rows = context.db.prepare(`
    SELECT source_log_id, connection_id, key_id, recharge_multiplier,
      cash_revenue, attribution_status
    FROM sub2api_account_cost_ledger ORDER BY occurred_at
  `).all();
  assert.deepEqual(rows.map((row) => ({
    sourceLogId: row.source_log_id,
    connectionId: row.connection_id,
    keyId: row.key_id,
    rechargeMultiplier: row.recharge_multiplier,
    cashRevenue: row.cash_revenue,
    attributionStatus: row.attribution_status
  })), [
    {
      sourceLogId: 'old-cost',
      connectionId: firstProvider.id,
      keyId: 'key-first',
      rechargeMultiplier: 2,
      cashRevenue: 5,
      attributionStatus: 'attributed'
    },
    {
      sourceLogId: 'new-cost',
      connectionId: secondProvider.id,
      keyId: 'key-second',
      rechargeMultiplier: 4,
      cashRevenue: 3,
      attributionStatus: 'attributed'
    }
  ]);
  const rollups = context.db.prepare(`
    SELECT connection_id, key_id, cash_revenue
    FROM sub2api_attributed_cost_rollups ORDER BY cash_revenue DESC
  `).all();
  assert.deepEqual(rollups, [
    { connection_id: firstProvider.id, key_id: 'key-first', cash_revenue: 5 },
    { connection_id: secondProvider.id, key_id: 'key-second', cash_revenue: 3 }
  ]);
  const mappingHistory = context.db.prepare(`
    SELECT connection_id, key_id, valid_from, valid_to
    FROM sub2api_mapping_history WHERE mapping_id = 'temporal-map'
    ORDER BY valid_from
  `).all();
  assert.equal(mappingHistory.length, 2);
  assert.equal(mappingHistory[0].key_id, 'key-first');
  assert.equal(mappingHistory[0].valid_to, t2);
  assert.equal(mappingHistory[1].key_id, 'key-second');
  assert.equal(mappingHistory[1].valid_from, t2);
});

test('status and group-rate histories only add versions when values change', (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const provider = createProvider(providers, 'History Supplier');
  const firstAt = new Date(Date.now() - 3600000).toISOString();
  const observedAt = new Date().toISOString();
  context.db.prepare(`
    INSERT INTO remote_groups(
      id, connection_id, remote_id, group_type, name, ratio, status,
      metadata_json, first_seen_at, last_seen_at
    ) VALUES ('history-group', ?, 'premium', 'key_route_group', 'Premium', 1.5,
      'active', '{}', ?, ?)
  `).run(provider.id, firstAt, firstAt);
  context.db.prepare(`
    UPDATE remote_groups SET ratio = 2, last_seen_at = ? WHERE id = 'history-group'
  `).run(observedAt);
  assert.deepEqual(context.db.prepare(`
    SELECT rate, valid_to IS NULL AS current
    FROM provider_group_rate_history WHERE group_id = 'history-group' ORDER BY id
  `).all(), [
    { rate: 1.5, current: 0 },
    { rate: 2, current: 1 }
  ]);

  recordBaseGroupRates(context.db, [{ id: 7, name: 'Base group', rateMultiplier: 1 }], firstAt);
  recordBaseGroupRates(context.db, [{ id: 7, name: 'Base group', rateMultiplier: 1 }], observedAt);
  recordBaseGroupRates(context.db, [{ id: 7, name: 'Base group', rateMultiplier: 1.25 }], observedAt);
  assert.deepEqual(context.db.prepare(`
    SELECT rate, valid_to IS NULL AS current
    FROM sub2api_group_rate_history WHERE group_id = 7 ORDER BY id
  `).all(), [
    { rate: 1, current: 0 },
    { rate: 1.25, current: 1 }
  ]);
});
