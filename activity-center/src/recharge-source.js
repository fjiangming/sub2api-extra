'use strict';

const { Pool } = require('pg');
const { AppError } = require('./errors');

// Match operations-center's balance-credit basis, without counting activity gifts.
const REDEMPTION_SQL = `SELECT
  FLOOR(GREATEST(COALESCE(SUM(r.value::numeric), 0), 0) * 100)::text AS total_minor
FROM redeem_codes r
WHERE r.used_by = $1::bigint AND r.used_by IS DISTINCT FROM 1
  AND r.status = 'used' AND r.type IN ('balance', 'admin_balance')
  AND r.used_at >= $2::timestamptz AND r.used_at <= CURRENT_TIMESTAMP
  AND COALESCE(r.notes, '') NOT LIKE '%补贴%'
  AND NOT (r.type = 'balance' AND COALESCE(r.code, '') ~ '^AC-[a-f0-9]{48}$'
    AND COALESCE(r.notes, '') ~ '^活动奖励; activity=recharge-lottery; reward=[a-f0-9-]{36}; batch=[a-f0-9-]{36}$')`;

function minor(value) {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new AppError('RECHARGE_UNVERIFIED', '充值数据暂时无法核验', 503);
  return Number(value);
}

class RechargeSource {
  constructor(config, { pool } = {}) {
    this.config = config;
    this.pool = pool || new Pool({
      connectionString: config.databaseUrl,
      ssl: config.databaseSsl === 'disable' ? false : { rejectUnauthorized: config.databaseSsl === 'verify-full' },
      max: 3, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, statement_timeout: 10000,
      options: '-c default_transaction_read_only=on -c timezone=UTC', application_name: 'sub2api-activity-center'
    });
    this.pool?.on?.('error', () => console.error('[activity-center] RECHARGE_DATABASE_ERROR'));
    this.active = 0;
  }
  async total(userId, since) {
    if (this.active >= 8) throw new AppError('SERVICE_BUSY', '当前访问人数较多，请稍后重试', 503);
    this.active++;
    try {
      const { rows } = await this.pool.query(REDEMPTION_SQL, [userId, since]);
      return minor(rows[0]?.total_minor);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('RECHARGE_UNAVAILABLE', '暂时无法读取充值记录，请稍后重试', 503);
    } finally { this.active--; }
  }
  async close() { await this.pool?.end?.(); }
}

module.exports = { RechargeSource, REDEMPTION_SQL, minor };
