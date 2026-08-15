const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');
const { ProviderRepository } = require('../src/repositories/provider-repository');
const { AccountMonitorService } = require('../src/services/account-monitor-service');
const { recordMappingRateVersions } = require('../src/services/accounting-context');
const {
  recordProviderUsageCounters
} = require('../src/services/provider-counter-accounting');

function insertAccount(db, id, name, observedAt) {
  db.prepare(`
    INSERT INTO sub2api_monitored_accounts(
      account_id, name, platform, account_type, status, schedulable,
      metadata_json, first_seen_at, last_seen_at
    ) VALUES (?, ?, 'openai', 'apikey', 'active', 1, '{}', ?, ?)
  `).run(String(id), name, observedAt, observedAt);
}

function cumulativeUsage(cost, requests, identity) {
  return [{
    scope: 'key',
    period: 'cumulative',
    remoteSubjectId: 'manual-key',
    currency: 'USD',
    cost,
    requests,
    inputTokens: requests * 10,
    outputTokens: requests * 2,
    cacheCreationTokens: requests,
    cacheReadTokens: requests * 3,
    raw: { monitorMetrics: { credentialIdentity: identity } }
  }];
}

test('API-key-only counters preserve deltas across rate, mapping, reset and key rotation changes', (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'Key-only Supplier',
    adapterType: 'sub2api',
    baseUrl: 'https://key-only.example',
    authMode: 'api_key',
    credentials: {
      apiKeys: [{ id: 'manual-key', name: 'Manual Key', key: 'sk-manual-12345678' }]
    },
    rechargeMultiplier: 2
  });
  const now = Date.now();
  const at = (minutesAgo) => new Date(now - minutesAgo * 60000).toISOString();
  const [t0, t1, t2, t3, t4, t5, t6, t7, t8, t9] =
    [70, 60, 50, 40, 30, 20, 10, 5, 2, 1].map(at);

  insertAccount(context.db, 101, 'Old mapped account', t0);
  insertAccount(context.db, 102, 'New mapped account', t0);
  context.db.prepare(`
    INSERT INTO remote_groups(
      id, connection_id, remote_id, group_type, name, ratio, status,
      metadata_json, first_seen_at, last_seen_at
    ) VALUES ('counter-group', ?, 'configured-api-key:manual-key',
      'key_route_group', 'Manual Key rate', 0.15, 'active', '{}', ?, ?)
  `).run(provider.id, t0, t0);
  context.db.prepare(`
    INSERT INTO remote_keys(
      id, connection_id, remote_id, name, masked_key, status,
      primary_group_ref, currency, unlimited, metadata_json,
      first_seen_at, last_seen_at
    ) VALUES ('counter-key', ?, 'manual-key', 'Manual Key', 'sk-m...5678',
      'active', 'configured-api-key:manual-key', 'USD', 0, ?, ?, ?)
  `).run(provider.id, JSON.stringify({ identityHash: 'identity-v1' }), t0, t0);
  context.db.prepare(`
    INSERT INTO sub2api_mappings(
      id, connection_id, key_id, account_id, group_id, role, enabled,
      models_json, config_json, created_at, updated_at
    ) VALUES ('counter-map', ?, 'counter-key', 101, 1, 'primary', 1,
      '[]', ?, ?, ?)
  `).run(
    provider.id,
    JSON.stringify({ accounting: { effectiveFrom: t0 } }),
    t0,
    t0
  );
  recordMappingRateVersions(context.db, [{
    mappingId: 'counter-map',
    providerGroupRef: 'configured-api-key:manual-key',
    providerGroupName: 'Manual Key rate',
    providerRate: 0.15,
    baseGroupName: 'Base 1',
    baseGroupRate: 0.15,
    checkedAt: t0
  }]);

  const checkpoint = (capturedAt, cost, requests, options = {}) => (
    recordProviderUsageCounters({
      db: context.db,
      connectionId: provider.id,
      usage: cumulativeUsage(cost, requests, options.identity || 'identity-v1'),
      keys: [{ remoteId: 'manual-key' }],
      requestLogs: options.requestLogs || { ok: false },
      capturedAt
    })
  );

  assert.deepEqual(checkpoint(t1, 10, 100), {
    checkpointCount: 1,
    ledgerEntryCount: 0,
    openingEntryCount: 1,
    resetCount: 0,
    correctionCount: 0
  });
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM provider_cost_rollups').get().count, 0);

  assert.equal(checkpoint(t2, 14, 140).ledgerEntryCount, 1);
  context.db.prepare(`
    UPDATE provider_recharge_rates
    SET manual_multiplier = 4, status = 'manual', updated_at = ?
    WHERE connection_id = ?
  `).run(t3, provider.id);
  context.db.prepare(`
    UPDATE sub2api_mappings SET account_id = 102, updated_at = ?
    WHERE id = 'counter-map'
  `).run(t3);
  context.db.prepare(`
    UPDATE remote_groups SET ratio = 0.25, last_seen_at = ?
    WHERE id = 'counter-group'
  `).run(t3);
  recordMappingRateVersions(context.db, [{
    mappingId: 'counter-map',
    providerGroupRef: 'configured-api-key:manual-key',
    providerGroupName: 'Manual Key rate',
    providerRate: 0.25,
    baseGroupName: 'Base 2',
    baseGroupRate: 0.2,
    checkedAt: t3
  }]);

  assert.equal(checkpoint(t4, 18, 180).ledgerEntryCount, 1);
  assert.equal(checkpoint(t5, 20, 200).ledgerEntryCount, 1);
  const reset = checkpoint(t6, 1, 10);
  assert.equal(reset.ledgerEntryCount, 1);
  assert.equal(reset.resetCount, 1);

  const entriesBeforeReconciliation = context.db.prepare(`
    SELECT entry_kind, cost, request_count, recharge_multiplier, cash_cost,
      attributed_account_id, attribution_status, accounting_status,
      provider_group_rate, base_group_rate, precision_seconds
    FROM provider_cost_ledger
    WHERE connection_id = ? ORDER BY occurred_at
  `).all(provider.id);
  assert.deepEqual(entriesBeforeReconciliation.map((row) => ({
    kind: row.entry_kind,
    cost: row.cost,
    requests: row.request_count,
    multiplier: row.recharge_multiplier,
    cash: row.cash_cost,
    account: row.attributed_account_id,
    attribution: row.attribution_status
  })), [
    { kind: 'counter_opening', cost: 10, requests: 100, multiplier: 2, cash: 5,
      account: '101', attribution: 'attributed' },
    { kind: 'counter_delta', cost: 4, requests: 40, multiplier: 2, cash: 2,
      account: '101', attribution: 'attributed' },
    { kind: 'counter_delta', cost: 4, requests: 40, multiplier: 4, cash: 1,
      account: null, attribution: 'mapping_transition' },
    { kind: 'counter_delta', cost: 2, requests: 20, multiplier: 4, cash: 0.5,
      account: '102', attribution: 'attributed' },
    { kind: 'counter_reset', cost: 1, requests: 10, multiplier: 4, cash: 0.25,
      account: '102', attribution: 'attributed' }
  ]);
  assert.deepEqual(
    entriesBeforeReconciliation.map((row) => row.provider_group_rate),
    [0.15, 0.15, 0.25, 0.25, 0.25]
  );
  assert.deepEqual(
    entriesBeforeReconciliation.map((row) => row.base_group_rate),
    [0.15, 0.15, null, 0.2, 0.2]
  );
  assert.deepEqual(
    entriesBeforeReconciliation.slice(1).map((row) => row.precision_seconds),
    [600, 1200, 600, 600]
  );

  checkpoint(t7, 1, 10, {
    requestLogs: {
      ok: true,
      value: {
        keyCoverage: [{
          remoteKeyId: 'manual-key',
          status: 'succeeded',
          truncated: false,
          coverageFrom: t5,
          coverageTo: t6
        }]
      }
    }
  });
  assert.equal(context.db.prepare(`
    SELECT accounting_status FROM provider_cost_ledger
    WHERE connection_id = ? AND entry_kind = 'counter_reset'
  `).get(provider.id).accounting_status, 'superseded');

  context.db.prepare(`
    UPDATE remote_keys SET metadata_json = ?, last_seen_at = ?
    WHERE id = 'counter-key'
  `).run(JSON.stringify({ identityHash: 'identity-v2' }), t8);
  assert.equal(checkpoint(t8, 5, 50, { identity: 'identity-v2' }).openingEntryCount, 1);

  context.db.prepare(`
    INSERT INTO provider_cost_ledger(
      connection_id, key_id, remote_key_id, key_identity, source_log_id, status,
      currency, cost, request_count, occurred_at, ingested_at, updated_at,
      recharge_multiplier, recharge_source, cash_currency, cash_cost,
      first_observed_at, last_observed_at
    ) VALUES (?, 'counter-key', 'manual-key', 'identity-v2', 'partial-log',
      'success', 'USD', 0.4, 4, ?, ?, ?, 4, 'manual', 'USD', 0.1, ?, ?)
  `).run(provider.id, t9, t9, t9, t9, t9);
  const gapStart = new Date(Date.parse(t8) + 30000).toISOString();
  assert.equal(checkpoint(t9, 6, 60, {
    identity: 'identity-v2',
    requestLogs: {
      ok: true,
      value: {
        keyCoverage: [{
          remoteKeyId: 'manual-key',
          status: 'succeeded',
          truncated: false,
          coverageFrom: gapStart,
          coverageTo: t9
        }]
      }
    }
  }).ledgerEntryCount, 1);
  assert.equal(context.db.prepare(`
    SELECT accounting_status FROM provider_cost_ledger
    WHERE connection_id = ? AND source_log_id = 'partial-log'
  `).get(provider.id).accounting_status, 'shadow');

  const states = context.db.prepare(`
    SELECT key_identity, epoch, reset_count,
      lifetime_cost_offset + last_cost AS reported_cost,
      lifetime_request_offset + last_request_count AS reported_requests
    FROM provider_usage_counter_state WHERE connection_id = ? ORDER BY key_identity
  `).all(provider.id);
  assert.deepEqual(states, [
    { key_identity: 'identity-v1', epoch: 2, reset_count: 1,
      reported_cost: 21, reported_requests: 210 },
    { key_identity: 'identity-v2', epoch: 1, reset_count: 0,
      reported_cost: 6, reported_requests: 60 }
  ]);
  assert.deepEqual(context.db.prepare(`
    SELECT SUM(cost) AS cost, SUM(request_count) AS requests,
      SUM(cash_cost) AS cash_cost
    FROM provider_cost_ledger
    WHERE connection_id = ? AND comparable = 1 AND accounting_status = 'active'
  `).get(provider.id), { cost: 11, requests: 110, cash_cost: 3.75 });

  const monitor = new AccountMonitorService({
    db: context.db,
    config: context.config,
    sub2api: {}
  });
  const supplier = monitor.accounts({ display: 'providers', days: 7 }).items[0];
  assert.equal(supplier.audit.accountingMode, 'counter_ledger');
  assert.equal(supplier.audit.windowUpstreamBalanceCost, 11);
  assert.equal(supplier.audit.reportedLifetimeUpstreamBalanceCost, 27);
  assert.equal(supplier.audit.windowUpstreamCost, 3.75);
  assert.equal(supplier.audit.lifetimeUpstreamCost, 10);
  assert.equal(supplier.audit.lifetimeRequestCount, 270);
  assert.equal(supplier.audit.unallocatedEntryCount, 2);
  assert.equal(supplier.audit.counterResetCount, 1);
  assert.equal(supplier.audit.lifetimeGrossProfit, null);
  assert.equal(supplier.upstreamMetrics.requestCount, 110);
  assert.equal(supplier.upstreamMetrics.available, true);
  const mappedAccount = monitor.account('102', { days: 7 });
  assert.equal(mappedAccount.comparison.source, 'provider_counter_ledger');
  assert.equal(mappedAccount.comparison.upstream.requestCount, 30);
  assert.equal(mappedAccount.comparison.cost.estimated, true);
  assert.equal(mappedAccount.comparison.cost.precisionSeconds, 600);
});

test('an opening counter baseline exposes lifetime totals without inventing a window value', (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'Baseline-only Supplier',
    adapterType: 'sub2api',
    baseUrl: 'https://baseline-only.example',
    authMode: 'api_key',
    credentials: { apiKey: 'sk-baseline-12345678' }
  });
  const capturedAt = new Date().toISOString();
  context.db.prepare(`
    INSERT INTO remote_keys(
      id, connection_id, remote_id, name, masked_key, status, currency,
      unlimited, metadata_json, first_seen_at, last_seen_at
    ) VALUES ('baseline-key', ?, 'manual-key', 'Baseline Key', 'sk-b...5678',
      'active', 'USD', 0, ?, ?, ?)
  `).run(provider.id, JSON.stringify({ identityHash: 'baseline-identity' }), capturedAt, capturedAt);
  recordProviderUsageCounters({
    db: context.db,
    connectionId: provider.id,
    usage: cumulativeUsage(92.948641643, 7837, 'baseline-identity'),
    keys: [{ remoteId: 'manual-key' }],
    requestLogs: { ok: false },
    capturedAt
  });

  const monitor = new AccountMonitorService({
    db: context.db,
    config: context.config,
    sub2api: {}
  });
  const supplier = monitor.accounts({ display: 'providers', days: 7 }).items[0];
  assert.equal(supplier.audit.windowUpstreamBalanceCost, null);
  assert.equal(supplier.audit.reportedLifetimeUpstreamBalanceCost, 92.94864164);
  assert.equal(supplier.audit.lifetimeUpstreamCost, null);
  assert.equal(supplier.audit.lifetimeRequestCount, 7837);
  assert.equal(supplier.upstreamMetrics.available, false);
  assert.equal(
    supplier.upstreamMetrics.unavailableReason,
    'provider_counter_baseline_only'
  );
});

test('a negative cumulative correction remains visible without assuming a recharge rate', (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'Correction Supplier',
    adapterType: 'sub2api',
    baseUrl: 'https://correction.example',
    authMode: 'api_key',
    credentials: { apiKey: 'sk-correction-12345678' }
  });
  const capturedAt = new Date(Date.now() - 60000).toISOString();
  const correctedAt = new Date().toISOString();
  insertAccount(context.db, 201, 'Correction account', capturedAt);
  context.db.prepare(`
    INSERT INTO remote_keys(
      id, connection_id, remote_id, name, masked_key, status, currency,
      unlimited, metadata_json, first_seen_at, last_seen_at
    ) VALUES ('correction-key', ?, 'manual-key', 'Correction Key', 'sk-c...5678',
      'active', 'USD', 0, ?, ?, ?)
  `).run(provider.id, JSON.stringify({ identityHash: 'correction-identity' }), capturedAt, capturedAt);
  context.db.prepare(`
    INSERT INTO sub2api_mappings(
      id, connection_id, key_id, account_id, group_id, role, enabled,
      models_json, config_json, created_at, updated_at
    ) VALUES ('correction-map', ?, 'correction-key', 201, 1, 'primary', 1,
      '[]', ?, ?, ?)
  `).run(
    provider.id,
    JSON.stringify({ accounting: { effectiveFrom: capturedAt } }),
    capturedAt,
    capturedAt
  );
  const record = (when, cost) => recordProviderUsageCounters({
    db: context.db,
    connectionId: provider.id,
    usage: cumulativeUsage(cost, 100, 'correction-identity'),
    keys: [{ remoteId: 'manual-key' }],
    requestLogs: { ok: false },
    capturedAt: when
  });
  record(capturedAt, 10);
  const result = record(correctedAt, 9);
  assert.equal(result.correctionCount, 1);
  assert.deepEqual(context.db.prepare(`
    SELECT entry_kind, cost, request_count, recharge_source
    FROM provider_cost_ledger WHERE comparable = 1
  `).get(), {
    entry_kind: 'counter_correction',
    cost: -1,
    request_count: 0,
    recharge_source: 'default'
  });

  const monitor = new AccountMonitorService({
    db: context.db,
    config: context.config,
    sub2api: {}
  });
  const supplier = monitor.accounts({ display: 'providers', days: 7 }).items[0];
  assert.equal(supplier.audit.windowUpstreamBalanceCost, -1);
  assert.equal(supplier.audit.windowUpstreamCost, null);
  assert.equal(supplier.audit.reportedLifetimeUpstreamBalanceCost, 9);
  const account = monitor.account('201', { days: 7 });
  assert.equal(account.comparison.source, 'provider_counter_ledger');
  assert.equal(account.comparison.cost.upstreamCost, -1);
  assert.equal(account.comparison.cost.reason, 'request_pairing_unavailable');
});
