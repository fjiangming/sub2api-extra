'use strict';

const crypto = require('node:crypto');
const Decimal = require('decimal.js');
const { z } = require('zod');
const { AppError } = require('../errors');
const { GroupMonitorProbe } = require('./group-monitor-probe');

const idSchema = z.coerce.string().regex(/^[1-9]\d{0,18}$/).refine(value => /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n);
const policySchema = z.object({ revision: z.number().int().min(0), automatic: z.boolean(),
  intervalMinutes: z.number().int().min(1).max(1440), timeoutSeconds: z.number().int().min(1).max(120),
  concurrency: z.number().int().min(1).max(5), maxOutputTokens: z.number().int().min(16).max(512) }).strict();
const profileSchema = z.object({ revision: z.number().int().min(0), model: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/),
  protocol: z.enum(['auto', 'messages', 'responses', 'chat', 'gemini']), apiKey: z.string().trim().max(1024).regex(/^[\x21-\x7e]*$/).optional(),
  clearKey: z.boolean().optional() }).strict().refine(v => !v.clearKey || !v.apiKey);
const runSchema = z.object({ groupIds: z.array(idSchema).min(1).max(5000).optional() }).strict();
const querySchema = z.object({ search: z.string().max(120).default(''), platform: z.string().max(50).default('all'),
  status: z.enum(['all','ok','failed','waiting','unconfigured','empty','paused','running','queued','blocked','cancelled']).default('all'),
  page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) });
const findingsQuerySchema = z.object({ search: z.string().max(120).default(''), scope: z.enum(['current','unknown','history']).default('current'),
  page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) });

function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError('GROUP_MONITOR_INVALID_REQUEST', '巡检参数无效，请核对输入范围', { status: 400 });
  return result.data;
}
function rate(value) {
  try { if (value == null || value === '') return null; const v = new Decimal(value); return v.isFinite() && v.gte(0) ? v : null; } catch { return null; }
}
function audit(groups) {
  return groups.flatMap(g => g.accounts.filter(a => a.status === 'active').flatMap(a => {
    const accountRate = rate(a.rate), groupRate = rate(g.rate);
    if (accountRate && groupRate && accountRate.lte(groupRate)) return [];
    return [{ groupId: g.id, groupName: g.name, groupStatus: g.status, accountId: a.id, accountName: a.name,
      accountStatus: a.status, schedulable: a.schedulable, accountRate: accountRate?.toString() ?? null, groupRate: groupRate?.toString() ?? null,
      kind: !accountRate || !groupRate ? 'unknown' : 'higher', difference: accountRate && groupRate ? accountRate.minus(groupRate).toString() : null,
      excessPercent: accountRate && groupRate?.gt(0) ? accountRate.div(groupRate).minus(1).times(100).toDecimalPlaces(4).toString() : null }];
  }));
}
function page(items, query) {
  const pages = Math.max(1, Math.ceil(items.length / query.pageSize)), current = Math.min(query.page, pages);
  return { items: items.slice((current - 1) * query.pageSize, current * query.pageSize), total: items.length, page: current, pageSize: query.pageSize, pages };
}

class GroupMonitorService {
  constructor({ store, source, config, probe, now = () => Date.now() }) {
    this.store = store; this.source = source; this.config = config; this.now = now;
    this.probe = probe || new GroupMonitorProbe({ config }); this.scans = new Map(); this.job = null; this.starting = false; this.closed = false;
  }

  async scan() {
    const scope = this.source.scope();
    if (this.scans.has(scope)) return this.scans.get(scope);
    const promise = (async () => {
      try {
        const groups = await this.source.snapshot();
        if (this.source.scope() !== scope) throw new AppError('GROUP_MONITOR_SOURCE_CHANGED', '主站配置已变更，本次快照未更新', { status: 409 });
        this.store.scan(scope, groups, audit(groups)); this.store.prune();
        return { at: this.now(), groups: groups.length };
      } catch (error) {
        const code = error instanceof AppError ? error.code : 'GROUP_MONITOR_SOURCE_UNAVAILABLE';
        this.store.meta(scope, 'sourceError', { code, at: this.now() });
        throw error instanceof AppError ? error : new AppError(code, '分组数据读取失败，保留上次核验结果', { status: 503 });
      }
    })();
    this.scans.set(scope, promise);
    try { return await promise; } finally { this.scans.delete(scope); }
  }

  sourceStatus(scope) {
    const inventory = this.store.inventory(scope), error = this.store.meta(scope, 'sourceError');
    return { ready: Boolean(inventory && !error && this.now() - inventory.at < 180000), at: inventory?.at || null, error: error?.code || null,
      stale: Boolean(inventory && (error || this.now() - inventory.at >= 180000)) };
  }
  publicRun(run) {
    if (!run) return null;
    const { scope: _scope, ...safe } = run;
    return safe;
  }
  runStatus(scope) { return this.publicRun(this.job?.data.scope === scope ? this.job.data : this.finishedRun?.scope === scope ? this.finishedRun : this.store.lastRun(scope)); }
  groups(scope) {
    const profiles = new Map(this.store.profiles(scope).map(p => [p.group_id, p])), latest = this.store.latest(scope);
    const findings = this.store.findings(scope);
    const byGroup = new Map();
    for (const f of findings) { if (!byGroup.has(f.groupId)) byGroup.set(f.groupId, []); byGroup.get(f.groupId).push(f); }
    return (this.store.inventory(scope)?.groups || []).map(g => {
      const p = profiles.get(g.id), last = latest.get(g.id), enabled = g.accounts.filter(a => a.status === 'active').length;
      const result = last && last.profileRevision === p?.revision ? last : null;
      const inProgress = this.job?.data.scope === scope ? this.job.states.get(g.id) : null;
      const status = g.status !== 'active' ? 'paused' : !enabled ? 'empty' : !p?.model || !p.key_configured ? 'unconfigured' : inProgress || result?.status || 'waiting';
      return { id: g.id, name: g.name, platform: g.platform, rate: g.rate, groupStatus: g.status, enabledAccounts: enabled, accountCount: g.accounts.length,
        profile: { model: p?.model || '', protocol: p?.protocol || 'auto', revision: p?.revision || 0, keyConfigured: Boolean(p?.key_configured) },
        status, result, previousResult: !result ? last || null : null,
        anomalyCount: (byGroup.get(g.id) || []).filter(f => f.kind === 'higher').length,
        unknownCount: (byGroup.get(g.id) || []).filter(f => f.kind === 'unknown').length };
    });
  }

  async report(input = {}) {
    const scope = this.source.scope(), query = parse(querySchema, input);
    if (!this.store.inventory(scope)) await this.scan().catch(() => {});
    const all = this.groups(scope), findings = this.store.findings(scope), source = this.sourceStatus(scope);
    const priority = { failed:0,blocked:0,running:1,queued:2,waiting:3,unconfigured:4,empty:5,cancelled:6,ok:7,paused:8 };
    const items = all.filter(g => (query.platform === 'all' || g.platform === query.platform) && (query.status === 'all' || g.status === query.status)
      && `${g.id} ${g.name} ${g.profile.model}`.toLowerCase().includes(query.search.toLowerCase())).sort((a,b) => priority[a.status] - priority[b.status] || a.name.localeCompare(b.name));
    const paged = page(items, query);
    return { ...paged, source, timezone: this.config.sub2apiTimezone, policy: this.store.policy(scope), run: this.runStatus(scope),
      nextAt: this.store.policy(scope).automatic ? this.store.meta(scope, 'nextAt') : null, platforms: [...new Set(all.map(g => g.platform))].sort(),
      summary: { groups: all.length, activeGroups: all.filter(g => g.groupStatus === 'active').length, ok: all.filter(g => g.status === 'ok').length,
        failed: all.filter(g => ['failed','blocked'].includes(g.status)).length, pending: all.filter(g => ['waiting','unconfigured','empty','cancelled'].includes(g.status)).length,
        anomalies: findings.filter(f => f.kind === 'higher').length, unknown: findings.filter(f => f.kind === 'unknown').length,
        anomalyGroups: new Set(findings.filter(f => f.kind === 'higher').map(f => f.groupId)).size },
      histories: Object.fromEntries(paged.items.map(g => [g.id, this.store.history(scope, g.id)])) };
  }
  detail(input) {
    const id = parse(idSchema, input), scope = this.source.scope();
    const group = this.groups(scope).find(g => g.id === id);
    if (!group) throw new AppError('GROUP_MONITOR_NOT_FOUND', '分组不存在，请刷新分组列表', { status: 404 });
    const raw = this.store.inventory(scope).groups.find(g => g.id === id);
    return { ...group, accounts: raw.accounts.map(a => ({ ...a, comparison: a.status !== 'active' ? 'excluded' : !rate(a.rate) || !rate(raw.rate) ? 'unknown'
      : rate(a.rate).gt(rate(raw.rate)) ? 'higher' : 'normal' })), history: this.store.history(scope, id, 30), source: this.sourceStatus(scope) };
  }
  findings(input = {}) {
    const query = parse(findingsQuerySchema, input), scope = this.source.scope();
    let items = this.store.findings(scope, query.scope === 'history' ? 'resolved' : 'open');
    if (query.scope !== 'history') items = items.filter(f => f.kind === (query.scope === 'unknown' ? 'unknown' : 'higher'));
    items = items.filter(f => `${f.accountName} ${f.accountId} ${f.groupName} ${f.groupId}`.toLowerCase().includes(query.search.toLowerCase()));
    const inventory = this.store.inventory(scope), enabled = inventory?.groups.flatMap(g => g.accounts).filter(a => a.status === 'active') || [];
    return { ...page(items, query), source: this.sourceStatus(scope), groups: inventory?.groups.length || 0,
      enabledAccounts: new Set(enabled.map(a => a.id)).size, enabledMemberships: enabled.length };
  }
  finding(id) {
    const scope = this.source.scope(), record = this.store.finding(scope, id);
    if (!record) throw new AppError('GROUP_MONITOR_NOT_FOUND', '异常记录不存在或已超过保留期', { status: 404 });
    const groups = (this.store.inventory(scope)?.groups || []).filter(g => g.accounts.some(a => a.id === record.accountId)).map(g => ({ id:g.id, name:g.name, rate:g.rate,
      account:g.accounts.find(a => a.id === record.accountId) }));
    return { ...record, groups, source: this.sourceStatus(scope) };
  }

  idle() { if (this.job || this.starting) throw new AppError('GROUP_MONITOR_BUSY', '正在巡检，请等待完成或先停止本轮', { status: 409 }); }
  configurePolicy(input) {
    this.idle(); const scope = this.source.scope(), policy = this.store.savePolicy(scope, parse(policySchema, input));
    this.store.meta(scope, 'nextAt', this.now() + policy.intervalMinutes * 60000); return policy;
  }
  async configureGroup(id, input) {
    this.idle(); const scope = this.source.scope(), groupId = parse(idSchema, id), value = parse(profileSchema, input);
    if (!this.store.inventory(scope)) await this.scan();
    this.detail(groupId);
    if (value.apiKey && !await this.source.verifyKey(groupId, value.apiKey)) throw new AppError('GROUP_MONITOR_KEY_GROUP_MISMATCH', 'Key 不属于该分组、已停用、已过期或所属用户不可用', { status: 400 });
    this.idle();
    if (this.source.scope() !== scope) throw new AppError('GROUP_MONITOR_SOURCE_CHANGED', '主站配置已变更，请刷新后重新配置', { status: 409 });
    const result = this.store.saveProfile(scope, groupId, value);
    const { key: _key, ...safe } = result; return safe;
  }

  async startRun(input = {}) {
    this.idle(); if (this.closed) throw new AppError('GROUP_MONITOR_STOPPING', '巡检服务正在停止', { status: 503 });
    const value = parse(runSchema, input), scope = this.source.scope(); this.starting = true;
    try {
      await this.scan();
      if (this.source.scope() !== scope || this.closed) throw new AppError('GROUP_MONITOR_SOURCE_CHANGED', '主站配置已变更，请刷新后重试', { status: 409 });
      const all = this.groups(scope), selected = value.groupIds ? all.filter(g => value.groupIds.includes(g.id)) : all;
      if (value.groupIds && value.groupIds.length !== selected.length) throw new AppError('GROUP_MONITOR_NOT_FOUND', '所选分组不存在或重复', { status: 400 });
      const baseUrl = this.config.sub2apiBaseUrl || this.config.sub2apiPublicUrl;
      if (!baseUrl) throw new AppError('GROUP_MONITOR_SITE_MISSING', '请先在系统设置配置主站地址', { status: 409 });
      const queue = selected.filter(g => !['paused','empty','unconfigured'].includes(g.status));
      const data = { id: crypto.randomUUID(), scope, state: 'running', startedAt: this.now(), finishedAt: null,
        total: queue.length, done: 0, ok: 0, failed: 0, cancelled: 0, skipped: selected.length - queue.length, error: null };
      if (!queue.length) { data.state = 'completed'; data.finishedAt = this.now(); this.store.run(data); this.finishedRun = data; return this.publicRun(data); }
      const job = { data, queue, cursor: 0, states: new Map(queue.map(g => [g.id,'queued'])), controller: new AbortController(),
        policy: this.store.policy(scope), baseUrl, stopped: false };
      this.store.run(data); this.job = job;
      job.promise = new Promise(resolve => setImmediate(resolve)).then(() => this.work(job));
      return this.publicRun({ ...data });
    } finally { this.starting = false; }
  }
  cancel(id) {
    const job = this.job;
    if (!job || job.data.scope !== this.source.scope() || job.data.id !== id) throw new AppError('GROUP_MONITOR_RUN_NOT_ACTIVE', '本轮巡检已结束或不存在', { status: 409 });
    job.stopped = true; job.data.state = 'stopping'; job.controller.abort(); this.store.run(job.data); return this.publicRun(job.data);
  }
  async work(job) {
    const worker = async () => {
      try {
        while (job.cursor < job.queue.length && !job.stopped && !this.closed) {
          const g = job.queue[job.cursor++]; job.states.set(g.id, 'running');
          let profile, result;
          if (this.source.scope() !== job.data.scope) { job.stopped = true; job.data.error = 'SOURCE_CHANGED'; break; }
          try { profile = this.store.profile(job.data.scope, g.id, true); }
          catch { result = { status:'blocked',code:'KEY_UNAVAILABLE',httpStatus:null,elapsedMs:0 }; }
          if (!result) {
            try {
              const valid = await this.source.verifyKey(g.id, profile.key);
              if (job.stopped || this.closed) result = { status:'cancelled',code:'CANCELLED',httpStatus:null,elapsedMs:0 };
              else if (this.source.scope() !== job.data.scope) { job.stopped = true; job.data.error = 'SOURCE_CHANGED'; break; }
              else if (!valid) result = { status:'blocked',code:'KEY_GROUP_MISMATCH',httpStatus:null,elapsedMs:0 };
              else result = await this.probe.probe(g, profile, job.policy, job.controller.signal, job.baseUrl);
            } catch { result = { status:'blocked',code:'KEY_VERIFICATION_UNAVAILABLE',httpStatus:null,elapsedMs:0 }; }
          }
          result = { ...result, model: g.profile.model, profileRevision: g.profile.revision };
          this.store.result(job.data.scope, g.id, job.data.id, result); job.states.delete(g.id); job.data.done++;
          job.data[result.status === 'ok' ? 'ok' : result.status === 'cancelled' ? 'cancelled' : 'failed']++; this.store.run(job.data);
        }
      } catch {
        job.stopped = true; job.data.error = 'MONITOR_WORKER_FAILED'; job.controller.abort();
      }
    };
    try { await Promise.allSettled(Array.from({ length: Math.min(job.policy.concurrency, job.queue.length) }, worker)); }
    finally {
      job.data.state = job.data.error ? 'interrupted' : job.stopped || this.closed ? 'cancelled' : 'completed'; job.data.finishedAt = this.now();
      try { this.store.run(job.data); this.store.meta(job.data.scope, 'nextAt', this.now() + job.policy.intervalMinutes * 60000); }
      catch { job.data.state = 'interrupted'; job.data.error = 'MONITOR_STORE_UNAVAILABLE'; }
      finally { this.finishedRun = job.data; if (this.job === job) this.job = null; }
    }
  }
  async tick() {
    if (this.closed || this.ticking) return;
    this.ticking = true;
    try {
      const scope = this.source.scope(), inventory = this.store.inventory(scope);
      if (!inventory || this.now() - inventory.at >= 60000) await this.scan();
      const policy = this.store.policy(scope), nextAt = this.store.meta(scope, 'nextAt') || 0;
      if (!this.job && !this.starting && policy.automatic && this.now() >= nextAt) await this.startRun();
    } catch { /* Source failures retain the last inventory and are visible in the panel. */ }
    finally { this.ticking = false; }
  }
  start() { this.closed = false; this.timer = setInterval(() => this.tick(), 15000); this.timer.unref(); this.tick(); }
  async stop() {
    this.closed = true; clearInterval(this.timer);
    if (this.job) { this.job.stopped = true; this.job.controller.abort(); await this.job.promise; }
    await Promise.allSettled([...this.scans.values()]);
  }
}

module.exports = { GroupMonitorService, audit, rate };
