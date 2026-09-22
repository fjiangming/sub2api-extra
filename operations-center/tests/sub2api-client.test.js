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
