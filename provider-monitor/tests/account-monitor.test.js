const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createTestContext } = require('./helpers');
const { createApplication } = require('../src/server');
const { Sub2ApiAdminClient } = require('../src/services/sub2api-admin-client');
const { ProviderRepository } = require('../src/repositories/provider-repository');
const {
  AccountMonitorService,
  CHALLENGE_EXPECTED,
  accountMonitorWindow,
  createCapabilityChallenge,
  requestPairingTrust,
  scoreCapabilityChallenge,
  scoreChallenge
} = require('../src/services/account-monitor-service');

function answerCapabilityPrompt(prompt) {
  const arithmetic = prompt.match(/Arithmetic: calculate (\d+) \* (\d+) - (\d+)\./);
  const sequence = prompt.match(/Sequence: give the next number in ([\d, ]+)\./);
  const sorting = prompt.match(/Sort: sort \[([\d, ]+)\] in descending order\./);
  const checksum = prompt.match(/Checksum: concatenate the uppercase first letters of ([a-z, ]+)\./);
  assert.ok(arithmetic && sequence && sorting && checksum, 'dynamic capability prompt must be parseable');
  const sequenceValues = sequence[1].split(',').map((value) => Number(value.trim()));
  const lastDifference = sequenceValues.at(-1) - sequenceValues.at(-2);
  return JSON.stringify({
    arithmetic: Number(arithmetic[1]) * Number(arithmetic[2]) - Number(arithmetic[3]),
    logic: 'NO',
    sequence: sequenceValues.at(-1) + lastDifference + 2,
    sorted: sorting[1].split(',').map((value) => Number(value.trim()))
      .sort((left, right) => right - left),
    checksum: checksum[1].split(',').map((word) => word.trim()[0].toUpperCase()).join('')
  });
}

function insertMonitoredAccount(db, account) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO sub2api_monitored_accounts(
      account_id, name, platform, account_type, status, schedulable,
      metadata_json, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, 'active', 1, '{}', ?, ?)
  `).run(String(account.id), account.name, account.platform, account.type, now, now);
}

function setBaseLogCoverage(db, from, to) {
  db.prepare(`
    UPDATE sub2api_account_monitor_state SET
      last_log_sync_at = ?, last_sync_status = 'succeeded', last_sync_error = NULL,
      last_sync_summary_json = ?, updated_at = ?
    WHERE id = 1
  `).run(to, JSON.stringify({
    usageExactTotal: true,
    usageFullBackfill: true,
    usageCoverageFrom: from,
    usageCoverageTo: to,
    usageTruncated: false
  }), to);
}

function createSub2ApiMock() {
  const calls = [];
  let usageReturned = false;
  let groupCatalogReturned = false;
  return {
    calls,
    authenticationStatus() {
      return { available: true, source: 'test' };
    },
    async adminToken() {
      calls.push({ type: 'auth' });
      return 'test-admin-token';
    },
    async listAll(endpoint, query) {
      calls.push({ type: 'list', endpoint, query });
      if (endpoint === '/api/v1/admin/accounts') {
        return {
          items: [
            {
              id: 11,
              name: 'OpenAI Fast',
              platform: 'openai',
              type: 'oauth',
              status: 'active',
              schedulable: true,
              priority: 10,
              group_ids: [101, 102],
              credentials: { access_token: 'must-not-be-stored' }
            },
            {
              id: 12,
              name: 'Claude Pool',
              platform: 'anthropic',
              type: 'oauth',
              status: 'active',
              schedulable: true,
              groups: [{ id: 102, name: 'Embedded fallback name' }]
            }
          ],
          total: 2,
          truncated: false
        };
      }
      if (endpoint === '/api/v1/admin/usage') {
        if (usageReturned) return { items: [], total: 0, truncated: false };
        usageReturned = true;
        return {
          items: [
            {
              id: 101,
              account_id: 11,
              request_id: 'request-101',
              model: 'gpt-5.4',
              upstream_model: 'gpt-5.4',
              stream: true,
              duration_ms: 4200,
              first_token_ms: 1200,
              input_tokens: 100,
              output_tokens: 300,
              cache_read_tokens: 900,
              cache_creation_tokens: 0,
              actual_cost: 0.02,
              created_at: new Date(Date.now() - 60000).toISOString()
            },
            {
              id: 102,
              account_id: 11,
              request_id: 'request-102',
              model: 'gpt-5.4',
              stream: true,
              duration_ms: 5000,
              first_token_ms: 1800,
              input_tokens: 100,
              output_tokens: 320,
              cache_read_tokens: 0,
              cache_creation_tokens: 0,
              actual_cost: 0.03,
              created_at: new Date(Date.now() - 30000).toISOString()
            },
            {
              id: 103,
              account_id: 11,
              request_id: 'request-103',
              model: 'gpt-5.4',
              stream: false,
              duration_ms: 50,
              first_token_ms: 0,
              output_tokens: 100,
              created_at: new Date(Date.now() - 15000).toISOString()
            }
          ],
          total: 3,
          truncated: false
        };
      }
      throw new Error(`Unexpected endpoint ${endpoint}`);
    },
    async data(endpoint) {
      calls.push({ type: 'data', endpoint });
      if (endpoint === '/api/v1/admin/groups/all') {
        if (groupCatalogReturned) throw new Error('Group catalog unavailable');
        groupCatalogReturned = true;
        return [
          { id: 101, name: '高速组', platform: 'openai', status: 'active', rate_multiplier: 1.2 },
          { id: 102, name: '共享组', status: 'active', rate_multiplier: 0.8 }
        ];
      }
      throw new Error(`Unexpected endpoint ${endpoint}`);
    },
    async sse(endpoint, options) {
      calls.push({ type: 'sse', endpoint, body: options.body });
      await options.onEvent({ type: 'test_start', model: options.body.model_id || 'default-test-model' });
      if (endpoint.includes('/11/')) {
        assert.match(options.body.prompt, /LOCALCAP2 challenge/);
        const answer = answerCapabilityPrompt(options.body.prompt);
        await options.onEvent({ type: 'content', text: answer.slice(0, 30) });
        await options.onEvent({ type: 'content', text: answer.slice(30) });
      } else {
        assert.equal(options.body.prompt, '');
        await options.onEvent({ type: 'content', text: 'healthy' });
      }
      await options.onEvent({ type: 'test_complete', success: true });
      return { eventCount: 4, bytes: 100 };
    }
  };
}

test('account monitor syncs redacted metrics and scores dynamic capability probes', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const sub2api = createSub2ApiMock();
  const monitor = new AccountMonitorService({ db: context.db, config: context.config, sub2api });

  const sync = await monitor.sync();
  assert.equal(sync.accountCount, 2);
  assert.equal(sync.groupCount, 2);
  assert.equal(sync.groupCatalogComplete, true);
  assert.equal(sync.fetchedSampleCount, 3);
  assert.deepEqual(sync.truncatedDates, []);
  const usageCalls = sub2api.calls.filter((call) => call.endpoint === '/api/v1/admin/usage');
  assert.ok(usageCalls.length > 1);
  assert.ok(usageCalls.every((call) => call.query.start_date === call.query.end_date));
  assert.ok(usageCalls.every((call) => call.query.exact_total === true));
  assert.equal(sync.usageExactTotal, true);
  assert.equal(sync.usageFullBackfill, true);
  assert.ok(Date.parse(sync.usageCoverageFrom) < Date.parse(sync.usageCoverageTo));
  const callsBeforeExpandedBackfill = sub2api.calls.length;
  const expandedSync = await monitor.sync({ lookbackDays: 14 });
  const expandedUsageCalls = sub2api.calls.slice(callsBeforeExpandedBackfill)
    .filter((call) => call.endpoint === '/api/v1/admin/usage');
  assert.equal(expandedSync.usageFullBackfill, true);
  assert.equal(expandedSync.groupCatalogComplete, false);
  assert.ok(expandedUsageCalls.length >= 14);
  assert.ok(expandedUsageCalls.every((call) => call.query.exact_total === true));
  assert.doesNotMatch(
    context.db.prepare('SELECT metadata_json FROM sub2api_monitored_accounts WHERE account_id = ?').get('11').metadata_json,
    /must-not-be-stored/
  );
  const cachedGroups = monitor.accounts({ platform: 'openai', days: 7 }).items[0].groups;
  assert.deepEqual(cachedGroups.map((group) => [group.id, group.name]), [['101', '高速组'], ['102', '共享组']]);

  const listing = monitor.accounts({ platform: 'openai', days: 7 });
  assert.equal(listing.items.length, 1);
  assert.deepEqual(listing.platforms, ['anthropic', 'openai']);
  assert.equal(listing.items[0].metrics.requestCount, 3);
  assert.equal(listing.items[0].metrics.cacheRate, 81.8);
  assert.equal(listing.items[0].metrics.ttftP50Ms, 1200);
  assert.equal(listing.items[0].metrics.ttftP95Ms, 1800);
  assert.equal(listing.items[0].metrics.ttftSampleCount, 2);
  assert.ok(listing.items[0].metrics.outputTokensPerSecond >= 100);
  assert.deepEqual(
    listing.items[0].groups.map((group) => [group.id, group.name]),
    [['101', '高速组'], ['102', '共享组']]
  );
  assert.deepEqual(listing.items[0].groups.map((group) => group.rateMultiplier), [1.2, 0.8]);
  assert.deepEqual(
    listing.groups.map((group) => [group.id, group.accountCount])
      .sort((left, right) => left[0].localeCompare(right[0])),
    [['101', 1], ['102', 1]]
  );
  const grouped = monitor.accounts({ display: 'groups', days: 7 });
  assert.equal(grouped.itemType, 'group');
  assert.equal(grouped.pagination.total, 2);
  assert.equal(grouped.summary.accountCount, 2);
  assert.equal(grouped.summary.baseGroupCount, 2);
  assert.equal(grouped.summary.ungroupedAccountCount, 0);
  assert.equal(grouped.summary.groupMembershipCount, 3);
  const sharedGroup = grouped.items.find((group) => group.groupId === '102');
  assert.equal(sharedGroup.accountCount, 2);
  assert.equal(sharedGroup.metrics.requestCount, 3);
  assert.equal(sharedGroup.metrics.cacheRate, 81.8);
  assert.equal(sharedGroup.coverage.mappedAccountCount, 0);
  assert.deepEqual(
    sharedGroup.accounts.map((account) => account.accountId).sort(),
    ['11', '12']
  );
  assert.deepEqual(
    monitor.accounts({ groupId: '102', days: 7 }).items.map((item) => item.accountId).sort(),
    ['11', '12']
  );
  assert.equal(monitor.accounts({ platform: 'anthropic', days: 7 }).items[0].comparison.metricReason, 'no_enabled_mapping');

  const probe = await monitor.probe({ accountIds: ['11', '12'], triggerType: 'manual' });
  assert.equal(probe.accountCount, 2);
  assert.equal(probe.succeeded, 2);
  assert.equal(probe.results[0].intelligenceScore, 100);
  assert.equal(probe.results[0].instructionScore, 100);
  assert.equal(probe.results[0].suite, 'capability_v2');
  assert.equal(probe.results[0].details.challengeVersion, 2);
  assert.equal(probe.results[1].suite, 'connectivity_v1');
  assert.equal(probe.results[1].intelligenceScore, null);
  assert.equal(monitor.accounts({ platform: 'anthropic', days: 7 }).items[0].metrics.intelligenceScore, null);

  const detail = monitor.account('11', { days: 7 });
  assert.equal(detail.probes.length, 1);
  assert.equal(detail.metrics.probeSuccessRate, 100);
  assert.equal(detail.metrics.intelligenceScore, 100);
  assert.ok(detail.metrics.qualityScore > 90);
});

test('account quality compares mapped provider logs and same-window upstream cost', (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'Mapped New API',
    adapterType: 'new-api',
    baseUrl: 'https://mapped-provider.example',
    authMode: 'system_token',
    remoteUserId: 'provider-user',
    credentials: { systemToken: 'not-stored-in-samples' }
  });
  const now = Date.now();
  const iso = (minutesAgo) => new Date(now - minutesAgo * 60000).toISOString();
  insertMonitoredAccount(context.db, {
    id: 501,
    name: 'Mapped account',
    platform: 'openai',
    type: 'apikey'
  });
  context.db.prepare(`
    INSERT INTO remote_accounts(
      id, connection_id, remote_id, display_name, status, metadata_json,
      first_seen_at, last_seen_at
    ) VALUES ('remote-account', ?, 'provider-user', 'Provider user', 'active', '{}', ?, ?)
  `).run(provider.id, iso(70), iso(5));
  context.db.prepare(`
    INSERT INTO remote_keys(
      id, connection_id, remote_account_id, remote_id, name, masked_key,
      status, unlimited, currency, metadata_json, first_seen_at, last_seen_at
    ) VALUES ('mapped-key', ?, 'remote-account', '77', 'Mapped key', 'sk-...test',
      'enabled', 0, 'USD', '{}', ?, ?)
  `).run(provider.id, iso(70), iso(5));
  context.db.prepare(`
    INSERT INTO sub2api_mappings(
      id, connection_id, key_id, channel_id, account_id, group_id, role,
      enabled, models_json, config_json, created_at, updated_at
    ) VALUES ('mapped-account-link', ?, 'mapped-key', 1, 501, 1, 'primary',
      1, '[]', '{}', ?, ?)
  `).run(provider.id, iso(70), iso(5));
  context.db.prepare(`
    INSERT INTO provider_request_log_sync_state(
      connection_id, status, coverage_from, coverage_to, truncated,
      total_count, last_synced_at, updated_at
    ) VALUES (?, 'succeeded', ?, ?, 0, 2, ?, ?)
  `).run(provider.id, iso(7 * 24 * 60), iso(1), iso(1), iso(1));
  context.db.prepare(`
    INSERT INTO provider_request_key_sync_state(
      key_id, connection_id, status, coverage_from, coverage_to, truncated,
      total_count, last_synced_at, updated_at
    ) VALUES ('mapped-key', ?, 'succeeded', ?, ?, 0, 3, ?, ?)
  `).run(provider.id, iso(7 * 24 * 60), iso(1), iso(1), iso(1));
  context.db.prepare(`
    INSERT INTO provider_recharge_rates(
      connection_id, manual_multiplier, status, metadata_json, updated_at
    ) VALUES (?, 2, 'manual', '{}', ?)
  `).run(provider.id, iso(1));
  context.db.prepare(`
    UPDATE sub2api_account_monitor_settings SET base_recharge_multiplier = 2 WHERE id = 1
  `).run();
  setBaseLogCoverage(context.db, iso(7 * 24 * 60), iso(1));

  const insertBase = context.db.prepare(`
    INSERT INTO sub2api_account_request_samples(
      source_log_id, account_id, request_id, model, stream, duration_ms,
      first_token_ms, input_tokens, output_tokens, cache_creation_tokens,
      cache_read_tokens, actual_cost, created_at, ingested_at
    ) VALUES (?, '501', ?, 'gpt-test', 1, ?, ?, ?, ?, 0, ?, ?, ?, ?)
  `);
  insertBase.run('base-1', 'request-1', 2200, 800, 100, 100, 100, 0.02, iso(40), iso(1));
  insertBase.run('base-2', 'request-2', 2800, 1200, 100, 120, 0, 0.02, iso(20), iso(1));
  insertBase.run('base-after-coverage', 'request-after-coverage', 900, 300, 50, 50, 0, 0.1, iso(0.5), iso(0.1));
  const insertUpstream = context.db.prepare(`
    INSERT INTO provider_request_samples(
      connection_id, key_id, source_log_id, request_id, model, stream, status,
      duration_ms, first_token_ms, input_tokens, output_tokens,
      cache_creation_tokens, cache_read_tokens, actual_cost, currency,
      created_at, ingested_at
    ) VALUES (?, 'mapped-key', ?, ?, 'gpt-test', 1, 'success', ?, ?, ?, ?, 0, ?, ?, 'USD', ?, ?)
  `);
  insertUpstream.run(provider.id, 'provider-1', 'request-1', 1800, 700, 100, 100, 100, 0.01, iso(40), iso(1));
  insertUpstream.run(provider.id, 'provider-2', 'different-request-id', 2300, 1000, 100, 120, 0, 0.02, iso(20), iso(1));
  insertUpstream.run(provider.id, 'provider-extra', 'direct-request', 3100, 1400, 999, 50, 0, 0.05, iso(10), iso(1));
  const insertUsage = context.db.prepare(`
    INSERT INTO usage_snapshots(
      connection_id, subject_type, subject_id, currency, cost, requests,
      input_tokens, output_tokens, total_tokens, model, period, raw_json, captured_at
    ) VALUES (?, 'key', 'mapped-key', 'USD', ?, ?, ?, ?, ?, NULL, 'cumulative', '{}', ?)
  `);
  insertUsage.run(provider.id, 1, 10, 1000, 100, 1100, iso(7 * 24 * 60 + 10));
  insertUsage.run(provider.id, 1.03, 12, 1200, 320, 1520, iso(10));
  context.db.prepare(`
    INSERT INTO balance_snapshots(
      connection_id, subject_type, subject_id, currency, used, raw_json, captured_at
    ) VALUES (?, 'key', 'mapped-key', 'USD', 0, '{}', ?),
      (?, 'key', 'mapped-key', 'USD', 0, '{}', ?)
  `).run(provider.id, iso(7 * 24 * 60 + 10), provider.id, iso(10));

  const monitor = new AccountMonitorService({
    db: context.db,
    config: context.config,
    sub2api: {}
  });
  const item = monitor.accounts({ search: 'Mapped account', days: 7 }).items[0];
  assert.equal(item.groupAssociationsKnown, false);
  assert.equal(item.groupAssociationSource, 'mapping_cache');
  assert.deepEqual(item.groups.map((group) => [group.id, group.name]), [['1', '分组 #1']]);
  const cachedGroupListing = monitor.accounts({
    display: 'groups',
    search: 'Mapped account',
    days: 7
  });
  assert.equal(cachedGroupListing.items.length, 1);
  assert.equal(cachedGroupListing.items[0].groupId, '1');
  assert.equal(cachedGroupListing.items[0].cachedMembershipAccountCount, 1);
  assert.equal(cachedGroupListing.summary.baseGroupCount, 1);
  assert.equal(cachedGroupListing.summary.pendingGroupAccountCount, 1);
  assert.equal(cachedGroupListing.summary.mappingCachedGroupAccountCount, 1);
  assert.equal(cachedGroupListing.summary.ungroupedAccountCount, 0);
  assert.equal(item.comparison.status, 'mapped');
  assert.equal(item.comparison.source, 'provider_request_logs');
  assert.equal(item.comparison.metricReason, 'request_pairing_insufficient');
  assert.equal(item.comparison.provider.name, 'Mapped New API');
  assert.equal(item.comparison.provider.remoteKeyId, '77');
  assert.deepEqual(item.comparison.attribution, {
    base: { scope: 'account_id', accountId: '501' },
    upstream: {
      scope: 'api_key_id',
      connectionId: provider.id,
      keyId: 'mapped-key',
      remoteKeyId: '77'
    },
    mappingId: 'mapped-account-link'
  });
  assert.equal(item.comparison.coverage.syncScope, 'key');
  assert.equal(item.metrics.requestCount, 3);
  assert.equal(item.comparison.upstream.requestCount, 3);
  assert.equal(item.comparison.upstream.ttftP95Ms, 1400);
  assert.equal(item.comparison.upstream.cacheRate, 7.7);
  assert.equal(item.comparison.base.requestCount, 2);
  assert.equal(item.comparison.windowTotals.base.requestCount, 2);
  assert.equal(item.comparison.windowTotals.upstream.requestCount, 3);
  assert.equal(item.comparison.pairing.matchedCount, 2);
  assert.equal(item.comparison.pairing.trusted, false);
  assert.equal(item.comparison.pairing.minimumSampleCount, 30);
  assert.equal(item.comparison.pairing.minimumMatchRate, 95);
  assert.deepEqual(item.comparison.pairing.matchedBy, { requestId: 1, fingerprint: 1 });
  assert.equal(item.comparison.pairing.upstreamExtraCount, null);
  assert.equal(item.comparison.pairing.observedUpstreamUnmatchedCount, 1);
  assert.equal(item.comparison.overhead, null);
  assert.equal(item.comparison.cost.comparable, false);
  assert.equal(item.comparison.cost.source, 'provider_request_logs');
  assert.equal(item.comparison.cost.scope, 'key_window');
  assert.ok(Math.abs(item.comparison.cost.baseCost - 0.04) < 1e-8);
  assert.ok(Math.abs(item.comparison.cost.upstreamCost - 0.08) < 1e-8);
  assert.ok(Math.abs(item.comparison.cost.baseCashEquivalent - 0.02) < 1e-8);
  assert.ok(Math.abs(item.comparison.cost.upstreamCashEquivalent - 0.04) < 1e-8);
  assert.equal(item.comparison.cost.differenceAmount, null);
  assert.ok(Math.abs(item.comparison.cost.keyTotalUpstreamCost - 0.08) < 1e-8);
  assert.equal(item.comparison.cost.windowComparable, true);
  assert.ok(Math.abs(item.comparison.cost.baseWindowCashEquivalent - 0.02) < 1e-8);
  assert.ok(Math.abs(item.comparison.cost.keyTotalUpstreamCashEquivalent - 0.04) < 1e-8);
  assert.ok(Math.abs(item.comparison.cost.windowDifferenceAmount + 0.02) < 1e-8);
  assert.equal(item.comparison.cost.windowProfitStatus, 'loss');
  assert.equal(item.comparison.cost.extraUpstreamCost, null);
  assert.equal(item.comparison.cost.moreExpensive, null);
  assert.equal(item.comparison.cost.profitStatus, null);
  context.db.prepare(`
    UPDATE sub2api_account_monitor_state SET last_sync_summary_json = '{}'
    WHERE id = 1
  `).run();
  const incompleteBase = monitor.account('501', { days: 7 });
  assert.equal(incompleteBase.comparison.metricReason, 'base_request_logs_incomplete');
  assert.equal(incompleteBase.comparison.pairing.upstreamExtraCount, null);
  assert.equal(incompleteBase.comparison.pairing.observedUpstreamUnmatchedCount, 1);
  assert.equal(incompleteBase.comparison.cost.windowComparable, false);
  assert.equal(incompleteBase.comparison.cost.windowReason, 'base_request_logs_incomplete');
  setBaseLogCoverage(context.db, iso(7 * 24 * 60), iso(1));
  context.db.prepare(`
    UPDATE provider_request_key_sync_state
    SET status = 'unavailable', last_error_code = 'NETWORK_UNREACHABLE',
      last_error_message = 'fetch failed', updated_at = ?
    WHERE key_id = 'mapped-key'
  `).run(iso(0));
  const retained = monitor.account('501', { days: 7 });
  assert.equal(retained.comparison.source, 'provider_request_logs');
  assert.equal(retained.comparison.metricReason, 'request_logs_stale');
  assert.equal(retained.comparison.coverage.stale, true);
  assert.equal(retained.comparison.coverage.errorCode, 'NETWORK_UNREACHABLE');
  assert.equal(retained.comparison.upstream.requestCount, 3);
  assert.equal(retained.comparison.upstream.ttftP95Ms, 1400);
  context.db.prepare(`
    UPDATE provider_request_key_sync_state
    SET status = 'succeeded', last_error_code = NULL, last_error_message = NULL,
      updated_at = ?
    WHERE key_id = 'mapped-key'
  `).run(iso(0));
  const detail = monitor.account('501', { days: 7 });
  assert.equal(detail.upstreamTrends.length, 1);
  assert.equal(detail.comparison.cost.source, 'provider_request_logs');
  context.db.prepare(`
    UPDATE usage_snapshots SET cost = 1, requests = 10
    WHERE connection_id = ? AND subject_id = 'mapped-key' AND captured_at = ?
  `).run(provider.id, iso(10));
  const stagnant = monitor.account('501', { days: 7 }).comparison.cost;
  assert.equal(stagnant.comparable, false);
  assert.equal(stagnant.source, 'provider_request_logs');
  context.db.prepare(`
    UPDATE provider_request_samples SET created_at = ? WHERE key_id = 'mapped-key'
  `).run(iso(8 * 24 * 60));
  const noTraffic = monitor.account('501', { days: 7 });
  assert.equal(noTraffic.comparison.metricReason, 'no_successful_requests');
  assert.equal(noTraffic.comparison.upstream.requestCount, 0);
  context.db.prepare("DELETE FROM provider_request_key_sync_state WHERE key_id = 'mapped-key'").run();
  context.db.prepare("DELETE FROM usage_snapshots WHERE subject_id = 'mapped-key'").run();
  const unverified = monitor.account('501', { days: 7 });
  assert.equal(unverified.comparison.source, 'unavailable');
  assert.equal(unverified.comparison.metricReason, 'request_logs_key_unverified');
  assert.equal(unverified.comparison.upstream, null);
});

test('provider quality aggregates every key and retains audited costs after samples disappear', (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'Ledger Supplier',
    adapterType: 'new-api',
    baseUrl: 'https://ledger-provider.example',
    authMode: 'system_token',
    remoteUserId: 'ledger-user',
    credentials: { systemToken: 'ledger-token' },
    rechargeMultiplier: 2
  });
  const now = Date.now();
  const iso = (minutesAgo) => new Date(now - minutesAgo * 60000).toISOString();
  for (const account of [
    { id: 601, name: 'Ledger account A', platform: 'openai', type: 'apikey' },
    { id: 602, name: 'Ledger account B', platform: 'anthropic', type: 'apikey' }
  ]) insertMonitoredAccount(context.db, account);
  const insertKey = context.db.prepare(`
    INSERT INTO remote_keys(
      id, connection_id, remote_id, name, masked_key, status, currency,
      unlimited, metadata_json, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'USD', 0, ?, ?, ?)
  `);
  insertKey.run(
    'ledger-key-a', provider.id, 'key-a', 'Key A', 'sk-a...0001', 'active',
    JSON.stringify({ identityHash: 'identity-a' }), iso(120), iso(2)
  );
  insertKey.run(
    'ledger-key-b', provider.id, 'key-b', 'Key B', 'sk-b...0002', 'missing',
    JSON.stringify({ identityHash: 'identity-b' }), iso(120), iso(2)
  );
  const insertMapping = context.db.prepare(`
    INSERT INTO sub2api_mappings(
      id, connection_id, key_id, account_id, group_id, role, enabled,
      models_json, config_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'primary', 1, '[]', '{}', ?, ?)
  `);
  insertMapping.run('ledger-map-a', provider.id, 'ledger-key-a', 601, 1, iso(60), iso(1));
  insertMapping.run('ledger-map-b', provider.id, 'ledger-key-b', 602, 2, iso(60), iso(1));
  context.db.prepare(`
    UPDATE sub2api_account_monitor_settings SET base_recharge_multiplier = 2 WHERE id = 1
  `).run();

  const insertProviderCost = context.db.prepare(`
    INSERT INTO provider_cost_ledger(
      connection_id, key_id, remote_key_id, key_identity, source_log_id, status,
      currency, cost, request_count, input_tokens, output_tokens,
      cache_creation_tokens, cache_read_tokens, occurred_at, ingested_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'success', 'USD', ?, 1, ?, ?, 0, ?, ?, ?, ?)
  `);
  insertProviderCost.run(
    provider.id, 'ledger-key-a', 'key-a', 'identity-a', 'provider-ledger-a',
    4, 100, 40, 60, iso(40), iso(1), iso(1)
  );
  insertProviderCost.run(
    provider.id, 'ledger-key-b', 'key-b', 'identity-b', 'provider-ledger-b',
    6, 200, 60, 40, iso(20), iso(1), iso(1)
  );
  context.db.prepare(`
    INSERT OR IGNORE INTO provider_cost_ledger(
      connection_id, key_id, remote_key_id, key_identity, source_log_id, status,
      currency, cost, request_count, input_tokens, output_tokens,
      cache_creation_tokens, cache_read_tokens, occurred_at, ingested_at, updated_at
    ) VALUES (?, 'ledger-key-a', 'key-a', 'identity-a', 'provider-ledger-a',
      'success', 'USD', 999, 1, 0, 0, 0, 0, ?, ?, ?)
  `).run(provider.id, iso(40), iso(0), iso(0));
  const insertBaseCost = context.db.prepare(`
    INSERT INTO sub2api_account_cost_ledger(
      source_log_id, account_id, currency, cost, request_count,
      occurred_at, ingested_at, updated_at
    ) VALUES (?, ?, 'USD', ?, 1, ?, ?, ?)
  `);
  insertBaseCost.run('base-ledger-a', '601', 8, iso(40), iso(1), iso(1));
  insertBaseCost.run('base-ledger-b', '602', 6, iso(20), iso(1), iso(1));
  const insertSample = context.db.prepare(`
    INSERT INTO provider_request_samples(
      connection_id, key_id, source_log_id, model, stream, status,
      duration_ms, first_token_ms, input_tokens, output_tokens,
      cache_creation_tokens, cache_read_tokens, actual_cost, currency,
      created_at, ingested_at
    ) VALUES (?, ?, ?, 'gpt-test', 1, 'success', 2000, ?, ?, ?, 0, ?, ?, 'USD', ?, ?)
  `);
  insertSample.run(provider.id, 'ledger-key-a', 'sample-a', 500, 100, 40, 60, 4, iso(40), iso(1));
  insertSample.run(provider.id, 'ledger-key-b', 'sample-b', 900, 200, 60, 40, 6, iso(20), iso(1));

  const monitor = new AccountMonitorService({ db: context.db, config: context.config, sub2api: {} });
  assert.deepEqual(monitor.providerRechargeAudit(provider.id), {
    connectionId: provider.id,
    providerName: 'Ledger Supplier',
    configured: false,
    rechargedAmount: null,
    currency: 'USD',
    note: '',
    updatedAt: null
  });
  const recharge = monitor.saveProviderRechargeAudit(provider.id, {
    rechargedAmount: 20,
    currency: 'usd',
    note: 'August audit'
  });
  assert.equal(recharge.rechargedAmount, 20);
  assert.equal(recharge.currency, 'USD');
  assert.equal(recharge.configured, true);

  const result = monitor.accounts({ display: 'providers', days: 7 });
  assert.equal(result.itemType, 'provider');
  assert.equal(result.pagination.total, 1);
  const supplier = result.items[0];
  assert.equal(supplier.providerName, 'Ledger Supplier');
  assert.equal(supplier.keys.length, 2);
  assert.equal(supplier.activeKeyCount, 1);
  assert.deepEqual(supplier.keys.map((key) => key.name), ['Key A', 'Key B']);
  assert.deepEqual(supplier.keys.map((key) => key.metrics.requestCount), [1, 1]);
  assert.deepEqual(supplier.keys.map((key) => key.baseMetrics.requestCount), [1, 1]);
  assert.deepEqual(supplier.keys.map((key) => key.upstreamMetrics.requestCount), [1, 1]);
  assert.ok(supplier.keys.every((key) => key.baseMetrics.available));
  assert.ok(supplier.keys.every((key) => key.upstreamMetrics.available));
  assert.equal(supplier.metrics.requestCount, 2);
  assert.equal(supplier.metrics.inputTokens, 300);
  assert.equal(supplier.metrics.outputTokens, 100);
  assert.equal(supplier.metrics.cacheReadTokens, 100);
  assert.equal(supplier.metrics.cacheRate, 25);
  assert.equal(supplier.baseMetrics.requestCount, 2);
  assert.equal(supplier.baseMetrics.available, true);
  assert.equal(supplier.upstreamMetrics.requestCount, 2);
  assert.equal(supplier.upstreamMetrics.inputTokens, 300);
  assert.equal(supplier.upstreamMetrics.outputTokens, 100);
  assert.equal(supplier.upstreamMetrics.cacheReadTokens, 100);
  assert.equal(supplier.upstreamMetrics.cacheRate, 25);
  assert.equal(supplier.upstreamMetrics.available, true);
  assert.equal(supplier.audit.windowUpstreamCost, 5);
  assert.equal(supplier.audit.lifetimeUpstreamCost, 5);
  assert.equal(supplier.audit.lifetimeBaseRevenue, 7);
  assert.equal(supplier.audit.lifetimeGrossProfit, 2);
  assert.equal(supplier.audit.lifetimeBaseRequestCount, 2);
  assert.equal(supplier.audit.lifetimeRequestCount, 2);
  assert.equal(supplier.audit.unconsumedRecharge, 15);
  assert.equal(supplier.rechargeAudit.rechargedAmount, 20);
  assert.equal(context.db.prepare('SELECT request_count FROM provider_cost_rollups').all()
    .reduce((sum, row) => sum + row.request_count, 0), 2);

  context.db.prepare('DELETE FROM provider_request_samples WHERE connection_id = ?').run(provider.id);
  const retained = monitor.accounts({ display: 'providers', days: 7 }).items[0];
  assert.equal(retained.metrics.requestCount, 2);
  assert.equal(retained.audit.lifetimeUpstreamCost, 5);
  assert.equal(retained.audit.lifetimeGrossProfit, 2);
  assert.equal(retained.keys.find((key) => key.name === 'Key B').status, 'missing');

  insertMapping.run('ledger-map-ambiguous', provider.id, 'ledger-key-b', 601, 2, iso(1), iso(1));
  const ambiguous = monitor.accounts({ display: 'providers', days: 7 }).items[0];
  assert.equal(ambiguous.audit.attributionComplete, true);
  assert.equal(ambiguous.audit.unattributedAccountCount, 0);
  assert.equal(ambiguous.audit.lifetimeBaseRevenue, 7);
  assert.equal(ambiguous.audit.lifetimeGrossProfit, 2);
  assert.equal(ambiguous.baseMetrics.requestCount, 2);
  assert.equal(ambiguous.audit.lifetimeBaseRequestCount, 2);
  assert.ok(ambiguous.keys.every((key) => key.baseMetrics.available === false));
  assert.ok(ambiguous.keys.every(
    (key) => key.baseMetrics.unavailableReason === 'base_key_attribution_incomplete'
  ));
  assert.ok(ambiguous.keys.every((key) => key.audit.lifetimeBaseRevenue == null));
});

test('legacy accounts await a group sync instead of being reported as ungrouped', (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  insertMonitoredAccount(context.db, {
    id: 777,
    name: 'Legacy account',
    platform: 'openai',
    type: 'apikey'
  });
  const monitor = new AccountMonitorService({
    db: context.db,
    config: context.config,
    sub2api: {}
  });

  const grouped = monitor.accounts({ display: 'groups', days: 7 });
  assert.equal(grouped.items.length, 1);
  assert.equal(grouped.items[0].groupId, '__groups_pending__');
  assert.equal(grouped.items[0].groupName, '分组待同步');
  assert.equal(grouped.items[0].pending, true);
  assert.equal(grouped.items[0].cachedMembershipAccountCount, 0);
  assert.equal(grouped.summary.pendingGroupAccountCount, 1);
  assert.equal(grouped.summary.ungroupedAccountCount, 0);
  assert.deepEqual(
    monitor.accounts({ groupId: '__groups_pending__', days: 7 }).items.map(
      (item) => item.accountId
    ),
    ['777']
  );
});

test('request pairing requires at least 30 samples and 95 percent coverage', () => {
  assert.deepEqual(requestPairingTrust({
    matchedCount: 29,
    baseMatchRate: 100,
    upstreamMatchRate: 100
  }, { baseCoverageComplete: true }), {
    trusted: false,
    reason: 'request_pairing_insufficient'
  });
  assert.deepEqual(requestPairingTrust({
    matchedCount: 30,
    baseMatchRate: 95,
    upstreamMatchRate: 95
  }, { baseCoverageComplete: true }), {
    trusted: true,
    reason: null
  });
  assert.deepEqual(requestPairingTrust({
    matchedCount: 30,
    baseMatchRate: 94.9,
    upstreamMatchRate: 100
  }, { baseCoverageComplete: true }), {
    trusted: false,
    reason: 'request_pairing_partial'
  });
});

test('seven-day account windows use seven local calendar dates including today', () => {
  assert.deepEqual(
    accountMonitorWindow(7, 'Asia/Shanghai', new Date('2026-08-07T16:30:00.000Z')),
    {
      from: '2026-08-01T16:00:00.000Z',
      to: '2026-08-07T16:30:00.000Z',
      startDate: '2026-08-02',
      endDate: '2026-08-08',
      days: 7
    }
  );
});

test('daily API Key usage wins over a cumulative counter from a rotated credential', (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'Daily Sub2API',
    adapterType: 'sub2api',
    baseUrl: 'https://daily.example',
    authMode: 'api_key',
    credentials: { apiKey: 'sk-daily-secret-12345678' },
    rechargeMultiplier: 10
  });
  const window = accountMonitorWindow(7, context.config.timezone);
  const capturedAt = window.to;
  insertMonitoredAccount(context.db, {
    id: 778,
    name: 'Daily account',
    platform: 'openai',
    type: 'apikey'
  });
  context.db.prepare(`
    INSERT INTO remote_keys(
      id, connection_id, remote_id, name, masked_key, status, currency,
      unlimited, metadata_json, first_seen_at, last_seen_at
    ) VALUES ('daily-key', ?, 'configured-api-key', 'Daily key', 'sk-d...5678',
      'active', 'USD', 0, ?, ?, ?)
  `).run(provider.id, JSON.stringify({
    identityHash: 'current-credential',
    identityAlgorithm: 'hmac-sha256-v1'
  }), window.from, capturedAt);
  context.db.prepare(`
    INSERT INTO sub2api_mappings(
      id, connection_id, key_id, account_id, group_id, role, enabled,
      models_json, config_json, created_at, updated_at
    ) VALUES ('daily-mapping', ?, 'daily-key', 778, 1, 'primary', 1,
      '[]', ?, ?, ?)
  `).run(provider.id, JSON.stringify({
    autoMapping: { keyMatch: 'exact_configured_secret' }
  }), window.from, capturedAt);
  context.db.prepare(`
    UPDATE sub2api_account_monitor_settings SET base_recharge_multiplier = 2 WHERE id = 1
  `).run();
  setBaseLogCoverage(context.db, window.from, capturedAt);
  context.db.prepare(`
    INSERT INTO sub2api_account_request_samples(
      source_log_id, account_id, request_id, model, stream, input_tokens,
      output_tokens, cache_creation_tokens, cache_read_tokens, actual_cost,
      created_at, ingested_at
    ) VALUES ('daily-base', '778', 'daily-request', 'gpt-test', 1, 42163123,
      1983263, 0, 507104128, 50.5436770158, ?, ?)
  `).run(new Date(Date.parse(capturedAt) - 60000).toISOString(), capturedAt);
  const insertUsage = context.db.prepare(`
    INSERT INTO usage_snapshots(
      connection_id, subject_type, subject_id, currency, cost, requests,
      input_tokens, output_tokens, total_tokens, model, period, raw_json, captured_at
    ) VALUES (?, 'key', 'daily-key', 'USD', ?, ?, ?, ?, ?, NULL, ?, ?, ?)
  `);
  insertUsage.run(provider.id, 0.0014645, 3, 1645, 22, 13187, 'cumulative', JSON.stringify({
    monitorMetrics: { credentialIdentity: 'previous-credential', actualCost: 0.0014645 }
  }), new Date(Date.parse(window.from) - 60000).toISOString());
  insertUsage.run(provider.id, 92.801603073, 7807, 78907951, 4624790, 996481861,
    'cumulative', JSON.stringify({
      monitorMetrics: { credentialIdentity: 'current-credential', actualCost: 92.801603073 }
    }), capturedAt);
  insertUsage.run(provider.id, 46.91940238, 4061, 42190000, 1980000, 551390000,
    `day:${window.endDate}`, JSON.stringify({
      monitorMetrics: {
        credentialIdentity: 'current-credential',
        actualCost: 46.91940238,
        cacheCreationCount: 0,
        cacheReadCount: 507210000,
        usageDate: window.endDate,
        dailyHistoryComplete: true,
        dailyCoverageStart: window.startDate,
        dailyCoverageEnd: window.endDate,
        timezone: context.config.timezone
      }
    }), capturedAt);

  const monitor = new AccountMonitorService({ db: context.db, config: context.config, sub2api: {} });
  const comparison = monitor.account('778', { days: 7 }).comparison;
  assert.equal(comparison.source, 'provider_daily_usage');
  assert.equal(comparison.window.source, 'daily_usage');
  assert.equal(comparison.window.complete, true);
  assert.equal(comparison.upstream.requestCount, 4061);
  assert.equal(comparison.upstream.actualCost, 46.91940238);
  assert.equal(comparison.base.actualCost, 50.54367702);
  assert.equal(comparison.cost.baseWindowCashEquivalent, 25.27183851);
  assert.equal(comparison.cost.keyTotalUpstreamCashEquivalent, 4.69194024);
  assert.equal(comparison.cost.windowComparable, true);
  assert.equal(comparison.cost.windowDifferenceAmount, 20.57989827);
  assert.equal(comparison.cost.windowProfitStatus, 'profit');
});

test('API Key snapshot comparison restores actual cost and cache counters from raw usage', (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'Snapshot Sub2API',
    adapterType: 'sub2api',
    baseUrl: 'https://snapshot.example',
    authMode: 'api_key',
    credentials: { apiKey: 'sk-snapshot-secret-12345678' }
  });
  const now = Date.now();
  const iso = (minutesAgo) => new Date(now - minutesAgo * 60000).toISOString();
  insertMonitoredAccount(context.db, {
    id: 777,
    name: 'Snapshot account',
    platform: 'openai',
    type: 'apikey'
  });
  context.db.prepare(`
    INSERT INTO remote_keys(
      id, connection_id, remote_id, name, masked_key, status, currency,
      unlimited, metadata_json, first_seen_at, last_seen_at
    ) VALUES ('snapshot-key', ?, 'configured-api-key', 'Snapshot key', 'sk-s...5678',
      'active', 'USD', 0, '{}', ?, ?)
  `).run(provider.id, iso(8 * 24 * 60), iso(1));
  context.db.prepare(`
    INSERT INTO sub2api_mappings(
      id, connection_id, key_id, account_id, group_id, role, enabled,
      models_json, config_json, created_at, updated_at
    ) VALUES ('snapshot-mapping', ?, 'snapshot-key', 777, 1, 'primary', 1,
      '[]', ?, ?, ?)
  `).run(provider.id, JSON.stringify({
    autoMapping: { keyMatch: 'exact_configured_secret' }
  }), iso(8 * 24 * 60), iso(1));
  const insertUsage = context.db.prepare(`
    INSERT INTO usage_snapshots(
      connection_id, subject_type, subject_id, currency, cost, requests,
      input_tokens, output_tokens, total_tokens, model, period, raw_json, captured_at
    ) VALUES (?, 'key', 'snapshot-key', 'USD', ?, ?, ?, ?, ?, NULL,
      'cumulative', ?, ?)
  `);
  insertUsage.run(provider.id, 1.5, 10, 100, 20, 170, JSON.stringify({
    cost: 1.5,
    actual_cost: 0.15,
    cache_creation_tokens: 0,
    cache_read_tokens: 50
  }), iso(7 * 24 * 60 + 10));
  insertUsage.run(provider.id, 2.5, 20, 200, 40, 400, JSON.stringify({
    cost: 2.5,
    actual_cost: 9.99,
    cache_creation_tokens: '***',
    cache_read_tokens: '***',
    monitorMetrics: {
      actualCost: 0.25,
      cacheCreationCount: 10,
      cacheReadCount: 150
    }
  }), iso(10));

  const monitor = new AccountMonitorService({
    db: context.db,
    config: context.config,
    sub2api: {}
  });
  const comparison = monitor.account('777', { days: 7 }).comparison;
  assert.equal(comparison.status, 'mapped');
  assert.equal(comparison.source, 'provider_usage_snapshots');
  assert.equal(comparison.upstream.requestCount, 10);
  assert.equal(comparison.upstream.cacheCreationTokens, 10);
  assert.equal(comparison.upstream.cacheReadTokens, 100);
  assert.equal(comparison.upstream.cacheRate, 47.6);
  assert.ok(Math.abs(comparison.upstream.actualCost - 0.1) < 1e-8);

  context.db.prepare(`
    UPDATE sub2api_mappings SET config_json = ? WHERE id = 'snapshot-mapping'
  `).run(JSON.stringify({ autoMapping: { keyMatch: 'verified_gateway_billing' } }));
  context.db.prepare(`
    UPDATE provider_connections SET auth_mode = 'token_pair' WHERE id = ?
  `).run(provider.id);
  const blocked = monitor.account('777', { days: 7 }).comparison;
  assert.equal(blocked.status, 'mapping_unverified');
  assert.equal(blocked.source, 'unavailable');
  assert.equal(blocked.metricReason, 'mapping_key_unverified');
});

test('account monitor HTTP API supports manual sync, filtering and probes', async (t) => {
  const context = createTestContext();
  const sub2api = createSub2ApiMock();
  const providers = new ProviderRepository(context.db, context.config);
  const auditProvider = providers.create({
    name: 'HTTP Audit Supplier',
    adapterType: 'new-api',
    baseUrl: 'https://http-audit-provider.example',
    authMode: 'system_token',
    remoteUserId: 'http-audit-user',
    credentials: { systemToken: 'http-audit-token' }
  });
  const app = createApplication({
    config: context.config,
    db: context.db,
    sub2api,
    startBackground: false
  });
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
  const session = await login.json();
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const headers = {
    Cookie: cookie,
    'Content-Type': 'application/json',
    'X-CSRF-Token': session.csrfToken
  };

  const sync = await fetch(`${base}/api/account-monitor/sync?wait=true`, {
    method: 'POST', headers, body: '{}'
  });
  assert.equal(sync.status, 200);
  const accounts = await fetch(`${base}/api/account-monitor/accounts?platform=openai&days=7`, {
    headers: { Cookie: cookie }
  });
  assert.equal(accounts.status, 200);
  assert.deepEqual((await accounts.json()).items.map((item) => item.accountId), ['11']);

  const groupedAccounts = await fetch(
    `${base}/api/account-monitor/accounts?display=groups&groupId=102&days=7`,
    { headers: { Cookie: cookie } }
  );
  assert.equal(groupedAccounts.status, 200);
  const groupedBody = await groupedAccounts.json();
  assert.equal(groupedBody.itemType, 'group');
  assert.equal(groupedBody.items.length, 1);
  assert.equal(groupedBody.items[0].groupName, '共享组');
  assert.equal(groupedBody.items[0].accountCount, 2);
  assert.deepEqual(
    groupedBody.items[0].accounts.map((account) => account.accountId).sort(),
    ['11', '12']
  );

  const saveRecharge = await fetch(
    `${base}/api/account-monitor/providers/${auditProvider.id}/recharge-audit`,
    {
      method: 'PUT',
      headers,
      body: JSON.stringify({ rechargedAmount: 88.5, currency: 'USD', note: 'HTTP audit' })
    }
  );
  assert.equal(saveRecharge.status, 200);
  assert.equal((await saveRecharge.json()).rechargedAmount, 88.5);
  const providerView = await fetch(
    `${base}/api/account-monitor/accounts?display=providers&days=7`,
    { headers: { Cookie: cookie } }
  );
  assert.equal(providerView.status, 200);
  const providerBody = await providerView.json();
  assert.equal(providerBody.itemType, 'provider');
  assert.equal(providerBody.items[0].providerName, 'HTTP Audit Supplier');
  assert.equal(providerBody.items[0].rechargeAudit.rechargedAmount, 88.5);
  assert.equal(providerBody.items[0].baseMetrics.available, false);
  assert.equal(providerBody.items[0].baseMetrics.unavailableReason, 'base_provider_unmapped');
  assert.equal(providerBody.items[0].audit.windowUpstreamCost, null);
  assert.equal(providerBody.items[0].audit.lifetimeUpstreamCost, null);

  const probe = await fetch(`${base}/api/account-monitor/probes?wait=true`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ accountIds: ['11'], model: 'gpt-test' })
  });
  assert.equal(probe.status, 200);
  const probeBody = await probe.json();
  assert.equal(probeBody.results[0].intelligenceScore, 100);
  assert.equal(sub2api.calls.find((call) => call.type === 'sse').body.model_id, 'gpt-test');

  const invalidProbe = await fetch(`${base}/api/account-monitor/probes?wait=true`, {
    method: 'POST', headers, body: '{}'
  });
  assert.equal(invalidProbe.status, 400);
});

test('capability scorer separates answers from exact instruction following', () => {
  assert.deepEqual(scoreChallenge(CHALLENGE_EXPECTED), {
    intelligenceScore: 100,
    instructionScore: 100,
    answers: { arithmetic: true, logic: true, sequence: true },
    exact: true
  });
  const verbose = scoreChallenge('The answers are 43, NO, and 42.');
  assert.equal(verbose.intelligenceScore, 100);
  assert.equal(verbose.instructionScore, 0);
});

test('dynamic capability suite is reproducible, varied and independently scored', () => {
  const challenge = createCapabilityChallenge('account-11:batch-a');
  const repeated = createCapabilityChallenge('account-11:batch-a');
  const different = createCapabilityChallenge('account-11:batch-b');
  assert.deepEqual(repeated, challenge);
  assert.notEqual(different.id, challenge.id);

  const perfect = scoreCapabilityChallenge(challenge, JSON.stringify(challenge.expected));
  assert.equal(perfect.intelligenceScore, 100);
  assert.equal(perfect.instructionScore, 100);
  assert.equal(perfect.exact, true);

  const fenced = scoreCapabilityChallenge(
    challenge,
    `\`\`\`json\n${JSON.stringify(challenge.expected)}\n\`\`\``
  );
  assert.equal(fenced.intelligenceScore, 100);
  assert.equal(fenced.instructionScore, 60);

  const wrong = scoreCapabilityChallenge(challenge, JSON.stringify({
    ...challenge.expected,
    arithmetic: challenge.expected.arithmetic + 1
  }));
  assert.equal(wrong.intelligenceScore, 80);

  const allWrongButExecuted = scoreCapabilityChallenge(challenge, JSON.stringify({
    arithmetic: challenge.expected.arithmetic + 1,
    logic: 'YES',
    sequence: challenge.expected.sequence + 1,
    sorted: [...challenge.expected.sorted].reverse(),
    checksum: 'WRONG'
  }));
  assert.equal(allWrongButExecuted.parsed, true);
  assert.equal(allWrongButExecuted.intelligenceScore, 0);
});

test('OpenAI default greeting is recorded as an unexecuted capability probe, not zero', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  insertMonitoredAccount(context.db, {
    id: 21,
    name: 'OpenAI OAuth greeting',
    platform: 'openai',
    type: 'oauth'
  });
  const sub2api = {
    async sse(_endpoint, options) {
      await options.onEvent({ type: 'test_start', model: 'gpt-test' });
      await options.onEvent({ type: 'content', text: 'Hi! How can I help?' });
      await options.onEvent({ type: 'test_complete', success: true });
    }
  };
  const monitor = new AccountMonitorService({ db: context.db, config: context.config, sub2api });
  const result = await monitor.probe({ accountIds: ['21'], model: 'gpt-test' });
  assert.equal(result.results[0].suite, 'capability_v2_unexecuted');
  assert.equal(result.results[0].intelligenceScore, null);
  assert.equal(result.results[0].instructionScore, null);
  assert.equal(result.results[0].details.challengeExecuted, false);
  assert.equal(result.results[0].details.unscoredReason, 'sub2api_prompt_not_forwarded');
});

test('manual OpenAI API-key probe uses an ephemeral direct capability request', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  insertMonitoredAccount(context.db, {
    id: 22,
    name: 'OpenAI API key',
    platform: 'openai',
    type: 'apikey'
  });
  let sseCalls = 0;
  const sub2api = {
    async data(endpoint, options) {
      assert.equal(endpoint, '/api/v1/admin/accounts/data');
      assert.equal(options.query.ids, '22');
      assert.equal(options.query.include_proxies, true);
      return {
        accounts: [{
          name: 'OpenAI API key',
          platform: 'openai',
          type: 'apikey',
          credentials: {
            api_key: 'sk-ephemeral-test-secret',
            base_url: 'https://upstream.example/v1'
          },
          extra: { openai_responses_supported: true }
        }],
        proxies: []
      };
    },
    async sse() {
      sseCalls += 1;
      throw new Error('direct probe must not use the Sub2API greeting endpoint');
    }
  };
  const requests = [];
  const httpClient = {
    async requestJson(url, options) {
      requests.push({ url, options });
      const prompt = options.body.input[0].content[0].text;
      return {
        data: {
          model: options.body.model,
          output_text: answerCapabilityPrompt(prompt)
        }
      };
    }
  };
  const monitor = new AccountMonitorService({
    db: context.db,
    config: context.config,
    sub2api,
    http: httpClient
  });
  const prepared = await monitor.prepareProbe({
    accountIds: ['22'],
    model: 'gpt-test',
    triggerType: 'manual'
  });
  assert.ok(prepared.credentialTicket);
  assert.doesNotMatch(JSON.stringify(prepared), /ephemeral-test-secret/);
  const result = await monitor.probe(prepared);
  assert.equal(sseCalls, 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://upstream.example/v1/responses');
  assert.equal(requests[0].options.maxRedirects, 0);
  assert.equal(result.results[0].intelligenceScore, 100);
  assert.equal(result.results[0].instructionScore, 100);
  assert.equal(result.results[0].details.transport, 'direct_api_key');
  assert.equal(result.results[0].details.directCapability, 'responses');
  assert.equal(monitor.probeCredentials.size, 0);
  assert.doesNotMatch(
    JSON.stringify(context.db.prepare('SELECT * FROM sub2api_account_probe_runs').all()),
    /ephemeral-test-secret/
  );
});

test('API-key export matches unordered accounts and resolves duplicate names by ID', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  for (const account of [
    { id: 31, name: 'Unique account', platform: 'openai', type: 'apikey' },
    { id: 32, name: 'Duplicate account', platform: 'openai', type: 'apikey' },
    { id: 33, name: 'Duplicate account', platform: 'openai', type: 'apikey' }
  ]) insertMonitoredAccount(context.db, account);
  const exportedById = new Map([
    ['31', { name: 'Unique account', key: 'sk-account-31' }],
    ['32', { name: 'Duplicate account', key: 'sk-account-32' }],
    ['33', { name: 'Duplicate account', key: 'sk-account-33' }]
  ]);
  const exportCalls = [];
  const sub2api = {
    async data(_endpoint, options) {
      const ids = options.query.ids.split(',');
      exportCalls.push(ids);
      return {
        accounts: [...ids].reverse().map((id) => {
          const account = exportedById.get(id);
          return {
            name: account.name,
            platform: 'openai',
            type: 'apikey',
            credentials: {
              api_key: account.key,
              base_url: `https://upstream-${id}.example/v1`
            }
          };
        }),
        proxies: []
      };
    }
  };
  const monitor = new AccountMonitorService({
    db: context.db,
    config: context.config,
    sub2api,
    http: {}
  });
  const prepared = await monitor.prepareProbe({
    accountIds: ['31', '32', '33'],
    model: 'gpt-test',
    triggerType: 'manual'
  });
  const credentials = monitor.probeCredentials.get(prepared.credentialTicket).accounts;
  assert.equal(credentials.get('31').apiKey, 'sk-account-31');
  assert.equal(credentials.get('32').apiKey, 'sk-account-32');
  assert.equal(credentials.get('33').apiKey, 'sk-account-33');
  assert.equal(exportCalls.length, 3);
  assert.deepEqual(exportCalls.slice(1).map((ids) => ids.length), [1, 1]);
  monitor.probeCredentials.delete(prepared.credentialTicket);
});

test('Sub2API admin client parses incremental SSE events with administrator auth', async (t) => {
  const upstream = http.createServer((req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/api/v1/admin/accounts/11/test');
    assert.equal(req.headers.authorization, 'Bearer account-monitor-admin-token');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"type":"test_start","model":"gpt-test"}\n\n');
    setTimeout(() => {
      res.write('data:{"type":"content","text":"IQCHECK|43|NO|42"}\n\n');
      res.end('data: {"type":"test_complete","success":true}\n\n');
    }, 10);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const context = createTestContext({
    SUB2API_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
    SUB2API_ADMIN_TOKEN: 'account-monitor-admin-token'
  });
  t.after(() => context.cleanup());
  const client = new Sub2ApiAdminClient(context.config);
  const events = [];
  const result = await client.sse('/api/v1/admin/accounts/11/test', {
    method: 'POST',
    body: { model_id: 'gpt-test' },
    onEvent: (event) => events.push(event)
  });
  assert.equal(result.eventCount, 3);
  assert.deepEqual(events.map((event) => event.type), ['test_start', 'content', 'test_complete']);
  assert.equal(events[1].text, CHALLENGE_EXPECTED);
});
