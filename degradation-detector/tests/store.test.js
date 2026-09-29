'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { validateTestConfig } = require('../src/config');
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

test('legacy runs migrate without inventing a reasoning effort snapshot', (t) => {
  const config = testConfig(t);
  const original = new Store(config);
  const currentMonitor = monitor(original);
  const run = original.createRun(currentMonitor, { ...testCase, reasoning_effort: 'high' }, 'manual');
  original.close();

  const legacy = new Database(config.databasePath);
  legacy.exec('ALTER TABLE runs DROP COLUMN reasoning_effort');
  legacy.close();

  const migrated = new Store(config);
  t.after(() => migrated.close());
  assert.equal(migrated.getRun(run.id).reasoning_effort, null);
  assert.equal(migrated.groupSummary('user-1', 'group-1', 10).history[0].reasoning_effort, null);
});

test('legacy monitor tables migrate to support group-specific tests', (t) => {
  const config = testConfig(t);
  const original = new Store(config);
  original.close();
  const legacy = new Database(config.databasePath);
  legacy.exec('ALTER TABLE monitors DROP COLUMN test_config_json');
  legacy.close();

  const migrated = new Store(config);
  t.after(() => migrated.close());
  const columns = migrated.db.prepare('PRAGMA table_info(monitors)').all().map((column) => column.name);
  assert.ok(columns.includes('test_config_json'));
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

test('group tests override platform defaults and survive disabled scheduling', (t) => {
  const config = testConfig(t);
  const store = new Store(config);
  t.after(() => store.close());
  const validation = {
    min_bytes: 1,
    required_patterns: [],
    forbidden_patterns: [],
    case_sensitive: false
  };
  const platformTest = validateTestConfig('openai', {
    label: 'OpenAI', model: 'gpt-platform', api: 'responses', prompt: 'platform prompt',
    output_type: 'text', max_output_tokens: 256, validation
  });
  const groupTest = validateTestConfig('openai', {
    label: 'OpenAI Group 1', model: 'gpt-group', api: 'responses', prompt: 'group prompt',
    output_type: 'text', reasoning_effort: 'max', max_output_tokens: 512, validation
  });
  const save = (group) => store.saveAdminConfiguration({
    scheduleMode: 'daily', scheduleTimes: ['09:30'], scheduleIntervalMinutes: 60,
    scheduleTimezone: config.scheduleTimezone, updatedBy: 'test-admin',
    serviceOwnerId: config.serviceOwnerId,
    platforms: [{ id: 'openai', enabled: true, test: platformTest, groups: [] }],
    groups: [group]
  });

  save({
    id: 'group-1', name: 'Group 1', platform: 'openai', enabled: true,
    keyCipher: 'v1.cipher', keyFingerprint: 'fingerprint', test: groupTest
  });
  let current = store.getMonitor(config.serviceOwnerId, 'group-1');
  assert.equal(store.getMonitorTest(current).model, 'gpt-group');
  assert.equal(store.getMonitorTestOverride(current).reasoning_effort, 'max');

  save({
    id: 'group-1', name: 'Group 1', platform: 'openai', enabled: false,
    keyCipher: null, keyFingerprint: null, test: groupTest
  });
  current = store.getMonitor(config.serviceOwnerId, 'group-1');
  assert.equal(current.enabled, 0);
  assert.equal(current.key_cipher, null);
  assert.equal(store.getMonitorTestOverride(current).model, 'gpt-group');

  save({
    id: 'group-1', name: 'Group 1', platform: 'openai', enabled: true,
    keyCipher: 'v1.cipher', keyFingerprint: 'fingerprint', test: null
  });
  current = store.getMonitor(config.serviceOwnerId, 'group-1');
  assert.equal(store.getMonitorTestOverride(current), null);
  assert.equal(store.getMonitorTest(current).model, 'gpt-platform');
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

test('runs snapshot the reasoning effort used for each detection', (t) => {
  const config = testConfig(t);
  const store = new Store(config);
  t.after(() => store.close());
  const currentMonitor = monitor(store);

  const explicit = store.createRun(currentMonitor, { ...testCase, reasoning_effort: 'xhigh' }, 'manual');
  const automatic = store.createRun(currentMonitor, testCase, 'scheduled');

  assert.equal(explicit.reasoning_effort, 'xhigh');
  assert.equal(automatic.reasoning_effort, 'none');
  assert.deepEqual(
    store.groupSummary('user-1', 'group-1', 10).history.map((run) => run.reasoning_effort),
    ['none', 'xhigh']
  );
});

test('runs snapshot validation configuration and expose sanitized rule evidence', (t) => {
  const config = testConfig(t);
  const store = new Store(config);
  t.after(() => store.close());
  const currentMonitor = monitor(store);
  const validation = {
    version: 2,
    normal_threshold: 80,
    degraded_threshold: 50,
    confirmation: { window: 3, required_failures: 2, recovery_passes: 2 },
    rules: [
      { id: 'answer', label: '答案正确', type: 'exact_text', severity: 'hard', weight: 100, value: '1161', case_sensitive: false }
    ]
  };
  const run = store.createRun(currentMonitor, { ...testCase, validation }, 'manual');
  store.markRunRunning(run.id);
  store.completeRun(run.id, {
    status: 'normal', quality: 'normal', score: 100, reason: 'ok', source: 'configured_validation_v2',
    validationResult: {
      version: 2, score: 100, passed: 1, total: 1, hard_failures: 0, integrity_failures: [],
      results: [{ id: 'answer', label: '答案正确', type: 'exact_text', severity: 'hard', weight: 100, passed: true, message: '通过' }]
    },
    outputText: '1161'
  }, 60);

  const stored = store.getRun(run.id);
  assert.deepEqual(JSON.parse(stored.validation_snapshot), validation);
  assert.equal(JSON.parse(stored.test_snapshot).prompt, 'hello');
  assert.equal(stored.score, 100);
  assert.deepEqual(store.groupSummary('user-1', 'group-1', 10).history[0].validation, {
    score: 100,
    passed: 1,
    total: 1,
    hard_failures: 0,
    integrity_failures: []
  });
});

test('group assessment requires repeated failures and repeated recovery passes', (t) => {
  const config = testConfig(t);
  const store = new Store(config);
  t.after(() => store.close());
  const currentMonitor = monitor(store);
  const complete = (status) => {
    const run = store.createRun(currentMonitor, testCase, 'manual');
    store.markRunRunning(run.id);
    store.completeRun(run.id, {
      status, quality: status, reason: status, source: 'test', outputText: status
    }, 60);
  };

  complete('degraded');
  assert.equal(store.groupAssessment('user-1', 'group-1').status, 'unknown');
  complete('degraded');
  assert.equal(store.groupAssessment('user-1', 'group-1').status, 'degraded');
  complete('normal');
  assert.equal(store.groupAssessment('user-1', 'group-1').status, 'degraded');
  complete('normal');
  assert.equal(store.groupAssessment('user-1', 'group-1').status, 'normal');
});

test('group assessment establishes and retains normal before degradation is confirmed', (t) => {
  const config = testConfig(t);
  const store = new Store(config);
  t.after(() => store.close());
  const currentMonitor = monitor(store);
  const complete = (status) => {
    const run = store.createRun(currentMonitor, testCase, 'manual');
    store.markRunRunning(run.id);
    store.completeRun(run.id, {
      status, quality: status, reason: status, source: 'test', outputText: status
    }, 60);
  };

  complete('normal');
  assert.deepEqual(store.groupAssessment('user-1', 'group-1'), {
    status: 'normal',
    reason: '最近一次有效检测正常',
    considered: 1,
    window: 3,
    required_failures: 2,
    recovery_passes: 2
  });

  complete('degraded');
  assert.equal(store.groupAssessment('user-1', 'group-1').status, 'normal');
  assert.match(store.groupAssessment('user-1', 'group-1').reason, /尚未达到 2 次确认条件/);

  complete('degraded');
  assert.equal(store.groupAssessment('user-1', 'group-1').status, 'degraded');
});

test('manual reviews preserve automatic verdicts and drive effective summaries', (t) => {
  const config = testConfig(t);
  const store = new Store(config);
  t.after(() => store.close());
  const currentMonitor = monitor(store);
  const completed = [];
  for (let index = 0; index < 2; index += 1) {
    const run = store.createRun(currentMonitor, testCase, 'manual');
    store.markRunRunning(run.id);
    completed.push(store.completeRun(run.id, {
      status: 'degraded', quality: 'degraded', reason: `automatic-${index}`, source: 'test', outputText: 'bad'
    }, 60));
  }
  assert.equal(store.groupAssessment('user-1', 'group-1').status, 'degraded');

  const reviewed = store.reviewRun('user-1', 'group-1', completed[1].id, {
    status: 'normal', reason: '人工确认内容完整'
  }, 'admin-1');
  assert.equal(reviewed.outcome, 'updated');
  assert.equal(reviewed.run.status, 'degraded');
  assert.equal(reviewed.run.manual_status, 'normal');
  assert.equal(reviewed.run.manual_updated_by, 'admin-1');

  const summary = store.groupSummary('user-1', 'group-1', 10);
  assert.deepEqual(summary.totals, { passed: 1, valid: 2, attempts: 2 });
  assert.equal(summary.assessment.status, 'normal');
  assert.equal(summary.history[0].status, 'normal');
  assert.equal(summary.history[0].quality, 'normal');
  assert.equal(summary.history[0].reason, '人工复核：人工确认内容完整');
  assert.deepEqual(summary.history[0].review, {
    status: 'normal',
    automated_status: 'degraded',
    reason: '人工确认内容完整',
    reviewed_at: reviewed.run.manual_updated_at / 1000
  });

  store.reviewRun('user-1', 'group-1', completed[0].id, {
    status: 'normal', reason: '第二次人工确认'
  }, 'admin-1');
  assert.equal(store.groupAssessment('user-1', 'group-1').status, 'normal');

  const cleared = store.reviewRun('user-1', 'group-1', completed[1].id, {
    status: null, reason: ''
  }, 'admin-1');
  assert.equal(cleared.run.manual_status, null);
  assert.equal(store.groupSummary('user-1', 'group-1', 10).history[0].status, 'degraded');
  assert.equal(store.reviewRun('user-1', 'other-group', completed[0].id, {
    status: 'normal', reason: '越界尝试'
  }, 'admin-1').outcome, 'not_found');

  const active = store.createRun(currentMonitor, testCase, 'manual');
  assert.equal(store.reviewRun('user-1', 'group-1', active.id, {
    status: 'normal', reason: '任务尚未结束'
  }, 'admin-1').outcome, 'not_reviewable');
});

test('changing the active test configuration resets confirmation evidence', (t) => {
  const config = testConfig(t);
  const store = new Store(config);
  t.after(() => store.close());
  const validation = {
    version: 2,
    normal_threshold: 80,
    degraded_threshold: 50,
    confirmation: { window: 3, required_failures: 2, recovery_passes: 2 },
    rules: [{ id: 'answer', label: '答案', type: 'exact_text', severity: 'hard', weight: 100, value: 'ok', case_sensitive: false }]
  };
  const saveTest = (prompt) => store.saveAdminConfiguration({
    scheduleMode: 'daily',
    scheduleTimes: ['09:30'],
    scheduleIntervalMinutes: 60,
    scheduleTimezone: config.scheduleTimezone,
    updatedBy: 'test-admin',
    serviceOwnerId: config.serviceOwnerId,
    platforms: [{
      id: 'openai', enabled: true, groups: [],
      test: validateTestConfig('openai', {
        model: 'gpt-test', api: 'responses', prompt, output_type: 'text',
        max_output_tokens: 256, validation
      })
    }],
    groups: []
  });

  saveTest('first prompt');
  const currentMonitor = monitor(store);
  const activeTest = store.getPlatformTest('openai');
  for (let index = 0; index < 2; index += 1) {
    const run = store.createRun(currentMonitor, activeTest, 'manual');
    store.markRunRunning(run.id);
    store.completeRun(run.id, {
      status: 'degraded', quality: 'degraded', reason: 'failed', source: 'test', outputText: 'bad'
    }, 60);
  }
  assert.equal(store.groupAssessment('user-1', 'group-1').status, 'degraded');

  saveTest('second prompt');
  assert.equal(store.groupAssessment('user-1', 'group-1').status, 'unknown');
  assert.equal(store.groupAssessment('user-1', 'group-1').considered, 0);
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

test('history deletion is group-scoped and preserves active runs', (t) => {
  const config = testConfig(t);
  const store = new Store(config);
  t.after(() => store.close());
  const currentMonitor = monitor(store);
  const artifactPath = path.join(config.artifactDir, 'history-result.txt');
  fs.writeFileSync(artifactPath, 'artifact', 'utf8');

  const first = store.createRun(currentMonitor, testCase, 'manual');
  store.markRunRunning(first.id);
  store.completeRun(first.id, {
    status: 'normal', quality: 'normal', reason: 'first', source: 'test',
    artifactPath, artifactName: 'history-result.txt', artifactMime: 'text/plain'
  }, 60);
  const second = store.createRun(currentMonitor, testCase, 'scheduled');
  store.markRunRunning(second.id);
  store.completeRun(second.id, {
    status: 'degraded', quality: 'degraded', reason: 'second', source: 'test', outputText: 'second'
  }, 60);
  const active = store.createRun(currentMonitor, testCase, 'manual');

  assert.deepEqual(store.historyStats('user-1', 'group-1'), { total: 3, deletable: 2 });
  assert.deepEqual(store.historyCounts('user-1'), [{ group_id: 'group-1', count: 3 }]);
  assert.deepEqual(
    store.listHistoryPage('user-1', 'group-1', 2).map((run) => run.id),
    [active.id, second.id]
  );

  const wrongGroup = store.deleteHistory('user-1', 'other-group', [first.id]);
  assert.deepEqual(wrongGroup.missingIds, [first.id]);
  assert.ok(store.getRun(first.id));
  const activeResult = store.deleteHistory('user-1', 'group-1', [active.id]);
  assert.deepEqual(activeResult.activeIds, [active.id]);
  assert.ok(store.getRun(active.id));

  const selected = store.deleteHistory('user-1', 'group-1', [first.id]);
  assert.equal(selected.deleted, 1);
  assert.deepEqual(selected.artifactPaths, [artifactPath]);
  assert.equal(store.getRun(first.id), null);
  assert.ok(store.getRun(second.id));

  const cleared = store.deleteHistory('user-1', 'group-1');
  assert.equal(cleared.deleted, 1);
  assert.equal(store.getRun(second.id), null);
  assert.ok(store.getRun(active.id));
  assert.deepEqual(store.historyStats('user-1', 'group-1'), { total: 1, deletable: 0 });
  assert.equal(store.getMonitor('user-1', 'group-1').last_run_at, null);

  for (let index = 0; index < 100; index += 1) {
    store.createRun(currentMonitor, testCase, 'manual');
  }
  assert.equal(store.listHistoryPage('user-1', 'group-1', 101).length, 101);
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
