'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CostLedgerStore } = require('../src/cost-ledger-store');

test('cost ledger persists income, expenses and provider snapshots across restarts', async (t) => {
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
  const income = await store.createIncomeEntry({
    name: 'Consulting', date: '2026-09-21', amountMinor: 8800, currency: 'CNY', note: 'Project',
    createdBy: 'admin', updatedBy: 'admin'
  });
  await store.updateIncomeEntry(income.id, { amountMinor: 9900, updatedBy: 'operator' });

  const reloaded = new CostLedgerStore(directory);
  await reloaded.initialize();
  assert.equal(reloaded.entries()[0].amountMinor, 15000);
  assert.equal(reloaded.entries()[0].updatedBy, 'operator');
  assert.equal(reloaded.incomeEntries()[0].amountMinor, 9900);
  assert.equal(reloaded.incomeEntries()[0].updatedBy, 'operator');
  assert.equal(reloaded.providers().items[0].name, 'Provider One');
  assert.equal(reloaded.providers().sync.status, 'ok');

  await reloaded.deleteEntry(created.id);
  await reloaded.deleteIncomeEntry(income.id);
  assert.deepEqual(reloaded.entries(), []);
  assert.deepEqual(reloaded.incomeEntries(), []);
});

test('version 1 ledgers migrate without losing expenses or provider snapshots', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'operations-center-costs-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const timestamp = '2026-09-20T00:00:00.000Z';
  await fs.writeFile(path.join(directory, 'cost-ledger.json'), JSON.stringify({
    version: 1,
    entries: [{
      id: 'expense-1', kind: 'custom', providerId: null, name: 'Legacy hosting', date: '2026-09-20',
      amountMinor: 1234, currency: 'CNY', note: '', createdBy: 'admin', updatedBy: 'admin',
      createdAt: timestamp, updatedAt: timestamp
    }],
    providers: [{ id: 'provider-1', name: 'Legacy Provider' }],
    providerSync: { status: 'ok', syncedAt: timestamp, attemptedAt: timestamp, error: null }
  }));

  const store = new CostLedgerStore(directory);
  await store.initialize();
  assert.equal(store.snapshot().version, 2);
  assert.equal(store.entries()[0].name, 'Legacy hosting');
  assert.equal(store.providers().items[0].name, 'Legacy Provider');
  assert.deepEqual(store.incomeEntries(), []);

  const persisted = JSON.parse(await fs.readFile(path.join(directory, 'cost-ledger.json'), 'utf8'));
  assert.equal(persisted.version, 2);
  assert.deepEqual(persisted.incomes, []);
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

test('concurrent income and expense writes are serialized without losing entries', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'operations-center-costs-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new CostLedgerStore(directory);
  await store.initialize();

  const created = await Promise.all(Array.from({ length: 40 }, (_, index) => {
    const shared = {
      name: `${index % 2 ? 'Income' : 'Expense'} ${index}`,
      date: `2026-09-${String(index % 28 + 1).padStart(2, '0')}`,
      amountMinor: index + 1,
      currency: index % 2 ? 'USD' : 'CNY',
      note: '',
      createdBy: 'admin',
      updatedBy: 'admin'
    };
    return index % 2
      ? store.createIncomeEntry(shared)
      : store.createEntry({ ...shared, kind: 'custom', providerId: null });
  }));

  assert.equal(store.entries().length, 20);
  assert.equal(store.incomeEntries().length, 20);
  assert.equal(new Set(created.map((entry) => entry.id)).size, 40);
  await Promise.all(created.map((entry, index) => {
    const update = { amountMinor: 1000 + index, updatedBy: 'operator' };
    return entry.kind ? store.updateEntry(entry.id, update) : store.updateIncomeEntry(entry.id, update);
  }));

  const reloaded = new CostLedgerStore(directory);
  await reloaded.initialize();
  const entries = reloaded.entries();
  const incomes = reloaded.incomeEntries();
  assert.equal(entries.length, 20);
  assert.equal(incomes.length, 20);
  assert.equal(entries.every((entry) => entry.updatedBy === 'operator'), true);
  assert.equal(incomes.every((entry) => entry.updatedBy === 'operator'), true);
  assert.deepEqual(
    [...entries, ...incomes].map((entry) => entry.amountMinor).sort((left, right) => left - right),
    Array.from({ length: 40 }, (_, index) => 1000 + index)
  );
});
