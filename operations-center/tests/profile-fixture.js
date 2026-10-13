'use strict';

const { PGlite } = require('@electric-sql/pglite');
const { SchemaInspector } = require('../src/schema-inspector');
const { UserProfilesService } = require('../src/services/user-profiles-service');
const { addUtcDays, dateInTimezone } = require('../src/services/metrics-service');

async function profileFixture({ timezone = 'Asia/Shanghai', now = '2026-10-13T12:00:00Z' } = {}) {
  const engine = new PGlite();
  await engine.exec(`
    CREATE TABLE users (id bigint PRIMARY KEY, username text, email text, balance numeric(20,8),
      status text DEFAULT 'active', created_at timestamptz DEFAULT '2026-01-01Z', deleted_at timestamptz);
    CREATE TABLE groups (id bigint PRIMARY KEY, platform text);
    CREATE TABLE accounts (id bigint PRIMARY KEY, platform text);
    CREATE TABLE usage_logs (id bigserial PRIMARY KEY, user_id bigint NOT NULL, group_id bigint, account_id bigint,
      model text DEFAULT 'routed-model', requested_model text, billing_type smallint DEFAULT 0,
      actual_cost numeric(20,10) DEFAULT 0, input_tokens integer DEFAULT 0, output_tokens integer DEFAULT 0,
      cache_read_tokens integer DEFAULT 0, cache_creation_tokens integer DEFAULT 0, created_at timestamptz NOT NULL);
    CREATE INDEX ON usage_logs (user_id, created_at DESC);
    CREATE INDEX ON usage_logs (created_at);
    CREATE TABLE usage_dashboard_daily (bucket_date date PRIMARY KEY, total_requests bigint);
    CREATE TABLE usage_dashboard_aggregation_watermark (id integer PRIMARY KEY, last_aggregated_at timestamptz);
    INSERT INTO users (id, username, email, balance, deleted_at) VALUES
      (1, '管理员', 'admin@example.test', 500, NULL),
      (2, '林知夏', 'lin@example.test', 4, NULL),
      (3, '已删除用户', 'deleted@example.test', 2, '2026-10-12Z'),
      (4, '=HYPERLINK("invalid")', 'csv@example.test', 100, NULL),
      (6, '零消费用户', 'free@example.test', 0, NULL),
      (7, '100% 用户', 'literal@example.test', 100, NULL);
    INSERT INTO groups VALUES (1, 'anthropic'), (2, 'openai'), (3, 'composite'), (4, ''), (5, 'future-platform');
    INSERT INTO accounts VALUES (1, 'openai'), (2, 'anthropic'), (3, 'gemini'), (4, 'grok');
  `);
  let queue = Promise.resolve();
  const database = {
    engine,
    async connect() {
      const previous = queue;
      let release;
      queue = new Promise((resolve) => { release = resolve; });
      await previous;
      return { query: (sql, values) => engine.query(sql, values), release };
    },
    async query(sql, values) {
      const client = await this.connect();
      try { return await client.query(sql, values); } finally { client.release(); }
    },
    close: () => engine.close()
  };
  const config = { sub2apiTimezone: timezone, cacheTtlSeconds: 0,
    retention: { usageLogsDays: 30, usageDailyDays: 730 } };
  const inspector = new SchemaInspector(database);
  const profiles = new UserProfilesService(database, inspector, config, { now: () => new Date(now) });
  async function insert(logs) {
    await engine.query(`INSERT INTO usage_logs
      (user_id, group_id, account_id, model, requested_model, billing_type, actual_cost,
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, created_at)
      SELECT user_id, group_id, account_id, COALESCE(model, 'routed-model'), requested_model,
        COALESCE(billing_type, 0), COALESCE(actual_cost, 0), COALESCE(input_tokens, 0), COALESCE(output_tokens, 0),
        COALESCE(cache_read_tokens, 0), COALESCE(cache_creation_tokens, 0), created_at
      FROM jsonb_to_recordset($1::jsonb) AS l(user_id bigint, group_id bigint, account_id bigint, model text,
        requested_model text, billing_type smallint, actual_cost numeric, input_tokens integer,
        output_tokens integer, cache_read_tokens integer, cache_creation_tokens integer, created_at timestamptz)`, [JSON.stringify(logs)]);
  }
  async function aggregate() {
    await engine.query(`TRUNCATE usage_dashboard_daily, usage_dashboard_aggregation_watermark`);
    await engine.query(`INSERT INTO usage_dashboard_daily
      SELECT date, COUNT(l.id) FROM generate_series($3::date, $4::date, INTERVAL '1 day') d(date)
      LEFT JOIN usage_logs l ON (l.created_at AT TIME ZONE $1)::date = d.date::date AND l.created_at <= $2::timestamptz
      GROUP BY date`, [timezone, now, addUtcDays(dateInTimezone(timezone, new Date(now)), -29), dateInTimezone(timezone, new Date(now))]);
    await engine.query('INSERT INTO usage_dashboard_aggregation_watermark VALUES (1, $1::timestamptz)', [now]);
  }
  await insert([
    ...Array.from({ length: 100 }, () => ({ user_id: 2, group_id: 1, account_id: 1,
      requested_model: 'claude-sonnet-4', actual_cost: 0.1, input_tokens: 10, created_at: '2026-10-03T04:00:00Z' })),
    ...Array.from({ length: 10 }, () => ({ user_id: 2, group_id: 2, account_id: 2,
      requested_model: 'gpt-5', actual_cost: 0.7, input_tokens: 100, output_tokens: 10, cache_read_tokens: 20,
      cache_creation_tokens: 5, created_at: '2026-10-10T04:00:00Z' })),
    { user_id: 2, group_id: 3, account_id: 3, requested_model: 'gemini-2.5-pro', billing_type: 1,
      actual_cost: 70, input_tokens: 500, created_at: '2026-10-11T04:00:00Z' },
    { user_id: 2, group_id: 1, account_id: 1, requested_model: 'claude-sonnet-4', actual_cost: 7,
      input_tokens: 700, created_at: '2026-10-12T16:00:00Z' },
    { user_id: 3, group_id: 4, account_id: 4, actual_cost: 20, created_at: '2026-10-11T04:00:00Z' },
    { user_id: 4, group_id: 5, actual_cost: 1, created_at: '2026-10-11T04:00:00Z' },
    { user_id: 5, actual_cost: 5, created_at: '2026-10-11T04:00:00Z' },
    { user_id: 6, group_id: 2, requested_model: 'free-model', actual_cost: 0, created_at: '2026-10-11T04:00:00Z' },
    { user_id: 7, group_id: 2, actual_cost: 3, created_at: '2026-10-11T04:00:00Z' },
    { user_id: 1, group_id: 1, actual_cost: 1000, created_at: '2026-10-11T04:00:00Z' }
  ]);
  await aggregate();
  return { database, config, inspector, profiles, insert, aggregate };
}

module.exports = { profileFixture };
