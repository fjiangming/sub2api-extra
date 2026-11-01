'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { AccountingStore } = require('../src/accounting-store');
const { AccountingService, allocated } = require('../src/services/accounting-service');
const { AccountingSource } = require('../src/services/accounting-source');
const { SchemaInspector } = require('../src/schema-inspector');
const { CostAnalysisService } = require('../src/services/cost-analysis-service');
const { DailyProfitStore } = require('../src/daily-profit-store');
const { DailyProfitService } = require('../src/services/daily-profit-service');
const { CostLedgerStore } = require('../src/cost-ledger-store');
const { createApp } = require('../src/app');
const { AuthService } = require('../src/auth');
const { loadConfig } = require('../src/config');

const config = { financeTimezone: 'Asia/Shanghai', sub2apiTimezone: 'Asia/Shanghai',
  databaseUrl: 'postgres://readonly:synthetic@main.example/ops', providerMonitorBaseUrl: 'https://monitor.example' };
const decision = extra => ({ kind: 'fee', amount: 10, currency: 'CNY', serviceStart: '2026-10-01', serviceEnd: '2026-10-01', category: 'other', reason: 'verified invoice', ...extra });
const user = { id: '2', name: 'Paid user', balance: '60', createdDate: '2026-10-01', deleted: false };
const day = (date, extra = {}) => ({ date, siteConsumption: 60, supplierConsumption: 20, siteComplete: true, supplierComplete: true,
  mode: 'archived', providers: [{ id: 'supplier', name: 'Supplier', cost: 20, complete: true }],
  accountingSource: { complete: true, users: [user], usage: [{ userId: '2', billingType: 0, amount: '60' }] }, ...extra });

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'accounting-test-'));
  const store = new AccountingStore(directory, AccountingService.scope(config)); store.initialize();
  const ledger = { snapshot: () => ({ entries: [], incomes: [] }), providers: () => ({ items: [{ id: 'supplier', name: 'Supplier' }] }) };
  const service = new AccountingService({ config, store, ledger, now: () => new Date('2026-10-02T04:00:00Z') });
  const finalizers = [];
  t.after(async () => { for (const finish of finalizers) await finish(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, store, service, ledger, finalizers,
    docs(documents) { store.importDocuments(documents); return service.effectiveDocuments(); },
    calculate(days) { return service.calculate(days, service.effectiveDocuments(), service.settings()); } };
}
function paidDocuments() {
  return [
    { key: 'payment:1', origin: 'payment', name: 'Online paid', date: '2026-10-01', amount: '100', currency: 'CNY', quantity: '120', userId: '2', kind: 'customer_receipt' },
    { key: 'redeem:1', origin: 'redeem', name: 'Credit', date: '2026-10-01', quantity: '120', userId: '2', payments: [{ id: '1', amount: '120', cash: '100', currency: 'CNY' }] }
  ];
}

test('paid value is recognized on consumption; recharge and supplier prepayments never duplicate profit', t => {
  const f = fixture(t); f.docs(paidDocuments());
  f.service.create({ name: 'Server', date: '2026-10-01', ...decision({}) }, 'admin');
  f.service.create({ name: 'Supplier recharge', date: '2026-10-01', ...decision({ kind: 'provider_prepayment', amount: 500, providerId: 'supplier' }) }, 'admin');
  const row = f.calculate([day('2026-10-01')]).items[0];
  assert.equal(row.revenue, 50); assert.equal(row.fee, 10); assert.equal(row.profit, 20); assert.equal(row.margin, 40);
  const cash = f.service.cashSummary(f.service.effectiveDocuments());
  assert.equal(cash.receipts, 100); assert.equal(cash.payments, 510); assert.equal(cash.credit, 120);
});

test('cross-month consumption retains its paid value without subtracting current balances', t => {
  const f = fixture(t); f.docs(paidDocuments());
  const rows = [day('2026-10-01')];
  for (let index = 2; index <= 31; index++) rows.push(day(`2026-10-${String(index).padStart(2, '0')}`, { siteConsumption: 0, supplierConsumption: 0, accountingSource: { complete: true, users: [user], usage: [] } }));
  rows.push(day('2026-11-01'));
  const result = f.calculate(rows).items;
  assert.equal(result[0].revenue, 50); assert.equal(result.at(-1).revenue, 50); assert.equal(result.at(-1).profit, 30);
});

test('annual expense allocations sum exactly to the original amount including fractional remainder', () => {
  let sum = 0;
  for (let index = 1; index <= 31; index++) sum += allocated(10, '2026-10-01', '2026-10-31', `2026-10-${String(index).padStart(2, '0')}`).toNumber();
  assert(Math.abs(sum - 10) < 1e-8);
  assert.equal(allocated(365, '2026-10-01', '2027-09-30', '2026-11-01').toNumber(), 1);
  assert.equal(allocated(365, '2026-10-01', '2027-09-30', '2026-09-30').toNumber(), 0);
});

test('consumption allocation conserves every minimum cash unit when the entire credit pool is used', t => {
  const f = fixture(t);
  f.docs([{ key: 'redeem:3', origin: 'redeem', name: 'Fractional credit', date: '2026-10-01', quantity: '3', userId: '2', payments: [] }]);
  f.service.classify('redeem:3', decision({ kind: 'customer_receipt', amount: 1 }), 'admin');
  const rows = f.calculate(['01', '02', '03'].map(value => day(`2026-10-${value}`, { accountingSource: { complete: true, users: [user], usage: [{ userId: '2', billingType: 0, amount: '1' }] } }))).items;
  assert.deepEqual(rows.map(row => row.revenue), [0.33333333, 0.33333334, 0.33333333]);
  assert.equal(f.service.totals(rows).revenue, 1);
});

test('unpaid fees affect their service period while cash follows the actual paid date', t => {
  const f = fixture(t); f.docs(paidDocuments());
  f.service.create({ name: 'Annual prepaid', date: '2026-09-20', ...decision({ amount: 365, serviceStart: '2026-10-01', serviceEnd: '2027-09-30' }) }, 'admin');
  f.service.create({ name: 'Accrued labor', date: '2026-10-01', ...decision({ amount: 20, paid: false }) }, 'admin');
  const row = f.calculate([day('2026-10-01')]).items[0];
  assert.equal(row.fee, 21); assert.equal(row.profit, 9);
  assert.equal(f.service.cashSummary(f.service.effectiveDocuments().filter(document => document.date >= '2026-10-01')).payments, 0);
});

test('gifts consume upstream cost without creating revenue; missing opening needs explicit evidence', t => {
  const f = fixture(t);
  f.docs([{ key: 'redeem:2', origin: 'redeem', name: 'Admin gift', date: '2026-10-01', quantity: '120', userId: '2', payments: [] }]);
  assert.equal(f.calculate([day('2026-10-01')]).items[0].profit, null);
  f.service.classify('redeem:2', decision({ kind: 'gift', amount: 0 }), 'admin');
  const row = f.calculate([day('2026-10-01')]).items[0];
  assert.equal(row.revenue, 0); assert.equal(row.profit, -20); assert.equal(row.margin, null);
  const old = day('2026-10-01', { accountingSource: { complete: true, users: [{ ...user, createdDate: '2026-09-01' }], usage: [{ userId: '2', billingType: 0, amount: '60' }] } });
  assert.equal(f.calculate([old]).items[0].revenue, null);
  f.service.opening({ userId: '2', quantity: 0, cashValue: 0, reason: 'verified zero before opening' }, 'admin');
  assert.equal(f.calculate([old]).items[0].revenue, 0);
});

test('offline cash links once to admin credit, rejects duplicate associations and rolls back failed creations', t => {
  const f = fixture(t);
  f.docs([{ key: 'redeem:2', origin: 'redeem', name: 'Offline credit', date: '2026-10-01', quantity: '120', userId: '2', payments: [] }]);
  const input = { name: 'Bank receipt', date: '2026-10-01', ...decision({ kind: 'customer_receipt', amount: 100, userId: '2', linkedKey: 'redeem:2' }) };
  const record = f.service.create(input, 'admin');
  assert.equal(f.calculate([day('2026-10-01')]).items[0].revenue, 50);
  assert.equal(f.service.cashSummary(f.service.effectiveDocuments()).receipts, 100);
  const count = f.store.documents().length;
  assert.throws(() => f.service.create(input, 'admin'), error => error.code === 'ACCOUNTING_DUPLICATE_LINK');
  assert.equal(f.store.documents().length, count);
  assert(f.store.history(record.key).every(entry => entry.actor === 'admin'));
});

test('repeated manual requests are idempotent and conflicting reuse is rejected', t => {
  const f = fixture(t); const input = { name: 'Fee', date: '2026-10-01', requestId: crypto.randomUUID(), ...decision({}) };
  const first = f.service.create(input, 'admin'), second = f.service.create(input, 'admin');
  assert.equal(first.key, second.key); assert.equal(f.store.documents().length, 1);
  assert.throws(() => f.service.create({ ...input, amount: 100 }, 'admin'), error => error.code === 'ACCOUNTING_REQUEST_CONFLICT');
});

test('direct redemption receipts and linked offline receipts cannot count the same payment in either order', t => {
  const f = fixture(t);
  f.docs([2, 3].map(id => ({ key: `redeem:${id}`, origin: 'redeem', name: 'Offline credit', date: '2026-10-01', quantity: '120', userId: '2', payments: [] })));
  const receipt = decision({ kind: 'customer_receipt', amount: 100, userId: '2' });
  f.service.classify('redeem:2', receipt, 'admin');
  assert.throws(() => f.service.create({ name: 'Duplicate receipt', date: '2026-10-01', ...receipt, linkedKey: 'redeem:2' }, 'admin'), { code: 'ACCOUNTING_DUPLICATE_LINK' });
  f.service.create({ name: 'Linked receipt', date: '2026-10-01', ...receipt, linkedKey: 'redeem:3' }, 'admin');
  assert.throws(() => f.service.classify('redeem:3', receipt, 'admin'), { code: 'ACCOUNTING_DUPLICATE_LINK' });
  assert.equal(f.service.cashSummary(f.service.effectiveDocuments()).receipts, 200);
});

test('a late online payment makes an earlier linked receipt pending until its duplicate evidence is resolved', t => {
  const f = fixture(t);
  const credit = { key: 'redeem:1', origin: 'redeem', name: 'Credit', date: '2026-10-01', quantity: '120', userId: '2', payments: [] };
  f.docs([credit]);
  const record = f.service.create({ name: 'Early receipt', date: '2026-10-01', ...decision({ kind: 'customer_receipt', amount: 100, userId: '2', linkedKey: 'redeem:1' }) }, 'admin');
  f.docs(paidDocuments());
  assert.equal(f.service.effectiveDocuments().find(item => item.key === record.key).pending, true);
  assert.equal(f.service.cashSummary(f.service.effectiveDocuments()).receipts, null);
  assert.equal(f.calculate([day('2026-10-01')]).items[0].revenue, null);
  f.service.classify(record.key, decision({ kind: 'reference', linkedKey: 'payment:1' }), 'admin');
  assert.equal(f.service.cashSummary(f.service.effectiveDocuments()).receipts, 100);
  assert.equal(f.calculate([day('2026-10-01')]).items[0].revenue, 50);
});

test('legacy income classified as a gift carries zero cash value into its consumption pool', t => {
  const f = fixture(t);
  f.ledger.snapshot = () => ({ entries: [], incomes: [{ id: 'old-gift', name: 'Gift', date: '2026-10-01', amountMinor: 12000, currency: 'CNY' }] });
  f.service.importLegacy();
  f.service.classify('legacy-income:old-gift', decision({ kind: 'gift', userId: '2', quantity: 120 }), 'admin');
  const row = f.calculate([day('2026-10-01')]).items[0];
  assert.equal(row.revenue, 0); assert.equal(row.profit, -20);
  assert.equal(f.service.cashSummary(f.service.effectiveDocuments()).receipts, 0);
});

test('online subscriptions need a verified service period and use paid price instead of usage face value', t => {
  const f = fixture(t);
  f.docs([{ key: 'payment:8', origin: 'payment', name: 'Subscription', kind: 'subscription', date: '2026-10-01', userId: '2', amount: '199', currency: 'CNY' }]);
  const source = day('2026-10-01', { siteConsumption: 500, accountingSource: { complete: true, users: [user], usage: [{ userId: '2', billingType: 1, amount: 500 }] } });
  assert.equal(f.calculate([source]).items[0].revenue, null);
  f.service.classify('payment:8', decision({ kind: 'subscription', amount: 199, userId: '2', serviceEnd: '2026-10-30' }), 'admin');
  const row = f.calculate([source]).items[0];
  assert.equal(row.subscriptionRevenue, 6.63333334); assert.equal(row.revenue, 6.63333334);
  assert.equal(f.service.cashSummary(f.service.effectiveDocuments()).receipts, 199);
});

test('legacy money is never assumed to be revenue or expense and becomes usable after audited classification', t => {
  const f = fixture(t); f.docs(paidDocuments());
  f.ledger.snapshot = () => ({ entries: [{ id: 'old', kind: 'provider', providerId: 'supplier', name: 'Supplier', date: '2026-10-01', amountMinor: 10000, currency: 'CNY' }], incomes: [] });
  f.service.importLegacy();
  assert.equal(f.calculate([day('2026-10-01')]).items[0].fee, null);
  f.service.classify('legacy-expense:old', decision({ kind: 'provider_prepayment', amount: 100, providerId: 'supplier' }), 'admin');
  assert.equal(f.calculate([day('2026-10-01')]).items[0].profit, 30);
});

test('unknown providers and historical gaps never turn into zero costs or confirmed profits', t => {
  const f = fixture(t); f.docs(paidDocuments());
  const result = f.calculate([day('2026-10-01', { supplierConsumption: null, supplierComplete: false })]);
  assert.equal(result.items[0].revenue, 50); assert.equal(result.items[0].profit, null);
  assert.equal(f.service.totals(result.items).supplierCost, null);
  const gap = f.calculate([day('2026-10-02')]);
  assert.equal(gap.items[0].revenue, null);
});

test('test income exclusions preserve actual supplier costs and a deleted user does not remove recognized revenue', t => {
  const f = fixture(t); f.docs(paidDocuments());
  f.service.classify('payment:1', decision({ kind: 'excluded', amount: 0 }), 'admin');
  const deleted = day('2026-10-01', { accountingSource: { complete: true, users: [{ ...user, deleted: true }], usage: [{ userId: '2', billingType: 0, amount: '60' }] } });
  assert.equal(f.calculate([deleted]).items[0].profit, -20);
  f.service.classify('payment:1', decision({ kind: 'customer_receipt', amount: 100 }), 'admin');
  assert.equal(f.calculate([deleted]).items[0].revenue, 50);
  assert.equal(f.service.cashSummary(f.service.effectiveDocuments()).receipts, 100);
});

test('foreign amounts require a verified rate and source changes revoke classifications', t => {
  const f = fixture(t); f.docs([{ key: 'payment:1', origin: 'payment', date: '2026-10-01', name: 'USD receipt', kind: 'customer_receipt', amount: '100', currency: 'USD' }]);
  assert.equal(f.service.cashSummary(f.service.effectiveDocuments()).receipts, null);
  assert.throws(() => f.service.classify('payment:1', decision({ kind: 'customer_receipt', currency: 'USD' }), 'admin'));
  f.service.classify('payment:1', decision({ kind: 'customer_receipt', amount: 100, currency: 'USD', rate: 7 }), 'admin');
  assert.equal(f.service.cashSummary(f.service.effectiveDocuments()).receipts, 700);
  const original = f.store.document('payment:1'); f.docs([{ ...original, amount: '200' }]);
  assert.equal(f.service.effectiveDocuments()[0].sourceChanged, true);
  assert.equal(f.service.effectiveDocuments()[0].pending, true);
});

test('unconsumed refunds reduce unearned value; service refunds reduce recognized income', t => {
  const f = fixture(t); f.docs(paidDocuments());
  f.service.create({ name: 'Unused refund', date: '2026-10-02', ...decision({ kind: 'refund_unconsumed', userId: '2', quantity: 12, amount: 10, relatedKey: 'payment:1' }) }, 'admin');
  f.service.create({ name: 'Service rebate', date: '2026-10-02', ...decision({ kind: 'refund_service', amount: 5, relatedKey: 'payment:1' }) }, 'admin');
  const result = f.calculate([day('2026-10-01'), day('2026-10-02', { siteConsumption: 48, accountingSource: { complete: true, users: [user], usage: [{ userId: '2', billingType: 0, amount: 48 }] } })]);
  assert.equal(result.items[1].balanceRevenue, 40); assert.equal(result.items[1].revenue, 35);
  assert.equal(f.service.cashSummary(f.service.effectiveDocuments()).refunds, 15);
});

test('durable audit, decisions and original documents survive restart and input validation protects source identity', t => {
  const f = fixture(t); f.docs(paidDocuments());
  assert.throws(() => f.service.classify('payment:1', decision({ kind: 'customer_receipt', userId: '3' }), 'admin'), error => error.code === 'ACCOUNTING_SOURCE_IMMUTABLE');
  assert.throws(() => f.service.opening({ userId: '1', quantity: 10, cashValue: 10, reason: 'invalid' }, 'admin'));
  assert.throws(() => f.service.create({ name: 'Bad date', date: '2026-02-30', ...decision({}) }, 'admin'));
  f.service.classify('payment:1', decision({ kind: 'customer_receipt', amount: 100 }), 'admin');
  f.store.close(); f.store.initialize();
  assert.equal(f.store.documents().length, 2); assert.equal(f.store.decisions()['payment:1'].actor, 'admin');
  assert.equal(f.store.history('payment:1').length, 1);
});

test('a linked negative adjustment and refund reduce the balance only once, regardless of document ordering', t => {
  const f = fixture(t); f.docs([...paidDocuments(), { key: 'redeem:2', origin: 'redeem', name: 'Refund credit reversal', date: '2026-10-02', quantity: '-12', userId: '2', payments: [] }]);
  f.service.classify('redeem:2', decision({ kind: 'correction', amount: 0, cashAdjustment: 0 }), 'admin');
  f.service.create({ name: 'Refund', date: '2026-10-02', ...decision({ kind: 'refund_unconsumed', userId: '2', quantity: 12, amount: 10, relatedKey: 'payment:1', linkedKey: 'redeem:2' }) }, 'admin');
  const rows = f.calculate([day('2026-10-01'), day('2026-10-02', { accountingSource: { complete: true, users: [user], usage: [{ userId: '2', billingType: 0, amount: 48 }] } })]).items;
  assert.equal(rows[1].revenue, 40); assert.equal(rows[1].profit, 20);
  assert.throws(() => f.service.create({ name: 'Invalid link', date: '2026-10-02', ...decision({ kind: 'refund_unconsumed', userId: '2', quantity: 120, amount: 10, relatedKey: 'payment:1', linkedKey: 'redeem:1' }) }, 'admin'), { code: 'ACCOUNTING_REFUND_LINK' });
});

test('refunds require original cash evidence and cannot exceed actual receipts', t => {
  const f = fixture(t); f.docs(paidDocuments());
  assert.throws(() => f.service.create({ name: 'Unlinked refund', date: '2026-10-02', ...decision({ kind: 'refund_service', amount: 5 }) }, 'admin'), { code: 'ACCOUNTING_REFUND_ORIGINAL' });
  f.service.create({ name: 'Valid refund', date: '2026-10-02', ...decision({ kind: 'refund_service', amount: 90, relatedKey: 'payment:1' }) }, 'admin');
  assert.throws(() => f.service.create({ name: 'Over refund', date: '2026-10-02', ...decision({ kind: 'refund_service', amount: 11, relatedKey: 'payment:1' }) }, 'admin'), { code: 'ACCOUNTING_REFUND_EXCESS' });
  assert.throws(() => f.service.classify('payment:1', decision({ kind: 'customer_receipt', amount: 100, userId: null }), 'admin'), { code: 'ACCOUNTING_SOURCE_IMMUTABLE' });
  assert.throws(() => f.service.classify('payment:1', decision({ kind: 'customer_receipt', amount: 200 }), 'admin'), { code: 'ACCOUNTING_SOURCE_IMMUTABLE' });
});

test('subscription termination refunds unearned money without recognizing future service again', t => {
  const f = fixture(t);
  f.docs([{ key: 'payment:7', origin: 'payment', kind: 'subscription', name: 'Four day service', date: '2026-10-01', userId: '2', amount: 100, currency: 'CNY' }]);
  f.service.classify('payment:7', decision({ kind: 'subscription', amount: 100, serviceEnd: '2026-10-04' }), 'admin');
  const refund = { name: 'Cancel unused service', date: '2026-10-03', ...decision({ kind: 'refund_subscription', relatedKey: 'payment:7', amount: 50, cancelDate: '2026-10-03', refundEarned: 0 }) };
  assert.throws(() => f.service.create({ ...refund, amount: 49 }, 'admin'), { code: 'ACCOUNTING_REFUND_ALLOCATION' });
  f.service.create(refund, 'admin');
  const result = f.calculate(['01', '02', '03', '04'].map(index => day(`2026-10-${index}`, { accountingSource: { complete: true, users: [user], usage: [] } })));
  assert.deepEqual(result.items.map(row => row.revenue), [25, 25, 0, 0]);
  assert.deepEqual(result.items.map(row => row.profit), [5, 5, -20, -20]);
  assert.equal(f.service.cashSummary(f.service.effectiveDocuments()).refunds, 50);
  assert.throws(() => f.service.create(refund, 'admin'), { code: 'ACCOUNTING_REFUND_DUPLICATE' });
});

test('multiple duplicate bookkeeping rows can reference a verified manual receipt without counting it twice', t => {
  const f = fixture(t);
  f.docs([{ key: 'redeem:2', origin: 'redeem', date: '2026-10-01', name: 'Offline', quantity: 100, userId: '2', payments: [] }]);
  const receipt = f.service.create({ name: 'Bank cash', date: '2026-10-01', ...decision({ kind: 'customer_receipt', amount: 80, linkedKey: 'redeem:2', userId: '2' }) }, 'admin');
  for (let index = 0; index < 2; index++) f.service.create({ name: `Duplicate ${index}`, date: '2026-10-01', ...decision({ kind: 'reference', linkedKey: receipt.key }) }, 'admin');
  assert.equal(f.service.cashSummary(f.service.effectiveDocuments()).receipts, 80);
  assert.equal(f.calculate([day('2026-10-01')]).items[0].revenue, 48);
  f.service.classify('redeem:2', decision({ kind: 'excluded', amount: 0 }), 'admin');
  assert.equal(f.service.cashSummary(f.service.effectiveDocuments()).receipts, 0);
  assert.equal(f.calculate([day('2026-10-01')]).items[0].profit, -20);
});

test('changed CNY source records revoke prior approval and partial supplier amounts never produce a full profit', t => {
  const f = fixture(t); f.docs(paidDocuments());
  f.service.classify('payment:1', decision({ kind: 'customer_receipt', amount: 100 }), 'admin');
  f.docs([{ ...f.store.document('payment:1'), amount: 200 }]);
  assert.equal(f.service.effectiveDocuments().find(item => item.key === 'payment:1').pending, true);
  assert.equal(f.calculate([day('2026-10-01')]).items[0].revenue, null);
  f.docs([{ ...f.store.document('payment:1'), amount: 100 }]);
  const row = f.calculate([day('2026-10-01', { supplierComplete: false, supplierConsumption: 12 })]).items[0];
  assert.equal(row.supplierCost, null); assert.equal(row.profit, null);
});

test('unavailable source history prevents false zero cash totals and refresh is limited to the selected dates', async t => {
  const f = fixture(t); f.docs(paidDocuments());
  let options;
  f.service.dailyProfit = { getDailyProfit: async (_query, supplied) => { options = supplied; return { items: [day('2026-10-01', { accountingSource: null })], archive: {}, notices: [] }; } };
  f.service.currentBalances = async () => ({ users: [], providers: [] });
  const result = await f.service.getReport({ start: '2026-10-01', end: '2026-10-01', refresh: '1' });
  assert.equal(result.cash.receipts, null); assert.equal(result.cash.credit, null); assert.equal(result.cash.sourceComplete, false);
  assert.equal(options.refreshRange.start, '2026-10-01'); assert.equal(options.refreshRange.end, '2026-10-01');
});

test('persisted credit drilldown supports search and pagination and preserves archived deleted-user records', async t => {
  const f = fixture(t);
  f.docs([...paidDocuments(), { key: 'redeem:2', origin: 'redeem', date: '2026-10-01', name: 'Second credit', quantity: 40, userId: '3', userName: 'Archived user', payments: [] }]);
  const first = await f.service.creditUsers({ start: '2026-10-01', end: '2026-10-01', pageSize: 1 });
  assert.equal(first.pagination.total, 2); assert.equal(first.summary.totalIncome, 160); assert.equal(first.pagination.hasNext, true);
  const searched = await f.service.creditUsers({ start: '2026-10-01', end: '2026-10-01', search: 'Archived' });
  assert.equal(searched.items[0].userId, '3'); assert.equal(searched.items[0].missing, true);
  const records = await f.service.creditUsers({ start: '2026-10-01', end: '2026-10-01' }, '2');
  assert.equal(records.items[0].value, 120); assert.equal(records.items[0].type, undefined);
  assert.equal(records.summary.totalIncome, first.items[0].totalIncome);
  await assert.rejects(f.service.creditUsers({}, "2' OR 1=1"), { code: 'INVALID_USER_ID' });
});

test('accounting HTTP uses real admin sessions and CSRF, persists audited edits and validates requests', async t => {
  const f = fixture(t); f.docs(paidDocuments());
  const runtime = loadConfig({ NODE_ENV: 'test', OPERATIONS_CENTER_AUTH_MODE: 'local', OPERATIONS_CENTER_ADMIN_PASSWORD: 'test-accounting-password' });
  const auth = new AuthService(runtime);
  const app = createApp({ config: runtime, auth, accounting: f.service });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  f.finalizers.push(async () => { await new Promise(resolve => server.close(resolve)); auth.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const endpoint = `${base}/api/cost-analysis/accounting`;
  for (const suffix of ['/documents', '/report', '/credits/users', '/documents/payment:1']) assert.equal((await fetch(endpoint + suffix)).status, 401);
  const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'test-accounting-password' }) });
  const session = await response.json();
  const headers = { 'content-type': 'application/json', authorization: `Session ${session.sessionToken}` };
  const body = { name: 'HTTP cost', date: '2026-10-01', requestId: crypto.randomUUID(), ...decision({ amount: 10 }) };
  assert.equal((await fetch(`${endpoint}/documents`, { method: 'POST', headers, body: JSON.stringify(body) })).status, 403);
  headers['x-csrf-token'] = session.csrfToken;
  const first = await fetch(`${endpoint}/documents`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal(first.status, 201); assert.equal(first.headers.get('cache-control'), 'no-store');
  const record = await first.json();
  const duplicate = await fetch(`${endpoint}/documents`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await duplicate.json()).key, record.key);
  const change = await fetch(`${endpoint}/documents/${record.key}`, { method: 'PUT', headers, body: JSON.stringify(decision({ amount: 20 })) });
  assert.equal(change.status, 200);
  const detail = await (await fetch(`${endpoint}/documents/${record.key}`, { headers })).json();
  assert.equal(detail.item.cash, 20); assert.equal(detail.history.length, 3); assert(detail.history.every(row => row.actor === 'admin'));
  assert.equal((await fetch(`${endpoint}/documents?start=2026-02-30`, { headers })).status, 400);
  assert.equal((await fetch(`${endpoint}/documents/missing`, { headers })).status, 404);
  assert.equal((await fetch(`${endpoint}/opening`, { method: 'PUT', headers, body: JSON.stringify({ userId: '1', quantity: 0, cashValue: 0, reason: 'not allowed' }) })).status, 400);
  assert.equal((await (await fetch(`${endpoint}/credits/users?start=2026-10-01&end=2026-10-01`, { headers })).json()).summary.totalIncome, 120);
  assert.equal(f.calculate([day('2026-10-01')]).items[0].profit, 10);
});

test('real PostgreSQL sources, daily archive and accounting report are idempotent and exclude admin', async t => {
  const f = fixture(t); const database = new PGlite(); t.after(() => database.close());
  await database.exec(`CREATE TABLE users(id bigint PRIMARY KEY,balance numeric,created_at timestamptz,deleted_at timestamptz,email text);
    CREATE TABLE redeem_codes(id bigint,used_by bigint,type text,status text,value numeric,used_at timestamptz,code text,notes text);
    CREATE TABLE payment_orders(id bigint,user_id bigint,amount numeric,pay_amount numeric,order_type text,paid_at timestamptz,completed_at timestamptz,
      refund_at timestamptz,refund_amount numeric,status text,recharge_code text,provider_snapshot jsonb);
    CREATE TABLE usage_logs(id bigint,user_id bigint,billing_type smallint,actual_cost numeric,created_at timestamptz);
    CREATE TABLE usage_dashboard_daily(bucket_date date,total_requests bigint);
    INSERT INTO users VALUES (1,9999,'2026-01-01',NULL,'admin'),(2,60,'2026-10-01T00:00:00+08:00',NULL,'paid');
    INSERT INTO payment_orders VALUES(1,2,120,100,'balance','2026-10-01T01:00:00+08:00','2026-10-01T01:00:00+08:00',NULL,0,'COMPLETED','paid-code','{"currency":"CNY"}');
    INSERT INTO redeem_codes VALUES(1,2,'balance','used',120,'2026-10-01T01:00:00+08:00','paid-code','synthetic');
    INSERT INTO usage_logs VALUES(1,2,0,60,'2026-10-01T10:00:00+08:00'),(2,1,0,9999,'2026-10-01T10:00:00+08:00');
    INSERT INTO usage_dashboard_daily VALUES('2026-10-01',2);`);
  const inspector = new SchemaInspector(database);
  const source = new AccountingSource({ pool: database, inspector, config, store: f.store });
  const collected = await source.collectDay('2026-10-01');
  assert.equal(collected.usage.length, 1); assert.equal(collected.users.length, 1);
  assert.equal(collected.usage[0].userId, '2');
  const ledger = new CostLedgerStore(f.directory); await ledger.initialize();
  let supplierCalls = 0, queries = 0;
  const pool = { query(...args) { queries++; return database.query(...args); } };
  const providerMonitor = { configured: () => true, integrationToken: 'synthetic',
    createDailyCostsReader: async () => async input => {
      supplierCalls++;
      return { source: 'upstream_daily_summary', scope: 'account', providerFilter: 'scheduled_enabled', timezone: config.financeTimezone,
        currency: 'CNY', range: { start: input.from, end: input.to }, items: [{ date: input.from, cost: 20, complete: true, providers: [{ id: 'one', name: 'Supplier', cost: 20, complete: true }] }] };
    }, getFinancialBalances: async () => ({ currency: 'CNY', providerFilter: 'scheduled_enabled', complete: true, total: 300, items: [] }) };
  const analysis = new CostAnalysisService({ pool, inspector, config, store: ledger, providerMonitor });
  const dailyStore = new DailyProfitStore(f.directory); dailyStore.initialize();
  const daily = new DailyProfitService({ analysis, store: dailyStore, config, now: () => new Date('2026-10-02T04:00:00Z') });
  const accounting = new AccountingService({ pool, inspector, config, store: f.store, ledger, analysis, dailyProfit: daily, now: () => new Date('2026-10-02T04:00:00Z') });
  analysis.accounting = accounting;
  f.finalizers.push(async () => { await daily.stop(); dailyStore.close(); });
  const input = { start: '2026-10-01', end: '2026-10-01' };
  assert.equal((await accounting.getReport(input)).summary.profit, null);
  await daily.drain();
  const first = await accounting.getReport(input);
  assert.equal(first.summary.revenue, 50); assert.equal(first.summary.profit, 30); assert.equal(first.cash.receipts, 100);
  assert.equal(first.balances.userBalance, 60); assert.equal(first.balances.providerBalance, 300);
  const oldCalls = supplierCalls, oldQueries = queries;
  const next = await accounting.getReport(input);
  assert.equal(next.summary.profit, 30); assert.equal(supplierCalls, oldCalls); assert.equal(queries, oldQueries);
  assert.equal(f.store.results('2026-10-01', '2026-10-01')[0].revenue, 50);
  await database.exec('DELETE FROM users WHERE id=2; DELETE FROM redeem_codes WHERE id=1;');
  await accounting.source.collectDay('2026-10-01');
  assert.equal(f.store.documents().filter(document => document.origin === 'redeem').length, 1);
  assert.equal((await accounting.getReport(input)).summary.revenue, 50);
});
