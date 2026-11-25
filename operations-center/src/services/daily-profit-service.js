'use strict';

const crypto = require('node:crypto');
const cron = require('node-cron');
const { DateTime } = require('luxon');
const Decimal = require('decimal.js');
const { addUtcDays } = require('./metrics-service');
const { parseReportInput, dailyProfitReport } = require('./cost-analysis-service');
const { AppError } = require('../errors');

function pendingRow(date, status = 'pending_archive') {
  return { date, status, siteConsumption: null, supplierConsumption: null, lotteryReward: null, profit: null, margin: null,
    siteRequests: null, supplierRequests: null, complete: false, siteComplete: false,
    supplierComplete: false, lotteryComplete: false, providers: [] };
}

class DailyProfitService {
  constructor({ analysis, store, config, now = () => new Date(), cronImpl = cron, logger = console,
    calculationTimeoutMs = Math.min(60000, Math.max(config.queryTimeoutMs || 15000,
      config.providerMonitorRequestTimeoutMs || 10000) + 2000) }) {
    this.analysis = analysis;
    this.store = store;
    this.config = config;
    this.now = now;
    this.cron = cronImpl;
    this.logger = logger;
    this.live = new Map();
    this.lastLive = null;
    this.readerCache = null;
    this.started = false;
    this.stopping = false;
    this.running = null;
    this.calculationTimeoutMs = calculationTimeoutMs;
  }

  scope() {
    let database = null;
    if (this.config.databaseUrl) {
      const url = new URL(this.config.databaseUrl);
      database = `${url.host}${url.pathname}`;
    }
    return crypto.createHash('sha256').update(JSON.stringify(['daily-profit-v1', this.config.financeTimezone,
      this.config.sub2apiTimezone, database, this.config.providerMonitorBaseUrl])).digest('hex');
  }

  localNow() { return DateTime.fromJSDate(this.now(), { zone: this.config.financeTimezone }); }

  canFetchSupplier(date, archivePreviousDay = false) {
    const local = this.localNow();
    return date === local.toISODate() || (archivePreviousDay && local.hour >= 1 &&
      date === local.minus({ days: 1 }).toISODate());
  }

  archivedSupplierReader(date, snapshot) {
    const row = snapshot?.row || pendingRow(date);
    return async () => ({
      range: { start: date, end: date }, currency: 'CNY', timezone: this.config.financeTimezone,
      source: 'upstream_daily_summary', scope: 'account', providerFilter: 'scheduled_enabled',
      items: [{ date, cost: row.supplierConsumption, complete: row.supplierComplete === true,
        requests: row.supplierRequests ?? null, providers: row.providers || [] }]
    });
  }

  retrySupplierReader(date, snapshot, read, accessToken) {
    if (!snapshot?.row.providers?.length) return read;
    return async (query, { signal } = {}) => {
      const providers = [];
      for (const provider of snapshot.row.providers) {
        signal?.throwIfAborted();
        // An initial archive retry may fill gaps in yesterday only; known costs are immutable.
        if (provider.complete === true && provider.cost != null) providers.push(provider);
        else try {
          const result = await this.analysis.getSupplierDailyCost(date, provider.id, accessToken,
            { signal, supplierReader: read });
          providers.push(result.provider);
        } catch { providers.push(provider); }
      }
      const complete = providers.every(provider => provider.complete === true && provider.cost != null &&
        new Decimal(provider.cost).isFinite() && new Decimal(provider.cost).gte(0));
      return { ...(await this.archivedSupplierReader(date, snapshot)(query)),
        items: [{ date, providers, complete,
          cost: complete ? providers.reduce((sum, provider) => sum.plus(provider.cost), new Decimal(0)).toDecimalPlaces(8).toNumber() : null,
          requests: providers.every(provider => provider.requests != null)
            ? providers.reduce((sum, provider) => sum + Number(provider.requests), 0) : null }] };
    };
  }

  ready(accessToken) {
    if (this.analysis.accounting && this.analysis.pool?.configured?.() !== false) return true;
    return this.analysis.pool?.configured?.() !== false && this.analysis.providerMonitor?.configured() && Boolean(
      this.analysis.providerMonitor.integrationToken || accessToken || this.analysis.sub2api?.configured());
  }

  async supplierReader(date, accessToken, signal, archivePreviousDay = false) {
    if (!this.canFetchSupplier(date, archivePreviousDay)) {
      throw new AppError('SUPPLIER_HISTORY_FETCH_FORBIDDEN', '历史供应商消费禁止重新拉取', { status: 409 });
    }
    if (!this.analysis.createSupplierDailyCostsReader) return null;
    const archiveDate = archivePreviousDay ? date : null;
    const key = crypto.createHash('sha256').update(JSON.stringify([this.scope(), accessToken, date, archiveDate,
      this.analysis.providerMonitor?.integrationToken, this.config.sub2apiAdminToken,
      this.config.sub2apiAdminEmail, this.config.sub2apiAdminPassword,
      this.analysis.sub2api?.activeRuntimeToken?.()])).digest('hex');
    if (this.readerCache?.key === key && this.readerCache.until > this.now().getTime()) return this.readerCache.read;
    const reader = await this.analysis.createSupplierDailyCostsReader(accessToken, { signal, archiveDate });
    signal?.throwIfAborted();
    const read = async (query, options) => {
      if (query.from !== date || query.to !== date || !this.canFetchSupplier(date, archivePreviousDay)) {
        throw new AppError('SUPPLIER_HISTORY_FETCH_FORBIDDEN', '历史供应商消费禁止重新拉取', { status: 409 });
      }
      try { return await reader(query, options); }
      catch (error) { if (this.readerCache?.key === key) this.readerCache = null; throw error; }
    };
    this.readerCache = { key, read, until: this.now().getTime() + 300000 };
    return read;
  }

  scheduleDue() {
    const local = this.localNow();
    const yesterday = local.minus({ days: 1 }).toISODate();
    const target = local.minus({ days: local.hour >= 1 ? 1 : 2 }).toISODate();
    const scope = this.scope();
    const previous = this.store.metadata(scope, 'scheduled_through');
    let date = previous ? addUtcDays(previous, 1) : target;
    const days = [];
    // Bound recovery after a long outage; later ticks continue from the saved cursor.
    for (let count = 0; date <= target && count < 366; count++, date = addUtcDays(date, 1)) {
      days.push({ date, fetchSupplier: date === yesterday && this.store.list(scope, date, date).length === 0 });
    }
    this.store.enqueueDays(scope, days);
    if (days.length) this.store.metadata(scope, 'scheduled_through', days.at(-1).date);
  }

  start() {
    if (this.started) return;
    this.stopping = false;
    this.started = true;
    this.task = this.cron.schedule('0 1 * * *', () => { this.scheduleDue(); this.wake(); },
      { timezone: this.config.financeTimezone, noOverlap: true, name: 'operations-center-daily-profit' });
    this.timer = setInterval(() => { this.scheduleDue(); this.wake(); }, 15000);
    this.timer.unref?.();
    this.scheduleDue();
    this.wake();
  }

  wake(accessToken = null) {
    if (!this.started || this.wakeTimer || this.running) return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      this.drain({ accessToken }).catch(() => this.logger.warn('daily profit background calculation failed'));
    }, 25);
    this.wakeTimer.unref?.();
  }

  async stop() {
    this.started = false;
    this.stopping = true;
    this.task?.stop();
    clearInterval(this.timer);
    clearTimeout(this.wakeTimer);
    await this.running;
    this.readerCache = null;
    this.lastLive = null;
  }

  async drain({ accessToken = null, limit = 3 } = {}) {
    if (this.running) return this.running;
    if (!this.ready(accessToken)) return;
    this.running = (async () => {
      for (let index = 0; index < limit; index++) {
        if (this.stopping) break;
        const job = this.store.claim(this.scope());
        if (!job) break;
        try {
          const report = await this.calculateDay(job.date, accessToken, { archivePreviousDay: job.fetch_supplier === 1 });
          const row = report.items[0];
          if (!row || row.date !== job.date) throw new Error('Invalid calculated day');
          this.store.finish(job, { row, notices: report.notices }, row.complete &&
            (!this.analysis.accounting || row.accountingSource?.complete) ? null : 'DAILY_PROFIT_INCOMPLETE');
          try { this.analysis.accounting?.rebuildArchived(); }
          catch { this.logger.warn('accounting derived report rebuild failed'); }
        } catch (error) {
          this.store.finish(job, { row: pendingRow(job.date, 'archive_failed'),
            notices: [error.code === 'DAILY_PROFIT_TIMEOUT' ? '该日统计超时，后台将自动重试。' :
              '该日统计失败，后台将自动重试。'] }, error.code === 'DAILY_PROFIT_TIMEOUT' ? error.code : 'DAILY_PROFIT_FAILED');
        }
      }
    })();
    try { await this.running; } finally { this.running = null; }
  }

  async calculateDay(date, accessToken, { archivePreviousDay = false } = {}) {
    const scope = this.scope();
    const snapshot = this.store.list(scope, date, date)[0];
    // ONLY today's initial archive of yesterday may fetch historical supplier consumption.
    // Every rearchive, rule migration and manual refresh MUST reuse persisted values.
    // Missing older history stays unknown; an upstream zero must never replace it.
    const fetchSupplier = this.canFetchSupplier(date, archivePreviousDay) &&
      (date === this.localNow().toISODate() || snapshot?.row.supplierComplete !== true);
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new AppError('DAILY_PROFIT_TIMEOUT', 'Daily calculation exceeded its time limit', { status: 504 });
        controller.abort(error);
        reject(error);
      }, this.calculationTimeoutMs);
    });
    const operation = (async () => {
      let supplierReader;
      try {
        supplierReader = fetchSupplier ? this.retrySupplierReader(date, snapshot,
          await this.supplierReader(date, accessToken, controller.signal, archivePreviousDay), accessToken) :
          this.archivedSupplierReader(date, snapshot);
      } catch (error) {
        if (!this.analysis.accounting) throw error;
        supplierReader = this.archivedSupplierReader(date, snapshot);
      }
      controller.signal.throwIfAborted();
      const report = await this.analysis.getDailyProfit({ start: date, end: date, currency: 'CNY', refresh: '1' },
        { accessToken, supplierReader, signal: controller.signal });
      if (!fetchSupplier && snapshot?.row.supplierComplete !== true) {
        const notice = '本地归档缺少完整供应商消费；仅当天归档前一天时拉取上游，历史缺口需从备份恢复。';
        report.notices = [...report.notices, notice];
        report.items[0].notices = [...(report.items[0].notices || []), notice];
      }
      controller.signal.throwIfAborted();
      if (scope !== this.scope()) throw new AppError('DAILY_PROFIT_CONFIG_CHANGED', 'Daily data source changed during calculation', { status: 409 });
      return report;
    })();
    try { return await Promise.race([operation, timeout]); }
    finally { clearTimeout(timer); }
  }

  async refreshProvider({ date, providerId }, { accessToken = null } = {}) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) ||
        DateTime.fromISO(String(date), { zone: 'UTC' }).toISODate() !== String(date)) {
      throw new AppError('INVALID_DATE', '统计日期无效', { status: 400 });
    }
    const id = String(providerId || '').trim();
    if (!id || id.length > 200) throw new AppError('INVALID_PROVIDER', '供应商账号无效', { status: 400 });
    const today = this.localNow().toISODate();
    if (date > today) throw new AppError('INVALID_DATE', '不能刷新未来日期的消费', { status: 400 });
    if (date === today) {
      const report = await this.calculateDay(date, accessToken);
      this.lastLive = { key: `${this.scope()}:${today}`, report, at: this.now().getTime() };
      const row = report.items[0];
      const provider = row?.providers?.find((item) => String(item.id) === id);
      if (!provider) throw new AppError('PROVIDER_NOT_FOUND', '供应商账号不存在或未启用定时检查', { status: 404 });
      return { date, mode: 'live', row, provider };
    }
    const scope = this.scope();
    const snapshot = this.store.list(scope, date, date)[0];
    if (!snapshot?.row || snapshot.row.date !== date) {
      throw new AppError('DAILY_PROFIT_NOT_ARCHIVED', '该日期尚未形成历史归档，请等待自动统计后重试', { status: 409 });
    }
    // Manual historical refresh is archive-only, including yesterday before/after 01:00.
    const provider = snapshot.row.providers?.find(item => String(item.id) === id);
    if (!provider) throw new AppError('PROVIDER_NOT_ARCHIVED', '该历史日期没有此供应商的归档消费，请从备份恢复', { status: 409 });
    return { ...snapshot, date, mode: 'archived', row: snapshot.row, provider, reused: true };
  }

  async getDailyProfit(input = {}, { accessToken = null, refreshRange = null } = {}) {
    const { range, currency, granularity } = parseReportInput(input, this.config);
    const local = this.localNow();
    const today = local.toISODate();
    const scope = this.scope();
    const snapshots = new Map(this.store.list(scope, range.start, range.end).map(value => [value.row.date, value]));
    const force = input.recalculate === '1' || input.recalculate === true ||
      (input.accounting === '1' && (input.refresh === '1' || input.refresh === true));
    const items = [], notices = [], queued = [];
    let todayReport;
    if (currency === 'CNY' && range.start <= today && range.end >= today) {
      const liveKey = `${scope}:${today}`;
      const recent = this.lastLive?.key === liveKey && this.now().getTime() - this.lastLive.at < 60000;
      if (input.live === '0') todayReport = this.lastLive?.key === liveKey ? this.lastLive.report :
        { items: [pendingRow(today, 'live_pending')], generatedAt: null, notices: [] };
      else if (input.poll === '1' && recent) todayReport = this.lastLive.report;
      else try {
        if (!this.live.has(liveKey)) this.live.set(liveKey, this.calculateDay(today, accessToken)
          .finally(() => this.live.delete(liveKey)));
        todayReport = await this.live.get(liveKey);
      }
      catch { todayReport = { items: [pendingRow(today, 'live_failed')], generatedAt: this.now().toISOString(),
        notices: ['当日实时统计暂不可用，请稍后刷新。'] }; }
      if (input.live !== '0' && !(input.poll === '1' && recent)) {
        this.lastLive = { key: liveKey, report: todayReport, at: this.now().getTime() };
      }
      notices.push(...todayReport.notices);
    }
    for (let date = range.start; date <= range.end; date = addUtcDays(date, 1)) {
      if (currency !== 'CNY') { items.push(pendingRow(date, 'unsupported_currency')); continue; }
      if (date > today) { items.push(pendingRow(date, 'future')); continue; }
      if (date === today) {
        items.push({ ...todayReport.items[0], mode: 'live', computedAt: todayReport.generatedAt,
          notices: todayReport.items[0].notices || todayReport.notices || [], liveRefreshing: input.live === '0' });
        continue;
      }
      const snapshot = snapshots.get(date);
      const lotteryFieldMissing = Boolean(snapshot?.row) && !Object.hasOwn(snapshot.row, 'lotteryReward');
      const needsRefresh = !snapshot || !snapshot.row.complete || lotteryFieldMissing ||
        (force && (!refreshRange || (date >= refreshRange.start && date <= refreshRange.end))) ||
        (input.accounting === '1' && (!snapshot.row.accountingSource?.complete || snapshot.row.accountingSource.version !== 2));
      if (needsRefresh) {
        const dueAt = date === local.minus({ days: 1 }).toISODate() && local.hour < 1
          ? local.startOf('day').plus({ hours: 1 }).toMillis() : this.now().getTime();
        queued.push({ date, dueAt, fetchSupplier: !force && !snapshot && date === local.minus({ days: 1 }).toISODate() });
      }
      const row = snapshot ? { ...snapshot.row, mode: 'archived', computedAt: snapshot.computedAt,
        notices: snapshot.notices || [], lastAttempt: snapshot.lastAttempt } : { ...pendingRow(date), notices: [] };
      if (snapshot && lotteryFieldMissing) {
        // Keep known site and supplier figures visible while an old snapshot is
        // recalculated with the lottery deduction available in newer versions.
        row.lotteryReward = null;
        row.lotteryComplete = false;
        row.profit = null;
        row.margin = null;
        row.complete = false;
        row.status = row.siteComplete !== true ? 'site_incomplete' :
          row.supplierComplete !== true ? 'supplier_incomplete' : 'lottery_incomplete';
      }
      items.push(row);
      if (snapshot?.lastAttempt?.errorCode && row.complete) {
        notices.push(`${date} 最近更新失败，保留已归档的完整结果，后台自动重试。`);
      } else if (snapshot?.notices) notices.push(...snapshot.notices);
    }
    this.store.enqueueDays(scope, queued, { force });
    const jobs = new Map((currency === 'CNY' ? this.store.jobs(scope, range.start, range.end) : []).map(job => [job.date, job]));
    for (const row of items) if (jobs.has(row.date)) {
      row.archiveStatus = jobs.get(row.date).last_error ? 'retrying' : 'pending';
      row.nextAttemptAt = new Date(jobs.get(row.date).next_attempt_at).toISOString();
    }
    const pendingDays = jobs.size;
    if (currency !== 'CNY') notices.push('每日真实收入仅适用于 CNY。');
    if (pendingDays) notices.push(`${pendingDays} 天历史日报正在等待后台统计或重算。`);
    if (pendingDays && !this.ready(accessToken)) notices.push('自动统计需要可用的主站数据库、监控地址及集成 Token 或有效管理员认证。');
    this.wake(accessToken);
    return { ...dailyProfitReport(items, { range, currency, granularity, timezone: this.config.financeTimezone,
      generatedAt: this.now().toISOString() }, notices),
      live: { date: today, included: currency === 'CNY' && range.start <= today && range.end >= today },
      archive: { pendingDays, schedule: '01:00', timezone: this.config.financeTimezone, ready: Boolean(this.ready(accessToken)) } };
  }
}

module.exports = { DailyProfitService };
