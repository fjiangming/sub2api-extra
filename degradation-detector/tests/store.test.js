'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');
const { Store } = require('../src/store');
const { testConfig } = require('./helpers');

function monitor(store, enabled = true) {
  return store.upsertMonitor({
    userId: 'user-1',
    groupId: 'group-1',
    groupName: 'Group 1',
    platform: 'openai',
    enabled,
    nextRunAt: Date.now()
  });
}

const testCase = {
  model: 'gpt-test',
  prompt: 'hello',
  output_type: 'text'
};

function saveSchedule(store, config, overrides = {}) {
  return store.saveAdminConfiguration({
    scheduleMode: overrides.mode || 'daily',
    scheduleTimes: overrides.times || ['09:30'],
    scheduleIntervalMinutes: overrides.intervalMinutes || 60,
    scheduleTimezone: config.scheduleTimezone,
    updatedBy: 'test-admin',
    serviceOwnerId: config.serviceOwnerId,
    platforms: [],
    groups: []
  });
}

test('legacy single-time settings migrate to the multi-mode schedule', (t) => {
  const config = testConfig(t);
  const legacy = new Database(config.databasePath);
  legacy.exec(`
    CREATE TABLE service_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      schedule_time TEXT NOT NULL,
      schedule_timezone TEXT NOT NULL,
      updated_by TEXT,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO service_settings VALUES (1, '17:25', 'Asia/Shanghai', 'legacy-admin', 1);
  `);
  legacy.close();

  const store = new Store(config);
  t.after(() => store.close());
  const settings = store.getServiceSettings();
  assert.equal(settings.schedule_mode, 'daily');
  assert.deepEqual(settings.schedule_times, ['17:25']);
  assert.equal(settings.schedule_interval_minutes, 60);
});

test('stored schedules support multiple daily times and intervals', (t) => {
  const config = testConfig(t);
  const store = new Store(config);
  t.after(() => store.close());
  const from = Date.parse('2026-09-26T02:00:00.000Z');

  saveSchedule(store, config, { times: ['09:30', '18:45'] });
  assert.equal(new Date(store.nextScheduledAt(from)).toISOString(), '2026-09-26T10:45:00.000Z');

  saveSchedule(store, config, { mode: 'interval', intervalMinutes: 90 });
  assert.equal(store.nextScheduledAt(from), from + 90 * 60 * 1000);
});

test('manual completion preserves the automatic next run while scheduled completion advances it', (t) => {
  const config = testConfig(t);
  const store = new Store(config);
  t.after(() => store.close());
  saveSchedule(store, config, { mode: 'interval', intervalMinutes: 30 });
  const originalNextRunAt = Date.now() + 10 * 60 * 1000;
  const currentMonitor = store.upsertMonitor({
    userId: 'user-1',
    groupId: 'group-1',
    groupName: 'Group 1',
    platform: 'openai',
    enabled: true,
    nextRunAt: originalNextRunAt
  });

  const manual = store.createRun(currentMonitor, testCase, 'manual');
  store.markRunRunning(manual.id);
  store.completeRun(manual.id, {
    status: 'normal', quality: 'normal', reason: 'ok', source: 'test', outputText: 'ok'
  });
  assert.equal(store.getMonitorById(currentMonitor.id).next_run_at, originalNextRunAt);

  const beforeCompletion = Date.now();
  const scheduled = store.createRun(currentMonitor, testCase, 'scheduled');
  store.markRunRunning(scheduled.id);
  store.completeRun(scheduled.id, {
    status: 'normal', quality: 'normal', reason: 'ok', source: 'test', outputText: 'ok'
  });
  const advanced = store.getMonitorById(currentMonitor.id).next_run_at;
  assert.ok(advanced >= beforeCompletion + 30 * 60 * 1000);
  assert.ok(advanced <= Date.now() + 30 * 60 * 1000);
});

test('unfinished runs are recovered after reopening the database', (t) => {
  const config = testConfig(t);
  let store = new Store(config);
  const firstMonitor = monitor(store);
  const run = store.createRun(firstMonitor, testCase, 'scheduled');
  store.markRunRunning(run.id);
  store.close();

  store = new Store(config);
  t.after(() => store.close());
  const recovered = store.getRun(run.id);
  assert.equal(recovered.status, 'error');
  assert.equal(recovered.error_code, 'SERVICE_RESTARTED');
  assert.equal(recovered.source, 'service_restart');
  assert.ok(store.getMonitor('user-1', 'group-1').next_run_at <= Date.now());
});

test('a disabled monitor stays unscheduled when an in-flight run completes', (t) => {
  const config = testConfig(t);
  const store = new Store(config);
  t.after(() => store.close());
  const currentMonitor = monitor(store);
  const run = store.createRun(currentMonitor, testCase, 'manual');
  store.markRunRunning(run.id);
  store.setMonitorEnabled('user-1', 'group-1', false);
  store.completeRun(run.id, {
    status: 'normal',
    quality: 'normal',
    reason: 'ok',
    source: 'test',
    outputText: 'answer'
  }, 60);
  const updated = store.getMonitor('user-1', 'group-1');
  assert.equal(updated.enabled, 0);
  assert.equal(updated.next_run_at, null);
});

test('failed runs retain a machine-readable error code', (t) => {
  const config = testConfig(t);
  const store = new Store(config);
  t.after(() => store.close());
  const currentMonitor = monitor(store);
  const run = store.createRun(currentMonitor, testCase, 'manual');
  store.markRunRunning(run.id);
  const failed = store.failRun(run.id, {
    reason: 'upstream failed',
    errorCode: 'UPSTREAM_FAILED'
  }, 60);
  assert.equal(failed.status, 'error');
  assert.equal(failed.error_code, 'UPSTREAM_FAILED');
});

test('pruning expires old payloads without changing cumulative totals', (t) => {
  const config = testConfig(t);
  const store = new Store(config);
  t.after(() => store.close());
  const currentMonitor = monitor(store);
  const statuses = ['normal', 'degraded', 'error'];
  const runIds = [];
  for (const status of statuses) {
    const run = store.createRun(currentMonitor, testCase, 'manual');
    store.markRunRunning(run.id);
    const completed = status === 'error'
      ? store.failRun(run.id, { reason: 'failed', errorCode: 'FAILED' }, 60)
      : store.completeRun(run.id, {
          status,
          quality: status,
          reason: status,
          source: 'test',
          outputText: `payload-${status}`,
          previewToken: `preview_token_${status}_1234567890`
        }, 60);
    runIds.push(completed.id);
  }

  store.pruneRuns(currentMonitor.id, 1);
  const summary = store.groupSummary('user-1', 'group-1', 10);
  assert.deepEqual(summary.totals, { passed: 1, valid: 2, attempts: 3 });
  assert.equal(summary.history.length, 3);
  assert.equal(store.getRun(runIds[0]).output_text, null);
  assert.equal(store.getRun(runIds[1]).preview_token, null);
  assert.equal(store.getRun(runIds[2]).status, 'error');
});

test('unavailable monitors are disabled, credentials cleared, and history retained', (t) => {
  const config = testConfig(t);
  const store = new Store(config);
  t.after(() => store.close());
  const current = store.upsertMonitor({
    userId: 'user-1',
    groupId: 'group-1',
    groupName: 'Group 1',
    platform: 'openai',
    keyCipher: 'v1.test-cipher',
    keyFingerprint: 'test-fingerprint',
    enabled: true
  });
  const run = store.createRun(current, testCase, 'manual');
  store.markRunRunning(run.id);
  store.completeRun(run.id, {
    status: 'normal', quality: 'normal', reason: 'ok', source: 'test', outputText: 'ok'
  }, 60);
  assert.equal(store.disableUnavailableMonitors('user-1', []), 1);
  const disabled = store.getMonitor('user-1', 'group-1');
  assert.equal(disabled.enabled, 0);
  assert.equal(disabled.key_cipher, null);
  assert.equal(disabled.key_fingerprint, null);
  assert.equal(store.getRun(run.id).status, 'normal');
});

test('service ownership migration rejects legacy credential formats and disables legacy monitors', (t) => {
  const config = testConfig(t);
  const store = new Store(config);
  t.after(() => store.close());
  const legacy = store.upsertMonitor({
    userId: 'legacy-user',
    groupId: '1',
    groupName: 'Legacy Group',
    platform: 'openai',
    enabled: true
  });
  const service = store.upsertMonitor({
    userId: config.serviceOwnerId,
    groupId: 'unconfigured',
    groupName: 'Unconfigured Group',
    platform: 'openai',
    enabled: true
  });
  store.db.prepare('UPDATE monitors SET key_cipher = ? WHERE id IN (?, ?)')
    .run('legacy-encrypted-credential', legacy.id, service.id);

  store.prepareServiceOwnership(config.serviceOwnerId);
  assert.equal(store.getMonitorById(legacy.id).enabled, 0);
  assert.equal(store.getMonitorById(legacy.id).key_cipher, null);
  assert.equal(store.getMonitorById(service.id).enabled, 0);
  assert.equal(store.getMonitorById(service.id).key_cipher, null);
});
