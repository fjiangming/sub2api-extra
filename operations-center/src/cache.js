'use strict';

class BoundedTtlCache {
  constructor({ ttlMs = 60000, maxEntries = 100 } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.items = new Map();
  }

  get(key) {
    const entry = this.items.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.items.delete(key);
      return undefined;
    }
    this.items.delete(key);
    this.items.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    if (this.ttlMs <= 0) return value;
    this.items.delete(key);
    this.items.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    while (this.items.size > this.maxEntries) {
      this.items.delete(this.items.keys().next().value);
    }
    return value;
  }

  clear() {
    this.items.clear();
  }
}

module.exports = { BoundedTtlCache };
