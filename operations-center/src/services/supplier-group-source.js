'use strict';
const crypto = require('node:crypto');
const { GroupMonitorSource } = require('./group-monitor-source');
const { AppError } = require('../errors');

function keyIdentity(value) {
  const key = String(value || '').trim().replace(/^Bearer\s+/i, '').replace(/^sk-/, '');
  if (key.length < 16 || /[\s*•…]/u.test(key) || /\.{2,}/.test(key)) return null;
  return crypto.createHash('sha256').update('supplier-group-key-v1\0').update(key).digest('hex');
}

class SupplierGroupSource {
  constructor({ pool, config }) { this.reader = new GroupMonitorSource({ pool, config }); this.config = config; }
  scope() { return this.reader.scope(); }
  async read(from, to) {
    try { return await this.reader.read(async client => {
      const usage = (await client.query(`SELECT u.account_id::text AS account_id,u.group_id::text AS group_id,
        MAX(g.name) AS group_name,SUM(u.actual_cost)::text AS amount,COUNT(*)::text AS requests,
        MIN(u.created_at)::text AS first_at,COUNT(*) FILTER (WHERE u.actual_cost IS NULL OR u.actual_cost<0)::text AS invalid
        FROM public.usage_logs u LEFT JOIN public.groups g ON g.id=u.group_id
        WHERE u.created_at >= $1::timestamptz AND u.created_at < $2::timestamptz AND u.user_id<>1
        GROUP BY u.account_id,u.group_id ORDER BY u.account_id,u.group_id LIMIT 50001`, [from, to])).rows;
      const rows = (await client.query(`SELECT a.id::text AS id,a.name,a.status,
        a.credentials->>'api_key' AS secret,a.updated_at::text AS updated_at,a.deleted_at::text AS deleted_at
        FROM public.accounts a WHERE (a.deleted_at IS NULL AND a.credentials->>'api_key' IS NOT NULL)
          OR a.id IN (SELECT account_id FROM public.usage_logs WHERE created_at >= $1::timestamptz
            AND created_at < $2::timestamptz AND user_id<>1)
        ORDER BY a.id LIMIT 10001`, [from, to])).rows;
      if (usage.length > 50000 || rows.length > 10000) throw new AppError('SUPPLIER_GROUP_SOURCE_LIMIT', '账号或用量分组超过读取上限，本次不使用截断数据', { status: 503 });
      const coverage = (await client.query(`WITH days AS (
        SELECT generate_series(($1::timestamptz AT TIME ZONE $3)::date::timestamp,
          (($2::timestamptz - INTERVAL '1 microsecond') AT TIME ZONE $3)::date::timestamp,INTERVAL '1 day')::date AS day)
        SELECT BOOL_AND(d.bucket_date IS NOT NULL AND d.total_requests>=0 AND c.count >= d.total_requests) AS complete
        FROM days LEFT JOIN public.usage_dashboard_daily d ON d.bucket_date=days.day
        CROSS JOIN LATERAL (SELECT COUNT(*) AS count FROM public.usage_logs
          WHERE created_at >= days.day::timestamp AT TIME ZONE $3
            AND created_at < (days.day+1)::timestamp AT TIME ZONE $3) c`,
      [from, to, this.config.sub2apiTimezone || this.config.financeTimezone])).rows[0];
      const accounts = rows.map(row => ({ id: row.id, name: String(row.name || row.id).slice(0, 200),
        status: row.status, deleted: Boolean(row.deleted_at), identity: keyIdentity(row.secret), updatedAt: row.updated_at }));
      rows.forEach(row => { row.secret = null; });
      const accountIds = new Set(accounts.map(a => a.id));
      const valid = usage.every(row => accountIds.has(row.account_id) && row.invalid === '0' && Number.isFinite(Number(row.amount)) && Number(row.amount) >= 0 &&
        Number.isSafeInteger(Number(row.requests)) && Number(row.requests) >= 0);
      return { accounts, usage: usage.map(row => ({ ...row, amount: Number.isFinite(Number(row.amount)) && Number(row.amount) >= 0 ? row.amount : '0' })),
        complete: coverage?.complete === true && valid };
    }); } catch (error) {
      if (error.code === 'SUPPLIER_GROUP_SOURCE_LIMIT') throw error;
      throw new AppError('SUPPLIER_GROUP_SOURCE_UNAVAILABLE', '无法完整读取主站账号及用量，请检查只读数据库和用量保留范围', { status: 503 });
    }
  }
}
module.exports = { SupplierGroupSource, keyIdentity };
