'use strict';

const { PGlite } = require('@electric-sql/pglite');
const { loadConfig } = require('../src/config');
const { SchemaInspector } = require('../src/db');
const { UsageRepository } = require('../src/repository');
const { LeaderboardService } = require('../src/leaderboard');

async function memoryDatabase({ requestedModel = true } = {}) {
  const engine = new PGlite();
  await engine.exec(`
    CREATE TABLE public.users (id bigint PRIMARY KEY, username text NOT NULL DEFAULT '', email text NOT NULL DEFAULT '',
      role text NOT NULL DEFAULT 'user', status text NOT NULL DEFAULT 'active', deleted_at timestamptz);
    CREATE TABLE public.usage_logs (id bigserial PRIMARY KEY, user_id bigint NOT NULL, created_at timestamptz NOT NULL,
      model text NOT NULL DEFAULT 'claude-test', ${requestedModel ? 'requested_model text,' : ''}
      input_tokens integer NOT NULL DEFAULT 0, output_tokens integer NOT NULL DEFAULT 0,
      cache_creation_tokens integer NOT NULL DEFAULT 0, cache_read_tokens integer NOT NULL DEFAULT 0,
      actual_cost numeric(20,10) NOT NULL DEFAULT 0);
    CREATE INDEX ON public.usage_logs (user_id, created_at);
    CREATE INDEX ON public.usage_logs (created_at);
  `);
  let queries = 0;
  const database = {
    engine,
    get queryCount() { return queries; },
    async query(sql, params) {
      queries++;
      return engine.transaction(async (transaction) => {
        await transaction.exec('SET TRANSACTION READ ONLY');
        return transaction.query(sql, params);
      });
    },
    async close() { await engine.close(); }
  };
  return database;
}

async function insertUsers(database, users) {
  const records = users.map((user) => ({ email: `user${user.id}@example.com`, ...user }));
  await database.engine.query(`INSERT INTO public.users (id, username, email, role, status, deleted_at)
    SELECT id, COALESCE(username, ''), email, COALESCE(role, 'user'), COALESCE(status, 'active'), deleted_at
    FROM jsonb_to_recordset($1::jsonb) AS u(id bigint, username text, email text, role text, status text, deleted_at timestamptz)`, [JSON.stringify(records)]);
}

async function insertLogs(database, logs) {
  await database.engine.query(`INSERT INTO public.usage_logs
    (user_id, created_at, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, actual_cost)
    SELECT user_id, created_at, COALESCE(model, 'claude-test'), COALESCE(input_tokens, 0), COALESCE(output_tokens, 0),
      COALESCE(cache_creation_tokens, 0), COALESCE(cache_read_tokens, 0), COALESCE(actual_cost, 0)
    FROM jsonb_to_recordset($1::jsonb) AS l(user_id bigint, created_at timestamptz, model text, input_tokens integer,
      output_tokens integer, cache_creation_tokens integer, cache_read_tokens integer, actual_cost numeric)`, [JSON.stringify(logs)]);
}

function service(database, { anchor = '2026-10-13T03:30:00.000Z', ...overrides } = {}) {
  const config = { ...loadConfig({ NODE_ENV: 'test' }), ...overrides };
  const inspector = new SchemaInspector(database);
  const repository = new UsageRepository(database, config);
  return { config, inspector, repository, leaderboard: new LeaderboardService(repository, inspector, config, { now: () => new Date(anchor) }) };
}

module.exports = { memoryDatabase, insertUsers, insertLogs, service };
