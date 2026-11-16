'use strict';

const { Pool } = require('pg');
const { requestJson } = require('./upstream');
const { AppError } = require('./errors');

// Cash paid in CNY, rather than the face value of a balance redemption.
const OFFICIAL_SQL = `SELECT
  COALESCE(SUM(CASE WHEN currency = 'CNY' THEN
    CASE WHEN status = 'PARTIALLY_REFUNDED' AND amount > 0
      THEN ROUND(pay_amount * GREATEST(0, 1 - refund_amount / amount) * 100)
      WHEN status IN ('COMPLETED','REFUND_FAILED') THEN ROUND(pay_amount * 100)
      ELSE 0 END ELSE 0 END), 0)::text AS total_minor,
  COUNT(*) FILTER (WHERE currency <> 'CNY')::text AS foreign_count
FROM (SELECT *, COALESCE(NULLIF(UPPER(provider_snapshot->>'currency'), ''), 'CNY') AS currency
  FROM payment_orders WHERE user_id = $1 AND order_type = 'balance'
  AND paid_at >= $2::timestamptz AND paid_at <= CURRENT_TIMESTAMP
  AND completed_at IS NOT NULL AND pay_amount > 0
  AND status IN ('COMPLETED','REFUND_FAILED','PARTIALLY_REFUNDED')) payments`;

function minor(value) {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new AppError('RECHARGE_UNVERIFIED', '充值数据暂时无法核验', 503);
  return Number(value);
}

class RechargeSource {
  constructor(config, { pool, fetchImpl = fetch } = {}) {
    this.config = config;
    this.fetch = fetchImpl;
    this.pool = pool || (config.sources.includes('official') ? new Pool({
      connectionString: config.databaseUrl,
      ssl: config.databaseSsl === 'disable' ? false : { rejectUnauthorized: config.databaseSsl === 'verify-full' },
      max: 3, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, statement_timeout: 10000,
      options: '-c default_transaction_read_only=on -c timezone=UTC', application_name: 'sub2api-activity-center'
    }) : null);
    this.pool?.on?.('error', () => console.error('[activity-center] RECHARGE_DATABASE_ERROR'));
    this.active = 0;
  }
  async total(userId, since) {
    if (this.active >= 8) throw new AppError('SERVICE_BUSY', '当前访问人数较多，请稍后重试', 503);
    this.active++;
    let total = 0;
    try {
      if (this.config.sources.includes('official')) {
        const { rows } = await this.pool.query(OFFICIAL_SQL, [userId, since]);
        // Foreign-currency orders cannot silently become CNY chances.
        if (minor(rows[0].foreign_count) > 0) throw new AppError('RECHARGE_CURRENCY_UNSUPPORTED', '部分充值尚待核验，请联系管理员', 503);
        total += minor(rows[0].total_minor);
      }
      if (this.config.sources.includes('recharge_center')) {
        const query = new URLSearchParams({ user_id: userId, since });
        const data = await requestJson(`${this.config.rechargeUrl}/api/integrations/activity-center/recharges?${query}`, {
          headers: { authorization: `Bearer ${this.config.rechargeToken}`, accept: 'application/json' }
        }, this.config.timeoutMs, this.fetch);
        if (data?.version !== 1 || data.userId !== userId || data.since !== since || data.currency !== 'CNY') throw new AppError('RECHARGE_UNVERIFIED', '充值数据暂时无法核验', 503);
        total += minor(data.totalMinor);
      }
      return minor(total);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('RECHARGE_UNAVAILABLE', '暂时无法读取充值记录，请稍后重试', 503);
    } finally { this.active--; }
  }
  async close() { await this.pool?.end?.(); }
}

module.exports = { RechargeSource, OFFICIAL_SQL, minor };
