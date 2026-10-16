'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SettingsStore, MAX_SETTINGS_BYTES } = require('../src/settings');
const { DEFAULT_RULES, generateSnapshot, advanceSimulation } = require('../src/simulation');

const now = () => new Date('2026-10-15T03:00:00Z');
const config = { timezone: 'Asia/Shanghai', settingsDir: null };
const generate = (store, rules = DEFAULT_RULES) => store.generate({ revision: store.snapshot().revision, rules });
const publish = (store, source = 'simulation') => store.publish({ revision: store.snapshot().revision, source }, 'ad***@example.com');

test('draft changes stay isolated, publish and restore are atomic, and only one previous version is kept', async () => {
  const store = new SettingsStore(config, { now });
  let changes = 0;
  store.onPublish = () => changes++;
  assert.equal(store.active(), null);
  const generated = await generate(store);
  assert.equal(store.active(), null);
  await store.saveDraft({ revision: generated.revision, source: 'simulation' });
  assert.equal(store.active(), null);
  const live = await publish(store);
  assert.equal(store.active().version, live.published.version);
  const oldRows = structuredClone(store.active().candidate.rows);
  const regenerated = await generate(store);
  assert.deepEqual(store.active().candidate.rows, oldRows);
  assert.deepEqual(regenerated.draft.candidate.rows.map((row) => row.name), oldRows.map((row) => row.name));
  assert.deepEqual(regenerated.draft.candidate.rows, oldRows);
  const result = await publish(store, 'real');
  assert.equal(store.active(), null);
  await store.rollback({ revision: result.revision }, 'ad***@example.com');
  assert.deepEqual(store.active().candidate.rows, oldRows);
  assert.equal(store.snapshot().previous.source, 'real');
  assert.equal(changes, 3);
  assert.ok(!Object.hasOwn(store.snapshot().previous, 'candidate'));
  assert.equal(new SettingsStore(config, { now }).active(), null);
  const first = new SettingsStore(config, { now });
  await generate(first); const firstPublish = await publish(first);
  await first.rollback({ revision: firstPublish.revision }, 'ad***@example.com');
  assert.equal(first.active(), null);
});

test('optimistic revisions reject duplicates and competing saves without unbounded queues', async () => {
  const store = new SettingsStore(config, { now });
  const generated = await generate(store);
  const first = store.publish({ revision: generated.revision, source: 'simulation' }, 'admin');
  const competing = store.publish({ revision: generated.revision, source: 'real' }, 'admin');
  await assert.rejects(competing, { code: 'SETTINGS_BUSY', status: 409 });
  await first;
  await assert.rejects(store.publish({ revision: generated.revision, source: 'real' }, 'admin'), { code: 'SETTINGS_CONFLICT', status: 409 });
  assert.equal(store.active().source, 'simulation');
});

test('legacy snapshots expire across local dates while live examples keep advancing and remain publishable', async () => {
  let clock = now();
  const store = new SettingsStore(config, { now: () => clock });
  await store.change(0, (next) => { next.draft = { source: 'simulation', candidate: generateSnapshot(DEFAULT_RULES, { now: clock }) }; });
  await publish(store); await publish(store, 'real');
  clock = new Date('2026-10-15T16:00:00Z');
  assert.equal(store.snapshot().draftExpired, true);
  await assert.rejects(store.rollback({ revision: store.snapshot().revision }, 'admin'), { code: 'SIMULATION_EXPIRED' });
  await assert.rejects(publish(store), { code: 'SIMULATION_EXPIRED' });
  assert.equal(store.snapshot().previous.expired, true);
  await store.generate({ revision: store.snapshot().revision, rules: DEFAULT_RULES, keepIdentities: false }); await publish(store);
  clock = new Date('2026-10-16T16:00:00Z');
  assert.equal(store.active().candidate.version, 4);
  assert.equal(store.snapshot().expired, false);
  assert.equal(store.snapshot().draftExpired, false);
  await publish(store, 'real');
  await store.rollback({ revision: store.snapshot().revision }, 'admin');
  assert.equal(store.active().candidate.version, 4);
  await publish(store);
});

test('history conflicts leave draft and publication intact; new identities explicitly start a new series', async () => {
  const store = new SettingsStore(config, { now });
  await generate(store); await publish(store);
  const before = store.snapshot();
  const rules = { ...DEFAULT_RULES, boardMaximumTokens: 50e6 };
  await assert.rejects(generate(store, rules), { code: 'SIMULATION_HISTORY_CONFLICT' });
  assert.deepEqual(store.snapshot(), before);
  const next = await store.generate({ revision: before.revision, rules, keepIdentities: false });
  const oldKeys = new Set(before.published.candidate.rows.map((row) => row.key));
  assert.ok(next.draft.candidate.rows.every((row) => !oldKeys.has(row.key)));
  assert.deepEqual(next.published, before.published);
});

test('a fixed bounded settings file survives restart, write failures preserve publication, and corruption fails to real data', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'leaderboard-settings-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const persistent = { ...config, settingsDir: directory };
  const store = new SettingsStore(persistent, { now });
  await generate(store); await publish(store);
  for (let i = 0; i < 4; i++) { await generate(store); await publish(store); }
  const filename = path.join(directory, 'leaderboard-settings.json');
  assert.deepEqual(await fs.readdir(directory), ['leaderboard-settings.json']);
  assert.ok((await fs.stat(filename)).size <= MAX_SETTINGS_BYTES);
  const restored = new SettingsStore(persistent, { now });
  assert.deepEqual(restored.active(), store.active());
  const later = new Date('2026-11-01T03:00:00Z');
  assert.deepEqual(advanceSimulation(restored.active().candidate, later), advanceSimulation(store.active().candidate, later));
  const broken = new SettingsStore(persistent, { now, writeFile: async () => { throw new Error('no space'); } });
  const previous = broken.snapshot();
  await assert.rejects(publish(broken, 'real'), { code: 'SETTINGS_WRITE_FAILED' });
  assert.deepEqual(broken.snapshot(), previous);
  await fs.writeFile(filename, '{broken');
  const corrupt = new SettingsStore(persistent, { now });
  assert.equal(corrupt.active(), null);
  assert.ok(corrupt.snapshot().storageError);
  await generate(corrupt); await publish(corrupt);
  assert.equal(corrupt.snapshot().storageError, null);
  await fs.writeFile(filename, Buffer.alloc(MAX_SETTINGS_BYTES + 1, 32));
  const oversized = new SettingsStore(persistent, { now });
  assert.equal(oversized.active(), null);
  assert.ok(oversized.snapshot().storageError);
});
