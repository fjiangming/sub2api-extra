'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { PGlite } = require('@electric-sql/pglite');
const { Client } = require('pg');
const { CACHE_TTL_MS, GroupMetrics, createMetricsPool, publicGroupCacheStats } = require('../src/group-metrics');

test('group cache statistics use an exact five-hour window and token-weighted totals across users', async (t) => {
  const database = new PGlite();
  t.after(() => database.close());
  await database.exec(`
    CREATE TABLE usage_logs (
      user_id bigint, group_id bigint, created_at timestamptz,
      input_tokens bigint, cache_creation_tokens bigint, cache_read_tokens bigint, output_tokens bigint
    );
    INSERT INTO usage_logs VALUES
      (1, 1, '2026-10-13T21:17:00Z', 100, 20, 80, 10000),
      (2, 1, '2026-10-14T02:16:59.999Z', 10, 0, 90, 20000),
      (3, 1, '2026-10-13T21:16:59.999Z', 0, 0, 1000000, 0),
      (3, 1, '2026-10-14T02:17:00Z', 0, 0, 1000000, 0),
      (3, 1, '2026-10-14T02:18:00Z', 0, 0, 1000000, 0),
      (1, 2, '2026-10-14T01:00:00Z', 50, 50, 0, 20000),
      (1, 3, '2026-10-14T01:00:00Z', 0, NULL, 0, 100),
      (1, 4, '2026-10-14T01:00:00Z', 0, 0, 100, 0),
      (1, 5, '2026-10-14T01:00:00Z', 0, 0, 100, 0),
      (1, 6, '2026-10-14T01:00:00Z', 2000000000, 2000000000, 2000000000, 0),
      (2, 6, '2026-10-14T01:00:00Z', 2000000000, 2000000000, 2000000000, 0),
      (1, 9223372036854775807, '2026-10-14T01:00:00Z', 100, 0, 100, 0);
  `);
  const now = Date.parse('2026-10-14T02:17:00Z');
  const metrics = new GroupMetrics({}, { pool: database, now: () => now });
  const snapshot = await metrics.getRates(['1', '2', '3', '4', '6', '7', '9223372036854775807',
    '1); DROP TABLE usage_logs; --', '9223372036854775808', '-1', '0']);
  assert.equal(snapshot.status, 'ok');
  assert.equal(snapshot.window_end - snapshot.window_start, 5 * 3600);
  assert.equal(snapshot.window_start, Date.parse('2026-10-13T21:17:00Z') / 1000);
  assert.ok(Math.abs(publicGroupCacheStats(snapshot, '1').rate - 170 / 300) < 1e-12);
  assert.equal(publicGroupCacheStats(snapshot, '2').rate, 0);
  assert.equal(publicGroupCacheStats(snapshot, '3').status, 'no_data');
  assert.equal(publicGroupCacheStats(snapshot, '3').rate, null);
  assert.equal(publicGroupCacheStats(snapshot, '4').rate, 1);
  assert.equal(snapshot.rates.has('5'), false);
  assert.ok(Math.abs(publicGroupCacheStats(snapshot, '6').rate - 1 / 3) < 1e-12);
  assert.equal(publicGroupCacheStats(snapshot, '7').status, 'no_data');
  assert.equal(publicGroupCacheStats(snapshot, '9223372036854775807').rate, 0.5);
  assert.equal((await database.query('SELECT COUNT(*) AS count FROM usage_logs')).rows[0].count, 12);
  assert.deepEqual(Object.keys(publicGroupCacheStats(snapshot, '1')).sort(),
    ['rate', 'status', 'updated_at', 'window_end', 'window_hours', 'window_start']);
});

test('statistics share one cached query and concurrent requests, and invalidate on scope changes', async () => {
  let now = 100000000;
  let release;
  const calls = [];
  let closed = false;
  const metrics = new GroupMetrics({}, {
    now: () => now,
    pool: {
      async query(_sql, values) {
        calls.push(values);
        if (calls.length === 1) await new Promise((resolve) => { release = resolve; });
        return { rows: values[0].map((id) => ({ group_id: id, cache_rate: '0.75' })) };
      },
      async end() { closed = true; }
    }
  });
  const first = metrics.getRates(['1', '2']);
  const second = metrics.getRates(['2', '1', '1']);
  release();
  assert.equal(await first, await second);
  assert.equal(calls.length, 1);
  now += CACHE_TTL_MS - 1;
  await metrics.getRates(['1', '2']);
  assert.equal(calls.length, 1);
  now += 1;
  await metrics.getRates(['1', '2']);
  assert.equal(calls.length, 2);
  assert.equal(calls[1][2].getTime(), now);
  await metrics.getRates(['2']);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2][0], ['2']);
  await metrics.getRates([]);
  assert.equal(calls.length, 3);
  await metrics.close();
  assert.equal(closed, true);
  assert.equal((await metrics.getRates(['1'])).status, 'unavailable');
});

test('statistics failures expire, hide diagnostics and never reuse a stale percentage', async (t) => {
  const logs = [];
  const originalError = console.error;
  console.error = (message) => logs.push(message);
  t.after(() => { console.error = originalError; });
  let now = 100000000;
  let attempts = 0;
  const metrics = new GroupMetrics({}, {
    now: () => now,
    pool: {
      async query() {
        attempts += 1;
        if (attempts === 1 || attempts === 3) return { rows: [{ group_id: '1', cache_rate: '0.9' }] };
        const error = new Error('password=secret private-host stats-reader');
        error.code = '28P01';
        throw error;
      },
      async end() {}
    }
  });
  assert.equal(publicGroupCacheStats(await metrics.getRates(['1']), '1').rate, 0.9);
  now += CACHE_TTL_MS;
  const failed = publicGroupCacheStats(await metrics.getRates(['1']), '1');
  assert.equal(failed.status, 'unavailable');
  assert.equal(failed.rate, null);
  await metrics.getRates(['1']);
  assert.equal(attempts, 2);
  assert.deepEqual(logs.map(JSON.parse), [{ event: 'group_cache_stats_failed', code: '28P01' }]);
  assert.doesNotMatch(JSON.stringify(failed) + logs.join(''), /secret|private-host|stats-reader/);
  now += CACHE_TTL_MS;
  assert.equal(publicGroupCacheStats(await metrics.getRates(['1']), '1').status, 'ok');
  await metrics.close();
});

test('an optional read-only connection is bounded and demos never use the real database', async (t) => {
  const pool = createMetricsPool('postgresql://reader:password@example.test/sub2api?options=-c%20default_transaction_read_only%3Doff&statement_timeout=0&query_timeout=0');
  t.after(() => pool.end());
  assert.equal(pool.options.max, 1);
  assert.equal(pool.options.statement_timeout, 5000);
  assert.equal(pool.options.connectionTimeoutMillis, 5000);
  assert.equal(pool.options.options, '-c default_transaction_read_only=on');
  const parameters = new Client(pool.options).connectionParameters;
  assert.equal(parameters.options, '-c default_transaction_read_only=on');
  assert.equal(parameters.statement_timeout, 5000);
  assert.equal(parameters.query_timeout, 6000);
  const missing = new GroupMetrics({});
  assert.equal(publicGroupCacheStats(await missing.getRates(['1']), '1').status, 'not_configured');
  await missing.close();
  const demo = new GroupMetrics({ demoMode: true, sub2apiDatabaseUrl: 'postgresql://reader:password@example.test/sub2api' });
  assert.equal(demo.pool, null);
  assert.equal(publicGroupCacheStats(await demo.getRates(['8']), '8').rate, 0.934);
  await demo.close();
});
