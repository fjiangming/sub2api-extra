'use strict';

const { AppError } = require('./errors');

class BoundedCache {
  constructor({ ttlMs, maxEntries, maxPending = 8, now = Date.now }) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.maxPending = maxPending;
    this.now = now;
    this.items = new Map();
    this.pending = new Map();
  }

  async getOrLoad(key, load) {
    const cached = this.items.get(key);
    if (cached?.expiresAt > this.now()) {
      this.items.delete(key);
      this.items.set(key, cached);
      return cached.value;
    }
    this.items.delete(key);
    if (this.pending.has(key)) return this.pending.get(key);
    if (this.pending.size >= this.maxPending) throw new AppError('SERVICE_BUSY', '访问人数较多，请稍后重试', 503);
    const promise = Promise.resolve().then(load).then((value) => {
      this.items.set(key, { value, expiresAt: this.now() + this.ttlMs });
      while (this.items.size > this.maxEntries) this.items.delete(this.items.keys().next().value);
      return value;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }

  clear() { this.items.clear(); }
}

module.exports = { BoundedCache };
