const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { createTestContext } = require('./helpers');
const { ProviderRepository } = require('../src/repositories/provider-repository');
const { JobQueue } = require('../src/services/job-queue');

function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('Timed out waiting for queued jobs'));
      }
    }, 10);
  });
}

test('job queue enforces per-provider concurrency while allowing different providers in parallel', async (t) => {
  const context = createTestContext();
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const firstProvider = providers.create({ name: 'First', adapterType: 'custom', baseUrl: 'https://first.example', credentials: { apiKey: 'one' }, accountDedupeKey: 'first' });
  const secondProvider = providers.create({ name: 'Second', adapterType: 'custom', baseUrl: 'https://second.example', credentials: { apiKey: 'two' }, accountDedupeKey: 'second' });
  const queue = new JobQueue({ db: context.db, concurrency: 3, perConnectionConcurrency: 1, pollIntervalMs: 5 });
  t.after(() => queue.stop());
  const active = new Map();
  const maximum = new Map();
  let globalActive = 0;
  let globalMaximum = 0;
  const handler = async (job) => {
    const current = (active.get(job.connection_id) || 0) + 1;
    active.set(job.connection_id, current);
    maximum.set(job.connection_id, Math.max(maximum.get(job.connection_id) || 0, current));
    globalActive += 1;
    globalMaximum = Math.max(globalMaximum, globalActive);
    await new Promise((resolve) => setTimeout(resolve, 60));
    globalActive -= 1;
    active.set(job.connection_id, current - 1);
  };
  queue.register('first-task', handler);
  queue.register('second-task', handler);
  queue.start();
  const ids = [
    queue.enqueue('first-task', { connectionId: firstProvider.id }),
    queue.enqueue('second-task', { connectionId: firstProvider.id }),
    queue.enqueue('first-task', { connectionId: secondProvider.id })
  ];
  await waitFor(() => ids.every((id) => queue.get(id)?.status === 'succeeded'));
  assert.equal(maximum.get(firstProvider.id), 1);
  assert.ok(globalMaximum >= 2);
});

test('job queue survives a competing SQLite writer and resumes polling', async (t) => {
  const context = createTestContext();
  context.db.pragma('busy_timeout = 25');
  const queue = new JobQueue({
    db: context.db,
    concurrency: 1,
    perConnectionConcurrency: 1,
    pollIntervalMs: 10
  });
  let handled = 0;
  queue.register('lock-test', async () => {
    handled += 1;
  });
  queue.start();

  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  context.db.prepare(`
    INSERT INTO jobs(
      id, type, payload_json, status, priority, run_after, created_at, updated_at
    ) VALUES (?, 'lock-test', '{}', 'pending', 0, ?, ?, ?)
  `).run(jobId, new Date(Date.now() + 80).toISOString(), now, now);

  const competingDb = new Database(context.config.databasePath);
  competingDb.exec('BEGIN IMMEDIATE');
  let locked = true;
  t.after(async () => {
    await queue.stop();
    if (locked) competingDb.exec('ROLLBACK');
    competingDb.close();
    context.cleanup();
  });
  await new Promise((resolve) => setTimeout(resolve, 180));
  competingDb.exec('ROLLBACK');
  locked = false;

  await waitFor(() => queue.get(jobId)?.status === 'succeeded');
  assert.equal(handled, 1);
});
