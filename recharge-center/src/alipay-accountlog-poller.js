'use strict';

const { AppError } = require('./errors');

const PAGE_SIZE = 1000;
const MAX_PAGES_PER_POLL = 20;

class AlipayAccountLogPoller {
  constructor({ client, orders, config, clock = () => new Date(), setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.client = client;
    this.orders = orders;
    this.config = config;
    this.clock = clock;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
    this.running = null;
    this.closed = false;
    this.started = false;
    this.lastAttemptAt = null;
    this.lastSuccessAt = null;
    this.lastErrorCode = null;
    this.consecutiveFailures = 0;
  }

  start() {
    if (this.started || this.closed) return;
    this.started = true;
    this.#schedule(0);
  }

  #schedule(delayMs) {
    if (this.closed) return;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.pollNow().catch(() => {});
    }, delayMs);
    this.timer?.unref?.();
  }

  async pollNow() {
    if (this.closed) throw new AppError('ACCOUNTLOG_POLLER_CLOSED', '支付宝账务轮询器已关闭', { status: 503 });
    if (this.running) return this.running;
    this.running = this.#poll();
    try {
      return await this.running;
    } finally {
      this.running = null;
    }
  }

  async #poll() {
    const observedNow = this.clock();
    this.lastAttemptAt = observedNow.toISOString();
    let nextDelayMs = this.config.accountLogPollSeconds * 1000;
    try {
      const startTime = new Date(observedNow.getTime() - this.config.accountLogLookbackSeconds * 1000);
      const endTime = new Date(observedNow.getTime() + 1000);
      const entries = [];
      let pageNo = 1;
      let totalSize = 0;
      let pageCount = 1;
      do {
        const page = await this.client.queryPage({ startTime, endTime, pageNo, pageSize: PAGE_SIZE });
        entries.push(...page.entries);
        totalSize = page.totalSize;
        pageCount = Math.max(1, Math.ceil(totalSize / page.pageSize));
        if (pageCount > MAX_PAGES_PER_POLL) {
          throw new AppError(
            'ALIPAY_ACCOUNTLOG_VOLUME_EXCEEDED',
            '支付宝账务流水量超过单次安全处理上限，已停止自动创建新订单',
            { status: 503 }
          );
        }
        pageNo += 1;
      } while (pageNo <= pageCount);

      entries.sort((left, right) => left.paidAt.localeCompare(right.paidAt) ||
        left.accountLogId.localeCompare(right.accountLogId));
      for (const entry of entries) await this.orders.acceptAccountLogEntry(entry);

      this.lastSuccessAt = this.clock().toISOString();
      this.lastErrorCode = null;
      this.consecutiveFailures = 0;
      return { entries: entries.length, totalSize, completedAt: this.lastSuccessAt };
    } catch (error) {
      this.lastErrorCode = error?.code || 'ACCOUNTLOG_POLL_FAILED';
      this.consecutiveFailures += 1;
      nextDelayMs = Math.max(nextDelayMs, Number(error?.retryAfterMs) || 0);
      if (this.config.env !== 'test') {
        console.error(JSON.stringify({
          level: 'error',
          code: this.lastErrorCode,
          message: '支付宝账务轮询失败；已关闭新订单入口并等待重试',
          consecutiveFailures: this.consecutiveFailures
        }));
      }
      throw error;
    } finally {
      if (!this.closed) this.#schedule(nextDelayMs);
    }
  }

  status() {
    const lastSuccessMs = Date.parse(this.lastSuccessAt || '');
    const stale = !Number.isFinite(lastSuccessMs) ||
      this.clock().getTime() - lastSuccessMs > this.config.accountLogStaleSeconds * 1000;
    return {
      required: true,
      healthy: !this.closed && !stale && !this.lastErrorCode,
      running: Boolean(this.running),
      lastAttemptAt: this.lastAttemptAt,
      lastSuccessAt: this.lastSuccessAt,
      lastErrorCode: this.lastErrorCode,
      consecutiveFailures: this.consecutiveFailures
    };
  }

  assertReady() {
    if (!this.status().healthy) {
      throw new AppError(
        'ACCOUNTLOG_POLLER_NOT_READY',
        '支付宝账务查询暂不可用，为防止无法确认付款，当前暂停创建充值订单',
        { status: 503 }
      );
    }
  }

  close() {
    this.closed = true;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }
}

module.exports = { AlipayAccountLogPoller, MAX_PAGES_PER_POLL, PAGE_SIZE };
