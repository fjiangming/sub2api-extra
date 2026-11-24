'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { PRIZES, sample } = require('../src/prizes');
const { Store, day } = require('../src/store');
const { Lottery } = require('../src/lottery');
const { CoreClient } = require('../src/upstream');
const { legacyNotes, creditNotes } = require('../src/reward-credit');
const { fixture, config, USER } = require('./fixtures');

for (const [total,weights] of [
  [0,[6300,2000,1000,500,200,0,0,0]], [99999,[6300,2000,1000,500,200,0,0,0]],
  [100000,[5800,2000,1000,500,200,500,0,0]], [199999,[5800,2000,1000,500,200,500,0,0]],
  [200000,[5400,2000,1000,500,200,500,400,0]], [499999,[5400,2000,1000,500,200,500,400,0]],
  [500000,[5200,2000,1000,500,200,500,400,200]]
]) test(`all 10000 random outcomes match exact distribution at ${total} cents`, () => {
  const counts = PRIZES.map(() => 0);
  for (let roll = 0; roll < 10000; roll++) counts[PRIZES.findIndex(p => p.amount === sample(total, () => roll))]++;
  assert.deepEqual(counts,weights);
  if (total === 500000) assert.equal(PRIZES.reduce((sum,p,i) => sum+p.amount*counts[i],0)/10000,321);
});

test('fractional successful recharge carries across draws, without creating chances from rewards', async t => {
  const f = fixture(t);
  f.source.value = 4999;
  await assert.rejects(f.lottery.draw(USER,crypto.randomUUID(),1),{ code: 'CHANCES_INSUFFICIENT' });
  f.source.value = 5001;
  await f.lottery.draw(USER,crypto.randomUUID(),1); await f.lottery.kick();
  assert.equal((await f.lottery.summary(USER.id)).available,0);
  f.source.value = 10000;
  assert.equal((await f.lottery.summary(USER.id)).available,1);
  await f.lottery.draw(USER,crypto.randomUUID(),1); await f.lottery.kick();
  assert.equal(f.store.used(USER.id),2);
  assert.equal(f.store.summary(USER.id,10000).creditedMinor,100);
  assert.equal(f.credited.size,2);
});

test('atomic batches reserve exactly 10, 20, or 50 independent results', t => {
  const f = fixture(t);
  for (const count of [10,20,50]) {
    const batch = f.store.reserve(USER,crypto.randomUUID(),count,500000);
    assert.equal(batch.rewards.length,count);
    assert.deepEqual(batch.rewards.map(r => r.sequence),Array.from({ length: count },(_,i) => i+1));
  }
  assert.equal(f.store.used(USER.id),80);
  assert.equal(new Set(f.store.db.prepare('SELECT credit_code FROM rewards').all().map(r => r.credit_code)).size,80);
});

test('sampling failure rolls back chance reservation and the whole batch', t => {
  let calls = 0;
  const f = fixture(t,{ storeOptions: { rng: () => ++calls === 5 ? 10000 : 0 } });
  assert.throws(() => f.store.reserve(USER,crypto.randomUUID(),10,500000));
  assert.equal(f.store.used(USER.id),0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM batches').get().n,0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM rewards').get().n,0);
});

test('concurrent independent requests cannot overspend the last chance', async t => {
  const f = fixture(t); f.source.value = 5000;
  const results = await Promise.allSettled(Array.from({ length: 12 },() => f.lottery.draw(USER,crypto.randomUUID(),1)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length,1);
  assert.equal(f.store.used(USER.id),1); await f.lottery.kick(); assert.equal(f.credited.size,1);
});

test('concurrent identical requests and outage retries return the original draw', async t => {
  const f = fixture(t); const request = crypto.randomUUID();
  const results = await Promise.all(Array.from({ length: 6 },() => f.lottery.draw(USER,request,10)));
  assert.equal(new Set(results.map(r => r.id)).size,1);
  assert.equal(f.store.used(USER.id),10);
  f.source.error = new Error('synthetic outage');
  assert.equal((await f.lottery.draw(USER,request,10)).id,results[0].id);
  await assert.rejects(f.lottery.draw(USER,request,1),{ code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(f.lottery.draw(USER,crypto.randomUUID(),1));
  assert.equal(f.store.used(USER.id),10);
});

test('ambiguous credit responses recover with the same fixed code and credit only once', async t => {
  const f = fixture(t); const original = f.core.credit.bind(f.core); let lose = true;
  f.core.credit = async row => { const result = await original(row); if (lose) { lose = false; throw new Error('lost response after committing'); } return result; };
  const batch = await f.lottery.draw(USER,crypto.randomUUID(),1); await f.lottery.kick();
  assert.equal(f.store.batch(USER.id,batch.id).rewards[0].status,'pending');
  assert.equal(f.store.ledgerSummary().totalMinor,0); assert.equal(f.credited.size,1);
  f.advance(60000); await f.lottery.kick();
  assert.equal(f.store.batch(USER.id,batch.id).rewards[0].status,'paid');
  assert.equal(f.credited.size,1); assert.equal(f.attempts.length,2);
  assert.equal(f.attempts[0].credit_code,f.attempts[1].credit_code);
  assert.equal(f.store.ledgerSummary().totalMinor,50);
});

test('legacy reward migration preserves balance receipts, lost-response retries and consumed chances', async t => {
  const f = fixture(t);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'activity-credit-migration-'));
  const filename = path.join(directory,'test.sqlite');
  const cfg = config();
  let store = new Store(cfg,{ filename,now: f.now,rng: () => 0 });
  let lottery;
  t.after(async () => { await lottery?.close(); store.close(); fs.rmSync(directory,{ recursive: true,force: true }); });
  const originalStart = store.campaign.start_at;
  const requests = Array.from({ length: 3 },() => crypto.randomUUID());
  const batches = requests.map(id => store.reserve(USER,id,1,500000));
  for (const row of store.db.prepare('SELECT * FROM rewards').all()) {
    store.db.prepare("UPDATE rewards SET credit_type='balance',credit_code=?,credit_notes=? WHERE id=?")
      .run(`AC-${crypto.randomBytes(24).toString('hex')}`,legacyNotes(row),row.id);
  }
  const paid = store.claim();
  const paidReceipt = (await f.core.credit(paid)).redeem_code;
  store.settle(paid,{ usedAt: paidReceipt.used_at,type: paidReceipt.type });
  const lost = store.claim();
  await f.core.credit(lost);
  store.fail(lost,'CREDIT_UNAVAILABLE',false);
  const failed = store.claim();
  store.fail(failed,'CREDIT_RECEIPT_UNVERIFIED',true);
  // Reproduce the deployed v1 schema, including pending, failed and paid records.
  store.db.exec('ALTER TABLE rewards DROP COLUMN credit_type; ALTER TABLE rewards DROP COLUMN credit_notes; ALTER TABLE rewards DROP COLUMN credit_migration; PRAGMA user_version=1;');
  const oldRows = store.db.prepare('SELECT * FROM rewards ORDER BY id').all();
  store.close();
  store = new Store(cfg,{ filename,now: f.now,rng: () => { throw new Error('old outcomes must not be resampled'); } });
  assert.equal(store.db.pragma('user_version',{ simple: true }),5);
  assert.equal(store.campaign.start_at,originalStart);
  assert.equal(store.used(USER.id),3);
  assert.deepEqual(store.db.prepare('SELECT * FROM rewards ORDER BY id').all(),oldRows.map(row => ({ ...row,credit_type: 'balance',credit_notes: legacyNotes(row),credit_migration: null })));
  requests.forEach((id,i) => assert.equal(store.existing(USER.id,id,1).id,batches[i].id));
  assert.equal(store.ledgerSummary().totalMinor,50);
  f.advance(60000);
  lottery = new Lottery(store,f.source,f.core);
  await lottery.kick();
  assert.equal(store.detail(lost.id).status,'paid');
  assert.equal(f.credited.size,2);
  assert.equal(f.attempts.filter(row => row.credit_code === lost.credit_code).length,1);
  assert.ok(f.attempts.every(row => row.credit_type === 'balance'));
  store.retry(failed.id,'1'); await lottery.kick();
  assert.equal(store.detail(failed.id).status,'paid');
  assert.equal(f.credited.size,3);
  store.rng = () => 0;
  const fresh = await lottery.draw(USER,crypto.randomUUID(),1); await lottery.kick();
  assert.equal(store.detail(fresh.rewards[0].id).receipt.type,'balance');
  assert.equal(store.ledgerSummary().totalMinor,200);
  assert.equal(f.credited.size,4);
  const allRows = store.db.prepare('SELECT * FROM rewards ORDER BY id').all();
  await lottery.close(); store.close();
  store = new Store(cfg,{ filename,now: f.now });
  assert.deepEqual(store.db.prepare('SELECT * FROM rewards ORDER BY id').all(),allRows);
  assert.equal(store.campaign.start_at,originalStart);
  assert.equal(store.used(USER.id),4);
});

test('the original 32-character core accepts new balance rewards and lost responses reuse the same subsidy code', async t => {
  const f = fixture(t); const payloads = [];
  const native = new Map();
  f.lottery.core = new CoreClient(f.config,async (_url,options) => {
    const input = JSON.parse(options.body); payloads.push(input);
    assert.equal(input.type,'balance'); assert.equal(input.code.length,31); assert.match(input.notes,/补贴/);
    if (!native.has(input.code)) native.set(input.code,{ id: 1,...input,status: 'used',used_by: input.user_id,used_at: new Date(f.now()).toISOString() });
    if (payloads.length === 1) throw new Error('response lost after native commit');
    return new Response(JSON.stringify({ code: 0,data: { redeem_code: native.get(input.code) } }));
  });
  const batch = await f.lottery.draw(USER,crypto.randomUUID(),1); await f.lottery.kick();
  assert.equal(f.store.detail(batch.rewards[0].id).status,'pending');
  f.advance(60000); await f.lottery.kick();
  assert.equal(payloads.length,2);
  assert.ok(payloads.every(row => row.type === 'balance'));
  assert.equal(payloads[0].code,payloads[1].code);
  assert.equal(f.store.used(USER.id),1);
  assert.equal(f.store.detail(batch.rewards[0].id).status,'paid');
  assert.equal(f.store.ledgerSummary().totalMinor,50); assert.equal(native.size,1);
  assert.equal(payloads[0].notes,creditNotes(f.store.db.prepare('SELECT * FROM rewards').get()));
});

for (const [field,value] of [['code','wrong-code'],['type','affiliate_balance'],['status','unused'],['used_by',999],['value',0.51],['id',null],['used_at','invalid'],['notes','unrelated credit']]) {
  test(`unverified receipt ${field} cannot enter sent totals and admin recovery preserves prize`, async t => {
    const f = fixture(t); const original = f.core.credit.bind(f.core);
    f.core.credit = async row => { const result = await original(row); result.redeem_code[field] = value; return result; };
    const batch = await f.lottery.draw(USER,crypto.randomUUID(),1); await f.lottery.kick();
    const id = batch.rewards[0].id;
    assert.equal(f.store.detail(id).status,'failed'); assert.equal(f.store.ledgerSummary().totalMinor,0);
    f.core.credit = original; f.store.retry(id,'1'); await f.lottery.kick();
    assert.equal(f.store.detail(id).status,'paid'); assert.equal(f.store.detail(id).amountMinor,50);
    assert.equal(f.store.detail(id).retries[0].actorId,'1'); assert.equal(f.credited.size,1);
    assert.throws(() => f.store.retry(id,'1'),{ code: 'RETRY_NOT_ALLOWED' });
  });
}

test('expired worker leases are reclaimable and stale attempts cannot settle newer work', t => {
  const f = fixture(t);
  f.store.reserve(USER,crypto.randomUUID(),1,5000);
  const first = f.store.claim(); assert.equal(f.store.claim(),null);
  f.advance(60001); const second = f.store.claim();
  assert.equal(first.credit_code,second.credit_code); assert.equal(second.attempts,2);
  const receipt = { usedAt: new Date(f.now()).toISOString() };
  assert.equal(f.store.settle(first,receipt),0);
  assert.equal(f.store.settle(second,receipt),1);
  f.store.fail(first,'LATE_FAILURE',true);
  assert.equal(f.store.detail(first.id).status,'paid');
});

test('sent totals use verified native credit time, independent of filters and exclude pending and failed', async t => {
  const f = fixture(t); const original = f.core.credit.bind(f.core);
  f.core.credit = async row => { const result = await original(row); result.redeem_code.used_at = '2026-11-15T15:59:59Z'; return result; };
  await f.lottery.draw(USER,crypto.randomUUID(),1); await f.lottery.kick();
  const pending = f.store.reserve({ ...USER,id: '99' },crypto.randomUUID(),1,5000);
  f.store.db.prepare("UPDATE rewards SET status='failed' WHERE id=?").run(pending.rewards[0].id);
  f.store.reserve(USER,crypto.randomUUID(),1,10000);
  const sums = f.store.ledgerSummary();
  assert.equal(sums.totalMinor,50); assert.equal(sums.todayMinor,0); assert.equal(sums.recipients,1);
  assert.equal(sums.paidCount,1); assert.equal(sums.pendingCount,1); assert.equal(sums.failedCount,1);
  assert.equal(f.store.list({ query: 'example.test',status: 'paid' }).total,1);
  assert.equal(f.store.list({ from: '2026-11-17' }).total,0);
  assert.equal(day('2026-11-15T16:00:00Z','Asia/Shanghai'),'2026-11-16');
});

test('customer responses omit receipt, identity, private recharge snapshot and probability data', t => {
  const f = fixture(t); const batch = f.store.reserve(USER,crypto.randomUUID(),1,5000);
  assert.throws(() => f.store.batch('99',batch.id),{ status: 404 });
  const data = JSON.stringify({ registry: f.store.registry(),batch,history: f.store.list({ userId: USER.id }) });
  assert.doesNotMatch(data,/weight|minimum|threshold|probability|recharge_minor|credit_code|receipt|user_email|example\.test|AC-|audit|requiredMinor|rechargeMinor/);
});

test('persistent campaign start and chance usage survive restart; scope changes refuse startup', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'activity-restart-'));
  const filename = path.join(directory,'test.sqlite'); const cfg = config();
  try {
    const first = new Store(cfg,{ filename,now: () => Date.parse('2026-11-01T00:00:00Z') });
    first.reserve(USER,crypto.randomUUID(),1,5000); first.close();
    const second = new Store(cfg,{ filename,now: () => Date.parse('2026-11-16T00:00:00Z') });
    assert.equal(second.campaign.start_at,'2026-11-01T00:00:00.000Z'); assert.equal(second.used(USER.id),1); second.close();
    for (const change of [{ timezone: 'UTC' },{ sources: ['recharge_center'] },{ sub2apiBaseUrl: 'http://another.example.test' },
      { databaseUrl: 'postgres://synthetic:synthetic@another.example.test/test' }]) {
      assert.throws(() => new Store({ ...cfg,...change },{ filename }),/不能直接更改/);
    }
  } finally { fs.rmSync(directory,{ recursive: true,force: true }); }
});

test('legacy payment campaigns migrate once without resetting cutoff, consumed chances or reward history', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'activity-source-migration-'));
  try {
    for (const [index,legacySources,hadDatabase] of [[0,'official',true],[1,'recharge_center',true],
      [2,'official,recharge_center',true],[3,'recharge_center',false]]) {
      const filename = path.join(directory,`${index}.sqlite`);
      const cfg = config({ rechargeUrl: legacySources.includes('recharge_center') ? 'http://localhost:9874' : null });
      const first = new Store(cfg,{ filename,now: () => Date.parse('2026-11-01T00:00:00Z') });
      const batch = first.reserve(USER,crypto.randomUUID(),1,5000);
      const dbUrl = new URL(cfg.databaseUrl);
      const oldScope = crypto.createHash('sha256').update(JSON.stringify([
        cfg.sub2apiBaseUrl,hadDatabase ? `${dbUrl.host}${dbUrl.pathname}` : null,cfg.rechargeUrl
      ])).digest('hex');
      first.db.prepare('UPDATE campaign SET sources=?,source_scope=?').run(legacySources,oldScope);
      first.close();
      assert.throws(() => new Store({ ...cfg,timezone: 'UTC' },{ filename }),/不能直接更改/);
      assert.throws(() => new Store({ ...cfg,sub2apiBaseUrl: 'http://another.example.test' },{ filename }),/不能直接更改/);
      if (cfg.rechargeUrl) assert.throws(() => new Store({ ...cfg,rechargeUrl: null },{ filename }),/不能直接更改/);
      const migrated = new Store(cfg,{ filename,now: () => Date.parse('2026-11-16T00:00:00Z') });
      try {
        assert.equal(migrated.campaign.sources,'redemptions');
        assert.equal(migrated.campaign.start_at,'2026-11-01T00:00:00.000Z');
        assert.equal(migrated.used(USER.id),1);
        assert.deepEqual(migrated.batch(USER.id,batch.id),batch);
        assert.equal(migrated.ledgerSummary().pendingCount,1);
      } finally { migrated.close(); }
      const restarted = new Store({ ...cfg,rechargeUrl: null },{ filename,now: () => Date.parse('2026-11-17T00:00:00Z') });
      assert.equal(restarted.campaign.start_at,'2026-11-01T00:00:00.000Z');
      assert.equal(restarted.used(USER.id),1);
      restarted.close();
    }
  } finally { fs.rmSync(directory,{ recursive: true,force: true }); }
});

test('paused activities issue no new results', t => {
  const f = fixture(t,{ config: { enabled: false } });
  assert.throws(() => f.store.reserve(USER,crypto.randomUUID(),1,5000),{ code: 'ACTIVITY_UNAVAILABLE' });
  assert.equal(f.store.used(USER.id),0);
});
