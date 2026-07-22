const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createTestContext } = require('./helpers');
const { ProviderRepository } = require('../src/repositories/provider-repository');
const { AnalysisService } = require('../src/services/analysis-service');
const { MappingService } = require('../src/services/mapping-service');
const { CredentialService } = require('../src/services/credential-service');
const { TransferService } = require('../src/services/transfer-service');
const { KeyHealthService } = require('../src/services/key-health-service');
const { SyncService } = require('../src/services/sync-service');
const { QueryService } = require('../src/services/query-service');
const { nowIso } = require('../src/db');

function createProvider(context, overrides = {}) {
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'Provider', adapterType: 'deepseek', baseUrl: 'https://api.deepseek.com',
    authMode: 'api_key', credentials: { apiKey: 'old-secret-key' },
    accountDedupeKey: crypto.randomUUID(), ...overrides
  });
  return { providers, provider };
}

test('analysis records inventory drift and detects balance anomalies', () => {
  const context = createTestContext();
  try {
    const { provider } = createProvider(context);
    const analysis = new AnalysisService({ db: context.db, config: context.config });
    const before = analysis.captureInventory(provider.id);
    analysis.recordInventoryChanges(provider.id, before, {
      probe: { version: '2' },
      keys: [{ remoteId: 'key-1', name: 'Key', status: 'enabled', quota: { limit: 10 }, metadata: {} }],
      keysComplete: true,
      groups: [{ remoteId: 'group-1', type: 'key_route_group', name: 'Default', ratio: 1 }],
      groupsComplete: true
    });
    const older = new Date(Date.now() - 3600000).toISOString();
    context.db.prepare(`
      INSERT INTO balance_snapshots(connection_id, subject_type, subject_id, currency, available, used, captured_at)
      VALUES (?, 'account', 'account', 'USD', 100, 10, ?), (?, 'account', 'account', 'USD', 40, 10, ?)
    `).run(provider.id, older, provider.id, nowIso());
    const anomalies = analysis.analyzeConnection(provider.id);
    assert.ok(anomalies.some((item) => item.type === 'balance_drop'));
    assert.ok(anomalies.some((item) => item.type === 'balance_drop_without_usage'));
    assert.equal(analysis.listChanges({ connectionId: provider.id }).length, 2);
  } finally {
    context.cleanup();
  }
});

test('mapping reconciliation aggregates Sub2API group usage across channels and combines monitor health', async () => {
  const context = createTestContext();
  try {
    const { provider } = createProvider(context);
    const start = new Date(Date.now() - 86400000);
    const end = new Date();
    context.db.prepare(`UPDATE provider_connections SET last_success_at = ? WHERE id = ?`).run(end.toISOString(), provider.id);
    context.db.prepare(`
      INSERT INTO balance_snapshots(connection_id, subject_type, subject_id, currency, available, captured_at)
      VALUES (?, 'account', 'account', 'USD', 100, ?), (?, 'account', 'account', 'USD', 90, ?)
    `).run(provider.id, new Date(start.getTime() - 1000).toISOString(), provider.id, new Date(end.getTime() - 1000).toISOString());
    const sub2api = {
      async listAll(endpoint) {
        if (endpoint.includes('channel-monitors')) return { items: [{ id: 8, primary_status: 'healthy', availability_7d: 99 }], total: 1 };
        return {
          items: [
            { channel_id: 11, account_id: 70, group_id: 7, actual_cost: 6, total_cost: 4, account_rate_multiplier: 1, input_tokens: 10, output_tokens: 5, created_at: end.toISOString() },
            { channel_id: 12, account_id: 70, group_id: 7, actual_cost: 2, total_cost: 1, account_rate_multiplier: 1, input_tokens: 4, output_tokens: 2, created_at: end.toISOString() },
            { channel_id: 11, account_id: 70, group_id: 8, actual_cost: 100, total_cost: 100, created_at: end.toISOString() }
          ], total: 3, truncated: false
        };
      }
    };
    const mappings = new MappingService({ db: context.db, config: context.config, sub2api });
    const mapping = mappings.save({ connectionId: provider.id, accountId: 70, groupId: 7, config: { channelMonitorId: 8 } });
    const result = await mappings.reconcile(mapping.id, { periodStart: start.toISOString(), periodEnd: end.toISOString() });
    assert.equal(result.status, 'succeeded');
    assert.equal(result.upstream_balance_delta, 10);
    assert.equal(result.sub2api_cost, 8);
    assert.equal(result.expected_cost, 5);
    assert.equal(result.difference_amount, 5);
    assert.equal(result.details.sub2api.records, 2);
    assert.equal(result.health_score, 100);
    assert.throws(() => mappings.save({ connectionId: provider.id, accountId: 70, groupId: 7 }), /already exists/);
  } finally {
    context.cleanup();
  }
});

test('manual backup activation swaps roles and can switch back to the original provider', () => {
  const context = createTestContext();
  try {
    const first = createProvider(context, { name: 'Primary', accountDedupeKey: 'primary' }).provider;
    const second = createProvider(context, { name: 'Backup', baseUrl: 'https://backup.example', accountDedupeKey: 'backup' }).provider;
    const mappings = new MappingService({ db: context.db, config: context.config, sub2api: {} });
    const primary = mappings.save({ connectionId: first.id, groupId: 21, role: 'primary', enabled: true });
    const backup = mappings.save({ connectionId: second.id, groupId: 21, role: 'backup', enabled: false });
    mappings.activateBackup(backup.id);
    assert.equal(mappings.get(backup.id).role, 'primary');
    assert.equal(mappings.get(backup.id).enabled, true);
    assert.equal(mappings.get(primary.id).role, 'backup');
    assert.equal(mappings.get(primary.id).enabled, false);
    mappings.activateBackup(primary.id);
    assert.equal(mappings.get(primary.id).role, 'primary');
    assert.equal(mappings.get(primary.id).enabled, true);
    assert.equal(mappings.get(backup.id).role, 'backup');
  } finally {
    context.cleanup();
  }
});

test('credential rotation validates first and supports an encrypted rollback', async () => {
  const context = createTestContext();
  try {
    const { providers, provider } = createProvider(context);
    const authorizations = [];
    const service = new CredentialService({
      db: context.db, config: context.config, providers,
      http: {
        async requestJson(_input, options) {
          authorizations.push(options.headers.Authorization);
          return { data: { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '12', granted_balance: '2', topped_up_balance: '10' }] } };
        }
      }
    });
    const result = await service.rotate(provider.id, { apiKey: 'new-secret-key' }, { retentionDays: 3 });
    assert.equal(authorizations.every((value) => value === 'Bearer new-secret-key'), true);
    assert.equal(providers.getCredentials(provider.id).apiKey, 'new-secret-key');
    assert.equal(result.validation.balanceCount, 1);
    service.rollback(provider.id, result.backupId);
    assert.equal(providers.getCredentials(provider.id).apiKey, 'old-secret-key');
    const backups = service.listBackups(provider.id);
    assert.equal(backups.some((item) => item.restored_at), true);
  } finally {
    context.cleanup();
  }
});

test('transfer preview/import, secret-free export and SQLite backup work together', async () => {
  const context = createTestContext();
  try {
    const providers = new ProviderRepository(context.db, context.config);
    const transfers = new TransferService({ db: context.db, config: context.config, providers });
    const csv = 'name,adapter_type,base_url,api_key\nImported,deepseek,https://api.deepseek.com,sk-imported-secret\n';
    const preview = transfers.previewImport({ format: 'csv', content: csv });
    assert.equal(preview.create, 1);
    const imported = transfers.applyImport({ format: 'csv', content: csv });
    assert.equal(imported.created, 1);
    const exported = transfers.exportConfiguration();
    assert.equal(JSON.stringify(exported).includes('sk-imported-secret'), false);
    const bundle = transfers.exportDisasterBundle('twelve-char-password');
    assert.equal(JSON.stringify(bundle).includes('sk-imported-secret'), false);
    assert.equal(transfers.decodeDisasterBundle(bundle, 'twelve-char-password').providers[0].credentials.apiKey, 'sk-imported-secret');
    providers.create({
      name: 'New API Profile', adapterType: 'new-api', baseUrl: 'https://new-api.example',
      authMode: 'system_token', remoteUserId: '5', accountDedupeKey: 'new-api-profile',
      credentials: { systemToken: 'system-profile-secret', userId: '5' }
    });
    providers.create({
      name: 'LiteLLM Profile', adapterType: 'litellm', baseUrl: 'https://litellm.example',
      authMode: 'master_key', accountDedupeKey: 'litellm-profile',
      credentials: { masterKey: 'master-profile-secret' }
    });
    const profiles = transfers.credentialProfiles({ includeSecrets: true });
    assert.equal(profiles.find((item) => item.provider === 'new-api').apiKey, 'system-profile-secret');
    assert.equal(profiles.find((item) => item.provider === 'litellm').apiKey, 'master-profile-secret');
    const backup = await transfers.backupDatabase('test');
    assert.equal(fs.existsSync(path.join(context.config.dataDir, 'backups', backup.filename)), true);
  } finally {
    context.cleanup();
  }
});

test('secret-free configuration restores provider shells disabled until credentials are supplied', () => {
  const source = createTestContext();
  const target = createTestContext();
  try {
    const sourceProviders = new ProviderRepository(source.db, source.config);
    const sourceTransfers = new TransferService({ db: source.db, config: source.config, providers: sourceProviders });
    const definitions = [
      {
        name: '247kan', adapterType: 'sub2api', baseUrl: 'https://api.247kan.com',
        authMode: 'bearer', remoteUserId: '565', credentials: { accessToken: 'access-247' }
      },
      {
        name: 'a6api', adapterType: 'new-api', baseUrl: 'https://a6api.com',
        authMode: 'account', remoteUserId: '2160', credentials: { systemToken: 'system-a6', userId: '2160' }
      },
      {
        name: 'ai2api', adapterType: 'sub2api', baseUrl: 'https://ai2api.cc',
        authMode: 'account', remoteUserId: '115', credentials: { email: 'user@example.com', password: 'password' }
      },
      {
        name: 'aijws', adapterType: 'custom', baseUrl: 'https://api.aijws.com',
        authMode: 'api_key', credentials: { apiKey: 'custom-key' }
      },
      {
        name: 'hubway', adapterType: 'sub2api', baseUrl: 'https://api.hubway.cc',
        authMode: 'account', remoteUserId: '953', credentials: { email: 'hub@example.com', password: 'password' }
      }
    ];
    for (const definition of definitions) sourceProviders.create(definition);

    const content = sourceTransfers.exportConfiguration();
    const targetProviders = new ProviderRepository(target.db, target.config);
    const targetTransfers = new TransferService({ db: target.db, config: target.config, providers: targetProviders });
    const preview = targetTransfers.previewImport({ format: 'provider-monitor', content });

    assert.equal(preview.total, 5);
    assert.equal(preview.create, 5);
    assert.equal(preview.missingCredentials, 5);
    assert.equal(preview.disableForMissingCredentials, 5);
    assert.equal(preview.skipForMissingCredentials, 0);

    const imported = targetTransfers.applyImport({ format: 'provider-monitor', content });
    assert.equal(imported.created, 5);
    assert.equal(imported.skipped, 0);
    assert.equal(imported.disabledForMissingCredentials, 5);
    assert.deepEqual(targetProviders.list().map((provider) => provider.name).sort(), definitions.map((item) => item.name).sort());
    assert.equal(targetProviders.list().every((provider) => provider.enabled === false), true);

    const a6api = targetProviders.list().find((provider) => provider.name === 'a6api');
    assert.deepEqual(targetProviders.getCredentials(a6api.id), { userId: '2160' });
    targetProviders.updateCredentials(a6api.id, { systemToken: 'local-system-token', userId: '2160' });
    const secondPreview = targetTransfers.previewImport({ format: 'provider-monitor', content });
    assert.equal(secondPreview.missingCredentials, 4);
    assert.equal(secondPreview.disableForMissingCredentials, 4);
    targetTransfers.applyImport({ format: 'provider-monitor', content });
    assert.equal(targetProviders.get(a6api.id).enabled, true);
    assert.equal(targetProviders.getCredentials(a6api.id).systemToken, 'local-system-token');

    const emptyCsv = 'name,adapter_type,base_url\nBlank,deepseek,https://blank.example\n';
    const emptyPreview = targetTransfers.previewImport({ format: 'csv', content: emptyCsv });
    assert.equal(emptyPreview.skipForMissingCredentials, 1);
    const emptyImport = targetTransfers.applyImport({ format: 'csv', content: emptyCsv });
    assert.equal(emptyImport.skipped, 1);
    assert.equal(targetProviders.list().length, 5);
  } finally {
    source.cleanup();
    target.cleanup();
  }
});

test('metadata key health checks require no paid request', async () => {
  const context = createTestContext();
  try {
    const { providers, provider } = createProvider(context);
    context.db.prepare(`
      INSERT INTO remote_keys(
        id, connection_id, remote_id, name, masked_key, status, unlimited,
        quota_remaining, currency, metadata_json, first_seen_at, last_seen_at
      ) VALUES ('key-id', ?, 'remote-key', 'Client', 'sk-...test', 'enabled', 0, 5, 'USD', '{}', ?, ?)
    `).run(provider.id, nowIso(), nowIso());
    let networkCalls = 0;
    const health = new KeyHealthService({
      db: context.db, config: context.config, providers,
      http: { async requestJson() { networkCalls += 1; throw new Error('not expected'); } }
    });
    const result = await health.check('key-id', 'metadata');
    assert.equal(result.status, 'passed');
    assert.equal(networkCalls, 0);
  } finally {
    context.cleanup();
  }
});

test('paid probe budget includes requests whose later capability check failed', async () => {
  const context = createTestContext();
  try {
    const { providers, provider } = createProvider(context, {
      credentials: { apiKey: 'runtime-secret' },
      typeConfig: {
        paidProbe: { enabled: true, estimatedCost: 1, dailyBudget: 1, model: 'test-model' },
        capabilityProbes: [{ name: 'tools', path: '/capability', body: { model: 'test-model' } }]
      }
    });
    context.db.prepare(`
      INSERT INTO remote_keys(
        id, connection_id, remote_id, name, masked_key, status, unlimited,
        quota_remaining, currency, metadata_json, first_seen_at, last_seen_at
      ) VALUES ('paid-key', ?, 'paid-remote', 'Paid Client', 'sk-...test', 'enabled', 0, 5, 'USD', '{}', ?, ?)
    `).run(provider.id, nowIso(), nowIso());
    let paidCalls = 0;
    const health = new KeyHealthService({
      db: context.db, config: context.config, providers,
      http: {
        async requestJson(input) {
          const url = new URL(input);
          if (url.pathname === '/v1/models') return { data: { data: [{ id: 'test-model' }] } };
          if (url.pathname === '/v1/chat/completions') { paidCalls += 1; return { data: { id: 'response' } }; }
          if (url.pathname === '/capability') throw new Error('capability unavailable');
          throw new Error(`Unexpected ${url.pathname}`);
        }
      }
    });
    const first = await health.check('paid-key', 'capabilities');
    assert.equal(first.status, 'failed');
    assert.equal(first.details.paid.estimatedCost, 1);
    const second = await health.check('paid-key', 'paid');
    assert.equal(second.errorCode, 'PAID_PROBE_BUDGET_EXCEEDED');
    assert.equal(paidCalls, 1);
  } finally {
    context.cleanup();
  }
});

test('OneHub sync derives primary and backup groups from key references', async () => {
  const context = createTestContext();
  try {
    const { providers, provider } = createProvider(context, {
      name: 'OneHub', adapterType: 'one-hub', baseUrl: 'https://onehub.example',
      authMode: 'system_token', remoteUserId: '7', accountDedupeKey: 'onehub-user',
      credentials: { systemToken: 'token' }
    });
    const sync = new SyncService({
      db: context.db, config: context.config, providers,
      http: {
        async requestJson(input) {
          const url = new URL(input);
          if (url.pathname === '/api/status') return { data: { success: true, data: { quota_per_unit: 500000 } } };
          if (url.pathname === '/api/user/self') return { data: { success: true, data: { id: 7, username: 'user', quota: 5000000, used_quota: 1000000, status: 1 } } };
          if (url.pathname === '/api/token/') return { data: { success: true, data: { data: [{ id: 1, name: 'key', remain_quota: 1000000, used_quota: 0, group: 'primary', backup_group: 'backup', status: 1 }], total_count: 1 } } };
          if (url.pathname === '/api/log/self/stat') return { data: { success: true, data: { quota: 1000000 } } };
          throw new Error(`Unexpected ${url.pathname}`);
        }
      }
    });
    const result = await sync.run(provider.id);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.groupCount, 2);
    const assets = new QueryService(context.db, context.config).providerAssets(provider.id);
    assert.deepEqual(assets.groups.map((group) => group.remote_id).sort(), ['backup', 'primary']);
    assert.equal(assets.keys[0].primary_group_ref, 'primary');
    assert.equal(assets.keys[0].backup_group_ref, 'backup');
    assert.deepEqual(assets.keys[0].additionalGroups.sort(), ['backup', 'primary']);
  } finally {
    context.cleanup();
  }
});

test('LiteLLM sync persists global balance, Team Budget and key budget separately', async () => {
  const context = createTestContext();
  try {
    const { providers, provider } = createProvider(context, {
      name: 'LiteLLM', adapterType: 'litellm', baseUrl: 'https://litellm.example',
      credentials: { masterKey: 'master' }, accountDedupeKey: 'litellm'
    });
    const sync = new SyncService({
      db: context.db, config: context.config, providers,
      http: {
        async requestJson(input) {
          const url = new URL(input);
          if (url.pathname === '/global/spend') return { data: { spend: 20, max_budget: 100 } };
          if (url.pathname === '/team/list') return { data: [{ team_id: 'team-a', team_alias: 'Team A', max_budget: 40, spend: 10 }] };
          if (url.pathname === '/key/list') return { data: { keys: [{ token: 'hash', key_alias: 'client', team_id: 'team-a', max_budget: 20, spend: 5 }], total_count: 1 } };
          throw new Error(`Unexpected ${url.pathname}`);
        }
      }
    });
    const result = await sync.run(provider.id);
    assert.equal(result.status, 'succeeded');
    const summary = new QueryService(context.db, context.config).summary();
    assert.equal(summary.accounts[0].available, 80);
    assert.equal(summary.budgets.find((item) => item.subjectType === 'team').available, 30);
    assert.equal(summary.budgets.find((item) => item.subjectType === 'key').available, 15);
  } finally {
    context.cleanup();
  }
});
