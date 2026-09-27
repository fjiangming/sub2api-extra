'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CostLedgerStore } = require('../src/cost-ledger-store');

test('cost ledger persists expenses and provider snapshots across restarts', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'operations-center-costs-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const store = new CostLedgerStore(directory);
  await store.initialize();
  await store.replaceProviders([{
    id: 'provider-1', name: 'Provider One', adapterType: 'sub2api', enabled: true, currency: 'USD'
  }]);
  const created = await store.createEntry({
    kind: 'provider', providerId: 'provider-1', name: 'Provider One', date: '2026-09-20',
    amountMinor: 12345, currency: 'CNY', note: 'September', createdBy: 'admin', updatedBy: 'admin'
  });
  await store.updateEntry(created.id, { amountMinor: 15000, updatedBy: 'operator' });

  const reloaded = new CostLedgerStore(directory);
  await reloaded.initialize();
  assert.equal(reloaded.entries()[0].amountMinor, 15000);
  assert.equal(reloaded.entries()[0].updatedBy, 'operator');
  assert.equal(reloaded.providers().items[0].name, 'Provider One');
  assert.equal(reloaded.providers().sync.status, 'ok');

  await reloaded.deleteEntry(created.id);
  assert.deepEqual(reloaded.entries(), []);
});

test('provider sync failures retain the last successful snapshot', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'operations-center-costs-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new CostLedgerStore(directory);
  await store.initialize();
  await store.replaceProviders([{ id: 'p1', name: 'P1' }]);
  await store.recordProviderSyncFailure('connection failed');
  assert.deepEqual(store.providers().items, [{ id: 'p1', name: 'P1' }]);
  assert.equal(store.providers().sync.status, 'error');
  assert.equal(store.providers().sync.error, 'connection failed');
});
