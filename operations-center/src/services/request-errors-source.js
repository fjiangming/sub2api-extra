'use strict';

const { AppError } = require('../errors');
const { addUtcDays } = require('./metrics-service');
const { DateTime } = require('luxon');

const MAX_ROWS = 10000;
const FIELDS = ['id', 'request_id', 'client_request_id', 'user_id', 'api_key_id', 'group_id', 'account_id',
  'model', 'requested_model', 'upstream_model', 'stream', 'status_code', 'upstream_status_code',
  'error_type', 'error_phase', 'error_owner', 'error_source', 'provider_error_code', 'duration_ms', 'created_at'];

class RequestErrorsSource {
  constructor({ pool, inspector, telemetry }) { Object.assign(this, { pool, inspector, telemetry }); }

  async read(range, timezone) {
    const schema = await this.inspector.inspect();
    const has = (table, field) => schema.tables[table]?.columns?.includes(field);
    if (!['id', 'created_at'].every(field => has('ops_error_logs', field))) {
      throw new AppError('ERROR_LOGS_UNAVAILABLE', '主站错误日志表不可用，无法生成错误分析', { status: 503 });
    }
    const columns = FIELDS.map(field => has('ops_error_logs', field) ? `e.${field}${field.endsWith('_id') || field === 'id' ? '::text' : ''} AS ${field}` : `NULL AS ${field}`);
    // Response/error content stays in this process. Only bounded codes and booleans leave the classifier.
    columns.push(has('ops_error_logs', 'error_body') ? 'LEFT(e.error_body, 16384) AS error_body' : 'NULL AS error_body');
    columns.push(has('ops_error_logs', 'upstream_errors') ? `(SELECT jsonb_agg(jsonb_build_object(
      'account_id', a->>'account_id', 'at_unix_ms', a->>'at_unix_ms', 'kind', a->>'kind',
      'stage', a->>'stage', 'scope', a->>'scope', 'reason', a->>'reason',
      'upstream_status_code', a->>'upstream_status_code', 'attempt_id', a->>'attempt_id',
      'dropped_earlier_attempts', a->>'dropped_earlier_attempts'))
      FROM (SELECT value AS a FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.upstream_errors::jsonb) = 'array'
        THEN e.upstream_errors::jsonb ELSE '[]'::jsonb END) LIMIT 128) bounded) AS upstream_errors` : 'NULL AS upstream_errors');
    columns.push(has('ops_error_logs', 'upstream_errors') ? `CASE WHEN jsonb_typeof(e.upstream_errors::jsonb) = 'array'
      THEN jsonb_array_length(e.upstream_errors::jsonb) > 128 ELSE FALSE END AS upstream_errors_truncated` : 'FALSE AS upstream_errors_truncated');
    const joins = [];
    if (has('ops_error_logs', 'user_id') && has('users', 'username')) { joins.push('LEFT JOIN users u ON u.id = e.user_id'); columns.push('u.username AS user_name'); }
    if (has('ops_error_logs', 'group_id') && has('groups', 'name')) { joins.push('LEFT JOIN groups g ON g.id = e.group_id'); columns.push('g.name AS group_name'); }
    const select = `SELECT ${columns.join(', ')} FROM ops_error_logs e ${joins.join(' ')}`;
    let roots = { ids: [], truncated: false }, telemetryError = false, telemetryEnabled = false;
    try {
      telemetryEnabled = Boolean(this.telemetry?.status?.().enabled);
      roots = this.telemetry?.requestErrorRootIds?.(DateTime.fromISO(range.start, { zone: timezone }).toMillis(),
        DateTime.fromISO(range.endExclusive, { zone: timezone }).toMillis(), MAX_ROWS) || roots;
    } catch { telemetryError = true; }
    const client = await this.pool.connect();
    let rows, truncated = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      rows = (await client.query(`${select} WHERE e.created_at >= $1::date::timestamp AT TIME ZONE $3
        AND e.created_at < $2::date::timestamp AT TIME ZONE $3
        ORDER BY e.created_at DESC, e.id DESC LIMIT $4`, [addUtcDays(range.start, -1), range.endExclusive, timezone, MAX_ROWS + 1])).rows;
      truncated = rows.length > MAX_ROWS || roots.truncated; rows = rows.slice(0, MAX_ROWS);
      const ids = [...new Set([...roots.ids, ...rows.map(r => r.request_id).filter(Boolean)])];
      if (ids.length && has('ops_error_logs', 'request_id')) {
        const later = (await client.query(`${select} WHERE e.request_id = ANY($1::text[])
          AND e.created_at >= $2::date::timestamp AT TIME ZONE $3
          ORDER BY e.created_at, e.id LIMIT $4`, [ids, range.endExclusive, timezone, MAX_ROWS + 1])).rows;
        truncated ||= later.length > MAX_ROWS;
        rows.push(...later.slice(0, MAX_ROWS));
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
    const requestIds = [...new Set([...roots.ids, ...rows.map(r => r.request_id).filter(Boolean)])];
    let traces = [];
    try { traces = this.telemetry?.requestErrorTraces?.(requestIds) || []; }
    catch { telemetryError = true; }
    return { rows, traces, coverage: { truncated, maxRecords: MAX_ROWS,
      source: 'ops_error_logs + local_telemetry', telemetryEnabled, telemetryError,
      capabilities: { requestId: has('ops_error_logs', 'request_id'), userId: has('ops_error_logs', 'user_id'),
        apiKeyId: has('ops_error_logs', 'api_key_id'), upstreamAttempts: has('ops_error_logs', 'upstream_errors'),
        finalResponse: traces.some(t => t.events.some(e => e.name === 'request_end' && e.attributes?.resultVersion === 1)) },
      identity: 'direct_trace_and_user_api_key', historicalLogsRestored: false,
      warning: '仅分析已保留的错误记录；未采集的请求或已清理的日志不在范围内。' } };
  }
}

module.exports = { RequestErrorsSource, MAX_ROWS };
