'use strict';

const crypto = require('node:crypto');
const { z } = require('zod');
const { DateTime } = require('luxon');
const { AppError } = require('../errors');
const { domain } = require('./domain-access-format');
const { DomainAccessCollector } = require('./domain-access-collector');

const hostSchema = z.string().refine(value => domain(value) === value, '请输入小写域名，不含协议、端口或路径');
const idsSchema = z.array(z.number().int().safe().positive()).min(1).max(50).refine(ids => new Set(ids).size === ids.length);
const settingsSchema = z.object({ domains: z.array(hostSchema).min(1).max(20), target: hostSchema,
  rawDays: z.number().int().min(7).max(365), summaryDays: z.number().int().min(30).max(3650) }).strict()
  .refine(value => !value.domains.includes(value.target) && new Set(value.domains).size === value.domains.length && value.rawDays <= value.summaryDays,
    '关注域名须唯一，不能包含迁移目标；汇总保留时间不能短于明细');
const querySchema = z.object({ domain: hostSchema.optional(), start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), search: z.string().trim().max(200).default(''),
  migration: z.enum(['all', 'still', 'new', 'inactive']).default('all'),
  notification: z.enum(['all', 'pending', 'drafted', 'notified', 'ignored']).default('all'),
  identity: z.enum(['all', 'confirmed', 'pending', 'ambiguous', 'anonymous', 'unverified']).default('all'),
  sort: z.enum(['latest', 'count', 'id']).default('latest'), page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20) });

function validate(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) throw new AppError('INVALID_REQUEST', result.error.issues[0].message, { status: 400 });
  return result.data;
}
function missing() { return new AppError('DOMAIN_RECORD_NOT_FOUND', '未找到该记录', { status: 404 }); }
const csvCell = value => {
  let text = String(value ?? '');
  if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};

class DomainAccessService {
  constructor({ config, store, source, messages, now = () => Date.now() }) {
    this.config = config; this.store = store; this.source = source; this.messages = messages; this.now = now;
    this.timezone = config.sub2apiTimezone || 'Asia/Shanghai';
    this.timer = null; this.work = null; this.draftWork = null; this.stopped = false;
    this.collector = new DomainAccessCollector({ directory: config.domainAccess?.directory, store, now,
      timezone: this.timezone, settings: () => this.settings() });
  }
  today() { return DateTime.fromMillis(this.now(), { zone: this.timezone }).toISODate(); }
  settings() {
    return this.store.meta('settings') || { domains: this.config.domainAccess?.domains || ['epoint2api.fjmooo.cn', 'aihub.fo2.us.ci'],
      target: this.config.domainAccess?.target || 'yunhop.cc', rawDays: 30, summaryDays: 365 };
  }
  options() {
    return { ...this.settings(), timezone: this.timezone, today: this.today(),
      defaultStart: DateTime.fromISO(this.today()).minus({ days: 6 }).toISODate(), status: this.status() };
  }
  query(input = {}) {
    const q = validate(querySchema, input), settings = this.settings();
    q.domain ||= settings.domains[0]; q.end ||= this.today();
    q.start ||= DateTime.fromISO(q.end).minus({ days: 6 }).toISODate();
    const start = DateTime.fromISO(q.start, { zone: this.timezone }), end = DateTime.fromISO(q.end, { zone: this.timezone });
    if (!settings.domains.includes(q.domain) || !start.isValid || !end.isValid || start.toISODate() !== q.start ||
        end.toISODate() !== q.end || q.start > q.end || q.end > this.today() || end.diff(start, 'days').days > 365) {
      throw new AppError('INVALID_DOMAIN_RANGE', '请选择关注域名和不超过 366 天的有效日期范围', { status: 400 });
    }
    return q;
  }
  status() {
    const collector = this.collector.status();
    const status = !collector.configured ? 'unconfigured' : collector.error ? 'error' :
      !collector.lastSuccessAt || this.now() - collector.lastSuccessAt > 90000 ? 'interrupted' : collector.backlog ? 'catching_up' : 'ready';
    return { ...collector, status, identitySource: { lastError: this.source.lastError, lastSuccess: this.source.lastSuccess },
      settings: this.settings(), retention: this.store.meta('retention'), rawCount: this.store.db.prepare('SELECT COUNT(*) AS n FROM da_requests').get().n,
      latestMeans: '入口请求结束时间；HTTP 200 不证明流式输出完整',
      coverage: '无请求的时段无法证明没有访问；采集启用前和轮转缺失的记录不能补全。' };
  }
  configure(input, actor) {
    const settings = validate(settingsSchema, input), previous = this.settings();
    // Expanding retained dates later cannot recover data already purged.
    this.store.meta('settings', settings); this.store.meta('settingsAudit', { previous, settings, actor, at: this.now() });
    this.store.meta('retention', this.store.prune(settings, this.today()));
    return this.options();
  }
  async tick() {
    if (this.work) return this.work;
    this.work = (async () => {
      await this.collector.run();
      const due = this.store.due();
      if (due.length) {
        try { this.store.resolve(await this.source.match(due)); }
        catch { this.source.lastError = 'IDENTITY_SOURCE_UNAVAILABLE'; }
      }
      const lastPrune = this.store.meta('prunedDay');
      if (lastPrune !== this.today()) {
        this.store.meta('retention', this.store.prune(this.settings(), this.today())); this.store.meta('prunedDay', this.today());
      }
    })().finally(() => { this.work = null; });
    return this.work;
  }
  start() {
    this.stopped = false;
    const run = () => { this.tick().catch(() => { this.store.meta('workerError', 'DOMAIN_WORKER_FAILED'); }); };
    run(); this.timer = setInterval(run, 10000); this.timer.unref?.();
    this.processDrafts();
  }
  async stop() {
    this.stopped = true; clearInterval(this.timer); this.timer = null;
    await this.work; await this.draftWork;
  }

  messageFor(recipient) {
    if (!recipient.messageId) return null;
    try {
      const value = this.messages.store.get(recipient.messageId);
      return { id: value.id, status: value.status, readAt: value.readAt, updatedAt: value.updatedAt };
    } catch { return null; }
  }
  notificationMap(host) {
    const map = new Map();
    for (const batch of this.store.drafts(host, 1000)) for (const recipient of batch.recipients) {
      if (recipient.state === 'drafted' && this.messageFor(recipient)) map.set(recipient.userId, { state: 'drafted', at: batch.createdAt });
    }
    for (const row of this.store.db.prepare('SELECT * FROM da_notifications WHERE domain=?').all(host)) map.set(row.user_id, row);
    return map;
  }
  allUsers(q) {
    const target = this.settings().target, notifications = this.notificationMap(q.domain);
    const rows = this.store.db.prepare(`SELECT d.user_id AS id,p.name,p.email,p.role,MIN(d.first_at) AS firstAt,MAX(d.last_at) AS lastAt,
      SUM(d.count) AS totalCount,SUM(CASE WHEN d.day>=@start AND d.day<=@end THEN d.count ELSE 0 END) AS count,
      MAX(CASE WHEN d.day>=@start AND d.day<=@end THEN d.last_at ELSE NULL END) AS periodLastAt,
      (SELECT MAX(n.last_at) FROM da_daily n WHERE n.domain=@target AND n.user_id=d.user_id AND n.identity='confirmed' AND n.day<=@end) AS targetLastAt
      FROM da_daily d JOIN da_profiles p ON p.id=d.user_id
      WHERE d.domain=@domain AND d.identity='confirmed' AND d.day<=@end AND p.role='user' AND p.id<>1
      GROUP BY d.user_id`).all({ domain: q.domain, target, start: q.start, end: q.end });
    const since = DateTime.fromISO(q.end, { zone: this.timezone }).minus({ days: 6 }).startOf('day').toMillis();
    const keys = this.store.db.prepare(`SELECT user_id,GROUP_CONCAT(DISTINCT key_id) AS ids FROM da_requests
      WHERE domain=? AND identity='confirmed' GROUP BY user_id`).all(q.domain);
    const keyMap = new Map(keys.map(row => [row.user_id, row.ids.split(',').map(Number)]));
    for (const row of rows) {
      row.keyIds = keyMap.get(row.id) || [];
      row.notification = notifications.get(row.id)?.state || 'pending';
      row.migration = row.lastAt >= since ? 'still' : row.targetLastAt >= since ? 'new' : 'inactive';
    }
    return rows;
  }
  filteredUsers(q) {
    const search = q.search.toLowerCase();
    const rows = this.allUsers(q).filter(row => (q.migration === 'all' || row.migration === q.migration) &&
      (q.notification === 'all' || row.notification === q.notification) &&
      (!search || [row.id, row.name, row.email, ...row.keyIds.map(id => `#${id}`)].some(value => String(value).toLowerCase().includes(search))));
    return rows.sort(q.sort === 'count' ? (a, b) => b.count - a.count || a.id - b.id : q.sort === 'id' ? (a, b) => a.id - b.id : (a, b) => b.lastAt - a.lastAt || a.id - b.id);
  }
  users(input) {
    const q = this.query(input), rows = this.filteredUsers(q), offset = (q.page - 1) * q.pageSize;
    return { items: rows.slice(offset, offset + q.pageSize), total: rows.length, page: q.page, pageSize: q.pageSize };
  }
  csv(input) {
    const q = this.query(input), rows = this.filteredUsers(q);
    if (rows.length > 10000) throw new AppError('DOMAIN_EXPORT_LIMIT', '导出最多 10000 位用户，请缩小筛选范围', { status: 400 });
    const header = ['用户 ID', '用户名', '邮箱', '关注域名', '保留累计请求', '时段请求', '首次访问', '最后访问', '使用状态', '通知状态'];
    return '\uFEFF' + [header, ...rows.map(row => [row.id, row.name, row.email, q.domain, row.totalCount, row.count,
      new Date(row.firstAt).toISOString(), new Date(row.lastAt).toISOString(), row.migration, row.notification])].map(row => row.map(csvCell).join(',')).join('\r\n');
  }
  report(input) {
    const q = this.query(input), users = this.allUsers(q);
    const rows = this.store.db.prepare(`SELECT day,domain,SUM(count) AS count,
      SUM(CASE WHEN identity!='confirmed' THEN count ELSE 0 END) AS unknown
      FROM da_daily WHERE domain IN (?,?) AND day>=? AND day<=? GROUP BY day,domain`).all(q.domain, this.settings().target, q.start, q.end);
    const days = [];
    for (let day = DateTime.fromISO(q.start); day.toISODate() <= q.end; day = day.plus({ days: 1 })) {
      const date = day.toISODate(), old = rows.find(row => row.day === date && row.domain === q.domain), target = rows.find(row => row.day === date && row.domain === this.settings().target);
      days.push({ date, old: old?.count || 0, target: target?.count || 0, unknown: old?.unknown || 0 });
    }
    const historyCount = this.store.db.prepare('SELECT COUNT(*) AS n FROM da_history WHERE domain=? AND day>=? AND day<=?').get(q.domain, q.start, q.end).n;
    return { query: q, target: this.settings().target, timezone: this.timezone, generatedAt: this.now(), status: this.status(),
      summary: { users: users.length, periodUsers: users.filter(row => row.count > 0).length,
        requests: days.reduce((sum, row) => sum + row.old, 0), unknown: days.reduce((sum, row) => sum + row.unknown, 0), history: historyCount }, days };
  }
  requests(input, userId = null) {
    const q = this.query(input), start = DateTime.fromISO(q.start, { zone: this.timezone }).startOf('day').toMillis(),
      end = DateTime.fromISO(q.end, { zone: this.timezone }).plus({ days: 1 }).startOf('day').toMillis();
    const where = `r.domain=@domain AND r.at>=@start AND r.at<@end AND (@identity='all' OR r.identity=@identity)
      AND (@userId=0 OR r.user_id=@userId) AND (@search='' OR INSTR(LOWER(r.id),@search)>0 OR INSTR(LOWER(r.path),@search)>0
      OR INSTR(LOWER(COALESCE(p.name,'')),@search)>0 OR CAST(r.user_id AS TEXT)=@search)`;
    const args = { domain: q.domain, start, end, identity: q.identity, userId: userId || 0, search: q.search.toLowerCase() };
    const total = this.store.db.prepare(`SELECT COUNT(*) AS n FROM da_requests r LEFT JOIN da_profiles p ON p.id=r.user_id WHERE ${where}`).get(args).n;
    const items = this.store.db.prepare(`SELECT r.*,p.name,p.email FROM da_requests r LEFT JOIN da_profiles p ON p.id=r.user_id
      WHERE ${where} ORDER BY r.at DESC,r.id LIMIT @limit OFFSET @offset`).all({ ...args, limit: q.pageSize, offset: (q.page - 1) * q.pageSize });
    return { items: items.map(row => ({ ...row, evidence: JSON.parse(row.evidence) })), total, page: q.page, pageSize: q.pageSize,
      rawSince: this.store.meta('retention')?.rawSince || null };
  }
  detail(id) {
    validate(z.string().regex(/^[a-f0-9]{32}$/), id);
    const row = this.store.db.prepare('SELECT r.*,p.name,p.email,p.role FROM da_requests r LEFT JOIN da_profiles p ON p.id=r.user_id WHERE r.id=?').get(id);
    if (!row) throw missing();
    return { ...row, evidence: JSON.parse(row.evidence) };
  }
  user(id, input) {
    id = validate(z.coerce.number().int().safe().positive(), id);
    const q = this.query(input), user = this.allUsers(q).find(row => row.id === id);
    if (!user) throw missing();
    return { ...user, requests: this.requests({ ...q, pageSize: 20 }, id),
      notifications: this.store.db.prepare('SELECT * FROM da_audit WHERE domain=? AND user_id=? ORDER BY at DESC,id DESC LIMIT 100').all(q.domain, id),
      messages: this.drafts(q.domain).flatMap(batch => batch.recipients.filter(row => row.userId === id).map(row => ({ ...row, title: batch.title, at: batch.createdAt }))) };
  }
  history(input) {
    const q = this.query(input);
    return { items: this.store.db.prepare(`SELECT day,evidence,path,COUNT(*) AS count,MIN(at) AS firstAt,MAX(at) AS lastAt
      FROM da_history WHERE domain=? AND day>=? AND day<=? GROUP BY day,evidence,path ORDER BY day DESC LIMIT 500`).all(q.domain, q.start, q.end),
      limit: 500, deduplication: '相同原始行按摘要去重；计数是保留日志中的线索数，不是独立用户数。' };
  }
  ensureRecipients(host, ids) {
    const known = new Set(this.allUsers(this.query({ domain: host })).map(row => row.id));
    if (ids.some(id => !known.has(id))) throw new AppError('DOMAIN_RECIPIENT_UNVERIFIED', '名单中存在未确认或管理员账号，请刷新用户列表', { status: 409 });
  }
  notify(input, actor) {
    const value = validate(z.object({ domain: hostSchema, userIds: idsSchema, state: z.enum(['pending', 'notified', 'ignored']),
      note: z.string().trim().min(1).max(500) }).strict(), input);
    this.ensureRecipients(value.domain, value.userIds);
    this.store.notify(value.domain, value.userIds, value.state, value.note, actor);
    return { updated: value.userIds.length };
  }
  drafts(host) {
    const scopedDomain = this.query({ domain: host }).domain;
    return this.store.drafts(scopedDomain).map(batch => ({ ...batch, recipients: batch.recipients.map(recipient => ({ ...recipient, message: this.messageFor(recipient) })) }));
  }
  createDraft(input, actor, requestKey, accessToken) {
    const value = validate(z.object({ domain: hostSchema, userIds: idsSchema,
      title: z.string().trim().min(1).max(200), content: z.string().trim().min(1).max(16000) }).strict(), input);
    validate(z.string().uuid(), requestKey);
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const previous = this.store.draft(requestKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint || previous.actor !== actor) throw new AppError('DOMAIN_DRAFT_CONFLICT', '该草稿请求已经保存，内容不同', { status: 409 });
      return previous;
    }
    this.ensureRecipients(value.domain, value.userIds);
    if (this.store.db.prepare('SELECT COUNT(*) AS n FROM da_drafts').get().n >= 1000) throw new AppError('DOMAIN_DRAFT_LIMIT', '域名草稿批次已达上限', { status: 409 });
    const batch = { id: requestKey, fingerprint, domain: value.domain, title: value.title, content: value.content,
      actor, createdAt: this.now(), recipients: value.userIds.map(userId => ({ userId, requestKey: crypto.randomUUID(), state: 'pending' })) };
    this.store.draft(requestKey, batch); this.processDrafts(accessToken);
    return batch;
  }
  retryDraft(id, accessToken) {
    validate(z.string().uuid(), id);
    const batch = this.store.draft(id); if (!batch) throw missing();
    this.ensureRecipients(batch.domain, batch.recipients.filter(row => row.state !== 'drafted').map(row => row.userId));
    for (const row of batch.recipients) if (row.state === 'failed') { row.state = 'pending'; delete row.error; }
    this.store.draft(id, batch); this.processDrafts(accessToken); return batch;
  }
  processDrafts(accessToken) {
    if (accessToken) this.draftAccessToken = accessToken;
    if (this.draftWork || this.stopped) return;
    let failed = false;
    this.draftWork = (async () => {
      for (const batch of this.store.pendingDrafts()) {
        for (const row of batch.recipients.filter(recipient => recipient.state === 'pending')) {
          if (this.stopped) return;
          try {
            this.ensureRecipients(batch.domain, [row.userId]);
            const currentUser = await this.messages.adminRequest(`/api/v1/admin/users/${row.userId}`, this.draftAccessToken);
            const expected = this.store.db.prepare('SELECT email FROM da_profiles WHERE id=?').get(row.userId);
            if (Number(currentUser?.id) !== row.userId || currentUser.role !== 'user' || !expected || String(currentUser.email || '') !== expected.email) {
              throw new AppError('DOMAIN_RECIPIENT_CHANGED', '当前主站用户与已确认的身份信息不一致', { status: 409 });
            }
            const message = await this.messages.create({ userId: row.userId, title: batch.title, content: batch.content,
              status: 'draft', notifyMode: 'silent', startsAt: null, endsAt: null },
            { actor: batch.actor, accessToken: this.draftAccessToken, requestKey: row.requestKey });
            row.state = 'drafted'; row.messageId = message.id; delete row.error;
          } catch (error) { row.state = 'failed'; row.error = String(error.code || 'DRAFT_CREATE_FAILED').slice(0, 80); }
          this.store.draft(batch.id, batch);
        }
      }
    })().catch(() => { failed = true; this.store.meta('draftWorkerError', 'DRAFT_WORKER_FAILED'); })
      .finally(() => {
        this.draftWork = null;
        if (!failed && !this.stopped && this.store.pendingDrafts().length) this.processDrafts();
        else this.draftAccessToken = null;
      });
  }
}

module.exports = { DomainAccessService, settingsSchema };
