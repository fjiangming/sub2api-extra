const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createTestContext } = require('./helpers');
const { createApplication } = require('../src/server');
const { nowIso } = require('../src/db');
const { maskKey } = require('../src/security/redaction');

function seedProviderAssets(db, providerId, apiKey) {
  const now = nowIso();
  const groupId = crypto.randomUUID();
  const keyId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO remote_groups(
      id, connection_id, remote_id, group_type, name, ratio, status,
      metadata_json, first_seen_at, last_seen_at
    ) VALUES (?, ?, 'premium', 'key_route_group', 'Premium', 1.5, 'active', '{}', ?, ?)
  `).run(groupId, providerId, now, now);
  db.prepare(`
    INSERT INTO remote_keys(
      id, connection_id, remote_id, name, masked_key, status,
      primary_group_ref, unlimited, metadata_json, first_seen_at, last_seen_at
    ) VALUES (?, ?, 'remote-key', 'Primary key', ?, 'active', 'premium', 0, '{}', ?, ?)
  `).run(keyId, providerId, maskKey(apiKey), now, now);
  return keyId;
}

test('auto-mapping HTTP API enforces CSRF and exposes preview, apply and grouped comparisons', async (t) => {
  const context = createTestContext();
  const app = createApplication({ config: context.config, db: context.db, startBackground: false });
  const { providers, sub2api } = app.locals.services;
  const provider = providers.create({
    name: 'API Supplier', adapterType: 'new-api', baseUrl: 'https://api-supplier.example',
    authMode: 'system_token', credentials: { systemToken: 'secret', userId: '1' }, enabled: true
  });
  const apiKey = 'sk-api-route-test-12345678';
  const keyId = seedProviderAssets(context.db, provider.id, apiKey);
  sub2api.authenticationStatus = () => ({ available: true, source: 'test' });
  sub2api.listAll = async (endpoint) => {
    if (endpoint === '/api/v1/admin/channels') {
      return { items: [{ id: 51, name: 'Unrelated API route', status: 'active', group_ids: [501] }] };
    }
    if (endpoint === '/api/v1/admin/accounts') {
      return { items: [{ id: 901, name: 'API Supplier', type: 'api_key', group_ids: [501], credentials_status: { has_api_key: true } }] };
    }
    throw new Error(`Unexpected list endpoint: ${endpoint}`);
  };
  sub2api.data = async (endpoint) => {
    if (endpoint === '/api/v1/admin/groups/all') {
      return [
        { id: 501, name: 'Retail', status: 'active', rate_multiplier: 1 },
        { id: 502, name: 'No mappings', status: 'active', rate_multiplier: 0.8 }
      ];
    }
    if (endpoint === '/api/v1/groups/rates') return { 501: 1, 502: 0.8 };
    if (endpoint === '/api/v1/admin/accounts/data') {
      return { accounts: [{ name: 'API Supplier', credentials: { api_key: apiKey } }] };
    }
    throw new Error(`Unexpected data endpoint: ${endpoint}`);
  };

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

  const csrfFailure = await fetch(`${base}/api/sub2api/auto-mappings`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'preview' })
  });
  assert.equal(csrfFailure.status, 403);

  const previewResponse = await fetch(`${base}/api/sub2api/auto-mappings`, {
    method: 'POST', headers, body: JSON.stringify({ mode: 'preview' })
  });
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.equal(preview.summary.pendingCreate, 1);
  assert.equal(preview.items[0].keyId, keyId);
  assert.doesNotMatch(JSON.stringify(preview), /sk-api-route-test/);
  assert.equal(context.db.prepare('SELECT COUNT(*) count FROM sub2api_mappings').get().count, 0);

  const applyResponse = await fetch(`${base}/api/sub2api/auto-mappings`, {
    method: 'POST', headers, body: JSON.stringify({ mode: 'apply' })
  });
  assert.equal(applyResponse.status, 200);
  const applied = await applyResponse.json();
  assert.equal(applied.summary.created, 1);

  const comparisonsResponse = await fetch(`${base}/api/sub2api/comparisons`, { headers: { Cookie: cookie } });
  assert.equal(comparisonsResponse.status, 200);
  const comparisons = await comparisonsResponse.json();
  assert.equal(comparisons.items.length, 1);
  assert.equal(comparisons.groups.length, 2);
  assert.equal(comparisons.groups.find((group) => group.groupId === 501).highest.key_id, keyId);
  assert.equal(comparisons.groups.find((group) => group.groupId === 502).mappingCount, 0);
  assert.deepEqual(comparisons.unassignedItems, []);

  const invalidMode = await fetch(`${base}/api/sub2api/auto-mappings`, {
    method: 'POST', headers, body: JSON.stringify({ mode: 'guess' })
  });
  assert.equal(invalidMode.status, 400);
});
