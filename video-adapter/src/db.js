'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { ensure } = require('./errors');

async function createDatabase(config) {
  const pool = new Pool({ connectionString: config.databaseUrl,
    ssl: config.databaseSsl === 'verify-full' ? { rejectUnauthorized: true } : false,
    max: 12, connectionTimeoutMillis: 10000, statement_timeout: 15000,
    application_name: 'sub2api-video-adapter' });
  pool.on('error', () => console.error(JSON.stringify({ event: 'database_connection_error' })));
  const database = {
    query: (...args) => pool.query(...args),
    async tx(action) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await action(client);
        await client.query('COMMIT');
        return result;
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
    },
    close: () => pool.end()
  };
  try { await verifyCoreSchema(database); await migrate(database); }
  catch (error) { await pool.end(); throw error; }
  return database;
}

const requiredColumns = {
  users: ['id', 'balance', 'frozen_balance', 'status', 'deleted_at', 'updated_at', 'restrict_public_groups', 'concurrency', 'rpm_limit'],
  api_keys: ['id', 'key', 'user_id', 'group_id', 'status', 'quota', 'quota_used', 'expires_at', 'deleted_at', 'updated_at', 'last_used_at', 'ip_whitelist', 'ip_blacklist', 'usage_5h', 'usage_1d', 'usage_7d', 'rate_limit_5h', 'rate_limit_1d', 'rate_limit_7d', 'window_5h_start', 'window_1d_start', 'window_7d_start'],
  groups: ['id', 'platform', 'rate_multiplier', 'video_rate_independent', 'video_rate_multiplier', 'video_model_prices', 'model_pricing', 'video_price_480p', 'video_price_720p', 'video_price_1080p', 'peak_rate_enabled', 'peak_start', 'peak_end', 'peak_rate_multiplier', 'model_allowlist', 'subscription_type', 'allow_image_generation', 'status', 'deleted_at', 'is_exclusive', 'profit_control_enabled', 'profit_min_margin', 'profit_safety_buffer', 'rpm_limit'],
  accounts: ['id', 'deleted_at'],
  user_group_rate_multipliers: ['user_id', 'group_id', 'rate_multiplier', 'rpm_override'],
  user_platform_quotas: ['user_id', 'platform', 'deleted_at', 'daily_limit_usd', 'weekly_limit_usd', 'monthly_limit_usd'],
  user_allowed_groups: ['user_id', 'group_id'],
  channel_groups: ['channel_id', 'group_id'], channels: ['id', 'status', 'model_mapping', 'billing_model_source'],
  channel_model_pricing: ['id', 'channel_id', 'platform', 'models', 'billing_mode', 'per_request_price', 'time_pricing'],
  channel_pricing_intervals: ['id', 'pricing_id', 'tier_label', 'min_tokens', 'max_tokens', 'per_request_price', 'sort_order'],
  usage_logs: ['user_id', 'api_key_id', 'account_id', 'group_id', 'request_id', 'model', 'requested_model', 'upstream_model', 'total_cost', 'actual_cost', 'account_stats_cost', 'rate_multiplier', 'account_rate_multiplier', 'billing_mode', 'billing_type', 'stream', 'video_count', 'video_resolution', 'video_duration_seconds', 'created_at'],
  auth_cache_invalidation_outbox: ['cache_key']
};

async function verifyCoreSchema(db) {
  const { rows } = await db.query("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY($1::text[])", [Object.keys(requiredColumns)]);
  const actual = new Set(rows.map(row => `${row.table_name}.${row.column_name}`));
  const missing = Object.entries(requiredColumns).flatMap(([table, columns]) => columns.filter(column => !actual.has(`${table}.${column}`)).map(column => `${table}.${column}`));
  ensure(!missing.length, 'SUB2API_SCHEMA_UNSUPPORTED', `Required Sub2API columns are missing: ${missing.join(', ')}`, 503);
}

async function migrate(db) {
  await db.tx(async tx => {
    await tx.query('SELECT pg_advisory_xact_lock(198751)');
    await tx.query(fs.readFileSync(path.join(__dirname, '../sql/001_adapter.sql'), 'utf8'));
    const { rows } = await tx.query('SELECT version FROM video_adapter.schema_version');
    ensure(rows.length === 1 && rows[0].version === 1, 'ADAPTER_SCHEMA_UNSUPPORTED', 'Unsupported adapter schema version', 503);
  });
}

module.exports = { createDatabase, verifyCoreSchema, migrate };
