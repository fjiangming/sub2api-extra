const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');
const { createApplication } = require('../src/server');
const { AppError } = require('../src/errors');
const {
  KeyProbeService,
  DEFAULT_PROMPTS,
  probeHealth
} = require('../src/services/key-probe-service');
const {
  DirectKeyProbeTransport,
  Sub2ApiProbeCredentialExporter,
  clearCredentialMap
} = require('../src/services/direct-key-probe');

function insertAccount(db, {
  id,
  name,
  platform = 'openai',
  type = 'apikey',
  status = 'active',
  groups = []
}) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO sub2api_monitored_accounts(
      account_id, name, platform, account_type, status, schedulable,
      metadata_json, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
  `).run(String(id), name, platform, type, status, JSON.stringify({
    groupIds: groups.map((group) => String(group.id)),
    groups: groups.map((group) => ({
      id: String(group.id),
      name: group.name,
      status: group.status || 'active'
    }))
  }), now, now);
}

function createSub2ApiMock(db, mockOptions = {}) {
  const calls = [];
  const statuses = new Map();
  return {
    calls,
    statuses,
    authenticationStatus() {
      return { available: true, source: 'test' };
    },
    async adminToken() {
      calls.push({ type: 'auth' });
      return 'test-token';
    },
    async data(endpoint, requestOptions = {}) {
      if (endpoint === '/api/v1/admin/accounts/data') {
        const ids = String(requestOptions.query?.ids || '').split(',').filter(Boolean);
        calls.push({ type: 'credential_export', endpoint, ids, query: requestOptions.query });
        return {
          accounts: ids.map((id) => {
            const account = db.prepare(`
              SELECT name, platform, account_type FROM sub2api_monitored_accounts WHERE account_id = ?
            `).get(id);
            return {
              name: account.name,
              platform: account.platform,
              type: account.account_type,
              credentials: {
                api_key: `sk-ephemeral-test-${id}`,
                base_url: 'https://upstream.example'
              },
              extra: { openai_responses_supported: true },
              ...(mockOptions.proxyAccountIds?.has?.(String(id)) ? { proxy_key: `proxy-${id}` } : {})
            };
          })
        };
      }
      const match = endpoint.match(/\/accounts\/([^/?]+)$/);
      const accountId = match ? decodeURIComponent(match[1]) : null;
      calls.push({ type: 'data', endpoint, method: requestOptions.method || 'GET', body: requestOptions.body });
      if (!accountId) return {};
      if (requestOptions.method === 'PUT') statuses.set(accountId, requestOptions.body.status);
      return { id: accountId, name: `Account ${accountId}`, status: statuses.get(accountId) || 'active' };
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

function createStreamingHttpMock() {
  const calls = [];
  return {
    calls,
    async requestSse(url, options) {
      calls.push({ url, options });
      const prompt = options.body?.input?.[0]?.content?.[0]?.text ||
        options.body?.messages?.[0]?.content ||
        options.body?.contents?.[0]?.parts?.[0]?.text || '';
      const marker = prompt.match(/PMV_[a-f0-9]+/)?.[0];
      assert.ok(marker, 'direct probe must add a per-sample verification marker');
      if (url.includes('/responses')) {
        await options.onEvent({
          event: 'response.output_text.delta',
          rawData: '{}',
          data: { type: 'response.output_text.delta', delta: marker }
        });
        await options.onEvent({
          event: 'response.output_text.delta',
          rawData: '{}',
          data: { type: 'response.output_text.delta', delta: ' 探测响应内容' }
        });
        await options.onEvent({
          event: 'response.completed',
          rawData: '{}',
          data: { type: 'response.completed', response: { model: options.body.model } }
        });
      } else {
        await options.onEvent({
          event: 'message',
          rawData: '{}',
          data: { choices: [{ delta: { content: `${marker} 探测响应内容` }, finish_reason: null }] }
        });
        await options.onEvent({ event: 'message', rawData: '[DONE]', data: '[DONE]' });
      }
      return { eventCount: 3, bytes: 64 };
    }
  };
}

function insertTrafficSamples(db, accountId, firstTokenValues) {
  const insert = db.prepare(`
    INSERT INTO sub2api_account_request_samples(
      source_log_id, account_id, stream, duration_ms, first_token_ms,
      created_at, ingested_at
    ) VALUES (?, ?, 1, ?, ?, ?, ?)
  `);
  const base = Date.now() - firstTokenValues.length * 1000;
  firstTokenValues.forEach((firstTokenMs, index) => {
    const at = new Date(base + index * 1000).toISOString();
    insert.run(
      `${accountId}-traffic-${index}`,
      String(accountId),
      firstTokenMs + 1000,
      firstTokenMs,
      at,
      at
    );
  });
}

test('key probe service stores settings, schedules individual keys and aggregates samples', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  insertAccount(context.db, { id: 11, name: 'OpenAI Primary' });
  insertAccount(context.db, { id: 12, name: 'Claude Backup', platform: 'anthropic', type: 'oauth' });
  const sub2api = createSub2ApiMock(context.db);
  const http = createStreamingHttpMock();
  const service = new KeyProbeService({ db: context.db, config: context.config, sub2api, http });

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
  assert.equal(sub2api.calls.filter((call) => call.type === 'sse').length, 0);
  assert.equal(sub2api.calls.filter((call) => call.type === 'credential_export').length, 1);
  assert.equal(http.calls.length, 3);
  assert.equal(http.calls[0].options.body.model, 'gpt-monitor');
  assert.match(http.calls[0].options.body.input[0].content[0].text, /一个接口连续 5 次响应耗时/);
  assert.doesNotMatch(JSON.stringify(result), /ephemeral-test/);

  const listed = service.list({ platform: 'openai', health: 'healthy' });
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].latest.avgDurationMs >= 0, true);
  assert.equal(listed.summary.counts.disabled, 1);
  assert.equal(service.dueAccountIds().length, 0);

  const history = service.history({ accountId: '11' });
  assert.equal(history.items.length, 1);
  assert.equal(history.items[0].samples.length, 3);
  assert.equal(history.items[0].samples[0].prompt, settings.prompts.medium[0]);
  assert.doesNotMatch(
    JSON.stringify(context.db.prepare('SELECT * FROM sub2api_key_probe_samples').all()),
    /ephemeral-test/
  );
});

test('key probe health thresholds account for partial and complete failures', () => {
  assert.equal(probeHealth({ succeededCount: 3, failedCount: 0, averageMs: 900, warningMs: 1000, criticalMs: 3000 }), 'healthy');
  assert.equal(probeHealth({ succeededCount: 2, failedCount: 1, averageMs: 900, warningMs: 1000, criticalMs: 3000 }), 'warning');
  assert.equal(probeHealth({ succeededCount: 3, failedCount: 0, averageMs: 1200, warningMs: 1000, criticalMs: 3000 }), 'warning');
  assert.equal(probeHealth({ succeededCount: 0, failedCount: 3, averageMs: null, warningMs: 1000, criticalMs: 3000 }), 'critical');
  assert.equal(probeHealth({ succeededCount: 3, failedCount: 0, averageMs: 3200, warningMs: 1000, criticalMs: 3000 }), 'critical');
});

test('key probe automation groups accounts, disables slow traffic and recovers inactive keys', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const alpha = { id: 'alpha', name: 'OpenAI 主分组' };
  const beta = { id: 'beta', name: 'OpenAI 备用分组' };
  insertAccount(context.db, { id: 31, name: 'Slow active', groups: [alpha] });
  insertAccount(context.db, { id: 32, name: 'Beta active', groups: [beta] });
  insertAccount(context.db, { id: 33, name: 'Beta recovery', status: 'inactive', groups: [beta] });
  insertAccount(context.db, { id: 34, name: 'Ungrouped recovery', status: 'inactive' });
  insertTrafficSamples(context.db, '31', Array.from({ length: 10 }, () => 2200));
  const sub2api = createSub2ApiMock(context.db);
  const http = createStreamingHttpMock();
  sub2api.statuses.set('31', 'active');
  sub2api.statuses.set('32', 'active');
  sub2api.statuses.set('33', 'inactive');
  sub2api.statuses.set('34', 'inactive');
  const service = new KeyProbeService({ db: context.db, config: context.config, sub2api, http });
  service.saveSettings({
    autoControlEnabled: true,
    autoDisableThresholdMs: 1500,
    autoEnableThresholdMs: 1000,
    recoveryIntervalMinutes: 45,
    sampleCount: 2,
    concurrency: 2,
    models: { openai: 'gpt-monitor' }
  });

  const before = service.list({ groupId: 'beta' });
  assert.equal(before.items.length, 2);
  assert.deepEqual(
    new Set(before.groups.map((group) => group.id)),
    new Set(['alpha', 'beta', '__ungrouped__'])
  );
  const slow = service.list({ search: 'Slow active' }).items[0];
  assert.equal(slow.traffic.sampleCount, 10);
  assert.equal(slow.traffic.avgFirstTokenMs, 2200);
  assert.equal(slow.traffic.exceedsDisableThreshold, true);

  const result = await service.reconcileAutomation();
  assert.equal(result.disableCandidates, 1);
  assert.equal(result.disabled, 1);
  assert.equal(result.recoveryCandidates, 2);
  assert.equal(result.recoveryProbed, 2);
  assert.equal(result.reenabled, 2);
  assert.equal(sub2api.statuses.get('31'), 'inactive');
  assert.equal(sub2api.statuses.get('33'), 'active');
  assert.equal(sub2api.statuses.get('34'), 'active');
  assert.equal(
    context.db.prepare("SELECT status FROM sub2api_monitored_accounts WHERE account_id = '31'").get().status,
    'inactive'
  );
  assert.equal(
    context.db.prepare("SELECT COUNT(*) AS count FROM sub2api_key_probe_actions WHERE status = 'succeeded'").get().count,
    3
  );
  assert.equal(
    context.db.prepare("SELECT trigger_type FROM sub2api_key_probe_batches WHERE account_id = '33'").get().trigger_type,
    'recovery'
  );
  const betaHistory = service.history({ accountId: '33' });
  assert.equal(betaHistory.actions[0].action, 'auto_enable');
  assert.equal(betaHistory.items[0].details.recoveryReason, 'group_capacity_low');
  const ungroupedHistory = service.history({ accountId: '34' });
  assert.equal(ungroupedHistory.items[0].details.recoveryReason, 'recovery_interval_due');

  const after = service.list({ search: 'Slow active' }).items[0];
  assert.equal(after.traffic.sampleCount, 0);
  assert.equal(after.latestAction.action, 'auto_disable');
});

test('key probe automation requires a lower recovery threshold', (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const service = new KeyProbeService({
    db: context.db,
    config: context.config,
    sub2api: createSub2ApiMock(context.db)
  });
  assert.throws(
    () => service.saveSettings({ autoDisableThresholdMs: 1000, autoEnableThresholdMs: 1000 }),
    /自动启用阈值必须小于自动停用阈值/
  );
});

test('group shortage triggers one immediate recovery probe then respects the interval', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const group = { id: 'scarce', name: '容量不足分组' };
  insertAccount(context.db, { id: 41, name: 'Only active', groups: [group] });
  insertAccount(context.db, { id: 42, name: 'Inactive candidate', status: 'inactive', groups: [group] });
  const sub2api = createSub2ApiMock(context.db);
  sub2api.statuses.set('41', 'active');
  sub2api.statuses.set('42', 'inactive');
  sub2api.sse = async (_endpoint, options) => {
    await options.onEvent({ type: 'test_complete', success: true });
    return { eventCount: 1, bytes: 8 };
  };
  const service = new KeyProbeService({ db: context.db, config: context.config, sub2api });
  service.saveSettings({
    autoControlEnabled: true,
    autoDisableThresholdMs: 2000,
    autoEnableThresholdMs: 800,
    recoveryIntervalMinutes: 60,
    sampleCount: 1
  });

  const first = await service.reconcileAutomation();
  assert.equal(first.recoveryCandidates, 1);
  assert.equal(first.recoveryProbed, 1);
  assert.equal(first.reenabled, 0);
  const second = await service.reconcileAutomation();
  assert.equal(second.recoveryCandidates, 0);
  assert.equal(second.recoveryProbed, 0);

  context.db.prepare(`
    UPDATE sub2api_key_probe_configs SET next_recovery_probe_at = ? WHERE account_id = '42'
  `).run(new Date(Date.now() - 60000).toISOString());
  const third = await service.reconcileAutomation();
  assert.equal(third.recoveryCandidates, 1);
  assert.equal(third.recoveryProbed, 1);
  const history = service.history({ accountId: '42' });
  assert.equal(history.items[0].details.recoveryReason, 'recovery_interval_due');
});

test('automatic recovery never enables OAuth, proxied, or prompt-unverified keys', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  insertAccount(context.db, { id: 51, name: 'OAuth disabled', type: 'oauth', status: 'inactive' });
  insertAccount(context.db, { id: 52, name: 'Proxy disabled', status: 'inactive' });
  insertAccount(context.db, { id: 53, name: 'Greeting disabled', status: 'inactive' });
  const sub2api = createSub2ApiMock(context.db, { proxyAccountIds: new Set(['52']) });
  for (const id of ['51', '52', '53']) sub2api.statuses.set(id, 'inactive');
  const http = {
    calls: [],
    async requestSse(url, options) {
      this.calls.push({ url, options });
      await options.onEvent({
        event: 'response.output_text.delta', rawData: '{}',
        data: { type: 'response.output_text.delta', delta: 'Hi! What can I help you with?' }
      });
      await options.onEvent({
        event: 'response.completed', rawData: '{}',
        data: { type: 'response.completed', response: {} }
      });
      return { eventCount: 2, bytes: 64 };
    }
  };
  const service = new KeyProbeService({ db: context.db, config: context.config, sub2api, http });
  service.saveSettings({
    autoControlEnabled: true,
    autoDisableThresholdMs: 2000,
    autoEnableThresholdMs: 800,
    recoveryIntervalMinutes: 60,
    sampleCount: 1,
    models: { openai: 'gpt-monitor' }
  });

  const result = await service.reconcileAutomation();

  assert.equal(result.recoveryProbed, 3);
  assert.equal(result.reenabled, 0);
  assert.equal(http.calls.length, 1);
  assert.deepEqual([...sub2api.statuses.values()], ['inactive', 'inactive', 'inactive']);
  assert.equal(service.history({ accountId: '51' }).items[0].errorCode, 'DIRECT_PROBE_ACCOUNT_TYPE_UNSUPPORTED');
  assert.equal(service.history({ accountId: '52' }).items[0].errorCode, 'DIRECT_PROBE_PROXY_UNSUPPORTED');
  assert.equal(service.history({ accountId: '53' }).items[0].errorCode, 'PROMPT_VERIFICATION_FAILED');
  assert.ok(result.probes.every((probe) => probe.verifiedSampleCount === 0));
});

test('credential export failure is recorded safely and never reaches the upstream', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  insertAccount(context.db, { id: 61, name: 'Step-up protected' });
  const sub2api = createSub2ApiMock(context.db);
  sub2api.data = async (endpoint) => {
    if (endpoint === '/api/v1/admin/accounts/data') {
      throw new AppError('SUB2API_REQUEST_FAILED', 'step up required', {
        status: 403,
        details: { remoteCode: 'STEP_UP_REQUIRED', remoteStatus: 403 }
      });
    }
    return {};
  };
  const http = createStreamingHttpMock();
  const service = new KeyProbeService({ db: context.db, config: context.config, sub2api, http });
  service.saveSettings({ sampleCount: 1, models: { openai: 'gpt-monitor' } });

  const result = await service.run({ accountIds: ['61'] });

  assert.equal(result.results[0].status, 'critical');
  assert.equal(http.calls.length, 0);
  assert.equal(service.history({ accountId: '61' }).items[0].errorCode, 'SUB2API_STEP_UP_REQUIRED');
  assert.doesNotMatch(JSON.stringify(result), /api_key|sk-/i);
});

test('key probe HTTP API exposes configuration, filtering and immediate runs', async (t) => {
  const context = createTestContext();
  const sub2api = createSub2ApiMock(context.db);
  const http = createStreamingHttpMock();
  insertAccount(context.db, {
    id: 21,
    name: 'HTTP OpenAI Key',
    groups: [{ id: 'http-openai', name: 'HTTP OpenAI 分组' }]
  });
  const app = createApplication({
    config: context.config,
    db: context.db,
    sub2api,
    http,
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
      autoControlEnabled: true,
      autoDisableThresholdMs: 2000,
      autoEnableThresholdMs: 900,
      recoveryIntervalMinutes: 20,
      sampleCount: 2,
      warningThresholdMs: 1000,
      criticalThresholdMs: 3000,
      models: { openai: 'gpt-http-monitor' }
    })
  });
  assert.equal(saved.status, 200);
  const savedBody = await saved.json();
  assert.equal(savedBody.settings.autoControlEnabled, true);
  assert.equal(savedBody.settings.autoDisableThresholdMs, 2000);
  assert.equal(savedBody.settings.autoEnableThresholdMs, 900);

  const keys = await fetch(`${base}/api/key-probes/keys?platform=openai&groupId=http-openai`, {
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

  const automation = await fetch(`${base}/api/key-probes/automation/run?wait=true`, {
    method: 'POST',
    headers,
    body: '{}'
  });
  assert.equal(automation.status, 200);
  assert.equal((await automation.json()).enabled, true);
});
