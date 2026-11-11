const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { createTestContext } = require('./helpers');
const { createDatabase } = require('../src/db');
const { createApplication } = require('../src/server');
const { ProviderRepository } = require('../src/repositories/provider-repository');
const { TransferService } = require('../src/services/transfer-service');
const { NotificationService } = require('../src/services/notification-service');
const { validateBarkLevelSchedule, resolveBarkLevel } = require('../src/services/bark-level-schedule');

function nightSchedule(overrides = {}) {
  return {
    enabled: true,
    timezone: 'Asia/Shanghai',
    periods: [{ start: '22:00', end: '08:00', level: 'critical' }],
    ...overrides
  };
}

test('Bark switches day and overnight levels at exact local boundaries including midnight', () => {
  const config = { level: 'active', levelSchedule: nightSchedule() };
  validateBarkLevelSchedule(config.levelSchedule);
  for (const [instant, expected] of [
    ['2026-11-11T13:59:59.999Z', 'active'],
    ['2026-11-11T14:00:00.000Z', 'critical'],
    ['2026-11-11T15:59:59.999Z', 'critical'],
    ['2026-11-11T16:00:00.000Z', 'critical'],
    ['2026-11-11T23:59:59.999Z', 'critical'],
    ['2026-11-12T00:00:00.000Z', 'active'],
    ['2026-11-12T04:00:00.000Z', 'active']
  ]) assert.equal(resolveBarkLevel(config, new Date(instant)), expected, instant);

  const midnightEnd = { levelSchedule: nightSchedule({
    periods: [{ start: '22:00', end: '00:00', level: 'passive' }]
  }) };
  validateBarkLevelSchedule(midnightEnd.levelSchedule);
  assert.equal(resolveBarkLevel(midnightEnd, new Date('2026-11-11T15:59:59Z')), 'passive');
  assert.equal(resolveBarkLevel(midnightEnd, new Date('2026-11-11T16:00:00Z')), 'active');
});

test('adjacent periods cover a whole day and gaps use the original default level', () => {
  const config = { level: 'passive', levelSchedule: nightSchedule({ periods: [
    { start: '22:00', end: '08:00', level: 'critical' },
    { start: '08:00', end: '12:00', level: 'active' },
    { start: '12:00', end: '22:00', level: 'timeSensitive' }
  ] }) };
  validateBarkLevelSchedule(config.levelSchedule);
  assert.equal(resolveBarkLevel(config, new Date('2026-11-12T00:00:00Z')), 'active');
  assert.equal(resolveBarkLevel(config, new Date('2026-11-12T04:00:00Z')), 'timeSensitive');
  assert.equal(resolveBarkLevel(config, new Date('2026-11-12T14:00:00Z')), 'critical');
  config.levelSchedule.periods.pop();
  assert.equal(resolveBarkLevel(config, new Date('2026-11-12T04:00:00Z')), 'passive');
  config.levelSchedule.enabled = false;
  assert.equal(resolveBarkLevel(config, new Date('2026-11-12T14:00:00Z')), 'passive');
  assert.equal(resolveBarkLevel({}, new Date('2026-11-12T14:00:00Z')), 'active');
});

test('schedule timezone is independent of host timezone and follows DST clock changes', () => {
  const instant = new Date('2026-11-11T16:00:00Z');
  assert.equal(resolveBarkLevel({ levelSchedule: nightSchedule() }, instant), 'critical');
  assert.equal(resolveBarkLevel({ levelSchedule: nightSchedule({ timezone: 'UTC' }) }, instant), 'active');
  const config = { level: 'active', levelSchedule: nightSchedule({
    timezone: 'America/New_York',
    periods: [{ start: '01:00', end: '02:00', level: 'timeSensitive' }]
  }) };
  validateBarkLevelSchedule(config.levelSchedule);
  for (const instant of ['2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z']) {
    assert.equal(resolveBarkLevel(config, new Date(instant)), 'timeSensitive');
  }
  assert.equal(resolveBarkLevel(config, new Date('2026-11-01T07:00:00Z')), 'active');
  config.levelSchedule.periods = [{ start: '02:00', end: '03:00', level: 'critical' }];
  assert.equal(resolveBarkLevel(config, new Date('2026-03-08T06:59:59Z')), 'active');
  assert.equal(resolveBarkLevel(config, new Date('2026-03-08T07:00:00Z')), 'active');
});

test('invalid schedules are rejected atomically without changing saved configuration or credentials', (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const notifications = new NotificationService(context);
  const saved = notifications.save({ name: 'iPhone', type: 'bark',
    config: { level: 'active', levelSchedule: nightSchedule() },
    credentials: { deviceKey: 'original-test-device-key' } });
  const before = context.db.prepare('SELECT * FROM notification_channels WHERE id = ?').get(saved.id);
  const credentialsBefore = context.db.prepare('SELECT * FROM encrypted_credentials WHERE id = ?').get(before.credential_id);
  const period = { start: '08:00', end: '22:00', level: 'active' };
  const cases = [
    [], true, { enabled: 'true' }, nightSchedule({ timezone: '' }),
    nightSchedule({ timezone: 'invalid/timezone' }), nightSchedule({ timezone: 8 }),
    nightSchedule({ timezone: 'x'.repeat(81) }), nightSchedule({ periods: null }),
    nightSchedule({ periods: [] }), nightSchedule({ periods: Array(25).fill(period) }),
    ...['8:00', '24:00', '12:60', '08:00:01', '', 800].map((start) =>
      nightSchedule({ periods: [{ ...period, start }] })),
    nightSchedule({ periods: [null] }), nightSchedule({ periods: [{ ...period, end: '25:00' }] }),
    nightSchedule({ periods: [{ ...period, end: '08:00' }] }),
    nightSchedule({ periods: [{ ...period, level: 'urgent' }] }),
    nightSchedule({ periods: [...nightSchedule().periods, { ...period, end: '22:01' }] }),
    nightSchedule({ periods: [...nightSchedule().periods, { start: '00:00', end: '01:00', level: 'active' }] }),
    nightSchedule({ periods: [...nightSchedule().periods, { start: '23:00', end: '07:00', level: 'active' }] }),
    nightSchedule({ periods: [period, { ...period }] })
  ];
  for (const schedule of cases) {
    assert.throws(() => notifications.save({
      config: { level: 'critical', levelSchedule: schedule },
      credentials: { deviceKey: 'must-not-overwrite-existing-key' }
    }, saved.id), { code: 'NOTIFICATION_CONFIG_INVALID', status: 400 }, JSON.stringify(schedule));
    assert.deepEqual(context.db.prepare('SELECT * FROM notification_channels WHERE id = ?').get(saved.id), before);
    assert.deepEqual(context.db.prepare('SELECT * FROM encrypted_credentials WHERE id = ?').get(before.credential_id), credentialsBefore);
  }
});

test('legacy channels, disabled schedules and saved schedules survive a SQLite restart and export', (t) => {
  const context = createTestContext();
  let reopened;
  t.after(() => { if (reopened?.open) reopened.close(); context.cleanup(); });
  const notifications = new NotificationService(context);
  const legacy = notifications.save({ name: 'Legacy', type: 'bark',
    config: { level: 'timeSensitive' }, credentials: { deviceKey: 'legacy-test-key' } });
  const scheduled = notifications.save({ name: 'Scheduled', type: 'bark',
    config: { level: 'active', levelSchedule: nightSchedule() },
    credentials: { deviceKey: 'scheduled-test-key' } });
  notifications.save({ name: 'Renamed' }, scheduled.id);
  notifications.save({ config: { ...scheduled.config, levelSchedule: nightSchedule({ enabled: false }) } }, scheduled.id);
  context.db.close();
  reopened = createDatabase(context.config.databasePath);
  const restarted = new NotificationService({ db: reopened, config: context.config });
  const channels = restarted.listChannels();
  assert.deepEqual(channels.find((channel) => channel.id === legacy.id).config, legacy.config);
  const disabled = channels.find((channel) => channel.id === scheduled.id);
  assert.equal(disabled.name, 'Renamed');
  assert.deepEqual(disabled.config.levelSchedule, nightSchedule({ enabled: false }));
  assert.doesNotMatch(JSON.stringify(channels), /legacy-test-key|scheduled-test-key/);
  const transfers = new TransferService({ db: reopened, config: context.config,
    providers: new ProviderRepository(reopened, context.config) });
  const exported = transfers.exportConfiguration();
  assert.deepEqual(exported.notificationChannels.find((channel) => channel.id === scheduled.id).config, disabled.config);
});

test('manual tests, recharge tests and actual dispatch choose the send time level and retain Bark options', async (t) => {
  const context = createTestContext();
  const requests = [];
  const receiver = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ code: 200 }));
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => receiver.close(resolve)); context.cleanup(); });
  let now = new Date('2026-11-11T04:00:00Z');
  const notifications = new NotificationService({ ...context, now: () => now });
  const channel = notifications.save({ name: 'Scheduled', type: 'bark', config: {
    endpoint: `http://127.0.0.1:${receiver.address().port}/push`,
    level: 'active', levelSchedule: nightSchedule(), call: true, sound: 'alarm', group: 'Suppliers'
  }, credentials: { deviceKey: 'test-only-device-key' } });
  await notifications.test(channel.id);
  assert.equal(requests.at(-1).level, 'active');
  const event = { id: crypto.randomUUID(), severity: 'warning', message: 'Supplier balance is low',
    triggered_at: '2026-11-11T04:00:00Z', details: { rechargeUrl: 'https://supplier.example/recharge' } };
  now = new Date('2026-11-11T14:00:00Z');
  await notifications.testRechargeAlert(channel.id, event);
  assert.equal(requests.at(-1).level, 'critical');
  assert.equal(requests.at(-1).url, event.details.rechargeUrl);
  context.db.prepare(`INSERT INTO alert_events(id, status, severity, message, fingerprint, triggered_at)
    VALUES (?, 'active', ?, ?, ?, ?)`).run(event.id, event.severity, event.message, event.id, event.triggered_at);
  assert.equal((await notifications.dispatch(event, { channelIds: [channel.id] }))[0].status, 'fulfilled');
  assert.equal(requests.at(-1).level, 'critical');
  assert.equal(requests.at(-1).sound, 'alarm');
  assert.equal(requests.at(-1).call, 1);
  assert.equal(requests.at(-1).group, 'Suppliers');
  assert.equal(requests.at(-1).device_key, 'test-only-device-key');
  assert.equal(context.db.prepare("SELECT COUNT(*) AS count FROM notification_deliveries WHERE status = 'delivered'").get().count, 1);
  now = new Date('2026-11-12T00:00:00Z');
  await notifications.test(channel.id);
  assert.equal(requests.at(-1).level, 'active');
  notifications.save({ config: { ...channel.config, levelSchedule: nightSchedule({ enabled: false }) } }, channel.id);
  now = new Date('2026-11-12T14:00:00Z');
  await notifications.test(channel.id);
  assert.equal(requests.at(-1).level, 'active');
});

test('notification channel HTTP API protects schedules and rejects invalid updates', async (t) => {
  const context = createTestContext();
  const app = createApplication({ ...context, startBackground: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await app.locals.close(); context.cleanup();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const input = { name: 'HTTP iPhone', type: 'bark', config: { level: 'active', levelSchedule: nightSchedule() },
    credentials: { deviceKey: 'http-test-device-key' } };
  const send = (url, method, body, headers = {}) => fetch(`${base}${url}`, {
    method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body)
  });
  assert.equal((await send('/api/notification-channels', 'POST', input)).status, 401);
  const login = await send('/api/auth/login', 'POST', { username: 'admin', password: 'test-password' });
  const session = await login.json();
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await send('/api/notification-channels', 'POST', input, { Cookie: cookie })).status, 403);
  const headers = { Cookie: cookie, 'X-CSRF-Token': session.csrfToken };
  const created = await send('/api/notification-channels', 'POST', input, headers);
  assert.equal(created.status, 201);
  const channel = await created.json();
  assert.deepEqual(channel.config.levelSchedule, nightSchedule());
  assert.doesNotMatch(JSON.stringify(channel), /http-test-device-key/);
  const invalid = await send(`/api/notification-channels/${channel.id}`, 'PUT', {
    config: { ...channel.config, levelSchedule: nightSchedule({ periods: [
      ...nightSchedule().periods, { start: '07:00', end: '22:00', level: 'active' }
    ] }) }
  }, headers);
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'NOTIFICATION_CONFIG_INVALID');
  assert.equal((await send(`/api/notification-channels/${channel.id}`, 'PUT', { name: 'Renamed' }, headers)).status, 200);
  const listed = await fetch(`${base}/api/notification-channels`, { headers: { Cookie: cookie } });
  const saved = (await listed.json()).items.find((item) => item.id === channel.id);
  assert.deepEqual(saved.config, channel.config);
  assert.equal(saved.name, 'Renamed');
  const cleared = await send(`/api/notification-channels/${channel.id}`, 'PUT', { config: { level: 'timeSensitive' } }, headers);
  assert.equal(cleared.status, 200);
  assert.deepEqual((await cleared.json()).config, { level: 'timeSensitive' });
});

test('a delivery retry crossing a time boundary uses the current period and preserves delivery history', async (t) => {
  const context = createTestContext();
  const requests = [];
  let now = new Date('2026-11-11T13:59:59Z');
  const receiver = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    now = new Date('2026-11-11T14:00:00Z');
    response.writeHead(requests.length === 1 ? 503 : 200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ code: requests.length === 1 ? 503 : 200 }));
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => receiver.close(resolve)); context.cleanup(); });
  const notifications = new NotificationService({ ...context, now: () => now });
  const channel = notifications.save({ name: 'Retry', type: 'bark', config: {
    endpoint: `http://127.0.0.1:${receiver.address().port}/push`,
    level: 'active', levelSchedule: nightSchedule()
  }, credentials: { deviceKey: 'retry-test-device-key' } });
  const event = { id: crypto.randomUUID(), severity: 'warning', message: 'Low balance',
    triggered_at: '2026-11-11T13:59:00Z', details: {} };
  context.db.prepare(`INSERT INTO alert_events(id, status, severity, message, fingerprint, triggered_at)
    VALUES (?, 'active', ?, ?, ?, ?)`).run(event.id, event.severity, event.message, event.id, event.triggered_at);
  assert.equal((await notifications.dispatch(event))[0].status, 'fulfilled');
  assert.deepEqual(requests.map((request) => request.level), ['active', 'critical']);
  assert.deepEqual(context.db.prepare('SELECT attempt, status FROM notification_deliveries ORDER BY attempt').all(), [
    { attempt: 1, status: 'failed' }, { attempt: 2, status: 'delivered' }
  ]);
});

test('a non-iOS channel retains its own payload even if its JSON contains a schedule', async (t) => {
  const context = createTestContext();
  const requests = [];
  const receiver = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    response.writeHead(200); response.end();
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => receiver.close(resolve)); context.cleanup(); });
  const notifications = new NotificationService(context);
  const channel = notifications.save({ name: 'Webhook', type: 'webhook', config: {
    url: `http://127.0.0.1:${receiver.address().port}/hook`, levelSchedule: nightSchedule()
  } });
  await notifications.test(channel.id);
  assert.equal(requests[0].event, 'provider_monitor.alert');
  assert.equal(requests[0].severity, 'info');
  assert.equal(requests[0].level, undefined);
  assert.equal(requests[0].levelSchedule, undefined);
});
