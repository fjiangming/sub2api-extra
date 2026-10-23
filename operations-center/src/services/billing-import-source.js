'use strict';

const { AppError } = require('../errors');
const { requestIds } = require('./billing-recovery-usage');

const MAX_SOURCE = 20000;
const millis = value => value == null ? null : new Date(value).getTime();
const json = value => { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; } };
const clean = value => String(value || '').trim();

class BillingImportSource {
  constructor({ pool, inspector, recovery }) { Object.assign(this, { pool, inspector, recovery }); }
  async accounts() {
    const result = await this.pool.query('SELECT id::text,name,platform FROM accounts WHERE deleted_at IS NULL ORDER BY name,id LIMIT 2000');
    return result.rows;
  }
  async load(records, options, accessToken) {
    const accounts = [...new Set(Object.values(options.accountMappings || {}).map(String))];
    const valid = records.filter(row => !row.error && row.startedAt);
    if (!accounts.length || !valid.length) return { candidates: [], coreAvailable: true };
    const times = valid.map(row => millis(row.startedAt));
    const from = new Date(Math.min(...times) - 300000).toISOString();
    const to = new Date(Math.max(...times) + 4 * 3600000).toISOString();
    if (Math.max(...times) - Math.min(...times) > 31 * 86400000) throw new AppError('IMPORT_RANGE', '每批账单的时间跨度不能超过 31 天', { status: 400 });
    const schema = await this.inspector.inspect();
    const has = (table, column) => schema.tables[table]?.columns.includes(column);
    if (!has('usage_logs', 'id')) throw new AppError('SCHEMA_INCOMPATIBLE', '无法核对本地使用记录', { status: 503 });
    const col = (table, name, type = 'text') => has(table, name) ? `e.${name}` : `NULL::${type} AS ${name}`;
    const common = table => `e.id::text,e.user_id::text,e.api_key_id::text,e.account_id::text,e.group_id::text,
      e.created_at,e.model,${col(table, 'request_id')},${col(table, 'upstream_model')},
      ${col(table, 'stream', 'boolean')},u.email AS user_email,g.name AS group_name,g.subscription_type`;
    const attempts = has('ops_error_logs', 'upstream_errors')
      ? "CASE WHEN jsonb_typeof(e.upstream_errors)='array' THEN e.upstream_errors ELSE '[]'::jsonb END" : "'[]'::jsonb";
    // Original events can contain response bodies and error details. Only
    // attribution and correlation metadata may cross into the import workflow.
    const safeAttempts = `(SELECT jsonb_agg(jsonb_build_object('account_id',x->'account_id',
      'upstream_request_id',x->'upstream_request_id','upstream_status_code',x->'upstream_status_code',
      'at_unix_ms',x->'at_unix_ms')) FROM jsonb_array_elements(${attempts}) x) AS upstream_errors`;
    const errors = has('ops_error_logs', 'id') ? (await this.pool.query(`SELECT ${common('ops_error_logs')},
      ${col('ops_error_logs', 'client_request_id')},${safeAttempts},
      ${col('ops_error_logs', 'response_latency_ms', 'bigint')},${col('ops_error_logs', 'status_code', 'integer')},
      ${col('ops_error_logs', 'request_path')}
      FROM ops_error_logs e LEFT JOIN users u ON u.id=e.user_id LEFT JOIN groups g ON g.id=e.group_id
      WHERE e.created_at >= $1 AND e.created_at < $2 AND e.user_id IS NOT NULL AND e.api_key_id IS NOT NULL
      AND (e.account_id=ANY($3::bigint[]) OR EXISTS(SELECT 1 FROM jsonb_array_elements(
        ${attempts}) x
        WHERE x->>'account_id'=ANY($3::text[]))) ORDER BY e.created_at,e.id LIMIT ${MAX_SOURCE + 1}`, [from, to, accounts])).rows : [];
    const usages = (await this.pool.query(`SELECT ${common('usage_logs')},${col('usage_logs', 'upstream_request_id')},
      ${col('usage_logs', 'duration_ms', 'bigint')},${col('usage_logs', 'actual_cost', 'numeric')},
      ${['input_tokens', 'output_tokens', 'cache_creation_tokens', 'cache_read_tokens'].map(name => col('usage_logs', name, 'integer')).join(',')}
      FROM usage_logs e LEFT JOIN users u ON u.id=e.user_id LEFT JOIN groups g ON g.id=e.group_id
      WHERE e.created_at >= $1 AND e.created_at < $2 AND e.account_id=ANY($3::bigint[])
      ORDER BY e.created_at,e.id LIMIT ${MAX_SOURCE + 1}`, [from, to, accounts])).rows;
    if (errors.length > MAX_SOURCE || usages.length > MAX_SOURCE) throw new AppError('SOURCE_TRUNCATED', '本地记录过多，请缩小 CSV 时间范围后导入', { status: 409 });
    const cases = []; let coreAvailable = true;
    try {
      for (const account of accounts) {
        for (let page = 1; ; page++) {
          const result = await this.recovery.list({ state: '', account_id: account, from, to, page, page_size: 100 }, accessToken);
          if (!Array.isArray(result.items) || !Number.isSafeInteger(result.total) || result.total < 0 || page > MAX_SOURCE / 100 + 1) throw new AppError('SOURCE_INVALID', '核心异常列表响应无效，已停止匹配', { status: 502 });
          if (result.total > MAX_SOURCE || cases.length + result.items.length > MAX_SOURCE) throw new AppError('SOURCE_TRUNCATED', '异常记录过多，请缩小 CSV 时间范围', { status: 409 });
          cases.push(...result.items);
          if (page * 100 >= result.total) break;
        }
      }
    } catch (error) {
      if ([404, 503].includes(error.status) || [404, 503].includes(error.details?.upstreamStatus) || error.code === 'BILLING_RECOVERY_DISABLED') coreAvailable = false;
      else throw error;
    }
    return { candidates: normalizeSources(errors, usages, cases), coreAvailable };
  }
}

function normalizeSources(errors, usages, cases) {
  const base = row => ({ userId: String(row.user_id), apiKeyId: String(row.api_key_id), accountId: String(row.account_id),
    groupId: row.group_id == null ? null : String(row.group_id), userEmail: row.user_email || '',
    groupName: row.group_name || '', billingType: row.subscription_type === 'subscription' ? 'subscription' : 'balance',
    models: [...new Set([row.model, row.upstream_model].map(clean).filter(Boolean))], stream: row.stream === true,
    rootIds: [row.request_id, row.client_request_id].map(clean).filter(Boolean) });
  const result = cases.filter(row => !row.parent_case_id).map(row => {
    const snapshot = row.request_snapshot || {};
    return { ...base(row), reference: `case:${row.id}`, kind: 'case', caseId: row.id, version: row.version,
      state: row.state, recorded: Boolean(row.usage_record), userEmail: snapshot.user_email || '',
      billingType: row.subscription_id ? 'subscription' : 'balance', startMs: millis(row.created_at),
      endMs: millis(row.updated_at), startUncertain: false, ids: [...requestIds(row)],
      rootIds: [snapshot.request_id, snapshot.client_request_id].map(clean).filter(Boolean),
      entry: row, tokens: row.usage_record || null, cost: row.usage_record?.ActualCost ?? null };
  });
  const scope = row => `${row.accountId}:${row.userId}:${row.apiKeyId}:`;
  const roots = new Map(), nativeUsage = new Set();
  for (const item of result) {
    for (const value of item.rootIds) {
      const key = scope(item) + value;
      if (!roots.has(key)) roots.set(key, []);
      roots.get(key).push(item);
    }
    if (item.tokens?.RequestID) nativeUsage.add(scope(item) + item.tokens.RequestID);
  }
  for (const row of usages) {
    if (row.request_id && nativeUsage.has(scope(base(row)) + row.request_id)) continue;
    const endMs = millis(row.created_at), duration = row.duration_ms == null ? 4 * 3600000 : Number(row.duration_ms);
    result.push({ ...base(row), reference: `usage:${row.id}`, kind: 'usage', state: 'settled', recorded: true,
      startMs: endMs - (Number.isFinite(duration) ? duration : 0), endMs,
      startUncertain: row.duration_ms == null, ids: [row.upstream_request_id, row.request_id].map(clean).filter(Boolean),
      tokens: { InputTokens: row.input_tokens, OutputTokens: row.output_tokens,
        CacheReadTokens: row.cache_read_tokens, CacheCreationTokens: row.cache_creation_tokens }, cost: row.actual_cost });
  }
  for (const row of errors) {
    const attempts = json(row.upstream_errors);
    const events = Array.isArray(attempts) && attempts.some(item => item?.account_id)
      ? attempts.map((event, eventIndex) => ({ event, eventIndex })).filter(({ event }) => event?.account_id)
      : [{ event: { account_id: row.account_id }, eventIndex: -1 }];
    for (const { event, eventIndex } of events) {
      if (!event.account_id) continue;
      const endMs = millis(row.created_at);
      const candidate = { ...base(row), accountId: String(event.account_id), reference: `error:${row.id}:${eventIndex}`,
        kind: 'error', errorId: Number(row.id), eventIndex, state: 'legacy_error', recorded: false,
        startMs: endMs - (row.response_latency_ms == null ? 4 * 3600000 : Number(row.response_latency_ms)), endMs,
        startUncertain: row.response_latency_ms == null || events.length > 1,
        ids: [event.upstream_request_id].map(clean).filter(Boolean), statusCode: event.upstream_status_code || row.status_code };
      if (!candidate.rootIds.length && !candidate.ids.length) candidate.blockedReason = '原生日志缺少关联 ID，无法排除重复计费';
      if (!candidate.groupId || !candidate.userId || !candidate.apiKeyId) candidate.blockedReason = '原生日志缺少完整用户 / Key / 分组归属';
      // The native error and the durable case describe the same inbound request.
      // Prefer dispatch intents and keep multiple dispatches as separate candidates.
      if (candidate.rootIds.some(value => (roots.get(scope(candidate) + value) || []).some(item =>
        Math.abs(item.startMs - candidate.startMs) < 4 * 3600000))) continue;
      result.push(candidate);
    }
  }
  return result;
}

function matchBillingRows(records, candidates, options) {
  const tolerance = options.toleranceSeconds * 1000;
  const index = new Map(), ids = new Map();
  for (const candidate of candidates) {
    for (const id of candidate.ids) {
      const key = `${candidate.accountId}:${id}`;
      if (!ids.has(key)) ids.set(key, []);
      ids.get(key).push(candidate);
    }
    for (const model of candidate.models) {
      const key = `${candidate.accountId}:${model.toLowerCase()}:${candidate.startUncertain ? 'uncertain' : 'precise'}`;
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(candidate);
    }
  }
  for (const group of index.values()) group.sort((a, b) => a.startMs - b.startMs);
  const matches = records.map(row => {
    if (row.error) return { status: 'invalid', reason: row.error, candidates: [] };
    if (row.duplicateOf) return { status: 'duplicate', reason: `与第 ${row.duplicateOf} 行重复`, candidates: [] };
    const account = Object.hasOwn(options.accountMappings, row.key) ? String(options.accountMappings[row.key]) : '';
    if (!account) return { status: 'unmapped', reason: '尚未指定该上游 Key 对应的账号', candidates: [] };
    const exact = row.requestId ? ids.get(`${account}:${row.requestId}`) || [] : [];
    const at = millis(row.startedAt);
    let pool = exact;
    if (!pool.length) {
      pool = [];
      for (const mode of ['precise', 'uncertain']) {
        const group = index.get(`${account}:${row.model.toLowerCase()}:${mode}`) || [];
        const earliest = at - (mode === 'precise' ? tolerance : 4 * 3600000);
        let low = 0, high = group.length;
        while (low < high) { const mid = (low + high) >>> 1; if (group[mid].startMs < earliest) low = mid + 1; else high = mid; }
        for (let i = low; i < group.length && group[i].startMs <= at + tolerance; i++) {
          const item = group[i];
          if (Math.abs(item.startMs - at) <= tolerance || item.startUncertain && at >= item.startMs - tolerance && at <= item.endMs + tolerance) pool.push(item);
          if (pool.length > 30) break;
        }
        if (pool.length > 30) break;
      }
    }
    // An exact ID must still have the same model. Caller-supplied native IDs are
    // presented as candidates, never as permission to charge automatically.
    pool = pool.filter(item => item.models.some(model => model.toLowerCase() === row.model.toLowerCase()));
    const selected = pool.length === 1 ? pool[0] : null;
    const usageDifference = selected?.recorded && selected.tokens && Object.entries(row.tokens).some(([key, value]) =>
      value != null && selected.tokens[key] != null && Number(selected.tokens[key]) !== value);
    return { status: !pool.length ? 'unmatched' : pool.length > 1 ? 'ambiguous' : selected.blockedReason ? 'needs_review' : selected.recorded ? usageDifference ? 'usage_difference' : 'already_recorded' : exact.length ? 'exact' : 'time_candidate',
      ...(selected?.blockedReason ? { reason: selected.blockedReason } : {}),
      ...(usageDifference ? { reason: '已有记录与 CSV 用量不同，请在异常请求中核对累计用量与差额' } : {}),
      method: exact.length ? 'request_id' : 'time', totalCandidates: pool.length,
      candidates: pool.slice(0, 30).map(item => ({ ...item, entry: undefined, tokens: undefined, rootIds: undefined, ids: undefined,
        timeDifferenceMs: at - item.startMs, models: item.models })),
      selected: selected && !selected.recorded && !selected.blockedReason ? selected.reference : null };
  });
  // A local attempt cannot be assigned independently to two supplier rows.
  const owners = new Map();
  matches.forEach((match, i) => { if (match.selected) { const list = owners.get(match.selected) || []; list.push(i); owners.set(match.selected, list); } });
  for (const list of owners.values()) if (list.length > 1) for (const i of list) {
    matches[i].status = 'assignment_conflict'; matches[i].selected = null;
    matches[i].reason = '多条上游记录匹配到同一本地请求，需要核查';
  }
  return matches;
}

module.exports = { BillingImportSource, normalizeSources, matchBillingRows };
