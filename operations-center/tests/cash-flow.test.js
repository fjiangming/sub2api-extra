'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { AccountingStore } = require('../src/accounting-store');
const { AccountingService } = require('../src/services/accounting-service');
const { CashFlowService } = require('../src/services/cash-flow-service');
const { loadConfig } = require('../src/config');
const { startPreview } = require('../scripts/accounting-preview.cjs');

const payment = extra => ({ id: '1', user_id: '2', paid_at: '2026-10-01T23:30:00Z', amount: '100', currency: 'CNY',
  order_type: 'balance', status: 'COMPLETED', refund_quantity: '0', redeem_ids: ['1'], ...extra });
const entry = extra => ({ direction: 'expense', category: 'custom', name: 'Server', date: '2026-10-02', amount: 10, requestId: crypto.randomUUID(), ...extra });
function fixture(t, extra = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cash-test-'));
  const config = { financeTimezone: 'Asia/Shanghai', databaseUrl: 'postgres://example:synthetic@local.invalid/db', ...extra };
  const store = new AccountingStore(directory, AccountingService.scope(config)); store.initialize();
  const ledger = { state: {}, snapshot: () => ({ entries: [], incomes: [] }), providers: () => ({ items: [{ id: 'upstream', name: 'Supplier', enabled: false }] }) };
  const source = { payments: [payment()], credits: [], users: [{ id: '1', balance: '99999999' }, { id: '2', balance: '60', email: 'customer@example.test' }, { id: '3', balance: '12345', deleted_at: new Date() }], queries: [] };
  const pool = { async query(sql, params) {
    source.queries.push(sql); assert.match(sql.trim(), /^SELECT/);
    if (source.fail) throw new Error('synthetic source failure');
    if (sql.includes('FROM payment_orders p')) return { rows: source.payments.filter(row => BigInt(row.id) > BigInt(params[0])).slice(0, 1000) };
    if (sql.includes('FROM redeem_codes r')) return { rows: source.credits.filter(row => BigInt(row.id) > BigInt(params[0])).slice(0, 1000) };
    if (sql.includes('FROM users u')) { if (source.balanceFail) throw new Error('balance failure'); return { rows: source.users }; }
    throw new Error('Unexpected read');
  } };
  const inspector = { inspect: async () => ({ tables: { payment_orders: { exists: true }, redeem_codes: { exists: true } } }) };
  const accounting = new AccountingService({ config, store, ledger });
  const service = new CashFlowService({ pool, inspector, config, store, ledger, accounting, now: () => new Date('2026-11-02T04:00:00Z') });
  t.after(async () => { await service.stop(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { service, store, config, ledger, accounting, source, directory, query: { start: '2026-10-01', end: '2026-10-31' } };
}

test('cumulative uses all history and excludes ID 1 and deleted balances regardless of every report filter', async t => {
  const f = fixture(t); await f.service.save(entry(), 'admin');
  for (const query of [f.query, { start: '2026-11-01', end: '2026-11-02', currency: 'USD', search: 'absent', origin: 'manual', direction: 'income', granularity: 'year' }]) {
    const r = await f.service.getReport(query);
    assert.equal(r.cumulative.income, 100); assert.equal(r.cumulative.expense, 10); assert.equal(r.cumulative.userBalance, 60); assert.equal(r.cumulative.net, 30); assert.equal(r.cumulative.currency, 'CNY');
  }
  assert(f.source.queries.some(sql => sql.includes('WHERE u.id<>1 AND u.deleted_at IS NULL')));
  assert.equal((await f.service.getBalances()).pagination.total, 1);
  assert.equal((await f.service.getReport({ start: '2026-11-01', end: '2026-11-02' })).summary.income, 0);
});

test('actual paid balance and subscription orders count once without needing redeemed credits', async t => {
  const f = fixture(t);
  f.source.payments = [payment(), payment({ id: '2', amount: '199', order_type: 'subscription', redeem_ids: [] }),
    payment({ id: '3', user_id: '1', amount: '9999' }), payment({ id: '4', status: 'PENDING' }),
    payment({ id: '5', paid_at: null }), payment({ id: '6', status: 'CANCELLED' }), payment({ id: '7', amount: '-1' })];
  const r = await f.service.getReport(f.query); assert.equal(r.summary.income, 299); assert.equal(r.items.length, 2);
  assert(r.items.every(row => !row.editable)); assert.equal(r.periods.find(row => row.key === '2026-10-02').income, 299);
  assert.equal(r.periods.reduce((sum, row) => sum + row.income, 0), r.summary.income);
});

test('manual cash defaults to CNY and concurrent request retries are idempotent and audited', async t => {
  const f = fixture(t), input = entry();
  const rows = await Promise.all(Array.from({ length: 5 }, () => f.service.save(input, 'admin')));
  assert.equal(new Set(rows.map(row => row.key)).size, 1); assert.equal(rows[0].currency, 'CNY');
  assert.equal(f.store.cashRecords().filter(row => row.source === 'manual').length, 1);
  assert.equal(f.service.detail(rows[0].key).history.length, 1);
  await assert.rejects(f.service.save({ ...input, amount: 11 }, 'admin'), { code: 'CASH_REQUEST_CONFLICT' });
  await f.service.save(entry({ amount: 20 }), 'admin', rows[0].key);
  assert.equal((await f.service.getReport(f.query)).summary.expense, 20);
  f.service.remove(rows[0].key, 'admin'); assert.equal((await f.service.getReport(f.query)).summary.expense, 0);
  assert.equal(f.store.history(`cash:${rows[0].key}`).length, 3);
  await assert.rejects(f.service.save(input, 'admin'), { code: 'CASH_ALREADY_DELETED' });
  await assert.rejects(f.service.save(entry(), 'admin', 'payment:1'), { code: 'CASH_SOURCE_IMMUTABLE' });
  assert.throws(() => f.service.remove('payment:1', 'admin'), { code: 'CASH_SOURCE_IMMUTABLE' });
});

test('explicit duplicate order/redeem references are blocked, but identical amounts without references remain separate', async t => {
  const f = fixture(t);
  for (const sourceRef of ['payment:1', 'REDEEM:1']) await assert.rejects(f.service.save(entry({ direction: 'income', sourceRef }), 'admin'), { code: 'CASH_DUPLICATE_SOURCE' });
  await f.service.save(entry({ sourceRef: 'invoice-1' }), 'admin');
  await assert.rejects(f.service.save(entry({ sourceRef: 'INVOICE-1' }), 'admin'), { code: 'CASH_DUPLICATE_SOURCE' });
  await f.service.save(entry(), 'admin'); await f.service.save(entry(), 'admin');
  assert.equal((await f.service.getReport(f.query)).summary.expense, 30);
});

test('late automatic match suppresses manual duplicate without deleting either record', async t => {
  const f = fixture(t); f.source.payments = [];
  const manual = await f.service.save(entry({ direction: 'income', sourceRef: 'redeem:1', amount: 100 }), 'admin');
  assert.equal((await f.service.getReport(f.query)).summary.income, 100);
  f.source.payments = [payment()]; await f.service.sync({ force: true });
  const r = await f.service.getReport(f.query); assert.equal(r.summary.income, 100); assert.equal(r.items.length, 2);
  assert.equal(r.items.find(row => row.key === manual.key).counted, false);
});

test('original currencies stay separate while cumulative uses dated cash FX rather than upstream recharge rates', async t => {
  const f = fixture(t, { financeCashExchangeRates: [{ currency: 'USD', rate: 7.2, from: '2026-01-01', to: '2026-12-31' }] });
  await f.service.save(entry({ amount: 2, currency: 'USD', category: 'provider', providerId: 'upstream' }), 'admin');
  const cny = await f.service.getReport(f.query), usd = await f.service.getReport({ ...f.query, currency: 'USD' });
  assert.equal(cny.summary.expense, 0); assert.equal(usd.summary.expense, 2); assert.equal(usd.cumulative.expense, 14.4); assert.equal(usd.cumulative.net, 25.6);
  assert.deepEqual(cny.cumulative, usd.cumulative);
  assert.equal(usd.items[0].providerName, 'Supplier');
});

test('missing historical FX and currency keep cumulative unknown while original cash flow is still available', async t => {
  const f = fixture(t); await f.service.save(entry({ currency: 'USD', amount: 2 }), 'admin');
  let r = await f.service.getReport({ ...f.query, currency: 'USD' }); assert.equal(r.summary.net, -2); assert.equal(r.cumulative.net, null); assert.equal(r.cumulative.expense, null);
  f.source.payments.push(payment({ id: '2', currency: null })); await f.service.sync({ force: true });
  r = await f.service.getReport(f.query); assert.equal(r.summary.income, null); assert.equal(r.cumulative.income, null); assert.equal(r.cumulative.net, null);
});

test('source/balance failure never becomes zero or hides known manual records', async t => {
  const f = fixture(t); await f.service.save(entry(), 'admin'); f.source.fail = true;
  const r = await f.service.getReport({ ...f.query, refresh: '1' }); assert.equal(r.summary.income, null); assert.equal(r.summary.net, null); assert.equal(r.known.expense, 10);
  assert.equal(r.cumulative.net, null); assert.equal(r.cumulative.userBalance, null); assert(r.items.some(row => row.source === 'manual'));
  f.source.fail = false; f.source.balanceFail = true; f.service.balancesCache = null;
  const repaired = await f.service.getReport({ ...f.query, refresh: '1' }); assert.equal(repaired.summary.income, 100); assert.equal(repaired.cumulative.net, null);
});

test('paid order and credit snapshots survive source deletion, restart and current-user deletion', async t => {
  const f = fixture(t); f.source.credits = [{ id: '1', user_id: '2', type: 'balance', value: '120', used_at: '2026-10-02T00:00:00+08:00', code: 'synthetic', notes: '' }];
  await f.service.sync(); f.source.payments = []; f.source.credits = []; f.source.users = [{ id: '1', balance: '999999' }];
  await f.service.sync({ force: true });
  f.store.close(); f.store.initialize();
  const r = await f.service.getReport(f.query); assert.equal(r.cumulative.income, 100); assert.equal(r.cumulative.userBalance, 0);
  const credits = await f.service.creditUsers(f.query); assert.equal(credits.summary.totalIncome, 120); assert.equal(credits.items[0].missing, true);
  assert.equal((await f.service.creditUsers(f.query, '2')).items[0].code, 'synthetic');
});

test('legacy JSON cash survives with original IDs, exclusions, unpaid facts, and no migrated copies', async t => {
  const f = fixture(t); f.ledger.snapshot = () => ({ entries: [{ id: 'old', date: '2026-10-02', name: 'Old supplier', amountMinor: 2000, currency: 'CNY', providerId: 'upstream', note: '' }],
    incomes: [{ id: 'cash', date: '2026-10-02', name: 'Old offline', amountMinor: 5000, currency: 'CNY', note: '' }] });
  f.accounting.importLegacy(); f.accounting.classify('legacy-income:cash', { kind: 'excluded', currency: 'CNY', reason: 'Old excluded test' }, 'admin');
  f.accounting.classify('legacy-expense:old', { kind: 'provider_prepayment', amount: 20, currency: 'CNY', providerId: 'upstream', reason: 'Original actual payment' }, 'admin');
  f.accounting.create({ name: 'Duplicate copy', date: '2026-10-02', kind: 'reference', linkedKey: 'legacy-expense:old', currency: 'CNY', reason: 'Same receipt' }, 'admin');
  f.accounting.create({ name: 'Unpaid labor', date: '2026-10-02', kind: 'fee', amount: 20, currency: 'CNY', paid: false, serviceStart: '2026-10-02', serviceEnd: '2026-10-02', reason: 'Not paid' }, 'admin');
  const r = await f.service.getReport(f.query); assert.equal(r.summary.income, 100); assert.equal(r.summary.expense, 20); assert.equal(r.items.find(row => row.key === 'legacy-expense:old').amount, 20);
  await f.service.save(entry({ name: 'Corrected old supplier', amount: 30 }), 'admin', 'legacy-expense:old');
  assert.equal((await f.service.getReport(f.query)).summary.expense, 30); assert.equal(f.ledger.snapshot().entries[0].amountMinor, 2000);
  f.service.remove('legacy-expense:old', 'admin'); assert.equal((await f.service.getReport(f.query)).summary.expense, 0);
});

test('cleared user foreign keys or deleted redemption links retain archived identities and duplicate protection', async t => {
  const f = fixture(t); f.source.credits = [{ id: '1', user_id: '2', type: 'balance', value: '120', used_at: '2026-10-02T00:00:00+08:00', code: 'synthetic', notes: '' }];
  await f.service.sync(); f.source.payments = [payment({ user_id: null, redeem_ids: [], currency: null })];
  f.source.credits[0].user_id = null; f.source.users = []; await f.service.sync({ force: true });
  const r = await f.service.getReport(f.query); assert.equal(r.summary.income, 100); assert.equal(r.items[0].userId, '2');
  assert.equal((await f.service.creditUsers(f.query)).items[0].userId, '2');
  await assert.rejects(f.service.save(entry({ direction: 'income', sourceRef: 'redeem:1' }), 'admin'), { code: 'CASH_DUPLICATE_SOURCE' });
});

test('valid previous automatic exclusions and confirmed actual cash refunds are retained', async t => {
  const f = fixture(t), document = { key: 'payment:1', origin: 'payment', date: '2026-10-02', userId: '2', amount: '100', currency: 'CNY', kind: 'customer_receipt', name: 'Original payment' };
  f.store.importDocuments([document]); f.accounting.classify('payment:1', { kind: 'excluded', currency: 'CNY', reason: 'Known test receipt' }, 'admin');
  assert.equal((await f.service.getReport(f.query)).summary.income, 0);
  f.accounting.classify('payment:1', { kind: 'customer_receipt', amount: 100, currency: 'CNY', reason: 'Actual cash receipt' }, 'admin');
  f.source.payments[0].refund_at = '2026-10-03T00:00:00+08:00'; f.source.payments[0].refund_quantity = '24';
  await f.service.sync({ force: true });
  assert.equal((await f.service.getReport(f.query)).summary.net, null);
  f.store.importDocuments([{ key: 'refund:1', origin: 'refund', date: '2026-10-03', userId: '2', linkedPayment: 'payment:1', amount: null, currency: 'CNY', quantity: '24', kind: 'refund', name: 'Actual refund' }]);
  f.accounting.classify('refund:1', { kind: 'refund_service', amount: 20, currency: 'CNY', reason: 'Confirmed cash refund' }, 'admin');
  const r = await f.service.getReport(f.query); assert.equal(r.summary.expense, 20); assert.equal(r.summary.net, 80); assert.equal(r.cumulative.net, 20);
});

test('refund request, pending, failed and failed fulfillment statuses retain the original actual receipt', async t => {
  const f = fixture(t);
  f.source.payments = ['REFUND_REQUESTED', 'REFUND_PENDING', 'REFUND_FAILED', 'FAILED'].map((status, index) => payment({ id: String(index + 1), status, currency: index === 0 ? ' cny ' : 'CNY', redeem_ids: [] }));
  assert.equal((await f.service.getReport(f.query)).summary.income, 400);
  f.source.payments[0].status = 'CANCELLED'; await f.service.sync({ force: true });
  assert.equal((await f.service.getReport(f.query)).summary.income, 300);
});

test('previous confirmed currency and actual FX survive an incomplete source snapshot', async t => {
  const f = fixture(t); f.source.payments = [payment({ currency: null })];
  f.store.importDocuments([{ key: 'payment:1', origin: 'payment', date: '2026-10-02', userId: '2', amount: '100', currency: null, kind: 'customer_receipt', name: 'Old paid order' }]);
  f.accounting.classify('payment:1', { kind: 'customer_receipt', amount: 100, currency: 'USD', rate: 7.2, reason: 'Existing actual currency evidence' }, 'admin');
  const r = await f.service.getReport({ ...f.query, currency: 'USD' }); assert.equal(r.summary.income, 100); assert.equal(r.cumulative.income, 720); assert.equal(r.cumulative.net, 660);
});

test('archived quota refunds remain unknown without actual cash and removed suppliers keep their past payments editable', async t => {
  const f = fixture(t); f.source.payments = [];
  f.store.importDocuments([{ key: 'payment:9', origin: 'payment', date: '2026-10-02', userId: '2', amount: '100', currency: 'CNY', kind: 'customer_receipt', name: 'Archived order' },
    { key: 'refund:9', origin: 'refund', date: '2026-10-03', quantity: '20', amount: null, userId: '2', name: 'Archived refund' }]);
  const original = await f.service.save(entry({ category: 'provider', providerId: 'upstream' }), 'admin');
  f.ledger.providers = () => ({ items: [] });
  await f.service.save(entry({ category: 'provider', providerId: 'upstream', amount: 15 }), 'admin', original.key);
  const r = await f.service.getReport(f.query); assert.equal(r.summary.net, null); assert.equal(r.cumulative.net, null); assert.equal(r.known.expense, 15);
});

test('quota refunds are not inferred as cash and are isolated to their original currency', async t => {
  const f = fixture(t); f.source.payments.push(payment({ id: '2', currency: 'USD', amount: '5', refund_at: '2026-10-03T00:00:00+08:00', refund_quantity: '999' }));
  const cny = await f.service.getReport(f.query); assert.equal(cny.summary.net, 100); assert.equal(cny.cumulative.net, null);
  assert.equal((await f.service.getReport({ ...f.query, currency: 'USD' })).summary.net, null);
  await f.service.save(entry({ currency: 'USD', amount: 1, sourceRef: 'refund:2', date: '2026-10-03' }), 'admin');
  const usd = await f.service.getReport({ ...f.query, currency: 'USD' }); assert.equal(usd.summary.net, 4);
});

test('full history sync is bounded, resumable, single flight, and does not call the supplier', async t => {
  const f = fixture(t); f.source.payments = Array.from({ length: 4100 }, (_, index) => payment({ id: String(index + 1), amount: '1', redeem_ids: [] }));
  await Promise.all([f.service.sync(), f.service.sync()]);
  assert.equal(f.store.cashRecords().length, 4000); assert.equal(f.service.sourceStatus().complete, false);
  const r = await f.service.getReport(f.query); assert.equal(r.summary.income, 4100); assert.equal(f.service.sourceStatus().complete, true);
  const queries = f.source.queries.length; await f.service.sync(); assert.equal(f.source.queries.length, queries);
});

test('scope switches cannot mix one site or timezone with another site cumulative records', async t => {
  const f = fixture(t); await f.service.save(entry(), 'admin'); const original = f.config.databaseUrl;
  f.config.databaseUrl = 'postgres://example:synthetic@other.invalid/other'; f.source.payments = [];
  assert.equal((await f.service.getReport(f.query)).cumulative.income, 0); assert.equal(f.store.cashRecords().length, 0);
  f.config.databaseUrl = original; assert.equal((await f.service.getReport(f.query)).cumulative.expense, 10);
});

test('cash input and dated FX configuration reject invalid facts without changing the ledger', async t => {
  const f = fixture(t);
  for (const invalid of [{ amount: 1.001 }, { amount: -1 }, { date: '2026-02-30' }, { date: '2026-11-03' }, { category: 'provider', providerId: 'unknown' }, { rate: 1 }, { requestId: undefined }]) await assert.rejects(f.service.save(entry(invalid), 'admin'));
  await assert.rejects(f.service.creditUsers(f.query, "1' OR 1=1"), { code: 'INVALID_USER_ID' });
  const env = { NODE_ENV: 'test', OPERATIONS_CENTER_ADMIN_PASSWORD: 'cash-test-password' };
  assert.deepEqual(loadConfig(env).financeCashExchangeRates, []);
  const good = [{ currency: 'USD', rate: 7.2, from: '2026-01-01', to: '2026-12-31' }];
  assert.equal(loadConfig({ ...env, FINANCE_CASH_EXCHANGE_RATES: JSON.stringify(good) }).financeCashExchangeRates[0].rate, 7.2);
  for (const bad of ['bad json', JSON.stringify([...good, ...good]), JSON.stringify([{ ...good[0], rate: 0 }]), JSON.stringify([{ ...good[0], from: '2026-02-30' }])]) assert.throws(() => loadConfig({ ...env, FINANCE_CASH_EXCHANGE_RATES: bad }));
});

test('real PostgreSQL and authenticated HTTP support cash CRUD, readonly automatic entries and persisted historical credits', async t => {
  const p = await startPreview(); t.after(() => p.close()); const base = `http://127.0.0.1:${p.port}`;
  for (const suffix of ['/cash/report', '/cash/balances', '/cash/records/payment:1', '/automatic-income/users']) assert.equal((await fetch(`${base}/api/cost-analysis${suffix}`)).status, 401);
  const login = await fetch(`${base}/preview`, { redirect: 'manual' }), cookie = login.headers.get('set-cookie').split(';')[0];
  const session = await (await fetch(`${base}/api/auth/me`, { headers: { cookie } })).json();
  const headers = { cookie, 'content-type': 'application/json' }, url = `${base}/api/cost-analysis/cash`;
  const input = entry({ date: p.today });
  assert.equal((await fetch(`${url}/records`, { method: 'POST', headers, body: JSON.stringify(input) })).status, 403);
  headers['x-csrf-token'] = session.csrfToken;
  const create = await fetch(`${url}/records`, { method: 'POST', headers, body: JSON.stringify(input) });
  assert.equal(create.status, 201); assert.equal(create.headers.get('cache-control'), 'no-store'); const saved = await create.json();
  const edited = await fetch(`${url}/records/${saved.key}`, { method: 'PUT', headers, body: JSON.stringify(entry({ date: p.today, amount: 25 })) }); assert.equal(edited.status, 200);
  const detail = await (await fetch(`${url}/records/${saved.key}`, { headers })).json(); assert.equal(detail.item.amount, 25); assert.equal(detail.history.length, 2);
  assert.equal((await fetch(`${url}/records/payment:1`, { method: 'DELETE', headers })).status, 400);
  const r = await p.cashFlow.getReport({ start: p.start, end: p.today }); assert.equal(r.summary.income, 10199); assert.equal(r.cumulative.userBalance, 11790);
  await p.database.exec('DELETE FROM users WHERE id=2; DELETE FROM redeem_codes WHERE id=1; DELETE FROM payment_orders WHERE id=1;');
  await p.cashFlow.sync({ force: true }); const credits = await p.cashFlow.creditUsers({ start: p.start, end: p.today });
  assert.equal(credits.items.find(row => row.userId === '2').totalIncome, 12000); assert.equal((await p.cashFlow.getReport({ start: p.start, end: p.today })).summary.income, 10199);
  assert.equal((await fetch(`${url}/records/${saved.key}`, { method: 'DELETE', headers })).status, 204);
});
