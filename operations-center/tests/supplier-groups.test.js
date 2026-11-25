'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');
const { supplierGroupFixture } = require('./supplier-group-fixture');
const { keyIdentity } = require('../src/services/supplier-group-source');
const { buildGroupReport } = require('../src/services/supplier-group-matcher');
const { SupplierGroupStore } = require('../src/supplier-group-store');
const { ProviderMonitorClient } = require('../src/provider-monitor-client');
const { createApp } = require('../src/app');
const { AuthService } = require('../src/auth');
async function fixture(t, options) { const f = await supplierGroupFixture(options); t.after(() => f.close()); return f; }
const response = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

test('supplier matching fingerprints are identical across services and never accept masks', () => {
  const { costKeyIdentity } = require('../../provider-monitor/src/security/cost-key-identity');
  for (const value of ['sk-synthetic-complete-key-001122334455', 'Bearer sk-synthetic-complete-key-001122334455',
    'synthetic-complete-key-001122334455', 'sk-1234...567890123456789', 'sk-1234********5678', 'sk-1234…567890123456789', 'short']) {
    assert.equal(keyIdentity(value), costKeyIdentity(value));
  }
  assert.equal(keyIdentity('Bearer sk-synthetic-complete-key-001122334455'), keyIdentity('synthetic-complete-key-001122334455'));
  assert.equal(keyIdentity('sk-1234...567890123456789'), null);
});

test('real SQL groups all accounts by upstream group without account membership multiplication', async t => {
  const f = await fixture(t), r = await f.service.getReport({ date: f.date });
  assert.equal(r.summary.groupCount, 6); assert.equal(r.summary.accountCount, 10); assert.equal(r.summary.issueCount, 3);
  assert.equal(r.summary.pendingAccountCount, 1);
  const claude = r.groups.find(g => g.groupRef === 'claude');
  assert.equal(claude.upstream, 15); assert.equal(claude.main, 35); assert.equal(claude.accountCount, 3);
  assert.equal(claude.localGroupCount, 3); assert.equal(claude.diff, 20); assert.equal(claude.status, 'comparable');
  assert.deepEqual(claude.accounts.map(a => [a.id, a.name, a.main]), [
    ['11', '灵枢 API Claude 主账号', 23], ['12', '灵枢 Claude 备用', 7], ['13', '灵枢 API Claude 高倍率', 5]
  ]);
  assert.deepEqual(claude.accounts[0].localGroups.map(g => g.main), [20, 3]);
  assert.equal(claude.accountsTruncated, false);
  assert.deepEqual(r.providerSummaries.find(p => p.id === 'ling'), {
    id: 'ling', name: '灵枢 API', groupCount: 2, knownGroups: 2, pendingAccountCount: 1,
    upstream: null, knownUpstream: 23, main: 47, diff: null
  });
  assert.equal(r.providerSummaries.find(p => p.id === 'nova').diff, null);
  assert.equal(r.providerSummaries.find(p => p.id === 'zen').upstream, null);
  assert.equal(r.providerSummaries.find(p => p.id === 'zen').knownUpstream, 0);
  assert.equal(r.groups.find(g => g.groupRef === 'gpt').main, 12);
  assert.equal(r.groups.find(g => g.groupRef === 'pro').status, 'upstream_high');
  assert.equal(r.groups.find(g => g.groupRef === 'batch').status, 'unlinked_key');
  assert.equal(r.groups.find(g => g.groupRef === 'zero').status, 'zero');
  assert.equal(r.groups.find(g => g.groupRef === 'unknown').diff, null);
  const detail = await f.service.getReport({ date: f.date, groupId: claude.id, keyId: 'k1', pageSize: 1 });
  assert.equal(detail.group.keys.find(k => k.id === 'k1').upstream, 12);
  assert.equal(detail.group.keys.find(k => k.id === 'k1').main, 30);
  assert.equal(detail.group.keys.find(k => k.id === 'k1').accountCount, 2);
  assert.equal(detail.pagination.total, 2); assert.equal(detail.group.localGroups.reduce((s, g) => s + g.main, 0), 25);
  const local = await f.service.getReport({ date: f.date, groupId: claude.id, view: 'local', pageSize: 100 });
  assert.equal(local.group.localGroups.reduce((s, g) => s + g.main, 0), 35);
  assert.deepEqual(local.group.localGroups.find(g => g.id === '1').accounts.map(a => a.name), ['灵枢 API Claude 主账号', '灵枢 API Claude 高倍率']);
  const accounts = await f.service.getReport({ date: f.date, groupId: claude.id, view: 'accounts', pageSize: 2 });
  assert.equal(accounts.pagination.total, 3);
  assert.deepEqual(accounts.group.accounts.map(a => a.main), [23, 7]);
  const nextAccounts = await f.service.getReport({ date: f.date, groupId: claude.id, view: 'accounts', pageSize: 2, page: 2 });
  assert.deepEqual(nextAccounts.group.accounts.map(a => a.main), [5]);
  assert.equal(nextAccounts.group.main, 35);
  const publicData = JSON.stringify([r, detail, local, await f.service.getReport({ view: 'mapping', issuesOnly: '0' })]);
  assert(!publicData.includes(keyIdentity(f.secrets[0]))); assert(!publicData.includes(f.secrets[0]));
  assert(!publicData.includes('upstreamSnapshot')); assert(!publicData.includes('siteSnapshot'));
  assert(f.queries.every(sql => /^(SELECT|WITH|BEGIN|SET LOCAL|COMMIT|ROLLBACK)/.test(sql)));
});

test('ambiguous supplier/group identity blocks comparison and does not allocate or duplicate usage', async t => {
  const f = await fixture(t), raw = await f.source.read('2026-11-24T16:00:00Z', '2026-11-25T16:00:00Z');
  const upstream = { items: structuredClone(f.items) }, settings = f.store.settings(f.service.scope());
  const accounts = raw.accounts.map(a => ({ ...a, stable: true }));
  accounts[1].name = '名称无法定位';
  let r = buildGroupReport(upstream, { ...raw, accounts }, settings, f.date, new Date().toISOString());
  assert.equal(r.groups.find(g => g.groupRef === 'claude').comparable, false);
  assert.equal(r.groups.find(g => g.groupRef === 'claude').main, 28);
  upstream.items[0].keys.push({ ...upstream.items[0].keys[0], groupRef: 'second-daily-group', cost: 1, upstreamAmount: 1 });
  r = buildGroupReport(upstream, { ...raw, accounts }, settings, f.date, new Date().toISOString());
  assert.equal(r.mappings.find(a => a.id === '11').matched, false);
  assert.match(r.mappings.find(a => a.id === '11').reason, /多个/);
  assert.equal(r.groups.find(g => g.groupRef === 'claude').diff, null);
  const partial = { items: [{ ...f.items[0], name: 'ABC科技123' }] };
  const source = { accounts: [{ ...accounts[0], name: 'ABC科技 标准账号' }], usage: raw.usage, complete: true };
  const result = buildGroupReport(partial, source, settings, f.date, new Date().toISOString());
  assert.equal(result.mappings.find(a => a.id === '11').matched, false);
  assert.equal(result.mappings.find(a => a.id === '11').providerId, undefined);
  const configured = buildGroupReport(partial, source, { ...settings, aliases: { ling: ['ABC科技'] } }, f.date, new Date().toISOString());
  assert.equal(configured.mappings.find(a => a.id === '11').matched, true);
});

test('account previews stay bounded while supplier and group totals include every account and page', async t => {
  const f = await fixture(t);
  await f.database.query(`INSERT INTO accounts
    SELECT n,'灵枢 API Claude 扩展账号 ' || n,'active',$1::jsonb,'2026-01-01T00:00:00Z',NULL
    FROM generate_series(100,110) n`, [JSON.stringify({ api_key: f.secrets[0] })]);
  await f.database.exec(`INSERT INTO usage_logs(user_id,account_id,group_id,actual_cost,created_at)
    SELECT 2,n,1,0.01,'2026-11-25T00:00:00Z' FROM generate_series(100,110) n;
    UPDATE usage_dashboard_daily SET total_requests=21`);
  const report = await f.service.getReport({ date: f.date, providerId: 'ling', pageSize: 1 });
  const group = report.groups[0];
  assert.equal(group.accountCount, 14);
  assert.equal(group.accounts.length, 10); assert.equal(group.accountsTruncated, true);
  assert.equal(group.main, 35.11); assert.equal(group.upstream, 15);
  assert.equal(report.pagination.total, 3);
  assert.deepEqual(report.providerSummaries.map(provider => [provider.id, provider.groupCount, provider.main, provider.upstream, provider.diff]),
    [['ling', 2, 47.11, null, null]]);
  const pages = await Promise.all([1, 2].map(page => f.service.getReport({ date: f.date, groupId: group.id, view: 'accounts', pageSize: 10, page })));
  assert.deepEqual(pages.map(page => page.group.accounts.length), [10, 4]);
  assert(pages.every(page => page.group.main === 35.11 && page.group.upstream === 15 && page.pagination.total === 14));
  assert.equal(new Set(pages.flatMap(page => page.group.accounts.map(account => account.id))).size, 14);
  const payload = JSON.stringify([report, pages]);
  assert(!payload.includes(f.secrets[0])); assert(!payload.includes(keyIdentity(f.secrets[0])));
});

test('a partial upstream group contributes only to the known subtotal and never creates a supplier difference', async t => {
  const f = await fixture(t);
  Object.assign(f.items[0].keys[1], { cost: null, upstreamAmount: null, requests: null, complete: false });
  const report = await f.service.getReport({ date: f.date });
  const provider = report.providerSummaries.find(provider => provider.id === 'ling');
  assert.equal(provider.main, 47);
  assert.equal(provider.upstream, null); assert.equal(provider.diff, null);
  assert.equal(provider.knownGroups, 1); assert.equal(provider.groupCount, 2);
  assert.equal(provider.knownUpstream, 20);
  assert.equal(report.groups.find(group => group.groupRef === 'claude').knownUpstream, 12);
});

test('missing detailed usage or native coverage stays unknown, including deleted/disabled accounts', async t => {
  const f = await fixture(t);
  await f.database.exec("UPDATE accounts SET deleted_at='2026-11-25T02:00:00Z' WHERE id=14");
  let r = await f.service.collect(f.date); assert.equal(r.mappings.find(a => a.id === '14').main, 12);
  assert.equal(r.mappings.find(a => a.id === '14').deleted, true);
  await f.database.exec("INSERT INTO usage_logs(user_id,account_id,group_id,actual_cost,created_at) VALUES(2,999,1,4,'2026-11-25T00:00:00Z'); UPDATE usage_dashboard_daily SET total_requests=11");
  r = await f.service.collect(f.date); assert.equal(r.siteComplete, false); assert(r.groups.every(g => g.diff === null));
  await f.database.exec('DELETE FROM usage_logs WHERE account_id=999; UPDATE usage_dashboard_daily SET total_requests=10');
  await f.database.exec('DELETE FROM usage_logs WHERE account_id=12');
  r = await f.service.collect(f.date); assert.equal(r.siteComplete, false);
  assert(r.groups.every(g => g.main === null && g.diff === null));
  const incomplete = await f.service.getReport({ date: f.date });
  assert(incomplete.groups.every(group => group.accounts.every(account => account.main === null && account.localGroups.every(local => local.main === null))));
  assert(incomplete.providerSummaries.every(provider => provider.main === null && provider.diff === null));
  await f.database.exec('DELETE FROM usage_dashboard_daily');
  const raw = await f.source.read('2026-11-24T16:00:00Z', '2026-11-25T16:00:00Z'); assert.equal(raw.complete, false);
});

test('day observations reject rotations but preserve previously observed historical identity', async t => {
  const f = await fixture(t); await f.service.collect(f.date);
  await f.database.query("UPDATE accounts SET credentials=$1::jsonb,updated_at='2026-11-25T03:00:00Z' WHERE id=11", [JSON.stringify({ api_key: f.secrets[2] })]);
  let r = await f.service.collect(f.date); assert.equal(r.mappings.find(a => a.id === '11').matched, false);
  assert.match(r.mappings.find(a => a.id === '11').reason, /身份/);
  const previous = f.store.observe('other', f.date, [{ id: '1', identity: 'old', name: 'old', updatedAt: '2026-11-24T00:00:00Z' }], [],
    '2026-11-24T16:00:00Z', '2026-11-25T16:00:00Z');
  assert.equal(previous[0].stable, true);
  const next = f.store.observe('other', f.date, [{ id: '1', identity: 'new', name: 'new', updatedAt: '2026-11-26T00:00:00Z' }], [],
    '2026-11-24T16:00:00Z', '2026-11-25T16:00:00Z'); assert.equal(next[0].identity, 'old');
});

test('unchanged observed credentials tolerate later account updates but actual identity changes stay blocked', async t => {
  const f = await fixture(t);
  await f.service.collect(f.date);
  await f.database.exec("UPDATE accounts SET updated_at='2026-11-25T03:00:00Z' WHERE id=11");
  let report = await f.service.collect(f.date);
  assert.equal(report.mappings.find(a => a.id === '11').matched, true);
  assert.equal(report.groups.find(g => g.groupRef === 'claude').main, 35);
  await f.database.exec("UPDATE accounts SET name='灵枢 API 新名称',updated_at='2026-11-25T03:01:00Z' WHERE id=11");
  report = await f.service.collect(f.date);
  const account = report.mappings.find(a => a.id === '11');
  assert.equal(account.matched, false); assert.equal(account.providerId, 'ling');
  assert.match(account.reason, /身份/);
});

test('name-identified accounts remain visible without upstream keys and keep cross-group consumption', async t => {
  const f = await fixture(t);
  f.items[0].keys = [];
  const report = await f.service.getReport({ date: f.date, providerId: 'ling' });
  assert.equal(report.groups.length, 0);
  assert.equal(report.pendingProviders.length, 1);
  const pending = report.pendingProviders[0];
  assert.equal(pending.id, 'ling'); assert.equal(pending.accountCount, 5);
  assert.equal(pending.main, 47);
  const account = pending.accounts.find(a => a.id === '11');
  assert.equal(account.name, '灵枢 API Claude 主账号'); assert.equal(account.main, 23);
  assert.deepEqual(account.localGroups.map(g => g.main), [20, 3]);
  assert.equal(report.providerSummaries[0].main, 47);
  assert.equal(report.providerSummaries[0].upstream, null); assert.equal(report.providerSummaries[0].diff, null);
  assert.equal(report.summary.accountCount, 5);
  const mapping = await f.service.getReport({ date: f.date, providerId: 'ling', view: 'mapping' });
  assert(mapping.mappings.every(a => a.providerId === 'ling' && !a.matched));
  assert(!JSON.stringify(report).includes(f.secrets[0]));
});

test('unused upstream groups are excluded before totals and pagination while zero-use accounts stay', async t => {
  const f = await fixture(t);
  const unused = { ...f.items[0].keys[0], id: 'unused-key', identity: null, groupRef: 'unused', cost: 999, upstreamAmount: 999 };
  f.items[0].keys.push(unused);
  f.items.push({ id: 'unused-provider', name: 'Unused Provider', complete: true, accountCovered: true, reasons: [], keys: [{ ...unused, id: 'unused-other' }] });
  const report = await f.service.getReport({ date: f.date });
  assert(report.groups.every(g => g.groupRef !== 'unused'));
  assert.equal(report.providerSummaries.find(p => p.id === 'ling').knownUpstream, 23);
  assert(!report.providerSummaries.some(p => p.id === 'unused-provider'));
  assert(report.groups.some(g => g.groupRef === 'zero' && g.main === 0 && g.accountCount === 1));
  assert.equal(report.pagination.total, 7);
  const pages = await Promise.all(Array.from({ length: 7 }, (_, n) => f.service.getReport({ date: f.date, pageSize: 1, page: n + 1 })));
  assert.equal(pages.flatMap(page => page.groups).length, 6);
  assert.equal(pages.flatMap(page => page.pendingProviders).length, 1);
});

test('pending previews paginate without losing supplier totals or exposing credentials', async t => {
  const f = await fixture(t);
  f.items[0].keys = [];
  await f.database.query(`INSERT INTO accounts SELECT n,'灵枢 API 待核对 ' || n,'active',$1::jsonb,'2026-01-01T00:00:00Z',NULL
    FROM generate_series(100,111) n`, [JSON.stringify({ api_key: f.secrets[0] })]);
  const report = await f.service.getReport({ providerId: 'ling' });
  assert.equal(report.pendingProviders[0].accounts.length, 10);
  assert.equal(report.pendingProviders[0].accountsTruncated, true);
  assert.equal(report.pendingProviders[0].accountCount, 17);
  assert.equal(report.providerSummaries[0].main, 47);
  const pages = await Promise.all([1, 2].map(page => f.service.getReport({ providerId: 'ling', view: 'mapping', pageSize: 10, page })));
  assert.equal(new Set(pages.flatMap(page => page.mappings.map(a => a.id))).size, 17);
  assert(pages.every(page => page.providerSummaries[0].main === 47));
  assert(!JSON.stringify([report, pages]).includes(f.secrets[0]));
});

test('archive retries retain confirmed upstream values and allow incomplete main-site data to fill', async t => {
  const f = await fixture(t);
  f.controls.clock = new Date('2026-11-25T18:00:00Z');
  await f.database.exec('UPDATE usage_dashboard_daily SET total_requests=11');
  let r = await f.service.collect(f.date, { archive: true }); assert.equal(r.siteComplete, false);
  f.items[0].keys.forEach(k => { k.cost = 0; k.upstreamAmount = 0; k.requests = 0; });
  await f.database.exec('UPDATE usage_dashboard_daily SET total_requests=10');
  r = await f.service.collect(f.date, { archive: true });
  assert.equal(r.groups.find(g => g.groupRef === 'claude').upstream, 15);
  assert.equal(r.groups.find(g => g.groupRef === 'claude').main, 35);
  assert.equal(r.groups.find(g => g.groupRef === 'claude').diff, 20);
  const calls = f.controls.calls.length;
  const archived = await f.service.getReport({ date: f.date }); assert.equal(archived.source, 'archive');
  assert.equal(f.controls.calls.length, calls);
  f.controls.clock = new Date('2026-11-27T04:00:00Z');
  await assert.rejects(f.service.collect(f.date, { archive: true }), { code: 'SUPPLIER_HISTORY_FETCH_FORBIDDEN' });
  const missing = await f.service.getReport({ date: '2026-11-24' }); assert.equal(missing.source, 'history_missing');
  assert.equal(f.controls.calls.length, calls);
  const reopened = new SupplierGroupStore(f.directory); reopened.initialize();
  try { assert.equal(reopened.get(f.service.scope(), f.date).groups.find(g => g.groupRef === 'claude').upstream, 15); } finally { reopened.close(); }
});

test('settings persist with audit, only current-day matching updates, and pagination is bounded', async t => {
  const f = await fixture(t, { history: true });
  const policy = f.store.settings(f.service.scope()); policy.aliases.ling = ['自定义别名']; policy.alert.amount = 100;
  f.service.configure(policy, { id: 'admin' });
  const report = await f.service.getReport({ date: f.date, pageSize: '1', page: '100' });
  assert.equal(report.pagination.page, 7); assert.equal(report.groups.length, 1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM sg_audit').get().n, 1);
  assert.deepEqual(f.store.settings(f.service.scope()), policy);
  await assert.rejects(f.service.getReport({ date: '2026-02-30' }), { code: 'INVALID_DATE_RANGE' });
  await assert.rejects(f.service.getReport({ groupId: 'bad' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => f.service.configure({ ...policy, alert: { ...policy.alert, amount: -1 } }), { code: 'INVALID_REQUEST' });
  const g = (await f.service.getReport({ date: f.date })).groups.find(g => g.groupRef === 'pro');
  assert.equal(g.status, 'upstream_above');
  const detail = await f.service.getReport({ date: f.date, groupId: g.id, view: 'daily' });
  assert.equal(detail.group.days.length, 7); assert(detail.group.days.every(d => d.upstream === 20));
  assert.equal(detail.pagination.totalPages, 1);
});

test('single-flight, timeout, stale fallback and shutdown prevent late source writes', async t => {
  const f = await fixture(t, { timeoutMs: 40 });
  await f.service.getReport({ date: f.date });
  f.controls.clock = new Date(f.controls.clock.getTime() + 61000);
  let release; f.controls.delay = new Promise(resolve => { release = resolve; });
  const count = f.controls.calls.length;
  const [a, b] = await Promise.all([f.service.getReport({ date: f.date }), f.service.getReport({ date: f.date })]);
  assert.equal(f.controls.calls.length, count + 1); assert.equal(a.stale, true); assert.equal(b.stale, true);
  assert(a.groups.every(g => g.diff === null));
  assert(a.providerSummaries.every(provider => provider.diff === null));
  const saved = f.store.get(f.service.scope(), f.date);
  release(); await new Promise(resolve => setTimeout(resolve, 15));
  assert.deepEqual(f.store.get(f.service.scope(), f.date), saved);
  await f.service.stop(); await assert.rejects(f.service.collect(f.date), { code: 'SERVICE_STOPPING' });
});

test('source/scope and finance-day changes discard responses and observations', async t => {
  const f = await fixture(t), scope = f.service.scope(), original = f.source.read.bind(f.source);
  f.source.read = async (...args) => { const r = await original(...args); f.pool.connectionString += '-changed'; return r; };
  await assert.rejects(f.service.collect(f.date), { code: 'SOURCE_CHANGED' });
  assert.equal(f.store.get(scope, f.date), null); assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM sg_observations').get().n, 0);
  f.source.read = async (...args) => { const r = await original(...args); f.controls.clock = new Date('2026-11-26T17:00:00Z'); return r; };
  await assert.rejects(f.service.collect(f.date), { code: 'SUPPLIER_HISTORY_FETCH_FORBIDDEN' });
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM sg_observations').get().n, 0);
  f.source.read = original; f.controls.clock = new Date('2026-11-25T04:00:00Z');
  const observe = f.store.observe.bind(f.store);
  f.store.observe = (...args) => { const accounts = observe(...args); f.controls.clock = new Date('2026-11-26T17:00:00Z'); return accounts; };
  await assert.rejects(f.service.collect(f.date), { code: 'SUPPLIER_HISTORY_FETCH_FORBIDDEN' });
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM sg_observations').get().n, 0);
});

test('native source counts both 25-hour DST day and every overlapping source day', async t => {
  const f = await fixture(t); f.config.financeTimezone = 'America/New_York'; f.config.sub2apiTimezone = 'UTC';
  const day = DateTime.fromISO('2026-11-01', { zone: f.config.financeTimezone });
  assert.equal(day.plus({ days: 1 }).diff(day, 'hours').hours, 25);
  await f.database.exec(`DELETE FROM usage_logs; DELETE FROM usage_dashboard_daily;
    INSERT INTO usage_logs(user_id,account_id,group_id,actual_cost,created_at) VALUES
    (2,11,1,3,'2026-11-01T05:30:00Z'),(2,11,2,4,'2026-11-01T06:30:00Z'),(2,12,1,5,'2026-11-02T04:30:00Z');
    INSERT INTO usage_dashboard_daily VALUES('2026-11-01',2),('2026-11-02',1)`);
  let r = await f.source.read(day.toUTC().toISO(), day.plus({ days: 1 }).toUTC().toISO());
  assert.equal(r.complete, true); assert.equal(r.usage.reduce((s, r) => s + Number(r.amount), 0), 12);
  await f.database.exec("DELETE FROM usage_dashboard_daily WHERE bucket_date='2026-11-02'");
  r = await f.source.read(day.toUTC().toISO(), day.plus({ days: 1 }).toUTC().toISO()); assert.equal(r.complete, false);
});

test('monitor client sends group reads with integration or SSO authentication and propagates cancellation', async () => {
  const calls = [], config = { providerMonitorBaseUrl: 'http://synthetic.test', providerMonitorRequestTimeoutMs: 100 };
  const fetcher = async (url, options) => { calls.push({ url, options }); return response(url.endsWith('/sso') ? { sessionToken: 'session' } : { items: [] }); };
  const integration = new ProviderMonitorClient({ ...config, providerMonitorIntegrationToken: 'integration' }, fetcher);
  await integration.getGroupDailyCosts({ from: '2026-11-25', archive: '1' });
  assert.match(calls[0].url, /\/api\/integrations\/group-daily-costs\?/); assert.equal(calls[0].options.headers.authorization, 'Bearer integration');
  const sso = new ProviderMonitorClient(config, fetcher); await sso.getGroupDailyCosts({}, 'main-site-token');
  assert.equal(calls[1].options.headers.authorization, 'Bearer main-site-token'); assert.equal(calls[2].options.headers.authorization, 'Session session');
  const signal = new AbortController(); signal.abort(); await assert.rejects(integration.getGroupDailyCosts({}, null, { signal: signal.signal }), { code: 'PROVIDER_MONITOR_TIMEOUT' });
});

test('HTTP group report/settings require administrator session and CSRF, and reject invalid upstream rows', async t => {
  const f = await fixture(t), auth = new AuthService(f.config); t.after(() => auth.close());
  const app = createApp({ config: f.config, auth, supplierGroups: f.service, settings: { getStatus: () => ({ setupRequired: false }) } });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve))); const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${url}/api/cost-analysis/supplier-groups`)).status, 401);
  const login = await fetch(`${url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'synthetic-admin-password' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0], session = await login.json();
  let r = await fetch(`${url}/api/cost-analysis/supplier-groups`, { headers: { cookie } }); assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store');
  const options = { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(f.store.settings(f.service.scope())) };
  assert.equal((await fetch(`${url}/api/cost-analysis/supplier-groups/settings`, options)).status, 403);
  options.headers['x-csrf-token'] = session.csrfToken; assert.equal((await fetch(`${url}/api/cost-analysis/supplier-groups/settings`, options)).status, 200);
  f.items[0].keys.push(structuredClone(f.items[0].keys[0]));
  await assert.rejects(f.service.collect(f.date), { code: 'SUPPLIER_GROUP_INVALID_SOURCE' });
});
