'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { RechargeSource, OFFICIAL_SQL } = require('../src/recharge-source');
const { CoreClient, requestJson } = require('../src/upstream');
const { config, fixture, USER } = require('./fixtures');

test('first startup excludes historical payments from chances and prize eligibility, even if credited later', async t => {
  const f = fixture(t,{ storeOptions: { now: () => Date.parse('2026-11-01T00:00:00Z'),rng: () => 9999 } });
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`CREATE TABLE payment_orders(user_id bigint,order_type text,paid_at timestamptz,completed_at timestamptz,
    status text,pay_amount numeric,amount numeric,refund_amount numeric DEFAULT 0,provider_snapshot jsonb);
    INSERT INTO payment_orders VALUES
      (42,'balance','2026-10-31T23:59:59.999Z','2026-11-02','COMPLETED',5000,5000,0,null);`);
  f.lottery.source = new RechargeSource(f.config,{ pool: db });
  assert.equal(f.store.campaign.start_at,'2026-11-01T00:00:00.000Z');
  assert.equal((await f.lottery.summary(USER.id)).available,0);
  await assert.rejects(f.lottery.draw(USER,crypto.randomUUID(),1),{ code: 'CHANCES_INSUFFICIENT' });
  await db.exec(`INSERT INTO payment_orders VALUES
    (42,'balance','2026-11-02','2026-11-02','COMPLETED',49.99,49.99,0,null);`);
  assert.equal((await f.lottery.summary(USER.id)).available,0);
  await db.exec(`INSERT INTO payment_orders VALUES
    (42,'balance','2026-11-01T00:00:00.000Z','2026-11-02','COMPLETED',0.01,0.01,0,null);`);
  assert.equal((await f.lottery.summary(USER.id)).available,1);
  const batch = await f.lottery.draw(USER,crypto.randomUUID(),1);
  assert.equal(batch.rewards[0].amountMinor,500);
  await f.lottery.kick();
  assert.equal((await f.lottery.summary(USER.id)).available,0);
});

test('real SQL uses paid CNY cash, net partial refunds, strict user/date/completion and excludes subscriptions/gifts', async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`CREATE TABLE payment_orders(user_id bigint,order_type text,paid_at timestamptz,completed_at timestamptz,
    status text,pay_amount numeric,amount numeric,refund_amount numeric DEFAULT 0,provider_snapshot jsonb);
    INSERT INTO payment_orders VALUES
      (42,'balance','2026-11-02',now(),'COMPLETED',50.01,100,0,'{"currency":"CNY"}'),
      (42,'balance','2026-11-02',now(),'PARTIALLY_REFUNDED',100,200,50,'{"currency":"CNY"}'),
      (42,'balance','2026-11-02',now(),'REFUNDED',100,100,100,'{"currency":"CNY"}'),
      (42,'subscription','2026-11-02',now(),'COMPLETED',999,999,0,null),
      (42,'balance','2026-10-02',now(),'COMPLETED',999,999,0,null),
      (42,'balance','2026-11-02',null,'PAID',999,999,0,null),
      (99,'balance','2026-11-02',now(),'COMPLETED',999,999,0,null),
      (42,'balance','2026-11-02',now(),'REFUNDING',999,999,0,null),
      (42,'balance','2026-11-02',now(),'COMPLETED',5.99,5.99,0,null);`);
  const source = new RechargeSource(config(),{ pool: db });
  assert.equal(await source.total('42','2026-11-01T00:00:00.000Z'),13100);
  assert.match(OFFICIAL_SQL,/^SELECT/);
  await db.exec(`INSERT INTO payment_orders VALUES (42,'balance','2026-11-02',now(),'COMPLETED',100,100,0,'{"currency":"USD"}')`);
  await assert.rejects(source.total('42','2026-11-01T00:00:00.000Z'),{ code: 'RECHARGE_CURRENCY_UNSUPPORTED' });
});

test('both recharge sources add independent verified cash and failures prevent partial chance grants', async () => {
  const cfg = config({ sources: ['official','recharge_center'],rechargeUrl: 'http://localhost:9874',rechargeToken: 'synthetic-token' });
  let fail = false;
  const source = new RechargeSource(cfg,{ pool: { async query() { return { rows: [{ total_minor: '5001',foreign_count: '0' }] }; } },
    fetchImpl: async (url,options) => {
      assert.match(String(url),/user_id=42/); assert.equal(options.headers.authorization,'Bearer synthetic-token');
      return new Response(JSON.stringify(fail ? { error: {} } : { version: 1,userId: '42',since: '2026-11-01T00:00:00.000Z',currency: 'CNY',totalMinor: '4999' }),{ status: fail ? 503 : 200 });
    } });
  assert.equal(await source.total('42','2026-11-01T00:00:00.000Z'),10000);
  fail = true; await assert.rejects(source.total('42','2026-11-01T00:00:00.000Z'));
});

test('wrong identity, currency, start date and unsafe totals from recharge integration are rejected', async () => {
  for (const override of [{ userId: '99' },{ currency: 'USD' },{ since: '2020-01-01' },{ totalMinor: '-1' },{ totalMinor: '1.5' },{ totalMinor: '9007199254740992' },{ version: 2 }]) {
    const source = new RechargeSource(config({ sources: ['recharge_center'],rechargeUrl: 'http://localhost',rechargeToken: 'test' }),{
      fetchImpl: async () => new Response(JSON.stringify({ version: 1,userId: '42',since: '2026-11-01T00:00:00.000Z',currency: 'CNY',totalMinor: '5000',...override }))
    });
    await assert.rejects(source.total('42','2026-11-01T00:00:00.000Z'));
  }
});

test('credit uses only the native fixed-code contract and bounded errors never expose keys or upstream bodies', async () => {
  const cfg = config(); let received;
  const core = new CoreClient(cfg,async (url,options) => { received = { url,options }; return new Response(JSON.stringify({ code: 0,data: { redeem_code: {} } })); });
  await core.credit({ id: 'reward',attempts: 2,credit_code: 'AC-secret',amount_minor: 50,user_id: '42',batch_id: 'batch' });
  assert.match(received.url,/\/api\/v1\/admin\/redeem-codes\/create-and-redeem$/);
  assert.equal(received.options.headers['x-api-key'],cfg.adminKey);
  assert.equal(received.options.headers['idempotency-key'],'activity-reward-2');
  assert.deepEqual(JSON.parse(received.options.body),{ code: 'AC-secret',type: 'balance',value: 0.5,user_id: 42,notes: '活动奖励; activity=recharge-lottery; reward=reward; batch=batch' });
  for (const response of [new Response('x'.repeat(300000)),new Response('not json'),new Response(JSON.stringify({ error: { message: 'secret password' } }),{ status: 500 })]) {
    await assert.rejects(requestJson('http://localhost',{},1000,async () => response),error => !error.message.includes('secret'));
  }
});
