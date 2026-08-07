const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');
const { ProviderRepository } = require('../src/repositories/provider-repository');
const { apiKeyIdentityHash } = require('../src/security/configured-api-keys');

test('API Key identity hashes are stable, keyed and do not reveal the key', () => {
  const key = 'sk-identity-secret-1234';
  const first = apiKeyIdentityHash(key, 'first-master-secret');
  assert.equal(first, apiKeyIdentityHash(`Bearer ${key}`, 'first-master-secret'));
  assert.notEqual(first, apiKeyIdentityHash(key, 'second-master-secret'));
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first.includes('identity-secret'), false);
});

test('provider credentials preserve, rename, add and remove configured API Keys by stable ID', (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'Gateway',
    adapterType: 'sub2api',
    baseUrl: 'https://gateway.example',
    authMode: 'api_key',
    credentials: {
      apiKeys: [
        { id: 'primary', name: 'Primary', key: 'sk-primary-secret-1234' },
        { id: 'backup', name: 'Backup', key: 'sk-backup-secret-1234' }
      ]
    }
  });

  assert.deepEqual(provider.configuredApiKeys.map((entry) => ({
    id: entry.id,
    name: entry.name
  })), [
    { id: 'primary', name: 'Primary' },
    { id: 'backup', name: 'Backup' }
  ]);
  assert.doesNotMatch(JSON.stringify(provider), /primary-secret|backup-secret/);

  const updated = providers.update(provider.id, {
    credentials: {
      apiKeys: [
        { id: 'primary', name: 'Primary renamed' },
        { name: 'Canary', key: 'sk-canary-secret-1234' }
      ]
    }
  });
  const stored = providers.getCredentials(provider.id);
  assert.equal(stored.apiKey, undefined);
  assert.equal(stored.apiKeys.length, 2);
  assert.deepEqual(stored.apiKeys.map((entry) => [entry.name, entry.key]), [
    ['Primary renamed', 'sk-primary-secret-1234'],
    ['Canary', 'sk-canary-secret-1234']
  ]);
  assert.equal(stored.apiKeys.some((entry) => entry.id === 'backup'), false);
  assert.equal(updated.configuredApiKeys.some((entry) => entry.id === 'primary'), true);
  assert.equal(updated.configuredApiKeys.some((entry) => entry.name === 'Canary'), true);
});

test('legacy single API Key is exposed and migrated without changing its configured key ID', (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'Legacy gateway',
    adapterType: 'sub2api',
    baseUrl: 'https://legacy.example',
    authMode: 'api_key',
    credentials: { apiKey: 'sk-legacy-secret-1234' }
  });

  assert.equal(provider.configuredApiKeys[0].id, 'configured-api-key');
  providers.update(provider.id, {
    credentials: {
      apiKeys: [{ id: 'configured-api-key', name: 'Legacy renamed' }]
    }
  });
  const stored = providers.getCredentials(provider.id);
  assert.equal(stored.apiKey, undefined);
  assert.deepEqual(stored.apiKeys, [{
    id: 'configured-api-key',
    name: 'Legacy renamed',
    key: 'sk-legacy-secret-1234'
  }]);
});
