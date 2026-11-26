'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { DateTime } = require('luxon');
const { loadConfig } = require('../src/config');
const { SupplierGroupStore } = require('../src/supplier-group-store');
const { SupplierGroupSource, keyIdentity } = require('../src/services/supplier-group-source');
const { SupplierGroupService } = require('../src/services/supplier-group-service');

async function supplierGroupFixture({ date = '2026-11-25', history = false, timeoutMs = 1000, dailyTotals = null } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'supplier-group-test-'));
  const config = loadConfig({ NODE_ENV: 'test', OPERATIONS_CENTER_AUTH_MODE: 'local', OPERATIONS_CENTER_ADMIN_PASSWORD: 'synthetic-admin-password',
    FINANCE_TIMEZONE: 'Asia/Shanghai', SUB2API_TIMEZONE: 'Asia/Shanghai', PROVIDER_MONITOR_BASE_URL: 'https://synthetic.example',
    DATABASE_URL: 'postgres://synthetic:example@local.invalid/example', OPERATIONS_CENTER_DATA_DIR: directory });
  const database = new PGlite(), queries = [], controls = { calls: [], dailyCalls: [], dailyTotals, unavailable: false, delay: null,
    clock: DateTime.fromISO(date, { zone: config.financeTimezone }).set({ hour: 12 }).toJSDate() };
  const pool = { connectionString: config.databaseUrl, async connect() { return {
    async query(sql, values) { queries.push(sql); return database.query(sql, values); }, release() {}
  }; } };
  const store = new SupplierGroupStore(directory); store.initialize();
  const source = new SupplierGroupSource({ pool, config });
  const secrets = Array.from({ length: 10 }, (_, i) => `sk-synthetic-supplier-group-key-${String(i + 1).padStart(4, '0')}`);
  const key = (id, groupRef, groupName, cost, index, requests = 1) => ({ id, name: `Key ${id}`, groupRef, groupName,
    identity: keyIdentity(secrets[index]), maskedKey: `sk-s...${String(index + 1).padStart(4, '0')}`,
    cost, upstreamAmount: cost, requests: cost === null ? null : requests, complete: cost !== null,
    reasons: cost === null ? ['上游未提供完整的当日分组消费'] : [] });
  const items = [
    { id: 'ling', name: '灵枢 API', complete: true, accountCovered: true, reasons: [], keys: [
      key('k1', 'claude', 'Claude 标准', 12, 0, 4), key('k2', 'claude', 'Claude 标准', 3, 1), key('k3', 'gpt', 'GPT 优选', 8, 2)] },
    { id: 'nova', name: 'Nova Relay', complete: true, accountCovered: true, reasons: [], keys: [
      key('k4', 'pro', 'Pro', 20, 3, 2), key('k5', 'batch', 'Batch', 4, 4), key('k6', 'batch', 'Batch', 2, 5)] },
    { id: 'zen', name: 'Zen API', complete: false, accountCovered: true, reasons: [], keys: [
      key('k7', 'zero', 'Zero', 0, 6, 0), key('k8', 'unknown', '待归档分组', null, 7)] }
  ];
  const monitor = { integrationToken: 'synthetic', configured: () => true, async getGroupDailyCosts(query, token, options) {
    controls.calls.push({ query, token, options });
    if (controls.delay) await controls.delay;
    if (controls.unavailable) throw new Error('synthetic upstream unavailable');
    return { source: 'upstream_key_group_daily_v1', date: query.from, timezone: query.timezone, currency: 'CNY',
      providerFilter: 'scheduled_enabled', items: structuredClone(items) };
  } };
  if (dailyTotals !== null) monitor.getDailyCosts = async query => {
    controls.dailyCalls.push(query);
    const providers = Object.entries(controls.dailyTotals || {}).map(([id, row]) => {
      const source = items.find(item => item.id === id);
      return { id, name: source?.name || id, cost: row.amount, requests: row.requests ?? null,
        complete: row.complete !== false, reasons: row.reasons || [] };
    });
    return { source: 'upstream_daily_summary', scope: 'account', timezone: query.timezone, currency: 'CNY',
      providerFilter: 'scheduled_enabled', items: [{ date: query.from, complete: providers.every(provider => provider.complete && provider.cost !== null),
        cost: providers.every(provider => provider.cost !== null) ? providers.reduce((sum, provider) => sum + provider.cost, 0) : null,
        requests: providers.every(provider => provider.requests !== null) ? providers.reduce((sum, provider) => sum + provider.requests, 0) : null,
        providers }] };
  };
  controls.dailyTotals = dailyTotals;
  const service = new SupplierGroupService({ source, store, providerMonitor: monitor, config,
    now: () => new Date(controls.clock), timeoutMs });
  await database.exec(`CREATE TABLE accounts(id bigint PRIMARY KEY,name text,status text,credentials jsonb,updated_at timestamptz,deleted_at timestamptz);
    CREATE TABLE groups(id bigint PRIMARY KEY,name text);
    CREATE TABLE account_groups(account_id bigint,group_id bigint);
    CREATE TABLE usage_logs(id bigserial,user_id bigint,account_id bigint,group_id bigint,actual_cost numeric,created_at timestamptz);
    CREATE TABLE usage_dashboard_daily(bucket_date date PRIMARY KEY,total_requests bigint);
    INSERT INTO groups VALUES(1,'主站标准'),(2,'主站高倍率'),(3,'主站专享');
    INSERT INTO account_groups VALUES(11,1),(11,2),(12,3),(13,1),(14,2);`);
  const accounts = [
    [11, '灵枢 API Claude 主账号', 0], [12, '灵枢 Claude 备用', 0], [13, '灵枢 API Claude 高倍率', 1],
    [14, '灵枢 API GPT 已停用', 2], [21, 'Nova Relay Pro A', 3], [22, 'Nova Relay Pro B', 3],
    [23, 'Nova Relay Batch', 4], [31, 'Zen API Zero', 6], [32, 'Zen API 待归档', 7],
    [90, '未命名供应商', 8], [91, '灵枢 API 待核验 Key', 9], [92, '无来源账号', null]
  ];
  for (const [id, name, index] of accounts) await database.query(`INSERT INTO accounts VALUES($1,$2,$3,$4::jsonb,$5,NULL)`,
    [id, name, id === 14 ? 'disabled' : 'active', JSON.stringify({ api_key: index === null ? '***' : secrets[index] }), '2026-01-01T00:00:00Z']);
  for (let offset = history ? 6 : 0; offset >= 0; offset--) {
    const day = DateTime.fromISO(date, { zone: config.financeTimezone }).minus({ days: offset });
    const at = day.set({ hour: 4 }).toUTC().toISO();
    await database.query(`INSERT INTO usage_logs(user_id,account_id,group_id,actual_cost,created_at)
      SELECT u.user_id,u.account_id,u.group_id,u.amount,$1::timestamptz FROM (VALUES
      (1,11,1,9999),(2,11,1,20),(3,11,2,3),(2,12,3,7),(2,13,1,5),(2,14,2,12),
      (2,21,1,6),(2,22,2,4),(2,23,3,6),(2,32,1,2)) u(user_id,account_id,group_id,amount)`, [at]);
    await database.query('INSERT INTO usage_dashboard_daily VALUES($1,10)', [day.toISODate()]);
    if (offset > 0) {
      controls.clock = day.plus({ days: 1 }).set({ hour: 2 }).toJSDate();
      await service.collect(day.toISODate(), { archive: true });
    }
  }
  controls.clock = DateTime.fromISO(date, { zone: config.financeTimezone }).set({ hour: 12 }).toJSDate();
  return { date, directory, config, database, pool, queries, source, store, service, controls, items, secrets,
    async close() { await service.stop(); store.close(); await database.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}
module.exports = { supplierGroupFixture };
