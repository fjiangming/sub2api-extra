const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');
const { ProviderRepository } = require('../src/repositories/provider-repository');
const { createDatabase } = require('../src/db');
const { historyOptions, initialHistory } = require('../src/services/recharge-rate-history');
const { createApplication } = require('../src/server');

function fixture(t) {
  const context = createTestContext();
  const finalizers = [];
  t.after(async () => { for (const close of finalizers) await close(); context.cleanup(); });
  return { ...context, finalizers, providers: new ProviderRepository(context.db, context.config) };
}

const input = { name: 'Initial rate supplier', adapterType: 'sub2api',
  baseUrl: 'https://rate.example', authMode: 'token_pair', credentials: { accessToken: 'fixture-only' }, enabled: false };
const history = (db, id) => db.prepare('SELECT * FROM provider_recharge_rate_history WHERE connection_id=? ORDER BY valid_from,id').all(id);
const confirmation = (multiplier = 10, effectiveDate = '2020-01-01') => ({ multiplier, effectiveDate });

test('creation explicitly confirms the initial rate from midnight, preserves observation time and survives reopening', t => {
  const f = fixture(t);
  const supplier = f.providers.create({ ...input, rechargeMultiplier: 10, initialRechargeRate: confirmation() });
  const rows = history(f.db, supplier.id);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].valid_from, '2019-12-31T16:00:00.000Z');
  assert.equal(rows[0].valid_to, rows[1].valid_from);
  assert.equal(rows[0].source, 'manual_initial');
  assert.equal(rows[0].multiplier, 10);
  assert.ok(rows[0].observed_at > rows[0].valid_from);
  assert.equal(rows[1].valid_to, null);
  const audits = f.db.prepare("SELECT * FROM audit_logs WHERE action='provider.recharge_history.confirm'").all();
  assert.equal(audits.length, 1);
  assert.equal(JSON.parse(audits[0].details_json).effectiveDate, '2020-01-01');
  const reopened = createDatabase(f.config.databasePath);
  try { assert.deepEqual(history(reopened, supplier.id), rows); } finally { reopened.close(); }
});

test('legacy creation and automatic detection never backdate a rate without explicit confirmation', t => {
  const f = fixture(t);
  const supplier = f.providers.create({ ...input, rechargeMultiplier: 10 });
  assert.equal(history(f.db, supplier.id).length, 1);
  assert.equal(history(f.db, supplier.id)[0].valid_from, supplier.created_at);
  const automatic = f.providers.create({ ...input, name: 'Auto', baseUrl: 'https://auto.example' });
  f.providers.recordRecharge(automatic.id, { multiplier: 1, balanceCurrency: 'USD', source: 'provider_api' });
  assert.notEqual(history(f.db, automatic.id)[0].source, 'manual_initial');
});

test('backfill replaces only the default prefix and leaves confirmed history and current automatic rate intact', t => {
  const f = fixture(t);
  const supplier = f.providers.create(input);
  f.providers.recordRecharge(supplier.id, { available: false }, '2020-01-01T00:00:00.000Z');
  f.providers.recordRecharge(supplier.id, { multiplier: 10, paidCurrency: 'CNY', balanceCurrency: 'USD',
    source: 'provider_api' }, '2020-01-01T04:00:00.000Z');
  f.providers.recordRecharge(supplier.id, { multiplier: 20, paidCurrency: 'CNY', balanceCurrency: 'USD',
    source: 'provider_api' }, '2020-01-02T04:00:00.000Z');
  const confirmed = history(f.db, supplier.id).filter(row => row.source !== 'default');
  f.providers.update(supplier.id, { initialRechargeRate: confirmation() });
  const rows = history(f.db, supplier.id);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.slice(1), confirmed);
  assert.equal(rows[0].paid_currency, 'CNY');
  assert.equal(rows[0].balance_currency, 'USD');
  assert.equal(f.providers.get(supplier.id).recharge.multiplier, 20);
  assert.equal(f.providers.get(supplier.id).recharge.manualMultiplier, null);
  assert.equal(JSON.parse(rows[0].context_json).replacedDefaults.length, 1);
  const again = JSON.stringify(rows);
  f.providers.update(supplier.id, { initialRechargeRate: confirmation() });
  assert.equal(JSON.stringify(history(f.db, supplier.id)), again);
});

test('partial default prefixes are retained before the chosen effective date and other suppliers are unchanged', t => {
  const f = fixture(t);
  const supplier = f.providers.create(input);
  const other = f.providers.create({ ...input, baseUrl: 'https://other.example', rechargeMultiplier: 2 });
  f.providers.recordRecharge(supplier.id, { available: false }, '2019-12-30T00:00:00.000Z');
  f.providers.recordRecharge(supplier.id, { multiplier: 10 }, '2020-01-01T04:00:00.000Z');
  const otherHistory = history(f.db, other.id);
  f.providers.update(supplier.id, { initialRechargeRate: confirmation() });
  const rows = history(f.db, supplier.id);
  assert.equal(rows[0].source, 'default');
  assert.equal(rows[0].valid_to, rows[1].valid_from);
  assert.equal(rows[1].valid_to, rows[2].valid_from);
  assert.deepEqual(history(f.db, other.id), otherHistory);
});

test('invalid or conflicting confirmations roll back the whole provider edit and credential update', t => {
  const f = fixture(t);
  const supplier = f.providers.create({ ...input, rechargeMultiplier: 10, initialRechargeRate: confirmation() });
  const before = history(f.db, supplier.id);
  for (const invalid of [confirmation(20), confirmation(10, '2020-01-02'), confirmation(0),
    confirmation(-1), confirmation(Infinity), confirmation(1000001), confirmation(1, '2026-02-30'),
    confirmation(1, '2099-01-01'), confirmation(1, '0099-01-01'), confirmation(1, 'bad')]) {
    assert.throws(() => f.providers.update(supplier.id, { name: 'Must roll back',
      credentials: { accessToken: 'must-roll-back' }, rechargeMultiplier: 30, initialRechargeRate: invalid }),
    error => ['RECHARGE_HISTORY_INVALID', 'RECHARGE_HISTORY_CONFLICT'].includes(error.code));
    assert.deepEqual(history(f.db, supplier.id), before);
    assert.equal(f.providers.get(supplier.id).name, input.name);
    assert.equal(f.providers.get(supplier.id).recharge.manualMultiplier, 10);
    assert.equal(f.providers.getCredentials(supplier.id).accessToken, 'fixture-only');
  }
});

test('unconfirmed automatic rates cannot be backfilled, but a current manual rate and initial confirmation save atomically', t => {
  const f = fixture(t);
  const supplier = f.providers.create(input);
  assert.throws(() => f.providers.update(supplier.id, { initialRechargeRate: confirmation() }),
    error => error.code === 'RECHARGE_HISTORY_UNCONFIRMED');
  assert.throws(() => f.providers.create({ ...input, baseUrl: 'https://invalid.example', initialRechargeRate: confirmation() }));
  assert.equal(f.providers.list().length, 1);
  f.providers.update(supplier.id, { rechargeMultiplier: 10, initialRechargeRate: confirmation() });
  assert.equal(history(f.db, supplier.id)[0].multiplier, 10);
});

test('effective dates use the configured timezone, including daylight saving, independently of the host timezone', t => {
  const f = fixture(t);
  f.config.timezone = 'America/New_York';
  const supplier = f.providers.create({ ...input, rechargeMultiplier: 10,
    initialRechargeRate: confirmation(10, '2020-07-01') });
  assert.equal(history(f.db, supplier.id)[0].valid_from, '2020-07-01T04:00:00.000Z');
  assert.deepEqual(historyOptions(f.config, new Date('2020-07-01T02:00:00Z')),
    { timezone: 'America/New_York', today: '2020-06-30' });
  assert.equal(initialHistory(f.db, supplier.id, f.config).firstMultiplier, 10);
});

test('history API requires admin authentication and CSRF and validates the new fields', async t => {
  const f = fixture(t);
  const app = createApplication({ ...f, startBackground: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  f.finalizers.push(async () => { await new Promise(resolve => server.close(resolve)); await app.locals.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const provider = f.providers.create({ ...input, rechargeMultiplier: 10 });
  assert.equal((await fetch(`${base}/api/providers/${provider.id}/recharge-history`)).status, 401);
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'test-password' }) });
  const session = await login.json();
  const headers = { 'Content-Type': 'application/json', Cookie: login.headers.get('set-cookie').split(';')[0] };
  const url = `${base}/api/providers/${provider.id}`;
  const body = JSON.stringify({ initialRechargeRate: confirmation() });
  assert.equal((await fetch(url, { method: 'PUT', headers, body })).status, 403);
  headers['X-CSRF-Token'] = session.csrfToken;
  for (const value of [confirmation(0), confirmation(1, 'bad'), { ...confirmation(), unexpected: true }]) {
    assert.equal((await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ initialRechargeRate: value }) })).status, 400);
  }
  assert.equal((await fetch(url, { method: 'PUT', headers, body })).status, 200);
  const response = await fetch(`${url}/recharge-history`, { headers });
  assert.match(response.headers.get('cache-control'), /no-store/);
  const result = await response.json();
  assert.equal(result.firstConfirmedAt, '2019-12-31T16:00:00.000Z');
  assert.equal(result.firstMultiplier, 10);
  assert.doesNotMatch(JSON.stringify(result), /fixture-only|accessToken|credential/);
});
