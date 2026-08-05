const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');
const { createApplication } = require('../src/server');
const { AppError } = require('../src/errors');

test('administrator API Key settings verify before encrypted storage and restore the environment fallback', async (t) => {
  const environmentKey = 'admin-environment-fallback-1234567890';
  const storedKey = 'admin-settings-secret-0987654321';
  const blockedKey = 'admin-step-up-blocked-1234567890';
  const context = createTestContext({ SUB2API_ADMIN_API_KEY: environmentKey });
  const configuredKeys = [];
  const verifiedKeys = [];
  const sub2api = {
    setAdminApiKey(value, capability = null) {
      configuredKeys.push({ value, capability });
    },
    authenticationStatus() {
      return { available: true, source: 'admin_api_key' };
    },
    async verifyAdminApiKey(value) {
      verifiedKeys.push(value);
      if (value === blockedKey) {
        throw new AppError(
          'SUB2API_ADMIN_API_KEY_EXPORT_FORBIDDEN',
          'Blocked by step-up',
          {
            status: 409,
            details: { remoteCode: 'STEP_UP_ADMIN_API_KEY_FORBIDDEN' }
          }
        );
      }
      return {
        verified: true,
        verifiedAt: '2026-08-05T12:00:00.000Z',
        capabilities: {
          adminGroups: true,
          adminAccounts: true,
          accountKeyExport: true
        },
        groupCount: 7,
        sampledAccount: true
      };
    }
  };
  const app = createApplication({
    config: context.config,
    db: context.db,
    sub2api,
    startBackground: false
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await app.locals.close();
    context.cleanup();
  });

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-password' })
  });
  assert.equal(login.status, 200);
  const session = await login.json();
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const headers = {
    Cookie: cookie,
    'Content-Type': 'application/json',
    'X-CSRF-Token': session.csrfToken
  };

  const withoutReauth = await fetch(`${baseUrl}/api/sub2api/admin-api-key`, {
    method: 'PUT', headers, body: JSON.stringify({ adminApiKey: blockedKey })
  });
  assert.equal(withoutReauth.status, 403);
  assert.deepEqual(verifiedKeys, []);

  const reauth = await fetch(`${baseUrl}/api/auth/reauth`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ username: 'admin', password: 'test-password' })
  });
  assert.equal(reauth.status, 200);

  const blocked = await fetch(`${baseUrl}/api/sub2api/admin-api-key`, {
    method: 'PUT', headers, body: JSON.stringify({ adminApiKey: blockedKey })
  });
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error.code, 'SUB2API_ADMIN_API_KEY_EXPORT_FORBIDDEN');
  assert.equal(context.db.prepare(`
    SELECT COUNT(*) AS count FROM encrypted_credentials
    WHERE id = 'integration:sub2api-admin-api-key'
  `).get().count, 0);

  const saved = await fetch(`${baseUrl}/api/sub2api/admin-api-key`, {
    method: 'PUT', headers, body: JSON.stringify({ adminApiKey: storedKey })
  });
  assert.equal(saved.status, 200);
  const savedBody = await saved.json();
  assert.equal(savedBody.source, 'stored');
  assert.equal(savedBody.capabilities.accountKeyExport, true);
  assert.equal(JSON.stringify(savedBody).includes(storedKey), false);
  assert.deepEqual(verifiedKeys, [blockedKey, storedKey]);

  const encrypted = context.db.prepare(`
    SELECT payload FROM encrypted_credentials
    WHERE id = 'integration:sub2api-admin-api-key'
  `).get().payload;
  assert.equal(encrypted.includes(storedKey), false);
  const statusResponse = await fetch(`${baseUrl}/api/sub2api/admin-api-key`, {
    headers: { Cookie: cookie }
  });
  const status = await statusResponse.json();
  assert.equal(status.source, 'stored');
  assert.equal(status.maskedKey.includes(storedKey), false);

  const deleted = await fetch(`${baseUrl}/api/sub2api/admin-api-key`, {
    method: 'DELETE', headers
  });
  assert.equal(deleted.status, 200);
  const deletedBody = await deleted.json();
  assert.equal(deletedBody.source, 'environment');
  assert.equal(configuredKeys.at(-1).value, environmentKey);
  assert.equal(context.db.prepare(`
    SELECT COUNT(*) AS count FROM encrypted_credentials
    WHERE id = 'integration:sub2api-admin-api-key'
  `).get().count, 0);

  const auditPayload = context.db.prepare(`
    SELECT GROUP_CONCAT(details_json, '') AS payload FROM audit_logs
    WHERE action LIKE 'sub2api.admin_api_key.%'
  `).get().payload || '';
  assert.equal(auditPayload.includes(storedKey), false);
  assert.equal(auditPayload.includes(blockedKey), false);
});
