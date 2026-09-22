'use strict';

const { AppError } = require('../errors');
const { BoundedTtlCache } = require('../cache');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_SQL = `UPPER(COALESCE(
  NULLIF(provider_snapshot->>'currency', ''),
  NULLIF(provider_snapshot->'config'->>'currency', ''),
  'CNY'
))`;

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(value, days) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDate(date);
}

function dateInTimezone(timezone, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function parseDateRange(input = {}, options = {}) {
  const maxDays = options.maxDays || 730;
  const defaultDays = options.defaultDays || 30;
  const today = options.today || isoDate(new Date());
  const start = input.start || addUtcDays(today, -(defaultDays - 1));
  const end = input.end || today;
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    throw new AppError('INVALID_DATE_RANGE', '日期格式必须为 YYYY-MM-DD', { status: 400 });
  }
  const startTime = Date.parse(`${start}T00:00:00.000Z`);
  const endTime = Date.parse(`${end}T00:00:00.000Z`);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime < startTime) {
    throw new AppError('INVALID_DATE_RANGE', '结束日期不能早于开始日期', { status: 400 });
  }
  const days = Math.floor((endTime - startTime) / 86400000) + 1;
  if (days > maxDays) {
    throw new AppError('DATE_RANGE_TOO_LARGE', `查询范围最多 ${maxDays} 天`, { status: 400 });
  }
  return { start, end, endExclusive: addUtcDays(end, 1), days };
}

function number(value) {
  if (value == null || value === '') return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function numericRow(row, fields) {
  const output = { ...row };
  for (const field of fields) output[field] = number(output[field]);
  return output;
}

class MetricsService {
  constructor(pool, inspector, config) {
    this.pool = pool;
    this.inspector = inspector;
    this.config = config;
    this.cache = new BoundedTtlCache({ ttlMs: config.cacheTtlSeconds * 1000, maxEntries: 100 });
  }

  async cached(key, fn) {
    const existing = this.cache.get(key);
    if (existing !== undefined) return existing;
    const value = await fn();
    return this.cache.set(key, value);
  }

  async require(names) {
    const missing = await this.inspector.requireTables(names);
    if (missing.length) {
      throw new AppError('SCHEMA_INCOMPATIBLE', `缺少必要数据表：${missing.join(', ')}`, {
        status: 503,
        details: { missing }
      });
    }
  }

  async getOverview() {
    return this.cached('overview', async () => {
      await this.require(['users', 'usage_dashboard_daily', 'usage_dashboard_daily_users', 'payment_orders']);
      const [users, activity, usage, payments, coverage] = await Promise.all([
        this.pool.query(`
          SELECT COUNT(*) AS total_users,
                 COUNT(*) FILTER (WHERE deleted_at IS NULL) AS retained_users,
                 COUNT(*) FILTER (WHERE deleted_at IS NULL AND status = 'active') AS available_users,
                 COUNT(*) FILTER (WHERE created_at >= date_trunc('day', NOW() AT TIME ZONE $1) AT TIME ZONE $1) AS new_today,
                 COUNT(*) FILTER (WHERE created_at >= date_trunc('month', NOW() AT TIME ZONE $1) AT TIME ZONE $1) AS new_month
          FROM users
        `, [this.config.sub2apiTimezone]),
        this.pool.query(`
          SELECT COUNT(DISTINCT user_id) FILTER (
                   WHERE bucket_date = (NOW() AT TIME ZONE $1)::date
                 ) AS dau,
                 COUNT(DISTINCT user_id) FILTER (
                   WHERE bucket_date >= date_trunc('month', NOW() AT TIME ZONE $1)::date
                 ) AS mau,
                 COUNT(DISTINCT user_id) FILTER (
                   WHERE bucket_date >= (NOW() AT TIME ZONE $1)::date - 6
                 ) AS active_7d,
                 COUNT(DISTINCT user_id) FILTER (
                   WHERE bucket_date >= (NOW() AT TIME ZONE $1)::date - 29
                 ) AS active_30d
          FROM usage_dashboard_daily_users
          WHERE bucket_date >= LEAST(
            date_trunc('month', NOW() AT TIME ZONE $1)::date,
            (NOW() AT TIME ZONE $1)::date - 29
          )
        `, [this.config.sub2apiTimezone]),
        this.pool.query(`
          SELECT COALESCE(SUM(total_requests) FILTER (
                   WHERE bucket_date = (NOW() AT TIME ZONE $1)::date
                 ), 0) AS requests_today,
                 COALESCE(SUM(actual_cost) FILTER (
                   WHERE bucket_date = (NOW() AT TIME ZONE $1)::date
                 ), 0) AS spend_today,
                 COALESCE(SUM(total_requests) FILTER (
                   WHERE bucket_date >= date_trunc('month', NOW() AT TIME ZONE $1)::date
                 ), 0) AS requests_month,
                 COALESCE(SUM(actual_cost) FILTER (
                   WHERE bucket_date >= date_trunc('month', NOW() AT TIME ZONE $1)::date
                 ), 0) AS spend_month,
                 MAX(computed_at) AS computed_at
          FROM usage_dashboard_daily
          WHERE bucket_date >= date_trunc('month', NOW() AT TIME ZONE $1)::date
        `, [this.config.sub2apiTimezone]),
        this.pool.query(`
          SELECT ${CURRENCY_SQL} AS currency,
                 COALESCE(SUM(pay_amount) FILTER (
                   WHERE paid_at >= date_trunc('day', NOW() AT TIME ZONE $1) AT TIME ZONE $1
                 ), 0) AS paid_today,
                 COALESCE(SUM(pay_amount) FILTER (
                   WHERE paid_at >= date_trunc('month', NOW() AT TIME ZONE $1) AT TIME ZONE $1
                 ), 0) AS paid_month,
                 COUNT(*) FILTER (
                   WHERE paid_at >= date_trunc('month', NOW() AT TIME ZONE $1) AT TIME ZONE $1
                 ) AS orders_month
          FROM payment_orders
          WHERE paid_at IS NOT NULL
            AND paid_at >= date_trunc('month', NOW() AT TIME ZONE $1) AT TIME ZONE $1
          GROUP BY 1
          ORDER BY 1
        `, [this.config.financeTimezone]),
        this.pool.query(`
          SELECT MIN(bucket_date)::text AS daily_from,
                 MAX(bucket_date)::text AS daily_through,
                 MAX(computed_at) AS last_computed_at
          FROM usage_dashboard_daily
        `)
      ]);
      return {
        generatedAt: new Date().toISOString(),
        timezones: { usage: this.config.sub2apiTimezone, finance: this.config.financeTimezone },
        users: numericRow(users.rows[0], ['total_users', 'retained_users', 'available_users', 'new_today', 'new_month']),
        activity: numericRow(activity.rows[0], ['dau', 'mau', 'active_7d', 'active_30d']),
        usage: numericRow(usage.rows[0], ['requests_today', 'spend_today', 'requests_month', 'spend_month']),
        payments: payments.rows.map((row) => numericRow(row, ['paid_today', 'paid_month', 'orders_month'])),
        coverage: coverage.rows[0]
      };
    });
  }

  async getUsage(input) {
    const range = parseDateRange(input, {
      maxDays: this.config.retention.usageDailyDays,
      today: dateInTimezone(this.config.sub2apiTimezone)
    });
    return this.cached(`usage:${range.start}:${range.end}`, async () => {
      await this.require(['usage_dashboard_daily', 'usage_dashboard_daily_users']);
      const [daily, summary, coverage] = await Promise.all([
        this.pool.query(`
          SELECT bucket_date::text AS date,
                 total_requests,
                 input_tokens,
                 output_tokens,
                 cache_creation_tokens,
                 cache_read_tokens,
                 total_cost,
                 actual_cost,
                 account_cost,
                 total_duration_ms,
                 active_users,
                 computed_at
          FROM usage_dashboard_daily
          WHERE bucket_date >= $1::date AND bucket_date < $2::date
          ORDER BY bucket_date
        `, [range.start, range.endExclusive]),
        this.pool.query(`
          SELECT COALESCE(SUM(total_requests), 0) AS total_requests,
                 COALESCE(SUM(input_tokens), 0) AS input_tokens,
                 COALESCE(SUM(output_tokens), 0) AS output_tokens,
                 COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
                 COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
                 COALESCE(SUM(total_cost), 0) AS total_cost,
                 COALESCE(SUM(actual_cost), 0) AS actual_cost,
                 COALESCE(SUM(account_cost), 0) AS account_cost,
                 COALESCE(SUM(total_duration_ms), 0) AS total_duration_ms,
                 (SELECT COUNT(DISTINCT user_id)
                  FROM usage_dashboard_daily_users
                  WHERE bucket_date >= $1::date AND bucket_date < $2::date) AS active_users,
                 CASE WHEN SUM(total_requests) > 0
                      THEN SUM(total_duration_ms)::numeric / SUM(total_requests)
                      ELSE NULL END AS average_duration_ms,
                 MIN(bucket_date)::text AS data_from,
                 MAX(bucket_date)::text AS data_through,
                 MAX(computed_at) AS computed_at
          FROM usage_dashboard_daily
          WHERE bucket_date >= $1::date AND bucket_date < $2::date
        `, [range.start, range.endExclusive]),
        this.pool.query(`
          SELECT MIN(bucket_date)::text AS available_from,
                 MAX(bucket_date)::text AS available_through,
                 COUNT(*) AS stored_buckets
          FROM usage_dashboard_daily
        `)
      ]);
      const numericFields = [
        'total_requests', 'input_tokens', 'output_tokens', 'cache_creation_tokens',
        'cache_read_tokens', 'total_cost', 'actual_cost', 'account_cost',
        'total_duration_ms', 'active_users', 'average_duration_ms'
      ];
      const byDate = new Map(daily.rows.map((row) => [row.date, numericRow(row, numericFields)]));
      const trend = [];
      for (let date = range.start; date < range.endExclusive; date = addUtcDays(date, 1)) {
        trend.push(byDate.get(date) || { date, available: false });
      }
      return {
        range,
        timezone: this.config.sub2apiTimezone,
        granularity: 'day',
        detailRetentionDays: this.config.retention.usageLogsDays,
        generatedAt: new Date().toISOString(),
        summary: numericRow(summary.rows[0], numericFields),
        trend,
        coverage: numericRow(coverage.rows[0], ['stored_buckets']),
        limitations: range.days > this.config.retention.usageLogsDays
          ? [`超过近 ${this.config.retention.usageLogsDays} 天的范围仅有站点级日汇总，不能恢复用户、API Key、模型、分组或端点维度。`]
          : []
      };
    });
  }

  async getUsageDimensions(input) {
    const range = parseDateRange(input, {
      maxDays: this.config.retention.usageLogsDays,
      today: dateInTimezone(this.config.sub2apiTimezone)
    });
    const earliest = new Date(Date.now() - this.config.retention.usageLogsDays * 86400000);
    if (Date.parse(`${range.start}T00:00:00Z`) < earliest.getTime() - 86400000) {
      throw new AppError('DETAIL_RANGE_EXPIRED', `维度明细只保证最近 ${this.config.retention.usageLogsDays} 天`, { status: 400 });
    }
    await this.require(['usage_logs']);
    const dimensions = {
      model: `COALESCE(NULLIF(requested_model, ''), NULLIF(model, ''), '(unknown)')`,
      user: `user_id::text`,
      apiKey: `api_key_id::text`,
      account: `account_id::text`,
      group: `COALESCE(group_id::text, '(none)')`,
      billing: `billing_type::text`
    };
    const dimension = input.dimension || 'model';
    const expression = dimensions[dimension];
    if (!expression) throw new AppError('INVALID_DIMENSION', '不支持的用量维度', { status: 400 });
    const values = [range.start, range.endExclusive, this.config.sub2apiTimezone];
    const conditions = [
      'created_at >= $1::date::timestamp AT TIME ZONE $3',
      'created_at < $2::date::timestamp AT TIME ZONE $3'
    ];
    const filterMap = [
      ['userId', 'user_id'], ['apiKeyId', 'api_key_id'], ['accountId', 'account_id'], ['groupId', 'group_id']
    ];
    for (const [key, column] of filterMap) {
      if (input[key] == null || input[key] === '') continue;
      const value = Number(input[key]);
      if (!Number.isSafeInteger(value) || value <= 0) throw new AppError('INVALID_FILTER', `${key} 必须为正整数`, { status: 400 });
      values.push(value);
      conditions.push(`${column} = $${values.length}`);
    }
    if (input.model) {
      values.push(String(input.model).slice(0, 100));
      conditions.push(`COALESCE(NULLIF(requested_model, ''), model) = $${values.length}`);
    }
    const { rows } = await this.pool.query(`
      SELECT ${expression} AS label,
             COUNT(*) AS requests,
             COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
             COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
             COALESCE(SUM(actual_cost), 0) AS actual_cost,
             COALESCE(SUM(total_cost), 0) AS total_cost,
             COALESCE(SUM(image_count), 0) AS image_count,
             COALESCE(SUM(video_count), 0) AS video_count,
             CASE WHEN COUNT(*) > 0 THEN AVG(duration_ms) FILTER (WHERE duration_ms IS NOT NULL) END AS average_duration_ms
      FROM usage_logs
      WHERE ${conditions.join(' AND ')}
      GROUP BY 1
      ORDER BY actual_cost DESC, requests DESC
      LIMIT 100
    `, values);
    const fields = ['requests', 'input_tokens', 'output_tokens', 'cache_creation_tokens', 'cache_read_tokens', 'actual_cost', 'total_cost', 'image_count', 'video_count', 'average_duration_ms'];
    return { range, timezone: this.config.sub2apiTimezone, dimension, rows: rows.map((row) => numericRow(row, fields)) };
  }

  async getUsers(input) {
    const range = parseDateRange(input, {
      maxDays: this.config.retention.usageDailyDays,
      today: dateInTimezone(this.config.sub2apiTimezone)
    });
    return this.cached(`users:${range.start}:${range.end}`, async () => {
      await this.require(['users', 'usage_dashboard_daily_users']);
      const [activity, registrations, summary, firstObserved, activation, cohorts] = await Promise.all([
        this.pool.query(`
          SELECT bucket_date::text AS date, COUNT(*) AS active_users
          FROM usage_dashboard_daily_users
          WHERE bucket_date >= $1::date AND bucket_date < $2::date
          GROUP BY bucket_date ORDER BY bucket_date
        `, [range.start, range.endExclusive]),
        this.pool.query(`
          SELECT (created_at AT TIME ZONE $3)::date::text AS date, COUNT(*) AS new_users
          FROM users
          WHERE created_at >= $1::date::timestamp AT TIME ZONE $3
            AND created_at < $2::date::timestamp AT TIME ZONE $3
          GROUP BY 1 ORDER BY 1
        `, [range.start, range.endExclusive, this.config.sub2apiTimezone]),
        this.pool.query(`
          SELECT (SELECT COUNT(DISTINCT user_id) FROM usage_dashboard_daily_users
                  WHERE bucket_date >= $1::date AND bucket_date < $2::date) AS active_users,
                 (SELECT COUNT(*) FROM users
                  WHERE created_at >= $1::date::timestamp AT TIME ZONE $3
                    AND created_at < $2::date::timestamp AT TIME ZONE $3) AS new_users,
                 (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL) AS retained_users,
                 (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL AND status = 'active') AS available_users
        `, [range.start, range.endExclusive, this.config.sub2apiTimezone]),
        this.pool.query(`
          WITH first_seen AS (
            SELECT user_id, MIN(bucket_date) AS first_date
            FROM usage_dashboard_daily_users
            GROUP BY user_id
          )
          SELECT COUNT(*) AS first_observed_users
          FROM first_seen
          WHERE first_date >= $1::date AND first_date < $2::date
        `, [range.start, range.endExclusive]),
        this.pool.query(`
          WITH mature AS (
            SELECT id, (created_at AT TIME ZONE $3)::date AS registered_date
            FROM users
            WHERE created_at >= $1::date::timestamp AT TIME ZONE $3
              AND created_at < LEAST($2::date, (NOW() AT TIME ZONE $3)::date - 6)::timestamp AT TIME ZONE $3
          )
          SELECT COUNT(*) AS mature_registrations,
                 COUNT(*) FILTER (WHERE EXISTS (
                   SELECT 1 FROM usage_dashboard_daily_users d
                   WHERE d.user_id = mature.id
                     AND d.bucket_date >= mature.registered_date
                     AND d.bucket_date < mature.registered_date + 7
                 )) AS activated_7d
          FROM mature
        `, [range.start, range.endExclusive, this.config.sub2apiTimezone]),
        this.pool.query(`
          WITH cohorts AS (
            SELECT id, (created_at AT TIME ZONE $3)::date AS cohort_date
            FROM users
            WHERE created_at >= GREATEST($1::date, (NOW() AT TIME ZONE $3)::date - 90)::timestamp AT TIME ZONE $3
              AND created_at < $2::date::timestamp AT TIME ZONE $3
          )
          SELECT cohort_date::text,
                 COUNT(*) AS registered,
                 COUNT(*) FILTER (WHERE EXISTS (
                   SELECT 1 FROM usage_dashboard_daily_users d WHERE d.user_id = cohorts.id AND d.bucket_date = cohort_date + 1
                 )) AS retained_d1,
                 COUNT(*) FILTER (WHERE EXISTS (
                   SELECT 1 FROM usage_dashboard_daily_users d WHERE d.user_id = cohorts.id AND d.bucket_date = cohort_date + 7
                 )) AS retained_d7,
                 COUNT(*) FILTER (WHERE EXISTS (
                   SELECT 1 FROM usage_dashboard_daily_users d WHERE d.user_id = cohorts.id AND d.bucket_date = cohort_date + 30
                 )) AS retained_d30
          FROM cohorts
          GROUP BY cohort_date ORDER BY cohort_date
        `, [range.start, range.endExclusive, this.config.sub2apiTimezone])
      ]);
      const activeByDate = new Map(activity.rows.map((row) => [row.date, number(row.active_users)]));
      const newByDate = new Map(registrations.rows.map((row) => [row.date, number(row.new_users)]));
      const trend = [];
      for (let date = range.start; date < range.endExclusive; date = addUtcDays(date, 1)) {
        trend.push({
          date,
          activeUsers: activeByDate.has(date) ? activeByDate.get(date) : null,
          newUsers: newByDate.get(date) || 0
        });
      }
      const activationRow = numericRow(activation.rows[0], ['mature_registrations', 'activated_7d']);
      activationRow.rate = activationRow.mature_registrations
        ? activationRow.activated_7d / activationRow.mature_registrations
        : null;
      return {
        range,
        timezone: this.config.sub2apiTimezone,
        summary: {
          ...numericRow(summary.rows[0], ['active_users', 'new_users', 'retained_users', 'available_users']),
          ...numericRow(firstObserved.rows[0], ['first_observed_users'])
        },
        activation7d: activationRow,
        trend,
        cohorts: cohorts.rows.map((row) => numericRow(row, ['registered', 'retained_d1', 'retained_d7', 'retained_d30'])),
        caveat: '首次使用按当前最长 730 天活跃集合计算，历史覆盖不足时代表首次观测活跃。'
      };
    });
  }

  async getFinance(input) {
    const range = parseDateRange(input, {
      maxDays: 3650,
      defaultDays: 30,
      today: dateInTimezone(this.config.financeTimezone)
    });
    return this.cached(`finance:${range.start}:${range.end}`, async () => {
      await this.require(['payment_orders', 'redeem_codes']);
      const [payments, refunds, credits, summary, anomalies] = await Promise.all([
        this.pool.query(`
          SELECT (paid_at AT TIME ZONE $3)::date::text AS date,
                 ${CURRENCY_SQL} AS currency,
                 order_type,
                 COUNT(*) AS orders,
                 COUNT(DISTINCT user_id) AS paying_users,
                 COALESCE(SUM(pay_amount), 0) AS gross_received
          FROM payment_orders
          WHERE paid_at >= $1::date::timestamp AT TIME ZONE $3
            AND paid_at < $2::date::timestamp AT TIME ZONE $3
          GROUP BY 1, 2, 3 ORDER BY 1, 2, 3
        `, [range.start, range.endExclusive, this.config.financeTimezone]),
        this.pool.query(`
          SELECT (refund_at AT TIME ZONE $3)::date::text AS date,
                 ${CURRENCY_SQL} AS currency,
                 order_type,
                 COUNT(*) AS refunded_orders,
                 COALESCE(SUM(
                   CASE WHEN amount > 0 AND pay_amount > 0 AND refund_amount > 0
                        THEN LEAST(pay_amount, pay_amount * refund_amount / amount)
                        ELSE 0 END
                 ), 0) AS estimated_cash_refund
          FROM payment_orders
          WHERE refund_at >= $1::date::timestamp AT TIME ZONE $3
            AND refund_at < $2::date::timestamp AT TIME ZONE $3
          GROUP BY 1, 2, 3 ORDER BY 1, 2, 3
        `, [range.start, range.endExclusive, this.config.financeTimezone]),
        this.pool.query(`
          SELECT (r.used_at AT TIME ZONE $3)::date::text AS date,
                 CASE
                 WHEN p.id IS NOT NULL THEN 'online_payment'
                   WHEN r.type = 'admin_balance' THEN 'admin_adjustment'
                   ELSE 'standalone_redeem'
                 END AS source,
                 COUNT(*) AS events,
                 COUNT(DISTINCT r.used_by) AS users,
                 COALESCE(SUM(r.value), 0) AS credited_amount
          FROM redeem_codes r
          LEFT JOIN payment_orders p ON p.recharge_code = r.code
          WHERE r.used_at >= $1::date::timestamp AT TIME ZONE $3
            AND r.used_at < $2::date::timestamp AT TIME ZONE $3
            AND r.used_at IS NOT NULL
            AND r.type IN ('balance', 'admin_balance')
          GROUP BY 1, 2 ORDER BY 1, 2
        `, [range.start, range.endExclusive, this.config.financeTimezone]),
        this.pool.query(`
          WITH paid AS (
            SELECT user_id, order_type, ${CURRENCY_SQL} AS currency, pay_amount
            FROM payment_orders
            WHERE paid_at >= $1::date::timestamp AT TIME ZONE $3
              AND paid_at < $2::date::timestamp AT TIME ZONE $3
          ), refunded AS (
            SELECT order_type, ${CURRENCY_SQL} AS currency,
                   CASE WHEN amount > 0 AND pay_amount > 0 AND refund_amount > 0
                        THEN LEAST(pay_amount, pay_amount * refund_amount / amount)
                        ELSE 0 END AS cash_refund
            FROM payment_orders
            WHERE refund_at >= $1::date::timestamp AT TIME ZONE $3
              AND refund_at < $2::date::timestamp AT TIME ZONE $3
          ), keys AS (
            SELECT currency, order_type FROM paid UNION SELECT currency, order_type FROM refunded
          )
          SELECT keys.currency, keys.order_type,
                 (SELECT COUNT(*) FROM paid p WHERE p.currency = keys.currency AND p.order_type = keys.order_type) AS orders,
                 (SELECT COUNT(DISTINCT user_id) FROM paid p WHERE p.currency = keys.currency AND p.order_type = keys.order_type) AS paying_users,
                 COALESCE((SELECT SUM(pay_amount) FROM paid p WHERE p.currency = keys.currency AND p.order_type = keys.order_type), 0) AS gross_received,
                 COALESCE((SELECT SUM(cash_refund) FROM refunded r WHERE r.currency = keys.currency AND r.order_type = keys.order_type), 0) AS estimated_cash_refund
          FROM keys ORDER BY keys.currency, keys.order_type
        `, [range.start, range.endExclusive, this.config.financeTimezone]),
        this.pool.query(`
          SELECT COUNT(*) FILTER (WHERE paid_at IS NOT NULL AND status IN ('PENDING', 'FAILED', 'EXPIRED')) AS paid_status_conflicts,
                 COUNT(*) FILTER (WHERE paid_at IS NULL AND status IN ('PAID', 'COMPLETED', 'RECHARGING')) AS status_without_paid_at,
                 COUNT(*) FILTER (WHERE paid_at IS NOT NULL AND COALESCE(NULLIF(provider_snapshot->>'currency', ''), NULLIF(provider_snapshot->'config'->>'currency', '')) IS NULL) AS inferred_currency_orders,
                 COUNT(*) FILTER (WHERE status IN ('COMPLETED', 'PAID', 'RECHARGING') AND recharge_code <> '' AND NOT EXISTS (
                   SELECT 1 FROM redeem_codes r WHERE r.code = payment_orders.recharge_code AND r.used_at IS NOT NULL
                 )) AS paid_without_credit
          FROM payment_orders
        `)
      ]);
      const paymentFields = ['orders', 'paying_users', 'gross_received'];
      const refundFields = ['refunded_orders', 'estimated_cash_refund'];
      const creditFields = ['events', 'users', 'credited_amount'];
      const summaryRows = summary.rows.map((row) => {
        const parsed = numericRow(row, ['orders', 'paying_users', 'gross_received', 'estimated_cash_refund']);
        parsed.netReceived = parsed.gross_received - parsed.estimated_cash_refund;
        parsed.averageOrderValue = parsed.orders ? parsed.gross_received / parsed.orders : null;
        return parsed;
      });
      return {
        range,
        timezone: this.config.financeTimezone,
        payments: payments.rows.map((row) => numericRow(row, paymentFields)),
        refunds: refunds.rows.map((row) => numericRow(row, refundFields)),
        credits: credits.rows.map((row) => numericRow(row, creditFields)),
        summary: summaryRows,
        anomalies: numericRow(anomalies.rows[0], ['paid_status_conflicts', 'status_without_paid_at', 'inferred_currency_orders', 'paid_without_credit']),
        caveats: [
          '实收使用 paid_at 与 pay_amount；余额入账来自已使用兑换凭证，两者不相加为收入。',
          '退款现金额按订单金额比例估算，需与支付渠道结算单复核。',
          '缺失历史币种快照的订单暂按 CNY 展示并计入 inferred_currency_orders。'
        ]
      };
    });
  }
}

module.exports = { MetricsService, parseDateRange, addUtcDays, dateInTimezone, number, numericRow, CURRENCY_SQL };
