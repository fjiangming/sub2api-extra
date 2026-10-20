'use strict';

const { z } = require('zod');
const { AppError } = require('../errors');
const { BoundedTtlCache } = require('../cache');
const { parseDateRange, addUtcDays, dateInTimezone } = require('./metrics-service');

const pgId = z.string().regex(/^[1-9]\d{0,18}$/).refine((v) => BigInt(v) <= 9223372036854775807n);
const querySchema = z.object({
  start: z.string().optional(), end: z.string().optional(),
  accountId: pgId.optional(), userId: pgId.optional(),
  model: z.string().trim().max(120).default(''),
  requestId: z.string().trim().max(128).default(''),
  effort: z.enum(['all', 'low', 'medium', 'high', 'xhigh', 'max', 'unknown']).default('all'),
  kind: z.enum(['all', 'slow', 'error']).default('slow'),
  sort: z.enum(['time', 'ttft', 'duration']).default('time'),
  firstTokenSeconds: z.coerce.number().min(1).max(3600).default(60),
  highEffortSeconds: z.coerce.number().min(1).max(7200).default(180),
  durationSeconds: z.coerce.number().min(1).max(14400).default(300),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20)
});

function parseQuery(input, config, now) {
  const result = querySchema.safeParse(input || {});
  if (!result.success) throw new AppError('INVALID_REQUEST', '慢请求查询参数无效', { status: 400 });
  const today = dateInTimezone(config.sub2apiTimezone, now);
  const range = parseDateRange(result.data, { today, maxDays: 31, defaultDays: 1 });
  const earliest = addUtcDays(today, 1 - config.retention.usageLogsDays);
  if (range.start < earliest || range.end > today) {
    throw new AppError('DETAIL_RANGE_EXPIRED', `请求明细可查询 ${earliest} 至 ${today}`, { status: 400 });
  }
  return { ...result.data, range, today, earliest };
}

const numeric = (value) => value == null || !Number.isFinite(Number(value)) ? null : Number(value);
const positive = (value) => numeric(value) > 0 ? numeric(value) : null;
const stream = (row) => row.stream === true || row.stream === 1;
const models = (row) => [row.model, row.upstream_model].filter(Boolean).map((v) => v.toLowerCase());

function matchUpstream(base, candidates, { fingerprintUnique = true, observedRequestId = null } = {}) {
  const ids = [base.upstream_request_id, base.request_id, observedRequestId].filter(Boolean);
  const exact = candidates.filter((item) => item.request_id && ids.includes(item.request_id));
  if (exact.length > 1) return { status: 'ambiguous', method: 'request_id', candidates: exact, selected: null };
  if (exact.length === 1) return { status: 'matched', method: 'request_id', candidates: exact, selected: exact[0] };
  const fields = ['input_tokens', 'output_tokens', 'cache_creation_tokens', 'cache_read_tokens'];
  const complete = fields.every((key) => numeric(base[key]) != null) &&
    fields.reduce((sum, key) => sum + Number(base[key]), 0) > 0;
  const likely = complete ? candidates.filter((item) => fields.every((key) =>
    numeric(item[key]) != null && Number(item[key]) === Number(base[key])) &&
    stream(base) === stream(item) && models(base).some((name) => models(item).includes(name)) &&
    Math.abs(Date.parse(base.created_at) - Date.parse(item.created_at)) <= 15 * 60000) : [];
  return { status: likely.length === 1 && fingerprintUnique ? 'candidate' : likely.length ? 'ambiguous' : 'unmatched',
    method: likely.length ? 'fingerprint' : null, candidates: likely.slice(0, 20), selected: null };
}

function observedUpstreamRequest(base, traces) {
  if (base.source !== 'usage' || traces.length !== 1) return null;
  const attempts = new Map();
  for (const event of traces[0].events || []) {
    if (!event.attemptId) continue;
    const attempt = attempts.get(event.attemptId) || {};
    Object.assign(attempt, event.attributes);
    attempt.sequence = event.sequence;
    if (event.name === 'attempt_end') attempt.ended = true;
    attempts.set(event.attemptId, attempt);
  }
  const latest = [...attempts.entries()].sort((a, b) => b[1].sequence - a[1].sequence)[0];
  if (!latest) return null;
  const [attemptId, row] = latest;
  return row.accountId === base.account_id && row.ended && row.outcome === 'completed' &&
    row.statusCode >= 200 && row.statusCode < 300 && row.upstreamRequestId
    ? { attemptId, requestId: row.upstreamRequestId } : null;
}

function compareTimings(base, upstream) {
  if (!upstream) return null;
  const localTtft = stream(base) ? positive(base.first_token_ms) : null;
  const remoteTtft = stream(upstream) ? positive(upstream.first_token_ms) : null;
  const localDuration = numeric(base.duration_ms);
  const remoteDuration = numeric(upstream.duration_ms);
  const firstTokenDeltaMs = localTtft != null && remoteTtft != null ? localTtft - remoteTtft : null;
  const durationDeltaMs = localDuration != null && remoteDuration != null ? localDuration - remoteDuration : null;
  const comparable = firstTokenDeltaMs != null && durationDeltaMs != null;
  const similar = comparable && firstTokenDeltaMs > 5000 &&
    Math.abs(firstTokenDeltaMs - durationDeltaMs) <= Math.max(2000, Math.abs(firstTokenDeltaMs) * 0.1);
  return { firstTokenDeltaMs, durationDeltaMs,
    localAfterFirstTokenMs: localTtft != null && localDuration >= localTtft ? localDuration - localTtft : null,
    upstreamAfterFirstTokenMs: remoteTtft != null && remoteDuration >= remoteTtft ? remoteDuration - remoteTtft : null,
    observation: similar ? 'similar_waiting_gap' : comparable && (firstTokenDeltaMs < 0 || durationDeltaMs < 0)
      ? 'negative_difference' : 'timing_difference',
    semanticsVerified: false };
}

class LatencyService {
  constructor({ pool, inspector, config, providerMonitor, telemetry, now = () => new Date() }) {
    Object.assign(this, { pool, inspector, config, providerMonitor, telemetry, now });
    this.cache = new BoundedTtlCache({ ttlMs: 15000, maxEntries: 30 });
    this.cacheSource = null;
  }

  async source(record = null) {
    const schema = await this.inspector.inspect();
    const has = (table, column) => schema.tables[table]?.columns.includes(column) || false;
    const required = ['id', 'user_id', 'account_id', 'created_at', 'model', 'duration_ms', 'stream'];
    const missing = required.filter((column) => !has('usage_logs', column));
    if (missing.length) throw new AppError('SCHEMA_INCOMPATIBLE', `慢请求监测缺少 usage_logs 字段：${missing.join(', ')}`, { status: 503 });
    const col = (table, key, type = 'text') => has(table, key) ? key : `NULL::${type} AS ${key}`;
    const select = (table, source) => `SELECT '${source}'::text AS source, id::text AS source_id,
      user_id::text AS user_id, account_id::text AS account_id, created_at, model,
      ${col(table, 'request_id')}, ${col(table, 'upstream_request_id')}, ${col(table, 'upstream_model')},
      ${has(table, 'requested_model') ? "COALESCE(NULLIF(requested_model, ''), model)" : 'model'} AS requested_model,
      ${col(table, 'reasoning_effort')}, stream, duration_ms::float8,
      ${source === 'error' ? (has(table, 'time_to_first_token_ms') ? 'time_to_first_token_ms' : 'NULL::bigint') :
        (has(table, 'first_token_ms') ? 'first_token_ms' : 'NULL::integer')}::float8 AS first_token_ms,
      ${['input_tokens', 'output_tokens', 'cache_creation_tokens', 'cache_read_tokens'].map((key) => col(table, key, 'integer')).join(', ')},
      ${col(table, 'status_code', 'integer')}, ${col(table, 'error_type')}, ${col(table, 'error_phase')},
      ${col(table, 'request_body_bytes', 'integer')}
      FROM ${table} WHERE created_at >= $1::date::timestamp AT TIME ZONE $3
        AND created_at < $2::date::timestamp AT TIME ZONE $3 AND (user_id IS NULL OR user_id <> 1)
        ${record ? 'AND id = $4::bigint' : ''}`;
    const errors = ['id', 'user_id', 'account_id', 'created_at', 'model', 'duration_ms', 'stream']
      .every((column) => has('ops_error_logs', column));
    const sources = record ? record.source === 'usage' ? [select('usage_logs', 'usage')]
      : errors ? [select('ops_error_logs', 'error')] : []
      : [select('usage_logs', 'usage'), ...(errors ? [select('ops_error_logs', 'error')] : [])];
    return { sql: sources.join(' UNION ALL '),
      errors, has, warnings: [
        ...(!errors ? ['错误记录不可用，当前范围只包含用量记录。'] : []),
        ...(!has('usage_logs', 'first_token_ms') ? ['当前版本未记录首输出耗时。'] : []),
        '用量记录不等于完整请求或成功请求；错误记录可能包含重试，统计不代表请求成功率。',
        '仅统计保留明细，不还原已清理的记录；首输出为空的记录不参与首输出分位数。'
      ] };
  }

  filter(query) {
    const values = [query.range.start, query.range.endExclusive, this.config.sub2apiTimezone,
      query.firstTokenSeconds * 1000, query.highEffortSeconds * 1000, query.durationSeconds * 1000];
    const clauses = [];
    const add = (sql, value) => { values.push(value); clauses.push(sql.replace('?', `$${values.length}`)); };
    if (query.accountId) add('account_id = ?', query.accountId);
    if (query.userId) add('user_id = ?', query.userId);
    if (query.model) add('POSITION(LOWER(?) IN LOWER(requested_model)) > 0', query.model);
    if (query.requestId) {
      values.push(query.requestId);
      clauses.push(`(request_id = $${values.length} OR upstream_request_id = $${values.length})`);
    }
    if (query.effort !== 'all') add("COALESCE(NULLIF(reasoning_effort, ''), 'unknown') = ?", query.effort);
    const slow = `COALESCE((stream AND first_token_ms > 0 AND first_token_ms >=
      CASE WHEN reasoning_effort IN ('high','xhigh','max') THEN $5::float8 ELSE $4::float8 END)
      OR duration_ms >= $6::float8, false)`;
    return { values, where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', slow,
      selected: query.kind === 'slow' ? 'WHERE is_slow' : query.kind === 'error' ? "WHERE source = 'error'" : '' };
  }

  async options() {
    const query = parseQuery({}, this.config, this.now());
    return { today: query.today, earliest: query.earliest, timezone: this.config.sub2apiTimezone,
      defaultRange: query.range, upstreamConfigured: Boolean(this.providerMonitor?.configured()),
      telemetry: this.telemetry?.status() || { enabled: false } };
  }

  async report(input) {
    const query = parseQuery(input, this.config, this.now());
    const poolSource = this.pool.pool || this.pool;
    if (poolSource !== this.cacheSource) { this.cache.clear(); this.cacheSource = poolSource; }
    const key = JSON.stringify(query);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const source = await this.source();
    const filter = this.filter(query);
    const cte = `WITH records AS (${source.sql}), filtered AS (SELECT *, (${filter.slow}) AS is_slow
      FROM records ${filter.where}), selected AS (SELECT * FROM filtered ${filter.selected})`;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const summary = (await client.query(`${cte} SELECT COUNT(*)::integer AS records,
        COUNT(*) FILTER (WHERE is_slow)::integer AS slow_records,
        COUNT(*) FILTER (WHERE source = 'error')::integer AS error_records,
        COUNT(*) FILTER (WHERE stream AND first_token_ms > 0)::integer AS ttft_samples,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY first_token_ms) FILTER (WHERE stream AND first_token_ms > 0) AS ttft_p50_ms,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY first_token_ms) FILTER (WHERE stream AND first_token_ms > 0) AS ttft_p95_ms,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE duration_ms >= 0) AS duration_p95_ms
        FROM filtered`, filter.values)).rows[0];
      const total = (await client.query(`${cte} SELECT COUNT(*)::integer AS total FROM selected`, filter.values)).rows[0].total;
      const order = { time: 'created_at', ttft: 'CASE WHEN stream AND first_token_ms > 0 THEN first_token_ms END', duration: 'duration_ms' }[query.sort];
      const pageValues = [...filter.values, query.pageSize, (query.page - 1) * query.pageSize];
      const items = (await client.query(`${cte} SELECT * FROM selected ORDER BY ${order} DESC NULLS LAST, source, source_id DESC
        LIMIT $${pageValues.length - 1} OFFSET $${pageValues.length}`, pageValues)).rows;
      const grouped = (await client.query(`${cte} SELECT account_id, requested_model, reasoning_effort,
        COUNT(*)::integer AS records, COUNT(*) FILTER (WHERE is_slow)::integer AS slow_records,
        COUNT(*) FILTER (WHERE stream AND first_token_ms > 0)::integer AS ttft_samples,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY first_token_ms) FILTER (WHERE stream AND first_token_ms > 0) AS ttft_p95_ms
        FROM filtered GROUP BY account_id, requested_model, reasoning_effort
        ORDER BY slow_records DESC, records DESC LIMIT 30`, filter.values)).rows;
      const trend = (await client.query(`${cte} SELECT (created_at AT TIME ZONE $3)::date::text AS date,
        COUNT(*)::integer AS records, COUNT(*) FILTER (WHERE is_slow)::integer AS slow_records,
        COUNT(*) FILTER (WHERE source = 'error')::integer AS error_records FROM filtered GROUP BY 1 ORDER BY 1`, filter.values)).rows;
      await client.query('COMMIT');
      const result = { query, timezone: this.config.sub2apiTimezone, generatedAt: this.now().toISOString(),
        summary, items, groups: grouped, trend, pagination: { total, page: query.page, pageSize: query.pageSize,
          hasNext: query.page * query.pageSize < total }, warnings: source.warnings, excludedUserId: '1' };
      if (poolSource === (this.pool.pool || this.pool)) this.cache.set(key, result);
      return result;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async detail(id, accessToken) {
    const match = /^(usage|error):([1-9]\d{0,18})$/.exec(String(id));
    if (!match || BigInt(match[2]) > 9223372036854775807n) throw new AppError('INVALID_REQUEST', '请求记录 ID 无效', { status: 400 });
    const query = parseQuery({}, this.config, this.now());
    const source = await this.source({ source: match[1] });
    if (!source.sql) throw new AppError('REQUEST_NOT_FOUND', '错误记录不可用', { status: 404 });
    const rows = await this.pool.query(`WITH records AS (${source.sql}) SELECT * FROM records LIMIT 1`,
    [query.earliest, addUtcDays(query.today, 1), this.config.sub2apiTimezone, match[2]]);
    const base = rows.rows[0];
    if (!base) throw new AppError('REQUEST_NOT_FOUND', '请求记录不存在或已超过保留期', { status: 404 });
    const traces = this.telemetry?.find([base.request_id, base.upstream_request_id].filter(Boolean)) || [];
    const result = { base, traces, upstream: null, comparison: null, upstreamError: null,
      warnings: ['两端首输出口径与计时起点尚需核实；耗时差不直接表示网络延迟。'] };
    if (!base.account_id) { result.upstreamError = { code: 'ACCOUNT_MISSING', message: '记录没有上游账号，无法限定供应商查询范围' }; return result; }
    try {
      const at = Date.parse(base.created_at);
      const duration = Math.min(Math.max(Number(base.duration_ms) || 0, 0), 23 * 3600000);
      const start = traces.length === 1 ? Date.parse(traces[0].startedAt) : NaN;
      const from = Number.isFinite(start) ? Math.min(at, start) - 15 * 60000 : at - duration - 15 * 60000;
      const to = Number.isFinite(start) ? Math.max(at, start + duration) + 15 * 60000 : at + duration + 15 * 60000;
      const payload = await this.providerMonitor.getLatencySamples({ accountId: base.account_id,
        from: new Date(from).toISOString(), to: new Date(Math.min(to, from + 48 * 3600000)).toISOString(), limit: '2000' }, accessToken);
      let fingerprintUnique = false;
      if (base.source === 'usage') {
        const fields = ['input_tokens', 'output_tokens', 'cache_creation_tokens', 'cache_read_tokens'];
        if (fields.every((field) => source.has('usage_logs', field) && base[field] != null)) {
          const count = await this.pool.query(`SELECT COUNT(*)::integer AS count FROM usage_logs
            WHERE account_id = $1 AND created_at >= $2::timestamptz AND created_at < $3::timestamptz
            AND stream = $4 AND model = $5 AND ${fields.map((field, i) => `${field} = $${i + 6}`).join(' AND ')}`,
          [base.account_id, new Date(at - 15 * 60000).toISOString(), new Date(at + 15 * 60000).toISOString(),
            base.stream, base.model, ...fields.map((field) => base[field])]);
          fingerprintUnique = count.rows[0].count === 1;
        }
      }
      const observed = observedUpstreamRequest(base, traces);
      const pairing = matchUpstream(base, payload.items || [], { fingerprintUnique, observedRequestId: observed?.requestId });
      // An incomplete query cannot prove that an ID or a fingerprint is unique.
      if (payload.truncated && pairing.status === 'matched') {
        pairing.status = 'candidate'; pairing.selected = null;
      }
      result.upstream = { ...pairing, observedAttempt: observed, mappings: payload.mappings,
        truncated: payload.truncated, generatedAt: payload.generatedAt };
      result.comparison = compareTimings(base, pairing.selected);
    } catch (error) {
      result.upstreamError = { code: error.code || 'UPSTREAM_UNAVAILABLE', message: error.message || '上游日志暂不可用' };
    }
    return result;
  }
}

module.exports = { LatencyService, parseQuery, matchUpstream, compareTimings, observedUpstreamRequest };
