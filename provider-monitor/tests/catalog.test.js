const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');
const { ProviderRepository } = require('../src/repositories/provider-repository');
const { CatalogService } = require('../src/services/catalog-service');

test('Sub2API catalog sync persists effective group rates and multiplied model prices', async () => {
  const context = createTestContext();
  try {
    const providers = new ProviderRepository(context.db, context.config);
    const provider = providers.create({
      name: 'Sub2API',
      adapterType: 'sub2api',
      baseUrl: 'https://sub2api.example',
      authMode: 'account',
      credentials: { accessToken: 'access-token', tokenExpiresAt: Date.now() + 3600000 },
      enabled: true
    });
    const catalog = new CatalogService({
      db: context.db,
      config: context.config,
      providers,
      http: {
        async requestJson(input) {
          const url = new URL(input);
          if (url.pathname === '/api/v1/groups/available') return { data: { code: 0, data: [{ id: 7, name: 'Codex', platform: 'openai', rate_multiplier: 0.1, status: 'active' }] } };
          if (url.pathname === '/api/v1/groups/rates') return { data: { code: 0, data: { 7: 0.04 } } };
          if (url.pathname === '/api/v1/channels/available') return { data: { code: 0, data: [{ name: 'OpenAI', platforms: [{ platform: 'openai', groups: [{ id: 7, name: 'Codex', rate_multiplier: 0.1 }], supported_models: [{ name: 'gpt-test', platform: 'openai', pricing: { billing_mode: 'token', input_price: 0.000002, output_price: 0.000008 } }] }] }] } };
          throw new Error(`Unexpected ${url.pathname}`);
        }
      }
    });

    const result = await catalog.sync(provider.id);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.groupRateCount, 1);
    assert.equal(result.priceCount, 1);
    const group = context.db.prepare('SELECT ratio, metadata_json FROM remote_groups WHERE connection_id = ?').get(provider.id);
    assert.equal(group.ratio, 0.04);
    assert.equal(JSON.parse(group.metadata_json).default_rate_multiplier, 0.1);
    const [price] = catalog.prices({ connectionId: provider.id });
    assert.equal(price.input_per_million, 0.08);
    assert.equal(price.output_per_million, 0.32);
    assert.equal(price.groupRatio, 0.04);
    assert.equal(price.groupName, 'Codex');
  } finally {
    context.cleanup();
  }
});

test('Sub2API catalog sync reports partial success when only group rates are available', async () => {
  const context = createTestContext();
  try {
    const providers = new ProviderRepository(context.db, context.config);
    const provider = providers.create({
      name: 'Sub2API',
      adapterType: 'sub2api',
      baseUrl: 'https://sub2api.example',
      authMode: 'account',
      credentials: { accessToken: 'access-token', tokenExpiresAt: Date.now() + 3600000 },
      enabled: true
    });
    const catalog = new CatalogService({
      db: context.db,
      config: context.config,
      providers,
      http: {
        async requestJson(input) {
          const url = new URL(input);
          if (url.pathname === '/api/v1/groups/available') return { data: { code: 0, data: [{ id: 7, name: 'Codex', platform: 'openai', rate_multiplier: 0.1, status: 'active' }] } };
          if (url.pathname === '/api/v1/groups/rates') return { data: { code: 0, data: { 7: 0.04 } } };
          if (url.pathname === '/api/v1/channels/available') return { data: { code: 0, data: [] } };
          throw new Error(`Unexpected ${url.pathname}`);
        }
      }
    });

    const result = await catalog.sync(provider.id);
    assert.equal(result.status, 'partial');
    assert.equal(result.groupRateCount, 1);
    assert.equal(result.priceCount, 0);
    assert.equal(result.warning.code, 'PRICE_CATALOG_NOT_EXPOSED');
    assert.equal(context.db.prepare('SELECT ratio FROM remote_groups WHERE connection_id = ?').get(provider.id).ratio, 0.04);
  } finally {
    context.cleanup();
  }
});
