'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { Store } = require('../src/store');
const { Lottery } = require('../src/lottery');
const { RechargeSource } = require('../src/recharge-source');
const { CoreClient } = require('../src/upstream');
const { AppError } = require('../src/errors');
const { legacyNotes, creditNotes } = require('../src/reward-credit');
const { fixture, config, USER } = require('./fixtures');

function legacy(store, type = 'balance') {
  const batch = store.reserve(USER,crypto.randomUUID(),1,500000);
  const row = store.db.prepare('SELECT * FROM rewards WHERE id=?').get(batch.rewards[0].id);
  store.db.prepare('UPDATE rewards SET credit_code=?,credit_type=?,credit_notes=? WHERE id=?')
    .run(`AC-${crypto.randomBytes(24).toString('hex')}`,type,legacyNotes(row),row.id);
  return store.db.prepare('SELECT * FROM rewards WHERE id=?').get(row.id);
}

test('real PostgreSQL lookup requires both absence and the original 32-character column before replacing a legacy code', async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec('CREATE TABLE redeem_codes(id bigint,code varchar(32),type text,status text,value numeric,used_by bigint,used_at timestamptz,notes text)');
  const source = new RechargeSource(config(),{ pool: db });
  const code = `AC-${'a'.repeat(48)}`;
  assert.deepEqual(await source.inspectLegacyCredit(code),{ receipt: null,codeLimit: 32 });
  await assert.rejects(db.query('INSERT INTO redeem_codes(code) VALUES($1)',[code]),/too long/);
  await db.exec('ALTER TABLE redeem_codes ALTER COLUMN code TYPE varchar(128)');
  await assert.rejects(source.inspectLegacyCredit(code),{ code: 'CREDIT_LEGACY_REVIEW_REQUIRED' });
  await db.query("INSERT INTO redeem_codes VALUES(1,$1,'balance','used',0.5,42,'2026-11-16','original notes')",[code]);
  const found = await source.inspectLegacyCredit(code);
  assert.equal(found.receipt.code,code); assert.equal(found.receipt.id,'1'); assert.equal(found.receipt.used_by,'42');
  assert.equal(found.receipt.notes,'original notes'); assert.equal(found.codeLimit,undefined);
  await db.exec('DELETE FROM redeem_codes; ALTER TABLE redeem_codes ALTER COLUMN code TYPE text');
  await assert.rejects(source.inspectLegacyCredit(code),{ code: 'CREDIT_LEGACY_REVIEW_REQUIRED' });
  assert.equal(source.active,0);
});

test('schema 2 affiliate failures convert only after verification, survive a lost response and restart, and never reroll', async t => {
  const f = fixture(t);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'activity-credit-v2-'));
  const filename = path.join(directory,'activity.sqlite');
  let store = new Store(f.config,{ filename,now: f.now,rng: () => 0 });
  let lottery;
  t.after(async () => { await lottery?.close(); store.close(); fs.rmSync(directory,{ recursive: true,force: true }); });
  const old = legacy(store,'affiliate_balance');
  store.db.prepare("UPDATE rewards SET status='failed',attempts=8,error_code='UPSTREAM_REJECTED' WHERE id=?").run(old.id);
  store.db.exec('ALTER TABLE rewards DROP COLUMN credit_notes; ALTER TABLE rewards DROP COLUMN credit_migration; PRAGMA user_version=2;');
  const start = store.campaign.start_at;
  store.close();
  store = new Store(f.config,{ filename,now: f.now,rng: () => { throw new Error('must not reroll'); } });
  assert.equal(store.detail(old.id).status,'failed'); assert.equal(store.used(USER.id),1);
  const native = f.core.credit.bind(f.core); let lose = true;
  f.core.credit = async row => { const result = await native(row); if (lose) { lose = false; throw new Error('lost committed response'); } return result; };
  lottery = new Lottery(store,f.source,f.core);
  await lottery.kick(); assert.equal(f.credited.size,0);
  store.retry(old.id,'1'); await lottery.kick();
  const converted = store.db.prepare('SELECT * FROM rewards WHERE id=?').get(old.id);
  assert.equal(converted.credit_code.length,31); assert.equal(converted.credit_type,'balance');
  assert.equal(converted.credit_notes,creditNotes(converted)); assert.equal(converted.attempts,1);
  assert.deepEqual(JSON.parse(converted.credit_migration),{ code: old.credit_code,type: 'affiliate_balance',notes: old.credit_notes,attempts: 8,verifiedAt: new Date(f.now()).toISOString(),codeLimit: 32 });
  assert.equal(converted.status,'pending'); assert.equal(f.credited.size,1);
  await lottery.close(); store.close(); f.advance(60000);
  store = new Store(f.config,{ filename,now: f.now }); lottery = new Lottery(store,f.source,f.core);
  await lottery.kick();
  const settled = store.detail(old.id);
  assert.equal(settled.status,'paid'); assert.equal(settled.receipt.code,converted.credit_code);
  assert.equal(f.credited.size,1); assert.equal(store.used(USER.id),1); assert.equal(store.campaign.start_at,start);
  assert.equal(store.detail(old.id).retries.length,1); assert.equal(settled.amountMinor,old.amount_minor);
  const customer = JSON.stringify(store.list({ userId: USER.id }));
  assert.doesNotMatch(customer,/AC-|creditMigration|credit_notes|codeLimit|补贴/);
});

test('already committed legacy credits settle their original receipt without issuing any new code or payment', async t => {
  const f = fixture(t);
  const old = legacy(f.store,'affiliate_balance');
  await f.core.credit(old); f.attempts.length = 0;
  await f.lottery.kick();
  const row = f.store.db.prepare('SELECT * FROM rewards WHERE id=?').get(old.id);
  assert.equal(row.status,'paid'); assert.equal(row.credit_code,old.credit_code); assert.equal(row.credit_type,'affiliate_balance');
  assert.equal(row.credit_notes,old.credit_notes); assert.equal(row.credit_migration,null);
  assert.equal(f.attempts.length,0); assert.equal(f.credited.size,1); assert.equal(f.store.used(USER.id),1);
});

test('unverifiable or mismatched legacy credits cannot be renamed, paid again or counted as sent', async t => {
  for (const scenario of ['wide-column','wrong-user','database-down']) {
    const f = fixture(t); const old = legacy(f.store);
    f.source.inspectLegacyCredit = async () => {
      if (scenario === 'database-down') throw new AppError('CREDIT_LEGACY_UNAVAILABLE','unavailable',503);
      if (scenario === 'wide-column') return { receipt: null,codeLimit: 128 };
      return { receipt: { id: '1',code: old.credit_code,type: old.credit_type,status: 'used',value: 0.5,used_by: '99',used_at: new Date(f.now()).toISOString(),notes: old.credit_notes } };
    };
    await f.lottery.kick();
    const row = f.store.db.prepare('SELECT * FROM rewards WHERE id=?').get(old.id);
    assert.equal(row.credit_code,old.credit_code); assert.equal(row.credit_migration,null);
    assert.equal(row.status,scenario === 'database-down' ? 'pending' : 'failed');
    assert.equal(f.credited.size,0); assert.equal(f.attempts.length,0); assert.equal(f.store.ledgerSummary().totalMinor,0);
  }
});

test('legacy conversion rejects stale leases and late callbacks cannot settle or fail a replacement with the same attempt number', t => {
  const f = fixture(t); legacy(f.store);
  const first = f.store.claim();
  const replacement = f.store.replaceLegacyCredit(first,32);
  assert.equal(first.attempts,replacement.attempts); assert.notEqual(first.credit_code,replacement.credit_code);
  assert.equal(f.store.replaceLegacyCredit(first,32),null);
  assert.equal(f.store.settle(first,{ usedAt: new Date(f.now()).toISOString() }),0);
  f.store.fail(first,'LATE_FAILURE',true);
  assert.equal(f.store.detail(first.id).status,'pending');
  assert.equal(f.store.settle(replacement,{ usedAt: new Date(f.now()).toISOString(),code: replacement.credit_code }),1);
  assert.equal(f.store.detail(first.id).status,'paid');
});

test('legacy lookup failures are bounded and never expose database errors or issue payments', async () => {
  const code = `AC-${'a'.repeat(48)}`;
  const source = new RechargeSource(config(),{ pool: { async query() { throw new Error('secret database connection'); } } });
  await assert.rejects(source.inspectLegacyCredit(code),error => error.code === 'CREDIT_LEGACY_UNAVAILABLE' && !error.message.includes('secret'));
  assert.equal(source.active,0);
  source.active = 8;
  await assert.rejects(source.inspectLegacyCredit(code),{ code: 'SERVICE_BUSY' });
  assert.equal(source.active,8);
  await assert.rejects(source.inspectLegacyCredit('invalid'),{ code: 'CREDIT_LEGACY_REVIEW_REQUIRED' });
});

test('new payouts reject unsupported types, legacy codes and unmarked notes before calling the core', () => {
  const row = { id: 'reward',batch_id: 'batch',credit_type: 'balance',credit_code: `AC-${'a'.repeat(28)}` };
  row.credit_notes = creditNotes(row);
  const core = new CoreClient(config(),() => { throw new Error('must not call the core'); });
  for (const changed of [{ credit_type: 'affiliate_balance' },{ credit_code: `AC-${'a'.repeat(48)}` },{ credit_notes: legacyNotes(row) }]) {
    assert.throws(() => core.credit({ ...row,...changed }),{ code: 'CREDIT_CONTRACT_INVALID' });
  }
});

test('converted credits never reuse a cached native request key from earlier failed legacy attempts', async t => {
  const f = fixture(t); const old = legacy(f.store);
  f.store.db.prepare('UPDATE rewards SET attempts=8 WHERE id=?').run(old.id);
  const row = f.store.replaceLegacyCredit(f.store.claim(),32);
  const previous = new Set(Array.from({ length: 8 },(_,i) => `activity-${old.id}-${i+1}`));
  const keys = [];
  const core = new CoreClient(f.config,async (_url,options) => {
    const key = options.headers['idempotency-key'];
    assert.equal(previous.has(key),false); assert(key.length <= 128); keys.push(key);
    return new Response(JSON.stringify({ code: 0,data: {} }));
  });
  await core.credit(row); await core.credit({ ...row,attempts: 2 });
  assert.notEqual(keys[0],keys[1]); assert.equal(row.attempts,1);
});
