'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RetentionService,
  POLICY_DEFINITIONS,
  PERMANENTLY_PROTECTED,
  cutoffFor
} = require('../src/services/retention-service');

function config(overrides = {}) {
  return {
    cleanupEnabled: true,
    requireFreshBackup: true,
    previewTtlMinutes: 15,
    cleanupBatchSize: 5000,
    cleanupBatchDelayMs: 0,
    cleanupMaxRows: 10000,
    sub2apiTimezone: 'Asia/Shanghai',
    retention: {
      usageLogsDays: 30,
      usageHourlyDays: 30,
      usageDailyDays: 730,
      systemLogDays: 7,
      errorLogDays: 30,
      opsMetricDays: 30,
      backupMaxAgeHours: 24
    },
    ...overrides
  };
}

test('cleanup whitelist never contains protected money or dedup tables', () => {
  const targetTables = Object.values(POLICY_DEFINITIONS).flatMap((definition) => definition.tables.map((item) => item.table));
  const protectedTables = PERMANENTLY_PROTECTED.flatMap((group) => group.tables);
  for (const name of ['users', 'payment_orders', 'payment_audit_logs', 'redeem_codes', 'usage_billing_dedup', 'usage_billing_dedup_archive']) {
    assert.ok(protectedTables.includes(name));
    assert.ok(!targetTables.includes(name));
  }
});

test('minimum configured usage retention remains 30 days', () => {
  const policy = new RetentionService({
    readPool: {}, maintenancePool: {}, inspector: {}, sub2api: {}, config: config()
  }).getPolicy();
  assert.equal(policy.policies.find((item) => item.id === 'usage_logs').retentionDays, 30);
  assert.equal(policy.policies.find((item) => item.id === 'usage_daily').retentionDays, 730);
  assert.equal(policy.automaticSchedule, false);
});

test('batch delete uses a fixed table, ctid plus tableoid, and a transaction', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/DELETE FROM usage_logs/.test(sql)) return { rowCount: 42 };
      return { rows: [] };
    }
  };
  const service = new RetentionService({
    readPool: {}, maintenancePool: {}, inspector: {}, sub2api: {}, config: config()
  });
  const deleted = await service.deleteBatch(client, POLICY_DEFINITIONS.usage_logs.tables[0], new Date(), 5000);
  assert.equal(deleted, 42);
  assert.equal(calls[0].sql, 'BEGIN');
  assert.match(calls[2].sql, /SELECT tableoid, ctid/);
  assert.match(calls[2].sql, /target\.tableoid = victims\.tableoid/);
  assert.deepEqual(calls[2].params.slice(1), [5000]);
  assert.equal(calls.at(-1).sql, 'COMMIT');
});

test('date-bucket cleanup uses the configured Sub2API timezone', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/DELETE FROM usage_dashboard_daily/.test(sql)) return { rowCount: 3 };
      return { rows: [] };
    }
  };
  const service = new RetentionService({
    readPool: {}, maintenancePool: {}, inspector: {}, sub2api: {}, config: config()
  });
  const deleted = await service.deleteBatch(client, POLICY_DEFINITIONS.usage_daily.tables[0], new Date(), 5000);
  assert.equal(deleted, 3);
  assert.match(calls[2].sql, /AT TIME ZONE \$3/);
  assert.deepEqual(calls[2].params.slice(1), [5000, 'Asia/Shanghai']);
});

test('usage coverage compares complete configured-timezone dates', async () => {
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (/FROM usage_dashboard_aggregation_watermark/.test(sql)) {
        return { rows: [{ last_aggregated_at: new Date(), updated_at: new Date(), lag_seconds: 0 }] };
      }
      if (/WITH raw AS/.test(sql)) return { rows: [] };
      return { rows: [{ raw_from: null, raw_through: null, eligible_rows: 0 }] };
    }
  };
  const tables = Object.fromEntries([
    'usage_logs', 'usage_dashboard_daily', 'usage_dashboard_daily_users',
    'usage_dashboard_aggregation_watermark'
  ].map((name) => [name, { exists: true }]));
  const service = new RetentionService({
    readPool: pool,
    maintenancePool: {},
    inspector: { inspect: async () => ({ tables }) },
    sub2api: {},
    config: config()
  });
  const result = await service.checkUsageCoverage(cutoffFor(new Date(), 30));
  const comparison = queries.find(({ sql }) => /WITH raw AS/.test(sql));
  assert.equal(result.passed, true);
  assert.match(comparison.sql, /created_at AT TIME ZONE \$3\)::date >= \(\$1::timestamptz AT TIME ZONE \$3\)::date/);
  assert.match(comparison.sql, /account_cost_mismatch/);
});

test('cleanup releases its active state when the maintenance connection fails', async () => {
  const service = new RetentionService({
    readPool: {},
    maintenancePool: { connect: async () => { throw new Error('database unavailable'); } },
    inspector: {}, sub2api: {}, config: config()
  });
  const run = {
    id: 'run-id', status: 'queued', targets: [], deletedRows: 0,
    cancelRequested: false, partial: false, notes: [], error: null
  };
  service.activeRunId = run.id;
  await service.runCleanup(run, { targets: [] });
  assert.equal(run.status, 'failed');
  assert.equal(run.error.message, 'database unavailable');
  assert.equal(service.activeRunId, null);
});

test('execution is blocked until a post-preview native backup exists', async () => {
  const inspector = { inspect: async () => ({ compatible: true, missingRequired: [], checkedAt: new Date().toISOString(), tables: {} }) };
  const service = new RetentionService({
    readPool: {}, maintenancePool: { connect: async () => { throw new Error('must not run'); } }, inspector, sub2api: {}, config: config()
  });
  const preview = {
    id: '15c2c513-719e-4e55-94ed-abf85016379f',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    confirmationPhrase: '确认清理 15c2c513',
    executable: true,
    blockers: [],
    targets: [{ id: 'system_logs', label: '普通系统日志', cutoff: cutoffFor(new Date(), 7).toISOString(), eligibleRows: 2 }],
    usageCoverage: null
  };
  service.previews.set(preview.id, preview);
  service.inspectNativeActivity = async () => ({ usageCleanupTasks: [], jobHeartbeats: [] });
  service.getBackupStatus = async () => ({ available: true, satisfied: false });
  await assert.rejects(service.execute({
    previewId: preview.id,
    confirmationPhrase: preview.confirmationPhrase,
    acknowledgeImpact: true,
    acknowledgeDownstream: true,
    actor: 'admin'
  }), (error) => error.code === 'FRESH_BACKUP_REQUIRED');
});

test('preview backup status uses the preview creation time as its boundary', async () => {
  const service = new RetentionService({
    readPool: {}, maintenancePool: {},
    inspector: {
      inspect: async () => ({
        compatible: true,
        missingRequired: [],
        checkedAt: new Date().toISOString(),
        tables: {}
      })
    },
    sub2api: {},
    config: config()
  });
  service.inspectNativeActivity = async () => ({ usageCleanupTasks: [], jobHeartbeats: [] });
  service.countTable = async (item) => ({ table: item.table, available: true, eligibleRows: 3, estimatedLogicalBytes: 128 });
  let backupOptions = null;
  service.getBackupStatus = async (options) => {
    backupOptions = options;
    return { available: true, satisfied: false };
  };

  const preview = await service.createPreview(['system_logs']);
  assert.equal(backupOptions.previewCreatedAt, preview.createdAt);
  assert.equal(preview.backup.satisfied, false);
});
