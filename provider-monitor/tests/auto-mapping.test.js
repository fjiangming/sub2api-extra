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

function insertKey(db, providerId, { remoteId, name, apiKey, primaryGroupRef }) {
  const now = nowIso();
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO remote_keys(
      id, connection_id, remote_id, name, masked_key, status,
      primary_group_ref, unlimited, metadata_json, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, 0, '{}', ?, ?)
  `).run(id, providerId, remoteId, name, maskKey(apiKey), primaryGroupRef, now, now);
  return id;
}

function sub2apiFixture({ channels, groups, accounts, apiKeys, exportError = null, exportPayload = null, onExport = null }) {
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
      if (endpoint === '/api/v1/admin/accounts/data') {
        onExport?.(options.query);
        if (exportError) throw exportError;
        if (exportPayload) return exportPayload;
        const ids = String(options.query?.ids || '').split(',').filter(Boolean).map(Number);
        return {
          accounts: ids.map((id) => {
            const account = accounts.find((item) => Number(item.id) === id);
            return { name: account.name, credentials: { api_key: apiKeys[id] || '' } };
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
      channels: [{ id: 1, name: 'GPT', status: 'active', group_ids: [3] }],
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
  assert.deepEqual(preview.items.map((item) => item.channelName), ['GPT', 'GPT']);
  assert.deepEqual(preview.items.map((item) => item.accountMatch), ['contains', 'contains']);
  assert.deepEqual(new Set(String(exports[0].ids).split(',').map(Number)), new Set([108, 113]));

  const applied = await mappings.autoMappings({ mode: 'apply' });
  assert.equal(applied.summary.created, 2);
  assert.deepEqual(
    context.db.prepare('SELECT account_id FROM sub2api_mappings ORDER BY account_id').all().map((row) => row.account_id),
    [108, 113]
  );
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

test('auto-mapping previews, preserves manual rows, maps one account to multiple groups and selects the highest rate', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'Supplier A', adapterType: 'new-api', baseUrl: 'https://supplier-a.example',
    authMode: 'system_token', credentials: { systemToken: 'secret', userId: '1' }, enabled: true
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
  assert.equal(retail.items.filter((item) => item.isHighestRate).length, 1);
  assert.equal(team.highest.key_id, highKeyId);
  assert.equal(unmapped.mappingCount, 0);
  assert.equal(unmapped.highest, null);

  const repeated = await mappings.autoMappings({ mode: 'apply' });
  assert.equal(repeated.summary.created, 0);
  assert.equal(repeated.summary.existing, 2);
  assert.equal(context.db.prepare('SELECT COUNT(*) count FROM sub2api_mappings').get().count, 3);
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
      onExport: (query) => exports.push(query)
    })
  });

  const preview = await mappings.autoMappings({ mode: 'preview' });
  assert.equal(exports.length, 1);
  assert.equal(exports[0].include_proxies, false);
  assert.deepEqual(new Set(String(exports[0].ids).split(',').map(Number)), new Set([701, 703, 704, 705]));
  assert.equal(preview.summary.pendingCreate, 1);
  assert.equal(preview.summary.missingApiKey, 1);
  assert.equal(preview.summary.missingRemoteKey, 1);
  assert.equal(preview.summary.missingProviderGroup, 1);
  assert.equal(preview.items.find((item) => item.accountId === 701).keyId, sharedKeyId);
  assert.equal(preview.items.some((item) => item.accountId === 702), false);

  const applied = await mappings.autoMappings({ mode: 'apply' });
  assert.equal(applied.summary.created, 1);
  assert.deepEqual(
    context.db.prepare('SELECT account_id FROM sub2api_mappings ORDER BY account_id').all().map((row) => row.account_id),
    [701]
  );
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
});

test('highest-rate grouping uses stable tie-breakers, excludes invalid rates and keeps unassigned rows', () => {
  const items = [
    { id: 'channel-2', channel_id: 2, provider_name: 'Alpha', key_id: 'a', group_id: 1, comparison: { providerRate: 2 } },
    { id: 'provider-z', channel_id: 1, provider_name: 'Zulu', key_id: 'a', group_id: 1, comparison: { providerRate: 2 } },
    { id: 'key-z', channel_id: 1, provider_name: 'Alpha', key_id: 'z', group_id: 1, comparison: { providerRate: 2 } },
    { id: 'winner', channel_id: 1, provider_name: 'Alpha', key_id: 'a', group_id: 1, enabled: false, comparison: { providerRate: 2 } },
    { id: 'zero', channel_id: 1, provider_name: 'Alpha', key_id: '0', group_id: 1, comparison: { providerRate: 0 } },
    { id: 'invalid', channel_id: 1, provider_name: 'Alpha', key_id: 'x', group_id: 1, comparison: { providerRate: 'not-a-rate' } },
    { id: 'orphan', channel_id: 9, provider_name: 'Other', key_id: 'o', group_id: 999, comparison: { providerRate: 9 } }
  ];
  assert.equal(highestMapping(items.filter((item) => item.group_id === 1)).id, 'winner');
  const grouped = groupComparisons(items, {
    groups: [
      { id: 1, name: 'One', status: 'active', defaultRate: 1, effectiveRate: 1 },
      { id: 2, name: 'Two', status: 'inactive', defaultRate: 1, effectiveRate: 1 }
    ],
    channels: [{ id: 1, name: 'Channel', status: 'active', groupIds: [1], groupIdsKnown: true }]
  });
  assert.equal(grouped.groups.length, 2);
  assert.equal(grouped.groups[0].highest.id, 'winner');
  assert.equal(grouped.groups[0].items.filter((item) => item.isHighestRate).length, 1);
  assert.equal(grouped.groups[1].mappingCount, 0);
  assert.deepEqual(grouped.unassignedItems.map((item) => item.id), ['orphan']);
});
