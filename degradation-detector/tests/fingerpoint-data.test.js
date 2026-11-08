'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { Store } = require('../src/store');
const { ModelStore } = require('../src/model-store');
const { FingerpointData, sources, validateBundle } = require('../src/fingerpoint-data');
const { securedModelFetch, downloadReference } = require('../src/fingerpoint-http');
const { testConfig } = require('./helpers');

function bundle(version) {
  const bytes = Buffer.from(`detector-version-${version}`);
  return { bytes, manifest: { schema: 'lmfpd-data-v1', detector_schema: 'shared-detector-v2', built_at: `2026-11-0${version}T12:00:00Z`, models: [{ id: 'gpt-test' }], files: { 'shared_detector.bin': { sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, parts: [`detector.${version}.zst`] } } } };
}
function setup(t) {
  const config = testConfig(t); const store = new Store(config); const models = new ModelStore(store);
  const state = { version: 1, calls: [], brokenOfficial: false, brokenAll: false, invalidManifest: false, rejectLoad: false };
  const dependencies = {
    download: async (url, options) => {
      state.calls.push(url); options.signal.throwIfAborted();
      if (url.includes('registry.npmjs.org')) return Buffer.from('{"version":"0.2.1"}');
      const item = bundle(state.version);
      if (url.endsWith('bundle.json')) {
        if (state.invalidManifest) item.manifest.detector_schema = 'future-version';
        return Buffer.from(JSON.stringify(item.manifest));
      }
      if (state.brokenAll || state.brokenOfficial && url.startsWith(sources[0])) return Buffer.alloc(item.bytes.length, 0);
      return item.bytes;
    },
    unpack: async bytes => bytes,
    loadDetector: async directory => {
      if (state.rejectLoad) throw new Error('invalid binary or bank');
      const bank = JSON.parse(await fs.readFile(path.join(directory, 'unified_bank.json'), 'utf8'));
      return { builtAt: bank.built_at };
    }
  };
  const data = new FingerpointData({ config, store, modelStore: models, ...dependencies });
  t.after(async () => { await data.close(); store.close(); });
  return { config, store, models, state, data, dependencies };
}

test('reference manifests reject unknown formats, unsafe paths, duplicates and excessive downloads', () => {
  const valid = bundle(1).manifest;
  assert.equal(validateBundle(valid).bytes, bundle(1).bytes.length);
  for (const modify of [value => { value.files['shared_detector.bin'].parts = ['../escape.zst']; }, value => { value.models.push(value.models[0]); }, value => { value.files['shared_detector.bin'].bytes = 20 * 1024 * 1024; }, value => { value.files['shared_detector.bin'].sha256 = '../../bad'; }, value => { value.built_at = 'not a date'; }]) {
    const item = structuredClone(valid); modify(item); assert.throws(() => validateBundle(item));
  }
  assert.throws(() => validateBundle({ ...valid, detector_schema: 'future' }), { code: 'FINGERPOINT_SDK_UPGRADE_REQUIRED' });
});

test('reference updates verify hashes, fail over sources, switch atomically and preserve pinned versions', async t => {
  const { data, state } = setup(t);
  assert.equal(data.status().active, null);
  state.brokenOfficial = true;
  await data.check(); await data.apply();
  const first = await data.acquire(new AbortController().signal);
  assert.equal(first.hash, bundle(1).manifest.files['shared_detector.bin'].sha256);
  assert(state.calls.some(url => url.startsWith(sources[1]) && url.endsWith('.zst')), 'corrupt official downloads fail over to mirror');
  assert.equal(data.status().sdk_status, 'update_available');
  assert.doesNotMatch(JSON.stringify(data.status()), /chunks|source.*https:|directory|unified_bank/);
  state.version = 2; await data.check(); await data.apply();
  state.version = 3; await data.check(); await data.apply();
  assert.equal(data.status().active.built_at, bundle(3).manifest.built_at);
  await fs.access(first.directory);
  await data.rollback();
  assert.equal(data.status().active.built_at, bundle(2).manifest.built_at);
  assert.equal(data.status().available.built_at, bundle(3).manifest.built_at);
  assert.equal(data.status().can_rollback, false);
  await first.release();
  await assert.rejects(fs.access(first.directory), { code: 'ENOENT' });
  await data.apply();
  assert.equal(data.status().active.built_at, bundle(3).manifest.built_at);
  assert.equal(data.status().history.length, 5);
  state.version = 1;
  await assert.rejects(data.check(), { code: 'FINGERPOINT_REFERENCE_STALE' });
  assert.equal(data.status().active.built_at, bundle(3).manifest.built_at, 'stale mirrors cannot automatically downgrade a reference');
});

test('failed validation or SDK loading keeps the active reference and never activates corrupt data', async t => {
  const { data, state } = setup(t);
  await data.check(); await data.apply(); const active = data.status().active;
  state.version = 2; state.brokenAll = true; await data.check();
  await assert.rejects(data.apply(), { code: 'FINGERPOINT_DATA_UNAVAILABLE' });
  assert.deepEqual(data.status().active, active);
  assert.match(data.status().last_error, /保留/);
  assert.equal(data.status().busy, false);
  state.brokenAll = false; state.rejectLoad = true;
  await assert.rejects(data.apply(), { code: 'FINGERPOINT_DATA_UNAVAILABLE' });
  assert.deepEqual(data.status().active, active);
  state.rejectLoad = false; state.invalidManifest = true;
  await assert.rejects(data.check(), { code: 'FINGERPOINT_SDK_UPGRADE_REQUIRED' });
  assert.equal(data.status().sdk_status, 'upgrade_required');
  assert.deepEqual(data.status().active, active);
});

test('reference settings and rollback survive database reopen; retention removes only owned obsolete data', async t => {
  const { data, config, store, models, state, dependencies } = setup(t);
  data.saveSettings({ automatic: true, interval_hours: 6, application: 'manual', source: 'mirror' });
  await data.check(); await data.apply();
  assert(state.calls[0].startsWith(sources[1]));
  state.version = 2; await data.check(); await data.apply();
  const orphan = path.join(data.root, 'a'.repeat(64));
  const unrelated = path.join(data.root, 'keep-user-file');
  const staging = path.join(data.root, '.staging-ABC123');
  await fs.mkdir(orphan); await fs.mkdir(unrelated); await fs.mkdir(staging);
  await fs.utimes(staging, new Date(0), new Date(0));
  await data.prune();
  await assert.rejects(fs.access(orphan)); await assert.rejects(fs.access(staging)); await fs.access(unrelated);
  await data.close();
  const reopened = new FingerpointData({ config, store, modelStore: models, ...dependencies });
  try {
    assert.equal(reopened.settings().application, 'manual');
    assert.equal(reopened.status().active.built_at, bundle(2).manifest.built_at);
    assert.equal(reopened.status().can_rollback, true);
    await reopened.rollback();
    assert.equal(reopened.status().active.built_at, bundle(1).manifest.built_at);
  } finally { await reopened.close(); }
});

test('reference actions are mutually exclusive and cancellation cannot switch the active version', async t => {
  const { data } = setup(t);
  let release;
  data.download = async (_url, { signal }) => { await new Promise(resolve => { release = resolve; }); signal.throwIfAborted(); return Buffer.from('{}'); };
  const controller = new AbortController();
  const pending = data.check(controller.signal); await Promise.resolve();
  assert.equal(data.status().busy, true);
  await assert.rejects(data.apply(), { code: 'FINGERPOINT_UPDATE_BUSY' });
  controller.abort(); release();
  await assert.rejects(pending);
  assert.equal(data.status().busy, false); assert.equal(data.status().active, null);
});

test('automatic reference checks respect disabled channels, notification mode and automatic application', async t => {
  const { data, state } = setup(t);
  t.mock.timers.enable({ apis: ['setInterval'] });
  let enabled = false;
  data.modelStore = { enabledGroups: () => enabled ? [{}] : [], effective: () => ({ enabled: true }) };
  data.saveSettings({ automatic: true, interval_hours: 1, application: 'manual', source: 'official' });
  data.start(); t.mock.timers.tick(60000);
  assert.equal(state.calls.length, 0);
  enabled = true; t.mock.timers.tick(60000);
  await data.pending; await new Promise(resolve => setImmediate(resolve));
  assert.equal(data.status().active, null); assert(data.status().available);
  data.saveSettings({ ...data.settings(), application: 'automatic' }); data.state.last_checked = 0;
  t.mock.timers.tick(60000);
  for (let attempt = 0; attempt < 100 && !data.status().active; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert(data.status().active); assert.equal(data.status().available, null);
});

test('active references stay immediately available during updates, while first-time waits honor cancellation', async t => {
  const { data } = setup(t);
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  data.pending = blocked;
  const controller = new AbortController(); const first = data.acquire(controller.signal);
  controller.abort(); await assert.rejects(first);
  data.state.active = { built_at: '2026-11-03T12:00:00Z', hash: 'a'.repeat(64), models: 66 };
  const lease = await data.acquire(new AbortController().signal);
  assert.equal(lease.hash, 'a'.repeat(64));
  release(); data.pending = null; await lease.release();
});

test('first-time detection can share a reference installation started by automatic checking', async t => {
  const { data } = setup(t);
  const check = data.check.bind(data);
  data.check = async signal => {
    await check(signal);
    queueMicrotask(() => data.apply().catch(() => {}));
  };
  const lease = await data.acquire(new AbortController().signal);
  assert.equal(data.status().active.hash, lease.hash);
  assert.equal(data.status().history.length, 1, 'concurrent initializers share one successful installation');
  await lease.release();
});

test('SDK transport pins public DNS, forbids credential redirects and bounds streamed responses', async () => {
  const calls = []; const controller = new AbortController();
  const network = securedModelFetch('https://relay.example.com/v1/responses', controller.signal, {
    resolve: async url => { calls.push(url.hostname); return { address: '8.8.8.8', family: 4 }; },
    fetch: async (_url, options) => { calls.push(options); return new Response('data: finished\n\n', { headers: { 'content-type': 'text/event-stream' } }); }
  });
  try {
    const response = await network.fetch('https://relay.example.com/v1/responses', { method: 'POST', headers: { authorization: 'Bearer dedicated-key' } });
    assert.equal(await response.text(), 'data: finished\n\n');
    assert.equal(calls[1].redirect, 'error'); assert(calls[1].dispatcher);
    await assert.rejects(network.fetch('https://other.example.com/v1/responses', { method: 'POST' }), /ENDPOINT_REJECTED/);
    await assert.rejects(network.fetch('https://127.0.0.1/v1/responses', { method: 'POST' }));
    await assert.rejects(network.fetch('https://relay.example.com/v1/responses', { method: 'GET' }), /ENDPOINT_REJECTED/);
  } finally { await network.close(); }
  const large = securedModelFetch('https://relay.example.com/v1/responses', controller.signal, { resolve: async () => ({ address: '8.8.8.8', family: 4 }), fetch: async () => new Response(new Uint8Array(2 * 1024 * 1024 + 1)) });
  try { await assert.rejects((await large.fetch('https://relay.example.com/v1/responses', { method: 'POST' })).text(), /TOO_LARGE/); }
  finally { await large.close(); }
  let dispatched = false;
  await assert.rejects(downloadReference('https://127.0.0.1/bundle.json', { signal: controller.signal, maxBytes: 100 }, { request: () => { dispatched = true; } }));
  assert.equal(dispatched, false);
});
