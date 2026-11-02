const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');
const { ProviderRepository } = require('../src/repositories/provider-repository');
const { BalanceMonitorService } = require('../src/services/balance-monitor-service');
const { SyncService } = require('../src/services/sync-service');
const { AlertService } = require('../src/services/alert-service');
const { QueryService } = require('../src/services/query-service');
const { JobQueue } = require('../src/services/job-queue');
const { createAdapter } = require('../src/adapters/registry');
const { AppError } = require('../src/errors');
const { TransferService } = require('../src/services/transfer-service');
const { createApplication } = require('../src/server');

function fixture(t, requestJson, env = {}, onCompleted) {
  const context = createTestContext(env);
  const providers = new ProviderRepository(context.db, context.config);
  const queries = new QueryService(context.db, context.config);
  const delivered = [];
  const alerts = new AlertService({ ...context, queries,
    notifications: { dispatch: async (event) => delivered.push(event) } });
  const balances = new BalanceMonitorService({ ...context, providers, http: { requestJson },
    onCompleted: onCompleted || (({ connectionId }) => alerts.evaluateConnection(connectionId, { balancesOnly: true })) });
  t.after(async () => { await balances.stop(); context.cleanup(); });
  const create = (input = {}) => providers.create({
    name: 'Balance supplier', adapterType: 'custom', baseUrl: 'https://balance.example',
    credentials: { apiKey: 'private-test-key' }, warningThreshold: 100, secondaryWarningThreshold: 20,
    thresholdCurrency: 'USD', typeConfig: { requests: {
      accountBalance: { path: '/balance', availableJsonPath: '$.balance' }
    } }, ...input
  });
  return { ...context, providers, queries, balances, delivered, create };
}

test('balance checks publish and alert without inventory, logs, or a successful full sync', async (t) => {
  let amount = 90;
  const calls = [];
  const context = fixture(t, async (url, options) => {
    calls.push(new URL(url).pathname);
    assert.equal(options.retries, 0);
    assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 15000);
    return { data: { balance: amount } };
  });
  const provider = context.create();
  await context.balances.run(provider.id);
  assert.deepEqual(calls, ['/balance']);
  assert.equal(context.delivered.length, 1);
  assert.equal(context.delivered[0].details.alertLevel, 1);
  assert.equal(context.queries.summary().accounts[0].status, 'warning');
  assert.equal(context.providers.get(provider.id).last_success_at, null);
  assert.ok(context.providers.get(provider.id).last_balance_success_at);
  for (const table of ['remote_keys', 'remote_groups', 'provider_cost_ledger', 'usage_snapshots', 'jobs']) {
    assert.equal(context.db.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count, 0);
  }
  amount = 50;
  await context.balances.run(provider.id);
  assert.equal(context.delivered.length, 1);
  amount = 5;
  await context.balances.run(provider.id);
  assert.equal(context.delivered.length, 2);
  assert.equal(context.delivered[1].details.alertLevel, 2);
});

test('slow full inventory sync neither delays balance alerts nor overwrites newer balances', async (t) => {
  let amount = 90;
  let releaseGroups;
  let groupsStarted;
  const gate = new Promise((resolve) => { releaseGroups = resolve; });
  const reachedGroups = new Promise((resolve) => { groupsStarted = resolve; });
  const context = fixture(t, async (url) => {
    if (new URL(url).pathname === '/groups') {
      groupsStarted();
      await gate;
      return { data: [] };
    }
    return { data: { balance: amount } };
  });
  const provider = context.create({ typeConfig: { requests: {
    accountBalance: { path: '/balance', availableJsonPath: '$.balance' },
    groups: { path: '/groups', itemsJsonPath: '$[*]', idJsonPath: '$.id' }
  } } });
  const sync = new SyncService({ ...context, http: context.balances.http });
  const operation = sync.run(provider.id);
  try {
    await reachedGroups;
    assert.equal(context.delivered.length, 1);
    amount = 5;
    await context.balances.run(provider.id);
    assert.equal(context.delivered.length, 2);
    assert.equal(context.queries.summary().accounts[0].available, 5);
  } finally {
    releaseGroups();
    await operation;
  }
  assert.equal(context.queries.summary().accounts[0].available, 5);
  assert.equal(context.db.prepare("SELECT COUNT(*) count FROM balance_snapshots WHERE subject_type = 'account'").get().count, 2);
});

test('per-provider balance schedules have no jitter and ignore the full-sync schedule', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-02T03:00:00Z') });
  let calls = 0;
  const context = fixture(t, async () => { calls += 1; return { data: { balance: 200 } }; });
  const fast = context.create();
  const slow = context.create({ name: 'Slow supplier', baseUrl: 'https://slow.example', balanceRefreshIntervalMinutes: 3 });
  context.create({ name: 'Paused supplier', baseUrl: 'https://paused.example', enabled: false });
  context.db.prepare("UPDATE provider_connections SET next_check_at = '2099-01-01T00:00:00Z'").run();
  await Promise.all(context.balances.checkDue());
  assert.equal(calls, 2);
  assert.equal(context.providers.get(fast.id).next_balance_check_at, '2026-11-02T03:01:00.000Z');
  assert.equal(context.providers.get(slow.id).next_balance_check_at, '2026-11-02T03:03:00.000Z');
  t.mock.timers.tick(59000);
  assert.equal(context.balances.checkDue().length, 0);
  t.mock.timers.tick(1000);
  await Promise.all(context.balances.checkDue());
  assert.equal(calls, 3);
  context.providers.update(slow.id, { balanceRefreshIntervalMinutes: 2 });
  await Promise.all(context.balances.checkDue());
  assert.equal(calls, 4);
  assert.equal(context.providers.get(slow.id).next_balance_check_at, '2026-11-02T03:03:00.000Z');
  context.providers.update(fast.id, { enabled: false });
  context.providers.update(slow.id, { enabled: false });
  t.mock.timers.tick(600000);
  assert.equal(context.balances.checkDue().length, 0);
});

test('failures keep the last real balance, expose separate errors, and back off without retry storms', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-02T03:00:00Z') });
  let fail = false;
  const context = fixture(t, async () => {
    if (fail) throw new AppError('RATE_LIMITED', 'Try again later', { status: 429, retryable: true });
    return { data: { balance: 200 } };
  });
  const provider = context.create();
  await context.balances.run(provider.id);
  const successAt = context.providers.get(provider.id).last_balance_success_at;
  fail = true;
  t.mock.timers.tick(60000);
  await assert.rejects(context.balances.run(provider.id), { code: 'RATE_LIMITED' });
  const failed = context.providers.get(provider.id);
  assert.equal(failed.next_balance_check_at, '2026-11-02T03:06:00.000Z');
  assert.equal(failed.last_balance_success_at, successAt);
  assert.equal(failed.last_error_code, null);
  assert.equal(context.queries.summary().accounts[0].available, 200);
  assert.equal(context.queries.summary().accounts[0].status, 'error');
  assert.equal(context.balances.checkDue().length, 0);
  fail = false;
  await context.balances.run(provider.id, { manual: true });
  assert.equal(context.providers.get(provider.id).balance_failure_count, 0);
  assert.equal(context.queries.summary().accounts[0].status, 'healthy');
});

test('balance workers stay available while the asset job queue is occupied and deduplicate reads', async (t) => {
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const reached = new Promise((resolve) => { started = resolve; });
  let calls = 0;
  const context = fixture(t, async () => { calls += 1; return { data: { balance: 200 } }; });
  const provider = context.create();
  const queue = new JobQueue({ db: context.db, concurrency: 1 });
  queue.register('blocked_inventory', async () => { started(); await gate; });
  queue.enqueue('blocked_inventory', { connectionId: provider.id });
  queue.start();
  try {
    await reached;
    const first = context.balances.run(provider.id);
    assert.equal(context.balances.run(provider.id), first);
    await first;
    assert.equal(calls, 1);
    assert.equal(queue.active.size, 1);
  } finally {
    release();
    await queue.stop();
  }
});

test('concurrent provider sessions share one refresh and reuse the rotated pair', async (t) => {
  let refreshes = 0;
  const context = fixture(t, async (url, options) => {
    if (new URL(url).pathname === '/api/v1/auth/refresh') {
      refreshes += 1;
      assert.equal(options.body.refresh_token, 'old-refresh');
      return { data: { code: 0, data: { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 } } };
    }
    assert.equal(options.headers.Authorization, 'Bearer new-access');
    return { data: { code: 0, data: { id: 7, username: 'Supplier', balance: 200 } } };
  });
  const provider = context.create({ adapterType: 'sub2api', authMode: 'token_pair',
    credentials: { accessToken: `header.${Buffer.from('{"exp":1}').toString('base64url')}.signature`,
      refreshToken: 'old-refresh' } });
  const connection = context.providers.get(provider.id, { forAdapter: true });
  const adapters = [0, 1].map(() => createAdapter('sub2api', context.providers.adapterContext(connection, context.balances.http)));
  await Promise.all([context.balances.run(provider.id), ...adapters.map((adapter) => adapter.getAccessToken())]);
  assert.equal(refreshes, 1);
  assert.equal(context.providers.getCredentials(provider.id).refreshToken, 'new-refresh');
  const stale = createAdapter('sub2api', context.providers.adapterContext(connection, context.balances.http));
  stale.credentials = { accessToken: 'expired-access', refreshToken: 'old-refresh' };
  assert.equal(await stale.getAccessToken(true), 'new-access');
  assert.equal(refreshes, 1);
});

test('editing credentials during an in-flight balance read cannot publish an old account snapshot', async (t) => {
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const reached = new Promise((resolve) => { started = resolve; });
  const context = fixture(t, async () => { started(); await gate; return { data: { balance: 1 } }; });
  const provider = context.create();
  const operation = context.balances.run(provider.id);
  await reached;
  context.providers.update(provider.id, { credentials: { apiKey: 'replacement-test-key' } });
  release();
  await assert.rejects(operation, { code: 'CONFIG_CHANGED' });
  assert.equal(context.db.prepare('SELECT COUNT(*) count FROM balance_snapshots').get().count, 0);
  assert.equal(context.providers.get(provider.id).balance_error_code, null);
  assert.equal(context.delivered.length, 0);
});

test('an existing adapter cannot silently switch to manually replaced account credentials', async (t) => {
  const context = fixture(t, async () => { throw new Error('No upstream request expected'); });
  const provider = context.create({ adapterType: 'sub2api', authMode: 'token_pair',
    credentials: { accessToken: 'first-account-token', refreshToken: 'first-refresh' } });
  const connection = context.providers.get(provider.id, { forAdapter: true });
  const adapter = createAdapter('sub2api', context.providers.adapterContext(connection, context.balances.http));
  assert.equal(await adapter.getAccessToken(), 'first-account-token');
  context.providers.updateCredentials(provider.id, { accessToken: 'other-account-token', refreshToken: 'other-refresh' });
  await assert.rejects(adapter.getAccessToken(), { code: 'CONFIG_CHANGED' });
  const replacement = createAdapter('sub2api', context.providers.adapterContext(connection, context.balances.http));
  assert.equal(await replacement.getAccessToken(), 'other-account-token');
});

test('notification failures preserve the fresh balance and remain visible in the check history', async (t) => {
  const context = fixture(t, async () => ({ data: { balance: 200 } }), {}, async () => { throw new Error('alert failed'); });
  const provider = context.create();
  await context.balances.run(provider.id);
  assert.equal(context.queries.summary().accounts[0].available, 200);
  assert.equal(context.queries.summary().accounts[0].status, 'healthy');
  assert.equal(context.db.prepare("SELECT error_code FROM check_runs WHERE job_type = 'balance_check'").get().error_code,
    'BALANCE_ALERT_FAILED');
});

test('balance intervals survive exports and imports and reject invalid values', (t) => {
  const context = fixture(t, async () => ({ data: { balance: 200 } }));
  const provider = context.create({ balanceRefreshIntervalMinutes: 4, refreshIntervalMinutes: 45 });
  const transfers = new TransferService({ ...context, providers: context.providers });
  const exported = transfers.exportConfiguration();
  assert.equal(exported.providers[0].balanceRefreshIntervalMinutes, 4);
  assert.equal(exported.providers[0].refreshIntervalMinutes, 45);
  for (const interval of [0, -1, 1.5, 1441, NaN]) {
    assert.throws(() => context.providers.update(provider.id, { balanceRefreshIntervalMinutes: interval }),
      { code: 'PROVIDER_INTERVAL_INVALID' });
  }
  const imported = transfers.previewImport({ format: 'provider-monitor', content: exported });
  assert.equal(imported.invalid, 0);
  assert.equal(imported.items[0].provider.balanceRefreshIntervalMinutes, 4);
  delete exported.providers[0].balanceRefreshIntervalMinutes;
  transfers.applyImport({ format: 'provider-monitor', content: exported });
  assert.equal(context.providers.get(provider.id).balance_refresh_interval_minutes, 4);
});

test('minute-level history limits retain the newest balance for forecasts', (t) => {
  const context = fixture(t, async () => ({ data: { balance: 200 } }));
  const provider = context.create();
  const now = Date.now();
  const insert = context.db.prepare(`INSERT INTO balance_snapshots(
    connection_id, subject_type, subject_id, currency, available, captured_at
  ) VALUES (?, 'account', ?, 'USD', ?, ?)`);
  context.db.transaction(() => {
    for (let index = 0; index < 20005; index += 1) {
      insert.run(provider.id, provider.id, 25000 - index, new Date(now - (20004 - index) * 60000).toISOString());
    }
  })();
  const rows = context.queries.history({ connectionId: provider.id, currency: 'USD', days: 30 });
  assert.equal(rows.length, 20000);
  assert.equal(rows.at(-1).captured_at, new Date(now).toISOString());
  assert.equal(context.queries.forecast(provider.id, 'USD', 30).currentAvailable, 4996);
});

test('the authenticated balance refresh API bypasses pending inventory work and requires CSRF', async (t) => {
  const context = createTestContext();
  const calls = [];
  const app = createApplication({ ...context, http: { requestJson: async (url) => {
    calls.push(new URL(url).pathname);
    return { data: { balance: 30 } };
  } } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await app.locals.close();
    context.cleanup();
  });
  const provider = app.locals.services.providers.create({ name: 'HTTP balance supplier', adapterType: 'custom',
    baseUrl: 'https://http-balance.example', credentials: { apiKey: 'private-key' },
    typeConfig: { requests: { accountBalance: { path: '/balance', availableJsonPath: '$.balance' } } } });
  app.locals.services.queue.enqueue('provider_sync', { connectionId: provider.id });
  const base = `http://127.0.0.1:${server.address().port}`;
  const url = `${base}/api/providers/${provider.id}/balance/refresh`;
  assert.equal((await fetch(url, { method: 'POST' })).status, 401);
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-password' }) });
  const session = await login.json();
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(url, { method: 'POST', headers: { Cookie: cookie } })).status, 403);
  const response = await fetch(url, { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': session.csrfToken } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'succeeded');
  assert.ok(body.capturedAt);
  assert.doesNotMatch(JSON.stringify(body), /private-key/);
  assert.deepEqual(calls, ['/balance']);
  assert.equal(app.locals.services.providers.get(provider.id).last_success_at, null);
  assert.equal(app.locals.services.queries.summary().accounts[0].available, 30);
  assert.equal(app.locals.services.queue.list()[0].status, 'pending');
});
