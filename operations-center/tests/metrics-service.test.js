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

test('overview shares the excluded usage totals and completeness with the usage report', async () => {
  const queries = [];
  const service = serviceWithRows(queries);
  service.getUsage = async ({ start, end }) => {
    assert.equal(start, `${end.slice(0, 7)}-01`);
    return {
      summary: { total_requests: 10, actual_cost: 12.5, metrics_complete: true, actual_cost_complete: true },
      trend: [{ date: end, total_requests: 2, actual_cost: 3, metrics_complete: true }], coverage: {}
    };
  };
  const overview = await service.getOverview();
  assert.equal(overview.usage.requests_month, 10);
  assert.equal(overview.usage.spend_month, 12.5);
  assert.equal(overview.usage.requests_today, 2);
  assert.equal(overview.usage.spend_today, 3);
  assert.equal(overview.usage.spend_month_excluded_user_id, 1);
  assert.equal(overview.usage.excluded_user_id, 1);
  assert.equal(overview.usage.spend_month_complete, true);
});

test('overview marks monthly spend incomplete when retained details trail the daily aggregate', async () => {
  const service = serviceWithRows([]);
  service.getUsage = async () => ({
    summary: { total_requests: 9, actual_cost: 12.5, metrics_complete: false, actual_cost_complete: false },
    trend: [], coverage: {}
  });
  const overview = await service.getOverview();

  assert.equal(overview.usage.spend_month, 12.5);
  assert.equal(overview.usage.spend_month_complete, false);
  assert.equal(overview.usage.metrics_month_complete, false);
  assert.equal(overview.usage.metrics_today_complete, false);
});

test('arbitrary-range usage summary counts distinct active users', async () => {
  const queries = [];
  const result = await serviceWithRows(queries).getUsage({ start: '2026-09-01', end: '2026-09-20' });
  const summary = queries.find((sql) => /SELECT COUNT\(DISTINCT user_id\) AS active_users/.test(sql));
  assert.match(summary, /COUNT\(DISTINCT user_id\)/);
  assert.match(summary, /usage_dashboard_daily_users/);
  assert.equal(result.detailRetentionDays, 30);
});
