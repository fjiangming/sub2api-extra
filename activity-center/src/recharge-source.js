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
  async inspectLegacyCredit(code) {
    if (!/^AC-[a-f0-9]{48}$/.test(code)) throw new AppError('CREDIT_LEGACY_REVIEW_REQUIRED', '原奖励入账信息需要核查', 409);
    if (this.active >= 8) throw new AppError('SERVICE_BUSY', '当前访问人数较多，请稍后重试', 503);
    this.active++;
    try {
      const { rows } = await this.pool.query(`SELECT id::text,code,type,status,value::text,used_by::text,used_at,notes
        FROM redeem_codes WHERE code=$1 LIMIT 2`,[code]);
      if (rows.length > 1) throw new AppError('CREDIT_LEGACY_REVIEW_REQUIRED', '原奖励入账信息需要核查', 409);
      if (rows.length) return { receipt: rows[0] };
      const metadata = await this.pool.query(`SELECT character_maximum_length AS maximum FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name='redeem_codes' AND column_name='code' AND data_type='character varying'`);
      // A missing receipt alone cannot justify replacing an idempotency code.
      if (metadata.rows.length !== 1 || metadata.rows[0].maximum !== 32) {
        throw new AppError('CREDIT_LEGACY_REVIEW_REQUIRED', '原奖励入账信息需要核查', 409);
      }
      return { receipt: null,codeLimit: 32 };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('CREDIT_LEGACY_UNAVAILABLE', '暂时无法核验原奖励入账记录', 503);
    } finally { this.active--; }
  }
  async close() { await this.pool?.end?.(); }
}

module.exports = { RechargeSource, REDEMPTION_SQL, minor };
