'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { SchemaInspector } = require('../src/schema-inspector');
const { MetricsService, addUtcDays, dateInTimezone } = require('../src/services/metrics-service');
const { CostAnalysisService } = require('../src/services/cost-analysis-service');

let database;
let metrics;
let costs;
const timezone = 'Asia/Shanghai';
const today = dateInTimezone(timezone);
const cohort = addUtcDays(today, -40);
const range = { start: cohort, end: today };

test.before(async () => {
  database = new PGlite();
  await database.exec(`
    CREATE TABLE users (id bigint PRIMARY KEY, email text, username text, balance numeric,
      status text DEFAULT 'active', created_at timestamptz, deleted_at timestamptz);
    CREATE TABLE usage_logs (user_id bigint, created_at timestamptz, billing_type smallint DEFAULT 0,
      input_tokens bigint DEFAULT 0, output_tokens bigint DEFAULT 0,
      cache_creation_tokens bigint DEFAULT 0, cache_read_tokens bigint DEFAULT 0,
      actual_cost numeric DEFAULT 0, total_cost numeric DEFAULT 0,
      account_stats_cost numeric, account_rate_multiplier numeric, duration_ms integer);
    CREATE TABLE usage_dashboard_daily (bucket_date date PRIMARY KEY, total_requests bigint,
      computed_at timestamptz DEFAULT NOW());
    CREATE TABLE usage_dashboard_daily_users (bucket_date date, user_id bigint);
    CREATE TABLE payment_orders (id bigint PRIMARY KEY, user_id bigint, order_type text DEFAULT 'recharge',
      provider_snapshot jsonb DEFAULT '{}', pay_amount numeric DEFAULT 0, amount numeric DEFAULT 0,
      refund_amount numeric DEFAULT 0, paid_at timestamptz, refund_at timestamptz,
      status text DEFAULT 'COMPLETED', recharge_code text DEFAULT '');
    CREATE TABLE redeem_codes (id bigint PRIMARY KEY, code text, type text DEFAULT 'balance',
      value numeric, used_by bigint, status text DEFAULT 'used', used_at timestamptz,
      created_at timestamptz DEFAULT NOW(), notes text);
  `);
  await database.query(`INSERT INTO users (id, email, username, balance, created_at, status, deleted_at) VALUES
    (1, 'admin@example.test', 'Administrator', 99999, $1::date::timestamp AT TIME ZONE $3, 'active', NULL),
    (2, 'customer@example.test', 'Customer', 10, $1::date::timestamp AT TIME ZONE $3, 'active', NULL),
    (3, 'idle@example.test', 'Idle', 20, $1::date::timestamp AT TIME ZONE $3, 'active', NULL),
    (4, 'deleted@example.test', 'Deleted', 40, $2::date::timestamp AT TIME ZONE $3, 'active', NOW()),
    (5, 'disabled@example.test', 'Disabled', 30, $2::date::timestamp AT TIME ZONE $3, 'disabled', NULL)
  `, [cohort, today, timezone]);
  await database.query(`INSERT INTO usage_dashboard_daily_users
    SELECT ($1::date + offset_days), user_id FROM (VALUES
      (1, 0), (1, 1), (1, 7), (1, 30), (1, 39), (1, 40),
      (2, 0), (2, 1), (2, 7), (2, 30), (2, 40), (4, 40)
    ) v(user_id, offset_days)
  `, [cohort]);
  await database.query(`INSERT INTO usage_logs
    (user_id, created_at, input_tokens, output_tokens, actual_cost, total_cost, account_stats_cost, duration_ms) VALUES
    (1, $1::date::timestamp AT TIME ZONE $2, 999999, 999999, 9999, 9999, 9999, 99999),
    (1, ($1::date - 1)::timestamp AT TIME ZONE $2, 999999, 999999, 9999, 9999, 9999, 99999),
    (2, $1::date::timestamp AT TIME ZONE $2, 100, 10, 2, 3, 4, 100),
    (4, $1::date::timestamp AT TIME ZONE $2, 50, 30, 3, 5, 6, 300)
  `, [today, timezone]);
  await database.query(`INSERT INTO usage_dashboard_daily
    SELECT d::date, COUNT(l.user_id), NOW() FROM generate_series($1::date, $2::date, INTERVAL '1 day') d
    LEFT JOIN usage_logs l ON (l.created_at AT TIME ZONE $3)::date = d::date GROUP BY 1
  `, [cohort, today, timezone]);
  await database.query(`INSERT INTO payment_orders
    (id, user_id, order_type, provider_snapshot, pay_amount, amount, refund_amount, paid_at, refund_at, status, recharge_code) VALUES
    (1, 1, 'recharge', '{"currency":"USD"}', 9000, 9000, 9000, $1, $1, 'COMPLETED', 'ADMIN-MISSING'),
    (2, 1, 'recharge', '{}', 9000, 9000, 0, $1, NULL, 'FAILED', ''),
    (3, 1, 'recharge', '{}', 0, 0, 0, NULL, NULL, 'PAID', 'ADMIN-UNPAID'),
    (4, 2, 'recharge', '{"currency":"CNY"}', 100, 200, 20, $1, $1, 'COMPLETED', 'ONLINE'),
    (5, 3, 'subscription', '{"config":{"currency":"cny"}}', 50, 50, 0, $1, NULL, 'COMPLETED', ''),
    (6, NULL, 'recharge', '{"currency":"CNY"}', 25, 25, 0, $1, NULL, 'COMPLETED', ''),
    (7, 4, 'recharge', '{"currency":"CNY"}', 10, 10, 0, $1, NULL, 'PENDING', ''),
    (8, 5, 'recharge', '{}', 0, 0, 0, NULL, NULL, 'PAID', 'CUSTOMER-MISSING'),
    (9, 5, 'recharge', '{}', 15, 15, 0, $1, NULL, 'COMPLETED', '')
  `, [`${today}T04:00:00Z`]);
  await database.query(`INSERT INTO redeem_codes (id, code, type, value, used_by, status, used_at) VALUES
    (1, 'ADMIN-USED', 'balance', 10000, 1, 'used', $1),
    (2, 'ONLINE', 'balance', 100, 2, 'used', $1),
    (3, 'ADJUSTMENT', 'admin_balance', -5, 2, 'used', $1),
    (4, 'UNASSIGNED', 'balance', 7, NULL, 'used', $1),
    (5, 'STANDALONE', 'balance', 20, 3, 'used', $1),
    (6, 'SUBSCRIPTION', 'subscription', 999, 4, 'used', $1),
    (7, 'UNUSED', 'balance', 200, 4, 'unused', NULL)
  `, [`${today}T04:00:00Z`]);
  const config = { cacheTtlSeconds: 0, sub2apiTimezone: timezone, financeTimezone: timezone,
    retention: { usageDailyDays: 730, usageLogsDays: 30 } };
  const inspector = new SchemaInspector(database);
  metrics = new MetricsService(database, inspector, config);
  costs = new CostAnalysisService({ pool: database, inspector, config,
    store: { incomeEntries: () => [], entries: () => [] } });
});

test.after(async () => { await database?.close(); });

test('overview removes ID 1 from users, all activity windows, requests, consumption and payments', async () => {
  const report = await metrics.getOverview();
  assert.deepEqual(report.users, { total_users: 4, retained_users: 3, available_users: 2, new_today: 2, new_month: 2 });
  assert.deepEqual(report.activity, { dau: 2, mau: 2, active_7d: 2, active_30d: 2 });
  assert.equal(report.usage.requests_today, 2);
  assert.equal(report.usage.requests_month, 2);
  assert.equal(report.usage.spend_today, 5);
  assert.equal(report.usage.spend_month, 5);
  assert.equal(report.usage.metrics_today_complete, true);
  assert.equal(report.usage.metrics_month_complete, true);
  assert.deepEqual(report.payments, [{ currency: 'CNY', paid_today: 200, paid_month: 200, orders_month: 5 }]);
});

test('users excludes ID 1 from activity, registrations, first use, activation and cohort denominators', async () => {
  const report = await metrics.getUsers(range);
  assert.deepEqual(report.summary, { active_users: 2, new_users: 4, retained_users: 3,
    available_users: 2, first_observed_users: 2 });
  assert.deepEqual(report.activation7d, { mature_registrations: 2, activated_7d: 1, rate: 0.5 });
  assert.deepEqual(report.cohorts[0], { cohort_date: cohort, registered: 2, retained_d1: 1, retained_d7: 1, retained_d30: 1 });
  assert.equal(report.trend.find((row) => row.date === cohort).newUsers, 2);
  assert.equal(report.trend.find((row) => row.date === today).newUsers, 2);
  assert.equal(report.trend.find((row) => row.date === addUtcDays(today, -1)).activeUsers, 0);
});

test('finance removes admin payments, refunds, credits, currencies and anomalies while keeping unknown identities', async () => {
  const report = await metrics.getFinance(range);
  assert.equal(report.summary.some((row) => row.currency === 'USD'), false);
  const recharge = report.summary.find((row) => row.order_type === 'recharge');
  assert.deepEqual(recharge, { currency: 'CNY', order_type: 'recharge', orders: 4, paying_users: 3,
    gross_received: 150, estimated_cash_refund: 10, netReceived: 140, averageOrderValue: 37.5 });
  assert.equal(report.payments.reduce((sum, row) => sum + row.orders, 0), 5);
  assert.equal(report.payments.reduce((sum, row) => sum + row.gross_received, 0), 200);
  assert.equal(report.refunds.reduce((sum, row) => sum + row.refunded_orders, 0), 1);
  assert.equal(report.credits.reduce((sum, row) => sum + row.events, 0), 4);
  assert.equal(report.credits.reduce((sum, row) => sum + row.credited_amount, 0), 122);
  assert.equal(report.credits.find((row) => row.source === 'admin_adjustment').credited_amount, -5);
  assert.deepEqual(report.anomalies, { paid_status_conflicts: 1, status_without_paid_at: 1,
    inferred_currency_orders: 1, paid_without_credit: 1 });
});

test('cost income, profit, user audit, pagination and drilldown consistently exclude ID 1', async () => {
  const report = await costs.getReport({ ...range, currency: 'CNY' });
  assert.equal(report.summary.automaticRevenue, 122);
  assert.equal(report.summary.transactions, 4);
  assert.equal(report.summary.averageTransaction, 30.5);
  assert.equal(report.summary.userBalance, 60);
  assert.equal(report.summary.balanceUsers, 3);
  assert.equal(report.summary.profit, 122);
  assert.equal(report.summary.actualProfit, 62);
  assert.equal(report.periods.find((row) => row.start === today).balanceConsumption, 5);
  assert.equal(report.periods.find((row) => row.start === today).consumptionProfit, 5);
  const users = await costs.getAutomaticIncomeUsers(range);
  assert.deepEqual(users.summary, { users: 3, transactions: 4, totalIncome: 122 });
  assert.equal(users.pagination.total, 3);
  assert.equal(users.items.some((row) => row.userId === '1'), false);
  assert.equal(users.items.some((row) => row.userId === null), true);
  const admin = await costs.getAutomaticIncomeRecords('1', range);
  assert.equal(admin.summary.transactions, 0);
  assert.equal(admin.summary.totalIncome, 0);
  assert.deepEqual(admin.items, []);
  const customer = await costs.getAutomaticIncomeRecords('2', range);
  assert.equal(customer.summary.totalIncome, 95);
  assert.equal(customer.items.length, 2);
  const unassigned = await costs.getAutomaticIncomeRecords('unassigned', range);
  assert.equal(unassigned.summary.totalIncome, 7);
});
