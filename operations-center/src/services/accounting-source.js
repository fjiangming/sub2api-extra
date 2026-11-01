'use strict';

const { DateTime } = require('luxon');
const { addUtcDays } = require('./metrics-service');

function localDate(value, timezone) {
  if (!value) return null;
  const date = value instanceof Date ? DateTime.fromJSDate(value) : DateTime.fromISO(String(value), { setZone: true });
  return date.isValid ? date.setZone(timezone).toISODate() : null;
}

class AccountingSource {
  constructor({ pool, inspector, config, store }) { Object.assign(this, { pool, inspector, config, store }); }

  async collectDay(date) {
    const schema = await this.inspector.inspect();
    if (['usage_logs', 'users', 'redeem_codes', 'payment_orders'].some(table => !schema.tables[table]?.exists)) {
      return { version: 2, complete: false, date, usage: [], users: [], reason: '缺少收入核算所需的主站表' };
    }
    const client = this.pool.connect ? await this.pool.connect() : this.pool;
    try {
      if (this.pool.connect) await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const result = await this.readDay(client, date);
      if (this.pool.connect) await client.query('COMMIT');
      this.store.importDocuments(result.documents);
      const { documents, ...source } = result;
      return source;
    } catch (error) {
      if (this.pool.connect) await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { if (this.pool.connect) client.release(); }
  }

  async readDay(client, date) {
    const zone = this.config.financeTimezone;
    const params = [date, addUtcDays(date, 1), zone];
    const { rows: usages } = await client.query(`SELECT user_id::text AS user_id, billing_type,
      SUM(actual_cost)::text AS amount, COUNT(*) AS requests
      FROM usage_logs WHERE created_at >= $1::date::timestamp AT TIME ZONE $3
      AND created_at < $2::date::timestamp AT TIME ZONE $3 AND user_id <> 1
      GROUP BY user_id,billing_type`, params);
    const { rows: credits } = await client.query(`SELECT r.id::text AS id,r.used_by::text AS user_id,
      r.type,r.value::text AS value,r.used_at,r.code,r.notes,to_jsonb(r)->>'created_at' AS created_at,
      (SELECT jsonb_agg(jsonb_build_object('id',p.id::text,'amount',p.amount::text,'cash',p.pay_amount::text,
        'paidAt',p.paid_at,'currency',COALESCE(NULLIF(to_jsonb(p)->'provider_snapshot'->>'currency',''),
        NULLIF(to_jsonb(p)->'provider_snapshot'->'config'->>'currency',''))))
       FROM payment_orders p WHERE p.recharge_code=r.code AND p.recharge_code<>''
       AND p.order_type='balance' AND p.paid_at IS NOT NULL AND p.user_id=r.used_by) AS payments
      FROM redeem_codes r WHERE r.used_at >= $1::date::timestamp AT TIME ZONE $3
      AND r.used_at < $2::date::timestamp AT TIME ZONE $3 AND r.status='used'
      AND r.type IN ('balance','admin_balance') AND r.used_by IS DISTINCT FROM 1`, params);
    const { rows: payments } = await client.query(`SELECT p.id::text AS id,p.user_id::text AS user_id,
      p.amount::text,p.pay_amount::text AS cash,p.order_type,p.paid_at,p.completed_at,p.refund_at,
      p.refund_amount::text,p.status,
      to_jsonb(p)->>'subscription_days' AS subscription_days,
      to_jsonb(p)->>'subscription_group_id' AS subscription_group_id,
      COALESCE(NULLIF(to_jsonb(p)->'provider_snapshot'->>'currency',''),
        NULLIF(to_jsonb(p)->'provider_snapshot'->'config'->>'currency','')) AS currency
      FROM payment_orders p WHERE p.user_id IS DISTINCT FROM 1 AND (
      (p.paid_at >= $1::date::timestamp AT TIME ZONE $3 AND p.paid_at < $2::date::timestamp AT TIME ZONE $3) OR
      (p.refund_at >= $1::date::timestamp AT TIME ZONE $3 AND p.refund_at < $2::date::timestamp AT TIME ZONE $3) OR
      p.id=ANY($4::bigint[]))`, [...params, credits.flatMap(row => (row.payments || []).map(payment => payment.id))]);
    const userIds = [...new Set([...usages, ...credits, ...payments].map(row => row.user_id).filter(Boolean))];
    const { rows: users } = await client.query(`SELECT u.id::text AS id,u.balance::text AS balance,
      to_jsonb(u)->>'created_at' AS created_at,u.deleted_at,
      to_jsonb(u)->>'email' AS email,to_jsonb(u)->>'username' AS username
      FROM users u WHERE u.id <> 1 AND u.id=ANY($1::bigint[])`, [userIds]);
    const userById = new Map(users.map(row => [row.id, row]));
    const documents = credits.map(row => ({ key: `redeem:${row.id}`, origin: 'redeem', date,
      userId: row.user_id, kind: 'credit', quantity: row.value, redeemType: row.type,
      name: `兑换记录 #${row.id}`, note: row.notes || '', payments: row.payments || [],
      usedAt: row.used_at instanceof Date ? row.used_at.toISOString() : row.used_at,
      code: row.code, sourceCreatedAt: row.created_at,
      userName: userById.get(row.user_id)?.username || userById.get(row.user_id)?.email || this.store.document(`redeem:${row.id}`)?.userName || null }));
    for (const row of payments) {
      const paidDate = localDate(row.paid_at, zone);
      if (paidDate) documents.push({ key: `payment:${row.id}`, origin: 'payment', date: paidDate,
        userId: row.user_id, name: `支付订单 #${row.id}`, amount: row.cash, currency: row.currency,
        quantity: row.amount, kind: row.order_type === 'subscription' ? 'subscription' : 'customer_receipt',
        completedAt: localDate(row.completed_at, zone), subscriptionDays: Number(row.subscription_days) || null,
        groupId: row.subscription_group_id, status: row.status });
      const refundDate = localDate(row.refund_at, zone);
      if (refundDate && Number(row.refund_amount) > 0) documents.push({ key: `refund:${row.id}`, origin: 'refund',
        date: refundDate, userId: row.user_id, name: `退款订单 #${row.id}`, kind: 'refund',
        linkedPayment: `payment:${row.id}`, quantity: row.refund_amount, amount: null, currency: row.currency });
    }
    return { version: 2, complete: true, date, documents,
      usage: usages.map(row => ({ userId: row.user_id, billingType: row.billing_type == null ? null : Number(row.billing_type), amount: row.amount, requests: Number(row.requests) })),
      users: users.map(row => ({ id: row.id, balance: row.balance, createdDate: localDate(row.created_at, zone),
        deleted: Boolean(row.deleted_at), name: row.username || row.email || `用户 #${row.id}` })),
      capturedAt: new Date().toISOString() };
  }
}

module.exports = { AccountingSource, localDate };
