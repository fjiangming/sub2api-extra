'use strict';

const { AppError } = require('./errors');

const PERIODS = ['today', 'week', 'month', 'all'];
const METRICS = ['tokens', 'requests'];
const tokenExpression = (alias) => `COALESCE(${alias}.input_tokens, 0)::bigint + COALESCE(${alias}.output_tokens, 0)::bigint + COALESCE(${alias}.cache_creation_tokens, 0)::bigint + COALESCE(${alias}.cache_read_tokens, 0)::bigint`;
const avatarExpression = (schema, alias) => schema.userAvatars
  ? `(SELECT a.url FROM public.user_avatars a WHERE a.user_id = ${alias}.id) AS avatar_url`
  : 'NULL::text AS avatar_url';

function validateSelection(period, metric) {
  if (!PERIODS.includes(period) || !METRICS.includes(metric)) throw new AppError('INVALID_REQUEST', '统计周期或排名依据无效', 400);
}

// Work in local calendar time before converting to instants; this also handles DST.
const WINDOW_SQL = `
  local_clock AS (
    SELECT $2::timestamptz AS finish, $2::timestamptz AT TIME ZONE $3 AS local_now
  ), local_window AS (
    SELECT *, CASE $1::text
      WHEN 'today' THEN date_trunc('day', local_now)
      WHEN 'week' THEN date_trunc('week', local_now)
      WHEN 'month' THEN date_trunc('month', local_now)
      ELSE NULL END AS local_start
    FROM local_clock
  ), previous_window AS (
    SELECT *, CASE $1::text
      WHEN 'today' THEN local_start - INTERVAL '1 day'
      WHEN 'week' THEN local_start - INTERVAL '1 week'
      WHEN 'month' THEN local_start - INTERVAL '1 month'
      ELSE NULL END AS local_previous_start
    FROM local_window
  ), win AS (
    SELECT finish, local_now,
           local_start AT TIME ZONE $3 AS start,
           local_previous_start AT TIME ZONE $3 AS previous_start,
           LEAST(local_previous_start + (local_now - local_start), local_start) AT TIME ZONE $3 AS previous_finish
    FROM previous_window
  )`;

function rankingCte(metric) {
  validateSelection('all', metric);
  return `WITH ${WINDOW_SQL},
    scope_users AS (
      SELECT id, email, ($4::boolean OR lower(role) NOT IN ('admin', 'root')) AS eligible
      FROM public.users WHERE deleted_at IS NULL AND status = 'active'
    ), totals AS (
      SELECT u.id, u.email, u.eligible,
        COALESCE(SUM(${tokenExpression('l')}) FILTER (WHERE w.start IS NULL OR l.created_at >= w.start), 0) AS tokens,
        COUNT(*) FILTER (WHERE w.start IS NULL OR l.created_at >= w.start) AS requests,
        COALESCE(SUM(${tokenExpression('l')}) FILTER (WHERE l.created_at >= w.previous_start AND l.created_at < w.previous_finish), 0) AS previous_tokens,
        COUNT(*) FILTER (WHERE l.created_at >= w.previous_start AND l.created_at < w.previous_finish) AS previous_requests
      FROM public.usage_logs l JOIN scope_users u ON u.id = l.user_id CROSS JOIN win w
      WHERE (w.start IS NULL OR l.created_at >= w.previous_start) AND l.created_at < w.finish
      GROUP BY u.id, u.email, u.eligible
    ), ranked AS (
      SELECT *, RANK() OVER (ORDER BY ${metric} DESC) AS rank
      FROM totals WHERE eligible AND requests > 0
    ), previous_ranked AS (
      SELECT id, RANK() OVER (ORDER BY previous_${metric} DESC) AS rank
      FROM totals WHERE eligible AND previous_requests > 0
    )`;
}

class UsageRepository {
  constructor(database, config) { this.database = database; this.config = config; }

  params(period, metric, anchor, userId) {
    validateSelection(period, metric);
    return [period, anchor, this.config.timezone, this.config.includeAdmins, ...(userId ? [userId] : [])];
  }

  async board(period, metric, anchor, range = null, schema = {}) {
    const { rows } = await this.database.query(`${rankingCte(metric)}
      SELECT
        COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.${metric} DESC, t.id::bigint) FROM (
          SELECT r.id::text, r.email, ${avatarExpression(schema, 'r')}, r.tokens, r.requests, r.rank,
                 p.rank AS previous_rank, r.previous_${metric} AS previous_value
          FROM ranked r LEFT JOIN previous_ranked p ON p.id = r.id
          ORDER BY r.${metric} DESC, r.id LIMIT 10
        ) t), '[]'::jsonb) AS entries,
        COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.${metric} DESC, t.id::bigint) FROM (
          SELECT r.id::text, r.email, ${avatarExpression(schema, 'r')}, r.tokens, r.requests, r.rank,
                 p.rank AS previous_rank, r.previous_${metric} AS previous_value
          FROM ranked r LEFT JOIN previous_ranked p ON p.id = r.id
          WHERE $5::bigint IS NOT NULL AND r.tokens >= $5::bigint
          ORDER BY r.${metric} DESC, r.id LIMIT 10
        ) t), '[]'::jsonb) AS qualified_entries,
        (SELECT jsonb_build_object('tokens', COALESCE(SUM(tokens), 0),
          'requests', COALESCE(SUM(requests), 0), 'active', COUNT(*)) FROM ranked) AS summary,
        (SELECT jsonb_build_object('tokens', COALESCE(SUM(previous_tokens), 0),
          'requests', COALESCE(SUM(previous_requests), 0), 'active', COUNT(*))
          FROM totals WHERE eligible AND previous_requests > 0) AS previous_summary,
        jsonb_build_object('start', w.start, 'end', w.finish,
          'previousStart', w.previous_start, 'previousEnd', w.previous_finish,
          'retainedFrom', (SELECT MIN(created_at) FROM public.usage_logs WHERE created_at < w.finish)) AS window
      FROM win w
    `, [...this.params(period, metric, anchor), range?.minimumTokens ?? null]);
    return rows[0];
  }

  async personal(period, metric, anchor, userId, schema = {}) {
    const { rows } = await this.database.query(`${rankingCte(metric)},
      mine AS (
        SELECT u.id::text, u.email, ${avatarExpression(schema, 'u')}, u.eligible, COALESCE(t.tokens, 0) AS tokens,
          COALESCE(t.requests, 0) AS requests,
          COALESCE(t.previous_${metric}, 0) AS previous_value
        FROM scope_users u LEFT JOIN totals t ON t.id = u.id WHERE u.id = $5::bigint
      )
      SELECT to_jsonb(m) AS me,
        (SELECT rank FROM ranked WHERE id = $5::bigint) AS rank,
        (SELECT rank FROM previous_ranked WHERE id = $5::bigint) AS previous_rank,
        (SELECT COUNT(*) FROM ranked WHERE ${metric} < m.${metric}) AS beaten,
        (SELECT jsonb_build_object('rank', n.rank, 'value', n.${metric}) FROM ranked n
          WHERE n.${metric} > m.${metric} ORDER BY n.${metric}, n.id LIMIT 1) AS next
      FROM mine m
    `, this.params(period, metric, anchor, userId));
    if (!rows[0]) throw new AppError('ACCOUNT_UNAVAILABLE', '当前账号不可用，请重新登录', 401);
    return rows[0];
  }

  async details(period, anchor, userId, { requestedModel }) {
    validateSelection(period, 'tokens');
    const model = requestedModel ? "COALESCE(NULLIF(l.requested_model, ''), NULLIF(l.model, ''), '未标注模型')" : "COALESCE(NULLIF(l.model, ''), '未标注模型')";
    const { rows } = await this.database.query(`WITH ${WINDOW_SQL},
      history AS (
        SELECT (l.created_at AT TIME ZONE $3)::date AS day, (${tokenExpression('l')}) AS tokens, l.created_at
        FROM public.usage_logs l CROSS JOIN win w
        WHERE l.user_id = $4::bigint
          AND l.created_at >= (date_trunc('day', w.local_now) - INTERVAL '13 days') AT TIME ZONE $3
          AND l.created_at < w.finish
      ), daily AS (
        SELECT day, SUM(tokens) AS tokens FROM history GROUP BY day
      ), dates AS (
        SELECT generate_series((SELECT date_trunc('day', local_now) - INTERVAL '6 days' FROM win),
          (SELECT date_trunc('day', local_now) FROM win), INTERVAL '1 day')::date AS day
      ), models AS (
        SELECT ${model} AS name, SUM(${tokenExpression('l')}) AS tokens, COUNT(*) AS requests
        FROM public.usage_logs l CROSS JOIN win w
        WHERE l.user_id = $4::bigint AND (w.start IS NULL OR l.created_at >= w.start) AND l.created_at < w.finish
        GROUP BY 1
      ), model_ranked AS (
        SELECT *, ROW_NUMBER() OVER (ORDER BY tokens DESC, requests DESC, name) AS position FROM models
      ), model_groups AS (
        SELECT CASE WHEN position <= 4 THEN name ELSE '其他' END AS name,
          MIN(position) AS position, SUM(tokens) AS tokens, SUM(requests) AS requests
        FROM model_ranked GROUP BY CASE WHEN position <= 4 THEN name ELSE '其他' END
      )
      SELECT (SELECT jsonb_agg(jsonb_build_object('date', d.day::text, 'tokens', COALESCE(v.tokens, 0)) ORDER BY d.day)
        FROM dates d LEFT JOIN daily v ON v.day = d.day) AS trend,
        (SELECT (date_trunc('day', local_now) - INTERVAL '13 days') AT TIME ZONE $3 FROM win) AS previous_trend_start,
        (SELECT COALESCE(SUM(h.tokens), 0) FROM history h CROSS JOIN win w
          WHERE h.created_at < (date_trunc('day', w.local_now) - INTERVAL '6 days') AT TIME ZONE $3
            AND h.created_at < (w.local_now - INTERVAL '7 days') AT TIME ZONE $3) AS previous_trend_tokens,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('name', name, 'tokens', tokens, 'requests', requests)
          ORDER BY position) FROM model_groups), '[]'::jsonb) AS models
    `, [period, anchor, this.config.timezone, userId]);
    return rows[0];
  }
}

module.exports = { UsageRepository, WINDOW_SQL, METRICS, PERIODS };
