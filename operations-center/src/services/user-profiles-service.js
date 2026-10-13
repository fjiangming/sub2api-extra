'use strict';

const { z } = require('zod');
const { AppError } = require('../errors');
const { BoundedTtlCache } = require('../cache');
const { parseDateRange, addUtcDays, dateInTimezone } = require('./metrics-service');

const UNKNOWN_PLATFORM = '(unknown)';
const MODEL_REMAINDER = '(aggregate)';
const METRICS = ['requests', 'tokens', 'cost'];
const querySchema = z.object({
  start: z.string().optional(),
  end: z.string().optional(),
  platform: z.string().trim().min(1).max(50).default('all'),
  billing: z.enum(['all', 'balance', 'subscription']).default('all'),
  metric: z.enum(METRICS).default('requests'),
  search: z.string().trim().max(120).default(''),
  segment: z.enum(['all', 'high', 'multi', 'decline', 'balance']).default('all'),
  sort: z.enum(['cost', 'requests', 'tokens', 'days']).default('cost'),
  page: z.coerce.number().int().min(1).max(1000000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20)
});

function parseQuery(input, config, now) {
  const result = querySchema.safeParse(input || {});
  if (!result.success) throw new AppError('INVALID_REQUEST', '用户画像查询参数无效', { status: 400 });
  const query = result.data;
  const today = dateInTimezone(config.sub2apiTimezone, now);
  const maxDays = Math.min(config.retention.usageLogsDays, 366);
  const range = parseDateRange(query, { today, maxDays, defaultDays: Math.min(30, maxDays) });
  const earliest = addUtcDays(today, 1 - config.retention.usageLogsDays);
  if (range.start < earliest || range.end > today) {
    throw new AppError('DETAIL_RANGE_EXPIRED', `画像明细可查询 ${earliest} 至 ${today}，不能还原已清理的历史`, { status: 400 });
  }
  return { ...query, range, today, earliest, maxDays, asOf: now.toISOString() };
}

function parseUserId(value) {
  const id = String(value);
  if (!/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) {
    throw new AppError('INVALID_USER_ID', '用户 ID 必须为有效的正整数', { status: 400 });
  }
  return id;
}

function csvCell(value) {
  let text = value == null ? '' : String(value);
  if (/^[\s\u0000-\u001f]*[=+@-]/u.test(text) || /^[\t\r\n]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function csvDocument(rows) {
  return '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

const SUM_LOGS = `COUNT(*) AS requests, COALESCE(SUM(tokens), 0) AS tokens,
  COALESCE(SUM(cost), 0) AS cost, COALESCE(SUM(input_tokens), 0) AS input_tokens,
  COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
  COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens`;

class UserProfilesService {
  constructor(pool, inspector, config, { now = () => new Date() } = {}) {
    this.pool = pool;
    this.inspector = inspector;
    this.config = config;
    this.now = now;
    this.cache = new BoundedTtlCache({ ttlMs: config.cacheTtlSeconds * 1000, maxEntries: 60 });
    this.cacheSource = null;
  }

  async cached(key, fn) {
    key = `${this.config.retention.usageLogsDays}:${this.config.retention.usageDailyDays}:${key}`;
    const source = this.pool.pool || this.pool;
    if (source !== this.cacheSource) {
      this.cache.clear();
      this.cacheSource = source;
    }
    const existing = this.cache.get(key);
    if (existing !== undefined) return existing;
    const result = await fn();
    if (source === (this.pool.pool || this.pool)) this.cache.set(key, result);
    return result;
  }

  async schema() {
    const schema = await this.inspector.inspect();
    const has = (table, column) => schema.tables[table]?.columns.includes(column) || false;
    const required = {
      usage_logs: ['user_id', 'created_at', 'model', 'billing_type', 'actual_cost',
        'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens'],
      users: ['id', 'email', 'created_at', 'status', 'deleted_at']
    };
    const missing = Object.entries(required).flatMap(([table, columns]) =>
      columns.filter((column) => !has(table, column)).map((column) => `${table}.${column}`));
    if (missing.length) throw new AppError('SCHEMA_INCOMPATIBLE', `用户画像缺少字段：${missing.join(', ')}`, {
      status: 503, details: { missing }
    });
    const group = has('groups', 'id') && has('groups', 'platform') && has('usage_logs', 'group_id');
    const account = has('accounts', 'id') && has('accounts', 'platform') && has('usage_logs', 'account_id');
    const groupPlatform = group ? "NULLIF(LOWER(BTRIM(g.platform)), '')" : 'NULL::text';
    const accountPlatform = account ? "NULLIF(LOWER(BTRIM(a.platform)), '')" : 'NULL::text';
    const effectivePlatform = `CASE WHEN ${groupPlatform} = 'composite' THEN ${accountPlatform}
      ELSE COALESCE(${groupPlatform}, ${accountPlatform}) END`;
    return {
      has, group, account,
      joins: `${group ? 'LEFT JOIN groups g ON g.id = ul.group_id' : ''}
        ${account ? 'LEFT JOIN accounts a ON a.id = ul.account_id' : ''}`,
      platform: `COALESCE(NULLIF((${effectivePlatform}), 'composite'), '${UNKNOWN_PLATFORM}')`,
      model: has('usage_logs', 'requested_model')
        ? "COALESCE(NULLIF(ul.requested_model, ''), NULLIF(ul.model, ''), '(unknown)')"
        : "COALESCE(NULLIF(ul.model, ''), '(unknown)')",
      warnings: [
        ...(!group || !account ? ['部分平台关联表不可用，无法归属的用量保留为“未知平台”。'] : []),
        ...(!has('usage_logs', 'requested_model') ? ['历史 schema 未记录请求模型，模型名称使用日志 model 字段。'] : []),
        ...(!has('users', 'balance') ? ['当前 schema 无法读取用户余额，低余额关注与余额寿命暂不可用。'] : [])
      ]
    };
  }

  async snapshot(fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const value = await fn(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  metadata(query, schema, coverage) {
    return {
      range: query.range, timezone: this.config.sub2apiTimezone, generatedAt: query.asOf,
      filters: { platform: query.platform, billing: query.billing },
      coverage,
      recent: {
        start: addUtcDays(query.today, -6), end: query.today,
        previousStart: addUtcDays(query.today, -13), previousEnd: addUtcDays(query.today, -7),
        available: coverage.recent.status === 'matched',
        includesToday: true
      },
      warnings: schema.warnings,
      excludedUserId: '1', unit: '额度'
    };
  }

  async getOptions() {
    const query = parseQuery({}, this.config, this.now());
    return this.cached(`options:${query.today}`, async () => {
      const schema = await this.schema();
      const sources = ["SELECT '(unknown)'::text AS platform"];
      if (schema.group) sources.push("SELECT LOWER(BTRIM(platform)) AS platform FROM groups");
      if (schema.account) sources.push("SELECT LOWER(BTRIM(platform)) AS platform FROM accounts");
      const { rows } = await this.pool.query(`SELECT DISTINCT platform FROM (${sources.join(' UNION ALL ')}) p
        WHERE platform IS NOT NULL AND platform <> '' AND platform <> 'composite' ORDER BY platform`);
      return {
        timezone: this.config.sub2apiTimezone, today: query.today, earliest: query.earliest,
        maxDays: query.maxDays, defaultRange: query.range, platforms: rows.map((row) => row.platform)
      };
    });
  }

  async coverage(client, query, schema) {
    const daily = schema.has('usage_dashboard_daily', 'bucket_date') && schema.has('usage_dashboard_daily', 'total_requests');
    const watermark = schema.has('usage_dashboard_aggregation_watermark', 'last_aggregated_at');
    const recentStart = addUtcDays(query.today, -13);
    const tomorrow = addUtcDays(query.today, 1);
    const dailyEarliest = addUtcDays(query.today, 1 - this.config.retention.usageDailyDays);
    const values = [query.range.start, query.range.endExclusive, this.config.sub2apiTimezone,
      recentStart, tomorrow, query.asOf, dailyEarliest];
    const { rows } = await client.query(`
      WITH dates AS (
        SELECT generate_series($1::date, $2::date - 1, INTERVAL '1 day')::date AS date
        UNION SELECT generate_series($4::date, $5::date - 1, INTERVAL '1 day')::date
      ), detail AS (
        SELECT (created_at AT TIME ZONE $3)::date AS date, COUNT(*) AS requests
        FROM usage_logs
        WHERE ((created_at >= $1::date::timestamp AT TIME ZONE $3 AND created_at < $2::date::timestamp AT TIME ZONE $3)
           OR (created_at >= $4::date::timestamp AT TIME ZONE $3 AND created_at < $5::date::timestamp AT TIME ZONE $3))
          AND created_at <= $6::timestamptz
        GROUP BY 1
      )
      SELECT dates.date::text, COALESCE(detail.requests, 0)::float8 AS detail_requests,
        ${daily ? 'COALESCE(d.total_requests, 0)::float8' : 'NULL::float8'} AS aggregated_requests,
        CASE WHEN dates.date < $7::date THEN 'unverified' ELSE ${daily && watermark ? `CASE
          WHEN COALESCE(d.total_requests, 0) > COALESCE(detail.requests, 0) THEN 'partial'
          WHEN COALESCE(d.total_requests, 0) < COALESCE(detail.requests, 0)
            AND dates.date < ($6::timestamptz AT TIME ZONE $3)::date THEN 'unverified'
          WHEN dates.date < ($6::timestamptz AT TIME ZONE $3)::date AND
            (SELECT MAX(last_aggregated_at) FROM usage_dashboard_aggregation_watermark) <
              (dates.date + 1)::timestamp AT TIME ZONE $3 THEN 'unverified'
          WHEN (SELECT MAX(last_aggregated_at) FROM usage_dashboard_aggregation_watermark) IS NULL THEN 'unverified'
          ELSE 'matched' END` : "'unverified'::text"} END AS status
      FROM dates LEFT JOIN detail ON detail.date = dates.date
      ${daily ? 'LEFT JOIN usage_dashboard_daily d ON d.bucket_date = dates.date' : ''}
      ORDER BY dates.date
    `, values);
    const summarize = (from, through) => {
      const days = rows.filter((row) => row.date >= from && row.date <= through);
      const missingDays = days.filter((row) => row.status === 'partial').map((row) => row.date);
      const unverifiedDays = days.filter((row) => row.status === 'unverified').map((row) => row.date);
      return {
        status: missingDays.length ? 'partial' : unverifiedDays.length ? 'unverified' : 'matched',
        missingDays, unverifiedDays,
        detailRequests: days.reduce((sum, row) => sum + row.detail_requests, 0),
        aggregatedRequests: daily ? days.reduce((sum, row) => sum + row.aggregated_requests, 0) : null
      };
    };
    return { selected: summarize(query.range.start, query.range.end), recent: summarize(recentStart, query.today) };
  }

  ctes(query, schema, recentAvailable) {
    const values = [];
    const parameter = (value) => { values.push(value); return `$${values.length}`; };
    const start = parameter(query.range.start), end = parameter(query.range.endExclusive);
    const timezone = parameter(this.config.sub2apiTimezone), asOf = parameter(query.asOf);
    const recentStart = parameter(addUtcDays(query.today, -13));
    const currentStart = parameter(addUtcDays(query.today, -6)), tomorrow = parameter(addUtcDays(query.today, 1));
    const platform = parameter(query.platform === 'all' ? null : query.platform);
    const billing = parameter(query.billing === 'all' ? null : query.billing === 'balance' ? 0 : 1);
    const filter = `(${platform}::text IS NULL OR platform = ${platform}) AND
      (${billing}::smallint IS NULL OR billing_type = ${billing})`;
    const rawColumns = `ul.user_id, ul.created_at, (ul.created_at AT TIME ZONE ${timezone})::date AS date,
      ${schema.platform} AS platform, ${schema.model} AS model, ul.billing_type,
      ul.actual_cost AS cost, ul.input_tokens::bigint, ul.output_tokens::bigint,
      ul.cache_read_tokens::bigint, ul.cache_creation_tokens::bigint,
      (ul.input_tokens::bigint + ul.output_tokens::bigint + ul.cache_read_tokens::bigint + ul.cache_creation_tokens::bigint) AS tokens`;
    const sql = `WITH selected_logs AS MATERIALIZED (
        SELECT * FROM (SELECT ${rawColumns} FROM usage_logs ul ${schema.joins}
          WHERE ul.user_id <> 1 AND ul.created_at >= ${start}::date::timestamp AT TIME ZONE ${timezone}
            AND ul.created_at < ${end}::date::timestamp AT TIME ZONE ${timezone}
            AND ul.created_at <= ${asOf}::timestamptz) raw WHERE ${filter}
      ), user_totals AS (
        SELECT user_id, ${SUM_LOGS}, COUNT(DISTINCT date) AS active_days,
          MAX(created_at) AS last_used_in_range FROM selected_logs GROUP BY user_id
      ), user_platforms AS (
        SELECT user_id, platform, COUNT(*) AS requests, SUM(tokens) AS tokens, SUM(cost) AS cost
        FROM selected_logs GROUP BY user_id, platform
      ), user_models AS MATERIALIZED (
        SELECT user_id, platform, model, COUNT(*) AS requests, SUM(tokens) AS tokens, SUM(cost) AS cost
        FROM selected_logs GROUP BY user_id, platform, model
      ), platform_counts AS (
        SELECT user_id, COUNT(*) FILTER (WHERE platform <> '${UNKNOWN_PLATFORM}') AS platform_count
        FROM user_platforms GROUP BY user_id
      ), recent_logs AS MATERIALIZED (
        SELECT ${rawColumns} FROM usage_logs ul ${schema.joins}
        WHERE ul.user_id <> 1 AND ul.created_at >= ${recentStart}::date::timestamp AT TIME ZONE ${timezone}
          AND ul.created_at < ${tomorrow}::date::timestamp AT TIME ZONE ${timezone}
          AND ul.created_at <= ${asOf}::timestamptz
      ), recent_users AS (
        SELECT user_id,
          COUNT(*) FILTER (WHERE date >= ${currentStart}::date AND ${filter}) AS recent_requests,
          COUNT(*) FILTER (WHERE date < ${currentStart}::date AND ${filter}) AS previous_requests,
          COUNT(*) FILTER (WHERE ${filter}) AS relevant_requests,
          COALESCE(SUM(cost) FILTER (WHERE date >= ${currentStart}::date AND billing_type = 0), 0) / 7 AS daily_balance_cost
        FROM recent_logs GROUP BY user_id
      ), candidates AS (
        SELECT user_id FROM user_totals
        UNION SELECT user_id FROM recent_users WHERE relevant_requests > 0
      ), profiles AS (
        SELECT c.user_id::text AS id,
          COALESCE(NULLIF(${schema.has('users', 'username') ? 'u.username' : 'NULL::text'}, ''), NULLIF(u.email, ''), '用户 #' || c.user_id::text) AS name,
          COALESCE(u.email, '') AS email, u.status,
          (u.id IS NULL OR u.deleted_at IS NOT NULL) AS deleted,
          u.created_at AS registered_at,
          ${schema.has('users', 'balance') ? 'CASE WHEN u.deleted_at IS NULL THEN u.balance ELSE NULL END' : 'NULL::numeric'} AS balance,
          COALESCE(t.requests, 0) AS requests, COALESCE(t.tokens, 0) AS tokens, COALESCE(t.cost, 0) AS cost,
          COALESCE(t.input_tokens, 0) AS input_tokens, COALESCE(t.output_tokens, 0) AS output_tokens,
          COALESCE(t.cache_read_tokens, 0) AS cache_read_tokens, COALESCE(t.cache_creation_tokens, 0) AS cache_creation_tokens,
          COALESCE(t.active_days, 0) AS active_days, t.last_used_in_range,
          COALESCE(p.platform_count, 0) AS platform_count,
          COALESCE(r.recent_requests, 0) AS recent_requests, COALESCE(r.previous_requests, 0) AS previous_requests,
          ${recentAvailable ? 'r.daily_balance_cost' : 'NULL::numeric'} AS daily_balance_cost,
          ${recentAvailable ? '(COALESCE(r.previous_requests, 0) >= 100 AND r.recent_requests <= r.previous_requests * 0.5)' : 'NULL::boolean'} AS declining,
          ${recentAvailable && schema.has('users', 'balance') ? `CASE WHEN u.id IS NOT NULL AND u.deleted_at IS NULL AND r.daily_balance_cost > 0
            THEN GREATEST(u.balance, 0) / r.daily_balance_cost ELSE NULL END` : 'NULL::numeric'} AS runway_days
        FROM candidates c LEFT JOIN user_totals t ON t.user_id = c.user_id
        LEFT JOIN users u ON u.id = c.user_id LEFT JOIN recent_users r ON r.user_id = c.user_id
        LEFT JOIN platform_counts p ON p.user_id = c.user_id
      ), ranked_active AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY cost DESC, id::bigint) AS consumption_rank,
          COUNT(*) OVER () AS active_count FROM profiles WHERE requests > 0
      ), annotated AS (
        SELECT p.*, COALESCE(r.consumption_rank <= CEIL(r.active_count * 0.2) AND p.cost > 0, false) AS high_consumption,
          CASE WHEN p.runway_days IS NULL THEN NULL ELSE p.runway_days < 3 END AS low_balance,
          CASE WHEN totals.cost > 0 THEN p.cost / totals.cost ELSE NULL END AS consumption_share
        FROM profiles p LEFT JOIN ranked_active r ON r.id = p.id
        CROSS JOIN (SELECT COALESCE(SUM(cost), 0) AS cost FROM user_totals) totals
      )`;
    return { sql, values, parameter };
  }

  async getReport(input) {
    const query = parseQuery(input, this.config, this.now());
    const key = `report:${query.today}:${query.range.start}:${query.range.end}:${query.platform}:${query.billing}`;
    return this.cached(key, async () => {
      const schema = await this.schema();
      return this.snapshot(async (client) => {
        const coverage = await this.coverage(client, query, schema);
        const cte = this.ctes(query, schema, coverage.recent.status === 'matched');
        const models = METRICS.map((metric) => `'${metric}', (
          SELECT COALESCE(JSONB_AGG(TO_JSONB(m) ORDER BY m.position), '[]'::jsonb) FROM (
            SELECT model, platform, requests, tokens, cost, position FROM ranked_${metric} WHERE position <= 5
            UNION ALL SELECT '其他模型', '${MODEL_REMAINDER}', SUM(requests), SUM(tokens), SUM(cost), 6
              FROM ranked_${metric} WHERE position > 5 HAVING COUNT(*) > 0
          ) m)`).join(',');
        const { rows } = await client.query(`${cte.sql}, model_totals AS (
            SELECT model, platform, COUNT(*) AS requests, SUM(tokens) AS tokens, SUM(cost) AS cost
            FROM selected_logs GROUP BY model, platform
          ), ${METRICS.map((metric) => `ranked_${metric} AS (
            SELECT *, ROW_NUMBER() OVER (ORDER BY ${metric} DESC, model, platform) AS position FROM model_totals
          )`).join(',')}, concentration AS (
            SELECT CASE WHEN consumption_rank <= CEIL(active_count * 0.2) THEN 0
              WHEN consumption_rank <= CEIL(active_count * 0.5) THEN 1 ELSE 2 END AS band,
              COUNT(*) AS users, SUM(p.cost) AS cost
            FROM ranked_active r JOIN profiles p ON p.id = r.id GROUP BY 1
          )
          SELECT JSONB_BUILD_OBJECT(
            'summary', (SELECT JSONB_BUILD_OBJECT('users', COUNT(*), 'requests', COALESCE(SUM(requests), 0),
              'tokens', COALESCE(SUM(tokens), 0), 'cost', COALESCE(SUM(cost), 0),
              'average_cost', CASE WHEN COUNT(*) > 0 THEN SUM(cost) / COUNT(*) ELSE NULL END,
              'multi_users', COUNT(*) FILTER (WHERE platform_count >= 2),
              'multi_rate', CASE WHEN COUNT(*) > 0 THEN COUNT(*) FILTER (WHERE platform_count >= 2)::numeric / COUNT(*) ELSE NULL END)
              FROM profiles WHERE requests > 0),
            'platforms', (SELECT COALESCE(JSONB_AGG(TO_JSONB(p) ORDER BY p.requests DESC, p.platform), '[]'::jsonb)
              FROM (SELECT platform, SUM(requests) AS requests, SUM(tokens) AS tokens, SUM(cost) AS cost FROM user_platforms GROUP BY platform) p),
            'models', JSONB_BUILD_OBJECT(${models}),
            'concentration', (SELECT COALESCE(JSONB_AGG(TO_JSONB(c) ORDER BY band), '[]'::jsonb) FROM concentration c),
            'attention', (SELECT JSONB_BUILD_OBJECT(
              'declining', ${coverage.recent.status === 'matched' ? 'COUNT(*) FILTER (WHERE declining)' : 'NULL'},
              'low_balance', ${coverage.recent.status === 'matched' && schema.has('users', 'balance') ? 'COUNT(*) FILTER (WHERE low_balance AND NOT deleted)' : 'NULL'}) FROM annotated GROUP BY ())
          ) AS data
        `, cte.values);
        return { ...this.metadata(query, schema, coverage), ...rows[0].data };
      });
    });
  }

  listSql(cte, query) {
    const search = cte.parameter(query.search);
    const segment = {
      all: 'requests > 0', high: 'high_consumption AND requests > 0', multi: 'platform_count >= 2 AND requests > 0',
      decline: 'declining', balance: 'low_balance AND NOT deleted'
    }[query.segment];
    // strpos makes search literal, including user-supplied SQL wildcard characters.
    return `, filtered_users AS (
      SELECT * FROM annotated WHERE ${segment} AND (${search}::text = '' OR
        STRPOS(LOWER(name), LOWER(${search})) > 0 OR STRPOS(LOWER(email), LOWER(${search})) > 0 OR id = ${search})
    )`;
  }

  userRowsSql(cte, query, limit) {
    const sort = query.sort === 'days' ? 'active_days' : query.sort;
    const paging = limit ? `LIMIT ${cte.parameter(query.pageSize)} OFFSET ${cte.parameter((query.page - 1) * query.pageSize)}` : '';
    return `WITH page_users AS MATERIALIZED (
        SELECT * FROM filtered_users ORDER BY ${sort} DESC, id::bigint ${paging}
      ), page_platforms AS (
        SELECT p.user_id, JSONB_AGG(TO_JSONB(p) - 'user_id' ORDER BY p.${query.metric} DESC, p.platform) AS platforms
        FROM user_platforms p JOIN page_users f ON p.user_id = f.id::bigint GROUP BY p.user_id
      ), preferred_models AS (
        SELECT DISTINCT ON (l.user_id) l.user_id, JSONB_BUILD_OBJECT('model', l.model, 'platform', l.platform) AS preferred_model
        FROM user_models l JOIN page_users f ON l.user_id = f.id::bigint
        ORDER BY l.user_id, l.${query.metric} DESC, l.model, l.platform
      )
      SELECT f.*, COALESCE(p.platforms, '[]'::jsonb) AS platforms, m.preferred_model
      FROM page_users f LEFT JOIN page_platforms p ON p.user_id = f.id::bigint
      LEFT JOIN preferred_models m ON m.user_id = f.id::bigint ORDER BY f.${sort} DESC, f.id::bigint`;
  }

  async getUsers(input) {
    const query = parseQuery(input, this.config, this.now());
    return this.cached(`users:${query.today}:${JSON.stringify({ ...query, asOf: undefined })}`, async () => {
      const schema = await this.schema();
      return this.snapshot(async (client) => {
        const coverage = await this.coverage(client, query, schema);
        const cte = this.ctes(query, schema, coverage.recent.status === 'matched');
        const filtered = this.listSql(cte, query);
        const userRows = this.userRowsSql(cte, query, true);
        const { rows } = await client.query(`${cte.sql}${filtered}
          SELECT (SELECT COUNT(*)::integer FROM filtered_users) AS total,
            COALESCE((SELECT JSONB_AGG(TO_JSONB(u)) FROM (${userRows}) u), '[]'::jsonb) AS items,
            (SELECT COALESCE(SUM(cost), 0)::float8 FROM user_totals) AS total_consumption`, cte.values);
        const total = rows[0].total;
        return {
          ...this.metadata(query, schema, coverage), items: rows[0].items, totalConsumption: rows[0].total_consumption,
          pagination: { page: query.page, pageSize: query.pageSize, total, pages: Math.ceil(total / query.pageSize),
            hasNext: query.page * query.pageSize < total }
        };
      });
    });
  }

  async getUser(idInput, input) {
    const id = parseUserId(idInput);
    if (id === '1') throw new AppError('USER_PROFILE_NOT_FOUND', '该用户不在画像统计范围内', { status: 404 });
    const query = parseQuery(input, this.config, this.now());
    return this.cached(`detail:${id}:${query.today}:${query.range.start}:${query.range.end}:${query.platform}:${query.billing}`, async () => {
      const schema = await this.schema();
      return this.snapshot(async (client) => {
        const coverage = await this.coverage(client, query, schema);
        const cte = this.ctes(query, schema, coverage.recent.status === 'matched');
        const userId = cte.parameter(id);
        const modelLists = METRICS.map((metric) => `'${metric}', (
          SELECT COALESCE(JSONB_AGG(TO_JSONB(m) ORDER BY m.position), '[]'::jsonb) FROM (
            SELECT model, platform, requests, tokens, cost, position FROM detail_ranked_${metric} WHERE position <= 50
            UNION ALL SELECT '其他模型', '${MODEL_REMAINDER}', SUM(requests), SUM(tokens), SUM(cost), 51
              FROM detail_ranked_${metric} WHERE position > 50 HAVING COUNT(*) > 0
          ) m)`).join(',');
        const { rows } = await client.query(`${cte.sql}, detail_models AS (
            SELECT model, platform, requests, tokens, cost FROM user_models WHERE user_id = ${userId}::bigint
          ), ${METRICS.map((metric) => `detail_ranked_${metric} AS (
            SELECT *, ROW_NUMBER() OVER (ORDER BY ${metric} DESC, model, platform) AS position FROM detail_models
          )`).join(',')}
          SELECT TO_JSONB(p) AS user,
            COALESCE((SELECT JSONB_AGG(TO_JSONB(a) - 'user_id' ORDER BY a.requests DESC, a.platform)
              FROM user_platforms a WHERE a.user_id = ${userId}::bigint), '[]'::jsonb) AS platforms,
            JSONB_BUILD_OBJECT(${modelLists}) AS models,
            COALESCE((SELECT JSONB_AGG(TO_JSONB(d) ORDER BY d.date) FROM (
              SELECT date::text, ${SUM_LOGS} FROM selected_logs WHERE user_id = ${userId}::bigint GROUP BY date
            ) d), '[]'::jsonb) AS trend,
            (SELECT created_at FROM usage_logs WHERE user_id = ${userId}::bigint AND created_at <= $4::timestamptz
              ORDER BY created_at DESC LIMIT 1) AS last_used_at
          FROM annotated p WHERE p.id = ${userId}::text`, cte.values);
        if (!rows.length) throw new AppError('USER_PROFILE_NOT_FOUND', '该用户在所选范围与最近观察期没有用量明细', { status: 404 });
        return { ...this.metadata(query, schema, coverage), ...rows[0] };
      });
    });
  }

  async exportUsers(input) {
    const query = parseQuery(input, this.config, this.now());
    const schema = await this.schema();
    return this.snapshot(async (client) => {
      const coverage = await this.coverage(client, query, schema);
      const cte = this.ctes(query, schema, coverage.recent.status === 'matched');
      const filtered = this.listSql(cte, query);
      // Bound memory explicitly; an oversized export fails visibly instead of silently truncating.
      const count = await client.query(`${cte.sql}${filtered} SELECT COUNT(*)::integer AS total FROM filtered_users`, cte.values);
      if (count.rows[0].total > 50000) throw new AppError('EXPORT_TOO_LARGE', '单次导出最多 50,000 位用户，请缩小范围或筛选条件', { status: 400 });
      const userRows = this.userRowsSql(cte, query, false);
      const { rows } = await client.query(`${cte.sql}${filtered} SELECT TO_JSONB(u) AS data FROM (${userRows}) u`, cte.values);
      const header = ['用户 ID', '用户', '邮箱', '用户状态', '开始日期', '结束日期', '时区', '计费筛选', '平台筛选',
        '请求数', 'Token', '消费额度', '消费占比', '活跃天数', '平台构成', '主要模型', '高消费', '多平台',
        '活跃下降', '当前余额', '余额预计天数', '明细覆盖', '最近观察覆盖', '快照时间'];
      const body = rows.map(({ data: u }) => [u.id, u.name, u.email, u.deleted ? '已删除或缺失' : u.status,
        query.range.start, query.range.end, this.config.sub2apiTimezone, query.billing, query.platform,
        u.requests, u.tokens, u.cost, u.consumption_share, u.active_days,
        u.platforms.map((p) => `${p.platform}:${u[query.metric] > 0 ? (p[query.metric] / u[query.metric] * 100).toFixed(2) + '%' : '—'}`).join('; '),
        u.preferred_model?.model, u.high_consumption ? '是' : '否', u.platform_count >= 2 ? '是' : '否',
        u.declining == null ? '不可用' : u.declining ? '是' : '否', u.balance, u.runway_days,
        coverage.selected.status, coverage.recent.status, query.asOf]);
      return { filename: `user-profiles-${query.range.start}-${query.range.end}.csv`, csv: csvDocument([header, ...body]) };
    });
  }
}

module.exports = { UserProfilesService, parseQuery, parseUserId, csvCell, csvDocument, UNKNOWN_PLATFORM };
