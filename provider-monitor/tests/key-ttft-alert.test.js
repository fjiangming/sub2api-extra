const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createTestContext } = require('./helpers');
const { createApplication } = require('../src/server');
const { NotificationService } = require('../src/services/notification-service');
const {
  KeyTtftAlertService,
  SAMPLE_SOURCE
} = require('../src/services/key-ttft-alert-service');

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

function insertActiveProbeSample(db, accountId, firstTokenMs, at) {
  db.prepare(`
    INSERT INTO sub2api_key_probe_batches(
      id, run_id, account_id, trigger_type, complexity, sample_count,
      succeeded_count, failed_count, status, avg_first_token_ms,
      started_at, completed_at
    ) VALUES (?, 'probe-run', ?, 'scheduled', 'simple', 1, 1, 0,
      'critical', ?, ?, ?)
  `).run(`probe-batch-${accountId}`, String(accountId), firstTokenMs, at, at);
  db.prepare(`
    INSERT INTO sub2api_key_probe_samples(
      id, batch_id, sample_index, prompt, status, duration_ms,
      first_token_ms, started_at, completed_at
    ) VALUES (?, ?, 0, 'probe prompt', 'succeeded', ?, ?, ?, ?)
  `).run(
    `probe-sample-${accountId}`,
    `probe-batch-${accountId}`,
    firstTokenMs + 1000,
    firstTokenMs,
    at,
    at
  );
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
  assert.equal((await service.evaluate({ at: now + 11 * 60000 })).renotified, 1);
  assert.equal(notifications.deliveries.length, 2);

  insertBusinessSamples(
    context.db,
    'cooldown-key',
    [200, 300, 400],
    now + 12 * 60000,
    'recovered'
  );
  const recovered = await service.evaluate({ at: now + 13 * 60000 });
  assert.equal(recovered.matchedKeys, 0);
  assert.equal(recovered.resolved, 1);
  assert.equal(
    context.db.prepare('SELECT status FROM alert_events').get().status,
    'resolved'
  );
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

test('business TTFT alert HTTP API saves channels and supports immediate evaluation', async (t) => {
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
  assert.equal(configBody.settings.windowMinutes, 8);
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
  const triggeredAt = new Date().toISOString();
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
  assert.match(messages[0].html, /触发时间/);
});
