const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');
const { ProviderRepository } = require('../src/repositories/provider-repository');
const { QueryService } = require('../src/services/query-service');
const { AlertService } = require('../src/services/alert-service');
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

test('automation defaults to dry run and deduplicates repeated channel actions', async (t) => {
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
    name: 'Disable channel', enabled: true, dryRun: false, triggerType: 'low_balance',
    connectionId: provider.id,
    config: { currency: 'USD', threshold: 2, channelIds: [7], action: 'disable_sub2api_channel' }
  });
  const first = await automation.evaluateConnection(provider.id);
  const second = await automation.evaluateConnection(provider.id);
  assert.equal(first.length, 1);
  assert.equal(first[0].status, 'dry_run');
  assert.equal(second.length, 0);
  assert.equal(automation.listActions().length, 1);
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
