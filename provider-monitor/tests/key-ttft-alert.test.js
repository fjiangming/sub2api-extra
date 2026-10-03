const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createTestContext } = require('./helpers');
const { createApplication } = require('../src/server');
const { NotificationService } = require('../src/services/notification-service');
const {
  ACTIVE_PROBE_EVENT_FINGERPRINT_PREFIX,
  ACTIVE_PROBE_SAMPLE_SOURCE,
  KeyTtftAlertService,
  SAMPLE_SOURCE
} = require('../src/services/key-ttft-alert-service');

let activeProbeSequence = 0;

function insertAccount(db, id, name) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO sub2api_monitored_accounts(
      account_id, name, platform, account_type, status, schedulable,
      metadata_json, first_seen_at, last_seen_at
    ) VALUES (?, ?, 'openai', 'apikey', 'active', 1, '{}', ?, ?)
  `).run(String(id), name, now, now);
}

function insertChannel(db, id, name = 'Email alerts') {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO notification_channels(
      id, name, type, enabled, config_json, created_at, updated_at
    ) VALUES (?, ?, 'email', 1, '{"to":"owner@example.com"}', ?, ?)
  `).run(id, name, now, now);
}

function insertBusinessSamples(db, accountId, values, endAt, prefix = 'business') {
  const insert = db.prepare(`
    INSERT INTO sub2api_account_request_samples(
      source_log_id, sample_source, account_id, stream, duration_ms,
      first_token_ms, created_at, ingested_at
    ) VALUES (?, 'business_usage', ?, 1, ?, ?, ?, ?)
  `);
  values.forEach((firstTokenMs, index) => {
    const createdAt = new Date(endAt - (values.length - index) * 1000).toISOString();
    insert.run(
      `${prefix}-${accountId}-${index}-${endAt}`,
      String(accountId),
      firstTokenMs + 1000,
      firstTokenMs,
      createdAt,
      createdAt
    );
  });
}

function insertActiveProbeSample(db, accountId, firstTokenMs, at, options = {}) {
  activeProbeSequence += 1;
  const status = options.status || 'succeeded';
  const batchId = `probe-batch-${accountId}-${activeProbeSequence}`;
  const sampleId = `probe-sample-${accountId}-${activeProbeSequence}`;
  const succeededCount = status === 'succeeded' ? 1 : 0;
  const failedCount = status === 'succeeded' ? 0 : 1;
  const durationMs = options.durationMs ?? (
    Number.isFinite(firstTokenMs) ? firstTokenMs + 1000 : null
  );
  db.prepare(`
    INSERT INTO sub2api_key_probe_batches(
      id, run_id, account_id, trigger_type, complexity, sample_count,
      succeeded_count, failed_count, status, avg_first_token_ms,
      started_at, completed_at
    ) VALUES (?, ?, ?, 'scheduled', 'simple', 1, ?, ?, ?, ?, ?, ?)
  `).run(
    batchId,
    `probe-run-${activeProbeSequence}`,
    String(accountId),
    succeededCount,
    failedCount,
    status === 'succeeded' ? 'critical' : 'failed',
    firstTokenMs,
    at,
    at
  );
  db.prepare(`
    INSERT INTO sub2api_key_probe_samples(
      id, batch_id, sample_index, prompt, status, duration_ms,
      first_token_ms, started_at, completed_at
    ) VALUES (?, ?, 0, 'probe prompt', ?, ?, ?, ?, ?)
  `).run(
    sampleId,
    batchId,
    status,
    durationMs,
    firstTokenMs,
    at,
    at
  );
  return { batchId, sampleId };
}

function notificationRecorder() {
  const deliveries = [];
  return {
    deliveries,
    async dispatch(event, options) {
      deliveries.push({ event, options });
      return [];
    }
  };
}

test('TTFT alerts use only real business request logs and selected channels', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const now = Date.parse('2026-09-29T08:00:00.000Z');
  const emailChannelId = '11111111-1111-4111-8111-111111111111';
  const unusedChannelId = '22222222-2222-4222-8222-222222222222';
  insertAccount(context.db, 'business-slow', 'Business slow');
  insertAccount(context.db, 'probe-only', 'Probe only');
  insertChannel(context.db, emailChannelId);
  insertChannel(context.db, unusedChannelId, 'Unused channel');
  insertBusinessSamples(context.db, 'business-slow', [2400, 2600, 2800], now);
  insertBusinessSamples(context.db, 'probe-only', [300, 400, 500], now);
  insertActiveProbeSample(
    context.db,
    'probe-only',
    120000,
    new Date(now - 1000).toISOString()
  );
  const notifications = notificationRecorder();
  const service = new KeyTtftAlertService({ db: context.db, notifications });
  service.saveSettings({
    enabled: true,
    windowMinutes: 5,
    sampleCount: 3,
    thresholdMs: 2000,
    cooldownMinutes: 60,
    channelIds: [emailChannelId]
  });

  const result = await service.evaluate({ at: now });

  assert.equal(result.evaluatedKeys, 2);
  assert.equal(result.matchedKeys, 1);
  assert.equal(result.notified, 1);
  assert.equal(notifications.deliveries.length, 1);
  assert.deepEqual(notifications.deliveries[0].options.channelIds, [emailChannelId]);
  assert.equal(notifications.deliveries[0].event.details.sampleSource, SAMPLE_SOURCE);
  assert.equal(notifications.deliveries[0].event.details.accountId, 'business-slow');
  assert.match(notifications.deliveries[0].event.message, /真实业务流式请求/);
  assert.deepEqual(
    context.db.prepare('SELECT subject_id FROM alert_events').all(),
    [{ subject_id: 'business-slow' }]
  );
});

test('TTFT alerts enforce sample count, cooldown and automatic resolution', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const now = Date.parse('2026-09-29T09:00:00.000Z');
  const channelId = '33333333-3333-4333-8333-333333333333';
  insertAccount(context.db, 'cooldown-key', 'Cooldown key');
  insertChannel(context.db, channelId);
  const notifications = notificationRecorder();
  const service = new KeyTtftAlertService({ db: context.db, notifications });
  service.saveSettings({
    enabled: true,
    windowMinutes: 30,
    sampleCount: 3,
    thresholdMs: 1000,
    cooldownMinutes: 10,
    channelIds: [channelId]
  });

  insertBusinessSamples(context.db, 'cooldown-key', [3000, 3000], now, 'short');
  assert.equal((await service.evaluate({ at: now })).matchedKeys, 0);
  assert.equal(notifications.deliveries.length, 0);

  insertBusinessSamples(context.db, 'cooldown-key', [3000], now + 1000, 'ready');
  assert.equal((await service.evaluate({ at: now + 2000 })).notified, 1);
  assert.equal((await service.evaluate({ at: now + 5 * 60000 })).notified, 0);

  insertBusinessSamples(context.db, 'cooldown-key', [3000], now + 6 * 60000, 'new-high');
  assert.equal((await service.evaluate({ at: now + 7 * 60000 })).renotified, 0);
  assert.equal((await service.evaluate({ at: now + 11 * 60000 })).renotified, 1);
  assert.equal((await service.evaluate({ at: now + 22 * 60000 })).renotified, 0);
  assert.equal(notifications.deliveries.length, 2);

  insertBusinessSamples(
    context.db,
    'cooldown-key',
    [200, 300, 400],
    now + 25 * 60000,
    'recovered'
  );
  const recovered = await service.evaluate({ at: now + 26 * 60000 });
  assert.equal(recovered.matchedKeys, 0);
  assert.equal(recovered.resolved, 1);
  assert.equal(
    context.db.prepare('SELECT status FROM alert_events').get().status,
    'resolved'
  );
});

test('active probe TTFT alerts require N consecutive slow successful requests', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const now = Date.parse('2026-09-29T09:30:00.000Z');
  const channelId = '55555555-5555-4555-8555-555555555555';
  insertAccount(context.db, 'probe-slow', 'Probe slow');
  insertChannel(context.db, channelId);
  for (const [index, firstTokenMs] of [2400, 2600, 2800].entries()) {
    insertActiveProbeSample(
      context.db,
      'probe-slow',
      firstTokenMs,
      new Date(now - (3 - index) * 1000).toISOString()
    );
  }
  const notifications = notificationRecorder();
  const service = new KeyTtftAlertService({ db: context.db, notifications });
  const disabled = await service.evaluate({ at: now });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.activeProbe.enabled, false);
  assert.equal(notifications.deliveries.length, 0);
  service.saveSettings({
    enabled: true,
    activeProbeConsecutiveCount: 3,
    thresholdMs: 2000,
    cooldownMinutes: 60,
    channelIds: [channelId]
  });

  const result = await service.evaluate({ at: now });

  assert.equal(result.business.matchedKeys, 0);
  assert.equal(result.activeProbe.enabled, true);
  assert.equal(result.activeProbe.evaluatedKeys, 1);
  assert.equal(result.activeProbe.matchedKeys, 1);
  assert.equal(result.activeProbe.notified, 1);
  assert.equal(notifications.deliveries.length, 1);
  assert.equal(notifications.deliveries[0].event.title, 'Key 主动检测首字延迟提醒');
  assert.match(notifications.deliveries[0].event.message, /最近 3 次主动检测请求/);
  assert.equal(
    notifications.deliveries[0].event.details.sampleSource,
    ACTIVE_PROBE_SAMPLE_SOURCE
  );
  assert.equal(notifications.deliveries[0].event.details.averageFirstTokenMs, 2600);
  assert.equal(notifications.deliveries[0].event.details.consecutiveCount, 3);
  assert.equal(notifications.deliveries[0].event.details.thresholdMs, 2000);
  assert.equal(
    context.db.prepare('SELECT fingerprint FROM alert_events').get().fingerprint,
    `${ACTIVE_PROBE_EVENT_FINGERPRINT_PREFIX}probe-slow`
  );
});

test('fast, failed and missing-TTFT probe samples break the consecutive sequence', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const now = Date.parse('2026-09-29T09:45:00.000Z');
  const channelId = '66666666-6666-4666-8666-666666666666';
  insertChannel(context.db, channelId);
  for (const [accountId, breaker] of [
    ['probe-fast-break', { firstTokenMs: 2000 }],
    ['probe-failed-break', { firstTokenMs: 5000, status: 'failed' }],
    ['probe-null-break', { firstTokenMs: null }]
  ]) {
    insertAccount(context.db, accountId, accountId);
    insertActiveProbeSample(
      context.db,
      accountId,
      3000,
      new Date(now - 3000).toISOString()
    );
    insertActiveProbeSample(
      context.db,
      accountId,
      breaker.firstTokenMs,
      new Date(now - 2000).toISOString(),
      { status: breaker.status }
    );
    insertActiveProbeSample(
      context.db,
      accountId,
      4000,
      new Date(now - 1000).toISOString()
    );
  }
  const notifications = notificationRecorder();
  const service = new KeyTtftAlertService({ db: context.db, notifications });
  service.saveSettings({
    enabled: true,
    activeProbeConsecutiveCount: 3,
    thresholdMs: 2000,
    channelIds: [channelId]
  });

  const result = await service.evaluate({ at: now });

  assert.equal(result.activeProbe.evaluatedKeys, 3);
  assert.equal(result.activeProbe.matchedKeys, 0);
  assert.equal(result.notified, 0);
  assert.equal(notifications.deliveries.length, 0);
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM alert_events').get().count, 0);
});

test('active probe alerts honor cooldown, require a new sample and resolve on recovery', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const now = Date.parse('2026-09-29T10:15:00.000Z');
  const channelId = '77777777-7777-4777-8777-777777777777';
  insertAccount(context.db, 'probe-cooldown', 'Probe cooldown');
  insertChannel(context.db, channelId);
  insertActiveProbeSample(
    context.db,
    'probe-cooldown',
    3000,
    new Date(now - 2000).toISOString()
  );
  insertActiveProbeSample(
    context.db,
    'probe-cooldown',
    4000,
    new Date(now - 1000).toISOString()
  );
  const notifications = notificationRecorder();
  const service = new KeyTtftAlertService({ db: context.db, notifications });
  service.saveSettings({
    enabled: true,
    activeProbeConsecutiveCount: 2,
    thresholdMs: 2000,
    cooldownMinutes: 10,
    channelIds: [channelId]
  });

  assert.equal((await service.evaluate({ at: now })).activeProbe.notified, 1);
  assert.equal((await service.evaluate({ at: now + 11 * 60000 })).activeProbe.renotified, 0);

  insertActiveProbeSample(
    context.db,
    'probe-cooldown',
    5000,
    new Date(now + 12 * 60000).toISOString()
  );
  assert.equal((await service.evaluate({ at: now + 13 * 60000 })).activeProbe.renotified, 1);
  assert.equal(notifications.deliveries.length, 2);

  insertActiveProbeSample(
    context.db,
    'probe-cooldown',
    500,
    new Date(now + 14 * 60000).toISOString()
  );
  const recovered = await service.evaluate({ at: now + 15 * 60000 });
  assert.equal(recovered.activeProbe.matchedKeys, 0);
  assert.equal(recovered.activeProbe.resolved, 1);
  assert.equal(
    context.db.prepare('SELECT status FROM alert_events').get().status,
    'resolved'
  );
});

test('legacy TTFT events wait for a newer business request before repeating', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const now = Date.parse('2026-09-29T10:00:00.000Z');
  const channelId = '44444444-4444-4444-8444-444444444444';
  insertAccount(context.db, 'legacy-event-key', 'Legacy event key');
  insertChannel(context.db, channelId);
  insertBusinessSamples(context.db, 'legacy-event-key', [3000, 3000, 3000], now, 'legacy');
  const lastRequestAt = context.db.prepare(`
    SELECT MAX(created_at) AS value FROM sub2api_account_request_samples
    WHERE account_id = 'legacy-event-key'
  `).get().value;
  context.db.prepare(`
    INSERT INTO alert_events(
      id, subject_type, subject_id, status, severity, message,
      fingerprint, details_json, triggered_at
    ) VALUES ('legacy-ttft-event', 'sub2api_key', 'legacy-event-key',
      'active', 'warning', 'legacy event', ?, ?, ?)
  `).run(
    'sub2api-business-ttft:legacy-event-key',
    JSON.stringify({ lastRequestAt }),
    new Date(now - 10 * 60000).toISOString()
  );
  const notifications = notificationRecorder();
  const service = new KeyTtftAlertService({ db: context.db, notifications });
  service.saveSettings({
    enabled: true,
    windowMinutes: 30,
    sampleCount: 3,
    thresholdMs: 1000,
    cooldownMinutes: 5,
    channelIds: [channelId]
  });

  assert.equal((await service.evaluate({ at: now })).notified, 0);
  assert.equal(notifications.deliveries.length, 0);
  const migratedDetails = JSON.parse(
    context.db.prepare("SELECT details_json FROM alert_events WHERE id = 'legacy-ttft-event'").get()
      .details_json
  );
  assert.equal(migratedDetails.lastNotifiedRequestAt, lastRequestAt);

  insertBusinessSamples(
    context.db,
    'legacy-event-key',
    [3000],
    now + 60000,
    'legacy-new'
  );
  const repeated = await service.evaluate({ at: now + 2 * 60000 });
  assert.equal(repeated.renotified, 1);
  assert.equal(notifications.deliveries.length, 1);
});

test('business request sample provenance rejects active-probe sources', (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  insertAccount(context.db, 'source-guard', 'Source guard');
  const now = new Date().toISOString();

  assert.throws(() => context.db.prepare(`
    INSERT INTO sub2api_account_request_samples(
      source_log_id, sample_source, account_id, stream, first_token_ms,
      created_at, ingested_at
    ) VALUES ('invalid-probe-sample', 'active_probe', 'source-guard', 1, 99999, ?, ?)
  `).run(now, now), /CHECK constraint failed/);
});

test('Key TTFT alert HTTP API saves shared settings and supports immediate evaluation', async (t) => {
  const context = createTestContext();
  const app = createApplication({
    config: context.config,
    db: context.db,
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
  const headers = {
    Cookie: login.headers.get('set-cookie').split(';')[0],
    'Content-Type': 'application/json',
    'X-CSRF-Token': session.csrfToken
  };
  const channelResponse = await fetch(`${base}/api/notification-channels`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'TTFT webhook',
      type: 'webhook',
      config: { url: 'https://alerts.example.test/provider-monitor' }
    })
  });
  assert.equal(channelResponse.status, 201);
  const channel = await channelResponse.json();
  const saved = await fetch(`${base}/api/key-ttft-alerts/config`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      enabled: true,
      windowMinutes: 8,
      sampleCount: 6,
      thresholdMs: 2500,
      activeProbeConsecutiveCount: 4,
      cooldownMinutes: 45,
      channelIds: [channel.id]
    })
  });
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).settings.channelIds, [channel.id]);

  const config = await fetch(`${base}/api/key-ttft-alerts/config`, {
    headers: { Cookie: headers.Cookie }
  });
  const configBody = await config.json();
  assert.equal(configBody.settings.sampleSource, 'business_usage');
  assert.equal(configBody.settings.activeProbeSampleSource, 'active_probe');
  assert.equal(configBody.settings.windowMinutes, 8);
  assert.equal(configBody.settings.activeProbeConsecutiveCount, 4);
  assert.equal(configBody.settings.thresholdMs, 2500);
  assert.equal('activeProbeEnabled' in configBody.settings, false);
  assert.equal('activeProbeThresholdMs' in configBody.settings, false);
  assert.equal(configBody.channels[0].name, 'TTFT webhook');

  const evaluation = await fetch(`${base}/api/key-ttft-alerts/evaluate?wait=true`, {
    method: 'POST',
    headers,
    body: '{}'
  });
  assert.equal(evaluation.status, 200);
  assert.equal((await evaluation.json()).matchedKeys, 0);
});

test('notification dispatch sends a TTFT event only to selected channels', async (t) => {
  const requests = [];
  const receiver = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    response.writeHead(204).end();
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const context = createTestContext();
  t.after(async () => {
    await new Promise((resolve) => receiver.close(resolve));
    context.cleanup();
  });
  const notifications = new NotificationService({ db: context.db, config: context.config });
  const endpoint = `http://127.0.0.1:${receiver.address().port}/alerts`;
  const selected = notifications.save({
    name: 'Selected', type: 'webhook', config: { url: endpoint }
  });
  notifications.save({ name: 'Not selected', type: 'webhook', config: { url: endpoint } });
  const triggeredAt = new Date().toISOString();
  context.db.prepare(`
    INSERT INTO alert_events(
      id, subject_type, subject_id, status, severity, message,
      fingerprint, details_json, triggered_at
    ) VALUES ('ttft-event', 'sub2api_key', '42', 'active', 'warning',
      'TTFT is high', 'test-selected-channel', '{}', ?)
  `).run(triggeredAt);

  await notifications.dispatch({
    id: 'ttft-event',
    title: 'Key 业务首字延迟提醒',
    severity: 'warning',
    message: 'TTFT is high',
    triggered_at: triggeredAt,
    details: { sampleSource: 'business_usage' }
  }, { channelIds: [selected.id] });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].title, 'Key 业务首字延迟提醒');
  assert.equal(
    context.db.prepare('SELECT channel_id FROM notification_deliveries').get().channel_id,
    selected.id
  );
});

test('email channels use authenticated TLS settings and send TTFT details', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const transports = [];
  const messages = [];
  const mailer = {
    createTransport(options) {
      transports.push(options);
      return {
        async sendMail(message) {
          messages.push(message);
        }
      };
    }
  };
  const notifications = new NotificationService({
    db: context.db,
    config: context.config,
    mailer
  });
  const channel = notifications.save({
    name: 'Owner email',
    type: 'email',
    config: {
      host: 'smtp.example.com',
      port: 587,
      useTLS: true,
      user: 'monitor@example.com',
      from: 'monitor@example.com',
      fromName: 'Sub2API Monitor',
      to: 'owner@example.com'
    },
    credentials: { password: 'smtp-secret' }
  });
  const triggeredAt = '2026-09-29T14:35:00.031Z';
  context.db.prepare(`
    INSERT INTO alert_events(
      id, subject_type, subject_id, status, severity, message,
      fingerprint, details_json, triggered_at
    ) VALUES ('email-ttft-event', 'sub2api_key', '88', 'active', 'warning',
      '业务首字过高', 'test-email-channel', '{}', ?)
  `).run(triggeredAt);

  await notifications.dispatch({
    id: 'email-ttft-event',
    title: 'Key 业务首字延迟提醒',
    severity: 'warning',
    message: 'Key #88 平均首字过高',
    triggered_at: triggeredAt,
    details: { sampleSource: 'business_usage' }
  }, { channelIds: [channel.id] });

  assert.equal(transports.length, 1);
  assert.equal(transports[0].secure, false);
  assert.equal(transports[0].requireTLS, true);
  assert.equal(transports[0].tls.minVersion, 'TLSv1.2');
  assert.equal(transports[0].connectionTimeout, 10000);
  assert.deepEqual(transports[0].auth, {
    user: 'monitor@example.com',
    pass: 'smtp-secret'
  });
  assert.equal(messages[0].to, 'owner@example.com');
  assert.equal(messages[0].subject, 'Key 业务首字延迟提醒');
  assert.deepEqual(messages[0].from, {
    name: 'Sub2API Monitor',
    address: 'monitor@example.com'
  });
  assert.match(messages[0].text, /Key #88 平均首字过高/);
  assert.match(messages[0].text, /触发时间：2026-09-29 22:35:00（北京时间）/);
  assert.match(messages[0].html, /触发时间：<\/strong>2026-09-29 22:35:00（北京时间）/);
  assert.doesNotMatch(messages[0].text, /2026-09-29T14:35:00\.031Z/);
});
