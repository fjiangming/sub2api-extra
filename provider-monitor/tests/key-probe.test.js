const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');
const { createApplication } = require('../src/server');
const {
  KeyProbeService,
  DEFAULT_PROMPTS,
  probeHealth
} = require('../src/services/key-probe-service');

function insertAccount(db, { id, name, platform = 'openai', type = 'apikey', status = 'active' }) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO sub2api_monitored_accounts(
      account_id, name, platform, account_type, status, schedulable,
      metadata_json, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, 1, '{}', ?, ?)
  `).run(String(id), name, platform, type, status, now, now);
}

function createSub2ApiMock() {
  const calls = [];
  return {
    calls,
    authenticationStatus() {
      return { available: true, source: 'test' };
    },
    async adminToken() {
      calls.push({ type: 'auth' });
      return 'test-token';
    },
    async sse(endpoint, options) {
      calls.push({ type: 'sse', endpoint, body: options.body, timeoutMs: options.timeoutMs });
      await options.onEvent({ type: 'test_start', model: options.body.model_id || 'auto-model' });
      await options.onEvent({ type: 'content', text: '探测响应内容' });
      await options.onEvent({ type: 'test_complete', success: true });
      return { eventCount: 3, bytes: 32 };
    }
  };
}

test('key probe service stores settings, schedules individual keys and aggregates samples', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  insertAccount(context.db, { id: 11, name: 'OpenAI Primary' });
  insertAccount(context.db, { id: 12, name: 'Claude Backup', platform: 'anthropic', type: 'oauth' });
  const sub2api = createSub2ApiMock();
  const service = new KeyProbeService({ db: context.db, config: context.config, sub2api });

  assert.deepEqual(service.settings().prompts.simple, [...DEFAULT_PROMPTS.simple]);
  const settings = service.saveSettings({
    enabled: true,
    defaultIntervalMinutes: 30,
    sampleCount: 3,
    complexity: 'medium',
    warningThresholdMs: 1000,
    criticalThresholdMs: 3000,
    models: { openai: 'gpt-monitor', anthropic: 'claude-monitor' }
  });
  assert.equal(settings.enabled, true);
  assert.equal(settings.models.openai, 'gpt-monitor');
  assert.ok(settings.prompts.medium.every((prompt) => !/^hello\W*$/i.test(prompt)));

  service.saveAccountConfig('12', { enabled: false });
  assert.deepEqual(service.dueAccountIds(), ['11']);

  const result = await service.run({ accountIds: ['11'], triggerType: 'manual' });
  assert.equal(result.accountCount, 1);
  assert.equal(result.results[0].sampleCount, 3);
  assert.equal(result.results[0].succeededCount, 3);
  assert.equal(result.results[0].status, 'healthy');
  assert.equal(sub2api.calls.filter((call) => call.type === 'sse').length, 3);
  assert.equal(sub2api.calls.find((call) => call.type === 'sse').body.model_id, 'gpt-monitor');

  const listed = service.list({ platform: 'openai', health: 'healthy' });
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].latest.avgDurationMs >= 0, true);
  assert.equal(listed.summary.counts.disabled, 1);
  assert.equal(service.dueAccountIds().length, 0);

  const history = service.history({ accountId: '11' });
  assert.equal(history.items.length, 1);
  assert.equal(history.items[0].samples.length, 3);
  assert.equal(history.items[0].samples[0].prompt, settings.prompts.medium[0]);
});

test('key probe health thresholds account for partial and complete failures', () => {
  assert.equal(probeHealth({ succeededCount: 3, failedCount: 0, averageMs: 900, warningMs: 1000, criticalMs: 3000 }), 'healthy');
  assert.equal(probeHealth({ succeededCount: 2, failedCount: 1, averageMs: 900, warningMs: 1000, criticalMs: 3000 }), 'warning');
  assert.equal(probeHealth({ succeededCount: 3, failedCount: 0, averageMs: 1200, warningMs: 1000, criticalMs: 3000 }), 'warning');
  assert.equal(probeHealth({ succeededCount: 0, failedCount: 3, averageMs: null, warningMs: 1000, criticalMs: 3000 }), 'critical');
  assert.equal(probeHealth({ succeededCount: 3, failedCount: 0, averageMs: 3200, warningMs: 1000, criticalMs: 3000 }), 'critical');
});

test('key probe HTTP API exposes configuration, filtering and immediate runs', async (t) => {
  const context = createTestContext();
  const sub2api = createSub2ApiMock();
  insertAccount(context.db, { id: 21, name: 'HTTP OpenAI Key' });
  const app = createApplication({
    config: context.config,
    db: context.db,
    sub2api,
    startBackground: false
  });
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

  const saved = await fetch(`${base}/api/key-probes/config`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      enabled: true,
      sampleCount: 2,
      warningThresholdMs: 1000,
      criticalThresholdMs: 3000,
      models: { openai: 'gpt-http-monitor' }
    })
  });
  assert.equal(saved.status, 200);

  const keys = await fetch(`${base}/api/key-probes/keys?platform=openai`, {
    headers: { Cookie: cookie }
  });
  assert.equal(keys.status, 200);
  assert.deepEqual((await keys.json()).items.map((item) => item.accountId), ['21']);

  const run = await fetch(`${base}/api/key-probes/run?wait=true`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ accountIds: ['21'] })
  });
  assert.equal(run.status, 200);
  const runBody = await run.json();
  assert.equal(runBody.results[0].sampleCount, 2);

  const disable = await fetch(`${base}/api/key-probes/keys/21`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ enabled: false })
  });
  assert.equal(disable.status, 200);
  assert.equal((await disable.json()).config.enabled, false);

  const history = await fetch(`${base}/api/key-probes/history?accountId=21`, {
    headers: { Cookie: cookie }
  });
  assert.equal(history.status, 200);
  assert.equal((await history.json()).items[0].samples.length, 2);
});
