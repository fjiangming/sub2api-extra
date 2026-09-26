'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Agent, fetch: undiciFetch } = require('undici');
const {
  Sub2ApiClient,
  asItems,
  isTimeoutError,
  timeoutMessage
} = require('../src/sub2api-client');

function client() {
  return new Sub2ApiClient({
    sub2apiBaseUrl: 'https://sub2api.example.test',
    requestTimeoutMs: 1000,
    maxResponseBytes: 1024 * 1024
  });
}

test('Sub2API list envelopes are normalized', () => {
  assert.deepEqual(asItems({ code: 0, data: [{ id: 1 }] }), [{ id: 1 }]);
  assert.deepEqual(asItems({ data: { items: [{ id: 2 }] } }), [{ id: 2 }]);
});

test('verified users retain a normalized administrator capability', async () => {
  const api = client();
  api.request = async () => ({
    code: 0,
    data: { id: 7, username: 'owner', role: 'user', is_admin: true }
  });
  const user = await api.verifyUser('user-token');
  assert.equal(user.id, '7');
  assert.equal(user.is_admin, true);
  assert.equal(user.isAdmin, true);
});

test('group discovery uses only the ordinary user API contract', async () => {
  const api = client();
  const calls = [];
  api.request = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/v1/groups/available') {
      return { code: 0, data: [{ id: 9, name: 'Group 9', platform: 'OpenAI' }] };
    }
    return { code: 0, data: {} };
  };
  const groups = await api.listAvailableGroups('user-token');
  assert.deepEqual(groups.map(({ id, name, platform }) => ({ id, name, platform })), [
    { id: '9', name: 'Group 9', platform: 'openai' }
  ]);
  assert.deepEqual(calls.map((call) => call.path), ['/api/v1/groups/available']);
});

test('Undici header and body timeouts are classified as request timeouts', async () => {
  for (const code of ['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT']) {
    assert.equal(isTimeoutError({ cause: { code } }), true, code);
  }
  assert.equal(timeoutMessage(600000), 'Sub2API 请求在 10 分钟内未完成');

  const headersTimeout = new TypeError('fetch failed');
  headersTimeout.cause = { code: 'UND_ERR_HEADERS_TIMEOUT' };
  const api = new Sub2ApiClient({
    sub2apiBaseUrl: 'https://sub2api.example.test',
    requestTimeoutMs: 600000,
    maxResponseBytes: 1024
  }, async () => { throw headersTimeout; });
  await assert.rejects(
    () => api.request('/v1/responses'),
    (error) => error.code === 'SUB2API_TIMEOUT' && /10 分钟/.test(error.message)
  );
});

test('the default Sub2API client extends Undici timeouts beyond the service deadline', async (t) => {
  const api = client();
  t.after(() => api.close());
  assert.ok(api.dispatcher instanceof Agent);
  assert.equal(api.fetch, undiciFetch);
});
