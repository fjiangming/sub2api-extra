'use strict';

const { AppError } = require('./errors');
const { legacyCredit } = require('./reward-credit');

class Lottery {
  constructor(store, source, core) { Object.assign(this, { store, source, core, running: null, stopped: false }); }
  async summary(userId) {
    const total = await this.source.total(userId, this.store.campaign.start_at);
    return this.store.summary(userId, total);
  }
  async draw(user, requestId, count) {
    const existing = this.store.existing(user.id, requestId, count);
    if (existing) { this.kick(); return existing; }
    if (this.stopped) throw new AppError('SERVICE_STOPPING', '服务正在维护，请稍后重试', 503);
    const total = await this.source.total(user.id, this.store.campaign.start_at);
    if (this.stopped) throw new AppError('SERVICE_STOPPING', '服务正在维护，请稍后重试', 503);
    const result = this.store.reserve(user, requestId, count, total);
    this.kick();
    return result;
  }
  start() {
    this.timer = setInterval(() => this.kick(), 15000);
    this.timer.unref();
    this.kick();
  }
  kick() {
    if (this.stopped || this.running) return this.running;
    this.running = this.drain().catch(() => console.error('[activity-center] REWARD_WORKER_ERROR')).finally(() => { this.running = null; });
    return this.running;
  }
  async drain() {
    for (let i = 0; i < 100 && !this.stopped; i++) {
      let row = this.store.claim();
      if (!row) break;
      try {
        let receipt;
        if (legacyCredit(row)) {
          const inspected = await this.source.inspectLegacyCredit(row.credit_code);
          receipt = inspected.receipt;
          if (!receipt) {
            row = this.store.replaceLegacyCredit(row,inspected.codeLimit);
            if (!row) continue;
          }
        }
        if (!receipt) receipt = (await this.core.credit(row))?.redeem_code;
        if (!receipt || receipt.code !== row.credit_code || receipt.type !== row.credit_type || receipt.status !== 'used' ||
          String(receipt.used_by) !== row.user_id || Number(receipt.value) !== row.amount_minor / 100 ||
          !/^[1-9]\d*$/.test(String(receipt.id)) || !Number.isFinite(Date.parse(receipt.used_at)) ||
          receipt.notes !== row.credit_notes) {
          throw new AppError('CREDIT_RECEIPT_UNVERIFIED', '主站入账回执无法核验', 502);
        }
        this.store.settle(row, { id: String(receipt.id), code: receipt.code, type: receipt.type, value: Number(receipt.value),
          status: receipt.status, userId: row.user_id, usedAt: new Date(receipt.used_at).toISOString() });
      } catch (error) {
        const code = error instanceof AppError ? error.code : 'CREDIT_UNAVAILABLE';
        this.store.fail(row, code, ['CREDIT_RECEIPT_UNVERIFIED','CREDIT_LEGACY_REVIEW_REQUIRED','CREDIT_CONTRACT_INVALID'].includes(code));
      }
    }
  }
  async close() { this.stopped = true; clearInterval(this.timer); await this.running; }
}

module.exports = { Lottery };
