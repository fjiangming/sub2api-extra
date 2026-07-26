const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createTestContext } = require('./helpers');
const { ProviderRepository } = require('../src/repositories/provider-repository');
const { QueryService } = require('../src/services/query-service');
const { AlertService, localizeLegacyAlertMessage } = require('../src/services/alert-service');
const { NotificationService } = require('../src/services/notification-service');
const { AutomationService } = require('../src/services/automation-service');

function insertSnapshot(db, connectionId, available, capturedAt = new Date().toISOString()) {
  db.prepare(`
    INSERT INTO balance_snapshots(
      connection_id, subject_type, subject_id, currency, available, unlimited,
      raw_json, captured_at
    ) VALUES (?, 'account', ?, 'USD', ?, 0, '{}', ?)
  `).run(connectionId, connectionId, available, capturedAt);
}

function insertKeySnapshot(db, connectionId, keyId, available, capturedAt = new Date().toISOString()) {
  db.prepare(`
    INSERT INTO balance_snapshots(
      connection_id, subject_type, subject_id, currency, available, unlimited,
      raw_json, captured_at
    ) VALUES (?, 'key', ?, 'USD', ?, 0, '{}', ?)
  `).run(connectionId, keyId, available, capturedAt);
}

test('legacy English alert messages are returned in Chinese', () => {
  assert.equal(
    localizeLegacyAlertMessage('hubway balance is 92.52 USD, at or below 100 USD.'),
    'hubway 余额为 92.52 USD，已低于或等于预警值 100 USD。'
  );
  assert.equal(
    localizeLegacyAlertMessage('a6api mapped group default has rate status rate_mismatch (-15.06%).'),
    'a6api 映射分组“default”的倍率状态为综合倍率偏差（偏差 -15.06%）。'
  );
  assert.equal(
    localizeLegacyAlertMessage('aijws sync failed: token expired.'),
    'aijws 同步失败：token expired。'
  );
});

test('alert remains acknowledged while matched and resolves after balance recovery', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'Budget API', adapterType: 'custom', baseUrl: 'https://example.com',
    authMode: 'api_key', credentials: { apiKey: 'secret' }
  });
  insertSnapshot(context.db, provider.id, 3);
  const deliveries = [];
  const alerts = new AlertService({
    db: context.db,
    config: context.config,
    queries: new QueryService(context.db, context.config),
    notifications: { dispatch: async (event) => deliveries.push(event.id) }
  });
  const rule = alerts.saveRule({
    name: 'Low balance', ruleType: 'low_balance', connectionId: provider.id,
    currency: 'USD', threshold: 5, consecutiveMatches: 1, cooldownMinutes: 60, enabled: true
  });
  await alerts.evaluateConnection(provider.id);
  let event = alerts.listEvents('active')[0];
  assert.ok(event);
  assert.equal(event.message, 'Budget API 余额为 3.00 USD，已低于或等于预警值 5 USD。');
  assert.equal(deliveries.length, 1);
  alerts.acknowledge(event.id);
  await alerts.evaluateConnection(provider.id);
  event = alerts.listEvents().find((item) => item.id === event.id);
  assert.equal(event.status, 'acknowledged');
  assert.equal(deliveries.length, 1);
  insertSnapshot(context.db, provider.id, 10, new Date(Date.now() + 1000).toISOString());
  await alerts.evaluateConnection(provider.id);
  event = alerts.listEvents().find((item) => item.rule_id === rule.id);
  assert.equal(event.status, 'resolved');
  insertSnapshot(context.db, provider.id, 2, new Date(Date.now() + 2000).toISOString());
  await alerts.evaluateConnection(provider.id);
  event = alerts.listEvents().find((item) => item.rule_id === rule.id);
  assert.equal(event.status, 'active');
  assert.equal(event.acknowledged_at, null);
});

test('provider balance thresholds create and recover independent built-in alerts', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'Tiered Budget API', adapterType: 'custom', baseUrl: 'https://tiered.example.com',
    authMode: 'api_key', credentials: { apiKey: 'secret' },
    warningThreshold: 10, secondaryWarningThreshold: 3, thresholdCurrency: 'USD'
  });
  const delivered = [];
  const queries = new QueryService(context.db, context.config);
  const alerts = new AlertService({
    db: context.db,
    config: context.config,
    queries,
    notifications: { dispatch: async (event) => delivered.push(event) }
  });
  const capturedAt = Date.now();
  context.db.prepare('UPDATE provider_connections SET last_success_at = ? WHERE id = ?')
    .run(new Date(capturedAt).toISOString(), provider.id);

  insertSnapshot(context.db, provider.id, 8, new Date(capturedAt).toISOString());
  await alerts.evaluateConnection(provider.id);
  let events = alerts.listEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].details.alertLevel, 1);
  assert.equal(events[0].severity, 'warning');
  assert.equal(events[0].rule_id, null);
  assert.match(events[0].message, /触发1级余额告警/);
  assert.equal(queries.summary().accounts.find((account) => account.connectionId === provider.id).status, 'warning');

  insertSnapshot(context.db, provider.id, 2, new Date(capturedAt + 1000).toISOString());
  await alerts.evaluateConnection(provider.id);
  events = alerts.listEvents();
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.details.alertLevel).sort(), [1, 2]);
  assert.equal(events.find((event) => event.details.alertLevel === 2).severity, 'error');
  assert.match(events.find((event) => event.details.alertLevel === 2).message, /触发2级余额告警/);
  assert.equal(delivered.length, 2);
  assert.equal(queries.summary().accounts.find((account) => account.connectionId === provider.id).status, 'error');

  insertSnapshot(context.db, provider.id, 5, new Date(capturedAt + 2000).toISOString());
  await alerts.evaluateConnection(provider.id);
  events = alerts.listEvents();
  assert.equal(events.find((event) => event.details.alertLevel === 1).status, 'active');
  assert.equal(events.find((event) => event.details.alertLevel === 2).status, 'resolved');
  assert.equal(delivered.length, 3);
  assert.equal(queries.summary().accounts.find((account) => account.connectionId === provider.id).status, 'warning');

  insertSnapshot(context.db, provider.id, 2, new Date(capturedAt + 3000).toISOString());
  await alerts.evaluateConnection(provider.id);
  assert.equal(alerts.listEvents().find((event) => event.details.alertLevel === 2).status, 'active');
  assert.equal(delivered.length, 4);
  providers.update(provider.id, { secondaryWarningThreshold: null });
  await alerts.evaluateConnection(provider.id);
  assert.equal(alerts.listEvents().find((event) => event.details.alertLevel === 2).status, 'resolved');
  assert.equal(delivered.length, 5);
});

test('low balance alert sends the configured recharge link to WeCom', async (t) => {
  const payloads = [];
  const receiver = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    payloads.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    response.writeHead(204).end();
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));

  const context = createTestContext();
  t.after(async () => {
    await new Promise((resolve) => receiver.close(resolve));
    context.cleanup();
  });
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'Recharge API', adapterType: 'custom', baseUrl: 'https://example.com',
    authMode: 'api_key', credentials: { apiKey: 'secret' },
    warningThreshold: 5, thresholdCurrency: 'USD',
    rechargeUrl: 'https://example.com/account/recharge'
  });
  insertSnapshot(context.db, provider.id, 3);
  const notifications = new NotificationService({ db: context.db, config: context.config });
  notifications.save({
    name: 'WeCom test', type: 'wecom', enabled: true,
    config: { url: `http://127.0.0.1:${receiver.address().port}` }
  });
  const alerts = new AlertService({
    db: context.db,
    config: context.config,
    queries: new QueryService(context.db, context.config),
    notifications
  });

  await alerts.evaluateConnection(provider.id);

  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].msgtype, 'markdown');
  assert.match(payloads[0].markdown.content, /\[立即充值\]\(https:\/\/example\.com\/account\/recharge\)/);
  const event = alerts.listEvents('active')[0];
  assert.equal(event.details.rechargeUrl, 'https://example.com/account/recharge');
  assert.equal(context.db.prepare("SELECT status FROM notification_deliveries LIMIT 1").get().status, 'delivered');
});

test('low balance alert sends the configured recharge link to personal WeChat through ServerChan', async (t) => {
  const requests = [];
  let responseCode = 0;
  const receiver = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      url: request.url,
      contentType: request.headers['content-type'],
      body: new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
    });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ code: responseCode, message: responseCode === 0 ? 'success' : 'rejected' }));
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));

  const context = createTestContext();
  t.after(async () => {
    await new Promise((resolve) => receiver.close(resolve));
    context.cleanup();
  });
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'Personal WeChat API', adapterType: 'custom', baseUrl: 'https://example.com',
    authMode: 'api_key', credentials: { apiKey: 'secret' },
    warningThreshold: 5, thresholdCurrency: 'USD',
    rechargeUrl: 'https://example.com/account/recharge'
  });
  insertSnapshot(context.db, provider.id, 3);
  const notifications = new NotificationService({ db: context.db, config: context.config });
  const channel = notifications.save({
    name: 'ServerChan test', type: 'serverchan', enabled: true,
    config: { baseUrl: `http://127.0.0.1:${receiver.address().port}/` },
    credentials: { sendKey: 'SCT_TEST_KEY' }
  });
  const alerts = new AlertService({
    db: context.db,
    config: context.config,
    queries: new QueryService(context.db, context.config),
    notifications
  });

  await alerts.evaluateConnection(provider.id);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/SCT_TEST_KEY.send');
  assert.match(requests[0].contentType, /^application\/x-www-form-urlencoded/);
  assert.match(requests[0].body.get('title'), /Provider Monitor WARNING/);
  assert.match(requests[0].body.get('desp'), /\[立即充值\]\(https:\/\/example\.com\/account\/recharge\)/);
  assert.equal(context.db.prepare("SELECT status FROM notification_deliveries LIMIT 1").get().status, 'delivered');
  responseCode = 1;
  await assert.rejects(notifications.test(channel.id), /Server酱 rejected the notification: rejected/);
});

test('automation defaults to dry run and deduplicates repeated account actions', async (t) => {
  const context = createTestContext({ PROVIDER_MONITOR_AUTOMATION_ENABLED: 'false' });
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'Low Provider', adapterType: 'custom', baseUrl: 'https://example.com',
    authMode: 'api_key', credentials: { apiKey: 'secret' }
  });
  insertSnapshot(context.db, provider.id, 1);
  const automation = new AutomationService({ db: context.db, config: context.config });
  automation.saveRule({
    name: 'Disable account', enabled: true, dryRun: false, triggerType: 'low_balance',
    connectionId: provider.id,
    config: { currency: 'USD', threshold: 2, accountIds: [7], action: 'disable_sub2api_account' }
  });
  const first = await automation.evaluateConnection(provider.id);
  const second = await automation.evaluateConnection(provider.id);
  assert.equal(first.length, 1);
  assert.equal(first[0].status, 'dry_run');
  assert.equal(first[0].after.accountId, 7);
  assert.equal(first[0].after.status, 'inactive');
  assert.equal(second.length, 0);
  assert.equal(automation.listActions().length, 1);
});

test('real account automation updates the Sub2API account and rollback restores its status', async (t) => {
  const context = createTestContext({ PROVIDER_MONITOR_AUTOMATION_ENABLED: 'true' });
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'Recovered Provider', adapterType: 'custom', baseUrl: 'https://recovered.example.com',
    authMode: 'api_key', credentials: { apiKey: 'secret' }
  });
  insertSnapshot(context.db, provider.id, 10);
  let account = { id: 17, name: 'Sub2API upstream', status: 'error' };
  const requests = [];
  const sub2api = {
    async data(endpoint, options = {}) {
      requests.push({ endpoint, method: options.method || 'GET', body: options.body || null });
      if (endpoint !== '/api/v1/admin/accounts/17') throw new Error(`Unexpected endpoint: ${endpoint}`);
      if (options.method === 'PUT') account = { ...account, status: options.body.status };
      return { ...account };
    }
  };
  const automation = new AutomationService({ db: context.db, config: context.config, sub2api });
  automation.saveRule({
    name: 'Enable account', enabled: true, dryRun: false, triggerType: 'balance_recovered',
    connectionId: provider.id,
    config: { currency: 'USD', threshold: 5, accountIds: [17], action: 'enable_sub2api_account' }
  });

  const [action] = await automation.evaluateConnection(provider.id);
  assert.equal(account.status, 'active');
  assert.deepEqual(requests.slice(0, 2), [
    { endpoint: '/api/v1/admin/accounts/17', method: 'GET', body: null },
    { endpoint: '/api/v1/admin/accounts/17', method: 'PUT', body: { status: 'active' } }
  ]);
  assert.equal(action.before.status, 'error');
  assert.equal(action.after.accountId, 17);

  await automation.rollback(action.id);
  assert.equal(account.status, 'error');
});

test('scheduled automation rebuilds all mappings once per configured interval', async (t) => {
  const context = createTestContext({ PROVIDER_MONITOR_AUTOMATION_ENABLED: 'true' });
  t.after(() => context.cleanup());
  const calls = [];
  const mappings = {
    async rebuildAutoMappings(options) {
      calls.push(options);
      return {
        summary: { deletedMappings: 3, createdMappings: 2, skipped: 1 }
      };
    }
  };
  const automation = new AutomationService({
    db: context.db,
    config: context.config,
    sub2api: {},
    mappings
  });
  const rule = automation.saveRule({
    name: 'Refresh mappings', enabled: true, dryRun: false, triggerType: 'scheduled',
    connectionId: null,
    config: {
      action: 'rebuild_sub2api_mappings',
      scheduleIntervalMinutes: 60,
      dailyMaximumActions: 24
    }
  });

  const first = await automation.evaluateScheduled();
  const second = await automation.evaluateScheduled();
  assert.equal(first.length, 1);
  assert.equal(first[0].status, 'succeeded');
  assert.deepEqual(first[0].before, { mappingCount: 0 });
  assert.deepEqual(first[0].after, {
    replaced: true,
    deletedMappings: 3,
    createdMappings: 2,
    skipped: 1
  });
  assert.deepEqual(calls, [{ preview: false }]);
  assert.equal(second.length, 0);

  context.db.prepare(`UPDATE automation_actions SET created_at = ? WHERE rule_id = ?`)
    .run(new Date(Date.now() - 61 * 60000).toISOString(), rule.id);
  assert.equal((await automation.evaluateScheduled()).length, 1);
  assert.equal(calls.length, 2);
});

test('scheduled mapping workflow disables each account whose refreshed composite-rate difference is below zero', async (t) => {
  const context = createTestContext({ PROVIDER_MONITOR_AUTOMATION_ENABLED: 'true' });
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'Rate Provider', adapterType: 'custom', baseUrl: 'https://rate.example.com',
    authMode: 'api_key', credentials: { apiKey: 'secret' }
  });
  const accountStates = new Map([
    [17, { id: 17, name: 'Negative account', status: 'active' }],
    [18, { id: 18, name: 'Positive account', status: 'active' }]
  ]);
  const requests = [];
  const sub2api = {
    async data(endpoint, options = {}) {
      const accountId = Number(endpoint.split('/').pop());
      requests.push({ endpoint, method: options.method || 'GET', body: options.body || null });
      const account = accountStates.get(accountId);
      if (!account) throw new Error(`Unexpected account: ${accountId}`);
      if (options.method === 'PUT') Object.assign(account, { status: options.body.status });
      return { ...account };
    }
  };
  const mappings = {
    async rebuildAutoMappings({ preview }) {
      assert.equal(preview, false);
      const now = new Date().toISOString();
      const insertMapping = context.db.prepare(`
        INSERT INTO sub2api_mappings(
          id, connection_id, account_id, group_id, role, enabled,
          models_json, config_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'primary', 1, '[]', '{}', ?, ?)
      `);
      const insertState = context.db.prepare(`
        INSERT INTO sub2api_mapping_states(
          mapping_id, status, difference_ratio, tolerance_ratio, details_json, checked_at
        ) VALUES (?, 'rate_mismatch', ?, 0.05, '{}', ?)
      `);
      context.db.transaction(() => {
        insertMapping.run('negative-a', provider.id, 17, 7, now, now);
        insertState.run('negative-a', -0.1, now);
        insertMapping.run('negative-b', provider.id, 17, 8, now, now);
        insertState.run('negative-b', -0.02, now);
        insertMapping.run('positive', provider.id, 18, 9, now, now);
        insertState.run('positive', 0.25, now);
      })();
      return { summary: { deletedMappings: 0, createdMappings: 3, skipped: 0 } };
    }
  };
  const dispatched = [];
  const automation = new AutomationService({
    db: context.db,
    config: context.config,
    sub2api,
    mappings,
    notifications: { dispatch: async (event) => dispatched.push(event) }
  });
  const rule = automation.saveRule({
    name: 'Disable negative composite accounts',
    enabled: true,
    dryRun: false,
    triggerType: 'scheduled',
    connectionId: null,
    config: {
      action: 'rebuild_sub2api_mappings',
      scheduleIntervalMinutes: 60,
      condition: { type: 'composite_rate_difference', operator: 'lt', threshold: 0 },
      onMatchAction: 'disable_sub2api_account',
      targetMode: 'matched_mapping_accounts',
      cooldownMinutes: 60,
      dailyMaximumActions: 10,
      contractPauseHours: 24,
      notifyOnAction: true
    }
  });

  const actions = await automation.evaluateScheduled();
  assert.deepEqual(actions.map((action) => action.actionType), [
    'rebuild_sub2api_mappings',
    'disable_sub2api_account'
  ]);
  assert.equal(accountStates.get(17).status, 'inactive');
  assert.equal(accountStates.get(18).status, 'active');
  assert.deepEqual(requests, [
    { endpoint: '/api/v1/admin/accounts/17', method: 'GET', body: null },
    { endpoint: '/api/v1/admin/accounts/17', method: 'PUT', body: { status: 'inactive' } }
  ]);
  const accountAction = automation.listActions().find((action) => action.action_type === 'disable_sub2api_account');
  assert.equal(accountAction.after.accountId, 17);
  assert.deepEqual(
    accountAction.after.workflowContext.condition.matchedMappings.map((mapping) => mapping.mappingId),
    ['negative-a', 'negative-b']
  );
  assert.equal(accountAction.after.workflowContext.condition.threshold, 0);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].id, null);
  assert.equal(dispatched[0].severity, 'warning');
  assert.equal(dispatched[0].connection_id, provider.id);
  assert.equal(
    dispatched[0].message,
    '自动化规则「Disable negative composite accounts」已触发：综合倍率偏差 < 0%（命中 2 个映射），已执行「停用 Sub2API 账号 #17（Negative account）」'
  );
  assert.equal(dispatched[0].details.source, 'automation_rule');
  assert.equal(dispatched[0].details.actionType, 'disable_sub2api_account');
  assert.equal(dispatched[0].details.condition.matchedMappings.length, 2);
  assert.equal((await automation.evaluateScheduled()).length, 0);
  assert.equal(dispatched.length, 1);
  assert.equal(automation.previewRule(rule.id)[0].conditionMatchedTargets, 1);
});

test('automation rules with notify-on-action alert through channels and survive dispatch failures', async (t) => {
  const context = createTestContext({ PROVIDER_MONITOR_AUTOMATION_ENABLED: 'false' });
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'Notify Provider', adapterType: 'custom', baseUrl: 'https://notify.example.com',
    authMode: 'api_key', credentials: { apiKey: 'secret' }
  });
  insertSnapshot(context.db, provider.id, 1);
  const dispatched = [];
  const automation = new AutomationService({
    db: context.db,
    config: context.config,
    notifications: {
      async dispatch(event) {
        dispatched.push(event);
        throw new Error('channel down');
      }
    }
  });
  automation.saveRule({
    name: 'Disable low balance account', enabled: true, dryRun: true, triggerType: 'low_balance',
    connectionId: provider.id,
    config: {
      currency: 'USD', threshold: 2, accountIds: [7],
      action: 'disable_sub2api_account', notifyOnAction: true
    }
  });
  const actions = await automation.evaluateConnection(provider.id);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].status, 'dry_run');
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].id, null);
  assert.equal(dispatched[0].severity, 'info');
  assert.equal(
    dispatched[0].message,
    '[演练] 自动化规则「Disable low balance account」已触发：低余额，计划执行「停用 Sub2API 账号 #7」'
  );
  assert.equal(dispatched[0].details.dryRun, true);
  assert.equal(dispatched[0].details.targetId, 7);
  assert.equal(automation.listActions()[0].status, 'dry_run');
  assert.equal((await automation.evaluateConnection(provider.id)).length, 0);
  assert.equal(dispatched.length, 1);
});

test('recharge webhook runs once per provider without a Sub2API channel ID', async (t) => {
  const deliveries = [];
  const relay = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    deliveries.push(JSON.parse(body));
    response.writeHead(204).end();
  });
  await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => relay.close(resolve)));

  const context = createTestContext({ PROVIDER_MONITOR_AUTOMATION_ENABLED: 'true' });
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'Recharge API', adapterType: 'custom', baseUrl: 'https://example.com',
    authMode: 'api_key', credentials: { apiKey: 'secret' }
  });
  insertSnapshot(context.db, provider.id, 1);
  const automation = new AutomationService({ db: context.db, config: context.config });
  const rule = automation.saveRule({
    name: 'Recharge account', enabled: true, dryRun: false, triggerType: 'low_balance',
    connectionId: provider.id,
    config: {
      currency: 'USD', threshold: 2, action: 'trigger_recharge_webhook',
      webhookUrl: `http://127.0.0.1:${relay.address().port}/recharge`
    }
  });

  const first = await automation.evaluateConnection(provider.id);
  const second = await automation.evaluateConnection(provider.id);

  assert.equal(first.length, 1);
  assert.equal(first[0].status, 'succeeded');
  assert.deepEqual(first[0].after, { delivered: true });
  assert.equal(second.length, 0);
  assert.deepEqual(deliveries, [{
    event: 'provider_monitor.recharge_required',
    connectionId: provider.id,
    ruleId: rule.id
  }]);
});

test('key balance alert requires the configured number of consecutive snapshots', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const provider = providers.create({
    name: 'Key Budget API', adapterType: 'custom', baseUrl: 'https://example.com',
    authMode: 'api_key', credentials: { apiKey: 'secret' }
  });
  context.db.prepare(`
    INSERT INTO remote_keys(
      id, connection_id, remote_id, name, masked_key, status, unlimited,
      quota_remaining, currency, metadata_json, first_seen_at, last_seen_at
    ) VALUES ('key-budget', ?, 'remote', 'Client', 'sk-...test', 'enabled', 0, 3, 'USD', '{}', ?, ?)
  `).run(provider.id, new Date().toISOString(), new Date().toISOString());
  const alerts = new AlertService({
    db: context.db, config: context.config, queries: new QueryService(context.db, context.config),
    notifications: { dispatch: async () => {} }
  });
  alerts.saveRule({
    name: 'Key low balance', ruleType: 'low_balance', scope: 'key', connectionId: provider.id,
    currency: 'USD', threshold: 5, consecutiveMatches: 2, cooldownMinutes: 60, enabled: true
  });
  insertKeySnapshot(context.db, provider.id, 'key-budget', 3);
  await alerts.evaluateConnection(provider.id);
  assert.equal(alerts.listEvents('active').length, 0);
  insertKeySnapshot(context.db, provider.id, 'key-budget', 2, new Date(Date.now() + 1000).toISOString());
  await alerts.evaluateConnection(provider.id);
  assert.equal(alerts.listEvents('active').length, 1);
});

test('real backup automation swaps mapping roles and rollback restores the original state', async (t) => {
  const context = createTestContext({ PROVIDER_MONITOR_AUTOMATION_ENABLED: 'true' });
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const primaryProvider = providers.create({ name: 'Primary', adapterType: 'custom', baseUrl: 'https://primary.example', credentials: { apiKey: 'one' }, accountDedupeKey: 'primary' });
  const backupProvider = providers.create({ name: 'Backup', adapterType: 'custom', baseUrl: 'https://backup.example', credentials: { apiKey: 'two' }, accountDedupeKey: 'backup' });
  const now = new Date().toISOString();
  const primaryId = '00000000-0000-4000-8000-000000000001';
  const backupId = '00000000-0000-4000-8000-000000000002';
  const insertMapping = context.db.prepare(`
    INSERT INTO sub2api_mappings(id, connection_id, channel_id, role, enabled, models_json, config_json, created_at, updated_at)
    VALUES (?, ?, 31, ?, ?, '[]', '{}', ?, ?)
  `);
  insertMapping.run(primaryId, primaryProvider.id, 'primary', 1, now, now);
  insertMapping.run(backupId, backupProvider.id, 'backup', 0, now, now);
  insertSnapshot(context.db, primaryProvider.id, 1);
  const automation = new AutomationService({ db: context.db, config: context.config, sub2api: {} });
  automation.saveRule({
    name: 'Switch backup', enabled: true, dryRun: false, triggerType: 'low_balance', connectionId: primaryProvider.id,
    config: { currency: 'USD', threshold: 2, channelIds: [31], action: 'switch_to_backup' }
  });
  const [action] = await automation.evaluateConnection(primaryProvider.id);
  let mappings = context.db.prepare('SELECT id, role, enabled FROM sub2api_mappings WHERE channel_id = 31 ORDER BY id').all();
  assert.deepEqual(mappings.map((row) => [row.id, row.role, row.enabled]), [[primaryId, 'backup', 0], [backupId, 'primary', 1]]);
  await automation.rollback(action.id);
  mappings = context.db.prepare('SELECT id, role, enabled FROM sub2api_mappings WHERE channel_id = 31 ORDER BY id').all();
  assert.deepEqual(mappings.map((row) => [row.id, row.role, row.enabled]), [[primaryId, 'primary', 1], [backupId, 'backup', 0]]);
});
