'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CleanupScheduler, scheduleExpression } = require('../src/services/cleanup-scheduler');

function config(overrides = {}) {
  return {
    cleanupEnabled: true,
    sub2apiTimezone: 'Asia/Shanghai',
    automaticCleanup: {
      enabled: true,
      time: '03:30',
      targets: ['system_logs', 'error_logs'],
      backupWaitMinutes: 10,
      ...overrides
    }
  };
}

function retention(overrides = {}) {
  return {
    activeRunId: null,
    maintenancePool: {},
    sub2api: { configured: () => true },
    ...overrides
  };
}

test('daily schedule uses the configured local time and timezone', () => {
  let scheduled = null;
  let stopped = false;
  const cronImpl = {
    schedule(expression, callback, options) {
      scheduled = { expression, callback, options };
      return { getNextRun: () => new Date('2026-09-23T19:30:00Z'), stop: () => { stopped = true; } };
    }
  };
  const scheduler = new CleanupScheduler({
    retention: retention(), config: config(), cronImpl,
    logger: { info() {} }
  });
  scheduler.start();
  assert.equal(scheduleExpression('03:30'), '30 3 * * *');
  assert.equal(scheduled.expression, '30 3 * * *');
  assert.equal(scheduled.options.timezone, 'Asia/Shanghai');
  assert.equal(scheduled.options.noOverlap, true);
  assert.equal(scheduler.getStatus().schedule.nextRunAt, '2026-09-23T19:30:00.000Z');
  scheduler.stop();
  assert.equal(stopped, true);
});

test('automatic cleanup reuses preview, fresh backup and guarded execution', async () => {
  const calls = [];
  const service = retention({
    async createPreview(targets) {
      calls.push(['preview', targets]);
      return {
        id: 'preview-id', createdAt: '2026-09-22T03:30:00.000Z', confirmationPhrase: '确认清理 preview',
        blockers: [], executable: true, targets: [{ eligibleRows: 12 }]
      };
    },
    async startNativeBackup() { calls.push(['backup']); },
    async execute(input) { calls.push(['execute', input]); return { id: 'run-id' }; }
  });
  const scheduler = new CleanupScheduler({ retention: service, config: config(), logger: { info() {} } });
  scheduler.waitForFreshBackup = async (createdAt) => {
    calls.push(['wait', createdAt]);
    return { satisfied: true, latest: { id: 'backup-id' } };
  };
  const result = await scheduler.runOnce();
  assert.equal(result.status, 'started');
  assert.equal(result.phase, 'finished');
  assert.equal(result.runId, 'run-id');
  assert.equal(result.eligibleRows, 12);
  assert.deepEqual(calls[0], ['preview', ['system_logs', 'error_logs']]);
  assert.deepEqual(calls[1], ['backup']);
  assert.deepEqual(calls[2], ['wait', '2026-09-22T03:30:00.000Z']);
  assert.equal(calls[3][1].actor, 'automatic-cleanup');
  assert.equal(calls[3][1].acknowledgeImpact, true);
  assert.equal(calls[3][1].acknowledgeDownstream, true);
});

test('blocked previews never start a backup or deletion', async () => {
  let destructiveCalls = 0;
  const service = retention({
    async createPreview() {
      return { id: 'preview-id', blockers: ['聚合不完整'], executable: false, targets: [{ eligibleRows: 9 }] };
    },
    async startNativeBackup() { destructiveCalls += 1; },
    async execute() { destructiveCalls += 1; }
  });
  const scheduler = new CleanupScheduler({ retention: service, config: config(), logger: { info() {} } });
  const result = await scheduler.runOnce();
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /聚合不完整/);
  assert.equal(destructiveCalls, 0);
});

test('empty previews never start a backup or deletion', async () => {
  let destructiveCalls = 0;
  const service = retention({
    async createPreview() {
      return { id: 'preview-id', blockers: [], executable: false, targets: [{ eligibleRows: 0 }] };
    },
    async startNativeBackup() { destructiveCalls += 1; },
    async execute() { destructiveCalls += 1; }
  });
  const scheduler = new CleanupScheduler({ retention: service, config: config(), logger: { info() {} } });
  const result = await scheduler.runOnce();
  assert.equal(result.status, 'skipped');
  assert.match(result.reason, /没有超过保留期限/);
  assert.equal(destructiveCalls, 0);
});

test('status follows the submitted automatic cleanup until its batch run finishes', async () => {
  const service = retention({
    async createPreview() {
      return {
        id: 'preview-id', createdAt: '2026-09-22T03:30:00.000Z', confirmationPhrase: '确认清理 preview',
        blockers: [], executable: true, targets: [{ eligibleRows: 2 }]
      };
    },
    async startNativeBackup() {},
    async execute() {
      this.activeRunId = 'run-id';
      return { id: 'run-id' };
    },
    getRun() {
      return { id: 'run-id', status: this.activeRunId ? 'running' : 'completed', deletedRows: this.activeRunId ? 1 : 2, finishedAt: null, error: null };
    }
  });
  const scheduler = new CleanupScheduler({ retention: service, config: config(), logger: { info() {} } });
  scheduler.waitForFreshBackup = async () => ({ satisfied: true });
  await scheduler.runOnce();

  const running = scheduler.getStatus();
  assert.equal(running.running, true);
  assert.equal(running.phase, 'cleanup');
  assert.equal(running.activeRunId, 'run-id');
  assert.equal(running.lastAttempt.cleanup.status, 'running');

  service.activeRunId = null;
  const completed = scheduler.getStatus();
  assert.equal(completed.running, false);
  assert.equal(completed.phase, 'idle');
  assert.equal(completed.lastAttempt.cleanup.status, 'completed');
});

test('automatic cleanup skips while any cleanup run is active', async () => {
  const scheduler = new CleanupScheduler({
    retention: retention({ activeRunId: 'manual-run' }),
    config: config(),
    logger: { info() {} }
  });
  const result = await scheduler.runOnce();
  assert.equal(result.status, 'skipped');
  assert.match(result.reason, /正在执行/);
});
