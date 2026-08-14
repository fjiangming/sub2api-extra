const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createTestContext } = require('./helpers');
const { nowIso, stringifyJson } = require('../src/db');
const { AppError } = require('../src/errors');
const { ProviderRepository } = require('../src/repositories/provider-repository');
const {
  MappingService,
  matchProviderAccounts,
  highestMapping,
  groupComparisons
} = require('../src/services/mapping-service');
const { maskKey } = require('../src/security/redaction');

function insertGroup(db, providerId, { remoteId, name, ratio }) {
  const now = nowIso();
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO remote_groups(
      id, connection_id, remote_id, group_type, name, ratio, status,
      metadata_json, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, 'key_route_group', ?, ?, 'active', '{}', ?, ?)
  `).run(id, providerId, remoteId, name, ratio, now, now);
  return id;
}

function insertKey(db, providerId, { remoteId, name, apiKey, primaryGroupRef, remoteAccountId = null }) {
  const now = nowIso();
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO remote_keys(
      id, connection_id, remote_account_id, remote_id, name, masked_key, status,
      primary_group_ref, unlimited, metadata_json, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, 0, '{}', ?, ?)
  `).run(id, providerId, remoteAccountId, remoteId, name, maskKey(apiKey), primaryGroupRef, now, now);
  return id;
}

function sub2apiFixture({
  channels,
  groups,
  accounts,
  apiKeys,
  accountCredentials = {},
  exportError = null,
  exportPayload = null,
  onExport = null
}) {
  return {
    authenticationStatus: () => ({ available: true, source: 'test' }),
    async listAll(endpoint) {
      if (endpoint === '/api/v1/admin/channels') return { items: channels };
      if (endpoint === '/api/v1/admin/accounts') return { items: accounts };
      throw new Error(`Unexpected list endpoint: ${endpoint}`);
    },
    async data(endpoint, options = {}) {
      if (endpoint === '/api/v1/admin/groups/all') return groups;
      if (endpoint === '/api/v1/groups/rates') {
        return Object.fromEntries(groups.map((group) => [group.id, group.rate_multiplier]));
      }
      const accountDetail = endpoint.match(/^\/api\/v1\/admin\/accounts\/(\d+)$/);
      if (accountDetail) {
        return accounts.find((account) => Number(account.id) === Number(accountDetail[1])) || null;
      }
      if (endpoint === '/api/v1/admin/accounts/data') {
        onExport?.(options.query, options);
        if (exportError) throw exportError;
        const ids = String(options.query?.ids || '').split(',').filter(Boolean).map(Number);
        if (exportPayload) {
          return typeof exportPayload === 'function'
            ? exportPayload(ids, options)
            : exportPayload;
        }
        return {
          accounts: ids.map((id) => {
            const account = accounts.find((item) => Number(item.id) === id);
            return {
              name: account.name,
              credentials: { ...accountCredentials[id], api_key: apiKeys[id] || '' }
            };
          })
        };
      }
      throw new Error(`Unexpected data endpoint: ${endpoint}`);
    }
  };
}

test('provider account matching prefers exact names and returns every contains match', () => {
  const accounts = [
    { id: 1, name: 'Supplier A' },
    { id: 2, name: 'Supplier A - Codex' },
    { id: 3, name: 'Other Supplier A Route' }
  ];
  const exact = matchProviderAccounts('  supplier a ', accounts);
  assert.equal(exact.status, 'matched');
  assert.equal(exact.matchType, 'exact');
  assert.equal(exact.accounts[0].id, 1);

  const multipleExact = matchProviderAccounts('supplier a', [
    ...accounts,
    { id: 4, name: ' SUPPLIER A ' }
  ]);
  assert.equal(multipleExact.status, 'matched');
  assert.equal(multipleExact.matchType, 'exact');
  assert.deepEqual(multipleExact.accounts.map((account) => account.id), [1, 4]);

  const contains = matchProviderAccounts('Codex', accounts);
  assert.equal(contains.status, 'matched');
  assert.equal(contains.matchType, 'contains');
  assert.equal(contains.accounts[0].id, 2);

  const multiple = matchProviderAccounts('Supplier A Route'.replace(' Route', ''), accounts.slice(1));
  assert.equal(multiple.status, 'matched');
  assert.equal(multiple.matchType, 'contains');
  assert.deepEqual(multiple.accounts.map((account) => account.id), [2, 3]);
  assert.equal(matchProviderAccounts('Missing', accounts).status, 'unmatched');
});

test('auto-mapping processes every account from a multiple contains match', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'ai2api', adapterType: 'sub2api', baseUrl: 'https://ai2api.example',
    authMode: 'account', credentials: { email: 'user@example.com', password: 'secret' }, enabled: true
  });
  insertGroup(context.db, provider.id, { remoteId: 'plus', name: 'Plus', ratio: 0.045 });
  insertGroup(context.db, provider.id, { remoteId: 'stable', name: 'Stable', ratio: 0.09 });
  const plusKey = 'sk-ai2api-plus-1234567890';
  const stableKey = 'sk-ai2api-stable-12345678';
  insertKey(context.db, provider.id, {
    remoteId: 'plus-key', name: 'Plus key', apiKey: plusKey, primaryGroupRef: 'plus'
  });
  insertKey(context.db, provider.id, {
    remoteId: 'stable-key', name: 'Stable key', apiKey: stableKey, primaryGroupRef: 'stable'
  });
  const exports = [];
  const mappings = new MappingService({
    db: context.db,
    config: context.config,
    sub2api: sub2apiFixture({
      channels: [],
      groups: [{ id: 3, name: 'GPT accounts', status: 'active', rate_multiplier: 1 }],
      accounts: [
        { id: 108, name: 'AI2API-plus0.045', type: 'apikey', group_ids: [3], credentials_status: { has_api_key: true } },
        { id: 113, name: 'ai2api稳定渠道-0.09', type: 'apikey', group_ids: [3], credentials_status: { has_api_key: true } }
      ],
      apiKeys: { 108: plusKey, 113: stableKey },
      onExport: (query) => exports.push(query)
    })
  });

  const preview = await mappings.autoMappings({ mode: 'preview' });

  assert.equal(preview.summary.pendingCreate, 2);
  assert.equal(preview.summary.conflict, 0);
  assert.deepEqual(preview.items.map((item) => item.accountId), [108, 113]);
  assert.equal(preview.items.some((item) => 'channelId' in item || 'channelName' in item), false);
  assert.deepEqual(preview.items.map((item) => item.accountMatch), ['contains', 'contains']);
  assert.deepEqual(new Set(String(exports[0].ids).split(',').map(Number)), new Set([108, 113]));

  const applied = await mappings.autoMappings({ mode: 'apply' });
  assert.equal(applied.summary.created, 2);
  assert.deepEqual(
    context.db.prepare('SELECT account_id FROM sub2api_mappings ORDER BY account_id').all().map((row) => row.account_id),
    [108, 113]
  );
});

test('auto-mapping excludes inactive Sub2API accounts before exporting keys or creating mappings', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'Status Supplier', adapterType: 'new-api', baseUrl: 'https://status-supplier.example',
    authMode: 'system_token', credentials: { systemToken: 'secret', userId: '1' }, enabled: true
  });
  insertGroup(context.db, provider.id, { remoteId: 'default', name: 'Default', ratio: 1 });
  const activeKey = 'sk-status-active-1234567890';
  insertKey(context.db, provider.id, {
    remoteId: 'active-key', name: 'Active key', apiKey: activeKey, primaryGroupRef: 'default'
  });
  const exports = [];
  const mappings = new MappingService({
    db: context.db,
    config: context.config,
    sub2api: sub2apiFixture({
      channels: [],
      groups: [{ id: 31, name: 'Active group', status: 'active', rate_multiplier: 1 }],
      accounts: [
        {
          id: 301, name: 'Status Supplier', status: 'inactive', type: 'api_key',
          group_ids: [31], credentials_status: { has_api_key: true }
        },
        {
          id: 302, name: 'Status Supplier', status: 'active', type: 'api_key',
          group_ids: [31], credentials_status: { has_api_key: true }
        }
      ],
      apiKeys: { 301: 'sk-status-inactive-0987654321', 302: activeKey },
      onExport: (query) => exports.push(query)
    })
  });

  const preview = await mappings.autoMappings({ mode: 'preview' });
  assert.equal(preview.summary.pendingCreate, 1);
  assert.deepEqual(preview.items.map((item) => item.accountId), [302]);
  assert.deepEqual(exports.map((query) => query.ids), ['302']);

  const applied = await mappings.autoMappings({ mode: 'apply' });
  assert.equal(applied.summary.created, 1);
  assert.deepEqual(exports.map((query) => query.ids), ['302', '302']);
  assert.deepEqual(
    context.db.prepare('SELECT account_id FROM sub2api_mappings').all().map((row) => row.account_id),
    [302]
  );
});

test('manual mappings reject inactive accounts when binding or re-enabling them', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'Manual Status', adapterType: 'custom', baseUrl: 'https://manual-status.example',
    authMode: 'api_key', credentials: { apiKey: 'secret' }, enabled: true
  });
  const accounts = [
    { id: 401, name: 'Inactive', status: 'inactive' },
    { id: 402, name: 'Active', status: 'active' }
  ];
  const mappings = new MappingService({
    db: context.db,
    config: context.config,
    sub2api: sub2apiFixture({ channels: [], groups: [], accounts, apiKeys: {} })
  });

  await assert.rejects(
    () => mappings.saveValidated({ connectionId: provider.id, accountId: 401, groupId: 31 }),
    (error) => error.code === 'SUB2API_ACCOUNT_DISABLED' && error.details?.accountStatus === 'inactive'
  );
  assert.equal(context.db.prepare('SELECT COUNT(*) count FROM sub2api_mappings').get().count, 0);

  const mapping = await mappings.saveValidated({
    connectionId: provider.id, accountId: 402, groupId: 31
  });
  accounts[1].status = 'inactive';
  const disabled = await mappings.saveValidated({ enabled: false }, mapping.id);
  assert.equal(disabled.enabled, false);
  await assert.rejects(
    () => mappings.saveValidated({ enabled: true }, mapping.id),
    (error) => error.code === 'SUB2API_ACCOUNT_DISABLED' && error.details?.accountId === 402
  );
  assert.equal(mappings.get(mapping.id).enabled, false);
});

test('auto-mapping normalizes an sk prefix and resolves an inherited sole provider group', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'a6api', adapterType: 'new-api', baseUrl: 'https://a6api.example',
    authMode: 'system_token', credentials: { systemToken: 'secret', userId: '1' }, enabled: true
  });
  insertGroup(context.db, provider.id, { remoteId: 'default', name: 'Default', ratio: 1 });
  const remoteAccountId = crypto.randomUUID();
  const now = nowIso();
  context.db.prepare(`
    INSERT INTO remote_accounts(
      id, connection_id, remote_id, display_name, user_group, status,
      metadata_json, first_seen_at, last_seen_at
    ) VALUES (?, ?, '2160', 'A6 User', 'default', 'active', '{}', ?, ?)
  `).run(remoteAccountId, provider.id, now, now);
  const rawKey = 'UL0W-provider-token-frsI';
  const keyId = insertKey(context.db, provider.id, {
    remoteId: 'a6-key', name: 'A6 Key', apiKey: rawKey, remoteAccountId
  });
  const mappings = new MappingService({
    db: context.db,
    config: context.config,
    sub2api: sub2apiFixture({
      channels: [],
      groups: [{ id: 21, name: 'GPT Plus', status: 'active', rate_multiplier: 1 }],
      accounts: [{
        id: 107,
        name: 'https://a6api.example/',
        type: 'api_key',
        group_ids: [21],
        credentials_status: { has_api_key: true }
      }],
      apiKeys: { 107: `sk-${rawKey}` }
    })
  });

  const preview = await mappings.autoMappings({ mode: 'preview' });
  assert.equal(preview.summary.pendingCreate, 1);
  assert.equal(preview.summary.missingRemoteKey, 0);
  assert.equal(preview.items[0].keyId, keyId);
  assert.equal(preview.items[0].keyMatch, 'normalized_fingerprint');
  assert.equal(preview.items[0].keyVerification, 'api_key_prefix_normalized');
  assert.equal(preview.items[0].providerGroupRef, 'default');
  assert.equal(preview.items[0].providerGroupSource, 'account_inherited');
  assert.equal(preview.items[0].providerRateScope, 'group_multiplier');
  assert.equal(preview.items[0].channelCostVerified, false);
  assert.notEqual(preview.items[0].baseMaskedKey, preview.items[0].providerMaskedKey);

  const applied = await mappings.autoMappings({ mode: 'apply' });
  assert.equal(applied.summary.created, 1);
  assert.equal(applied.comparisons.items[0].comparison.details.providerGroupSource, 'account_inherited');
  assert.equal(context.db.prepare(
    'SELECT key_id FROM sub2api_mappings WHERE account_id = 107 AND group_id = 21'
  ).get().key_id, keyId);
});

test('auto-mapping requires the exact configured Sub2API API Key', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'aijws', adapterType: 'sub2api', baseUrl: 'https://api.aijws.example',
    authMode: 'api_key', credentials: { apiKey: 'sk-monitor-key-88888888' }, enabled: true
  });
  insertGroup(context.db, provider.id, { remoteId: 'token', name: 'Current API Key', ratio: 0.1 });
  const keyId = insertKey(context.db, provider.id, {
    remoteId: 'configured-api-key',
    name: 'aijws API Key',
    apiKey: 'sk-monitor-key-88888888',
    primaryGroupRef: 'token'
  });
  const differentKey = 'sk-base-account-22222222';
  const mismatchedFixture = sub2apiFixture({
    channels: [],
    groups: [{ id: 91, name: 'Codex', status: 'active', rate_multiplier: 0.1 }],
    accounts: [{
      id: 901,
      name: 'aijws',
      type: 'upstream',
      group_ids: [91],
      credentials_status: { has_api_key: true }
    }],
    apiKeys: { 901: differentKey },
    accountCredentials: { 901: { base_url: 'https://api.aijws.example/v1/' } }
  });
  const rejected = new MappingService({
    db: context.db,
    config: context.config,
    sub2api: mismatchedFixture
  });
  const rejectedPreview = await rejected.autoMappings({ mode: 'preview' });
  assert.equal(rejectedPreview.summary.missingRemoteKey, 1);
  assert.equal(rejectedPreview.items[0].keyVerification, 'configured_api_key_secret_mismatch');
  assert.equal(context.db.prepare('SELECT COUNT(*) count FROM sub2api_mappings').get().count, 0);

  const exactFixture = sub2apiFixture({
    channels: [],
    groups: [{ id: 91, name: 'Codex', status: 'active', rate_multiplier: 0.1 }],
    accounts: [{
      id: 901,
      name: 'aijws',
      type: 'upstream',
      group_ids: [91],
      credentials_status: { has_api_key: true }
    }],
    apiKeys: { 901: 'sk-monitor-key-88888888' },
    accountCredentials: { 901: { base_url: 'https://api.aijws.example/v1/' } }
  });
  const mappings = new MappingService({ db: context.db, config: context.config, sub2api: exactFixture });
  const preview = await mappings.autoMappings({ mode: 'preview' });
  const item = preview.items[0];
  assert.equal(preview.summary.pendingCreate, 1);
  assert.equal(item.keyId, keyId);
  assert.equal(item.keyMatch, 'exact_configured_secret');
  assert.equal(item.keyVerification, 'api_key_secret_exact');
  assert.equal(item.verifiedBillingScope, 'token');
  assert.equal(item.baseMaskedKey, item.providerMaskedKey);
  assert.doesNotMatch(JSON.stringify(preview), /sk-(?:base-account|monitor-key)-/);

  const applied = await mappings.autoMappings({ mode: 'apply' });
  assert.equal(applied.summary.created, 1);
  const config = JSON.parse(context.db.prepare(
    'SELECT config_json FROM sub2api_mappings WHERE account_id = 901'
  ).get().config_json);
  assert.equal(config.autoMapping.source, 'provider_account_name_exact_api_key');
  assert.equal(config.autoMapping.keyMatch, 'exact_configured_secret');
  assert.equal(config.autoMapping.billingScope, 'token');
});

test('auto-mapping never falls back to a provider-named channel', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'Channel Only', adapterType: 'new-api', baseUrl: 'https://channel-only.example',
    authMode: 'system_token', credentials: { systemToken: 'secret', userId: '1' }, enabled: true
  });
  insertGroup(context.db, provider.id, { remoteId: 'default', name: 'Default', ratio: 1 });
  insertKey(context.db, provider.id, {
    remoteId: 'key', name: 'Key', apiKey: 'sk-channel-only-12345678', primaryGroupRef: 'default'
  });
  let exportCalled = false;
  const mappings = new MappingService({
    db: context.db,
    config: context.config,
    sub2api: sub2apiFixture({
      channels: [{ id: 9, name: 'Channel Only', status: 'active', group_ids: [91] }],
      groups: [{ id: 91, name: 'Retail', status: 'active', rate_multiplier: 1 }],
      accounts: [{ id: 901, name: 'Different account', type: 'api_key', group_ids: [91], credentials_status: { has_api_key: true } }],
      apiKeys: { 901: 'sk-channel-only-12345678' },
      onExport: () => { exportCalled = true; }
    })
  });

  const preview = await mappings.autoMappings({ mode: 'preview' });
  assert.equal(preview.summary.unmatched, 1);
  assert.equal(preview.items[0].reason, 'account_not_found');
  assert.equal(exportCalled, false);
  assert.equal(context.db.prepare('SELECT COUNT(*) count FROM sub2api_mappings').get().count, 0);
});

test('auto-mapping previews, preserves manual rows, maps one account to multiple groups and selects the highest composite rate', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'Supplier A', adapterType: 'new-api', baseUrl: 'https://supplier-a.example',
    authMode: 'system_token', credentials: { systemToken: 'secret', userId: '1' },
    rechargeMultiplier: 1, enabled: true
  });
  insertGroup(context.db, provider.id, { remoteId: 'premium', name: 'Premium', ratio: 1.5 });
  insertGroup(context.db, provider.id, { remoteId: 'economy', name: 'Economy', ratio: 0.8 });
  const highKeyValue = 'sk-supplier-high-1234567890';
  const lowKeyValue = 'sk-supplier-low-0987654321';
  const highKeyId = insertKey(context.db, provider.id, {
    remoteId: 'high', name: 'High key', apiKey: highKeyValue, primaryGroupRef: 'premium'
  });
  const lowKeyId = insertKey(context.db, provider.id, {
    remoteId: 'low', name: 'Low key', apiKey: lowKeyValue, primaryGroupRef: 'economy'
  });
  const now = nowIso();
  context.db.prepare(`
    INSERT INTO sub2api_mappings(
      id, connection_id, key_id, channel_id, account_id, group_id, role,
      enabled, models_json, config_json, created_at, updated_at
    ) VALUES ('manual-low', ?, ?, 11, 502, 101, 'primary', 1, '[]', ?, ?, ?)
  `).run(provider.id, lowKeyId, stringifyJson({ manual: true }), now, now);

  const channels = [{ id: 11, name: 'Unrelated route', status: 'active', group_ids: [101, 102] }];
  const groups = [
    { id: 101, name: 'Retail', status: 'active', rate_multiplier: 1.1 },
    { id: 102, name: 'Team', status: 'active', rate_multiplier: 1.2 },
    { id: 103, name: 'Unmapped', status: 'active', rate_multiplier: 1.0 }
  ];
  const accounts = [
    { id: 501, name: ' supplier a ', type: 'upstream', group_ids: [101, 102], credentials_status: { has_api_key: true } },
    { id: 502, name: 'Low', type: 'apikey', group_ids: [101], credentials_status: { has_api_key: true } }
  ];
  const mappings = new MappingService({
    db: context.db,
    config: context.config,
    sub2api: sub2apiFixture({
      channels, groups, accounts,
      apiKeys: { 501: highKeyValue, 502: lowKeyValue }
    })
  });

  const preview = await mappings.autoMappings({ mode: 'preview' });
  assert.equal(preview.summary.pendingCreate, 2);
  assert.equal(preview.summary.existing, 0);
  assert.equal(context.db.prepare('SELECT COUNT(*) count FROM sub2api_mappings').get().count, 1);
  assert.doesNotMatch(JSON.stringify(preview), /sk-supplier-(high|low)/);

  const applied = await mappings.autoMappings({ mode: 'apply' });
  assert.equal(applied.summary.created, 2);
  assert.equal(applied.summary.existing, 0);
  const rows = context.db.prepare(`
    SELECT key_id, account_id, group_id, config_json
    FROM sub2api_mappings ORDER BY group_id, account_id
  `).all();
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.filter((row) => row.key_id === highKeyId).map((row) => row.group_id), [101, 102]);
  assert.deepEqual(JSON.parse(rows.find((row) => row.key_id === lowKeyId).config_json), { manual: true });
  const automatic = rows.find((row) => row.key_id === highKeyId);
  assert.equal(JSON.parse(automatic.config_json).autoMapping.source, 'provider_account_name_api_key');
  assert.equal(JSON.parse(automatic.config_json).autoMapping.accountMatch, 'exact');
  assert.equal(JSON.parse(automatic.config_json).upstreamGroupRef, undefined);

  const retail = applied.comparisons.groups.find((group) => group.groupId === 101);
  const team = applied.comparisons.groups.find((group) => group.groupId === 102);
  const unmapped = applied.comparisons.groups.find((group) => group.groupId === 103);
  assert.equal(retail.mappingCount, 2);
  assert.equal(retail.highest.key_id, highKeyId);
  assert.equal(retail.highest.comparison.providerRate, 1.5);
  assert.equal(retail.highest.comparison.compositeRate, 1.5);
  assert.equal(retail.items.filter((item) => item.isHighestRate).length, 1);
  assert.equal(team.highest.key_id, highKeyId);
  assert.equal(unmapped.mappingCount, 0);
  assert.equal(unmapped.highest, null);

  const repeated = await mappings.autoMappings({ mode: 'apply' });
  assert.equal(repeated.summary.created, 0);
  assert.equal(repeated.summary.existing, 2);
  assert.equal(context.db.prepare('SELECT COUNT(*) count FROM sub2api_mappings').get().count, 3);

  const replacementPreview = await mappings.rebuildAutoMappings({ preview: true });
  assert.equal(replacementPreview.summary.wouldDeleteMappings, 3);
  assert.equal(replacementPreview.summary.wouldCreateMappings, 2);
  assert.equal(context.db.prepare('SELECT COUNT(*) count FROM sub2api_mappings').get().count, 3);

  const replacement = await mappings.rebuildAutoMappings();
  assert.equal(replacement.summary.deletedMappings, 3);
  assert.equal(replacement.summary.createdMappings, 2);
  assert.equal(replacement.summary.skipped, 0);
  const replacedRows = context.db.prepare(`
    SELECT id, account_id, group_id, config_json FROM sub2api_mappings ORDER BY group_id
  `).all();
  assert.deepEqual(replacedRows.map((row) => row.account_id), [501, 501]);
  assert.deepEqual(replacedRows.map((row) => row.group_id), [101, 102]);
  assert.equal(replacedRows.some((row) => row.id === 'manual-low'), false);
  assert.equal(replacedRows.every((row) => JSON.parse(row.config_json).autoMapping), true);
});

test('auto-mapping reports key fingerprint collisions and performs no write when key export is forbidden', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'Collision', adapterType: 'new-api', baseUrl: 'https://collision.example',
    authMode: 'system_token', credentials: { systemToken: 'secret', userId: '1' }, enabled: true
  });
  insertGroup(context.db, provider.id, { remoteId: 'premium', name: 'Premium', ratio: 1.2 });
  const apiKey = 'sk-collision-shared-1234';
  insertKey(context.db, provider.id, { remoteId: 'one', name: 'One', apiKey, primaryGroupRef: 'premium' });
  insertKey(context.db, provider.id, { remoteId: 'two', name: 'Two', apiKey, primaryGroupRef: 'premium' });
  const channels = [{ id: 21, name: 'Collision', status: 'active', group_ids: [201] }];
  const groups = [{ id: 201, name: 'Retail', status: 'active', rate_multiplier: 1 }];
  const accounts = [{ id: 601, name: 'Collision account', type: 'upstream', group_ids: [201], credentials_status: { has_api_key: true } }];
  const collisionService = new MappingService({
    db: context.db, config: context.config,
    sub2api: sub2apiFixture({ channels, groups, accounts, apiKeys: { 601: apiKey } })
  });
  const preview = await collisionService.autoMappings({ mode: 'preview' });
  assert.equal(preview.summary.conflict, 1);
  assert.equal(preview.items[0].reason, 'remote_key_fingerprint_collision');
  assert.equal(context.db.prepare('SELECT COUNT(*) count FROM sub2api_mappings').get().count, 0);

  const forbiddenService = new MappingService({
    db: context.db, config: context.config,
    sub2api: sub2apiFixture({
      channels, groups, accounts, apiKeys: {},
      exportError: new AppError('SUB2API_REQUEST_FAILED', 'Step-up required', { status: 403 })
    })
  });
  await assert.rejects(
    () => forbiddenService.autoMappings({ mode: 'apply' }),
    (error) => error.code === 'SUB2API_KEY_EXPORT_FORBIDDEN'
  );
  assert.equal(context.db.prepare('SELECT COUNT(*) count FROM sub2api_mappings').get().count, 0);

  const stepUpService = new MappingService({
    db: context.db, config: context.config,
    sub2api: sub2apiFixture({
      channels, groups, accounts, apiKeys: {},
      exportError: new AppError('SUB2API_REQUEST_FAILED', 'Step-up required', {
        status: 403,
        details: { remoteCode: 'STEP_UP_REQUIRED', remoteStatus: 403 }
      })
    })
  });
  await assert.rejects(
    () => stepUpService.autoMappings({ mode: 'preview' }, { accessToken: 'current-sso-token' }),
    (error) => error.code === 'SUB2API_STEP_UP_REQUIRED' &&
      error.details?.remoteCode === 'STEP_UP_REQUIRED'
  );

  const adminApiKeyBlockedService = new MappingService({
    db: context.db, config: context.config,
    sub2api: sub2apiFixture({
      channels, groups, accounts, apiKeys: {},
      exportError: new AppError('SUB2API_REQUEST_FAILED', 'Admin API key is blocked', {
        status: 403,
        details: { remoteCode: 'STEP_UP_ADMIN_API_KEY_FORBIDDEN', remoteStatus: 403 }
      })
    })
  });
  await assert.rejects(
    () => adminApiKeyBlockedService.autoMappings({ mode: 'preview' }),
    (error) => error.code === 'SUB2API_ADMIN_API_KEY_EXPORT_FORBIDDEN' &&
      error.details?.remoteCode === 'STEP_UP_ADMIN_API_KEY_FORBIDDEN' &&
      error.details?.prerequisite ===
        'disable_sub2api_step_up_enabled_with_a_totp_verified_admin_session'
  );

  const unsupportedService = new MappingService({
    db: context.db, config: context.config,
    sub2api: sub2apiFixture({
      channels, groups, accounts, apiKeys: {},
      exportError: new AppError('SUB2API_REQUEST_FAILED', 'Not found', { status: 405 })
    })
  });
  await assert.rejects(
    () => unsupportedService.autoMappings({ mode: 'apply' }),
    (error) => error.code === 'SUB2API_KEY_EXPORT_UNSUPPORTED'
  );

  const malformedService = new MappingService({
    db: context.db, config: context.config,
    sub2api: sub2apiFixture({ channels, groups, accounts, apiKeys: {}, exportPayload: { accounts: [] } })
  });
  await assert.rejects(
    () => malformedService.autoMappings({ mode: 'apply' }),
    (error) => error.code === 'SCHEMA_MISMATCH'
  );
  assert.equal(context.db.prepare('SELECT COUNT(*) count FROM sub2api_mappings').get().count, 0);
});

test('auto-mapping exports only name-matched accounts and distinguishes key outcomes', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const createProvider = (name, slug) => providers.create({
    name, adapterType: 'new-api', baseUrl: `https://${slug}.example`,
    authMode: 'system_token', credentials: { systemToken: 'secret', userId: '1' }, enabled: true
  });
  const supplier = createProvider('Supplier B', 'supplier-b');
  const emptyExport = createProvider('Empty Export', 'empty-export');
  const unknownKey = createProvider('Unknown Key', 'unknown-key');
  const brokenGroup = createProvider('Broken Group', 'broken-group');
  const sharedValue = 'sk-shared-account-key-12345678';
  const brokenGroupValue = 'sk-broken-group-key-87654321';
  insertGroup(context.db, supplier.id, { remoteId: 'premium', name: 'Premium', ratio: 1.25 });
  insertGroup(context.db, emptyExport.id, { remoteId: 'premium', name: 'Premium', ratio: 1.1 });
  insertGroup(context.db, unknownKey.id, { remoteId: 'premium', name: 'Premium', ratio: 1.2 });
  const sharedKeyId = insertKey(context.db, supplier.id, {
    remoteId: 'shared', name: 'Shared key', apiKey: sharedValue, primaryGroupRef: 'premium'
  });
  insertKey(context.db, emptyExport.id, {
    remoteId: 'empty', name: 'Empty key', apiKey: 'sk-empty-stored-12345678', primaryGroupRef: 'premium'
  });
  insertKey(context.db, unknownKey.id, {
    remoteId: 'known', name: 'Known key', apiKey: 'sk-known-stored-12345678', primaryGroupRef: 'premium'
  });
  insertKey(context.db, brokenGroup.id, {
    remoteId: 'broken', name: 'Broken group key', apiKey: brokenGroupValue, primaryGroupRef: 'deleted-group'
  });
  const channels = [
    { id: 31, name: 'Route A', status: 'active', group_ids: [301] },
    { id: 32, name: 'Route B', status: 'active', group_ids: [302] },
    { id: 33, name: 'Route C', status: 'active', group_ids: [303] },
    { id: 34, name: 'Route D', status: 'active', group_ids: [304] }
  ];
  const groups = [301, 302, 303, 304].map((id) => ({
    id, name: `Group ${id}`, status: 'active', rate_multiplier: 1
  }));
  const accounts = [
    { id: 701, name: ' Supplier B ', type: 'api_key', group_ids: [301], credentials: { api_key: 'must-not-be-used' }, credentials_status: { has_api_key: true } },
    { id: 702, name: 'Supplier B backup', type: 'upstream', group_ids: [301], credentials_status: { has_api_key: true } },
    { id: 703, name: 'Empty Export', type: 'api_key', group_ids: [302], credentials_status: { has_api_key: true } },
    { id: 704, name: 'Unknown Key', type: 'api_key', group_ids: [303], credentials_status: { has_api_key: true } },
    { id: 705, name: 'Broken Group', type: 'api_key', group_ids: [304], credentials_status: { has_api_key: true } }
  ];
  const exports = [];
  const mappings = new MappingService({
    db: context.db,
    config: context.config,
    sub2api: sub2apiFixture({
      channels,
      groups,
      accounts,
      apiKeys: {
        701: sharedValue,
        703: '',
        704: 'sk-not-synced-anywhere-00000000',
        705: brokenGroupValue
      },
      onExport: (query, options) => exports.push({ query, accessToken: options.accessToken })
    })
  });

  const preview = await mappings.autoMappings({ mode: 'preview' }, { accessToken: 'current-sso-token' });
  assert.equal(exports.length, 1);
  assert.equal(exports[0].query.include_proxies, false);
  assert.equal(exports[0].accessToken, 'current-sso-token');
  assert.deepEqual(new Set(String(exports[0].query.ids).split(',').map(Number)), new Set([701, 703, 704, 705]));
  assert.equal(preview.summary.pendingCreate, 1);
  assert.equal(preview.summary.missingApiKey, 1);
  assert.equal(preview.summary.missingRemoteKey, 1);
  assert.equal(preview.summary.missingProviderGroup, 1);
  assert.equal(preview.items.find((item) => item.accountId === 701).keyId, sharedKeyId);
  assert.equal(preview.items.some((item) => item.accountId === 702), false);

  const applied = await mappings.autoMappings({ mode: 'apply' }, { accessToken: 'current-sso-token' });
  assert.equal(applied.summary.created, 1);
  assert.deepEqual(
    context.db.prepare('SELECT account_id FROM sub2api_mappings ORDER BY account_id').all().map((row) => row.account_id),
    [701]
  );
});

test('auto-mapping matches unordered account exports and rechecks duplicate names by ID', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'Duplicate', adapterType: 'new-api', baseUrl: 'https://duplicates.example',
    authMode: 'system_token', credentials: { systemToken: 'secret', userId: '1' }, enabled: true
  });
  insertGroup(context.db, provider.id, { remoteId: 'default', name: 'Default', ratio: 1 });
  const apiKeys = {
    901: 'sk-duplicate-first-12345678',
    902: 'sk-duplicate-second-87654321'
  };
  const keyIds = {
    901: insertKey(context.db, provider.id, {
      remoteId: 'first', name: 'First', apiKey: apiKeys[901], primaryGroupRef: 'default'
    }),
    902: insertKey(context.db, provider.id, {
      remoteId: 'second', name: 'Second', apiKey: apiKeys[902], primaryGroupRef: 'default'
    })
  };
  const accounts = [901, 902].map((id) => ({
    id,
    name: 'Duplicate',
    type: 'api_key',
    group_ids: [501],
    credentials_status: { has_api_key: true }
  }));
  const exportCalls = [];
  const mappings = new MappingService({
    db: context.db,
    config: context.config,
    sub2api: sub2apiFixture({
      channels: [],
      groups: [{ id: 501, name: 'Default', status: 'active', rate_multiplier: 1 }],
      accounts,
      apiKeys: {},
      onExport: (query) => exportCalls.push(String(query.ids).split(',').map(Number)),
      exportPayload: (ids) => ({
        accounts: [...ids].reverse().map((id) => ({
          name: 'Duplicate',
          credentials: { api_key: apiKeys[id] }
        }))
      })
    })
  });

  const preview = await mappings.autoMappings({ mode: 'preview' });
  assert.equal(preview.summary.pendingCreate, 2);
  assert.deepEqual(
    preview.items.map((item) => [item.accountId, item.keyId]).sort((left, right) => left[0] - right[0]),
    [[901, keyIds[901]], [902, keyIds[902]]]
  );
  assert.deepEqual(exportCalls.map((ids) => ids.length), [2, 1, 1]);
});

test('auto-mapping rolls back every insert when one item fails inside the apply transaction', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'Transactional', adapterType: 'new-api', baseUrl: 'https://transactional.example',
    authMode: 'system_token', credentials: { systemToken: 'secret', userId: '1' }, enabled: true
  });
  insertGroup(context.db, provider.id, { remoteId: 'default', name: 'Default', ratio: 1.1 });
  const keyValue = 'sk-transactional-key-12345678';
  insertKey(context.db, provider.id, {
    remoteId: 'key', name: 'Key', apiKey: keyValue, primaryGroupRef: 'default'
  });
  const mappings = new MappingService({
    db: context.db,
    config: context.config,
    sub2api: sub2apiFixture({
      channels: [{ id: 41, name: 'Unrelated route', status: 'active', group_ids: [401, 402] }],
      groups: [
        { id: 401, name: 'One', status: 'active', rate_multiplier: 1 },
        { id: 402, name: 'Two', status: 'active', rate_multiplier: 1 }
      ],
      accounts: [{ id: 801, name: 'Transactional', type: 'api_key', group_ids: [401, 402], credentials_status: { has_api_key: true } }],
      apiKeys: { 801: keyValue }
    })
  });
  context.db.exec(`
    CREATE TRIGGER fail_second_auto_mapping
    BEFORE INSERT ON sub2api_mappings WHEN NEW.group_id = 402
    BEGIN SELECT RAISE(ABORT, 'forced auto-mapping failure'); END;
  `);

  await assert.rejects(
    () => mappings.autoMappings({ mode: 'apply' }),
    /forced auto-mapping failure/
  );
  assert.equal(context.db.prepare('SELECT COUNT(*) count FROM sub2api_mappings').get().count, 0);

  const now = nowIso();
  context.db.prepare(`
    INSERT INTO sub2api_mappings(
      id, connection_id, key_id, account_id, group_id, role,
      enabled, models_json, config_json, created_at, updated_at
    ) VALUES ('existing-before-rebuild', ?, NULL, NULL, 999, 'primary', 1, '[]', '{}', ?, ?)
  `).run(provider.id, now, now);
  await assert.rejects(
    () => mappings.rebuildAutoMappings(),
    (error) => /forced auto-mapping failure/.test(error.message) &&
      error.details?.stage === 'replace_mappings' &&
      error.details?.replacementCommitted === false
  );
  assert.deepEqual(
    context.db.prepare('SELECT id FROM sub2api_mappings').all().map((row) => row.id),
    ['existing-before-rebuild']
  );
});

test('mapping rebuild refreshes matching suppliers and uses the final live Sub2API groups and composite rate', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'Fresh Supplier', adapterType: 'new-api', baseUrl: 'https://fresh.example',
    authMode: 'system_token', credentials: { systemToken: 'secret', userId: '1' },
    rechargeMultiplier: 2, enabled: true
  });
  insertGroup(context.db, provider.id, { remoteId: 'current', name: 'Current', ratio: 1 });
  const apiKey = 'sk-fresh-supplier-1234567890';
  insertKey(context.db, provider.id, {
    remoteId: 'fresh-key', name: 'Fresh key', apiKey, primaryGroupRef: 'current'
  });
  const account = {
    id: 911,
    name: 'Fresh Supplier',
    type: 'api_key',
    group_ids: [701],
    credentials_status: { has_api_key: true }
  };
  const groups = [
    { id: 701, name: 'Previous', status: 'active', rate_multiplier: 1 },
    { id: 702, name: 'Current', status: 'active', rate_multiplier: 1.2 }
  ];
  const syncCalls = [];
  const mappings = new MappingService({
    db: context.db,
    config: context.config,
    sub2api: sub2apiFixture({
      channels: [], groups, accounts: [account], apiKeys: { 911: apiKey }
    })
  });
  mappings.setProviderSync(async (connectionId, options) => {
    syncCalls.push({ connectionId, options });
    context.db.prepare('UPDATE remote_groups SET ratio = ?, last_seen_at = ? WHERE connection_id = ?')
      .run(2.4, nowIso(), connectionId);
    account.group_ids = [702];
    return {
      status: 'succeeded',
      mappingSnapshot: { ready: true, capturedAt: nowIso() },
      warnings: []
    };
  });

  const rebuilt = await mappings.rebuildAutoMappings();

  assert.deepEqual(syncCalls, [{
    connectionId: provider.id,
    options: { jobType: 'mapping_rebuild_sync', manual: true }
  }]);
  assert.equal(rebuilt.summary.providerSnapshots.refreshed, 1);
  assert.deepEqual(
    context.db.prepare('SELECT group_id FROM sub2api_mappings').all().map((row) => row.group_id),
    [702]
  );
  const comparison = rebuilt.comparisons.items[0].comparison;
  assert.equal(comparison.providerRate, 2.4);
  assert.equal(comparison.rechargeMultiplier, 2);
  assert.equal(comparison.compositeRate, 1.2);
  const state = context.db.prepare(`
    SELECT status, provider_rate, base_group_rate FROM sub2api_mapping_states
  `).get();
  assert.equal(state.status, 'aligned');
  assert.equal(state.provider_rate, 2.4);
  assert.equal(state.base_group_rate, 1.2);
});

test('mapping rebuild preserves existing mappings when a supplier snapshot is incomplete', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'Incomplete Supplier', adapterType: 'new-api', baseUrl: 'https://incomplete.example',
    authMode: 'system_token', credentials: { systemToken: 'secret', userId: '1' }, enabled: true
  });
  insertGroup(context.db, provider.id, { remoteId: 'default', name: 'Default', ratio: 1 });
  const apiKey = 'sk-incomplete-supplier-1234567890';
  const keyId = insertKey(context.db, provider.id, {
    remoteId: 'key', name: 'Key', apiKey, primaryGroupRef: 'default'
  });
  const now = nowIso();
  context.db.prepare(`
    INSERT INTO sub2api_mappings(
      id, connection_id, key_id, account_id, group_id, role,
      enabled, models_json, config_json, created_at, updated_at
    ) VALUES ('mapping-before-incomplete-sync', ?, ?, 921, 801, 'primary', 1, '[]', '{}', ?, ?)
  `).run(provider.id, keyId, now, now);
  const mappings = new MappingService({
    db: context.db,
    config: context.config,
    sub2api: sub2apiFixture({
      channels: [],
      groups: [{ id: 801, name: 'Default', status: 'active', rate_multiplier: 1 }],
      accounts: [{
        id: 921, name: 'Incomplete Supplier', type: 'api_key', group_ids: [801],
        credentials_status: { has_api_key: true }
      }],
      apiKeys: { 921: apiKey }
    })
  });
  mappings.setProviderSync(async () => ({
    status: 'partial',
    mappingSnapshot: {
      ready: false,
      capturedAt: nowIso(),
      groupsComplete: false,
      keysComplete: true
    },
    warnings: [{ capability: 'listGroups', code: 'TIMEOUT', message: 'Timed out' }]
  }));

  await assert.rejects(
    () => mappings.rebuildAutoMappings(),
    (error) => error.code === 'MAPPING_PROVIDER_SNAPSHOT_INCOMPLETE' &&
      error.details?.stage === 'refresh_provider_snapshots' &&
      error.retryable === true
  );
  assert.deepEqual(
    context.db.prepare('SELECT id FROM sub2api_mappings').all().map((row) => row.id),
    ['mapping-before-incomplete-sync']
  );
});

test('mapping rebuild rolls back mappings and comparison states when a composite rate is incomplete', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'Missing Rate', adapterType: 'new-api', baseUrl: 'https://missing-rate.example',
    authMode: 'system_token', credentials: { systemToken: 'secret', userId: '1' }, enabled: true
  });
  insertGroup(context.db, provider.id, { remoteId: 'default', name: 'Default', ratio: null });
  const apiKey = 'sk-missing-rate-1234567890';
  insertKey(context.db, provider.id, {
    remoteId: 'key', name: 'Key', apiKey, primaryGroupRef: 'default'
  });
  const now = nowIso();
  context.db.prepare(`
    INSERT INTO sub2api_mappings(
      id, connection_id, key_id, account_id, group_id, role,
      enabled, models_json, config_json, created_at, updated_at
    ) VALUES ('mapping-before-rate-failure', ?, NULL, NULL, 999, 'primary', 1, '[]', '{}', ?, ?)
  `).run(provider.id, now, now);
  context.db.prepare(`
    INSERT INTO sub2api_mapping_states(
      mapping_id, status, tolerance_ratio, details_json, checked_at
    ) VALUES ('mapping-before-rate-failure', 'aligned', 0.05, '{}', ?)
  `).run(now);
  const mappings = new MappingService({
    db: context.db,
    config: context.config,
    sub2api: sub2apiFixture({
      channels: [],
      groups: [{ id: 901, name: 'Default', status: 'active', rate_multiplier: 1 }],
      accounts: [{
        id: 931, name: 'Missing Rate', type: 'api_key', group_ids: [901],
        credentials_status: { has_api_key: true }
      }],
      apiKeys: { 931: apiKey }
    })
  });
  mappings.setProviderSync(async () => ({
    status: 'succeeded', mappingSnapshot: { ready: true, capturedAt: nowIso() }, warnings: []
  }));

  await assert.rejects(
    () => mappings.rebuildAutoMappings(),
    (error) => error.code === 'MAPPING_RATE_SNAPSHOT_INCOMPLETE' &&
      error.details?.stage === 'replace_mappings' &&
      error.details?.replacementCommitted === false
  );
  assert.deepEqual(
    context.db.prepare('SELECT id FROM sub2api_mappings').all().map((row) => row.id),
    ['mapping-before-rate-failure']
  );
  assert.deepEqual(
    context.db.prepare('SELECT mapping_id FROM sub2api_mapping_states').all().map((row) => row.mapping_id),
    ['mapping-before-rate-failure']
  );
});

test('highest-composite-rate grouping ignores raw-rate winners, uses stable tie-breakers and excludes invalid rates', () => {
  const items = [
    { id: 'raw-rate-only', provider_name: 'Zulu', key_id: 'a', account_id: 1, group_id: 1, comparison: { providerRate: 9, compositeRate: 1.5 } },
    { id: 'key-z', provider_name: 'Alpha', key_id: 'z', account_id: 2, group_id: 1, comparison: { providerRate: 2, compositeRate: 2 } },
    { id: 'winner', provider_name: 'Alpha', key_id: 'a', account_id: 3, group_id: 1, enabled: false, comparison: { providerRate: 1, compositeRate: 2 } },
    { id: 'zero', provider_name: 'Alpha', key_id: '0', account_id: 4, group_id: 1, comparison: { providerRate: 8, compositeRate: 0 } },
    { id: 'invalid', provider_name: 'Alpha', key_id: 'x', account_id: 5, group_id: 1, comparison: { providerRate: 8, compositeRate: 'not-a-rate' } },
    { id: 'missing-recharge', provider_name: 'Alpha', key_id: 'm', account_id: 6, group_id: 1, comparison: { providerRate: 99, compositeRate: null } },
    { id: 'orphan', provider_name: 'Other', key_id: 'o', account_id: 7, group_id: 999, comparison: { providerRate: 9, compositeRate: 9 } }
  ];
  assert.equal(highestMapping(items.filter((item) => item.group_id === 1)).id, 'winner');
  assert.equal(highestMapping(items.filter((item) => item.group_id === 1)).comparison.providerRate, 1);
  const grouped = groupComparisons(items, {
    groups: [
      { id: 1, name: 'One', status: 'active', defaultRate: 1, effectiveRate: 1 },
      { id: 2, name: 'Two', status: 'inactive', defaultRate: 1, effectiveRate: 1 }
    ]
  });
  assert.equal(grouped.groups.length, 2);
  assert.equal(grouped.groups[0].highest.id, 'winner');
  assert.equal(grouped.groups[0].items.filter((item) => item.isHighestRate).length, 1);
  assert.equal(grouped.groups[1].mappingCount, 0);
  assert.deepEqual(grouped.unassignedItems.map((item) => item.id), ['orphan']);
});
