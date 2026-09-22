'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { RuntimeSettingsStore } = require('../src/runtime-settings-store');

test('runtime settings are encrypted and survive a process restart', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'operations-center-settings-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new RuntimeSettingsStore(directory);
  assert.deepEqual(await store.initialize(), {});
  await store.update((settings) => {
    settings.database = {
      readUrl: 'postgresql://reader:secret-value@database/sub2api',
      maintenanceUrl: null,
      sslMode: 'disable'
    };
    return settings;
  });
  await store.update((settings) => {
    settings.cleanup = { enabled: false };
    return settings;
  });
  const encrypted = await fs.readFile(path.join(directory, 'settings.enc.json'), 'utf8');
  assert.doesNotMatch(encrypted, /secret-value|postgresql|reader/);

  const reloaded = new RuntimeSettingsStore(directory);
  const value = await reloaded.initialize();
  assert.equal(value.database.readUrl, 'postgresql://reader:secret-value@database/sub2api');
  assert.deepEqual(value.cleanup, { enabled: false });
  assert.equal(Buffer.from((await fs.readFile(path.join(directory, 'settings.key'), 'utf8')).trim(), 'base64url').length, 32);
});
