'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { AppError } = require('./errors');
const { sample, PRIZES } = require('./prizes');

const ACTIVITY = Object.freeze({ id: 'recharge-lottery', name: '充值抽奖', kind: 'wheel' });
function day(value, timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}
function publicReward(row, admin = false) {
  const result = { id: row.id, batchId: row.batch_id, sequence: row.sequence, amountMinor: row.amount_minor,
    status: row.status, createdAt: row.created_at, creditedAt: row.credited_at, activity: ACTIVITY.name };
  if (admin) Object.assign(result, { userId: row.user_id, email: row.user_email, name: row.user_name,
    attempts: row.attempts, errorCode: row.error_code, receipt: row.receipt ? JSON.parse(row.receipt) : null });
  return result;
}

class Store {
  constructor(config, { filename, now = Date.now, rng } = {}) {
    this.config = config;
    this.now = now;
    this.rng = rng;
    if (!filename) fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    this.db = new Database(filename || path.join(config.dataDir, 'activity-center.sqlite'));
    try { this.initialize(config, now); } catch (error) { this.db.close(); throw error; }
  }
  initialize(config, now) {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    if (this.db.pragma('user_version', { simple: true }) > 1) throw new Error('活动数据库版本高于当前程序');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS campaign (
        id TEXT PRIMARY KEY, start_at TEXT NOT NULL, timezone TEXT NOT NULL, sources TEXT NOT NULL, source_scope TEXT NOT NULL,
        probability_version INTEGER NOT NULL CHECK(probability_version=1)
      );
      CREATE TABLE IF NOT EXISTS accounts (
        user_id TEXT PRIMARY KEY, used INTEGER NOT NULL DEFAULT 0 CHECK(used>=0)
      );
      CREATE TABLE IF NOT EXISTS batches (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, request_id TEXT NOT NULL, count INTEGER NOT NULL,
        recharge_minor INTEGER NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(user_id,request_id), CHECK(count IN (1,10,20,50))
      );
      CREATE TABLE IF NOT EXISTS rewards (
        id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES batches(id), sequence INTEGER NOT NULL,
        user_id TEXT NOT NULL, user_email TEXT NOT NULL, user_name TEXT NOT NULL,
        amount_minor INTEGER NOT NULL CHECK(amount_minor IN (50,100,200,300,500,1000,2000,5000)),
        credit_code TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','failed')),
        created_at TEXT NOT NULL, created_day TEXT NOT NULL, credited_at TEXT, credited_day TEXT,
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
        lease_until INTEGER NOT NULL DEFAULT 0, error_code TEXT, receipt TEXT,
        UNIQUE(batch_id,sequence)
      );
      CREATE INDEX IF NOT EXISTS rewards_user ON rewards(user_id,created_at DESC,id);
      CREATE INDEX IF NOT EXISTS rewards_queue ON rewards(status,next_attempt_at,lease_until);
      CREATE INDEX IF NOT EXISTS rewards_ledger ON rewards(created_day DESC,created_at DESC,id);
      CREATE INDEX IF NOT EXISTS rewards_credited ON rewards(status,credited_day);
      CREATE TABLE IF NOT EXISTS retry_audit (
        id INTEGER PRIMARY KEY, reward_id TEXT NOT NULL REFERENCES rewards(id), actor_id TEXT NOT NULL, created_at TEXT NOT NULL
      );
      PRAGMA user_version = 1;
    `);
    this.db.transaction(() => {
      let campaign = this.db.prepare('SELECT * FROM campaign WHERE id=?').get(ACTIVITY.id);
      const sources = [...config.sources].sort().join(',');
      const dbUrl = config.databaseUrl ? new URL(config.databaseUrl) : null;
      const scope = crypto.createHash('sha256').update(JSON.stringify([config.sub2apiBaseUrl, dbUrl ? `${dbUrl.host}${dbUrl.pathname}` : null, config.rechargeUrl || null])).digest('hex');
      if (!campaign) {
        this.db.prepare('INSERT INTO campaign VALUES (?,?,?,?,?,1)').run(ACTIVITY.id, new Date(now()).toISOString(), config.timezone, sources, scope);
        campaign = this.db.prepare('SELECT * FROM campaign WHERE id=?').get(ACTIVITY.id);
      }
      if (campaign.sources !== sources || campaign.timezone !== config.timezone || campaign.source_scope !== scope) throw new Error('已存在活动的充值来源和时区不能直接更改，请保留原配置与数据库');
      this.campaign = campaign;
    }).immediate();
  }
  registry() { return [{ ...ACTIVITY, enabled: this.config.enabled && this.now() >= Date.parse(this.campaign.start_at), prizes: PRIZES.map(p => p.amount) }]; }
  used(userId) { return this.db.prepare('SELECT used FROM accounts WHERE user_id=?').get(userId)?.used || 0; }
  summary(userId, rechargeMinor) {
    const sums = this.db.prepare(`SELECT COUNT(*) AS draws, COALESCE(SUM(CASE WHEN status='paid' THEN amount_minor ELSE 0 END),0) AS paid,
      COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END),0) AS pending,
      COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END),0) AS failed FROM rewards WHERE user_id=?`).get(userId);
    return { available: Math.max(0, Math.floor(rechargeMinor / 5000) - this.used(userId)),
      drawn: sums.draws, creditedMinor: sums.paid, pending: sums.pending, failed: sums.failed, enabled: this.registry()[0].enabled };
  }
  existing(userId, requestId, count) {
    const batch = this.db.prepare('SELECT * FROM batches WHERE user_id=? AND request_id=?').get(userId, requestId);
    if (!batch) return null;
    if (batch.count !== count) throw new AppError('IDEMPOTENCY_CONFLICT', '同一次请求的抽奖数量不一致', 409);
    return this.batch(userId, batch.id);
  }
  reserve(user, requestId, count, rechargeMinor) {
    return this.db.transaction(() => {
      const existing = this.existing(user.id, requestId, count);
      if (existing) return existing;
      if (!this.registry()[0].enabled) throw new AppError('ACTIVITY_UNAVAILABLE', '活动暂未开放', 409);
      if (!Number.isSafeInteger(rechargeMinor) || rechargeMinor < 0) throw new AppError('RECHARGE_UNVERIFIED', '充值信息无法核验', 503);
      if (![1, 10, 20, 50].includes(count)) throw new AppError('INVALID_COUNT', '抽奖数量无效');
      if (Math.floor(rechargeMinor / 5000) - this.used(user.id) < count) throw new AppError('CHANCES_INSUFFICIENT', '可用抽奖次数不足', 409);
      const batchId = crypto.randomUUID();
      const at = new Date(this.now()).toISOString();
      this.db.prepare('INSERT INTO batches VALUES (?,?,?,?,?,?)').run(batchId, user.id, requestId, count, rechargeMinor, at);
      this.db.prepare('INSERT INTO accounts VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET used=used+excluded.used').run(user.id, count);
      const insert = this.db.prepare(`INSERT INTO rewards(id,batch_id,sequence,user_id,user_email,user_name,amount_minor,credit_code,created_at,created_day)
        VALUES (?,?,?,?,?,?,?,?,?,?)`);
      for (let index = 1; index <= count; index++) {
        insert.run(crypto.randomUUID(), batchId, index, user.id, user.email, user.name, sample(rechargeMinor, this.rng),
          `AC-${crypto.randomBytes(24).toString('hex')}`, at, day(at, this.config.timezone));
      }
      return this.batch(user.id, batchId);
    }).immediate();
  }
  batch(userId, id) {
    const batch = this.db.prepare('SELECT id,count,created_at FROM batches WHERE id=? AND user_id=?').get(id, userId);
    if (!batch) throw new AppError('BATCH_NOT_FOUND', '抽奖记录不存在', 404);
    return { id: batch.id, count: batch.count, createdAt: batch.created_at,
      rewards: this.db.prepare('SELECT * FROM rewards WHERE batch_id=? ORDER BY sequence').all(id).map(r => publicReward(r)) };
  }
  list({ userId, query = '', from, to, status, page = 1, pageSize = 20 } = {}) {
    const clauses = [];
    const params = [];
    if (userId) { clauses.push('user_id=?'); params.push(userId); }
    if (status) { clauses.push('status=?'); params.push(status); }
    if (from) { clauses.push('created_day>=?'); params.push(from); }
    if (to) { clauses.push('created_day<=?'); params.push(to); }
    if (query) {
      clauses.push("(instr(lower(user_email),lower(?))>0 OR instr(lower(user_name),lower(?))>0 OR user_id=? OR id=? OR batch_id=? OR instr(COALESCE(receipt,''),?)>0)");
      params.push(query, query, query, query, query, query);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = this.db.prepare(`SELECT COUNT(*) AS total FROM rewards ${where}`).get(...params).total;
    const rows = this.db.prepare(`SELECT * FROM rewards ${where} ORDER BY created_at DESC,batch_id DESC,sequence DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize);
    return { rows: rows.map(r => publicReward(r, !userId)), total, page, pageSize };
  }
  detail(id) {
    const row = this.db.prepare('SELECT * FROM rewards WHERE id=?').get(id);
    if (!row) throw new AppError('REWARD_NOT_FOUND', '奖励记录不存在', 404);
    return { ...publicReward(row, true), retries: this.db.prepare('SELECT actor_id AS actorId,created_at AS createdAt FROM retry_audit WHERE reward_id=? ORDER BY id').all(id) };
  }
  ledgerSummary() {
    const result = this.db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status='paid' THEN amount_minor ELSE 0 END),0) AS totalMinor,
      COALESCE(SUM(CASE WHEN status='paid' AND credited_day=? THEN amount_minor ELSE 0 END),0) AS todayMinor,
      COUNT(DISTINCT CASE WHEN status='paid' THEN user_id END) AS recipients,
      COALESCE(SUM(status='paid'),0) AS paidCount,
      COALESCE(SUM(status='pending'),0) AS pendingCount, COALESCE(SUM(status='failed'),0) AS failedCount,
      COALESCE(SUM(CASE WHEN status='pending' THEN amount_minor ELSE 0 END),0) AS pendingMinor,
      COALESCE(SUM(CASE WHEN status='failed' THEN amount_minor ELSE 0 END),0) AS failedMinor FROM rewards`).get(day(this.now(), this.config.timezone));
    if (Object.values(result).some(v => !Number.isSafeInteger(v))) throw new AppError('SUMMARY_OVERFLOW', '奖励汇总超出支持范围', 503);
    return result;
  }
  claim() {
    return this.db.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM rewards WHERE status='pending' AND next_attempt_at<=? AND lease_until<=?
        ORDER BY next_attempt_at,created_at,sequence LIMIT 1`).get(this.now(), this.now());
      if (!row) return null;
      this.db.prepare('UPDATE rewards SET attempts=attempts+1,lease_until=? WHERE id=?').run(this.now() + 60000, row.id);
      return { ...row, attempts: row.attempts + 1 };
    }).immediate();
  }
  settle(row, receipt) {
    const at = receipt.usedAt;
    return this.db.prepare(`UPDATE rewards SET status='paid',receipt=?,credited_at=?,credited_day=?,lease_until=0,error_code=NULL
      WHERE id=? AND status='pending' AND attempts=?`).run(JSON.stringify(receipt), at, day(at, this.config.timezone), row.id, row.attempts).changes;
  }
  fail(row, code, permanent = false) {
    const failed = permanent || row.attempts >= 8;
    this.db.prepare(`UPDATE rewards SET status=?,lease_until=0,error_code=?,next_attempt_at=? WHERE id=? AND status='pending' AND attempts=?`)
      .run(failed ? 'failed' : 'pending', code, this.now() + Math.min(3600000, 15000 * 2 ** Math.min(row.attempts, 8)), row.id, row.attempts);
  }
  retry(id, actorId) {
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM rewards WHERE id=?').get(id);
      if (!row) throw new AppError('REWARD_NOT_FOUND', '奖励记录不存在', 404);
      if (row.status !== 'failed') throw new AppError('RETRY_NOT_ALLOWED', '只有入账异常的奖励可以重试', 409);
      this.db.prepare("UPDATE rewards SET status='pending',next_attempt_at=0,lease_until=0 WHERE id=?").run(id);
      this.db.prepare('INSERT INTO retry_audit(reward_id,actor_id,created_at) VALUES (?,?,?)').run(id, actorId, new Date(this.now()).toISOString());
    }).immediate();
    return this.detail(id);
  }
  close() { this.db.close(); }
}

module.exports = { Store, ACTIVITY, day };
