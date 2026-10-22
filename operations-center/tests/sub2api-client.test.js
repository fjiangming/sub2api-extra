'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Sub2ApiClient } = require('../src/sub2api-client');

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload)
  };
}

test('backup records are unwrapped from the native API response', async () => {
  const requests = [];
  const client = new Sub2ApiClient({
    sub2apiBaseUrl: 'https://sub2api.example',
    sub2apiAdminToken: 'fixed-token',
    sub2apiRequestTimeoutMs: 1000
  }, async (url, options) => {
    requests.push({ url, options });
    return response(200, { code: 0, data: { items: [{ id: 'b1', status: 'completed' }] } });
  });
  assert.deepEqual(await client.listBackups(), [{ id: 'b1', status: 'completed' }]);
  assert.equal(requests[0].options.headers.authorization, 'Bearer fixed-token');
});

test('upstream errors do not leak a token', async () => {
  const client = new Sub2ApiClient({
    sub2apiBaseUrl: 'https://sub2api.example',
    sub2apiAdminToken: 'secret-token',
    sub2apiRequestTimeoutMs: 1000
  }, async () => response(403, { message: 'forbidden' }));
  await assert.rejects(client.listBackups(), (error) => {
    assert.equal(error.code, 'SUB2API_REQUEST_FAILED');
    assert.ok(!error.message.includes('secret-token'));
    return true;
  });
});

test('a verified browser SSO token can temporarily authorize native backup calls', async () => {
  const requests = [];
  const client = new Sub2ApiClient({
    sub2apiBaseUrl: 'https://sub2api.example',
    sub2apiAdminToken: null,
    sub2apiAdminEmail: null,
    sub2apiAdminPassword: null,
    sub2apiRequestTimeoutMs: 1000
  }, async (url, options) => {
    requests.push({ url, options });
    return response(200, { code: 0, data: { id: 'backup-1' } });
  });

  assert.equal(client.configured(), false);
  client.setRuntimeToken('browser-session-token', Date.now() + 3600000);
  assert.equal(client.configured(), true);
  await client.startBackup();
  assert.equal(requests[0].options.headers.authorization, 'Bearer browser-session-token');
  client.clearRuntimeToken('browser-session-token');
  assert.equal(client.configured(), false);
});

test('persistent administrator credentials are verified without replacing the active configuration', async () => {
  const client = new Sub2ApiClient({
    sub2apiBaseUrl: 'https://sub2api.example',
    sub2apiAdminToken: 'existing-fixed-token',
    sub2apiAdminEmail: null,
    sub2apiAdminPassword: null,
    sub2apiRequestTimeoutMs: 1000
  }, async (_url, options) => {
    assert.equal(options.headers.authorization, 'Bearer candidate-admin-token');
    return response(200, { code: 0, data: { id: 1, username: 'admin', role: 'admin' } });
  });

  const result = await client.validateAdminCredentials({ token: 'candidate-admin-token' });
  assert.deepEqual(result, { valid: true, user: 'admin' });
  assert.equal(client.config.sub2apiAdminToken, 'existing-fixed-token');
  assert.equal(client.token, 'existing-fixed-token');
});

test('native API calls fall back to the public Sub2API URL after a connection failure', async () => {
  const requests = [];
  const client = new Sub2ApiClient({
    sub2apiBaseUrl: 'http://sub2api.internal:8080',
    sub2apiPublicUrl: 'https://sub2api.example',
    sub2apiAdminToken: 'fixed-token',
    sub2apiRequestTimeoutMs: 1000
  }, async (url) => {
    requests.push(url);
    if (url.startsWith('http://sub2api.internal:8080')) throw new TypeError('fetch failed');
    return response(200, { code: 0, data: { items: [{ id: 'b1' }] } });
  });

  assert.deepEqual(await client.listBackups(), [{ id: 'b1' }]);
  assert.deepEqual(requests, [
    'http://sub2api.internal:8080/api/v1/admin/backups',
    'https://sub2api.example/api/v1/admin/backups'
  ]);
  assert.equal(client.config.sub2apiResolvedBaseUrl, 'https://sub2api.example');
});

test('mutating native API calls are not replayed across origins after an uncertain failure', async () => {
  const requests = [];
  const client = new Sub2ApiClient({
    sub2apiBaseUrl: 'http://sub2api.internal:8080',
    sub2apiPublicUrl: 'https://sub2api.example',
    sub2apiAdminToken: 'fixed-token',
    sub2apiRequestTimeoutMs: 1000
  }, async (url) => {
    requests.push(url);
    if (url.endsWith('/api/v1/auth/me')) {
      return response(200, { code: 0, data: { id: 1, username: 'admin', role: 'admin' } });
    }
    throw new TypeError('connection reset after request');
  });

  await assert.rejects(client.startBackup(), (error) => error.code === 'SUB2API_UNAVAILABLE');
  assert.deepEqual(requests, [
    'http://sub2api.internal:8080/api/v1/auth/me',
    'http://sub2api.internal:8080/api/v1/admin/backups'
  ]);
});

test('native administrator API keys authorize recovery calls without a password login', async () => {
  const requests = [];
  const client = new Sub2ApiClient({ sub2apiBaseUrl: 'https://sub2api.example',
    sub2apiAdminToken: 'admin-integration-key', sub2apiRequestTimeoutMs: 1000 }, async (url, options) => {
    requests.push(url);
    assert.equal(options.headers['x-api-key'], 'admin-integration-key');
    assert.equal(options.headers.authorization, undefined);
    return response(200, { code: 0, data: { items: [] } });
  });
  assert.deepEqual(await client.raw('/api/v1/admin/billing-recovery?state=pending'), { code: 0, data: { items: [] } });
  assert.equal(requests.length, 1);
});

test('native administrator API key validation uses an admin route and restores active credentials', async () => {
  const client = new Sub2ApiClient({ sub2apiBaseUrl: 'https://sub2api.example',
    sub2apiAdminToken: 'existing-token', sub2apiRequestTimeoutMs: 1000 }, async (url, options) => {
    assert.equal(url, 'https://sub2api.example/api/v1/admin/system/version');
    assert.equal(options.headers['x-api-key'], 'admin-candidate');
    return response(200, { code: 0, data: { version: '1.0.0' } });
  });
  assert.deepEqual(await client.validateAdminCredentials({ token: 'admin-candidate' }), { valid: true, user: 'Admin API Key' });
  assert.equal(client.token, 'existing-token');
});

test('rejected native administrator API key validation preserves active credentials', async () => {
  const client = new Sub2ApiClient({ sub2apiBaseUrl: 'https://sub2api.example',
    sub2apiAdminToken: 'existing-token', sub2apiRequestTimeoutMs: 1000 }, async () => response(403, { message: 'forbidden' }));
  await assert.rejects(client.validateAdminCredentials({ token: 'admin-invalid' }), { code: 'SUB2API_REQUEST_FAILED' });
  assert.equal(client.token, 'existing-token');
});

test('a browser authorization override does not inherit the persistent administrator API key', async () => {
  const client = new Sub2ApiClient({ sub2apiBaseUrl: 'https://sub2api.example',
    sub2apiAdminToken: 'admin-persistent', sub2apiRequestTimeoutMs: 1000 }, async (_url, options) => {
    assert.equal(new Headers(options.headers).get('authorization'), 'Bearer browser-session');
    assert.equal(options.headers['x-api-key'], undefined);
    return response(200, { code: 0 });
  });
  await client.raw('/api/v1/admin/billing-recovery', { headers: { Authorization: 'Bearer browser-session' } });
});

test('an explicit API key override does not inherit the persistent JWT', async () => {
  const client = new Sub2ApiClient({ sub2apiBaseUrl: 'https://sub2api.example',
    sub2apiAdminToken: 'persistent-jwt', sub2apiRequestTimeoutMs: 1000 }, async (_url, options) => {
    assert.equal(new Headers(options.headers).get('x-api-key'), 'admin-explicit');
    assert.equal(options.headers.authorization, undefined);
    return response(200, { code: 0 });
  });
  await client.raw('/api/v1/admin/billing-recovery', { headers: { 'X-Api-Key': 'admin-explicit' } });
});

test('administrator API key writes resolve an admin route and never replay uncertain writes', async () => {
  const urls = [];
  const client = new Sub2ApiClient({ sub2apiBaseUrl: 'http://sub2api.internal:8080',
    sub2apiPublicUrl: 'https://sub2api.example', sub2apiAdminToken: 'admin-persistent',
    sub2apiRequestTimeoutMs: 1000 }, async (url) => {
    urls.push(url);
    if (url.endsWith('/api/v1/admin/system/version')) return response(200, { code: 0, data: {} });
    throw new TypeError('connection reset after request');
  });
  await assert.rejects(client.raw('/api/v1/admin/billing-recovery/case/settle', { method: 'POST' }), { code: 'SUB2API_UNAVAILABLE' });
  assert.deepEqual(urls, ['http://sub2api.internal:8080/api/v1/admin/system/version',
    'http://sub2api.internal:8080/api/v1/admin/billing-recovery/case/settle']);
});
