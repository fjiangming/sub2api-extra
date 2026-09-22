'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MetricsService } = require('../src/services/metrics-service');

function serviceWithRows(queries) {
  const pool = {
    async query(sql) {
      queries.push(sql);
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

test('arbitrary-range usage summary counts distinct active users', async () => {
  const queries = [];
  const result = await serviceWithRows(queries).getUsage({ start: '2026-09-01', end: '2026-09-20' });
  const summary = queries.find((sql) => /average_duration_ms/.test(sql));
  assert.match(summary, /COUNT\(DISTINCT user_id\)/);
  assert.match(summary, /usage_dashboard_daily_users/);
  assert.equal(result.detailRetentionDays, 30);
});
