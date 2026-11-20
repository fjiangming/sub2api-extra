'use strict';

const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { targets, publicPolicy, invalid } = require('./services/conversation-push-policy');
const { amountMicros, decimal } = require('./conversation-storage-billing-store');

const BATCH_SIZE = 100, BATCH_MS = 8, INTERVAL_MS = 1000;
const stateColumns = `id,status,phase,filters_json,policy_version,requested_at,updated_at,next_at,
  history_upper,history_cursor,history_scanned,imported,usage_upper,pair_index,pair_count,cursor,
  scanned,updated,batches,bytes,amount_micros`;

class ConversationStoragePricingStore {
  constructor(push) { this.push = push; this.db = push.db; this.now = push.now; }
  initialize() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS cl_push_storage_pricing(
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),id TEXT NOT NULL,status TEXT NOT NULL,phase TEXT NOT NULL,
      filters_json TEXT NOT NULL,rates_json TEXT NOT NULL,policy_version INTEGER NOT NULL,
      requested_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,next_at INTEGER NOT NULL DEFAULT 0,
      history_upper INTEGER NOT NULL,history_cursor INTEGER NOT NULL DEFAULT 0,history_scanned INTEGER NOT NULL DEFAULT 0,
      imported INTEGER NOT NULL DEFAULT 0,usage_upper INTEGER NOT NULL,pair_index INTEGER NOT NULL DEFAULT 0,
      pair_count INTEGER NOT NULL,cursor INTEGER NOT NULL DEFAULT 0,scanned INTEGER NOT NULL DEFAULT 0,
      updated INTEGER NOT NULL DEFAULT 0,batches INTEGER NOT NULL DEFAULT 0,bytes INTEGER NOT NULL DEFAULT 0,
      amount_micros INTEGER NOT NULL DEFAULT 0);`);
    return this;
  }
  status() {
    const row = this.db.prepare(`SELECT ${stateColumns} FROM cl_push_storage_pricing WHERE singleton=1`).safeIntegers(true).get();
    if (!row) return null;
    return { id: row.id, status: row.status, phase: row.phase, filter: JSON.parse(row.filters_json),
      policyVersion: Number(row.policy_version), requestedAt: Number(row.requested_at), updatedAt: Number(row.updated_at),
      historyScanned: Number(row.history_scanned), imported: Number(row.imported), scanned: Number(row.scanned),
      updated: Number(row.updated), batches: Number(row.batches), modelsDone: Number(row.pair_index), models: Number(row.pair_count),
      bytes: Number(row.bytes), terabytes: decimal(row.bytes, 12), amount: decimal(row.amount_micros) };
  }
  pending() { return Boolean(this.db.prepare("SELECT 1 FROM cl_push_storage_pricing WHERE singleton=1 AND status IN ('pending','running')").get()); }
  mutate(action) {
    const timeout = this.db.pragma('busy_timeout', { simple: true });
    this.db.pragma('busy_timeout = 1');
    try { return action(); }
    catch (error) {
      if (/^SQLITE_(?:BUSY|LOCKED)/.test(error.code || '')) throw invalid('归档正在写入，请稍后重试', 'CONVERSATION_STORAGE_PRICING_BUSY', 503);
      throw error;
    } finally { this.db.pragma('busy_timeout = ' + timeout); }
  }
  request(input = {}) {
    const { value } = this.push.billing.selection(input), { page, ...filter } = value;
    return this.mutate(() => this.db.transaction(() => {
      const existing = this.status();
      if (existing && ['pending','running'].includes(existing.status)) {
        if (JSON.stringify(existing.filter) !== JSON.stringify(filter)) throw invalid('已有补记任务，请等待完成或先停止', 'CONVERSATION_STORAGE_PRICING_ACTIVE', 409);
        return existing;
      }
      const policy = this.push.policy(), at = this.now();
      const prices = targets(policy).filter(row => row.billing?.enabled && (!filter.platform || row.id === filter.platform))
        .flatMap(row => row.billing.rates.filter(rate => !filter.model || rate.model === filter.model)
          .map(rate => ({ platform: row.id, model: rate.model, price: rate.price, version: row.billing.version })));
      const history = this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='cl_push_jsonl_files'").get()
        ? this.db.prepare('SELECT COALESCE(MAX(rowid),0) n FROM cl_push_jsonl_files').get().n : 0;
      const upper = this.db.prepare('SELECT COALESCE(MAX(rowid),0) n FROM cl_push_storage_usage').get().n;
      this.db.prepare('DELETE FROM cl_push_storage_pricing WHERE singleton=1').run();
      this.db.prepare(`INSERT INTO cl_push_storage_pricing(singleton,id,status,phase,filters_json,rates_json,policy_version,
        requested_at,updated_at,history_upper,usage_upper,pair_count) VALUES(1,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(crypto.randomUUID(), prices.length ? 'pending' : 'done', history ? 'history' : 'pricing', JSON.stringify(filter),
          JSON.stringify(prices), policy.version, at, at, history, upper, prices.length);
      return this.status();
    }).immediate());
  }
  cancel(id) {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw invalid('补记任务无效');
    return this.mutate(() => {
      this.db.prepare("UPDATE cl_push_storage_pricing SET status='cancelled',updated_at=? WHERE singleton=1 AND id=? AND status IN ('pending','running')").run(this.now(), id);
      return this.status();
    });
  }
  snapshot(job) {
    if (this.cached?.id !== job.id) this.cached = { id: job.id, filter: JSON.parse(job.filters_json),
      prices: JSON.parse(this.db.prepare('SELECT rates_json FROM cl_push_storage_pricing WHERE singleton=1').get().rates_json) };
    if (job.phase === 'history' && !this.cached.policy) {
      this.cached.policy = publicPolicy(this.push.policy(job.policy_version));
      this.cached.models = new Map();
      for (const price of this.cached.prices) {
        if (!this.cached.models.has(price.platform)) this.cached.models.set(price.platform, new Set());
        this.cached.models.get(price.platform).add(price.model);
      }
    }
    return this.cached;
  }
  step({ canWork = () => true } = {}) {
    if (!canWork()) return { worked: false };
    const timeout = this.db.pragma('busy_timeout', { simple: true }), checkpoint = this.db.pragma('wal_autocheckpoint', { simple: true });
    this.db.pragma('busy_timeout = 1'); this.db.pragma('wal_autocheckpoint = 0');
    try {
      const pending = this.db.prepare(`SELECT ${stateColumns} FROM cl_push_storage_pricing WHERE singleton=1 AND status IN ('pending','running')`).get();
      if (!pending || this.now() < pending.next_at) return { worked: false };
      // Decode the bounded configuration once, before acquiring the writer lock.
      const snapshot = this.snapshot(pending);
      // Prices and the cursor commit together. Competing/restarted workers cannot repeat a batch or bypass its pacing.
      const result = this.db.transaction(() => {
        const job = this.db.prepare(`SELECT ${stateColumns} FROM cl_push_storage_pricing WHERE singleton=1 AND status IN ('pending','running')`).get();
        if (!job || job.id !== pending.id || this.now() < job.next_at || !canWork()) return { worked: false };
        const began = performance.now();
        const allowed = () => canWork() && performance.now() - began < BATCH_MS;
        return job.phase === 'history' ? this.importHistory(job, snapshot, allowed) : this.price(job, snapshot, allowed);
      }).immediate();
      // Reuse WAL pages during long jobs without holding the pricing transaction or waiting for readers.
      if (result.worked && (result.completed || this.now() >= (this.nextCheckpoint || 0)) && canWork()) {
        this.nextCheckpoint = this.now() + 5000;
        try { this.db.pragma('wal_checkpoint(PASSIVE)'); } catch { /* The next idle batch retries checkpoint maintenance. */ }
      }
      return result;
    } catch (error) {
      if (/^SQLITE_(?:BUSY|LOCKED)/.test(error.code || '')) return { worked: false, busy: true };
      throw error;
    } finally { this.db.pragma('busy_timeout = ' + timeout); this.db.pragma('wal_autocheckpoint = ' + checkpoint); }
  }
  importHistory(job, snapshot, allowed) {
    const rows = this.db.prepare('SELECT rowid cursor,* FROM cl_push_jsonl_files WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT ?')
      .all(job.history_cursor, job.history_upper, BATCH_SIZE);
    let scanned = 0, imported = 0, cursor = job.history_cursor;
    const exists = this.db.prepare('SELECT 1 FROM cl_push_storage_usage WHERE id=?'), filter = snapshot.filter;
    for (const row of rows) {
      if (!allowed()) break;
      scanned++; cursor = row.cursor;
      if (row.status !== 'sent' || row.updated_at > job.requested_at || exists.get('jsonl:' + row.id)) continue;
      if (!snapshot.models.get(row.destination)?.has(row.model) || filter.start && row.day < filter.start || filter.end && row.day > filter.end) continue;
      imported += this.push.billing.recordFile(row, snapshot.policy, true);
    }
    const finished = !rows.length || cursor >= job.history_upper;
    const upper = finished ? this.db.prepare('SELECT COALESCE(MAX(rowid),0) n FROM cl_push_storage_usage').get().n : job.usage_upper;
    this.db.prepare(`UPDATE cl_push_storage_pricing SET status='running',phase=?,history_cursor=?,history_scanned=history_scanned+?,
      imported=imported+?,usage_upper=?,next_at=?,updated_at=? WHERE singleton=1`)
      .run(finished ? 'pricing' : 'history', cursor, scanned, imported, upper, this.now() + INTERVAL_MS, this.now());
    return { worked: true, scanned, imported, updated: 0 };
  }
  price(job, snapshot, allowed) {
    // The existing partial platform/model index also indexes rowid. Date filtering happens after the bounded seek,
    // so a sparse date range cannot turn one batch into an unbounded scan or sort of the remaining ledger.
    const select = this.db.prepare(`SELECT rowid cursor,id,bytes,log_date,delivered_at FROM cl_push_storage_usage INDEXED BY cl_push_storage_unpriced
      WHERE platform_id=? AND model=? AND rate IS NULL AND rowid>? AND rowid<=? ORDER BY rowid LIMIT ?`);
    const update = this.db.prepare('UPDATE cl_push_storage_usage SET rate=?,rate_version=?,amount_micros=?,billing_enabled=1 WHERE id=? AND rate IS NULL');
    let pair = job.pair_index, cursor = job.cursor, scanned = 0, updated = 0, bytes = 0n, amount = 0n, seeks = 0;
    while (pair < snapshot.prices.length && scanned < BATCH_SIZE && seeks < 128 && allowed()) {
      const rate = snapshot.prices[pair], rows = select.all(rate.platform, rate.model, cursor, job.usage_upper, BATCH_SIZE - scanned);
      seeks++;
      if (!rows.length) { pair++; cursor = 0; continue; }
      for (const row of rows) {
        if (!allowed()) break;
        scanned++; cursor = row.cursor;
        if (row.delivered_at > job.requested_at || snapshot.filter.start && row.log_date < snapshot.filter.start || snapshot.filter.end && row.log_date > snapshot.filter.end) continue;
        const cost = amountMicros(row.bytes, rate.price);
        const changed = update.run(rate.price, rate.version, cost, row.id).changes;
        updated += changed;
        if (changed) { bytes += BigInt(row.bytes); amount += cost; }
      }
    }
    this.db.prepare(`UPDATE cl_push_storage_pricing SET status=?,pair_index=?,cursor=?,scanned=scanned+?,updated=updated+?,
      batches=batches+1,bytes=bytes+?,amount_micros=amount_micros+?,next_at=?,updated_at=? WHERE singleton=1`)
      .run(pair >= snapshot.prices.length ? 'done' : 'running', pair, cursor, scanned, updated, bytes, amount, this.now() + INTERVAL_MS, this.now());
    return { worked: true, scanned, updated, completed: pair >= snapshot.prices.length };
  }
}

module.exports = { ConversationStoragePricingStore, BATCH_SIZE, INTERVAL_MS };
