'use strict';

const crypto = require('node:crypto');
const { AppError } = require('./errors');

const DAILY_ORDER_LIMIT = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

function dailyWindow(now) {
  const day = new Date(now.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
  const start = Date.parse(`${day}T00:00:00.000Z`) - SHANGHAI_OFFSET_MS;
  return { day, start: new Date(start).toISOString(), end: new Date(start + DAY_MS).toISOString() };
}

class DailyOrderLimit {
  constructor({ db, clock = () => new Date() }) {
    this.db = db;
    this.clock = clock;
    this.countOrders = db.prepare(`
      SELECT (
        SELECT COUNT(*) FROM recharge_orders
        WHERE user_id = @userId AND created_at >= @start AND created_at < @end
      ) + (
        SELECT COUNT(*) FROM official_order_creations
        WHERE user_id = @userId AND created_at >= @start AND created_at < @end
      ) AS used
    `);
  }

  status(userId, now = this.clock()) {
    const window = dailyWindow(now);
    const { used } = this.countOrders.get({ userId, start: window.start, end: window.end });
    return {
      limit: DAILY_ORDER_LIMIT,
      used,
      remaining: Math.max(0, DAILY_ORDER_LIMIT - used),
      day: window.day,
      timeZone: 'Asia/Shanghai',
      resetsAt: window.end
    };
  }

  // Local callers hold the order-creation write lock until the new order is inserted.
  assertAvailable(userId, now = this.clock()) {
    const status = this.status(userId, now);
    if (status.remaining === 0) {
      throw new AppError('DAILY_ORDER_LIMIT_REACHED', '今日创建订单次数已达上限（最多10次），请明日再试', {
        status: 429,
        details: { dailyOrderLimit: status }
      });
    }
    return status;
  }

  reserveOfficial(userId) {
    return this.db.transaction(() => {
      const now = this.clock();
      this.assertAvailable(userId, now);
      const id = crypto.randomUUID();
      this.db.prepare(`
        INSERT INTO official_order_creations(id, user_id, status, created_at)
        VALUES (?, ?, 'pending', ?)
      `).run(id, userId, now.toISOString());
      return id;
    }).immediate();
  }

  confirmOfficial(id, remoteOrderId) {
    this.db.prepare(`
      UPDATE official_order_creations SET status = 'created', remote_order_id = ? WHERE id = ?
    `).run(String(remoteOrderId), id);
  }

  releaseOfficial(id) {
    this.db.prepare("DELETE FROM official_order_creations WHERE id = ? AND status = 'pending'").run(id);
  }
}

module.exports = { DailyOrderLimit, DAILY_ORDER_LIMIT };
