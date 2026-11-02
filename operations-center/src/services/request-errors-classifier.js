'use strict';

const { dateInTimezone } = require('./metrics-service');

const FAILURE_TYPES = {
  provider_balance: '供应商余额不足', provider_auth: '上游 Key 无效 / 无权限', rate_limit: '上游限流',
  upstream_5xx: '上游服务故障', no_account: '无可用账号 / 切换失败', connect_timeout: '连接 / 首响应超时',
  request_rejected: '本站参数 / 权限 / 限额拒绝', stream_error: '流内错误事件', stream_timeout: '输出中途超时',
  stream_truncated: '响应提前结束 / 缺正常结束', gateway_error: '网关处理 / 响应转换异常',
  unclassified: '已确认失败 · 原因未明'
};
const CAUSES = { reject: '上游拒绝', upstream: '上游服务异常', interrupted: '中途响应失败',
  network: '连接 / 超时', local: '本站校验 / 路由', other: '其他 / 原因未知' };
const OUTCOMES = { recovered: '重试恢复', http: 'HTTP 失败', stream: '流式失败',
  disconnected: '客户端断开', unknown: '待判定' };
const token = value => /^[a-zA-Z0-9_.:@/-]{1,128}$/.test(String(value || '')) ? String(value) : null;
const pgId = value => /^[1-9]\d{0,18}$/.test(String(value || '')) && BigInt(value) <= 9223372036854775807n ? String(value) : null;
const code = value => /^[a-zA-Z0-9_.-]{1,80}$/.test(String(value || '')) ? String(value).toLowerCase() : null;
const timestamp = value => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const failed = r => r.outcome === 'http' || r.outcome === 'stream';

function safeBodyCode(body) {
  if (typeof body !== 'string' || body.length > 16384) return {};
  try {
    const parsed = JSON.parse(body);
    const error = parsed?.error || (parsed?.type === 'error' ? parsed : null);
    return error && typeof error === 'object' ? { bodyError: true, errorCode: code(error.code || error.type) } : {};
  } catch { return {}; }
}

function errorMetadata(row) {
  const body = safeBodyCode(row.error_body);
  let upstream = row.upstream_errors;
  if (typeof upstream === 'string') { try { upstream = JSON.parse(upstream); } catch { upstream = []; } }
  const attempts = (Array.isArray(upstream) ? upstream : []).slice(0, 128).map((a, i) => ({
    id: token(a.attempt_id), sequence: i, accountId: pgId(a.account_id),
    status: Number.isInteger(Number(a.upstream_status_code)) && Number(a.upstream_status_code) >= 100 ? Number(a.upstream_status_code) : null,
    kind: code(a.kind), stage: code(a.stage), errorCode: code(a.reason),
    at: Number(a.at_unix_ms) > 0 && Number(a.at_unix_ms) < 8640000000000000 ? new Date(Number(a.at_unix_ms)).toISOString() : null,
    failed: true, evidence: 'ops_error_logs.upstream_errors', dropped: Number(a.dropped_earlier_attempts) > 0
  }));
  return {
    sourceId: pgId(row.id), requestId: token(row.request_id), clientId: token(row.client_request_id),
    userId: pgId(row.user_id), userName: String(row.user_name || '').slice(0, 120),
    userKeyId: pgId(row.api_key_id), groupId: pgId(row.group_id), groupName: String(row.group_name || '').slice(0, 120),
    accountId: pgId(row.account_id), model: String(row.requested_model || row.model || '').slice(0, 120),
    upstreamModel: String(row.upstream_model || '').slice(0, 120), at: timestamp(row.created_at),
    stream: row.stream === true, semanticStatus: Number(row.status_code) || null,
    upstreamStatus: Number(row.upstream_status_code) || null, errorCode: body.errorCode || code(row.provider_error_code) || code(row.error_type),
    phase: code(row.error_phase), owner: code(row.error_owner), source: code(row.error_source), attempts,
    bodyError: Boolean(body.bodyError), attemptsDropped: Boolean(row.upstream_errors_truncated), durationMs: row.duration_ms == null ? null : Number(row.duration_ms)
  };
}

function failureType({ errorCode, phase, owner, upstreamStatus, outputState, delivery, status }) {
  if (['no_available_accounts', 'no_available_account', 'account_switch_failed', 'routing_exhausted'].includes(errorCode)) return 'no_account';
  if (owner === 'client' || ['request', 'auth', 'concurrency', 'billing'].includes(phase)) return 'request_rejected';
  if (['insufficient_balance', 'insufficient_account_balance', 'insufficient_quota', 'balance_not_enough'].includes(errorCode) && owner === 'provider') return 'provider_balance';
  if (['invalid_api_key', 'authentication_error', 'permission_denied', 'upstream_auth_error', 'key_expired'].includes(errorCode) && owner === 'provider') return 'provider_auth';
  if (['stream_timeout', 'stream_idle_timeout', 'output_timeout'].includes(errorCode) && outputState === 'partial') return 'stream_timeout';
  if (['connect_timeout', 'connection_timeout', 'tls_timeout', 'first_response_timeout', 'upstream_timeout'].includes(errorCode) && outputState !== 'partial') return 'connect_timeout';
  if (['stream_truncated', 'missing_terminal', 'unexpected_eof', 'incomplete_response'].includes(errorCode) || delivery === 'incomplete_close') return 'stream_truncated';
  if (['response_conversion_error', 'gateway_error', 'internal_processing_error', 'panic'].includes(errorCode)) return 'gateway_error';
  if (owner === 'provider' && (upstreamStatus === 429 || ['rate_limit_exceeded', 'rate_limit_error'].includes(errorCode))) return 'rate_limit';
  if (owner === 'provider' && upstreamStatus >= 500) return 'upstream_5xx';
  if (['sse_error', 'response_failed'].includes(delivery)) return 'stream_error';
  if (['routing', 'internal', 'account_auth'].includes(phase) && status >= 500) return 'gateway_error';
  return 'unclassified';
}

function causeOf(type, last) {
  if (['provider_balance', 'provider_auth', 'rate_limit'].includes(type)) return 'reject';
  if (type === 'upstream_5xx') return 'upstream';
  if (['connect_timeout', 'stream_timeout'].includes(type)) return 'network';
  if (['stream_truncated', 'stream_error'].includes(type)) return 'interrupted';
  if (['no_account', 'request_rejected', 'gateway_error'].includes(type)) return 'local';
  if (['network'].includes(last.phase)) return 'network';
  if (last.owner === 'provider') return last.upstreamStatus >= 500 ? 'upstream' : 'reject';
  return 'other';
}

// Only direct telemetry roots establish a request identity. Client/upstream aliases never merge rows.
function classifyRequests(rawRows, traces, timezone) {
  const rows = rawRows.map(errorMetadata).filter(r => r.at && r.sourceId);
  const byId = new Map();
  for (const trace of traces || []) {
    if (token(trace.requestId)) byId.set(trace.requestId, [...(byId.get(trace.requestId) || []), trace]);
  }
  const grouped = new Map();
  for (const row of rows) {
    const candidates = byId.get(row.requestId) || [];
    const trace = candidates.length === 1 ? candidates[0] : null;
    const metadata = trace?.metadata || {};
    const start = Date.parse(trace?.startedAt);
    const end = (trace?.events || []).find(e => e.name === 'request_end');
    const finish = Number.isFinite(Number(end?.elapsedMs)) ? start + Number(end.elapsedMs) : Date.parse(trace?.updatedAt);
    const withinTrace = Number.isFinite(start) && Date.parse(row.at) >= start - 1000 &&
      Date.parse(row.at) <= (Number.isFinite(finish) ? finish : start + 86400000) + 300000;
    const identityMatches = trace && withinTrace && row.userId && pgId(metadata.userId) === row.userId &&
      (!metadata.apiKeyId || pgId(metadata.apiKeyId) === row.userKeyId);
    const key = identityMatches ? `trace:${trace.requestId}` : `error:${row.sourceId}`;
    if (!grouped.has(key)) grouped.set(key, { rows: [], trace: identityMatches ? trace : null });
    grouped.get(key).rows.push(row);
  }
  const loggedRoots = new Set(rows.map(r => r.requestId));
  for (const trace of traces || []) {
    if (!token(trace.requestId) || loggedRoots.has(trace.requestId) || (byId.get(trace.requestId) || []).length !== 1) continue;
    const end = trace.events?.find(e => e.name === 'request_end'), result = end?.attributes || {};
    const anomalous = result.resultVersion === 1 && (result.errorWritten || result.deliveryKind === 'incomplete_close' || result.clientDisconnected) ||
      trace.events?.some(e => e.name === 'attempt_end' && e.attributes?.outcome === 'error' || e.name === 'response_headers' && e.attributes?.statusCode >= 400);
    const at = timestamp(trace.startedAt);
    if (!anomalous || !at) continue;
    const metadata = trace.metadata || {};
    const record = errorMetadata({ created_at: at, request_id: trace.requestId, user_id: metadata.userId,
      api_key_id: metadata.apiKeyId, group_id: metadata.groupId, model: metadata.model,
      stream: ['sse_error', 'response_failed', 'incomplete_close'].includes(result.deliveryKind) });
    grouped.set(`trace:${trace.requestId}`, { trace, rows: [record] });
  }
  return [...grouped.entries()].map(([id, group]) => {
    const records = group.rows.sort((a, b) => a.at.localeCompare(b.at) || a.sourceId.localeCompare(b.sourceId));
    const last = records.at(-1), first = records[0], trace = group.trace;
    const events = (trace?.events || []).slice().sort((a, b) => a.sequence - b.sequence);
    const ends = events.filter(e => e.name === 'request_end');
    const end = ends.length === 1 ? ends[0] : null, result = end?.attributes || {};
    const proof = result.resultVersion === 1;
    const dropped = Boolean(trace?.droppedEvents) || records.some(r => r.attemptsDropped || r.attempts.some(a => a.dropped));
    const conflict = records.some(r => r.groupId !== first.groupId || r.userId !== first.userId || r.userKeyId !== first.userKeyId) || ends.length > 1 ||
      events.some(e => e.attributes?.userId && pgId(e.attributes.userId) !== first.userId ||
        e.attributes?.apiKeyId && pgId(e.attributes.apiKeyId) !== first.userKeyId ||
        e.attributes?.groupId && pgId(e.attributes.groupId) !== first.groupId);
    const started = timestamp(trace?.startedAt), at = started || first.at;
    const attempts = new Map();
    for (const e of events) {
      if (!token(e.attemptId)) continue;
      const a = attempts.get(e.attemptId) || { id: e.attemptId, sequence: e.sequence, accountId: null, status: null, failed: false, evidence: 'telemetry',
        at: timestamp(e.at) || (started && Number.isFinite(e.elapsedMs) ? new Date(Date.parse(started) + e.elapsedMs).toISOString() : null) };
      if (pgId(e.attributes?.accountId)) a.accountId = pgId(e.attributes.accountId);
      if (e.name === 'response_headers' && e.attributes?.statusCode) a.status = e.attributes.statusCode;
      if (e.name === 'attempt_end') { a.ended = true; a.failed = e.attributes?.outcome === 'error' || a.status >= 400; }
      attempts.set(e.attemptId, a);
    }
    const observed = attempts.size ? [...attempts.values()] : records.reduce((list, r) => r.attempts.length > list.length ? r.attempts : list, []);
    const status = proof && Number.isInteger(result.wireStatusCode) ? result.wireStatusCode : null;
    let outcome = 'unknown', reason = !trace ? '缺少可信主站请求身份；按来源记录单列待关联' : '缺少下游完整结束或错误写出证据';
    const delivery = proof ? result.deliveryKind || null : null;
    const outputState = proof ? result.outputStarted === true ? 'partial' : result.outputStarted === false ? 'none' : 'unknown' : 'unknown';
    const errorWritten = proof && result.errorWritten === true;
    const complete = proof && result.downstreamComplete === true && (result.terminalSeen === true || !first.stream);
    const attemptsComplete = Boolean(trace) && !dropped && proof && result.upstreamAttemptCount === observed.length && observed.every(a => a.ended);
    const hasFailure = errorWritten || proof && delivery === 'incomplete_close' && result.downstreamComplete === false;
    if (trace && !conflict) {
      if (complete && (hasFailure || status >= 400) || proof && delivery === 'complete' && hasFailure) reason = '下游成功与失败结束证据冲突';
      else if (hasFailure) { outcome = ['sse_error', 'response_failed', 'incomplete_close'].includes(delivery) ? 'stream' : 'http'; reason = '下游错误写出或非正常结束已确认'; }
      else if (proof && result.clientDisconnected === true) { outcome = 'disconnected'; reason = '客户端先行断开，未确认错误返回'; }
      else if (complete && status >= 200 && status < 300 && attemptsComplete && observed.some(a => a.failed) && !observed.at(-1)?.failed) { outcome = 'recovered'; reason = '失败尝试后完整响应及正常结束已向下游写出'; }
      // Older collectors prove an HTTP error only if a write was observed; PANIC may synthesize status 500.
      else if (!proof && end?.attributes?.statusCode >= 400 && end.attributes.errorCode !== 'PANIC' &&
        events.some(e => e.name === 'downstream_write') && end.attributes.outcome === 'error') { outcome = 'http'; reason = '已记录下游错误状态与响应写出，细分传输表现未记录'; }
    }
    if (conflict) reason = '同请求身份或结束证据冲突';
    const wire = status || (outcome === 'http' && !proof ? end.attributes.statusCode : null);
    const errorCode = code(proof ? result.errorCode : null) || last.errorCode;
    const type = failed({ outcome }) ? failureType({ errorCode, phase: code(result.failureStage) || last.phase,
      owner: code(result.errorOwner) || last.owner, upstreamStatus: result.upstreamStatusCode || observed.at(-1)?.status || (last.stream ? null : last.upstreamStatus), outputState, delivery, status: wire }) : null;
    const retryState = outcome === 'recovered' ? 'recovered' : !failed({ outcome }) || !trace || dropped ? 'unknown' :
      observed.length > 1 && observed.every(a => a.id) ? result.retryExhausted === true ? 'exhausted' : 'retried_failed' :
        attemptsComplete ? outputState === 'partial' ? 'stopped_after_output' : 'not_retried' : 'unknown';
    return { id, linked: Boolean(trace), requestId: first.requestId, clientId: first.clientId,
      userId: first.userId, userName: first.userName || (first.userId ? `用户 #${first.userId}` : '身份未记录'),
      userKeyId: first.userKeyId, groupId: first.groupId, groupName: first.groupName || (first.groupId ? `分组 #${first.groupId}` : '分组未记录'),
      model: first.model, upstreamModel: last.upstreamModel, at, day: dateInTimezone(timezone, new Date(at)),
      dayBasis: started ? 'request_start' : 'first_error', stream: first.stream, outcome, failureType: type,
      cause: causeOf(type, last), wire, semanticStatus: last.semanticStatus, delivery, outputState: outcome === 'recovered' ? 'complete' : outputState,
      retryState, attempts: observed, attemptsComplete,
      sourceIds: records.map(r => r.sourceId).filter(Boolean), sourceRows: records.filter(r => r.sourceId).length, reason, errorCode,
      durationMs: end?.elapsedMs ?? last.durationMs, complete: proof ? result.downstreamComplete ?? null : null,
      terminal: proof ? result.terminalSeen ?? null : null, clientDisconnected: proof ? result.clientDisconnected ?? null : null,
      accounts: [...new Set([...observed.map(a => a.accountId), ...records.map(r => r.accountId)].filter(Boolean))],
      evidence: { root: trace ? trace.metadata?.apiKeyId ? 'telemetry.direct_request_id + user_id + api_key_id' : 'telemetry.direct_request_id + user_id; api_key_id from error logs' : 'ops_error_logs.id',
        final: proof ? 'telemetry.request_end.resultVersion=1' : outcome === 'http' ? 'telemetry.request_end + downstream_write' : null,
        dropped, conflict, errorBodyPresent: records.some(r => r.bodyError) }
    };
  });
}

module.exports = { FAILURE_TYPES, CAUSES, OUTCOMES, classifyRequests, failed, pgId, token, errorMetadata, failureType };
