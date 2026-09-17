const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');
const { createApplication } = require('../src/server');

async function authenticatedServer(t, sub2api) {
  const context = createTestContext();
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
  return {
    baseUrl,
    context,
    cookie,
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/json',
      'X-CSRF-Token': session.csrfToken
    }
  };
}

test('Sub2API pool config targets only upstream Key accounts and merges both retry fields', async (t) => {
  const requests = [];
  const accounts = [
    { id: 11, type: 'apikey' },
    { id: '12', account_type: 'api_key' },
    { accountId: 13, type: 'upstream' },
    { id: 14, type: 'oauth' },
    { id: 15, type: 'setup-token' },
    { id: 11, type: 'apikey' }
  ];
  const sub2api = {
    setAdminApiKey() {},
    authenticationStatus() { return { available: true, source: 'test' }; },
    async listAll(endpoint, query, options) {
      requests.push({ kind: 'list', endpoint, query, options });
      return { items: accounts, total: accounts.length, truncated: false };
    },
    async data(endpoint, options) {
      requests.push({ kind: 'data', endpoint, options });
      return {
        success: 3,
        failed: 0,
        success_ids: [11, 12, 13],
        failed_ids: [],
        results: [11, 12, 13].map((accountId) => ({ account_id: accountId, success: true }))
      };
    }
  };
  const { baseUrl, context, cookie, headers } = await authenticatedServer(t, sub2api);

  const preview = await fetch(`${baseUrl}/api/sub2api/accounts/pool-config-targets`, {
    headers: { Cookie: cookie }
  });
  assert.equal(preview.status, 200);
  assert.deepEqual(await preview.json(), {
    count: 3,
    accountTypes: { apikey: 1, api_key: 1, upstream: 1 }
  });

  const withoutCsrf = await fetch(`${baseUrl}/api/sub2api/accounts/pool-config`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ retryCount: 2, retryStatusCodes: [429] })
  });
  assert.equal(withoutCsrf.status, 403);

  const invalid = await fetch(`${baseUrl}/api/sub2api/accounts/pool-config`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ retryCount: 11, retryStatusCodes: [99, 429] })
  });
  assert.equal(invalid.status, 400);
  assert.equal(requests.filter((request) => request.kind === 'data').length, 0);

  const updated = await fetch(`${baseUrl}/api/sub2api/accounts/pool-config`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ retryCount: 2, retryStatusCodes: [503, 429, 503, 401] })
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(await updated.json(), {
    targetCount: 3,
    success: 3,
    failed: 0,
    failedAccountIds: [],
    retryCount: 2,
    retryStatusCodes: [401, 429, 503]
  });

  const mutation = requests.find((request) => request.kind === 'data');
  assert.equal(mutation.endpoint, '/api/v1/admin/accounts/bulk-update');
  assert.equal(mutation.options.method, 'POST');
  assert.deepEqual(mutation.options.body, {
    account_ids: [11, 12, 13],
    credentials: {
      pool_mode_retry_count: 2,
      pool_mode_retry_status_codes: [401, 429, 503]
    }
  });
  assert.equal('pool_mode' in mutation.options.body.credentials, false);

  const audit = context.db.prepare(`
    SELECT action, target_type, details_json FROM audit_logs
    WHERE action = 'sub2api.pool_config.bulk_update'
  `).get();
  assert.equal(audit.target_type, 'sub2api_account');
  assert.deepEqual(JSON.parse(audit.details_json), {
    targetCount: 3,
    success: 3,
    failed: 0,
    retryCount: 2,
    retryStatusCodes: [401, 429, 503]
  });
});

test('Sub2API pool config is a no-op when no upstream Key accounts exist', async (t) => {
  let mutationCount = 0;
  const sub2api = {
    setAdminApiKey() {},
    authenticationStatus() { return { available: true, source: 'test' }; },
    async listAll() {
      return {
        items: [{ id: 21, type: 'oauth' }, { id: 22, type: 'setup-token' }],
        total: 2,
        truncated: false
      };
    },
    async data() {
      mutationCount += 1;
      throw new Error('Unexpected Sub2API mutation');
    }
  };
  const { baseUrl, headers } = await authenticatedServer(t, sub2api);
  const response = await fetch(`${baseUrl}/api/sub2api/accounts/pool-config`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ retryCount: 0, retryStatusCodes: [] })
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    targetCount: 0,
    success: 0,
    failed: 0,
    failedAccountIds: [],
    retryCount: 0,
    retryStatusCodes: []
  });
  assert.equal(mutationCount, 0);
});
