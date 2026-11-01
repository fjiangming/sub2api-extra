'use strict';

// Local example: real report SQL and SQLite stores, synthetic users and suppliers.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { PGlite } = require('@electric-sql/pglite');
const { loadConfig } = require('../src/config');
const { AuthService } = require('../src/auth');
const { createApp } = require('../src/app');
const { SchemaInspector } = require('../src/schema-inspector');
const { CostLedgerStore } = require('../src/cost-ledger-store');
const { AccountingStore } = require('../src/accounting-store');
const { DailyProfitStore } = require('../src/daily-profit-store');
const { AccountingService } = require('../src/services/accounting-service');
const { CostAnalysisService } = require('../src/services/cost-analysis-service');
const { DailyProfitService } = require('../src/services/daily-profit-service');
const { dateInTimezone, addUtcDays } = require('../src/services/metrics-service');

async function startPreview({ port = 0 } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-accounting-preview-'));
  const password = crypto.randomBytes(24).toString('hex');
  const config = loadConfig({ NODE_ENV: 'test', OPERATIONS_CENTER_AUTH_MODE: 'local', OPERATIONS_CENTER_ADMIN_PASSWORD: password,
    FINANCE_TIMEZONE: 'Asia/Shanghai', SUB2API_TIMEZONE: 'Asia/Shanghai', PROVIDER_MONITOR_BASE_URL: 'https://synthetic.example',
    DATABASE_URL: 'postgres://synthetic:example@local.invalid/example', OPERATIONS_CENTER_DATA_DIR: directory });
  const today = dateInTimezone(config.financeTimezone), start = addUtcDays(today, -30);
  const database = new PGlite();
  const inspector = new SchemaInspector(database);
  const auth = new AuthService(config);
  const ledger = new CostLedgerStore(directory); await ledger.initialize();
  const store = new AccountingStore(directory, AccountingService.scope(config)); store.initialize();
  const dailyStore = new DailyProfitStore(directory); dailyStore.initialize();
  const controls = { supplierUnavailable: false, supplierCalls: 0 };
  const monitor = { configured: () => true, integrationToken: 'synthetic',
    listProviders: async () => [{ id: 'alpha', name: 'Sub2API 示例上游', enabled: true, currency: 'USD', adapterType: 'sub2api' }, { id: 'beta', name: 'New API 示例上游', enabled: true, currency: 'USD', adapterType: 'new-api' }],
    createDailyCostsReader: async () => async input => {
      controls.supplierCalls++;
      return { source: 'upstream_daily_summary', scope: 'account', providerFilter: 'scheduled_enabled', currency: 'CNY', timezone: config.financeTimezone,
        range: { start: input.from, end: input.to }, items: [{ date: input.from, cost: controls.supplierUnavailable ? null : 18.5, complete: !controls.supplierUnavailable,
          providers: [{ id: 'alpha', name: 'Sub2API 示例上游', cost: 12, complete: true }, { id: 'beta', name: 'New API 示例上游', cost: controls.supplierUnavailable ? null : 6.5, complete: !controls.supplierUnavailable, reasons: controls.supplierUnavailable ? ['上游连接暂不可用'] : [] }] }] };
    },
    getFinancialBalances: async () => ({ currency: 'CNY', providerFilter: 'scheduled_enabled', complete: true, total: 3150,
      items: [{ id: 'alpha', name: 'Sub2API 示例上游', available: 4000, currency: 'USD', cashValue: 2000, complete: true, capturedAt: new Date().toISOString() }, { id: 'beta', name: 'New API 示例上游', available: 1150, currency: 'USD', cashValue: 1150, complete: true, capturedAt: new Date().toISOString() }] }) };
  const analysis = new CostAnalysisService({ pool: database, inspector, config, store: ledger, providerMonitor: monitor });
  const daily = new DailyProfitService({ analysis, store: dailyStore, config });
  const accounting = new AccountingService({ pool: database, inspector, config, store, ledger, analysis, dailyProfit: daily });
  analysis.accounting = accounting;
  accounting.configure({ startDate: start, reason: 'Isolated local example' }, 'example');
  await database.exec(`CREATE TABLE users(id bigint PRIMARY KEY,balance numeric,created_at timestamptz,deleted_at timestamptz,email text,username text);
    CREATE TABLE redeem_codes(id bigint,used_by bigint,type text,status text,value numeric,used_at timestamptz,code text,notes text,created_at timestamptz);
    CREATE TABLE payment_orders(id bigint,user_id bigint,amount numeric,pay_amount numeric,order_type text,paid_at timestamptz,completed_at timestamptz,
      refund_at timestamptz,refund_amount numeric,status text,recharge_code text,provider_snapshot jsonb);
    CREATE TABLE usage_logs(id bigserial,user_id bigint,billing_type smallint,actual_cost numeric,created_at timestamptz);
    CREATE TABLE usage_dashboard_daily(bucket_date date,total_requests bigint);`);
  await database.query(`INSERT INTO users VALUES(1,99999,$1::date,NULL,'admin@example.test','系统管理员'),
    (2,10140,$1::date,NULL,'paid@example.test','付费客户'),(3,690,$1::date,NULL,'gift@example.test','赠送客户'),
    (4,0,$1::date,NULL,'subscription@example.test','订阅客户');
    `, [start]);
  await database.query(`INSERT INTO payment_orders VALUES
    (1,2,12000,10000,'balance',$1::date+INTERVAL '1 hour',$1::date+INTERVAL '1 hour',NULL,0,'COMPLETED','example-paid','{"currency":"CNY"}'),
    (2,4,199,199,'subscription',$1::date+INTERVAL '1 hour',$1::date+INTERVAL '1 hour',NULL,0,'COMPLETED','','{"currency":"CNY"}');
    `, [start]);
  await database.query(`INSERT INTO redeem_codes VALUES(1,2,'balance','used',12000,$1::date+INTERVAL '1 hour','example-paid','Synthetic paid credit',$1::date),
    (2,3,'admin_balance','used',1000,$1::date+INTERVAL '1 hour','example-gift','Synthetic gift',$1::date);`, [start]);
  await database.query(`INSERT INTO usage_logs(user_id,billing_type,actual_cost,created_at)
    SELECT u.id,u.billing,u.cost,(day::date::timestamp AT TIME ZONE 'Asia/Shanghai')+INTERVAL '12 hours'
    FROM generate_series($1::date,$2::date,INTERVAL '1 day') day CROSS JOIN (VALUES (1,0,9999),(2,0,60),(3,0,10),(4,1,70)) AS u(id,billing,cost);
    `, [start, today]);
  await database.query(`INSERT INTO usage_dashboard_daily SELECT day::date,4 FROM generate_series($1::date,$2::date,INTERVAL '1 day') day`, [start, today]);
  for (let id = 5; id <= 28; id++) {
    await database.query("INSERT INTO users VALUES($1,40,$2::date,NULL,$3,$4)", [id, start, `example-${id}@example.test`, `示例客户 ${id}`]);
    await database.query("INSERT INTO redeem_codes VALUES($1,$1,'admin_balance','used',40,$2::date+INTERVAL '1 hour',$3,'Synthetic sample',$2::date)", [id, start, `example-${id}`]);
  }
  await analysis.getProviders({ refresh: true });
  dailyStore.enqueueDays(daily.scope(), Array.from({ length: 30 }, (_, index) => ({ date: addUtcDays(start, index) })));
  await daily.drain({ limit: 30 });
  await accounting.collectDay(today);
  for (const document of store.documents().filter(item => item.origin === 'redeem' && !item.payments.length)) accounting.classify(document.key, { kind: 'gift', amount: 0, currency: 'CNY', reason: 'Synthetic gift evidence' }, 'example');
  accounting.classify('payment:2', { kind: 'subscription', amount: 199, currency: 'CNY', serviceStart: start, serviceEnd: today, reason: 'Synthetic service agreement' }, 'example');
  accounting.create({ kind: 'fee', name: '年度域名费用', date: start, amount: 365, currency: 'CNY', serviceStart: start, serviceEnd: addUtcDays(start, 364), category: 'domain', reason: 'Synthetic invoice' }, 'example');
  const app = createApp({ config, auth, database: { ping: async () => ({ database: 'local-example' }), configured: () => true }, inspector, accounting, costAnalysis: analysis, dailyProfit: daily,
    settings: { getStatus: () => ({ setupRequired: false }) } });
  const outer = express();
  outer.get('/preview', async (req, res, next) => {
    try { await auth.login(req, res, { username: 'admin', password }); res.redirect('/#costs'); } catch (error) { next(error); }
  });
  outer.use(app);
  const server = outer.listen(port, '127.0.0.1'); await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  daily.start();
  return { port: server.address().port, start, today, accounting, controls, database, store, daily,
    async close() { await daily.stop(); await new Promise(resolve => server.close(resolve)); auth.close(); dailyStore.close(); store.close(); await database.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

if (require.main === module) startPreview({ port: Number(process.env.PORT || 19881) }).then(preview => {
  console.log(`Cost accounting example (synthetic data): http://127.0.0.1:${preview.port}/preview`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => preview.close().then(() => process.exit(0)));
}).catch(error => { console.error(error); process.exit(1); });

module.exports = { startPreview };
