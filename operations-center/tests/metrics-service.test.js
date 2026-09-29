'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MetricsService } = require('../src/services/metrics-service');

function serviceWithRows(queries, resolveRows = null) {
  const pool = {
    async query(sql) {
      queries.push(sql);
      const resolved = resolveRows?.(sql);
      if (resolved !== undefined) return { rows: resolved };
      if (/GROUP BY 1\s+ORDER BY 1/.test(sql)) return { rows: [] };
      return { rows: [{}] };
    }
  };
  const inspector = { requireTables: async () => [] };
  return new MetricsService(pool, inspector, {
    cacheTtlSeconds: 0,
    sub2apiTimezone: 'Asia/Shanghai',
    financeTimezone: 'Asia/Shanghai',
    retention: { usageDailyDays: 730, usageLogsDays: 30 }
  });
}

test('overview MAU query includes the first day of a 31-day month', async () => {
  const queries = [];
  await serviceWithRows(queries).getOverview();
  const activity = queries.find((sql) => /AS dau/.test(sql));
  assert.match(activity, /WHERE bucket_date >= LEAST/);
  assert.match(activity, /date_trunc\('month'/);
});

test('overview monthly user spend excludes administrator usage and reports detail coverage', async () => {
  const queries = [];
  const overview = await serviceWithRows(queries).getOverview();
  const usage = queries.find((sql) => /AS detail_requests_month/.test(sql));

  assert.match(usage, /FROM usage_logs/);
  assert.match(usage, /SUM\(actual_cost\) FILTER \(WHERE user_id <> 1\)/);
  assert.match(usage, /created_at >= date_trunc\('month'/);
  assert.match(usage, /INTERVAL '1 month'/);
  assert.equal(overview.usage.spend_month_excluded_user_id, 1);
  assert.equal(overview.usage.spend_month_complete, true);
  assert.equal('detail_requests_month' in overview.usage, false);
});

test('overview marks monthly spend incomplete when retained details trail the daily aggregate', async () => {
  const overview = await serviceWithRows([], (sql) => {
    if (!/AS detail_requests_month/.test(sql)) return undefined;
    return [{ requests_month: '10', detail_requests_month: '9', spend_month: '12.5' }];
  }).getOverview();

  assert.equal(overview.usage.spend_month, 12.5);
  assert.equal(overview.usage.spend_month_complete, false);
});

test('arbitrary-range usage summary counts distinct active users', async () => {
  const queries = [];
  const result = await serviceWithRows(queries).getUsage({ start: '2026-09-01', end: '2026-09-20' });
  const summary = queries.find((sql) => /average_duration_ms/.test(sql));
  assert.match(summary, /COUNT\(DISTINCT user_id\)/);
  assert.match(summary, /usage_dashboard_daily_users/);
  assert.equal(result.detailRetentionDays, 30);
});
