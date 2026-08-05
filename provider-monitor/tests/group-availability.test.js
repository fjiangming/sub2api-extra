const assert = require('node:assert/strict');
const test = require('node:test');
const { createTestContext } = require('./helpers');
const { ProviderRepository } = require('../src/repositories/provider-repository');
const { CatalogService } = require('../src/services/catalog-service');
const { QueryService } = require('../src/services/query-service');

test('price comparison excludes disabled and unselectable groups without removing asset history', () => {
  const context = createTestContext();
  try {
    const providers = new ProviderRepository(context.db, context.config);
    const provider = providers.create({
      name: 'Group Visibility Provider',
      adapterType: 'custom',
      baseUrl: 'https://group-visibility.example',
      authMode: 'api_key',
      credentials: { apiKey: 'secret' },
      enabled: true
    });
    const capturedAt = '2026-08-05T10:00:00.000Z';
    const insertGroup = context.db.prepare(`
      INSERT INTO remote_groups(
        id, connection_id, remote_id, group_type, name, ratio, status,
        metadata_json, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, 'key_route_group', ?, 1, ?, ?, ?, ?)
    `);
    const groups = [
      ['active-group', 'active', { platform: 'openai', selectable: true }],
      ['enabled-group', 'enabled', { platform: 'anthropic' }],
      ['disabled-group', 'disabled', { platform: 'gemini' }],
      ['inactive-group', 'inactive', { platform: 'grok' }],
      ['derived-group', 'active', { platform: 'antigravity', derivedFromKey: true }],
      ['unselectable-group', 'active', { platform: 'other', selectable: false }],
      ['missing-group', 'missing', { platform: 'missing' }]
    ];
    for (const [id, status, metadata] of groups) {
      insertGroup.run(
        id, provider.id, id, id, status, JSON.stringify(metadata), capturedAt, capturedAt
      );
    }

    const insertPrice = context.db.prepare(`
      INSERT INTO model_prices(
        connection_id, model_id, group_ref, currency, billing_mode,
        input_per_million, raw_json, captured_at
      ) VALUES (?, ?, ?, 'USD', 'token', ?, ?, ?)
    `);
    for (const [index, [id, , metadata]] of groups.entries()) {
      insertPrice.run(
        provider.id,
        'shared-model',
        `${id}@Primary`,
        index + 1,
        JSON.stringify({
          groupRemoteId: id,
          groupName: id,
          groupRatio: 1,
          platform: metadata.platform
        }),
        capturedAt
      );
    }
    insertPrice.run(
      provider.id,
      'direct-model',
      'Direct Provider',
      0.5,
      JSON.stringify({ groupRatio: 1, platform: 'openrouter' }),
      capturedAt
    );
    insertPrice.run(
      provider.id,
      'legacy-active-model',
      'active-group',
      0.75,
      JSON.stringify({ groupRatio: 1, platform: 'openai' }),
      capturedAt
    );
    insertPrice.run(
      provider.id,
      'legacy-disabled-model',
      'disabled-group',
      0.75,
      JSON.stringify({ groupRatio: 1, platform: 'gemini' }),
      capturedAt
    );
    insertPrice.run(
      provider.id,
      'orphan-model',
      'orphan-group@Primary',
      0.75,
      JSON.stringify({ groupRemoteId: 'orphan-group', groupRatio: 1, platform: 'other' }),
      capturedAt
    );

    const queries = new QueryService(context.db, context.config);
    assert.equal(queries.groups(provider.id).length, groups.length);
    assert.deepEqual(
      queries.groups(provider.id, { requireRatio: true }).map((group) => group.remote_id),
      ['active-group', 'enabled-group']
    );
    const groupPage = queries.groupsPage({ requireRatio: true, page: 1, pageSize: 20 });
    assert.equal(groupPage.pagination.total, 2);
    assert.deepEqual(groupPage.filterOptions.platforms, ['anthropic', 'openai']);

    const catalog = new CatalogService({ db: context.db, config: context.config });
    const prices = catalog.prices({ connectionId: provider.id });
    assert.deepEqual(
      prices.map((price) => price.group_ref),
      ['Direct Provider', 'active-group', 'active-group@Primary', 'enabled-group@Primary']
    );
    const page = catalog.prices({ connectionId: provider.id, page: 1, pageSize: 20 });
    assert.equal(page.pagination.total, 4);
    assert.equal(page.summary.models, 3);
    assert.deepEqual(page.filterOptions.platforms, ['anthropic', 'openai', 'openrouter']);
    assert.deepEqual(
      catalog.comparisons('shared-model').map((price) => price.group_ref),
      ['active-group@Primary', 'enabled-group@Primary']
    );
  } finally {
    context.cleanup();
  }
});
