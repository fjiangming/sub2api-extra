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
  const group = f.calls.find(c => c.url.pathname.includes('snapshot-v2'));
  assert.equal(group.url.searchParams.get('api_key_id'), '123'); assert.equal(group.url.searchParams.get('timezone'), 'Asia/Shanghai');
  assert(f.calls.every(c => c.options.retries === 0 && c.options.timeoutMs <= 6000));
  assert.doesNotMatch(JSON.stringify(report), /_configKey|_catalog|_account|synthetic-access|subjectId/);
  const calls = f.calls.length; assert.equal((await f.service.report(query)).items[0].cached, true); assert.equal(f.calls.length, calls);
});

test('invalid/duplicate group totals fail atomically and real empty days remain confirmed zero', async t => {
  const f = fixture(t);
  f.states[0].groups.push({ group_id: 10, group_name: 'invalid', actual_cost: null, requests: 0 });
  let p = (await f.service.report(query)).items[0]; assert.equal(p.complete, false); assert.equal(p.keys.length, 1); assert.equal(p.keys[0].cost, null);
  f.setClock('2026-11-25T04:02:00Z'); f.states[0].amount = 0; f.states[0].requests = 0; f.states[0].groups = [];
  p = (await f.service.report(query)).items[0]; assert.equal(p.complete, true); assert.equal(p.keys[0].cost, 0); assert.equal(p.keys[0].groupRef, '9');
  f.setClock('2026-11-25T04:04:00Z'); f.states[0].groups = [{ group_id: 9, actual_cost: 0, requests: 0 }, { group_id: 9, actual_cost: 0, requests: 0 }];
  p = (await f.service.report(query)).items[0]; assert.equal(p.complete, false); assert.equal(p.keys[0].cost, null);
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
  f.states[0].before = url => { if (url.pathname.includes('snapshot')) f.setClock('2026-11-27T04:00:00Z'); };
  let r = await f.service.report(query); assert.equal(r.items[0].complete, false);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM provider_group_daily_costs').get().n, 0);
  f.setClock('2026-11-25T04:00:00Z'); f.states[0].before = url => {
    if (url.pathname.includes('snapshot')) f.providers.update(f.states[0].provider.id, { enabled: false });
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
