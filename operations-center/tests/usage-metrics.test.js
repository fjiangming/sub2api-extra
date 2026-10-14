'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { SchemaInspector } = require('../src/schema-inspector');
const { MetricsService, addUtcDays, dateInTimezone } = require('../src/services/metrics-service');

let database;
let metrics;
const timezone = 'Asia/Shanghai';
const end = dateInTimezone(timezone);
const start = addUtcDays(end, -3);
const range = { start, end };

test.before(async () => {
  database = new PGlite();
  await database.exec(`
    CREATE TABLE usage_logs (
      user_id bigint, api_key_id bigint DEFAULT 1, account_id bigint DEFAULT 1, group_id bigint DEFAULT 1,
      model text DEFAULT 'model-main', requested_model text, billing_type smallint DEFAULT 0,
      input_tokens bigint DEFAULT 0, output_tokens bigint DEFAULT 0,
      cache_creation_tokens bigint DEFAULT 0, cache_read_tokens bigint DEFAULT 0,
      actual_cost numeric DEFAULT 0, total_cost numeric DEFAULT 0,
      account_stats_cost numeric, account_rate_multiplier numeric,
      image_count integer DEFAULT 0, video_count integer DEFAULT 0, duration_ms integer DEFAULT 100,
      created_at timestamptz NOT NULL
    );
    CREATE TABLE usage_dashboard_daily (
      bucket_date date PRIMARY KEY, total_requests bigint DEFAULT 0,
      input_tokens bigint DEFAULT 0, output_tokens bigint DEFAULT 0,
      cache_creation_tokens bigint DEFAULT 0, cache_read_tokens bigint DEFAULT 0,
      actual_cost numeric DEFAULT 0, total_cost numeric DEFAULT 0, account_cost numeric DEFAULT 0,
      total_duration_ms bigint DEFAULT 0, active_users bigint DEFAULT 0, computed_at timestamptz DEFAULT NOW()
    );
    CREATE TABLE usage_dashboard_daily_users (bucket_date date, user_id bigint);
  `);
  await database.query(`
    INSERT INTO usage_logs (user_id, input_tokens, output_tokens, cache_read_tokens, actual_cost, created_at) VALUES
      (2, 1, 1, 0, 10000, ($1::date::timestamp AT TIME ZONE $3) - INTERVAL '1 second'),
      (1, 200000000, 100000000, 10000000, 100, $1::date::timestamp AT TIME ZONE $3),
      (2, 700000000, 100000000, 20000000, 1.25, ($1::date::timestamp AT TIME ZONE $3) + INTERVAL '1 hour'),
      (99, 100000000, 0, 30000000, 2.5, ($1::date::timestamp AT TIME ZONE $3) + INTERVAL '23 hours 59 minutes 59 seconds'),
      (1, 12345, 456, 0, 50, ($1::date::timestamp AT TIME ZONE $3) + INTERVAL '1 day'),
      (2, 1, 1, 0, 10000, ($2::date::timestamp AT TIME ZONE $3) + INTERVAL '1 day');
  `, [start, end, timezone]);
  await database.exec(`
    UPDATE usage_logs SET requested_model = 'admin-only', api_key_id = 7, account_id = 7,
      group_id = 7, billing_type = 1, total_cost = 999, account_stats_cost = 999,
      duration_ms = 99999, cache_creation_tokens = 1000 WHERE user_id = 1;
    UPDATE usage_logs SET total_cost = 2, account_stats_cost = 1, account_rate_multiplier = 2,
      duration_ms = 200, cache_creation_tokens = 5, image_count = 2 WHERE actual_cost = 1.25;
    UPDATE usage_logs SET total_cost = 5, account_rate_multiplier = 3,
      duration_ms = 600, cache_creation_tokens = 7, video_count = 3 WHERE user_id = 99;
  `);
  await database.query(`
    INSERT INTO usage_dashboard_daily
      (bucket_date, total_requests, input_tokens, output_tokens, cache_read_tokens, actual_cost, total_duration_ms, active_users)
    SELECT (created_at AT TIME ZONE $3)::date, COUNT(*), SUM(input_tokens), SUM(output_tokens),
      SUM(cache_read_tokens), SUM(actual_cost), SUM(duration_ms), COUNT(DISTINCT user_id)
    FROM usage_logs
    WHERE created_at >= $1::date::timestamp AT TIME ZONE $3
      AND created_at < ($2::date + 1)::timestamp AT TIME ZONE $3
    GROUP BY 1;
  `, [start, end, timezone]);
  await database.query('INSERT INTO usage_dashboard_daily (bucket_date) VALUES ($1::date)', [end]);
  await database.query(`
    INSERT INTO usage_dashboard_daily_users
    SELECT DISTINCT (created_at AT TIME ZONE $3)::date, user_id FROM usage_logs
    WHERE created_at >= $1::date::timestamp AT TIME ZONE $3
      AND created_at < ($2::date + 1)::timestamp AT TIME ZONE $3;
  `, [start, end, timezone]);
  metrics = new MetricsService(database, new SchemaInspector(database), {
    cacheTtlSeconds: 0, sub2apiTimezone: timezone,
    retention: { usageDailyDays: 730, usageLogsDays: 30 }
  });
});

test.after(async () => { await database?.close(); });

test('usage excludes ID 1 from every metric across timezone boundaries', async () => {
  const report = await metrics.getUsage(range);
  assert.equal(report.summary.actual_cost, 3.75);
  assert.equal(report.summary.actual_cost_excluded_user_id, 1);
  assert.equal(report.summary.actual_cost_complete, false); // One source bucket is absent.
  assert.equal(report.summary.total_requests, 2);
  assert.equal(report.summary.active_users, 2);
  assert.equal(report.summary.total_tokens, 900000000);
  assert.equal(report.summary.cache_read_tokens, 50000000);
  assert.equal(report.summary.cache_creation_tokens, 12);
  assert.equal(report.summary.total_cost, 7);
  assert.equal(report.summary.account_cost, 17);
  assert.equal(report.summary.total_duration_ms, 800);
  assert.equal(report.summary.average_duration_ms, 400);
  assert.equal(report.summary.excluded_user_id, 1);
  assert.deepEqual(report.trend.map((row) => row.actual_cost), [3.75, 0, undefined, 0]);
  assert.equal(report.trend[0].total_tokens, 900000000);
  assert.equal(report.trend[0].metrics_complete, true);
  assert.equal(report.trend[1].total_requests, 0);
  assert.equal(report.trend[1].active_users, 0);
  assert.equal(report.trend[1].actual_cost_complete, true);
  assert.equal(report.trend[2].available, false);
  assert.equal(report.trend[3].actual_cost_complete, true);
});

test('all usage dimensions remove administrator rows and every associated metric', async () => {
  for (const dimension of ['model', 'user', 'apiKey', 'account', 'group', 'billing']) {
    const details = await metrics.getUsageDimensions({ ...range, dimension });
    assert.equal(details.rows.reduce((sum, row) => sum + row.actual_cost, 0), 3.75, dimension);
    assert.equal(details.rows.reduce((sum, row) => sum + row.total_tokens, 0), 900000000, dimension);
    assert.equal(details.rows.reduce((sum, row) => sum + row.requests, 0), 2, dimension);
    assert.equal(details.rows.reduce((sum, row) => sum + row.total_cost, 0), 7, dimension);
    assert.equal(details.rows.reduce((sum, row) => sum + row.cache_creation_tokens, 0), 12, dimension);
    assert.equal(details.rows.reduce((sum, row) => sum + row.image_count, 0), 2, dimension);
    assert.equal(details.rows.reduce((sum, row) => sum + row.video_count, 0), 3, dimension);
    const forbidden = { model: 'admin-only', user: '1', apiKey: '7', account: '7', group: '7', billing: '1' };
    assert.equal(details.rows.some((row) => row.label === forbidden[dimension]), false, dimension);
    if (dimension === 'user') {
      assert.equal(details.rows.find((row) => row.label === '99').actual_cost, 2.5);
    } else {
      assert.equal(details.rows[0].average_duration_ms, 400, dimension);
    }
  }
  const admin = await metrics.getUsageDimensions({ ...range, userId: 1 });
  assert.deepEqual(admin.rows, []);
});

test('empty retained days return zero spend and Token totals', async () => {
  const report = await metrics.getUsage({ start: end, end });
  assert.equal(report.summary.actual_cost, 0);
  assert.equal(report.summary.total_tokens, 0);
  assert.equal(report.summary.actual_cost_complete, true);
  assert.equal(report.summary.metrics_complete, true);
  assert.equal(report.summary.average_duration_ms, null);
});

test('missing daily details stay incomplete even when another day has extra requests', async () => {
  await database.query('DELETE FROM usage_logs WHERE user_id = 2 AND actual_cost = 1.25');
  await database.query(`
    INSERT INTO usage_logs (user_id, actual_cost, created_at)
    VALUES (1, 777, ($1::date::timestamp AT TIME ZONE $2) + INTERVAL '1 day 1 hour');
  `, [start, timezone]);
  const report = await metrics.getUsage(range);
  assert.equal(report.summary.actual_cost, 2.5);
  assert.equal(report.summary.actual_cost_complete, false);
  assert.equal(report.summary.metrics_complete, false);
  assert.equal(report.summary.total_requests, 1);
  assert.equal(report.summary.total_tokens, 100000000);
  assert.equal(report.summary.total_cost, 5);
  assert.equal(report.summary.account_cost, 15);
  assert.equal(report.summary.average_duration_ms, 600);
  assert.equal(report.trend[0].actual_cost, 2.5);
  assert.equal(report.trend[0].actual_cost_complete, false);
  assert.equal(report.trend[1].actual_cost, 0);
  assert.equal(report.trend[1].actual_cost_complete, true);
  assert.match(report.limitations.join(' '), /ID 1/);
  assert.match(report.limitations.join(' '), /明细不完整/);
  for (const field of ['total_requests', 'input_tokens', 'output_tokens', 'cache_creation_tokens',
    'cache_read_tokens', 'total_cost', 'actual_cost', 'account_cost', 'total_duration_ms']) {
    assert.equal(report.summary[field], report.trend.reduce((sum, row) => sum + (row[field] ?? 0), 0), field);
  }
});

test('expired details cannot fall back to unfiltered station amounts, but historical activity stays exact', async () => {
  const date = addUtcDays(start, -60);
  await database.query(`INSERT INTO usage_dashboard_daily
    (bucket_date, total_requests, input_tokens, actual_cost, total_cost, account_cost)
    VALUES ($1::date, 100, 900000, 500, 600, 700)`, [date]);
  await database.query('INSERT INTO usage_dashboard_daily_users VALUES ($1::date, 1), ($1::date, 2)', [date]);
  const report = await metrics.getUsage({ start: date, end: date });
  assert.equal(report.summary.active_users, 1);
  assert.equal(report.trend[0].active_users, 1);
  for (const field of ['total_requests', 'total_tokens', 'total_cost', 'actual_cost', 'account_cost']) {
    assert.equal(report.summary[field], 0, field);
    assert.equal(report.trend[0][field], 0, field);
  }
  assert.equal(report.summary.metrics_complete, false);
  assert.equal(report.trend[0].metrics_complete, false);
  assert.match(report.limitations.join(' '), /无法恢复/);
});
