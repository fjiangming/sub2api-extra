const assert = require('node:assert/strict');
const test = require('node:test');
const { createTestContext } = require('./helpers');
const { createApplication } = require('../src/server');

const BUSINESS_TABLES = [
  'encrypted_credentials',
  'local_admin_credentials',
  'provider_connections',
  'remote_accounts',
  'remote_groups',
  'remote_keys',
  'remote_key_groups',
  'balance_snapshots',
  'usage_snapshots',
  'balance_aggregates',
  'usage_aggregates',
  'check_runs',
  'jobs',
  'alert_rules',
  'alert_events',
  'notification_channels',
  'notification_deliveries',
  'recharge_access_tickets',
  'automation_rules',
  'automation_actions',
  'audit_logs',
  'settings',
  'asset_change_events',
  'anomaly_events',
  'key_health_checks',
  'remote_models',
  'model_prices',
  'checkin_records',
  'sub2api_mappings',
  'reconciliation_runs',
  'credential_backups',
  'import_runs',
  'backup_targets',
  'backup_runs'
];

test('a newly initialized application contains no built-in business data', async () => {
  const context = createTestContext();
  const app = createApplication({ config: context.config, db: context.db, startBackground: false });

  try {
    for (const table of BUSINESS_TABLES) {
      const row = context.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
      assert.equal(row.count, 0, `${table} should be empty after initialization`);
    }
  } finally {
    await app.locals.close();
    context.cleanup();
  }
});
