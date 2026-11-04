'use strict';

const crypto = require('node:crypto');
const cron = require('node-cron');
const { DateTime } = require('luxon');
const { addUtcDays } = require('./metrics-service');
const { parseReportInput, dailyProfitReport } = require('./cost-analysis-service');
const { AppError } = require('../errors');

function pendingRow(date, status = 'pending_archive') {
  return { date, status, siteConsumption: null, supplierConsumption: null, profit: null, margin: null,
    siteRequests: null, supplierRequests: null, complete: false, siteComplete: false,
    supplierComplete: false, providers: [] };
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

  ready(accessToken) {
    if (this.analysis.accounting && this.analysis.pool?.configured?.() !== false) return true;
    return this.analysis.pool?.configured?.() !== false && this.analysis.providerMonitor?.configured() && Boolean(
      this.analysis.providerMonitor.integrationToken || accessToken || this.analysis.sub2api?.configured());
  }

  async supplierReader(accessToken, signal) {
    if (!this.analysis.createSupplierDailyCostsReader) return null;
    const key = crypto.createHash('sha256').update(JSON.stringify([this.scope(), accessToken,
      this.analysis.providerMonitor?.integrationToken, this.config.sub2apiAdminToken,
      this.config.sub2apiAdminEmail, this.config.sub2apiAdminPassword,
      this.analysis.sub2api?.activeRuntimeToken?.()])).digest('hex');
    if (this.readerCache?.key === key && this.readerCache.until > this.now().getTime()) return this.readerCache.read;
    const reader = await this.analysis.createSupplierDailyCostsReader(accessToken, { signal });
    signal?.throwIfAborted();
    const read = async (query, options) => {
      try { return await reader(query, options); }
      catch (error) { if (this.readerCache?.key === key) this.readerCache = null; throw error; }
    };
    this.readerCache = { key, read, until: this.now().getTime() + 300000 };
    return read;
  }

  scheduleDue() {
    const local = this.localNow();
    const target = local.minus({ days: local.hour >= 1 ? 1 : 2 }).toISODate();
    const scope = this.scope();
    const previous = this.store.metadata(scope, 'scheduled_through');
    let date = previous ? addUtcDays(previous, 1) : target;
    const days = [];
    // Bound recovery after a long outage; later ticks continue from the saved cursor.
    for (let count = 0; date <= target && count < 366; count++, date = addUtcDays(date, 1)) {
      days.push({ date });
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
          const report = await this.calculateDay(job.date, accessToken);
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

  async calculateDay(date, accessToken) {
    const scope = this.scope();
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
      try { supplierReader = await this.supplierReader(accessToken, controller.signal); }
      catch (error) { if (!this.analysis.accounting) throw error; }
      controller.signal.throwIfAborted();
      const report = await this.analysis.getDailyProfit({ start: date, end: date, currency: 'CNY', refresh: '1' },
        { accessToken, supplierReader, signal: controller.signal });
      controller.signal.throwIfAborted();
      if (scope !== this.scope()) throw new AppError('DAILY_PROFIT_CONFIG_CHANGED', 'Daily data source changed during calculation', { status: 409 });
      return report;
    })();
    try { return await Promise.race([operation, timeout]); }
    finally { clearTimeout(timer); }
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
      if (!snapshot || !snapshot.row.complete || (force && (!refreshRange || (date >= refreshRange.start && date <= refreshRange.end))) ||
          (input.accounting === '1' && (!snapshot.row.accountingSource?.complete || snapshot.row.accountingSource.version !== 2))) {
        const dueAt = date === local.minus({ days: 1 }).toISODate() && local.hour < 1
          ? local.startOf('day').plus({ hours: 1 }).toMillis() : this.now().getTime();
        queued.push({ date, dueAt });
      }
      const row = snapshot ? { ...snapshot.row, mode: 'archived', computedAt: snapshot.computedAt,
        notices: snapshot.notices || [], lastAttempt: snapshot.lastAttempt } : { ...pendingRow(date), notices: [] };
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
