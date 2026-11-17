'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { RechargeSource } = require('../src/recharge-source');
const { CoreClient, requestJson } = require('../src/upstream');
const { config, fixture, USER } = require('./fixtures');

async function database(t) {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`CREATE TABLE redeem_codes(id bigserial PRIMARY KEY,used_by bigint,type text,value numeric,
    used_at timestamptz,created_at timestamptz,status text,code text,notes text)`);
  return db;
}

function credit(db, extra = {}) {
  const row = { user: '42', type: 'balance', value: '50', usedAt: '2026-11-02T00:00:00Z',
    createdAt: '2026-10-01T00:00:00Z', status: 'used', code: 'paid-balance', notes: null, ...extra };
  return db.query(`INSERT INTO redeem_codes(used_by,type,value,used_at,created_at,status,code,notes)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [row.user,row.type,row.value,row.usedAt,row.createdAt,row.status,row.code,row.notes]);
}

test('first startup filters by redemption time and excludes historical credits from chances and prize eligibility', async t => {
  const f = fixture(t,{ storeOptions: { now: () => Date.parse('2026-11-01T00:00:00Z'),rng: () => 9999 } });
  const db = await database(t);
  await credit(db,{ value: '5000',usedAt: '2026-10-31T23:59:59.999Z',createdAt: '2026-11-02' });
  f.lottery.source = new RechargeSource(f.config,{ pool: db });
  assert.equal(f.store.campaign.start_at,'2026-11-01T00:00:00.000Z');
  assert.equal((await f.lottery.summary(USER.id)).available,0);
  await assert.rejects(f.lottery.draw(USER,crypto.randomUUID(),1),{ code: 'CHANCES_INSUFFICIENT' });
  await credit(db,{ value: '49.99' });
  assert.equal((await f.lottery.summary(USER.id)).available,0);
  await credit(db,{ value: '0.01',usedAt: '2026-11-01T00:00:00.000Z' });
  assert.equal((await f.lottery.summary(USER.id)).available,1);
  const batch = await f.lottery.draw(USER,crypto.randomUUID(),1);
  assert.equal(batch.rewards[0].amountMinor,500);
  await f.lottery.kick();
  assert.equal((await f.lottery.summary(USER.id)).available,0);
});

test('redemption face values match the operations balance-credit basis, net adjustments and never add payments', async t => {
  const db = await database(t);
  await credit(db,{ code: 'PAY-42',value: '50.01' });
  await credit(db,{ type: 'admin_balance',value: '24.99' });
  await credit(db,{ type: 'admin_balance',value: '-5' });
  for (const extra of [{ user: '99' },{ user: '1' },{ user: null },{ usedAt: null },{ usedAt: '2099-01-01' },
    { status: 'unused' },{ status: 'disabled' },{ status: 'expired' },{ type: 'concurrency' },
    { type: 'admin_concurrency' },{ type: 'subscription' },{ type: 'invitation' }]) await credit(db,extra);
  await db.exec(`CREATE TABLE payment_orders(user_id bigint,recharge_code text,pay_amount numeric,status text);
    INSERT INTO payment_orders VALUES (42,'PAY-42',30,'COMPLETED'),(42,'NO-CREDIT',1000,'COMPLETED')`);
  const source = new RechargeSource(config(),{ pool: db });
  assert.equal(await source.total('42','2026-11-01T00:00:00.000Z'),7000);
  assert.equal(await source.total('1','2026-11-01T00:00:00.000Z'),0);
});

test('only complete activity reward markers exclude a credit, matching operations gift detection', async t => {
  const db = await database(t);
  const code = 'AC-' + 'a'.repeat(48);
  const notes = '活动奖励; activity=recharge-lottery; reward=11111111-1111-4111-8111-111111111111; batch=22222222-2222-4222-8222-222222222222';
  await credit(db,{ code,notes,value: '50' });
  await credit(db,{ notes,value: '20' });
  await credit(db,{ code,value: '10' });
  const source = new RechargeSource(config(),{ pool: db });
  assert.equal(await source.total('42','2026-11-01T00:00:00.000Z'),3000);
});

test('reward redemptions cannot fund further draws and negative adjustments retain consumed chances', async t => {
  const f = fixture(t,{ storeOptions: { now: () => Date.parse('2026-11-01T00:00:00Z') } });
  const db = await database(t);
  f.lottery.source = new RechargeSource(f.config,{ pool: db });
  const original = f.core.credit.bind(f.core);
  f.core.credit = async row => {
    const result = await original(row), receipt = result.redeem_code;
    await credit(db,{ type: receipt.type,code: receipt.code,notes: receipt.notes,value: String(receipt.value),usedAt: receipt.used_at });
    return result;
  };
  await credit(db);
  await f.lottery.draw(USER,crypto.randomUUID(),1); await f.lottery.kick();
  assert.equal(f.store.summary(USER.id,5000).creditedMinor,50);
  assert.equal([...f.credited.values()][0].type,'affiliate_balance');
  assert.equal(f.store.ledgerSummary().totalMinor,50);
  assert.equal(await f.lottery.source.total(USER.id,f.store.campaign.start_at),5000);
  assert.equal((await f.lottery.summary(USER.id)).available,0);
  await credit(db,{ type: 'admin_balance',value: '-100' });
  assert.equal(await f.lottery.source.total(USER.id,f.store.campaign.start_at),0);
  assert.equal(f.store.used(USER.id),1);
  await credit(db,{ value: '100' });
  assert.equal((await f.lottery.summary(USER.id)).available,0);
  await credit(db);
  assert.equal((await f.lottery.summary(USER.id)).available,1);
});

test('subsidy mentions anywhere cannot grant chances or unlock higher prizes while normal notes still count', async t => {
  const f = fixture(t,{ storeOptions: { now: () => Date.parse('2026-11-01T00:00:00Z'),rng: () => 9999 } });
  const db = await database(t);
  f.lottery.source = new RechargeSource(f.config,{ pool: db });
  await credit(db,{ value: '49.99',notes: '正常充值' });
  await credit(db,{ value: '5000',notes: '系统补贴到账' });
  await credit(db,{ type: 'admin_balance',value: '2000',notes: '余额补贴' });
  await credit(db,{ type: 'admin_balance',value: '-5',notes: '[补贴] 补贴纠错' });
  await credit(db,{ value: '50',notes: '[补贴说明] 额外赠送' });
  await credit(db,{ value: '100',notes: '本单不含补贴' });
  assert.equal(await f.lottery.source.total(USER.id,f.store.campaign.start_at),4999);
  assert.equal((await f.lottery.summary(USER.id)).available,0);
  await assert.rejects(f.lottery.draw(USER,crypto.randomUUID(),1),{ code: 'CHANCES_INSUFFICIENT' });
  await credit(db,{ value: '0.01',notes: '' });
  assert.equal((await f.lottery.summary(USER.id)).available,1);
  const batch = await f.lottery.draw(USER,crypto.randomUUID(),1);
  assert.equal(batch.rewards[0].amountMinor,500);
  await f.lottery.kick();
  assert.equal((await f.lottery.summary(USER.id)).available,0);
});

test('affiliate transfers cannot fund draws or unlock prizes through history rows, balances or recharge totals', async t => {
  const f = fixture(t,{ storeOptions: { now: () => Date.parse('2026-11-01T00:00:00Z'),rng: () => 9999 } });
  const db = await database(t);
  await db.exec(`CREATE TABLE users(id bigint,balance numeric,total_recharged numeric);
    CREATE TABLE user_affiliate_ledger(id bigint,user_id bigint,action text,amount numeric,created_at timestamptz);
    INSERT INTO users VALUES(42,10049.99,10049.99);
    INSERT INTO user_affiliate_ledger VALUES(1,42,'transfer',5000,'2026-11-02');`);
  f.lottery.source = new RechargeSource(f.config,{ pool: db });
  await credit(db,{ type: 'affiliate_balance',code: 'AFF-1',value: '5000',notes: null });
  await credit(db,{ type: 'affiliate_balance',code: 'AFF-2',value: '-100',notes: '' });
  await credit(db,{ value: '49.99' });
  assert.equal(await f.lottery.source.total(USER.id,f.store.campaign.start_at),4999);
  assert.equal((await f.lottery.summary(USER.id)).available,0);
  await assert.rejects(f.lottery.draw(USER,crypto.randomUUID(),1),{ code: 'CHANCES_INSUFFICIENT' });
  await credit(db,{ type: 'admin_balance',value: '0.01' });
  assert.equal((await f.lottery.summary(USER.id)).available,1);
  const batch = await f.lottery.draw(USER,crypto.randomUUID(),1);
  assert.equal(batch.rewards[0].amountMinor,500);
  await f.lottery.kick();
  assert.equal((await f.lottery.summary(USER.id)).available,0);
  assert.equal((await db.query('SELECT balance::text FROM users WHERE id=42')).rows[0].balance,'10049.99');
  assert.equal((await db.query('SELECT amount::text FROM user_affiliate_ledger WHERE id=1')).rows[0].amount,'5000');
});

test('sub-cent credits accumulate precisely and cannot round an incomplete threshold into a chance', async t => {
  const db = await database(t);
  const source = new RechargeSource(config(),{ pool: db });
  await credit(db,{ value: '49.99999999' });
  assert.equal(await source.total('42','2026-11-01T00:00:00.000Z'),4999);
  await credit(db,{ value: '0.00000001' });
  assert.equal(await source.total('42','2026-11-01T00:00:00.000Z'),5000);
});

test('source failures and unsafe database totals cannot grant chances or expose upstream errors', async t => {
  for (const value of [undefined,'-1','1.5','NaN','9007199254740992']) {
    const source = new RechargeSource(config(),{ pool: { async query() { return { rows: [{ total_minor: value }] }; } } });
    await assert.rejects(source.total('42','2026-11-01T00:00:00.000Z'),{ code: 'RECHARGE_UNVERIFIED' });
  }
  const f = fixture(t);
  f.lottery.source = new RechargeSource(f.config,{ pool: { async query() { throw new Error('secret connection'); } } });
  await assert.rejects(f.lottery.draw(USER,crypto.randomUUID(),1),error => error.code === 'RECHARGE_UNAVAILABLE' && !error.message.includes('secret'));
  assert.equal(f.store.used(USER.id),0);
});

test('credit uses only the native fixed-code contract and bounded errors never expose keys or upstream bodies', async () => {
  const cfg = config(); let received;
  const core = new CoreClient(cfg,async (url,options) => { received = { url,options }; return new Response(JSON.stringify({ code: 0,data: { redeem_code: {} } })); });
  await core.credit({ id: 'reward',attempts: 2,credit_code: 'AC-secret',credit_type: 'affiliate_balance',amount_minor: 50,user_id: '42',batch_id: 'batch' });
  assert.match(received.url,/\/api\/v1\/admin\/redeem-codes\/create-and-redeem$/);
  assert.equal(received.options.headers['x-api-key'],cfg.adminKey);
  assert.equal(received.options.headers['idempotency-key'],'activity-reward-2');
  assert.deepEqual(JSON.parse(received.options.body),{ code: 'AC-secret',type: 'affiliate_balance',value: 0.5,user_id: 42,notes: '活动奖励; activity=recharge-lottery; reward=reward; batch=batch' });
  for (const response of [new Response('x'.repeat(300000)),new Response('not json'),new Response(JSON.stringify({ error: { message: 'secret password' } }),{ status: 500 })]) {
    await assert.rejects(requestJson('http://localhost',{},1000,async () => response),error => !error.message.includes('secret'));
  }
});
