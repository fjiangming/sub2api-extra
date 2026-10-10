'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { defaultStoragePolicy, validateTestConfig } = require('../src/config');
const { MaintenanceService } = require('../src/maintenance');
const { Store } = require('../src/store');
const { defaultTests, testConfig } = require('./helpers');

function fixture(t, policy = defaultStoragePolicy) {
  const config = testConfig(t);
  const store = new Store(config);
  const testCase = validateTestConfig('openai', defaultTests.openai);
  const save = (prompt = testCase.prompt, storagePolicy = policy) => store.saveAdminConfiguration({
    scheduleMode: 'daily', scheduleTimes: ['09:30'], scheduleIntervalMinutes: 60,
    scheduleTimezone: config.scheduleTimezone, serviceOwnerId: config.serviceOwnerId,
    updatedBy: 'admin', storagePolicy,
    platforms: [{ id: 'openai', enabled: true, test: { ...testCase, prompt }, groups: [] }], groups: []
  });
  save();
  const monitor = store.upsertMonitor({
    userId: config.serviceOwnerId, groupId: '1', groupName: 'Test group', platform: 'openai', enabled: true
  });
  const complete = (status, extra = {}) => {
    const run = store.createRun(monitor, store.getMonitorTest(monitor), 'test');
    store.markRunRunning(run.id);
    return store.completeRun(run.id, {
      status, quality: status, reason: status, source: 'test',
      outputText: '<!doctype html><html><body>test</body></html>', ...extra
    });
  };
  const maintenance = new MaintenanceService({ config, store });
  t.after(async () => { await maintenance.close(); if (store.db.open) store.close(); });
  return { config, store, monitor, complete, save, maintenance };
}

test('automatic history retirement preserves cumulative counters and confirmation across restart', (t) => {
  const policy = { ...defaultStoragePolicy, history_per_group: 60 };
  const f = fixture(t, policy);
  f.complete('normal');
  f.complete('degraded');
  f.complete('degraded');
  for (let index = 0; index < 60; index += 1) f.complete('unknown');
  const before = f.store.groupSummary(f.config.serviceOwnerId, '1', 60);
  assert.equal(before.assessment.status, 'degraded');
  const result = f.store.archiveHistory(f.monitor, policy);
  assert.equal(result.archived, 3);
  const after = f.store.groupSummary(f.config.serviceOwnerId, '1', 60);
  assert.deepEqual(after.totals, before.totals);
  assert.deepEqual(after.assessment, before.assessment);
  assert.equal(after.historyTotal, 63);
  assert.equal(after.historyArchived, 3);
  assert.equal(f.store.historyStats(f.config.serviceOwnerId, '1').total, 60);

  f.store.close();
  const reopened = new Store(f.config);
  t.after(() => reopened.close());
  const restored = reopened.groupSummary(f.config.serviceOwnerId, '1', 60);
  assert.deepEqual(restored.totals, before.totals);
  assert.deepEqual(restored.assessment, before.assessment);
  for (let index = 0; index < 2; index += 1) {
    const run = reopened.createRun(f.monitor, reopened.getMonitorTest(f.monitor), 'test');
    reopened.markRunRunning(run.id);
    reopened.completeRun(run.id, { status: 'normal', quality: 'normal', outputText: 'ok' });
    assert.equal(reopened.groupAssessment(f.config.serviceOwnerId, '1').status, index === 0 ? 'degraded' : 'normal');
  }
  reopened.deleteHistory(f.config.serviceOwnerId, '1');
  const cleared = reopened.groupSummary(f.config.serviceOwnerId, '1', 60);
  assert.deepEqual(cleared.totals, { attempts: 0, valid: 0, passed: 0 });
  assert.equal(cleared.historyArchived, 0);
  assert.equal(cleared.assessment.status, 'unknown');
});

test('age limits protect the latest 60 records and archive in bounded batches', (t) => {
  const f = fixture(t);
  for (let index = 0; index < 70; index += 1) f.complete(index % 3 === 0 ? 'degraded' : 'normal');
  f.store.db.prepare('UPDATE runs SET created_at = ?').run(Date.now() - 100 * 86400000);
  const before = f.store.groupSummary(f.config.serviceOwnerId, '1', 60);
  assert.equal(f.store.archiveHistory(f.monitor, { ...defaultStoragePolicy, enabled: false }).archived, 0);
  const first = f.store.archiveHistory(f.monitor, defaultStoragePolicy, Date.now(), 4);
  assert.equal(first.archived, 4);
  assert.equal(first.pending, true);
  f.store.archiveHistory(f.monitor, defaultStoragePolicy);
  const after = f.store.groupSummary(f.config.serviceOwnerId, '1', 60);
  assert.equal(after.history.length, 60);
  assert.equal(after.historyArchived, 10);
  assert.deepEqual(after.totals, before.totals);
  assert.deepEqual(after.assessment, before.assessment);
});

test('active tasks are protected and a changed prompt cannot reuse archived confirmation', (t) => {
  const policy = { ...defaultStoragePolicy, history_per_group: 60 };
  const f = fixture(t, policy);
  const active = f.store.createRun(f.monitor, f.store.getMonitorTest(f.monitor), 'test');
  for (let index = 0; index < 64; index += 1) f.complete(index < 2 ? 'degraded' : 'unknown');
  assert.equal(f.store.archiveHistory(f.monitor, policy).archived, 0);
  assert.equal(f.store.getRun(active.id).status, 'queued');
  f.store.failRun(active.id, { reason: 'test finished' });
  f.store.archiveHistory(f.monitor, policy);
  assert.equal(f.store.groupAssessment(f.config.serviceOwnerId, '1').status, 'degraded');
  f.save('a new prompt');
  assert.equal(f.store.groupAssessment(f.config.serviceOwnerId, '1').status, 'unknown');
  assert.equal(f.store.groupSummary(f.config.serviceOwnerId, '1', 60).totals.valid, 2);
});

test('summary caching stays bounded and invalidates after completion, review, deletion and pruning', (t) => {
  const f = fixture(t);
  const run = f.complete('normal');
  let computations = 0;
  const original = f.store.groupAssessment.bind(f.store);
  f.store.groupAssessment = (...args) => { computations += 1; return original(...args); };
  const summary = () => f.store.groupSummary(f.config.serviceOwnerId, '1', 60);
  assert.equal(summary().totals.passed, 1);
  summary();
  assert.equal(computations, 1);
  f.store.reviewRun(f.config.serviceOwnerId, '1', run.id, { status: 'degraded', reason: 'manual verdict' }, 'admin');
  assert.equal(summary().totals.passed, 0);
  assert.equal(computations, 2);
  f.complete('normal');
  assert.equal(summary().history.length, 2);
  f.store.pruneRuns(f.monitor.id, 1);
  assert.equal(summary().history.at(-1).has_html, false);
  f.store.deleteHistory(f.config.serviceOwnerId, '1', [run.id]);
  assert.deepEqual(summary().totals, { passed: 1, valid: 1, attempts: 1 });
  const page = f.store.listHistoryPage(f.config.serviceOwnerId, '1', 50);
  assert.equal(page[0].has_html, 1);
  assert.equal('output_text' in page[0], false);
  assert.equal('test_snapshot' in page[0], false);
  for (let index = 0; index < 140; index += 1) f.store.groupSummary(f.config.serviceOwnerId, `cache-${index}`, 60);
  assert.ok(f.store.summaryCache.size <= 128);
});

test('background cleanup removes expired and orphan files while protecting current and recently written files', async (t) => {
  const policy = { ...defaultStoragePolicy, history_per_group: 60 };
  const f = fixture(t, policy);
  const file = (name, old = true, outside = false) => {
    const filename = path.join(outside ? f.config.dataDir : f.config.artifactDir, name);
    fs.writeFileSync(filename, 'test fixture');
    if (old) fs.utimesSync(filename, new Date(0), new Date(0));
    return filename;
  };
  const expired = file('expired.txt');
  const orphan = file('orphan.txt');
  const temporary = file('unfinished.tmp-123');
  const recent = file('recent.txt', false);
  const live = file('live.txt');
  const outside = file('outside.txt', true, true);
  const retired = f.complete('degraded', { artifactPath: expired, previewToken: 'old-result-preview-token-1234' });
  f.complete('normal', { artifactPath: outside });
  for (let index = 0; index < 60; index += 1) f.complete('normal', index === 59 ? { artifactPath: live } : {});
  const before = f.store.groupSummary(f.config.serviceOwnerId, '1', 60).totals;
  const first = f.maintenance.run();
  assert.equal(f.maintenance.run(), first);
  const result = await first;
  assert.equal(result.archived, 2);
  assert.equal(f.store.getRun(retired.id), null);
  assert.equal(fs.existsSync(expired), false);
  assert.equal(fs.existsSync(orphan), false);
  assert.equal(fs.existsSync(temporary), false);
  assert.equal(fs.existsSync(recent), true);
  assert.equal(fs.existsSync(live), true);
  assert.equal(fs.existsSync(outside), true);
  assert.deepEqual(f.store.groupSummary(f.config.serviceOwnerId, '1', 60).totals, before);
  assert.ok(f.store.getServiceSettings().maintenance_last_run_at);
});

test('SQLite frees deleted space in idle maintenance and never compacts with active tasks', (t) => {
  const f = fixture(t);
  assert.equal(f.store.db.pragma('auto_vacuum', { simple: true }), 2);
  const big = f.complete('normal', { outputText: 'x'.repeat(12 * 1024 * 1024) });
  f.store.deleteHistory(f.config.serviceOwnerId, '1', [big.id]);
  const active = f.store.createRun(f.monitor, f.store.getMonitorTest(f.monitor), 'test');
  assert.equal(f.store.compactDatabase(), false);
  f.store.failRun(active.id, { reason: 'finished' });
  f.store.db.pragma('wal_checkpoint(TRUNCATE)');
  const freeBefore = f.store.db.pragma('freelist_count', { simple: true });
  const sizeBefore = fs.statSync(f.config.databasePath).size;
  assert.equal(f.store.compactDatabase(), true);
  assert.ok(f.store.db.pragma('freelist_count', { simple: true }) < freeBefore);
  assert.ok(fs.statSync(f.config.databasePath).size < sizeBefore);
  assert.equal(f.store.compactDatabase(), false);
});

test('multi-batch maintenance revisits remaining history promptly without starving later groups', async (t) => {
  const policy = { ...defaultStoragePolicy, history_per_group: 60 };
  const f = fixture(t, policy);
  for (let index = 0; index < 261; index += 1) f.complete('normal');
  let lastMonitor;
  for (let index = 2; index <= 21; index += 1) {
    lastMonitor = f.store.upsertMonitor({
      userId: f.config.serviceOwnerId, groupId: String(index), groupName: `Group ${index}`,
      platform: 'openai', enabled: false
    });
  }
  for (let index = 0; index < 61; index += 1) {
    const run = f.store.createRun(lastMonitor, f.store.getMonitorTest(lastMonitor), 'test');
    f.store.completeRun(run.id, { status: 'normal', quality: 'normal', outputText: 'test' });
  }
  const timestamp = Date.now();
  assert.equal((await f.maintenance.run(timestamp)).archived, 200);
  const second = await f.maintenance.run(timestamp + 60000);
  assert.equal(second.archived, 1);
  assert.equal(second.pending, true);
  assert.equal(f.maintenance.nextRunAt, timestamp + 120000);
  assert.equal(f.store.archivedCount(f.config.serviceOwnerId, '21'), 1);
  assert.equal((await f.maintenance.run(timestamp + 120000)).archived, 1);
  const fourth = await f.maintenance.run(timestamp + 180000);
  assert.equal(fourth.pending, false);
  assert.equal(f.maintenance.nextRunAt, timestamp + 180000 + 3600000);
  assert.equal(f.store.historyStats(f.config.serviceOwnerId, '1').total, 60);
});

test('a failed group cleanup does not prevent other groups from being maintained', async (t) => {
  const policy = { ...defaultStoragePolicy, history_per_group: 60 };
  const f = fixture(t, policy);
  const second = f.store.upsertMonitor({
    userId: f.config.serviceOwnerId, groupId: '2', groupName: 'Second group', platform: 'openai', enabled: false
  });
  for (let index = 0; index < 61; index += 1) {
    const run = f.store.createRun(second, f.store.getMonitorTest(second), 'test');
    f.store.completeRun(run.id, { status: 'normal', quality: 'normal' });
  }
  const archive = f.store.archiveHistory.bind(f.store);
  f.store.archiveHistory = (monitor, ...args) => {
    if (monitor.id === f.monitor.id) throw Object.assign(new Error('fixture database error'), { code: 'SQLITE_BUSY' });
    return archive(monitor, ...args);
  };
  const events = [];
  t.mock.method(console, 'error', (message) => events.push(JSON.parse(message)));
  const result = await f.maintenance.run();
  assert.equal(result.archived, 1);
  assert.equal(result.pending, true);
  assert.equal(f.store.historyStats(f.config.serviceOwnerId, '2').total, 60);
  assert.equal(events[0].event, 'maintenance_group_failed');
  f.store.archiveHistory = archive;
  assert.equal((await f.maintenance.run()).pending, false);
});

test('orphan scanning closes a broken directory and recovers on the next attempt', async (t) => {
  const f = fixture(t);
  let closed = false;
  f.maintenance.directory = {
    read: async () => { throw Object.assign(new Error('fixture directory error'), { code: 'EIO' }); },
    close: async () => { closed = true; }
  };
  await assert.rejects(f.maintenance.sweepOrphans(Date.now()), { code: 'EIO' });
  assert.equal(closed, true);
  assert.equal(f.maintenance.directory, null);
  const filename = path.join(f.config.artifactDir, 'recoverable-orphan.txt');
  fs.writeFileSync(filename, 'fixture');
  fs.utimesSync(filename, new Date(0), new Date(0));
  assert.deepEqual(await f.maintenance.sweepOrphans(Date.now()), { removed: 1, pending: false });
  assert.equal(fs.existsSync(filename), false);
});

test('legacy SQLite databases convert to incremental vacuum without losing retained data', (t) => {
  const config = testConfig(t);
  const legacy = new Database(config.databasePath);
  legacy.exec("CREATE TABLE legacy_marker (value TEXT); INSERT INTO legacy_marker VALUES ('keep legacy data')");
  legacy.close();
  const store = new Store(config);
  t.after(() => store.close());
  assert.equal(store.db.pragma('auto_vacuum', { simple: true }), 0);
  const monitor = store.upsertMonitor({
    userId: config.serviceOwnerId, groupId: '1', groupName: 'Test group', platform: 'openai', enabled: true
  });
  const testCase = validateTestConfig('openai', defaultTests.openai);
  const retained = store.createRun(monitor, testCase, 'test');
  store.completeRun(retained.id, { status: 'normal', quality: 'normal', outputText: 'keep this result' });
  const expired = store.createRun(monitor, testCase, 'test');
  store.completeRun(expired.id, { status: 'normal', quality: 'normal', outputText: 'x'.repeat(12 * 1024 * 1024) });
  store.deleteHistory(config.serviceOwnerId, '1', [expired.id]);
  store.db.pragma('wal_checkpoint(TRUNCATE)');
  const before = fs.statSync(config.databasePath).size;
  assert.equal(store.compactDatabase(), true);
  assert.equal(store.db.pragma('auto_vacuum', { simple: true }), 2);
  assert.ok(fs.statSync(config.databasePath).size < before);
  assert.equal(store.getRun(retained.id).output_text, 'keep this result');
  assert.equal(store.db.prepare('SELECT value FROM legacy_marker').get().value, 'keep legacy data');
});
