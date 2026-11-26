'use strict';
const crypto = require('node:crypto');
const { DateTime } = require('luxon');
const Decimal = require('decimal.js');
const { z } = require('zod');
const { AppError } = require('../errors');
const { buildGroupReport, total } = require('./supplier-group-matcher');

const querySchema = z.object({ date: z.string().optional(), start: z.string().optional(), end: z.string().optional(),
  providerId: z.string().max(200).optional(), groupId: z.string().regex(/^[a-f0-9]{32}$/).optional(),
  keyId: z.string().max(200).optional(), view: z.enum(['groups', 'mapping', 'pending', 'accounts', 'keys', 'local', 'daily']).default('groups'),
  issuesOnly: z.enum(['0', '1']).default('1'), page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20) });
const settingsSchema = z.object({ aliases: z.record(z.string().min(1).max(200), z.array(z.string().trim().min(2).max(120)).max(20)),
  alert: z.object({ enabled: z.boolean(), amount: z.number().finite().min(0).max(1000000), percent: z.number().finite().min(0).max(1000) }) });
const text = z.string().max(200), amount = z.number().finite().nonnegative().nullable();
const upstreamSchema = z.object({ source: z.literal('upstream_key_group_daily_v1'), date: z.string(), timezone: z.string(),
  currency: z.literal('CNY'), providerFilter: z.literal('scheduled_enabled'), items: z.array(z.object({
    id: text.min(1), name: text, complete: z.boolean(), accountCovered: z.boolean().optional().default(false),
    stale: z.boolean().optional(), archiveConflict: z.boolean().optional(), reasons: z.array(z.string().max(500)).max(20).optional().default([]),
    keys: z.array(z.object({ id: text.min(1), name: text.nullable().optional(), maskedKey: z.string().max(500).nullable().optional(),
      identity: z.string().regex(/^[a-f0-9]{64}$/).nullable(), groupRef: text.nullable(), groupName: text.nullable().optional(),
      cost: amount, upstreamAmount: amount, requests: z.number().int().nonnegative().safe().nullable(), complete: z.boolean(),
      reasons: z.array(z.string().max(500)).max(20).optional().default([])
    }).refine(k => !k.complete || (k.cost !== null && k.upstreamAmount !== null && k.requests !== null && k.groupRef !== null))).max(1000)
  })).max(500) });

function validateUpstream(value, date, timezone) {
  const parsed = upstreamSchema.safeParse(value);
  if (!parsed.success || parsed.data.date !== date || parsed.data.timezone !== timezone ||
      new Set(parsed.data.items.map(p => p.id)).size !== parsed.data.items.length || parsed.data.items.some(p =>
        new Set(p.keys.map(k => JSON.stringify([k.id, k.groupRef]))).size !== p.keys.length)) {
    throw new AppError('SUPPLIER_GROUP_INVALID_SOURCE', '供应商分组接口版本不兼容或返回数据无效，请配套更新供应商监控', { status: 502 });
  }
  for (const provider of parsed.data.items) for (const key of provider.keys) {
    if (key.maskedKey && !/\.{3}|[*•…]/u.test(key.maskedKey)) key.maskedKey = key.maskedKey.length > 8
      ? `${key.maskedKey.slice(0, 4)}...${key.maskedKey.slice(-4)}` : '***';
  }
  return parsed.data;
}

function archiveUpstream(previous, next) {
  const providers = new Map(next.items.map(p => [p.id, p]));
  for (const old of previous.items) {
    const current = providers.get(old.id);
    if (!current || (old.complete && old.accountCovered && !old.stale)) { providers.set(old.id, old); continue; }
    const knownIds = new Set(old.keys.filter(k => k.cost !== null).map(k => k.id));
    const frozen = old.keys.filter(k => knownIds.has(k.id));
    const confirmed = frozen.filter(k => k.cost !== null);
    const equal = (a, b) => a !== null && b !== null && new Decimal(a).minus(b).abs().lte(Decimal.max('0.0000001', new Decimal(a).abs().times('0.0000000001')));
    const matches = (k, n) => n.id === k.id && n.groupRef === k.groupRef && equal(n.upstreamAmount, k.upstreamAmount) && n.requests === k.requests;
    const changed = confirmed.some(k => !current.keys.some(n => matches(k, n)));
    const conflict = confirmed.some(k => {
      const rows = current.keys.filter(n => n.id === k.id), sameGroup = rows.find(n => n.groupRef === k.groupRef);
      if (!sameGroup) return k.groupRef !== null && rows.length > 0 && rows.every(n => n.groupRef !== null && n.complete);
      return (k.upstreamAmount !== null && sameGroup.upstreamAmount !== null && !equal(sameGroup.upstreamAmount, k.upstreamAmount)) ||
        (k.requests !== null && sameGroup.requests !== null && k.requests !== sameGroup.requests);
    });
    const verified = current.complete && current.accountCovered && !current.stale && !changed;
    const archiveConflict = conflict || current.archiveConflict === true || (old.archiveConflict === true && !verified);
    const reason = '历史分组归档与后续上游数据不一致，保留原已知金额；完整合计和差额待核对';
    providers.set(old.id, { ...current, accountCovered: current.accountCovered && !changed, archiveConflict,
      reasons: [...new Set([...current.reasons, ...(archiveConflict ? [reason] : [])])],
      keys: [...frozen, ...current.keys.filter(k => !knownIds.has(k.id))] });
  }
  return { ...next, items: [...providers.values()] };
}

class SupplierGroupService {
  constructor({ source, store, providerMonitor, sub2api, config, now = () => new Date(), timeoutMs = 45000 }) {
    Object.assign(this, { source, store, providerMonitor, sub2api, config, now, timeoutMs });
    this.running = new Map(); this.stopping = false;
  }
  local() { return DateTime.fromJSDate(this.now(), { zone: this.config.financeTimezone }); }
  scope() { return crypto.createHash('sha256').update(JSON.stringify([this.source.scope(), this.config.financeTimezone,
    this.config.sub2apiTimezone, this.config.providerMonitorBaseUrl])).digest('hex'); }
  allowed(date, archive) { const local = this.local(); return date === local.toISODate() ||
    (archive && local.hour >= 1 && date === local.minus({ days: 1 }).toISODate()); }
  async collect(date, { archive = false, accessToken = null } = {}) {
    if (this.stopping) throw new AppError('SERVICE_STOPPING', '服务正在停止', { status: 503 });
    const scope = this.scope(), identity = scope + date;
    if (this.running.has(identity)) return this.running.get(identity);
    if (!this.allowed(date, archive)) throw new AppError('SUPPLIER_HISTORY_FETCH_FORBIDDEN', '历史分组消费只读取归档', { status: 409 });
    const controller = new AbortController(), deadline = Date.now() + this.timeoutMs; let timer;
    const verify = () => {
      controller.signal.throwIfAborted();
      if (Date.now() >= deadline) throw new AppError('SUPPLIER_GROUP_TIMEOUT', '分组消费统计超时，请稍后重试', { status: 504 });
      if (scope !== this.scope() || this.stopping) throw new AppError('SOURCE_CHANGED', '统计来源已变化，请重新查询', { status: 409 });
      if (!this.allowed(date, archive)) throw new AppError('SUPPLIER_HISTORY_FETCH_FORBIDDEN', '资金日已变化，未保存迟到数据', { status: 409 });
    };
    const task = (async () => {
      const work = (async () => {
        const before = this.store.get(scope, date);
        let token = accessToken;
        if (!this.providerMonitor.integrationToken && !token && this.sub2api?.configured()) token = await this.sub2api.login();
        controller.signal.throwIfAborted();
        if (!this.allowed(date, archive)) throw new AppError('SUPPLIER_HISTORY_FETCH_FORBIDDEN', '资金日已变化', { status: 409 });
        const from = DateTime.fromISO(date, { zone: this.config.financeTimezone }).startOf('day');
        const to = from.plus({ days: 1 });
        const [response, raw] = await Promise.all([
          this.providerMonitor.getGroupDailyCosts({ from: date, to: date, timezone: this.config.financeTimezone,
            currency: 'CNY', ...(archive ? { archive: '1' } : {}) }, token, { signal: controller.signal }),
          this.source.read(from.toUTC().toISO(), to.toUTC().toISO())
        ]);
        verify();
        const incoming = validateUpstream(response, date, this.config.financeTimezone);
        const upstream = before?.finalized && before.upstreamSnapshot ? archiveUpstream(before.upstreamSnapshot, incoming) : incoming;
        const policy = before?.finalized ? before.policy : this.store.settings(scope);
        return this.store.db.transaction(() => {
          const accounts = this.store.observe(scope, date, raw.accounts, raw.usage, from.toUTC().toISO(), to.toUTC().toISO());
          const source = before?.finalized && before.siteComplete && !raw.complete && before.siteSnapshot
            ? before.siteSnapshot : { ...raw, accounts };
          const report = buildGroupReport(upstream, source, policy, date, this.now().toISOString());
          report.policy = policy; report.upstreamSnapshot = upstream; report.siteSnapshot = source;
          verify();
          return this.store.save(scope, date, report, archive);
        })();
      })();
      return Promise.race([work, new Promise((_, reject) => {
        timer = setTimeout(() => { const error = new AppError('SUPPLIER_GROUP_TIMEOUT', '分组消费统计超时，请稍后重试', { status: 504 }); controller.abort(error); reject(error); }, this.timeoutMs);
      })]);
    })().finally(() => { clearTimeout(timer); this.running.delete(identity); });
    this.running.set(identity, task); return task;
  }
  async tick() {
    if (this.stopping || !this.providerMonitor.configured()) return;
    const local = this.local(), yesterday = local.minus({ days: 1 }).toISODate();
    if (local.hour >= 1) {
      const saved = this.store.get(this.scope(), yesterday);
      if (!saved?.finalized || !saved.siteComplete || saved.groups.some(g => !g.upstreamComplete) || saved.missingProviders.length) {
        await this.collect(yesterday, { archive: true }).catch(() => {});
      }
    }
    await this.collect(this.local().toISODate()).catch(() => {});
  }
  start() {
    this.stopping = false;
    const run = () => { if (!this.background) this.background = this.tick().finally(() => { this.background = null; }); };
    this.timer = setInterval(run, 60000); this.timer.unref?.(); run();
  }
  async stop() { this.stopping = true; clearInterval(this.timer); await Promise.allSettled([...this.running.values()]); await this.background; }
  configure(input, actor) {
    const parsed = settingsSchema.safeParse(input);
    if (!parsed.success || Object.keys(parsed.data.aliases).length > 500) throw new AppError('INVALID_REQUEST', '供应商简称或差额提醒参数无效', { status: 400 });
    return this.store.configure(this.scope(), parsed.data, actor, this.now().toISOString());
  }
  status(group, alert, stale = false) {
    if (group.archiveConflict) return 'archive_conflict';
    if (stale || group.stale) return 'stale';
    if (!group.upstreamComplete) return 'upstream_missing';
    if (group.main === null) return 'site_incomplete';
    if (group.keys.some(k => k.accounts.some(a => a.historyVerified === false))) return 'history_unverified';
    if (group.mappingBlocked || group.keys.some(k => k.blocked)) return 'mapping_incomplete';
    if (!group.comparable) return 'unlinked_key';
    if (group.main === 0 && group.upstream === 0) return 'zero';
    const excess = group.upstream - group.main;
    if (alert.enabled && excess > 0 && excess >= alert.amount && (group.main === 0 || excess / group.main * 100 >= alert.percent)) return 'upstream_high';
    return excess > 0 ? 'upstream_above' : 'comparable';
  }
  async getReport(input = {}, { accessToken = null } = {}) {
    const parsed = querySchema.safeParse(input);
    if (!parsed.success) throw new AppError('INVALID_REQUEST', '分组消费查询参数无效', { status: 400 });
    const query = parsed.data, today = this.local().toISODate(), date = query.date || query.end || today;
    const day = DateTime.fromISO(date, { zone: this.config.financeTimezone });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !day.isValid || day.toISODate() !== date || date > today) throw new AppError('INVALID_DATE_RANGE', '消费日期无效或晚于今天', { status: 400 });
    const scope = this.scope(), settings = this.store.settings(scope);
    let report = this.store.get(scope, date), stale = false, warning = null;
    if (date === today && (!report || Date.parse(report.computedAt) < this.now().getTime() - 60000 || JSON.stringify(report.policy) !== JSON.stringify(settings))) {
      try { report = await this.collect(date, { accessToken }); }
      catch (error) { if (!report) throw error; stale = true; warning = '本次刷新失败，显示上次快照，差额暂不核定'; }
    }
    if (!report) return { date, today, timezone: this.config.financeTimezone, currency: 'CNY', source: 'history_missing',
      settings, providers: [], providerSummaries: [], groups: [], mappings: [], missingProviders: [], summary: null,
      pagination: { page: 1, total: 0, totalPages: 0 }, warning: '该日没有分组消费归档；历史不会重新拉取或按当前关系倒推' };
    const scopedGroups = report.groups.filter(g => !query.providerId || g.providerId === query.providerId);
    const all = scopedGroups.filter(g => g.accountCount > 0);
    const providerOf = account => account.providerId || (account.candidates.length === 1 ? account.candidates[0].id : null);
    const matched = report.mappings.filter(a => a.matched && (!query.providerId || a.providerId === query.providerId));
    const mappings = report.mappings.filter(a => !query.providerId || a.providerId === query.providerId || a.candidates.some(p => p.id === query.providerId));
    const pending = mappings.filter(a => !a.matched && providerOf(a) && (!query.providerId || providerOf(a) === query.providerId));
    const pendingByProvider = new Map();
    for (const account of pending) {
      const id = providerOf(account);
      if (!pendingByProvider.has(id)) pendingByProvider.set(id, []);
      pendingByProvider.get(id).push(account);
    }
    const known = all.filter(g => g.upstream !== null), comparable = all.filter(g => g.comparable && !stale);
    const page = items => { const n = Math.min(query.page, Math.max(1, Math.ceil(items.length / query.pageSize))); return {
      items: items.slice((n - 1) * query.pageSize, n * query.pageSize), pagination: { page: n, pageSize: query.pageSize, total: items.length, totalPages: Math.ceil(items.length / query.pageSize) } }; };
    const knownKeyCount = group => group.keys.filter(key => key.upstream !== null).length;
    const publicGroup = (g, outdated = stale) => ({ ...g, keys: undefined, stale: outdated || Boolean(g.stale),
      status: this.status(g, settings.alert, outdated), knownKeyCount: knownKeyCount(g),
      diff: outdated ? null : g.diff, rate: outdated ? null : g.rate, keyCount: g.keys.length });
    const publicAccount = account => ({
      id: account.id, name: account.name, status: account.status, deleted: Boolean(account.deleted),
      main: report.siteComplete ? account.main : null, requests: account.requests,
      localGroups: account.localGroups.map(row => ({ ...row, main: report.siteComplete ? row.main : null })),
      ...(account.historyVerified === false ? { historyVerified: false } : {}),
      ...(!account.matched || account.historyVerified === false ? { reason: account.reason } : {})
    });
    const publicAccounts = group => group.keys.flatMap(key => key.accounts).map(publicAccount);
    const byProvider = new Map();
    for (const group of all) {
      if (!byProvider.has(group.providerId)) byProvider.set(group.providerId, []);
      byProvider.get(group.providerId).push(group);
    }
    for (const id of pendingByProvider.keys()) if (!byProvider.has(id)) byProvider.set(id, []);
    const providers = [...new Map([...report.groups.map(g => ({ id: g.providerId, name: g.providerName })),
      ...report.missingProviders, ...report.mappings.flatMap(a => a.candidates)]
      .map(p => [p.id, { id: p.id, name: p.name }])).values()];
    const result = { date, today, timezone: this.config.financeTimezone, currency: 'CNY', source: date === today ? 'live' : 'archive',
      computedAt: report.computedAt, siteComplete: report.siteComplete, settings, stale, warning,
      providers,
      providerSummaries: [...byProvider].map(([id, groups]) => ({ id, name: providers.find(p => p.id === id).name,
        groupCount: groups.length, knownGroups: groups.filter(g => g.upstream !== null).length,
        pendingAccountCount: pendingByProvider.get(id)?.length || 0,
        groupMain: report.siteComplete ? total(groups, 'main') : null,
        groupUpstream: groups.length && groups.every(g => g.upstream !== null) ? total(groups, 'upstream') : null,
        upstream: !pendingByProvider.has(id) && groups.every(g => g.upstream !== null) ? total(groups, 'upstream') : null,
        knownUpstream: total(groups, 'knownUpstream'),
        knownKeyCount: groups.reduce((count, group) => count + knownKeyCount(group), 0),
        stale: stale || groups.some(group => group.stale),
        main: report.siteComplete ? total([...groups, ...(pendingByProvider.get(id) || [])], 'main') : null,
        diff: !stale && !pendingByProvider.has(id) && groups.every(g => g.comparable) ? total(groups, 'diff') : null })),
      missingProviders: report.missingProviders.filter(p => !query.providerId || p.id === query.providerId),
      summary: { groupCount: all.length, knownGroups: known.length, comparableGroups: comparable.length,
        upstream: known.length && !pending.length ? total(known, 'upstream') : null, main: report.siteComplete ? total([...matched, ...pending], 'main') : null,
        diff: comparable.length && !pending.length ? total(comparable, 'diff') : null, accountCount: matched.length + pending.length,
        pendingAccountCount: pending.length,
        localGroupCount: new Set([...matched, ...pending].flatMap(a => a.localGroups.map(g => g.id))).size,
        issueCount: mappings.filter(a => !a.matched || a.historyVerified === false).length,
        unassignedProviderCount: query.providerId ? report.mappings.filter(a => !a.candidates.length).length : 0 } };
    if (query.groupId) {
      const group = scopedGroups.find(g => g.id === query.groupId);
      if (!group) throw new AppError('NOT_FOUND', '所选范围没有该上游分组', { status: 404 });
      const selected = group.keys.find(k => k.id === query.keyId) || group.keys[0];
      const keyPage = page(selected.accounts);
      const accounts = publicAccounts(group), accountPage = page(accounts);
      const accountById = new Map(accounts.map(account => [account.id, account]));
      const local = new Map();
      for (const account of group.keys.flatMap(k => k.accounts)) for (const row of account.localGroups) {
        const previous = local.get(row.id) || { id: row.id, name: row.name, main: 0, requests: 0, accountIds: [] };
        previous.main = total([previous, row], 'main'); previous.requests += row.requests;
        if (!previous.accountIds.includes(account.id)) previous.accountIds.push(account.id);
        local.set(row.id, previous);
      }
      const localPage = page([...local.values()]);
      result.group = { ...publicGroup(group), selectedKeyId: selected.id,
        accounts: accountPage.items,
        keys: group.keys.map(k => ({ ...k, accounts: k.id === selected.id ? keyPage.items : [], accountCount: k.accounts.length })),
        localGroups: localPage.items.map(row => ({ ...row, main: group.main === null ? null : row.main,
          accounts: row.accountIds.map(id => ({ id, name: accountById.get(id).name })) })),
        days: Array.from({ length: 7 }, (_, index) => {
          const previousDate = day.minus({ days: index }).toISODate();
          const snapshot = previousDate === date ? report : this.store.get(scope, previousDate);
          const row = snapshot?.groups.find(g => g.id === group.id);
          return { date: previousDate, ...(row ? publicGroup(row, previousDate === date && stale)
            : { upstream: null, main: null, diff: null, rate: null, status: 'history_missing' }) };
        }) };
      result.pagination = query.view === 'accounts' ? accountPage.pagination : query.view === 'local' ? localPage.pagination : query.view === 'daily'
        ? { page: 1, total: 7, totalPages: 1 } : keyPage.pagination;
    } else if (query.view === 'pending') {
      const selected = page(pending);
      result.accounts = selected.items.map(publicAccount); result.pagination = selected.pagination;
    } else if (query.view === 'mapping') {
      const filtered = query.issuesOnly === '1' ? mappings.filter(a => !a.matched || a.historyVerified === false) : mappings;
      const selected = page(filtered); result.mappings = selected.items; result.pagination = selected.pagination;
    } else {
      const rows = [...byProvider].flatMap(([id, groups]) => [...groups.map(group => ({ group })),
        ...(pendingByProvider.has(id) ? [{ providerId: id }] : [])]);
      const selected = page(rows);
      result.groups = selected.items.filter(row => row.group).map(({ group }) => {
        const accounts = publicAccounts(group);
        return { ...publicGroup(group), accounts: accounts.slice(0, 10), accountsTruncated: accounts.length > 10 };
      });
      result.pendingProviders = selected.items.filter(row => row.providerId).map(({ providerId: id }) => {
        const accounts = pendingByProvider.get(id);
        return { id, accounts: accounts.slice(0, 10).map(publicAccount), accountCount: accounts.length,
          accountsTruncated: accounts.length > 10, main: report.siteComplete ? total(accounts, 'main') : null };
      });
      result.pagination = selected.pagination;
    }
    return result;
  }
}
module.exports = { SupplierGroupService, settingsSchema };
