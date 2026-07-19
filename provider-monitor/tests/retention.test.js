const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');
const { ProviderRepository } = require('../src/repositories/provider-repository');
const { RetentionService } = require('../src/services/retention-service');
const { QueryService } = require('../src/services/query-service');

function atDaysAgo(days, hour = 8) {
  const date = new Date(Date.now() - days * 86400000);
  date.setUTCHours(hour, 15, 0, 0);
  return date.toISOString();
}

test('retention downsamples old snapshots and keeps latest raw values available to queries', () => {
  const context = createTestContext({
    PROVIDER_MONITOR_RAW_SNAPSHOT_RETENTION_DAYS: '7',
    PROVIDER_MONITOR_SNAPSHOT_RETENTION_DAYS: '30',
    PROVIDER_MONITOR_JOB_RETENTION_DAYS: '7',
    PROVIDER_MONITOR_AUDIT_RETENTION_DAYS: '30',
    PROVIDER_MONITOR_NOTIFICATION_RETENTION_DAYS: '7'
  });
  try {
    const providers = new ProviderRepository(context.db, context.config);
    const provider = providers.create({
      name: 'History', adapterType: 'custom', baseUrl: 'https://history.example',
      credentials: { apiKey: 'secret' }, accountDedupeKey: 'history'
    });
    const balance = context.db.prepare(`
      INSERT INTO balance_snapshots(
        connection_id, subject_type, subject_id, currency, available, unlimited,
        raw_json, captured_at
      ) VALUES (?, 'account', ?, 'USD', ?, 0, '{}', ?)
    `);
    const usage = context.db.prepare(`
      INSERT INTO usage_snapshots(
        connection_id, subject_type, subject_id, currency, cost, period, raw_json, captured_at
      ) VALUES (?, 'account', ?, 'USD', ?, 'cumulative', '{}', ?)
    `);
    for (const [days, amount] of [[40, 100], [10, 80], [1, 70]]) {
      const capturedAt = atDaysAgo(days);
      balance.run(provider.id, provider.id, amount, capturedAt);
      usage.run(provider.id, provider.id, 100 - amount, capturedAt);
    }
    const retention = new RetentionService({
      db: context.db, config: context.config,
      credentials: { cleanupExpiredBackups: () => 0 }
    });
    retention.run();
    assert.equal(context.db.prepare('SELECT COUNT(*) count FROM balance_snapshots').get().count, 1);
    assert.equal(context.db.prepare("SELECT COUNT(*) count FROM balance_aggregates WHERE granularity = 'hourly'").get().count, 1);
    assert.equal(context.db.prepare("SELECT COUNT(*) count FROM balance_aggregates WHERE granularity = 'daily'").get().count, 1);
    assert.equal(context.db.prepare('SELECT COUNT(*) count FROM usage_snapshots').get().count, 1);
    const history = new QueryService(context.db, context.config).history({
      connectionId: provider.id, currency: 'USD', days: 60, subjectType: 'account'
    });
    assert.deepEqual(history.map((row) => row.granularity).sort(), ['daily', 'hourly', 'raw']);
    retention.run();
    assert.equal(context.db.prepare('SELECT COUNT(*) count FROM balance_aggregates').get().count, 2);
  } finally {
    context.cleanup();
  }
});
