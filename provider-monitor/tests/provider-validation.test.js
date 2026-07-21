const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');
const { createApplication } = require('../src/server');

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

test('provider validation reuses saved credentials and lets new account credentials replace stale tokens', async (t) => {
  const loginBodies = [];
  const upstream = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/v1/auth/login' && req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      loginBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.end(JSON.stringify({
        code: 0,
        data: {
          access_token: `access-${loginBodies.length}`,
          refresh_token: `refresh-${loginBodies.length}`,
          expires_in: 3600
        }
      }));
      return;
    }
    if (req.url === '/api/v1/user/profile') {
      res.end(JSON.stringify({
        code: 0,
        data: {
          id: 17,
          email: 'saved@example.com',
          username: 'saved-user',
          balance: 8.5,
          total_recharged: 10
        }
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ message: `Unexpected ${req.method} ${req.url}` }));
  });
  const upstreamBaseUrl = await listen(upstream);

  const context = createTestContext();
  const app = createApplication({ config: context.config, db: context.db, startBackground: false });
  const server = http.createServer(app);
  const baseUrl = await listen(server);
  t.after(async () => {
    await close(server);
    await app.locals.close();
    await close(upstream);
    context.cleanup();
  });

  const login = await fetch(`${baseUrl}/api/auth/login`, {
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

  const provider = app.locals.services.providers.create({
    name: 'OAuth-capable Sub2API',
    adapterType: 'sub2api',
    baseUrl: upstreamBaseUrl,
    authMode: 'account',
    credentials: { email: 'saved@example.com', password: 'saved-password' },
    enabled: false
  });
  const candidate = {
    existingProviderId: provider.id,
    name: provider.name,
    adapterType: 'sub2api',
    baseUrl: upstreamBaseUrl,
    authMode: 'account',
    credentials: {},
    enabled: false,
    refreshIntervalMinutes: 15,
    warningThreshold: null,
    thresholdCurrency: 'USD',
    typeConfig: {},
    tags: [],
    note: '',
    remoteUserId: null,
    accountDedupeKey: null
  };

  const savedCredentialValidation = await fetch(`${baseUrl}/api/providers/validate`, {
    method: 'POST', headers, body: JSON.stringify(candidate)
  });
  assert.equal(savedCredentialValidation.status, 200);
  assert.equal((await savedCredentialValidation.json()).balances[0].available, 8.5);
  assert.deepEqual(loginBodies[0], {
    email: 'saved@example.com',
    password: 'saved-password'
  });

  app.locals.services.providers.updateCredentials(provider.id, {
    email: 'saved@example.com',
    password: 'old-password',
    accessToken: 'stale-access-token',
    refreshToken: 'stale-refresh-token',
    tokenExpiresAt: Date.now() + 3600000
  });
  const replacementValidation = await fetch(`${baseUrl}/api/providers/validate`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...candidate, credentials: { password: 'correct-password' } })
  });
  assert.equal(replacementValidation.status, 200);
  assert.deepEqual(loginBodies[1], {
    email: 'saved@example.com',
    password: 'correct-password'
  });
});
