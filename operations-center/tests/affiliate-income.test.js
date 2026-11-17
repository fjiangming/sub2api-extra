'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { AccountingStore } = require('../src/accounting-store');
const { CostLedgerStore } = require('../src/cost-ledger-store');
const { AccountingService } = require('../src/services/accounting-service');
const { CashFlowService } = require('../src/services/cash-flow-service');
const { CostAnalysisService } = require('../src/services/cost-analysis-service');
const { isNonRechargeCredit } = require('../src/services/recharge-credit');

test('affiliate transfers and activity rewards are excluded from real SQL cash flow, accounting and legacy income without altering balances', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'affiliate-income-'));
  const database = new PGlite();
  const config = { financeTimezone: 'Asia/Shanghai', databaseUrl: 'postgres://synthetic@local.invalid/affiliate-test' };
  const store = new AccountingStore(directory, AccountingService.scope(config)); store.initialize();
  const ledger = new CostLedgerStore(directory); await ledger.initialize();
  const tables = ['users', 'redeem_codes', 'payment_orders', 'usage_logs'];
  const inspector = {
    inspect: async () => ({ tables: Object.fromEntries(tables.map(name => [name, { exists: true }])) }),
    requireTables: async names => names.filter(name => !tables.includes(name))
  };
  const pool = { query: (sql, params) => database.query(sql, params) };
  const now = () => new Date('2026-11-02T04:00:00Z');
  const accounting = new AccountingService({ pool, inspector, config, store, ledger, now });
  const cash = new CashFlowService({ pool, inspector, config, store, ledger, accounting, now });
  const analysis = new CostAnalysisService({ pool, inspector, config, store: ledger,
    providerMonitor: { configured: () => false }, sub2api: { configured: () => false } });
  t.after(async () => { await cash.stop(); store.close(); await database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await database.exec(`
    CREATE TABLE users(id bigint PRIMARY KEY,email text,username text,balance numeric,total_recharged numeric,
      deleted_at timestamptz,created_at timestamptz);
    CREATE TABLE redeem_codes(id bigint,used_by bigint,type text,status text,value numeric,used_at timestamptz,
      code text,notes text,created_at timestamptz);
    CREATE TABLE payment_orders(id bigint,user_id bigint,amount numeric,pay_amount numeric,order_type text,
      paid_at timestamptz,completed_at timestamptz,refund_at timestamptz,refund_amount numeric,status text,recharge_code text);
    CREATE TABLE usage_logs(user_id bigint,billing_type integer,actual_cost numeric,created_at timestamptz);
    CREATE TABLE user_affiliate_ledger(id bigint,user_id bigint,action text,amount numeric,created_at timestamptz);
    INSERT INTO users VALUES(2,'customer@example.test','Customer',5165.5,5165.5,NULL,'2026-10-01');
    INSERT INTO user_affiliate_ledger VALUES(1,2,'transfer',5000,'2026-10-02');
    INSERT INTO redeem_codes VALUES
      (1,2,'balance','used',100,'2026-10-02','paid-100',NULL,'2026-10-01'),
      (2,2,'admin_balance','used',20,'2026-10-02','admin-20','','2026-10-01'),
      (3,2,'admin_balance','used',-5,'2026-10-02','correction-5','','2026-10-01'),
      (4,2,'affiliate_balance','used',5000,'2026-10-02','AFF-1',NULL,'2026-10-01'),
      (5,2,'affiliate_balance','used',-100,'2026-10-02','AFF-2','','2026-10-01'),
      (6,2,'affiliate_balance','used',0.5,'2026-10-02','AC-${'a'.repeat(48)}','活动奖励; activity=recharge-lottery; reward=11111111-1111-4111-8111-111111111111; batch=22222222-2222-4222-8222-222222222222','2026-10-01'),
      (7,2,'balance','used',50,'2026-10-02','AC-${'b'.repeat(28)}','活动奖励补贴; activity=recharge-lottery; reward=33333333-3333-4333-8333-333333333333; batch=44444444-4444-4444-8444-444444444444','2026-10-01');`);

  const range = { start: '2026-10-01', end: '2026-10-31', include_consumption: '0' };
  const collected = await accounting.source.collectDay('2026-10-02');
  assert.equal(collected.complete,true);
  const documents = store.documents();
  assert.deepEqual(new Set(documents.map(row => row.key)),new Set(['redeem:1','redeem:2','redeem:3','redeem:7']));
  assert.equal(isNonRechargeCredit(documents.find(row => row.key === 'redeem:7')),true);
  const report = await cash.getReport(range);
  assert.equal(report.source.complete,true);
  assert.equal(report.summary.income,115); assert.equal(report.cumulative.income,115);
  assert.equal(report.cumulative.userBalance,5165.5);
  assert.equal(report.items.length,3);
  for (const service of [cash,accounting]) {
    assert.equal((await service.creditUsers(range)).summary.totalIncome,115);
    const records = await service.creditUsers(range,'2');
    assert.equal(records.summary.transactions,3);
    assert.equal(records.summary.totalIncome,115);
    assert.deepEqual(new Set(records.items.map(row => row.id)),new Set(['1','2','3']));
  }
  const legacy = await analysis.getReport(range);
  assert.equal(legacy.summary.automaticRevenue,115); assert.equal(legacy.summary.transactions,3);
  assert.equal(legacy.summary.userBalance,5165.5);
  assert.equal((await analysis.getAutomaticIncomeUsers(range)).summary.totalIncome,115);
  const records = await analysis.getAutomaticIncomeRecords('2',range);
  assert.equal(records.summary.totalIncome,115);
  assert.deepEqual(new Set(records.items.map(row => row.id)),new Set(['1','2','3']));

  store.close(); store.initialize();
  await cash.sync({ force: true });
  assert.equal((await cash.getReport(range)).cumulative.income,115);
  assert.equal((await accounting.creditUsers(range)).summary.totalIncome,115);
  assert.equal((await database.query('SELECT amount::text FROM user_affiliate_ledger WHERE id=1')).rows[0].amount,'5000');
  const user = (await database.query('SELECT balance::text,total_recharged::text FROM users WHERE id=2')).rows[0];
  assert.deepEqual(user,{ balance: '5165.5',total_recharged: '5165.5' });
});
