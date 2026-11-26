const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');
const { ProviderRepository } = require('../src/repositories/provider-repository');
const { DailyCostService } = require('../src/services/daily-cost-service');
const { GroupDailyCostService } = require('../src/services/group-daily-cost-service');
const { Sub2ApiAdapter } = require('../src/adapters/sub2api');
const { OneApiFamilyAdapter } = require('../src/adapters/one-api-family');
const { SyncService } = require('../src/services/sync-service');
const { costKeyIdentity } = require('../src/security/cost-key-identity');
const { createApplication } = require('../src/server');

const query = { from: '2026-11-25', to: '2026-11-25', timezone: 'Asia/Shanghai', currency: 'CNY' };
function fixture(t, { count = 1, ...options } = {}) {
  const f = createTestContext({ PROVIDER_MONITOR_INTEGRATION_TOKEN: 'group-integration-token-0123456789' });
  t.after(() => f.cleanup());
  f.db.prepare("INSERT OR REPLACE INTO settings VALUES('currencyRates',?,'2026-11-25')").run(JSON.stringify({ USD: 1, CNY: 1 }));
  const providers = new ProviderRepository(f.db, f.config), calls = [], states = [];
  let clock = new Date('2026-11-25T04:00:00Z');
  for (let i = 0; i < count; i++) {
    const provider = providers.create({ name: `Supplier ${i}`, adapterType: 'sub2api', baseUrl: `https://supplier-${i}.example`,
      authMode: 'token_pair', credentials: { accessToken: 'synthetic-access', userId: '7' }, rechargeMultiplier: 2 });
    f.db.prepare("UPDATE provider_recharge_rate_history SET valid_from='2026-01-01',paid_currency='CNY',balance_currency='USD' WHERE connection_id=?").run(provider.id);
    f.db.prepare(`INSERT INTO remote_keys(id,connection_id,remote_id,name,masked_key,status,primary_group_ref,metadata_json,first_seen_at,last_seen_at)
      VALUES(?,?,?,'Synthetic key','sk-s...1234','active','9',?,'2026-01-01','2026-01-01')`).run(`key-${i}`, provider.id, '123', JSON.stringify({ costKeyIdentity: costKeyIdentity('sk-synthetic-group-key-001122334455') }));
    states.push({ provider, amount: 12, requests: 2, groups: [{ group_id: 9, group_name: 'Historical Group', actual_cost: 12, requests: 2 }] });
  }
  const http = { async requestJson(input, options = {}) {
    const url = new URL(input), state = states[Number(url.hostname.match(/supplier-(\d+)/)?.[1] || 0)]; calls.push({ url, options });
    if (state.before) await state.before(url);
    if (state.unavailable) throw new Error('synthetic unavailable');
    let data;
    if (url.pathname === '/api/v1/user/profile') data = { id: 7, username: 'synthetic' };
    else if (url.pathname === '/api/v1/usage') {
      if (state.groupsError) throw new Error('synthetic usage endpoint missing');
      const records = state.records || state.groups.flatMap(group => Array.from({ length: group.requests }, () => ({
        group_id: group.group_id, group: { id: group.group_id, name: group.group_name },
        actual_cost: group.actual_cost === null ? null : group.actual_cost / group.requests
      })));
      const known = records.reduce((sum, row) => sum + (row.actual_cost || 0), 0);
      if (!state.records && state.amount > known) records.push({ api_key_id: 999, group_id: 9, actual_cost: state.amount - known });
      const sorted = records.map((row, i) => ({ id: i + 1, user_id: 7, api_key_id: 123,
        created_at: '2026-11-25T00:00:00Z', ...row })).sort((a, b) => a.id - b.id);
      if (url.searchParams.get('sort_order') === 'desc') sorted.reverse();
      const page = Number(url.searchParams.get('page')), pageSize = Number(url.searchParams.get('page_size'));
      data = { items: sorted.slice((page - 1) * pageSize, page * pageSize), total: sorted.length, page, page_size: pageSize };
    }
    else if (url.pathname.includes('snapshot-v2')) {
      if (state.groupsError) throw new Error('synthetic group endpoint missing'); data = { groups: state.groups };
    } else if (url.pathname.endsWith('/usage/stats')) data = { total_actual_cost: state.amount, total_requests: state.requests };
    else throw new Error(`Unexpected ${url.pathname}`);
    return { data: { code: 0, data } };
  } };
  const dailyCosts = new DailyCostService({ ...f, providers, http, now: () => clock });
  const service = new GroupDailyCostService({ ...f, providers, http, dailyCosts, now: () => clock, ...options });
  return { ...f, providers, calls, states, http, dailyCosts, service, setClock(value) { clock = new Date(value); } };
}

test('daily upstream group reads use actual historical groups and verified account coverage', async t => {
  const f = fixture(t), report = await f.service.report(query), p = report.items[0];
  assert.equal(p.complete, true); assert.equal(p.keys[0].cost, 6); assert.equal(p.keys[0].groupRef, '9');
  assert.equal(p.keys[0].identity, costKeyIdentity('synthetic-group-key-001122334455'));
  const group = f.calls.find(c => c.url.pathname === '/api/v1/usage');
  assert.equal(group.url.searchParams.get('sort_by'), 'id'); assert.equal(group.url.searchParams.get('timezone'), 'Asia/Shanghai');
  assert.equal(f.calls.length, 3); assert(!f.calls.some(c => c.url.pathname.includes('/usage/stats')));
  assert(f.calls.every(c => c.options.retries === 0 && c.options.timeoutMs <= 6000));
  assert.doesNotMatch(JSON.stringify(report), /_configKey|_catalog|_account|_usageSnapshot|synthetic-access|subjectId/);
  const calls = f.calls.length; assert.equal((await f.service.report(query)).items[0].cached, true); assert.equal(f.calls.length, calls);
});

test('failed daily reads retain today catalog identities with unknown costs without saving a snapshot', async t => {
  const f = fixture(t);
  f.states[0].unavailable = true;
  let report = await f.service.report(query), p = report.items[0];
  assert.equal(p.complete, false); assert.equal(p.accountCovered, false);
  assert.equal(p.keys.length, 1); assert.equal(p.keys[0].groupRef, '9');
  assert.equal(p.keys[0].identity, costKeyIdentity('sk-synthetic-group-key-001122334455'));
  assert.equal(p.keys[0].cost, null); assert.equal(p.keys[0].upstreamAmount, null);
  assert.equal(p.keys[0].requests, null);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM provider_group_daily_costs').get().n, 0);
  const calls = f.calls.length;
  f.setClock('2026-11-26T04:00:00Z');
  report = await f.service.report(query);
  assert.equal(report.items[0].keys.length, 0); assert.equal(f.calls.length, calls);
  report = await f.service.report({ ...query, archive: '1' });
  assert.equal(report.items[0].keys.length, 0);
  assert.doesNotMatch(JSON.stringify(report), /synthetic-access|_catalog/);
});

test('invalid/duplicate group totals fail atomically and real empty days remain confirmed zero', async t => {
  const f = fixture(t);
  f.states[0].groups.push({ group_id: 10, group_name: 'invalid', actual_cost: null, requests: 1 });
  let p = (await f.service.report(query)).items[0]; assert.equal(p.complete, false); assert.equal(p.keys.length, 1); assert.equal(p.keys[0].cost, null);
  f.setClock('2026-11-25T04:02:00Z'); f.states[0].amount = 0; f.states[0].requests = 0; f.states[0].groups = [];
  p = (await f.service.report(query)).items[0]; assert.equal(p.complete, true); assert.equal(p.keys[0].cost, 0); assert.equal(p.keys[0].groupRef, '9');
  f.setClock('2026-11-25T04:04:00Z'); f.states[0].records = [
    { id: 1, group_id: 9, actual_cost: 0 }, { id: 1, group_id: 9, actual_cost: 0 }];
  p = (await f.service.report(query)).items[0]; assert.equal(p.complete, false); assert.equal(p.stale, true); assert.equal(p.keys[0].cost, 0);
});

test('group sums must cover the whole upstream account and duplicated supplier accounts are blocked', async t => {
  const f = fixture(t, { count: 2 });
  f.states[0].amount = 14;
  let r = await f.service.report(query); assert.equal(r.items.find(p => p.id === f.states[0].provider.id).accountCovered, false);
  f.db.prepare('UPDATE provider_connections SET base_url=? WHERE id=?').run('https://supplier-0.example', f.states[1].provider.id);
  f.setClock('2026-11-25T04:02:00Z'); f.states[0].amount = 12;
  r = await f.service.report(query); assert(r.items.every(p => !p.accountCovered && /多个供应商/.test(p.reasons.join(''))));
});

test('historical reads never contact upstream; only yesterday archive after 01:00 may fetch and known costs freeze', async t => {
  const f = fixture(t);
  let r = await f.service.report({ ...query, from: '2026-11-24', to: '2026-11-24' }); assert.equal(r.items[0].complete, false); assert.equal(f.calls.length, 0);
  f.setClock('2026-11-25T16:30:00Z'); r = await f.service.report({ ...query, archive: '1' }); assert.equal(f.calls.length, 0);
  f.setClock('2026-11-25T17:30:00Z'); r = await f.service.report({ ...query, archive: '1' }); assert.equal(r.items[0].keys[0].cost, 6);
  const count = f.calls.length; f.states[0].amount = 0; f.states[0].requests = 0; f.states[0].groups = [];
  f.setClock('2026-11-25T19:30:00Z'); r = await f.service.report({ ...query, archive: '1' }); assert.equal(r.items[0].keys[0].cost, 6); assert.equal(f.calls.length, count);
  f.setClock('2026-11-28T04:00:00Z'); r = await f.service.report(query); assert.equal(r.items[0].keys[0].cost, 6); assert.equal(f.calls.length, count);
});

test('initial archive retries fetch only missing keys while keeping known costs and account day total', async t => {
  const f = fixture(t); f.setClock('2026-11-25T18:00:00Z');
  f.db.prepare(`INSERT INTO remote_keys(id,connection_id,remote_id,name,status,primary_group_ref,metadata_json,first_seen_at,last_seen_at)
    VALUES('unknown',?,'124','Missing','active','9','{}','2026-01-01','2026-01-01')`).run(f.states[0].provider.id);
  const original = f.http.requestJson.bind(f.http); let missing = true;
  f.http.requestJson = async (url, options) => {
    if (new URL(url).searchParams.get('api_key_id') === '124') {
      if (missing) throw new Error('missing');
      return { data: { code: 0, data: new URL(url).pathname.includes('snapshot') ? { groups: [{ group_id: 9, actual_cost: 0, requests: 0 }] } : { total_actual_cost: 0, total_requests: 0 } } };
    } return original(url, options);
  };
  let r = await f.service.report({ ...query, archive: '1' }); assert.equal(r.items[0].complete, false);
  assert.equal(r.items[0].keys.find(k => k.id === 'key-0').cost, 6);
  const count = f.calls.length; missing = false; f.setClock('2026-11-25T18:02:00Z'); f.states[0].unavailable = true;
  r = await f.service.report({ ...query, archive: '1' }); assert.equal(r.items[0].complete, true);
  assert.equal(r.items[0].keys.find(k => k.id === 'key-0').cost, 6); assert.equal(f.calls.length, count);
});

test('historical verified zero keys retain their amount without inventing a historical group or hiding covered groups', async t => {
  const f = fixture(t); f.setClock('2026-11-25T18:00:00Z');
  f.db.prepare(`INSERT INTO remote_keys(id,connection_id,remote_id,name,status,primary_group_ref,metadata_json,first_seen_at,last_seen_at)
    VALUES('zero',?,'124','Zero key','active','999','{}','2026-01-01','2026-01-01')`).run(f.states[0].provider.id);
  const original = f.http.requestJson.bind(f.http);
  f.http.requestJson = async (url, options) => new URL(url).searchParams.get('api_key_id') === '124'
    ? { data: { code: 0, data: new URL(url).pathname.includes('snapshot') ? { groups: [] } : { total_actual_cost: 0, total_requests: 0 } } }
    : original(url, options);
  let provider = (await f.service.report({ ...query, archive: '1' })).items[0];
  assert.equal(provider.accountCovered, true); assert.equal(provider.complete, true);
  assert.equal(provider.keys.find(k => k.id === 'key-0').cost, 6);
  const zero = provider.keys.find(k => k.id === 'zero');
  assert.equal(zero.cost, 0); assert.equal(zero.upstreamAmount, 0); assert.equal(zero.requests, 0);
  assert.equal(zero.complete, false); assert.equal(zero.groupRef, null); assert.equal(zero.groupName, null);
  assert.match(zero.reasons.join(''), /零消费.*历史分组/);
  const calls = f.calls.length; f.setClock('2026-11-25T18:02:00Z'); f.states[0].unavailable = true;
  provider = (await f.service.report({ ...query, archive: '1' })).items[0];
  assert.equal(provider.complete, true); assert.equal(f.calls.length, calls);
});

test('verified historical zero does not cover a real account amount or request gap', async t => {
  for (const change of [{ amount: 13 }, { requests: 3 }]) {
    const f = fixture(t); f.setClock('2026-11-25T18:00:00Z');
    Object.assign(f.states[0], change);
    f.db.prepare(`INSERT INTO remote_keys(id,connection_id,remote_id,name,status,primary_group_ref,metadata_json,first_seen_at,last_seen_at)
      VALUES('zero',?,'124','Zero key','active','999','{}','2026-01-01','2026-01-01')`).run(f.states[0].provider.id);
    const original = f.http.requestJson.bind(f.http);
    f.http.requestJson = async (url, options) => {
      const target = new URL(url), keyId = target.searchParams.get('api_key_id');
      if (!keyId) return original(url, options);
      return { data: { code: 0, data: target.pathname.includes('snapshot') ? { groups: keyId === '124' ? [] : f.states[0].groups }
        : { total_actual_cost: keyId === '124' ? 0 : 12, total_requests: keyId === '124' ? 0 : 2 } } };
    };
    const provider = (await f.service.report({ ...query, archive: '1' })).items[0];
    assert.equal(provider.accountCovered, false); assert.equal(provider.complete, false);
    assert.equal(provider.keys.find(k => k.id === 'key-0').cost, 6);
    assert.equal(provider.keys.find(k => k.id === 'zero').cost, 0);
  }
});

test('report deadlines include queued providers and late completions cannot save snapshots', async t => {
  const f = fixture(t, { count: 6, timeoutMs: 1000, reportTimeoutMs: 250 });
  // Isolate network queue timing from synchronous password-key derivation on busy CI hosts.
  f.providers.getCredentials = () => ({ accessToken: 'synthetic-access', userId: '7' });
  let release; const gate = new Promise(resolve => { release = resolve; });
  f.states.forEach(s => { s.before = () => gate; });
  const start = Date.now(), r = await f.service.report(query);
  assert(Date.now() - start < 4000); assert.equal(r.items.length, 6); assert(r.items.every(p => !p.complete));
  assert.equal(f.calls.length, 3); assert(f.calls.every(c => c.options.signal.aborted));
  release(); for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM provider_group_daily_costs').get().n, 0);
  assert.equal(f.service.running.size, 0);
});

test('provider configuration and finance day changes invalidate in-flight writes', async t => {
  const f = fixture(t);
  f.states[0].before = url => { if (url.pathname === '/api/v1/usage') f.setClock('2026-11-27T04:00:00Z'); };
  let r = await f.service.report(query); assert.equal(r.items[0].complete, false);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM provider_group_daily_costs').get().n, 0);
  f.setClock('2026-11-25T04:00:00Z'); f.states[0].before = url => {
    if (url.pathname === '/api/v1/usage') f.providers.update(f.states[0].provider.id, { enabled: false });
  };
  r = await f.service.report(query); assert.equal(r.items[0].complete, false);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM provider_group_daily_costs').get().n, 0);
});

function adapter(type, handler) {
  const context = { connection: { adapter_type: type, auth_mode: type === 'sub2api' ? 'token_pair' : 'system_token', base_url: 'https://synthetic.example', type_config_json: {} },
    credentials: { accessToken: 'synthetic', systemToken: 'synthetic', userId: '7' }, config: { secret: 'synthetic-group-adapter-secret-32-characters' },
    http: { requestJson: async (url, options) => ({ data: await handler(new URL(url), options) }) } };
  return type === 'sub2api' ? new Sub2ApiAdapter(context) : new OneApiFamilyAdapter(context);
}
const day = { key: { remote_id: '123', name: 'shared-name' }, date: query.from, timezone: query.timezone,
  fromAt: '2026-11-24T16:00:00Z', toAt: '2026-11-25T16:00:00Z' };
const log = (id, extra = {}) => ({ id, token_id: 123, type: 2, quota: 1000, created_at: Date.parse('2026-11-25T00:00:00Z') / 1000, group: 'historical', ...extra });

const usageRow = (id, extra = {}) => ({ id, user_id: 7, api_key_id: 123, group_id: 9,
  group: { id: 9, name: 'Historical group' }, actual_cost: 0.5, created_at: '2026-11-25T00:00:00Z', ...extra });
function snapshotAdapter(records, { beforePage, afterPage, groupStats, pageSizeLimit = 1000 } = {}) {
  const calls = [];
  const a = adapter('sub2api', async url => {
    calls.push(url);
    if (url.pathname === '/api/v1/user/profile') return { code: 0, data: { id: 7 } };
    if (groupStats && ['/api/v1/usage/dashboard/snapshot-v2', '/api/v1/usage/stats'].includes(url.pathname)) {
      assert.equal(url.searchParams.get('start_date'), query.from);
      assert.equal(url.searchParams.get('timezone'), query.timezone);
      const groups = await groupStats(url, records);
      return { code: 0, data: url.pathname.includes('snapshot') ? { groups } : {
        total_actual_cost: groups.reduce((sum, group) => sum + group.actual_cost, 0),
        total_requests: groups.reduce((sum, group) => sum + group.requests, 0) } };
    }
    assert.equal(url.pathname, '/api/v1/usage');
    assert.equal(url.searchParams.get('sort_by'), 'id');
    await beforePage?.(url, records);
    const page = Number(url.searchParams.get('page')), size = Math.min(pageSizeLimit, Number(url.searchParams.get('page_size')));
    const sorted = [...records].sort((a, b) => a.id - b.id);
    if (url.searchParams.get('sort_order') === 'desc') sorted.reverse();
    const data = { total: sorted.length, page, page_size: size, items: sorted.slice((page - 1) * size, page * size) };
    await afterPage?.(data, url);
    return { code: 0, data };
  });
  return { a, calls };
}

test('Sub2API account, keys and groups share one fixed record boundary while live usage keeps increasing', async () => {
  const records = Array.from({ length: 1001 }, (_, i) => usageRow(i + 1, { api_key_id: i % 2 ? 124 : 123 }));
  const { a, calls } = snapshotAdapter(records, { pageSizeLimit: 500, beforePage(url, rows) {
    if (url.searchParams.get('sort_order') === 'asc') rows.push(usageRow(rows.length + 1, { actual_cost: 500 }));
  } });
  const snapshot = await a.getDailyGroupUsageSnapshot(day);
  assert.equal(snapshot.account.amount, 500.5); assert.equal(snapshot.account.requests, 1001);
  assert.equal(snapshot.keys.get('123')[0].amount, 250.5);
  assert.equal(snapshot.keys.get('124')[0].amount, 250);
  assert.equal(calls.length, 5);
  assert.deepEqual(calls.slice(2).map(url => url.searchParams.get('page_size')), ['500', '500', '500']);
  assert(records.length > snapshot.account.requests);
});

test('Sub2API resolves missing log group IDs from exact per-key historical group names while preserving the cutoff', async () => {
  const missing = (id, apiKey, name) => usageRow(id, { api_key_id: apiKey, group_id: null, group: null,
    group_name: name, api_key: { group_id: 999, group: { id: 999, name: 'Current group must be ignored' } } });
  const records = [missing(1, 123, 'Recorded A'), missing(2, 123, 'Recorded B'), missing(3, 124, 'Recorded A')];
  const { a, calls } = snapshotAdapter(records, { afterPage(data, url) {
    if (url.searchParams.get('sort_order') === 'desc') records.push(missing(4, 123, 'Recorded A'));
  }, groupStats(url) {
    return url.searchParams.get('api_key_id') === '123'
      ? [{ group_id: 9, group_name: 'Recorded A', actual_cost: 1, requests: 2 },
        { group_id: 10, group_name: 'Recorded B', actual_cost: 0.5, requests: 1 }]
      : [{ group_id: 34, group_name: 'Recorded A', actual_cost: 0.5, requests: 1 }];
  } });
  const first = await a.getDailyGroupUsageSnapshot(day);
  assert.equal(first.account.amount, 1.5); assert.equal(first.account.requests, 3);
  assert.deepEqual(first.keys.get('123').map(row => [row.groupRef, row.amount, row.requests]), [['9', 0.5, 1], ['10', 0.5, 1]]);
  assert.equal(first.keys.get('124')[0].groupRef, '34');
  assert.equal(calls.filter(url => url.pathname.includes('snapshot-v2')).length, 2);
  assert.equal(calls.filter(url => url.pathname.endsWith('/usage/stats')).length, 2);
  assert(!JSON.stringify(first.state).includes('999'));
  const next = await a.getDailyGroupUsageSnapshot({ ...day, previous: first.state });
  assert.equal(next.account.requests, 4); assert.equal(next.account.amount, 2);
  assert.equal(next.keys.get('123').find(row => row.groupRef === '9').amount, 1);
});

test('Sub2API missing group IDs reject ambiguous names, mismatched names, unavailable statistics and uncovered usage', async () => {
  for (const groups of [
    [], [{ group_id: 9, group_name: 'Another name', actual_cost: 1, requests: 1 }],
    [{ group_id: 9, group_name: 'Recorded', actual_cost: 0.5, requests: 1 }, { group_id: 10, group_name: 'Recorded', actual_cost: 0, requests: 0 }],
    [{ group_id: 9, group_name: 'Recorded', actual_cost: 0.4, requests: 1 }],
    [{ group_id: 9, group_name: 'Recorded', actual_cost: 0.5, requests: 0 }]
  ]) {
    const { a } = snapshotAdapter([usageRow(1, { group_id: null, group: null, group_name: 'Recorded' })], { groupStats: () => groups });
    await assert.rejects(a.getDailyGroupUsageSnapshot(day), { code: 'SCHEMA_MISMATCH' });
  }
  const { a } = snapshotAdapter([usageRow(1, { group_id: null, group: null, group_name: 'Recorded' })], {
    groupStats: () => { throw new Error('unavailable'); }
  });
  await assert.rejects(a.getDailyGroupUsageSnapshot(day), /unavailable/);
});

test('Sub2API historical name resolution has a three-key concurrency bound', async () => {
  let active = 0, maximum = 0;
  const { a } = snapshotAdapter(Array.from({ length: 10 }, (_, i) => usageRow(i + 1,
    { api_key_id: 123 + i, group_id: null, group: null, group_name: 'Recorded' })), { async groupStats() {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setImmediate(resolve)); active--;
    return [{ group_id: 34, group_name: 'Recorded', actual_cost: 0.5, requests: 1 }];
  } });
  const result = await a.getDailyGroupUsageSnapshot(day);
  assert.equal(result.account.requests, 10); assert.equal(result.account.amount, 5);
  assert.equal(maximum, 3); assert.equal(active, 0);
});

test('Sub2API rejects more than 500 keys requiring name resolution before starting their metadata reads', async () => {
  const { a, calls } = snapshotAdapter(Array.from({ length: 501 }, (_, i) => usageRow(i + 1,
    { api_key_id: 123 + i, group_id: null, group: null, group_name: 'Recorded' })), {
    pageSizeLimit: 500, groupStats: () => [{ group_id: 34, group_name: 'Recorded', actual_cost: 0.5, requests: 1 }]
  });
  await assert.rejects(a.getDailyGroupUsageSnapshot(day), { code: 'SOURCE_LIMIT' });
  assert.equal(calls.filter(url => url.pathname.includes('snapshot-v2')).length, 1);
  assert.equal(calls.filter(url => url.pathname.endsWith('/usage/stats')).length, 1);
});

test('historical group name resolution shares the collection deadline and never saves late results', async t => {
  const f = fixture(t, { timeoutMs: 250 });
  f.providers.getCredentials = () => ({ accessToken: 'synthetic-access', userId: '7' });
  f.states[0].records = [usageRow(1, { group_id: null, group: null, group_name: 'Historical Group' })];
  let release; const gate = new Promise(resolve => { release = resolve; });
  f.states[0].before = url => url.pathname.includes('snapshot-v2') ? gate : undefined;
  const provider = (await f.service.report(query)).items[0];
  assert.equal(provider.complete, false); assert.equal(provider.keys[0].cost, null);
  assert(f.calls.some(call => call.url.pathname.includes('snapshot-v2') && call.options.signal.aborted));
  release(); for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM provider_group_daily_costs').get().n, 0);
  assert.equal(f.service.running.size, 0);
});

test('Sub2API snapshots reject missing pages, ignored sorting, changing anchors, invalid costs and record limits', async () => {
  const cases = [
    (d, url) => { if (url.searchParams.get('sort_order') === 'asc') d.items.reverse(); },
    (d, url) => { if (url.searchParams.get('sort_order') === 'asc') d.items.pop(); },
    (d, url) => { if (url.searchParams.get('sort_order') === 'asc') d.items[1] = d.items[0]; },
    (d, url) => { if (url.searchParams.get('sort_order') === 'asc') d.items[2] = { ...d.items[2], actual_cost: 12 }; },
    d => { d.items[0] = { ...d.items[0], actual_cost: null }; },
    d => { d.items[0] = { ...d.items[0], group_id: null }; },
    d => { d.items[0] = { ...d.items[0], api_key_id: null }; },
    d => { d.items[0] = { ...d.items[0], user_id: 8 }; },
    d => { d.items[0] = { ...d.items[0], created_at: day.toAt }; },
    d => { delete d.total; },
    d => { d.page = 2; },
    d => { d.page_size = 0; }
  ];
  for (const afterPage of cases) {
    const { a } = snapshotAdapter([usageRow(1), usageRow(2), usageRow(3)], { afterPage });
    await assert.rejects(a.getDailyGroupUsageSnapshot(day), { code: 'SCHEMA_MISMATCH' });
  }
  const { a, calls } = snapshotAdapter([usageRow(1)], { afterPage(d) { d.total = 20001; } });
  await assert.rejects(a.getDailyGroupUsageSnapshot(day), { code: 'SOURCE_LIMIT' });
  assert.equal(calls.length, 2);
});

test('Sub2API persists a verified cutoff for incremental refreshes and refuses deleted or changed boundaries', async () => {
  const records = Array.from({ length: 1200 }, (_, i) => usageRow(i + 1));
  const { a, calls } = snapshotAdapter(records);
  const first = await a.getDailyGroupUsageSnapshot(day), saved = JSON.parse(JSON.stringify(first.state));
  records.push(usageRow(1201, { actual_cost: 2 }));
  const before = calls.length;
  const next = await a.getDailyGroupUsageSnapshot({ ...day, previous: saved });
  assert.equal(calls.length - before, 2);
  assert.equal(calls.at(-1).searchParams.get('page'), '3');
  assert.equal(next.account.requests, 1201); assert.equal(next.account.amount, 602);
  assert.equal(next.keys.get('123')[0].amount, 602);
  assert.equal(saved.account.requests, 1200); assert.equal(saved.account.amount, 600);
  const count = calls.length;
  assert.equal((await a.getDailyGroupUsageSnapshot({ ...day, previous: next.state })).account.amount, 602);
  assert.equal(calls.length - count, 1);
  records.shift(); records.push(usageRow(1202), usageRow(1203));
  await assert.rejects(a.getDailyGroupUsageSnapshot({ ...day, previous: next.state }), { code: 'SCHEMA_MISMATCH' });
  assert.equal(next.account.requests, 1201);
  await assert.rejects(a.getDailyGroupUsageSnapshot({ ...day, previous: { ...saved, timezone: 'UTC' } }), { code: 'SCHEMA_MISMATCH' });
});

test('Sub2API incremental snapshots continue beyond the initial record limit without rereading the whole day', async () => {
  const records = Array.from({ length: 20000 }, (_, i) => usageRow(i + 1));
  const { a, calls } = snapshotAdapter(records);
  const first = await a.getDailyGroupUsageSnapshot(day);
  records.push(usageRow(20001));
  const count = calls.length;
  const next = await a.getDailyGroupUsageSnapshot({ ...day, previous: JSON.parse(JSON.stringify(first.state)) });
  assert.equal(next.account.requests, 20001); assert.equal(next.account.amount, 10000.5);
  assert.equal(calls.length - count, 3);
  assert.deepEqual(calls.slice(-2).map(url => url.searchParams.get('page')), ['40', '41']);
});

test('Sub2API snapshot pages respect the configured response budget without exposing full log payloads', async () => {
  const { a, calls } = snapshotAdapter([usageRow(1, { unused_payload: 'x'.repeat(80000) }), usageRow(2, { unused_payload: 'x'.repeat(80000) })]);
  a.config.maxResponseBytes = 256000;
  const snapshot = await a.getDailyGroupUsageSnapshot(day);
  assert.equal(snapshot.account.requests, 2);
  assert.equal(calls[2].searchParams.get('page_size'), '1');
  assert(!JSON.stringify([...snapshot.keys]).includes('unused_payload'));
});

test('Sub2API snapshot pagination uses at most three concurrent reads and aggregates pages in order', async () => {
  let active = 0, maximum = 0;
  const { a } = snapshotAdapter(Array.from({ length: 10 }, (_, i) => usageRow(i + 1)), { pageSizeLimit: 2,
    async beforePage(url) {
      if (url.searchParams.get('sort_order') !== 'asc' || url.searchParams.get('page') === '1') return;
      active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setImmediate(resolve));
    },
    afterPage(data, url) { if (url.searchParams.get('sort_order') === 'asc' && data.page > 1) active--; }
  });
  const result = await a.getDailyGroupUsageSnapshot(day);
  assert.equal(result.account.amount, 5); assert.equal(result.account.requests, 10);
  assert.equal(maximum, 3); assert.equal(active, 0);
});

test('42 catalog keys use one bounded account snapshot without repeating requests or credential derivations', async t => {
  const f = fixture(t), state = f.states[0];
  for (let i = 1; i < 42; i++) f.db.prepare(`INSERT INTO remote_keys(id,connection_id,remote_id,name,status,primary_group_ref,metadata_json,first_seen_at,last_seen_at)
    VALUES(?,?,?,'Additional key','active','9','{}','2026-01-01','2026-01-01')`).run(`additional-${i}`, state.provider.id, String(123 + i));
  state.records = Array.from({ length: 42 }, (_, i) => usageRow(i + 1, { api_key_id: 123 + i, actual_cost: 1 }));
  const derivation = t.mock.method(require('node:crypto'), 'scryptSync');
  const result = (await f.service.report(query)).items[0];
  assert.equal(result.complete, true); assert.equal(result.accountCovered, true);
  assert.equal(result.keys.length, 42); assert.equal(result.keys.reduce((sum, k) => sum + k.cost, 0), 21);
  assert.equal(f.calls.length, 3);
  assert(derivation.mock.callCount() <= 5);
  state.records.push(usageRow(43, { actual_cost: 2 }));
  f.setClock('2026-11-25T04:02:00Z');
  const next = (await f.service.report(query)).items[0];
  assert.equal(next.complete, true); assert.equal(next.keys.reduce((sum, k) => sum + k.cost, 0), 22);
  assert.equal(f.calls.length, 6);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM provider_group_daily_costs').get().n, 1);
});

test('New API group logs verify exact token IDs, actual group, units, timestamps and complete pagination', async () => {
  const seen = [], a = adapter('new-api', url => {
    seen.push(url); if (url.pathname === '/api/status') return { success: true, data: { quota_per_unit: 1000 } };
    const page = Number(url.searchParams.get('p'));
    return { success: true, data: { total: 101, items: page === 1 ? Array.from({ length: 100 }, (_, i) => log(i + 1)) : [log(101, { token_id: 999 })] } };
  });
  assert.deepEqual(await a.getKeyDailyGroupUsage(day), [{ groupRef: 'historical', groupName: 'historical', amount: 100, requests: 100, currency: 'USD' }]);
  const url = seen.find(u => u.pathname === '/api/log/self'); assert.equal(url.searchParams.get('token_name'), 'shared-name');
  assert.equal(Number(url.searchParams.get('end_timestamp')), Date.parse(day.toAt) / 1000 - 1);
});

test('New API rejects missing IDs, duplicated logs, changing totals, truncation and unsupported adapters', async () => {
  const bad = [
    { total: 1, items: [log(1, { token_id: undefined })] }, { total: 2, items: [log(1), log(1)] },
    { total: 2, items: [log(1)] }, { total: 1, items: [log(1, { group: '' })] },
    { total: 1, items: [log(1, { created_at: Date.parse(day.toAt) / 1000 })] }, { items: [] }, { total: 0 }, { total: 'bad', items: [] }
  ];
  for (const data of bad) {
    const a = adapter('new-api', url => ({ success: true, data: url.pathname === '/api/status' ? { quota_per_unit: 1000 } : data }));
    await assert.rejects(a.getKeyDailyGroupUsage(day), { code: 'SCHEMA_MISMATCH' });
  }
  const changing = adapter('new-api', url => ({ success: true, data: url.pathname === '/api/status' ? { quota_per_unit: 1000 }
    : { total: Number(url.searchParams.get('p')) === 1 ? 101 : 102, items: Array.from({ length: 100 }, (_, i) => log(i + 1)) } }));
  await assert.rejects(changing.getKeyDailyGroupUsage(day), { code: 'SCHEMA_MISMATCH' });
  await assert.rejects(adapter('one-api', () => { throw new Error('must not query'); }).getKeyDailyGroupUsage(day), { code: 'CAPABILITY_UNSUPPORTED' });
});

test('ordinary supplier synchronization records complete-key fingerprints before masking', async t => {
  const f = createTestContext(); t.after(() => f.cleanup()); const providers = new ProviderRepository(f.db, f.config);
  const provider = providers.create({ name: 'New API', adapterType: 'new-api', baseUrl: 'https://synthetic.example', authMode: 'system_token', credentials: { systemToken: 'synthetic' } });
  const secret = 'sk-synthetic-group-key-001122334455';
  const sync = new SyncService({ ...f, providers, http: { async requestJson(input) {
    const url = new URL(input); let data;
    if (url.pathname === '/api/status') data = { quota_per_unit: 1000 };
    else if (url.pathname === '/api/user/self') data = { id: 7, username: 'synthetic', quota: 0, used_quota: 0, status: 1 };
    else if (url.pathname === '/api/user/self/groups') data = { premium: { ratio: 1 } };
    else if (url.pathname.startsWith('/api/token')) data = { total: 1, items: [{ id: 123, name: 'Synthetic', key: secret, group: 'premium', status: 1 }] };
    else if (url.pathname === '/api/log/self/stat') data = { quota: 0 };
    else data = { total: 0, items: [] };
    return { data: { success: true, data } };
  } } });
  const result = await sync.run(provider.id); assert.equal(result.status, 'succeeded');
  const row = f.db.prepare('SELECT * FROM remote_keys WHERE connection_id=?').get(provider.id);
  assert.equal(JSON.parse(row.metadata_json).costKeyIdentity, costKeyIdentity(secret)); assert(!JSON.stringify(row).includes(secret));
});

test('group integration endpoint requires its token and rejects ranges without querying suppliers', async t => {
  const f = fixture(t), app = createApplication({ config: f.config, db: f.db, startBackground: false });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await app.locals.close(); });
  const url = `http://127.0.0.1:${server.address().port}/api/integrations/group-daily-costs`;
  assert.equal((await fetch(url)).status, 401);
  const r = await fetch(`${url}?from=2026-11-23&to=2026-11-24&currency=CNY`, { headers: { authorization: `Bearer ${f.config.integrationToken}` } }); assert.equal(r.status, 400);
});
