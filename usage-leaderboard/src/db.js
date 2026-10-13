'use strict';

const { Pool } = require('pg');
const { AppError } = require('./errors');

function createDatabase(config) {
  const pool = config.databaseUrl ? new Pool({
    connectionString: config.databaseUrl,
    ssl: config.databaseSsl === 'disable' ? false : { rejectUnauthorized: config.databaseSsl === 'verify-full' },
    max: config.databaseConnections,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: config.queryTimeoutMs,
    options: '-c default_transaction_read_only=on -c timezone=UTC',
    application_name: 'sub2api-usage-leaderboard'
  }) : null;
  pool?.on('error', () => console.error('[usage-leaderboard] DATABASE_CONNECTION_ERROR'));
  let active = 0;
  return {
    async query(sql, values) {
      if (!pool) throw new AppError('DATABASE_NOT_CONFIGURED', '用量服务尚未配置数据连接', 503);
      if (active >= config.databaseConnections) throw new AppError('SERVICE_BUSY', '访问人数较多，请稍后重试', 503);
      active++;
      try { return await pool.query(sql, values); }
      catch (error) {
        if (error?.code === '57014') throw new AppError('QUERY_TIMEOUT', '统计暂时超时，请稍后重试', 503);
        throw new AppError('DATABASE_UNAVAILABLE', '暂时无法读取用量数据，请稍后重试', 503);
      } finally { active--; }
    },
    async close() { await pool?.end(); }
  };
}

const REQUIRED_COLUMNS = {
  users: ['id', 'email', 'role', 'status', 'deleted_at'],
  usage_logs: ['user_id', 'created_at', 'model', 'input_tokens', 'output_tokens', 'cache_creation_tokens', 'cache_read_tokens']
};

class SchemaInspector {
  constructor(database) { this.database = database; this.pending = null; this.checked = null; }

  async inspect() {
    if (this.checked?.expiresAt > Date.now()) return this.checked.value;
    if (this.pending) return this.pending;
    this.pending = this.database.query(`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name IN ('users', 'usage_logs')
    `).then(({ rows }) => {
      for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
        if (columns.some((column) => !rows.some((row) => row.table_name === table && row.column_name === column))) {
          throw new AppError('SCHEMA_INCOMPATIBLE', '当前 Sub2API 版本暂不支持用量排行，请联系管理员', 503);
        }
      }
      if (!rows.some((row) => row.table_name === 'usage_logs' && row.column_name === 'created_at' && row.data_type === 'timestamp with time zone')) {
        throw new AppError('SCHEMA_INCOMPATIBLE', '当前用量数据的时间字段不兼容', 503);
      }
      const value = { requestedModel: rows.some((row) => row.table_name === 'usage_logs' && row.column_name === 'requested_model') };
      this.checked = { value, expiresAt: Date.now() + 300000 };
      return value;
    }).finally(() => { this.pending = null; });
    return this.pending;
  }
}

module.exports = { createDatabase, SchemaInspector, REQUIRED_COLUMNS };
