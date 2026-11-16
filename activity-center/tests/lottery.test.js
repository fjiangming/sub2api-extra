'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { PRIZES, sample } = require('../src/prizes');
const { Store, day } = require('../src/store');
const { fixture, config, USER } = require('./fixtures');

for (const [total,weights] of [
  [0,[5100,2400,1100,800,600,0,0,0]], [99999,[5100,2400,1100,800,600,0,0,0]],
  [100000,[4600,2400,1100,800,600,500,0,0]], [199999,[4600,2400,1100,800,600,500,0,0]],
  [200000,[4200,2400,1100,800,600,500,400,0]], [499999,[4200,2400,1100,800,600,500,400,0]],
  [500000,[4000,2400,1100,800,600,500,400,200]]
]) test(`all 10000 random outcomes match exact distribution at ${total} cents`, () => {
  const counts = PRIZES.map(() => 0);
  for (let roll = 0; roll < 10000; roll++) counts[PRIZES.findIndex(p => p.amount === sample(total, () => roll))]++;
  assert.deepEqual(counts,weights);
  if (total === 500000) assert.equal(PRIZES.reduce((sum,p,i) => sum+p.amount*counts[i],0)/10000,350);
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

for (const [field,value] of [['code','wrong-code'],['type','admin_balance'],['status','unused'],['used_by',999],['value',0.51],['id',null],['used_at','invalid'],['notes','unrelated credit']]) {
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
  assert.doesNotMatch(data,/weight|minimum|threshold|probability|recharge_minor|credit_code|receipt|user_email|example\.test|AC-/);
});

test('persistent campaign start and chance usage survive restart; scope changes refuse startup', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'activity-restart-'));
  const filename = path.join(directory,'test.sqlite'); const cfg = config();
  try {
    const first = new Store(cfg,{ filename,now: () => Date.parse('2026-11-01T00:00:00Z') });
    first.reserve(USER,crypto.randomUUID(),1,5000); first.close();
    const second = new Store(cfg,{ filename,now: () => Date.parse('2026-11-16T00:00:00Z') });
    assert.equal(second.campaign.start_at,'2026-11-01T00:00:00.000Z'); assert.equal(second.used(USER.id),1); second.close();
    for (const change of [{ timezone: 'UTC' },{ sources: ['recharge_center'] },{ sub2apiBaseUrl: 'http://another.example.test' }]) {
      assert.throws(() => new Store({ ...cfg,...change },{ filename }),/不能直接更改/);
    }
  } finally { fs.rmSync(directory,{ recursive: true,force: true }); }
});

test('paused activities issue no new results', t => {
  const f = fixture(t,{ config: { enabled: false } });
  assert.throws(() => f.store.reserve(USER,crypto.randomUUID(),1,5000),{ code: 'ACTIVITY_UNAVAILABLE' });
  assert.equal(f.store.used(USER.id),0);
});
