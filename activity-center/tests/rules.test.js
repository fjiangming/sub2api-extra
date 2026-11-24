'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fixture, config, USER } = require('./fixtures');
const { Store } = require('../src/store');

const defaultPrizes = [
  { amountMinor: 50, weight: 5200, minimumMinor: 0 }, { amountMinor: 100, weight: 2000, minimumMinor: 0 },
  { amountMinor: 200, weight: 1000, minimumMinor: 0 }, { amountMinor: 300, weight: 500, minimumMinor: 0 },
  { amountMinor: 500, weight: 200, minimumMinor: 0 }, { amountMinor: 1000, weight: 500, minimumMinor: 100000 },
  { amountMinor: 2000, weight: 400, minimumMinor: 200000 }, { amountMinor: 5000, weight: 200, minimumMinor: 500000 }
];

test('recharge lottery rules default to the current values and persist admin changes with historical threshold snapshots', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'activity-rules-'));
  const filename = path.join(directory,'test.sqlite');
  const custom = defaultPrizes.map(prize => ({ ...prize, weight: prize.amountMinor === 1000 ? 10000 : 0 }));
  let store;
  try {
    store = new Store(config(),{ filename,now: () => Date.parse('2026-11-24T00:00:00Z'),rng: () => 0 });
    assert.deepEqual(store.lotteryConfig().prizes,defaultPrizes);
    const updated = store.updateLotteryConfig({ prizes: custom },'1');
    assert.equal(updated.version,2); assert.deepEqual(updated.prizes,custom);
    const batch = store.reserve(USER,crypto.randomUUID(),1,100000);
    assert.equal(batch.rewards[0].amountMinor,1000);
    assert.equal(store.detail(batch.rewards[0].id).audit.requiredMinor,100000);
    store.updateLotteryConfig({ prizes: custom.map(prize => prize.amountMinor === 1000 ? { ...prize,minimumMinor: 200000 } : prize) },'1');
    assert.equal(store.detail(batch.rewards[0].id).audit.requiredMinor,100000);
    assert.equal(store.detail(batch.rewards[0].id).audit.status,'passed');
    store.close(); store = new Store(config(),{ filename,now: () => Date.parse('2026-11-24T00:00:00Z') });
    assert.equal(store.db.pragma('user_version',{ simple: true }),5);
    assert.equal(store.lotteryConfig().prizes.find(prize => prize.amountMinor === 1000).minimumMinor,200000);
  } finally { store?.close(); fs.rmSync(directory,{ recursive: true,force: true }); }
});

test('recharge lottery rule validation rejects incomplete, descending, or non-100-percent configurations', t => {
  const f = fixture(t);
  assert.throws(() => f.store.updateLotteryConfig({ prizes: defaultPrizes.map(prize => ({ ...prize,weight: prize.amountMinor === 50 ? 5199 : prize.weight })) },'1'),{ code: 'INVALID_PRIZE_CONFIG' });
  assert.throws(() => f.store.updateLotteryConfig({ prizes: defaultPrizes.map((prize,index) => index === 2 ? { ...prize,minimumMinor: 1 } : prize) },'1'),{ code: 'INVALID_PRIZE_CONFIG' });
  assert.throws(() => f.store.updateLotteryConfig({ prizes: defaultPrizes.map((prize,index) => index === 0 ? { ...prize,minimumMinor: 1 } : prize) },'1'),{ code: 'INVALID_PRIZE_CONFIG' });
  assert.throws(() => f.store.updateLotteryConfig({ prizes: defaultPrizes.slice(1) },'1'),{ code: 'INVALID_PRIZE_CONFIG' });
});
