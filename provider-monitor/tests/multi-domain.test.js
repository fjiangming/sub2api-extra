'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');
const { publicOrigins } = require('../src/public-origins');

const env = {
  NODE_ENV: 'test',
  SUB2API_BASE_URL: 'http://127.0.0.1:8080',
  SUB2API_PUBLIC_URL: 'https://old.example',
  SUB2API_PUBLIC_URLS: 'https://new.example/, https://www.new.example,https://old.example',
  PROVIDER_MONITOR_SECRET: 'test-domain-secret-0123456789abcdef0123456789',
};

test('public domain aliases preserve the canonical URL and internal API endpoint', () => {
  const config = loadConfig(env);
  assert.equal(config.sub2apiBaseUrl, 'http://127.0.0.1:8080');
  assert.equal(config.sub2apiPublicUrl, 'https://old.example');
  assert.deepEqual(config.sub2apiPublicOrigins, ['https://old.example', 'https://new.example', 'https://www.new.example']);
  assert.deepEqual(loadConfig({ ...env, SUB2API_PUBLIC_URLS: '' }).sub2apiPublicOrigins, ['https://old.example']);
});

test('domain aliases reject wildcard grants, credentials, paths, queries and insecure production origins', () => {
  for (const value of ['https://*.example', 'https://user:pass@example.com', 'https://new.example/path',
    'https://new.example?token=secret', 'https://new.example/#fragment', 'javascript:alert(1)', 'https://new.\nexample']) {
    assert.throws(() => loadConfig({ ...env, SUB2API_PUBLIC_URLS: value }), /SUB2API_PUBLIC_URLS/);
  }
  assert.throws(() => publicOrigins('https://old.example', 'http://new.example', 'SUB2API_PUBLIC_URLS', true), /HTTPS/);
  assert.deepEqual(publicOrigins(null, '', 'SUB2API_PUBLIC_URLS'), []);
});


const { createTestContext } = require('./helpers');
const { createApplication } = require('../src/server');

test('monitor domain aliases allow embedded pages without enabling cross-origin private APIs', async (t) => {
  const context = createTestContext(env);
  const app = createApplication({ config: context.config, db: context.db, startBackground: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await app.locals.close();
    context.cleanup();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(base);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'),
    /frame-ancestors 'self' https:\/\/old\.example https:\/\/new\.example https:\/\/www\.new\.example/);
  assert.equal((await fetch(`${base}/api/summary`)).status, 401);
  const configResponse = await fetch(`${base}/api/auth/config`, { headers: { origin: 'https://new.example' } });
  assert.equal(configResponse.headers.get('access-control-allow-origin'), null);
});
