'use strict';

const { AppError } = require('../errors');
const { requestIds, observedTokens } = require('./billing-recovery-usage');
const { matchBillingRows, reconcileBillingRows, MATCH_VERSION } = require('./billing-import-matcher');
const { buildLogCandidates, enrichErrorsFromLogs } = require('./billing-import-logs');

const MAX_SOURCE = 20000;
const millis = value => value == null ? null : new Date(value).getTime();
const json = value => { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; } };
const clean = value => String(value || '').trim();

function billingImportWindow(records, options) {
  const valid = records.filter(row => !row.error && !row.duplicateOf &&
    Object.hasOwn(options.accountMappings, row.key) && Number.isFinite(millis(row.time || row.startedAt)));
  if (!valid.length) return null;
  let first = Infinity, last = -Infinity, from = Infinity, to = -Infinity, unknownDurations = 0;
  for (const row of valid) {
    const at = millis(row.time || row.startedAt) + (row.time ? Number(options.clockOffsetSeconds || 0) * 1000 : 0);
    const duration = row.durationMs == null ? 4 * 3600000 : Number(row.durationMs);
    if (row.durationMs == null) unknownDurations++;
    first = Math.min(first, at); last = Math.max(last, at);
    // Read both timestamp conventions before calibration, including the full
    // duration of long requests. This range grants no ownership by itself.
    from = Math.min(from, at - duration); to = Math.max(to, at + duration);
  }
  if (last - first > 31 * 86400000 || to - from > 33 * 86400000) {
    throw new AppError('IMPORT_RANGE', '每批账单跨度最多 31 天，含请求耗时的证据时段最多 33 天，请拆分 CSV', { status: 400 });
  }
  const padding = Math.max(300000, options.toleranceSeconds * 1000);
  return { csvFrom: new Date(first).toISOString(), csvTo: new Date(last).toISOString(),
    from: new Date(from - padding).toISOString(), to: new Date(to + padding).toISOString(),
    timezone: options.timezone, clockOffsetSeconds: options.clockOffsetSeconds || 0, unknownDurations,
    rows: valid.length, accounts: [...new Set(valid.map(row => String(options.accountMappings[row.key])))] };
}

class BillingImportSource {
  constructor({ pool, inspector, recovery, logs }) { Object.assign(this, { pool, inspector, recovery, logs }); }
  async accounts() {
    const result = await this.pool.query('SELECT id::text,name,platform FROM accounts WHERE deleted_at IS NULL ORDER BY name,id LIMIT 2000');
    return result.rows;
  }
  async load(records, options, accessToken) {
    const window = billingImportWindow(records, options);
    if (!window) return { candidates: [], coreAvailable: true, diagnostics: { window: null } };
    const { from, to, accounts } = window;
    const schema = await this.inspector.inspect();
    const has = (table, column) => schema.tables[table]?.columns.includes(column);
    if (!has('usage_logs', 'id')) throw new AppError('SCHEMA_INCOMPATIBLE', '无法核对本地使用记录', { status: 503 });
    const col = (table, name, type = 'text') => has(table, name) ? `e.${name}` : `NULL::${type} AS ${name}`;
    const common = table => `e.id::text,e.user_id::text,e.api_key_id::text,e.account_id::text,e.group_id::text,
      e.created_at,e.model,${col(table, 'request_id')},${col(table, 'upstream_model')},${col(table, 'requested_model')},
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
    const billing = table => has(table, 'request_id') && has(table, 'api_key_id') && has('usage_logs', 'request_id')
      ? `EXISTS(SELECT 1 FROM ${table} d WHERE d.request_id=e.request_id AND d.api_key_id=e.api_key_id)` : 'NULL::boolean';
    const usages = (await this.pool.query(`SELECT ${common('usage_logs')},${col('usage_logs', 'upstream_request_id')},
      ${col('usage_logs', 'duration_ms', 'bigint')},${col('usage_logs', 'actual_cost', 'numeric')},
      ${billing('usage_billing_dedup')} AS billing_dedup,${billing('usage_billing_dedup_archive')} AS billing_archived,
      ${['input_tokens', 'output_tokens', 'cache_creation_tokens', 'cache_read_tokens', 'cache_creation_5m_tokens', 'cache_creation_1h_tokens'].map(name => col('usage_logs', name, 'integer')).join(',')}
      FROM usage_logs e LEFT JOIN users u ON u.id=e.user_id LEFT JOIN groups g ON g.id=e.group_id
      WHERE e.created_at >= $1 AND e.created_at < $2 AND e.account_id=ANY($3::bigint[])
      ORDER BY e.created_at,e.id LIMIT ${MAX_SOURCE + 1}`, [from, to, accounts])).rows;
    if (errors.length > MAX_SOURCE || usages.length > MAX_SOURCE) throw new AppError('SOURCE_TRUNCATED', '本地记录过多，请缩小 CSV 时间范围后导入', { status: 409 });
    const cases = [], claims = []; let coreAvailable = true, claimsAvailable = false;
    try {
      for (const account of accounts) {
        let expectedTotal = null;
        const seenIds = new Set();
        for (let page = 1; ; page++) {
          const result = await this.recovery.list({ state: '', account_id: account, from, to, page, page_size: 100 }, accessToken);
          if (!Array.isArray(result.items) || !Number.isSafeInteger(result.total) || result.total < 0 || page > MAX_SOURCE / 100 + 1) throw new AppError('SOURCE_INVALID', '核心异常列表响应无效，已停止匹配', { status: 502 });
          if (result.total > MAX_SOURCE || cases.length + result.items.length > MAX_SOURCE) throw new AppError('SOURCE_TRUNCATED', '异常记录过多，请缩小 CSV 时间范围', { status: 409 });
          if (expectedTotal != null && expectedTotal !== result.total || result.items.length !== Math.min(100, result.total - seenIds.size) ||
            result.items.some(item => !item?.id || seenIds.has(String(item.id))) || new Set(result.items.map(item => String(item.id))).size !== result.items.length) {
            throw new AppError('SOURCE_INVALID', '核心异常分页不完整或读取期间发生变化，请重新分析', { status: 502 });
          }
          expectedTotal = result.total;
          result.items.forEach(item => seenIds.add(String(item.id)));
          cases.push(...result.items);
          if (page * 100 >= result.total) break;
        }
      }
    } catch (error) {
      if ([404, 503].includes(error.status) || [404, 503].includes(error.details?.upstreamStatus) || error.code === 'BILLING_RECOVERY_DISABLED') coreAvailable = false;
      else throw error;
    }
    if (coreAvailable && typeof this.recovery.request === 'function') {
      try {
        for (const account of accounts) {
          const result = await this.recovery.request(`/imports/claims?${new URLSearchParams({ account_id: account, from, to })}`, {}, accessToken);
          if (!Array.isArray(result.claims) || result.claims.length > MAX_SOURCE || result.claims.some(claim =>
            String(claim.account_id) !== account || !/^[a-f0-9]{64}$/.test(claim.bill_identity) || !claim.local_reference || !claim.case_id)) {
            throw new AppError('SOURCE_INVALID', '核心补记认领列表无效，已停止匹配', { status: 502 });
          }
          claims.push(...result.claims);
        }
        claimsAvailable = true;
      } catch (error) {
        if (![404, 503].includes(error.status) && ![404, 503].includes(error.details?.upstreamStatus)) throw error;
        claims.length = 0;
      }
    }
    let logResult;
    try { logResult = this.logs ? await this.logs.load({ from, to, accounts }) : { events: [], diagnostics: { status: 'not_configured' } }; }
    catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('LOG_SOURCE_UNAVAILABLE', '无法读取配置的主站文件日志，请检查只读挂载与权限', { status: 503 });
    }
    const logs = buildLogCandidates(logResult.events, { from, to, accounts });
    if (logs.length) {
      const users = (await this.pool.query(`SELECT k.id::text,k.user_id::text,u.email FROM api_keys k
        JOIN users u ON u.id=k.user_id AND u.deleted_at IS NULL WHERE k.deleted_at IS NULL AND k.id=ANY($1::bigint[])`,
      [[...new Set(logs.map(item => item.apiKeyId))]])).rows;
      const groups = (await this.pool.query(`SELECT id::text,name,subscription_type FROM groups WHERE deleted_at IS NULL AND id=ANY($1::bigint[])`,
        [[...new Set(logs.map(item => item.groupId))]])).rows;
      const keys = new Map(users.map(item => [String(item.id), item])), groupMap = new Map(groups.map(item => [String(item.id), item]));
      for (const item of logs) {
        const key = keys.get(item.apiKeyId), group = groupMap.get(item.groupId);
        if (!key || String(key.user_id) !== item.userId || !group) item.blockedReason = '日志归属对应的用户、Key 或分组已删除或不一致';
        else Object.assign(item, { userEmail: key.email, groupName: group.name, billingType: group.subscription_type === 'subscription' ? 'subscription' : 'balance' });
      }
    }
    return { candidates: normalizeSources(enrichErrorsFromLogs(errors, logs), usages, cases, logs), claims, coreAvailable,
      diagnostics: { window, claimsAvailable, claims: claims.length, logs: logResult.diagnostics,
        native: { usages: usages.length, errors: errors.length, cases: cases.length } } };
  }
}

function normalizeSources(errors, usages, cases, logs = []) {
  const base = row => ({ userId: row.user_id == null ? null : String(row.user_id), apiKeyId: row.api_key_id == null ? null : String(row.api_key_id), accountId: String(row.account_id),
    groupId: row.group_id == null ? null : String(row.group_id), userEmail: row.user_email || '',
    groupName: row.group_name || '', billingType: row.subscription_type === 'subscription' ? 'subscription' : 'balance',
    models: [...new Set([row.model, row.upstream_model, row.requested_model].map(clean).filter(Boolean))], stream: row.stream === true,
    rootIds: [row.request_id, row.client_request_id].map(clean).filter(Boolean) });
  const result = cases.filter(row => !row.parent_case_id).map(row => {
    const snapshot = row.request_snapshot || {};
    const observed = observedTokens(row);
    const raw = row.observed_usage || {};
    const inclusiveInput = raw.prompt_tokens != null || raw.promptTokenCount != null ||
      raw._recovery?.protocol === 'responses' || raw.input_tokens_details != null;
    const inputKnown = !inclusiveInput || observed.cache_read_tokens != null && observed.cache_creation_tokens != null;
    return { ...base(row), reference: `case:${row.id}`, kind: 'case', caseId: row.id, version: row.version,
      state: row.state, recorded: Boolean(row.usage_record), billed: row.state === 'settled', userEmail: snapshot.user_email || '',
      billingType: row.subscription_id ? 'subscription' : 'balance', startMs: millis(row.created_at),
      endMs: millis(row.updated_at), startUncertain: false, ids: [...requestIds(row)],
      rootIds: [snapshot.request_id, snapshot.client_request_id].map(clean).filter(Boolean),
      serverIds: [snapshot.request_id].map(clean).filter(Boolean),
      usageEvidence: { complete: observed.complete, supported: observed.supported,
        invalid: row.observed_usage?._recovery?.invalid_usage === true,
        tokens: { InputTokens: inputKnown ? observed.input_tokens : null, OutputTokens: observed.output_tokens,
          CacheReadTokens: observed.cache_read_tokens, CacheCreationTokens: observed.cache_creation_tokens,
          CacheCreation5mTokens: observed.cache_creation_5m_tokens, CacheCreation1hTokens: observed.cache_creation_1h_tokens } },
      entry: row, tokens: row.usage_record || null, cost: row.usage_record?.ActualCost ?? null };
  });
  const scope = row => `${row.accountId}:${row.userId}:${row.apiKeyId}:${row.groupId}:`;
  const roots = new Map(), nativeUsage = new Map();
  const correlations = item => [...(item.serverIds || []).map(value => `server:${value}`), ...(item.ids || []).map(value => `upstream:${value}`)];
  const evidence = item => ({ reference: item.reference, kind: item.kind, ...(item.logSource ? { digest: item.logSource.digest } : {}) });
  const attach = (item, other) => {
    item.sourceEvidence ||= [evidence(item)];
    if (!item.sourceEvidence.some(source => source.reference === other.reference)) item.sourceEvidence.push(evidence(other));
  };
  const linked = item => [...new Set(correlations(item).flatMap(value => roots.get(scope(item) + value) || []))]
    .filter(other => other.models.some(model => item.models.includes(model)));
  const remember = item => {
    for (const value of new Set(correlations(item))) {
      const key = scope(item) + value;
      if (!roots.has(key)) roots.set(key, []);
      roots.get(key).push(item);
    }
  };
  for (const item of result) {
    remember(item);
    if (item.tokens?.RequestID) nativeUsage.set(scope(item) + item.tokens.RequestID, item);
  }
  for (const row of usages) {
    const endMs = millis(row.created_at), duration = row.duration_ms == null ? 4 * 3600000 : Number(row.duration_ms);
    const candidate = { ...base(row), reference: `usage:${row.id}`, usageId: String(row.id), kind: 'usage', state: 'settled', recorded: true,
      billed: row.billing_dedup === true || row.billing_archived === true,
      billingEvidence: { dedup: row.billing_dedup ?? null, archived: row.billing_archived ?? null }, nativeTiming: true,
      startMs: endMs - (Number.isFinite(duration) ? duration : 0), endMs,
      startUncertain: row.duration_ms == null, ids: [row.upstream_request_id, row.request_id].map(clean).filter(Boolean),
      tokens: { InputTokens: row.input_tokens, OutputTokens: row.output_tokens,
        CacheReadTokens: row.cache_read_tokens, CacheCreationTokens: row.cache_creation_tokens,
        CacheCreation5mTokens: row.cache_creation_5m_tokens, CacheCreation1hTokens: row.cache_creation_1h_tokens }, cost: row.actual_cost };
    candidate.rootIds.push(...candidate.rootIds.filter(value => value.startsWith('client:')).map(value => value.slice(7)));
    const existing = row.request_id && nativeUsage.get(scope(candidate) + row.request_id);
    if (existing) {
      Object.assign(existing, { usageId: candidate.usageId, nativeTiming: true, endMs,
        tokens: Object.fromEntries(Object.entries({ ...existing.tokens, ...candidate.tokens }).map(([key, value]) => [key, value ?? existing.tokens?.[key]])),
        cost: candidate.cost ?? existing.cost, billingEvidence: candidate.billingEvidence,
        billed: existing.billed || candidate.billed, models: [...new Set([...existing.models, ...candidate.models])],
        rootIds: [...new Set([...existing.rootIds, ...candidate.rootIds])], ids: [...new Set([...existing.ids, ...candidate.ids])] });
      attach(existing, candidate);
      remember(existing);
    } else { result.push(candidate); remember(candidate); }
  }
  for (const row of errors) {
    const attempts = json(row.upstream_errors);
    const events = Array.isArray(attempts) && attempts.some(item => item?.account_id)
      ? attempts.map((event, eventIndex) => ({ event, eventIndex })).filter(({ event }) => event?.account_id)
      : [{ event: { account_id: row.account_id }, eventIndex: -1 }];
    for (const { event, eventIndex } of events) {
      if (!event.account_id) continue;
      const endMs = millis(row.created_at), hint = row.log_start_ms;
      const candidate = { ...base(row), accountId: String(event.account_id), reference: `error:${row.id}:${eventIndex}`,
        kind: 'error', errorId: Number(row.id), eventIndex, state: 'legacy_error', recorded: false,
        startMs: hint ?? endMs - (row.response_latency_ms == null ? 4 * 3600000 : Number(row.response_latency_ms)), endMs,
        startUncertain: row.response_latency_ms == null && hint == null || events.length > 1,
        serverIds: [row.request_id].map(clean).filter(Boolean),
        ids: [event.upstream_request_id].map(clean).filter(Boolean), statusCode: event.upstream_status_code || row.status_code };
      if (!candidate.rootIds.length && !candidate.ids.length) candidate.blockedReason = '原生日志缺少关联 ID，无法排除重复计费';
      if (!candidate.groupId || !candidate.userId || !candidate.apiKeyId) candidate.blockedReason = '原生日志缺少完整用户 / Key / 分组归属';
      // The native error and the durable case describe the same inbound request.
      // Prefer dispatch intents and keep multiple dispatches as separate candidates.
      const repeatedAccount = events.filter(attempt => String(attempt.event.account_id) === candidate.accountId).length > 1;
      const native = linked(candidate).filter(item => ['case', 'usage'].includes(item.kind) &&
        (!repeatedAccount || candidate.ids.some(value => item.ids.includes(value))));
      if (native.length) { for (const item of native) attach(item, candidate); continue; }
      result.push(candidate); remember(candidate);
    }
  }
  for (const candidate of logs) {
    candidate.serverIds = [candidate.logSource?.request_id || candidate.rootIds?.[0]].filter(Boolean);
    const correlated = linked(candidate).filter(item => Math.abs(item.startMs - candidate.startMs) < 5000);
    if (correlated.length) { for (const item of correlated) attach(item, candidate); continue; }
    result.push(candidate);
  }
  return result;
}

module.exports = { BillingImportSource, billingImportWindow, normalizeSources, matchBillingRows, reconcileBillingRows, MATCH_VERSION };
