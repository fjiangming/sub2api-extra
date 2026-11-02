'use strict';

const { z } = require('zod');
const { AppError } = require('../errors');
const { BoundedTtlCache } = require('../cache');
const { parseDateRange, dateInTimezone, addUtcDays } = require('./metrics-service');
const { FAILURE_TYPES, CAUSES, OUTCOMES, classifyRequests, failed, pgId } = require('./request-errors-classifier');
const { RequestErrorsSource } = require('./request-errors-source');
const DELIVERY_LABELS = { http_error: '错误响应', body_error: '错误正文', sse_error: 'SSE error',
  response_failed: 'response.failed', incomplete_close: '提前断流 · 无错误事件', complete: '正常结束' };

const id = z.string().max(128).regex(/^[a-zA-Z0-9_.:@-]+$/);
const querySchema = z.object({ start: z.string().optional(), end: z.string().optional(), day: z.string().optional(),
  groupId: z.string().refine(v => v === 'unknown' || Boolean(pgId(v))).optional(), providerId: id.optional(), keyId: id.optional(),
  scopeGroupId: z.string().refine(v => v === 'unknown' || Boolean(pgId(v))).optional(),
  userId: z.string().refine(v => v === 'unknown' || Boolean(pgId(v))).optional(),
  search: z.string().trim().max(128).default(''), outcome: z.enum(['all', 'failed', 'unlinked', ...Object.keys(OUTCOMES)]).default('failed'),
  failureType: z.enum(['all', ...Object.keys(FAILURE_TYPES)]).default('all'), cause: z.enum(['all', ...Object.keys(CAUSES)]).default('all'),
  view: z.enum(['types', 'groups', 'users', 'requests']).default('types'),
  page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(20),
  refresh: z.enum(['0', '1']).optional() });

function summarize(rows, providerId = null, keyId = null) {
  const linked = rows.filter(r => r.linked), failures = linked.filter(failed);
  const attempts = linked.flatMap(r => r.attempts.filter(a => (!providerId || a.providerId === providerId) && (!keyId || a.keyIdentity === keyId)));
  return { total: linked.length, sourceRows: rows.reduce((sum, r) => sum + r.sourceRows, 0), unlinked: rows.filter(r => !r.linked).reduce((sum, r) => sum + r.sourceRows, 0),
    failed: failures.length, ...Object.fromEntries(Object.keys(OUTCOMES).map(outcome => [outcome, linked.filter(r => r.outcome === outcome).length])),
    retryFailed: failures.filter(r => ['exhausted', 'retried_failed'].includes(r.retryState)).length,
    affectedUsers: new Set(failures.map(r => r.userId).filter(Boolean)).size, unknownUsers: failures.filter(r => !r.userId).length,
    failedAttempts: attempts.filter(a => a.failed).length, attemptsIncomplete: linked.some(r => !r.attemptsComplete) };
}

class RequestErrorsService {
  constructor({ pool, inspector, config, telemetry, providerMonitor, source, now = () => new Date() }) {
    Object.assign(this, { pool, config, providerMonitor, now });
    this.source = source || new RequestErrorsSource({ pool, inspector, telemetry });
    this.cache = new BoundedTtlCache({ ttlMs: 10000, maxEntries: 8 }); this.running = new Map(); this.generation = null;
  }

  parse(input) {
    const parsed = querySchema.safeParse(input || {});
    if (!parsed.success) throw new AppError('INVALID_REQUEST', '错误分析查询参数无效', { status: 400 });
    const today = dateInTimezone(this.config.sub2apiTimezone, this.now());
    const range = parseDateRange(parsed.data, { today, maxDays: 31, defaultDays: 1 });
    if (range.end > today) throw new AppError('INVALID_DATE_RANGE', '结束日期不能晚于今天', { status: 400 });
    const day = parsed.data.day || range.end;
    parseDateRange({ start: day, end: day });
    if (day < range.start || day > range.end) throw new AppError('INVALID_DATE_RANGE', '分析日期必须在查询范围内', { status: 400 });
    return { ...parsed.data, range, day, today };
  }

  options() {
    const q = this.parse({});
    return { today: q.today, defaultRange: q.range, timezone: this.config.sub2apiTimezone,
      failureTypes: FAILURE_TYPES, outcomes: OUTCOMES, causes: CAUSES, maxDays: 31 };
  }

  async data(query) {
    const generation = this.pool?.pool || this.pool;
    if (this.generation !== generation) { this.cache.clear(); this.running.clear(); this.generation = generation; }
    const key = JSON.stringify([query.range.start, query.range.end, this.config.sub2apiTimezone]);
    if (query.refresh !== '1' && this.cache.get(key)) return this.cache.get(key);
    if (this.running.has(key)) return this.running.get(key);
    const promise = this.source.read(query.range, this.config.sub2apiTimezone).then(data => {
      if (generation !== (this.pool?.pool || this.pool)) throw new AppError('SOURCE_CHANGED', '数据来源已切换，请重新查询错误分析', { status: 409 });
      const result = { ...data, requests: classifyRequests(data.rows, data.traces, this.config.sub2apiTimezone), generatedAt: this.now().toISOString() };
      delete result.rows; delete result.traces;
      if (generation === (this.pool?.pool || this.pool)) this.cache.set(key, result);
      return result;
    }).finally(() => { if (this.running.get(key) === promise) this.running.delete(key); });
    this.running.set(key, promise); return promise;
  }

  async mapped(query, accessToken) {
    const data = await this.data(query), warnings = [data.coverage.warning];
    const rangeRows = data.requests.filter(r => r.day >= query.range.start && r.day <= query.range.end);
    let mappings = [];
    if (this.providerMonitor?.configured()) {
      try {
        const result = await this.providerMonitor.getRequestErrorMappings({ from: addUtcDays(query.range.start, -1), to: addUtcDays(query.range.endExclusive, 1) }, accessToken);
        mappings = result.items || [];
        if (result.truncated) { mappings = []; warnings.push('供应商历史映射超过读取上限，无法排除归属冲突；本次账号保留为未映射。'); }
      } catch { warnings.push('供应商历史 Key 映射暂不可用；保留主站账号，不猜测供应商归属。'); }
    } else warnings.push('未连接供应商监控；主站账号暂列为 Key 未映射。');
    const byAccount = new Map();
    for (const mapping of mappings) {
      const accountId = String(mapping.accountId);
      if (!byAccount.has(accountId)) byAccount.set(accountId, []);
      byAccount.get(accountId).push(mapping);
    }
    const mapAccount = (accountId, at) => {
      const matches = (byAccount.get(accountId) || []).filter(m => m.keyId && m.scope === 'history' &&
        Date.parse(m.validFrom) <= Date.parse(at) && (!m.validTo || Date.parse(m.validTo) > Date.parse(at)));
      const unique = new Map(matches.map(m => [`${m.providerId}:${m.keyId}`, m]));
      if (unique.size === 1) {
        const m = [...unique.values()][0];
        return { id: `key:${m.providerId}:${m.keyId}`, providerId: String(m.providerId), providerName: String(m.providerName || `供应商 #${m.providerId}`),
          name: String(m.keyName || `Key #${m.keyId}`), accountId, verified: true, labelBasis: 'current_alias', mappingAt: at };
      }
      return { id: `account:${accountId}`, providerId: 'unmapped', providerName: 'Key 未映射', name: `主站账号 #${accountId}`, accountId, verified: false };
    };
    const requests = rangeRows.map(r => {
      const keys = [];
      const attempts = r.attempts.map(a => {
        const key = a.accountId ? mapAccount(a.accountId, a.at || r.at) : null;
        if (key) keys.push(key);
        return { ...a, keyIdentity: key?.id || null, providerId: key?.providerId || null };
      });
      for (const accountId of r.accounts) {
        if (!attempts.some(a => a.accountId === accountId)) keys.push(mapAccount(accountId, r.at));
      }
      if (!keys.length) keys.push({ id: r.attemptsComplete && !attempts.length ? 'none' : 'unknown', providerId: 'unmapped',
        providerName: r.attemptsComplete && !attempts.length ? '未到上游' : '归属未记录', name: '无供应商 Key', accountId: null, verified: false });
      return { ...r, attempts, keys: [...new Map(keys.map(k => [`${k.id}:${k.accountId}`, k])).values()] };
    });
    if (data.coverage.truncated) warnings.push('读取达到上限，以下为部分数据；缩短日期范围后重试。');
    if (requests.some(r => !r.linked)) warnings.push('部分错误日志缺少可信请求关联，已单列待关联，不计入去重请求和最终失败合计。');
    if (requests.some(r => r.outcome === 'unknown')) warnings.push('部分记录缺少下游最终响应证据，无法判断是否实际返回错误；已列为待判定，不能按成功或无失败理解。');
    if (data.coverage.telemetryError) warnings.push('请求结束采集暂不可用，已保留主站错误日志；恢复后刷新可重新判定。');
    return { ...data, requests, warnings: warnings.filter(Boolean) };
  }

  async report(input, accessToken) {
    const q = this.parse(input), data = await this.mapped(q, accessToken);
    const scope = data.requests.filter(r => (!q.groupId || (r.groupId || 'unknown') === q.groupId) &&
      (!q.providerId || r.keys.some(k => k.providerId === q.providerId)));
    const base = scope.filter(r => r.day === q.day && (!q.scopeGroupId || (r.groupId || 'unknown') === q.scopeGroupId) && (!q.keyId || r.keys.some(k => k.id === q.keyId)) &&
      (!q.userId || (r.userId || 'unknown') === q.userId) && (q.cause === 'all' || r.cause === q.cause) &&
      (!q.search || `${r.requestId || ''} ${r.clientId || ''} ${r.userId || ''} ${r.userName}`.toLowerCase().includes(q.search.toLowerCase())));
    const rows = base.filter(r => (q.outcome === 'all' || q.outcome === 'unlinked' && !r.linked ||
      r.linked && (q.outcome === 'failed' ? failed(r) : r.outcome === q.outcome)) && (q.failureType === 'all' || r.failureType === q.failureType));
    const summary = summarize(scope, q.providerId), selected = summarize(rows, q.providerId, q.keyId), denominator = base.filter(r => r.linked && failed(r)).length;
    const groups = [...new Set(rows.map(r => r.groupId || 'unknown'))].map(groupId => {
      const gr = rows.filter(r => (r.groupId || 'unknown') === groupId);
      return { id: groupId, name: gr[0].groupName, summary: summarize(gr, q.providerId), types: this.types(gr),
        keys: [...new Set(gr.flatMap(r => r.keys.map(k => k.id)))].map(keyId => {
          const kr = gr.filter(r => r.keys.some(k => k.id === keyId)), key = kr[0].keys.find(k => k.id === keyId);
          return { ...key, accountIds: [...new Set(kr.flatMap(r => r.keys.filter(k => k.id === keyId).map(k => k.accountId)).filter(Boolean))],
            summary: summarize(kr, q.providerId, keyId), types: this.types(kr) };
        }).filter(k => !q.providerId || k.providerId === q.providerId) };
    });
    const users = [...new Set(rows.map(r => r.userId || 'unknown'))].map(userId => {
      const ur = rows.filter(r => (r.userId || 'unknown') === userId);
      return { id: userId, name: ur[0].userName, summary: summarize(ur, q.providerId, q.keyId), types: this.types(ur), groups: new Set(ur.map(r => r.groupId)).size };
    }).sort((a, b) => b.summary.failed - a.summary.failed || a.id.localeCompare(b.id));
    const requests = rows.slice().sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
    const allItems = q.view === 'users' ? users : q.view === 'requests' ? requests : q.view === 'groups' ? groups : this.types(rows, denominator);
    const offset = (q.page - 1) * q.pageSize;
    return { query: q, timezone: this.config.sub2apiTimezone, generatedAt: data.generatedAt, classifierVersion: 1,
      coverage: { ...data.coverage, complete: !data.coverage.truncated && !data.coverage.telemetryError, rootIdentityComplete: !summary.unlinked,
        finalEvidenceRequests: scope.filter(r => r.evidence.final).length, unresolvedRequests: summary.unknown,
        unlinkedRecords: summary.unlinked }, warnings: data.warnings,
      options: { groups: [...new Map(data.requests.map(r => [r.groupId || 'unknown', { id: r.groupId || 'unknown', name: r.groupName }])).values()],
        providers: [...new Map(data.requests.flatMap(r => r.keys.map(k => [k.providerId, { id: k.providerId, name: k.providerName }]))).values()] },
      summary, selected, days: Array.from({ length: q.range.days }, (_, i) => { const date = addUtcDays(q.range.start, i); return { date, ...summarize(scope.filter(r => r.day === date), q.providerId) }; }).reverse(),
      failureTypes: this.types(rows, denominator), groups, items: ['types', 'groups'].includes(q.view) ? allItems : allItems.slice(offset, offset + q.pageSize),
      pagination: { total: allItems.length, page: q.page, pageSize: q.pageSize, hasNext: offset + q.pageSize < allItems.length },
      matrix: Object.entries(CAUSES).map(([cause, label]) => ({ cause, label, ...summarize(base.filter(r => r.cause === cause), q.providerId, q.keyId) })).filter(s => s.sourceRows) };
  }

  types(rows, denominator = rows.filter(r => r.linked && failed(r)).length) {
    return Object.entries(FAILURE_TYPES).map(([id, label]) => {
      const tr = rows.filter(r => r.linked && r.failureType === id), s = summarize(tr);
      return { id, label, count: tr.length, denominator, share: denominator ? tr.length / denominator : null,
        users: s.affectedUsers, unknownUsers: s.unknownUsers, retryFailed: s.retryFailed,
        notRetried: tr.filter(r => ['not_retried', 'stopped_after_output'].includes(r.retryState)).length,
        retryUnknown: tr.filter(r => r.retryState === 'unknown').length,
        responses: [...new Set(tr.map(r => `${r.wire ? 'HTTP ' + r.wire : 'HTTP 未记录'} · ${DELIVERY_LABELS[r.delivery] || OUTCOMES[r.outcome]}`))],
        output: [...new Set(tr.map(r => r.outputState))] };
    }).filter(t => t.count).sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  }

  async detail(id, input, accessToken) {
    if (!/^(error:[1-9]\d{0,18}|trace:[a-zA-Z0-9_.:@-]{1,128})$/.test(id)) throw new AppError('INVALID_REQUEST', '请求标识无效', { status: 400 });
    const q = this.parse(input), data = await this.mapped(q, accessToken);
    const request = data.requests.find(r => r.id === id);
    if (!request) throw new AppError('REQUEST_NOT_FOUND', '请求不存在、已被清理或不在所选日期内', { status: 404 });
    return { request, timezone: this.config.sub2apiTimezone, generatedAt: data.generatedAt };
  }
}

module.exports = { RequestErrorsService, summarize };
