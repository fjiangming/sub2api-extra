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
