const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');
const { ProviderRepository } = require('../src/repositories/provider-repository');
const { GrossProfitService, bucketForTimestamp } = require('../src/services/gross-profit-service');
const { createApplication } = require('../src/server');

function createProvider(providers, name, suffix) {
  return providers.create({
    name,
    adapterType: 'custom',
    baseUrl: `https://${suffix}.example`,
    authMode: 'api_key',
    credentials: { apiKey: `secret-${suffix}` },
    enabled: false,
    rechargeMultiplier: 2
  });
}

function insertKey(db, provider, id, name, observedAt) {
  db.prepare(`
    INSERT INTO remote_keys(
      id, connection_id, remote_id, name, masked_key, status, currency,
      unlimited, metadata_json, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, 'active', 'USD', 0, '{}', ?, ?)
  `).run(id, provider.id, id, name, `${id.slice(0, 4)}...`, observedAt, observedAt);
}

function insertAccount(db, id, name, observedAt) {
  db.prepare(`
    INSERT INTO sub2api_monitored_accounts(
      account_id, name, platform, account_type, status, schedulable,
      metadata_json, first_seen_at, last_seen_at
    ) VALUES (?, ?, 'openai', 'apikey', 'active', 1, '{}', ?, ?)
  `).run(id, name, observedAt, observedAt);
}

function insertMappingHistory(db, mappingId, providerId, keyId, accountId, validFrom) {
  db.prepare(`
    INSERT INTO sub2api_mapping_history(
      mapping_id, connection_id, key_id, account_id, group_id, role, enabled,
      source, valid_from, observed_at, context_json
    ) VALUES (?, ?, ?, ?, 1, 'primary', 1, 'test', ?, ?, '{}')
  `).run(mappingId, providerId, keyId, accountId, validFrom, validFrom);
}

function insertRevenue(db, {
  id, accountId, providerId = null, keyId = null, occurredAt, cashRevenue,
  attributionStatus = 'attributed'
}) {
  db.prepare(`
    INSERT INTO sub2api_account_cost_ledger(
      source_log_id, account_id, currency, cost, request_count,
      occurred_at, ingested_at, updated_at, recharge_multiplier,
      recharge_source, cash_currency, cash_revenue, connection_id, key_id,
      attribution_status, first_observed_at, last_observed_at
    ) VALUES (?, ?, 'USD', ?, 1, ?, ?, ?, 2, 'base_settings', 'USD', ?, ?, ?, ?, ?, ?)
  `).run(
    id, accountId, cashRevenue * 2, occurredAt, occurredAt, occurredAt,
    cashRevenue, providerId, keyId, attributionStatus, occurredAt, occurredAt
  );
}

function insertCost(db, {
  id, providerId, keyId, occurredAt, cashCost, rechargeSource = 'manual',
  attributedAccountId = null
}) {
  db.prepare(`
    INSERT INTO provider_cost_ledger(
      connection_id, key_id, remote_key_id, key_identity, source_log_id, status,
      currency, cost, request_count, input_tokens, output_tokens,
      cache_creation_tokens, cache_read_tokens, occurred_at, ingested_at, updated_at,
      recharge_multiplier, recharge_source, cash_currency, cash_cost,
      first_observed_at, last_observed_at, source_type, entry_kind,
      accounting_status, interval_start, comparable, attributed_account_id,
      attribution_status
    ) VALUES (?, ?, ?, ?, ?, 'success', 'USD', ?, 1, 0, 0, 0, 0, ?, ?, ?,
      2, ?, 'USD', ?, ?, ?, 'request_log', 'request', 'active', ?, 1, ?, ?)
  `).run(
    providerId, keyId, keyId, keyId, id, cashCost * 2,
    occurredAt, occurredAt, occurredAt, rechargeSource, cashCost,
    occurredAt, occurredAt, occurredAt, attributedAccountId,
    attributedAccountId ? 'attributed' : 'unmapped'
  );
}

function setupLedger(context) {
  const providers = new ProviderRepository(context.db, context.config);
  const alpha = createProvider(providers, 'Alpha Supplier', 'alpha-profit');
  const beta = createProvider(providers, 'Beta Supplier', 'beta-profit');
  const first = '2026-08-16T15:30:00.000Z';
  const second = '2026-08-16T16:30:00.000Z';
  insertKey(context.db, alpha, 'key-alpha', 'Alpha Key', first);
  insertKey(context.db, beta, 'key-beta', 'Beta Key', first);
  insertAccount(context.db, '101', 'Alpha Account', first);
  insertAccount(context.db, '202', 'Beta Account', first);
  insertAccount(context.db, '999', 'Unmapped Account', first);
  insertMappingHistory(context.db, 'map-alpha', alpha.id, 'key-alpha', '101', '2026-01-01T00:00:00.000Z');
  insertMappingHistory(context.db, 'map-beta', beta.id, 'key-beta', '202', '2026-01-01T00:00:00.000Z');

  insertRevenue(context.db, {
    id: 'alpha-revenue-16', accountId: '101', providerId: alpha.id,
    keyId: 'key-alpha', occurredAt: first, cashRevenue: 5
  });
  insertCost(context.db, {
    id: 'alpha-cost-16', providerId: alpha.id, keyId: 'key-alpha',
    occurredAt: first, cashCost: 2
  });
  insertRevenue(context.db, {
    id: 'alpha-revenue-17', accountId: '101', providerId: alpha.id,
    keyId: 'key-alpha', occurredAt: second, cashRevenue: 3
  });
  insertCost(context.db, {
    id: 'alpha-cost-17', providerId: alpha.id, keyId: 'key-alpha',
    occurredAt: second, cashCost: 4
  });
  insertRevenue(context.db, {
    id: 'beta-revenue-17', accountId: '202', providerId: beta.id,
    keyId: 'key-beta', occurredAt: second, cashRevenue: 10
  });
  insertCost(context.db, {
    id: 'beta-cost-17', providerId: beta.id, keyId: 'key-beta',
    occurredAt: second, cashCost: 6
  });
  insertRevenue(context.db, {
    id: 'unmapped-revenue', accountId: '999', occurredAt: second,
    cashRevenue: 100, attributionStatus: 'unmapped'
  });
  return { alpha, beta };
}

test('gross profit uses the configured timezone and defaults to daily supplier totals', (t) => {
  const context = createTestContext({ PROVIDER_MONITOR_TIMEZONE: 'Asia/Shanghai' });
  t.after(() => context.cleanup());
  const { alpha, beta } = setupLedger(context);
  const service = new GrossProfitService({
    db: context.db,
    config: context.config,
    now: () => new Date('2026-08-17T12:00:00.000Z')
  });

  assert.equal(bucketForTimestamp('2026-08-16T15:59:59.999Z', 'day', 'Asia/Shanghai'), '2026-08-16');
  assert.equal(bucketForTimestamp('2026-08-16T16:00:00.000Z', 'day', 'Asia/Shanghai'), '2026-08-17');

  const report = service.report({ from: '2026-08-16', to: '2026-08-17' });
  assert.deepEqual(report.query, {
    dimension: 'provider',
    granularity: 'day',
    from: '2026-08-16',
    to: '2026-08-17',
    connectionId: null,
    currency: 'USD',
    timezone: 'Asia/Shanghai'
  });
  assert.equal(report.summary.revenue, 18);
  assert.equal(report.summary.upstreamCost, 12);
  assert.equal(report.summary.grossProfit, 6);
  assert.equal(report.summary.grossMarginRatio, 0.333333);
  assert.equal(report.summary.status, 'complete');
  assert.equal(report.summary.unattributedBaseRequestCount, 1);
  assert.equal(report.summary.unattributedBaseRevenue, 100);
  assert.equal(report.summary.breakdownComplete, false);
  assert.deepEqual(report.periods.map((period) => ({
    key: period.periodKey,
    revenue: period.revenue,
    cost: period.upstreamCost,
    profit: period.grossProfit
  })), [
    { key: '2026-08-16', revenue: 5, cost: 2, profit: 3 },
    { key: '2026-08-17', revenue: 13, cost: 10, profit: 3 }
  ]);
  assert.deepEqual(report.entities.map((entity) => [
    entity.entityName,
    entity.grossProfit
  ]), [
    ['Beta Supplier', 4],
    ['Alpha Supplier', 2]
  ]);
  assert.deepEqual(
    report.filterOptions.providers.map((provider) => provider.id).sort(),
    [alpha.id, beta.id].sort()
  );
});

test('gross profit keeps totals stable across key, account, week and month views', (t) => {
  const context = createTestContext({ PROVIDER_MONITOR_TIMEZONE: 'Asia/Shanghai' });
  t.after(() => context.cleanup());
  setupLedger(context);
  const service = new GrossProfitService({ db: context.db, config: context.config });
  const input = { from: '2026-08-16', to: '2026-08-17' };

  const keyReport = service.report({ ...input, dimension: 'key' });
  assert.equal(keyReport.summary.grossProfit, 6);
  assert.deepEqual(keyReport.entities.map((entity) => entity.entityName).sort(), [
    'Alpha Key',
    'Beta Key'
  ]);

  const accountReport = service.report({ ...input, dimension: 'account' });
  assert.equal(accountReport.summary.grossProfit, 6);
  assert.equal(accountReport.summary.breakdownComplete, false);
  assert.deepEqual(accountReport.entities.map((entity) => [
    entity.entityName,
    entity.grossProfit
  ]), [
    ['Beta Account', 4],
    ['Alpha Account', 2]
  ]);

  const weekly = service.report({ ...input, granularity: 'week' });
  assert.deepEqual(weekly.periods.map((period) => period.periodKey), [
    '2026-08-10',
    '2026-08-17'
  ]);
  const monthly = service.report({ ...input, granularity: 'month' });
  assert.equal(monthly.periods.length, 1);
  assert.equal(monthly.periods[0].periodKey, '2026-08-01');
  assert.equal(monthly.periods[0].grossProfit, 6);
});

test('unconfirmed supplier recharge rates expose estimates instead of exact gross profit', (t) => {
  const context = createTestContext({ PROVIDER_MONITOR_TIMEZONE: 'Asia/Shanghai' });
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const provider = createProvider(providers, 'Estimate Supplier', 'estimate-profit');
  const occurredAt = '2026-08-16T16:30:00.000Z';
  insertKey(context.db, provider, 'key-estimate', 'Estimate Key', occurredAt);
  insertAccount(context.db, '303', 'Estimate Account', occurredAt);
  insertRevenue(context.db, {
    id: 'estimate-revenue', accountId: '303', providerId: provider.id,
    keyId: 'key-estimate', occurredAt, cashRevenue: 5
  });
  insertCost(context.db, {
    id: 'estimate-cost', providerId: provider.id, keyId: 'key-estimate',
    occurredAt, cashCost: 2, rechargeSource: 'default'
  });
  const service = new GrossProfitService({ db: context.db, config: context.config });
  const report = service.report({
    from: '2026-08-17',
    to: '2026-08-17',
    connectionId: provider.id
  });

  assert.equal(report.summary.status, 'estimated');
  assert.equal(report.summary.grossProfit, null);
  assert.equal(report.summary.estimatedGrossProfit, 3);
  assert.equal(report.summary.provisionalGrossProfit, 3);
  assert.equal(report.summary.unconfirmedCostRequests, 1);
  assert.equal(report.entities[0].status, 'estimated');
});

test('gross profit rejects invalid dimensions and oversized daily ranges', (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const service = new GrossProfitService({ db: context.db, config: context.config });
  assert.throws(
    () => service.report({ dimension: 'model' }),
    (error) => error.code === 'VALIDATION_ERROR' && error.status === 400
  );
  assert.throws(
    () => service.report({ from: '2025-01-01', to: '2026-08-17', granularity: 'day' }),
    (error) => error.code === 'VALIDATION_ERROR' && error.status === 400
  );
});

test('gross profit HTTP endpoint is authenticated and validates query dimensions', async (t) => {
  const context = createTestContext({ PROVIDER_MONITOR_TIMEZONE: 'Asia/Shanghai' });
  setupLedger(context);
  const app = createApplication({ config: context.config, db: context.db, startBackground: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await app.locals.close();
    context.cleanup();
  });

  const unauthorized = await fetch(`${baseUrl}/api/gross-profit`);
  assert.equal(unauthorized.status, 401);
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-password' })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const response = await fetch(
    `${baseUrl}/api/gross-profit?dimension=provider&granularity=day&from=2026-08-16&to=2026-08-17`,
    { headers: { Cookie: cookie } }
  );
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.equal(report.summary.grossProfit, 6);
  assert.equal(report.periods.length, 2);
  assert.equal(report.entities.length, 2);

  const invalid = await fetch(`${baseUrl}/api/gross-profit?dimension=model`, {
    headers: { Cookie: cookie }
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'VALIDATION_ERROR');
});
