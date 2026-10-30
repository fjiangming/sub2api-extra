const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');
const { ProviderRepository } = require('../src/repositories/provider-repository');
const {
  ADMINISTRATOR_USER_ID,
  GrossProfitService,
  bucketForTimestamp
} = require('../src/services/gross-profit-service');
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
  attributionStatus = 'attributed', userId = '2'
}) {
  db.prepare(`
    INSERT INTO sub2api_account_cost_ledger(
      source_log_id, user_id, account_id, currency, cost, request_count,
      occurred_at, ingested_at, updated_at, recharge_multiplier,
      recharge_source, cash_currency, cash_revenue, connection_id, key_id,
      attribution_status, first_observed_at, last_observed_at
    ) VALUES (?, ?, ?, 'USD', ?, 1, ?, ?, ?, 2, 'base_settings', 'USD', ?, ?, ?, ?, ?, ?)
  `).run(
    id, userId, accountId, cashRevenue * 2, occurredAt, occurredAt, occurredAt,
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

function setupAdministratorLedger(context, provider) {
  const occurredAt = '2026-08-16T16:45:00.000Z';
  insertRevenue(context.db, {
    id: 'admin-revenue',
    accountId: '101',
    providerId: provider.id,
    keyId: 'key-alpha',
    occurredAt,
    cashRevenue: 4,
    userId: ADMINISTRATOR_USER_ID
  });
  insertCost(context.db, {
    id: 'admin-cost',
    providerId: provider.id,
    keyId: 'key-alpha',
    occurredAt,
    cashCost: 1,
    attributedAccountId: '101'
  });
  insertAccount(context.db, '1', 'Upstream Account #1', occurredAt);
  insertRevenue(context.db, {
    id: 'non-admin-upstream-account-one',
    accountId: '1',
    providerId: provider.id,
    keyId: 'key-alpha',
    occurredAt,
    cashRevenue: 2,
    userId: '42'
  });
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
    timezone: 'Asia/Shanghai',
    accountingMode: 'standard'
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

test('gross profit supports standard, administrator exclusion and administrator expense modes', (t) => {
  const context = createTestContext({ PROVIDER_MONITOR_TIMEZONE: 'Asia/Shanghai' });
  t.after(() => context.cleanup());
  const { alpha } = setupLedger(context);
  setupAdministratorLedger(context, alpha);
  const service = new GrossProfitService({
    db: context.db,
    config: context.config,
    now: () => new Date('2026-08-17T12:00:00.000Z')
  });
  const input = { from: '2026-08-16', to: '2026-08-17' };

  const standard = service.report(input);
  assert.equal(standard.query.accountingMode, 'standard');
  assert.equal(standard.summary.revenue, 24);
  assert.equal(standard.summary.upstreamCost, 13);
  assert.equal(standard.summary.administratorExpense, 0);
  assert.equal(standard.summary.grossProfit, 11);
  assert.equal(standard.summary.unknownRequesterUserRequestCount, 0);

  const excluded = service.report({ ...input, accountingMode: 'exclude_admin' });
  assert.equal(excluded.query.accountingMode, 'exclude_admin');
  assert.equal(excluded.summary.revenue, 20);
  assert.equal(excluded.summary.upstreamCost, 13);
  assert.equal(excluded.summary.administratorExpense, 0);
  assert.equal(excluded.summary.grossProfit, 7);
  assert.equal(excluded.summary.accountingModeComplete, true);

  const expense = service.report({ ...input, mode: 'admin_as_expense' });
  assert.equal(expense.query.accountingMode, 'admin_expense');
  assert.equal(expense.summary.revenue, 20);
  assert.equal(expense.summary.upstreamCost, 13);
  assert.equal(expense.summary.administratorExpense, 4);
  assert.equal(expense.summary.administratorRequestCount, 1);
  assert.equal(expense.summary.operatingGrossProfit, 7);
  assert.equal(expense.summary.totalCost, 17);
  assert.equal(expense.summary.grossProfit, 3);
  assert.equal(expense.summary.grossMarginRatio, 0.15);
  assert.deepEqual(expense.periods.map((period) => [
    period.periodKey,
    period.grossProfit,
    period.administratorExpense
  ]), [
    ['2026-08-16', 3, 0],
    ['2026-08-17', 0, 4]
  ]);

  const accountExpense = service.report({
    ...input,
    accountingMode: 'admin_expense',
    dimension: 'account'
  });
  const administratorUsage = accountExpense.entities.find(
    (entity) => entity.entityId === '101'
  );
  assert.equal(administratorUsage.entityName, 'Alpha Account');
  assert.equal(administratorUsage.revenue, 8);
  assert.equal(administratorUsage.upstreamCost, 7);
  assert.equal(administratorUsage.administratorExpense, 4);
  assert.equal(administratorUsage.grossProfit, -3);
  const nonAdministratorOnAccountOne = accountExpense.entities.find(
    (entity) => entity.entityId === '1'
  );
  assert.equal(nonAdministratorOnAccountOne.entityName, 'Upstream Account #1');
  assert.equal(nonAdministratorOnAccountOne.revenue, 2);
});

test('administrator modes report legacy rows without a requester user id', (t) => {
  const context = createTestContext({ PROVIDER_MONITOR_TIMEZONE: 'Asia/Shanghai' });
  t.after(() => context.cleanup());
  const { alpha } = setupLedger(context);
  insertRevenue(context.db, {
    id: 'legacy-requester-unknown',
    accountId: '101',
    providerId: alpha.id,
    keyId: 'key-alpha',
    occurredAt: '2026-08-16T16:45:00.000Z',
    cashRevenue: 1,
    userId: null
  });
  const service = new GrossProfitService({ db: context.db, config: context.config });
  const report = service.report({
    from: '2026-08-16',
    to: '2026-08-17',
    accountingMode: 'exclude_admin'
  });

  assert.equal(report.summary.unknownRequesterUserRequestCount, 1);
  assert.equal(report.summary.requesterUserCoverageComplete, false);
  assert.equal(report.summary.accountingModeComplete, false);
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
  assert.throws(
    () => service.report({ accountingMode: 'unknown' }),
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
  assert.equal(report.query.accountingMode, 'standard');
  assert.equal(report.periods.length, 2);
  assert.equal(report.entities.length, 2);

  const invalid = await fetch(`${baseUrl}/api/gross-profit?dimension=model`, {
    headers: { Cookie: cookie }
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'VALIDATION_ERROR');

  const invalidMode = await fetch(`${baseUrl}/api/gross-profit?accountingMode=unknown`, {
    headers: { Cookie: cookie }
  });
  assert.equal(invalidMode.status, 400);
  assert.equal((await invalidMode.json()).error.code, 'VALIDATION_ERROR');
});

function syncCoverage(db, providerId, changes = {}) {
  const state = { status: 'succeeded', from: '2026-08-15T16:00:00.000Z',
    to: '2026-08-18T16:00:00.000Z', truncated: 0, ...changes };
  db.prepare(`INSERT OR REPLACE INTO provider_request_log_sync_state
    (connection_id, status, coverage_from, coverage_to, truncated, last_synced_at, updated_at)
    VALUES (?, ?, ?, ?, ?, '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z')`
  ).run(providerId, state.status, state.from, state.to, state.truncated);
}

function dailySetup(t) {
  const context = createTestContext({ PROVIDER_MONITOR_TIMEZONE: 'UTC' });
  t.after(() => context.cleanup());
  const { alpha, beta } = setupLedger(context);
  for (const provider of [alpha, beta]) {
    context.db.prepare("UPDATE provider_connections SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(provider.id);
    syncCoverage(context.db, provider.id);
  }
  const service = new GrossProfitService({ db: context.db, config: context.config,
    now: () => new Date('2026-08-19T00:00:00.000Z') });
  return { ...context, alpha, beta, service,
    input: { from: '2026-08-16', to: '2026-08-17', timezone: 'Asia/Shanghai' } };
}

test('daily supplier costs use cash costs and the requested finance timezone, retaining disabled historical suppliers', (t) => {
  const { service, input } = dailySetup(t);
  const report = service.dailyCosts(input);
  assert.equal(report.source, 'provider_cost_ledger');
  assert.equal(report.timezone, 'Asia/Shanghai');
  assert.deepEqual(report.items.map((row) => [row.date, row.cost, row.requests, row.complete]), [
    ['2026-08-16', 2, 1, true], ['2026-08-17', 10, 2, true]
  ]);
  assert.equal(report.items[0].providers.length, 2);
  assert.equal(report.items[0].providers.find((provider) => provider.name === 'Beta Supplier').cost, 0);
  assert.doesNotMatch(JSON.stringify(report), /secret-|baseUrl|apiKey|credentials/);
  const utc = service.dailyCosts({ ...input, timezone: 'UTC' });
  assert.equal(utc.items[0].cost, 12);
  assert.equal(utc.items[1].cost, 0);
});

test('daily supplier costs apply confirmed recharge multipliers and configured currency conversion once', (t) => {
  const { service, input, db } = dailySetup(t);
  db.prepare("INSERT OR REPLACE INTO settings VALUES ('displayCurrency', ?, '2026-08-19')").run(JSON.stringify('CNY'));
  db.prepare("INSERT OR REPLACE INTO settings VALUES ('currencyRates', ?, '2026-08-19')").run(JSON.stringify({ USD: 7, CNY: 1 }));
  db.prepare('UPDATE provider_cost_ledger SET cash_cost = NULL').run();
  const report = service.dailyCosts({ ...input, currency: 'CNY' });
  assert.deepEqual(report.items.map((row) => row.cost), [14, 70]);
  assert.equal(report.items[1].complete, true);
  db.prepare("UPDATE provider_cost_ledger SET cash_currency = 'EUR' WHERE source_log_id = 'alpha-cost-17'").run();
  const missing = service.dailyCosts({ ...input, currency: 'CNY' });
  assert.equal(missing.items[0].cost, 14);
  assert.equal(missing.items[1].cost, null);
  assert.match(JSON.stringify(missing.items[1].providers), /缺少币种汇率/);
});

test('daily supplier costs exclude shadow and superseded duplicates while preserving all active supplier expense', (t) => {
  const { service, input, db, alpha } = dailySetup(t);
  setupAdministratorLedger({ db }, alpha);
  for (const [id, accounting, comparable] of [
    ['shadow', 'shadow', 1], ['old', 'superseded', 1], ['opening', 'active', 0]
  ]) {
    insertCost(db, { id, providerId: alpha.id, keyId: 'key-alpha',
      occurredAt: '2026-08-16T17:00:00.000Z', cashCost: 100 });
    db.prepare('UPDATE provider_cost_ledger SET accounting_status = ?, comparable = ? WHERE source_log_id = ?').run(accounting, comparable, id);
  }
  assert.equal(service.dailyCosts(input).items[1].cost, 11);
});

test('daily supplier costs distinguish unavailable, truncated and incomplete coverage from verified zero use', (t) => {
  const { service, input, db, alpha } = dailySetup(t);
  for (const changes of [
    { status: 'failed' }, { truncated: 1 }, { from: '2026-08-16T17:00:00.000Z' },
    { to: '2026-08-17T15:59:59.000Z' }
  ]) {
    syncCoverage(db, alpha.id, changes);
    const report = service.dailyCosts(input);
    assert.equal(report.items[1].cost, null);
    assert.equal(report.items[1].complete, false);
  }
  syncCoverage(db, alpha.id);
  assert.equal(service.dailyCosts(input).items[1].cost, 10);
  db.prepare('UPDATE provider_connections SET enabled = 1').run();
  const emptyDay = service.dailyCosts({ ...input, from: '2026-08-18', to: '2026-08-18' });
  assert.equal(emptyDay.items[0].cost, 0);
  assert.equal(emptyDay.items[0].complete, true);
});

test('daily supplier costs reject unknown values, unconfirmed multipliers and counter-only daily estimates', (t) => {
  const { service, input, db } = dailySetup(t);
  const updates = [
    "cost = NULL, request_count = 0",
    "cost = 8, recharge_source = 'default'",
    "recharge_source = 'manual', source_type = 'usage_counter'",
    "source_type = 'request_log', cash_cost = -1"
  ];
  for (const update of updates) {
    db.prepare(`UPDATE provider_cost_ledger SET ${update} WHERE source_log_id = 'alpha-cost-17'`).run();
    const report = service.dailyCosts(input);
    assert.equal(report.items[1].cost, null);
    assert.equal(report.items[1].complete, false);
  }
});

test('daily supplier costs never assume a USD to CNY rate when only the display currency is configured', (t) => {
  const { service, input, db } = dailySetup(t);
  db.prepare("INSERT OR REPLACE INTO settings VALUES ('displayCurrency', ?, '2026-08-19')").run(JSON.stringify('CNY'));
  const report = service.dailyCosts({ ...input, currency: 'CNY' });
  assert.equal(report.items[0].cost, null);
  assert.match(JSON.stringify(report.items[0].providers), /缺少币种汇率/);
});

test('daily supplier costs keep stale current-day coverage unverified and include newly enabled unsynchronized suppliers', (t) => {
  const { service, input, db } = dailySetup(t);
  const providers = new ProviderRepository(db, service.config);
  const provider = createProvider(providers, 'New Supplier', 'daily-new');
  db.prepare("UPDATE provider_connections SET enabled = 1, created_at = '2026-08-17T08:00:00.000Z' WHERE id = ?").run(provider.id);
  const report = service.dailyCosts(input);
  assert.equal(report.items[0].cost, 2);
  assert.equal(report.items[1].cost, null);
  assert.equal(report.items[1].providers.find((item) => item.id === provider.id).complete, false);
  db.prepare('UPDATE provider_connections SET enabled = 1').run();
  const today = service.dailyCosts({ ...input, from: '2026-08-19', to: '2026-08-19' });
  assert.equal(today.items[0].cost, null);
});

test('daily supplier costs do not invent zero when no monitored suppliers can be verified and validate ranges', (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const service = new GrossProfitService({ db: context.db, config: context.config });
  assert.equal(service.dailyCosts({ from: '2026-08-17', to: '2026-08-17' }).items[0].cost, null);
  assert.throws(() => service.dailyCosts({ timezone: 'bad/timezone' }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => service.dailyCosts({ from: '2025-01-01', to: '2026-08-17' }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => service.dailyCosts({ from: '2026-02-30', to: '2026-03-01' }), { code: 'VALIDATION_ERROR' });
});

test('daily supplier costs require integration or administrator authentication and return no-store safe data', async (t) => {
  const token = 'integration-daily-cost-token-0123456789abcdef';
  const context = createTestContext({ PROVIDER_MONITOR_INTEGRATION_TOKEN: token });
  setupLedger(context);
  const app = createApplication({ config: context.config, db: context.db, startBackground: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await app.locals.close();
    context.cleanup();
  });
  const query = '?from=2026-08-16&to=2026-08-17&timezone=Asia%2FShanghai';
  assert.equal((await fetch(`${base}/api/daily-costs${query}`)).status, 401);
  assert.equal((await fetch(`${base}/api/integrations/daily-costs${query}`)).status, 401);
  assert.equal((await fetch(`${base}/api/integrations/daily-costs${query}`, {
    headers: { authorization: 'Bearer wrong' }
  })).status, 401);
  const integration = await fetch(`${base}/api/integrations/daily-costs${query}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(integration.status, 200);
  assert.equal(integration.headers.get('cache-control'), 'no-store');
  const data = await integration.json();
  assert.equal(data.items.length, 2);
  assert.doesNotMatch(JSON.stringify(data), /secret-|baseUrl|apiKey|credentials/);
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-password' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const admin = await fetch(`${base}/api/daily-costs${query}`, { headers: { cookie } });
  assert.equal(admin.status, 200);
  assert.equal(admin.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await admin.json()).items, data.items);
});
