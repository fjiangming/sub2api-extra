'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { AppError } = require('./errors');
const { sample, sampleWeights, PRIZES, COMPENSATION_DEFAULT_WEIGHTS } = require('./prizes');
const { creditCode, creditNotes, legacyCredit } = require('./reward-credit');

const ACTIVITY = Object.freeze({ id: 'recharge-lottery', name: '充值抽奖', kind: 'wheel' });
const DEFAULT_COMPENSATION_PROFILE_ID = 'compensation-standard-v1';
const AUDIT_REQUIRED = `CASE WHEN r.chance_source='recharge' THEN CASE r.amount_minor ${PRIZES.filter(p => p.minimum > 0).map(p => `WHEN ${p.amount} THEN ${p.minimum}`).join(' ')} ELSE 0 END ELSE 0 END`;
const AUDIT_SNAPSHOT_VALID = `(b.user_id=r.user_id AND typeof(b.recharge_minor)='integer' AND b.recharge_minor BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER})`;
const AUDIT_STATUS = `CASE WHEN (${AUDIT_REQUIRED})=0 THEN 'not_required'
  WHEN NOT COALESCE(${AUDIT_SNAPSHOT_VALID},0) THEN 'unverifiable'
  WHEN b.recharge_minor<(${AUDIT_REQUIRED}) THEN 'violation' ELSE 'passed' END`;
const ADMIN_REWARDS_FROM = 'FROM rewards r LEFT JOIN batches b ON b.id=r.batch_id';
const ADMIN_REWARDS_SELECT = `r.*, (${AUDIT_REQUIRED}) AS audit_required_minor, (${AUDIT_STATUS}) AS audit_status,
  CASE WHEN ${AUDIT_SNAPSHOT_VALID} THEN b.recharge_minor END AS audit_recharge_minor`;
function day(value, timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}
function weightsJson(weights) {
  const expected = new Map(PRIZES.map(prize => [prize.amount, 0]));
  const seen = new Set();
  if (!Array.isArray(weights) || weights.length !== PRIZES.length) throw new AppError('INVALID_PROFILE', '概率方案必须包含全部奖项');
  for (const item of weights) {
    const amount = item?.amount ?? item?.amountMinor;
    if (!Number.isInteger(amount) || !expected.has(amount) || !Number.isInteger(item.weight) || item.weight < 0 || item.weight > 10000) throw new AppError('INVALID_PROFILE', '概率方案数值无效');
    if (seen.has(amount)) throw new AppError('INVALID_PROFILE', '概率方案包含重复奖项');
    seen.add(amount);
    expected.set(amount, item.weight);
  }
  if ([...expected.values()].reduce((sum, value) => sum + value, 0) !== 10000) throw new AppError('INVALID_PROFILE', '概率总和必须为 100%');
  return JSON.stringify(PRIZES.map(prize => ({ amount: prize.amount, weight: expected.get(prize.amount) })));
}
function parseWeights(value) {
  try {
    const parsed = JSON.parse(value);
    return JSON.parse(weightsJson(parsed));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('INVALID_PROFILE', '概率方案数据无效');
  }
}
function iso(value, name, { optional = false } = {}) {
  if (value == null && optional) return null;
  const parsed = new Date(value);
  if (!value || !Number.isFinite(parsed.getTime())) throw new AppError('INVALID_REQUEST', `${name}格式无效`);
  return parsed.toISOString();
}
function publicReward(row, admin = false) {
  const result = { id: row.id, batchId: row.batch_id, sequence: row.sequence, amountMinor: row.amount_minor,
    status: row.status, createdAt: row.created_at, creditedAt: row.credited_at, activity: ACTIVITY.name };
  if (admin) Object.assign(result, { userId: row.user_id, email: row.user_email, name: row.user_name,
    attempts: row.attempts, errorCode: row.error_code, receipt: row.receipt ? JSON.parse(row.receipt) : null,
    audit: { status: row.audit_status, requiredMinor: row.audit_required_minor, rechargeMinor: row.audit_recharge_minor },
    chanceSource: row.chance_source, grantId: row.grant_id, profileId: row.profile_id,
    creditMigration: row.credit_migration ? JSON.parse(row.credit_migration) : null });
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
    if (this.db.pragma('user_version', { simple: true }) > 4) throw new Error('活动数据库版本高于当前程序');
    this.db.transaction(() => {
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
        credit_type TEXT NOT NULL DEFAULT 'balance' CHECK(credit_type IN ('balance','affiliate_balance')),
        credit_notes TEXT, credit_migration TEXT,
        chance_source TEXT NOT NULL DEFAULT 'recharge' CHECK(chance_source IN ('recharge','compensation')),
        grant_id TEXT, profile_id TEXT,
        created_at TEXT NOT NULL, created_day TEXT NOT NULL, credited_at TEXT, credited_day TEXT,
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
        lease_until INTEGER NOT NULL DEFAULT 0, error_code TEXT, receipt TEXT,
        UNIQUE(batch_id,sequence)
      );
      CREATE INDEX IF NOT EXISTS rewards_user ON rewards(user_id,created_at DESC,id);
      CREATE INDEX IF NOT EXISTS rewards_queue ON rewards(status,next_attempt_at,lease_until);
      CREATE INDEX IF NOT EXISTS rewards_ledger ON rewards(created_day DESC,created_at DESC,id);
      CREATE INDEX IF NOT EXISTS rewards_credited ON rewards(status,credited_day);
      CREATE TABLE IF NOT EXISTS compensation_profiles (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, weights_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'enabled' CHECK(status IN ('enabled','disabled')),
        version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS compensation_grants (
        id TEXT PRIMARY KEY, audience TEXT NOT NULL CHECK(audience IN ('all','selected')),
        chance_count INTEGER NOT NULL CHECK(chance_count BETWEEN 1 AND 100000), profile_id TEXT NOT NULL,
        profile_name TEXT NOT NULL, weights_json TEXT NOT NULL, starts_at TEXT NOT NULL, expires_at TEXT,
        reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
        created_at TEXT NOT NULL, created_by TEXT NOT NULL,
        FOREIGN KEY(profile_id) REFERENCES compensation_profiles(id)
      );
      CREATE TABLE IF NOT EXISTS compensation_grant_users (
        grant_id TEXT NOT NULL REFERENCES compensation_grants(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0 CHECK(used>=0), created_at TEXT NOT NULL,
        PRIMARY KEY(grant_id,user_id)
      );
      CREATE INDEX IF NOT EXISTS compensation_grants_active ON compensation_grants(status,starts_at,expires_at,created_at);
      CREATE INDEX IF NOT EXISTS compensation_grant_users_user ON compensation_grant_users(user_id,grant_id);
      CREATE TABLE IF NOT EXISTS compensation_audit (
        id INTEGER PRIMARY KEY, grant_id TEXT, profile_id TEXT, actor_id TEXT NOT NULL,
        action TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS retry_audit (
        id INTEGER PRIMARY KEY, reward_id TEXT NOT NULL REFERENCES rewards(id), actor_id TEXT NOT NULL, created_at TEXT NOT NULL
      );
      `);
      // Keep old codes on their original contract, including credits committed before a lost response.
      if (!this.db.pragma('table_info(rewards)').some(column => column.name === 'credit_type')) {
        this.db.exec("ALTER TABLE rewards ADD COLUMN credit_type TEXT NOT NULL DEFAULT 'balance' CHECK(credit_type IN ('balance','affiliate_balance'))");
      }
      if (!this.db.pragma('table_info(rewards)').some(column => column.name === 'credit_notes')) {
        this.db.exec('ALTER TABLE rewards ADD COLUMN credit_notes TEXT');
      }
      if (!this.db.pragma('table_info(rewards)').some(column => column.name === 'credit_migration')) {
        this.db.exec('ALTER TABLE rewards ADD COLUMN credit_migration TEXT');
      }
      if (!this.db.pragma('table_info(rewards)').some(column => column.name === 'chance_source')) {
        this.db.exec("ALTER TABLE rewards ADD COLUMN chance_source TEXT NOT NULL DEFAULT 'recharge' CHECK(chance_source IN ('recharge','compensation'))");
      }
      if (!this.db.pragma('table_info(rewards)').some(column => column.name === 'grant_id')) this.db.exec('ALTER TABLE rewards ADD COLUMN grant_id TEXT');
      if (!this.db.pragma('table_info(rewards)').some(column => column.name === 'profile_id')) this.db.exec('ALTER TABLE rewards ADD COLUMN profile_id TEXT');
      this.db.exec("UPDATE rewards SET credit_notes='活动奖励; activity=recharge-lottery; reward='||id||'; batch='||batch_id WHERE credit_notes IS NULL");
      this.db.exec('CREATE INDEX IF NOT EXISTS rewards_source ON rewards(chance_source,created_at DESC,id)');
      if (!this.db.prepare('SELECT 1 FROM compensation_profiles WHERE id=?').get(DEFAULT_COMPENSATION_PROFILE_ID)) {
        const at = new Date(now()).toISOString();
        this.db.prepare('INSERT INTO compensation_profiles(id,name,weights_json,status,version,created_at,updated_at,created_by) VALUES (?,?,?,?,?,?,?,?)')
          .run(DEFAULT_COMPENSATION_PROFILE_ID,'补偿抽奖·标准 v1',weightsJson(COMPENSATION_DEFAULT_WEIGHTS),'enabled',1,at,at,'system');
      }
      this.db.pragma('user_version = 4');
    }).immediate();
    this.db.transaction(() => {
      let campaign = this.db.prepare('SELECT * FROM campaign WHERE id=?').get(ACTIVITY.id);
      const sources = [...config.sources].sort().join(',');
      const dbUrl = config.databaseUrl ? new URL(config.databaseUrl) : null;
      const identity = [config.sub2apiBaseUrl, dbUrl ? `${dbUrl.host}${dbUrl.pathname}` : null];
      const hash = parts => crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
      const scope = hash(identity);
      if (!campaign) {
        this.db.prepare('INSERT INTO campaign VALUES (?,?,?,?,?,1)').run(ACTIVITY.id, new Date(now()).toISOString(), config.timezone, sources, scope);
        campaign = this.db.prepare('SELECT * FROM campaign WHERE id=?').get(ACTIVITY.id);
      }
      const legacySources = campaign.sources.split(',');
      const legacyScopes = [hash([...identity, config.rechargeUrl || null])];
      if (!legacySources.includes('official')) legacyScopes.push(hash([config.sub2apiBaseUrl, null, config.rechargeUrl || null]));
      // Change only the calculation basis; keep the original cutoff and consumed chances.
      if (sources === 'redemptions' && legacySources.every(source => ['official', 'recharge_center'].includes(source)) &&
          campaign.timezone === config.timezone && legacyScopes.includes(campaign.source_scope)) {
        this.db.prepare('UPDATE campaign SET sources=?,source_scope=? WHERE id=?').run(sources, scope, ACTIVITY.id);
        campaign = this.db.prepare('SELECT * FROM campaign WHERE id=?').get(ACTIVITY.id);
      }
      if (campaign.sources !== sources || campaign.timezone !== config.timezone || campaign.source_scope !== scope) throw new Error('已存在活动的充值来源和时区不能直接更改，请保留原配置与数据库');
      this.campaign = campaign;
    }).immediate();
  }
  registry() { return [{ ...ACTIVITY, enabled: this.config.enabled && this.now() >= Date.parse(this.campaign.start_at), prizes: PRIZES.map(p => p.amount) }]; }
  used(userId) { return this.db.prepare('SELECT used FROM accounts WHERE user_id=?').get(userId)?.used || 0; }
  compensationAvailable(userId, at = this.now()) {
    const rows = this.db.prepare(`SELECT g.chance_count,COALESCE(u.used,0) AS used
      FROM compensation_grants g LEFT JOIN compensation_grant_users u ON u.grant_id=g.id AND u.user_id=?
      WHERE g.status='active' AND g.starts_at<=? AND (g.expires_at IS NULL OR g.expires_at>?)
        AND (g.audience='all' OR u.user_id IS NOT NULL)`).all(userId,new Date(at).toISOString(),new Date(at).toISOString());
    return rows.reduce((sum,row) => sum + Math.max(0, row.chance_count - row.used), 0);
  }
  compensationCandidates(userId, at = this.now()) {
    const timestamp = new Date(at).toISOString();
    return this.db.prepare(`SELECT g.*,COALESCE(u.used,0) AS used,u.user_id AS allocated_user_id
      FROM compensation_grants g LEFT JOIN compensation_grant_users u ON u.grant_id=g.id AND u.user_id=?
      WHERE g.status='active' AND g.starts_at<=? AND (g.expires_at IS NULL OR g.expires_at>?)
        AND (g.audience='all' OR u.user_id IS NOT NULL)
        AND g.chance_count>COALESCE(u.used,0)
      ORDER BY CASE WHEN g.expires_at IS NULL THEN 1 ELSE 0 END,g.expires_at,g.starts_at,g.created_at,g.id`).all(userId,timestamp,timestamp);
  }
  summary(userId, rechargeMinor) {
    const sums = this.db.prepare(`SELECT COUNT(*) AS draws, COALESCE(SUM(CASE WHEN status='paid' THEN amount_minor ELSE 0 END),0) AS paid,
      COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END),0) AS pending,
      COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END),0) AS failed FROM rewards WHERE user_id=?`).get(userId);
    return { available: Math.max(0, Math.floor(rechargeMinor / 5000) - this.used(userId)) + this.compensationAvailable(userId),
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
      const candidates = this.compensationCandidates(user.id);
      let compensationAvailable = candidates.reduce((sum,row) => sum + Math.max(0, row.chance_count - row.used), 0);
      const rechargeAvailable = Math.max(0, Math.floor(rechargeMinor / 5000) - this.used(user.id));
      if (compensationAvailable + rechargeAvailable < count) throw new AppError('CHANCES_INSUFFICIENT', '可用抽奖次数不足', 409);
      const batchId = crypto.randomUUID();
      const at = new Date(this.now()).toISOString();
      this.db.prepare('INSERT INTO batches VALUES (?,?,?,?,?,?)').run(batchId, user.id, requestId, count, rechargeMinor, at);
      const insert = this.db.prepare(`INSERT INTO rewards(id,batch_id,sequence,user_id,user_email,user_name,amount_minor,credit_code,credit_type,credit_notes,chance_source,grant_id,profile_id,created_at,created_day)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      let rechargeCount = 0; let candidateIndex = 0;
      for (let index = 1; index <= count; index++) {
        const id = crypto.randomUUID();
        let grant = null;
        if (compensationAvailable > 0) {
          while (candidateIndex < candidates.length && candidates[candidateIndex].used >= candidates[candidateIndex].chance_count) candidateIndex++;
          grant = candidates[candidateIndex];
          if (grant.audience === 'all') this.db.prepare('INSERT OR IGNORE INTO compensation_grant_users(grant_id,user_id,used,created_at) VALUES (?,?,0,?)').run(grant.id,user.id,at);
          const changed = this.db.prepare('UPDATE compensation_grant_users SET used=used+1 WHERE grant_id=? AND user_id=? AND used<?')
            .run(grant.id,user.id,grant.chance_count).changes;
          if (changed !== 1) throw new AppError('CHANCES_CONFLICT', '补偿抽奖机会已被使用，请重试', 409);
          grant.used++;
          compensationAvailable--;
        } else rechargeCount++;
        const chanceSource = grant ? 'compensation' : 'recharge';
        const profileWeights = grant ? parseWeights(grant.weights_json) : null;
        insert.run(id, batchId, index, user.id, user.email, user.name,
          grant ? sampleWeights(profileWeights, this.rng) : sample(rechargeMinor, this.rng), creditCode(), 'balance',
          creditNotes({ id,batch_id: batchId,chance_source: chanceSource,grant_id: grant?.id }), chanceSource, grant?.id || null,
          grant?.profile_id || null, at, day(at, this.config.timezone));
      }
      if (rechargeCount) this.db.prepare('INSERT INTO accounts VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET used=used+excluded.used').run(user.id, rechargeCount);
      return this.batch(user.id, batchId);
    }).immediate();
  }
  batch(userId, id) {
    const batch = this.db.prepare('SELECT id,count,created_at FROM batches WHERE id=? AND user_id=?').get(id, userId);
    if (!batch) throw new AppError('BATCH_NOT_FOUND', '抽奖记录不存在', 404);
    return { id: batch.id, count: batch.count, createdAt: batch.created_at,
      rewards: this.db.prepare('SELECT * FROM rewards WHERE batch_id=? ORDER BY sequence').all(id).map(r => publicReward(r)) };
  }
  list({ userId, query = '', from, to, status, audit, source: chanceSource, page = 1, pageSize = 20 } = {}) {
    const clauses = [];
    const params = [];
    if (userId) { clauses.push('r.user_id=?'); params.push(userId); }
    if (status) { clauses.push('r.status=?'); params.push(status); }
    if (from) { clauses.push('r.created_day>=?'); params.push(from); }
    if (to) { clauses.push('r.created_day<=?'); params.push(to); }
    if (audit && !userId) { clauses.push(`(${AUDIT_STATUS})=?`); params.push(audit); }
    if (chanceSource) { clauses.push('r.chance_source=?'); params.push(chanceSource); }
    if (query) {
      clauses.push("(instr(lower(r.user_email),lower(?))>0 OR instr(lower(r.user_name),lower(?))>0 OR r.user_id=? OR r.id=? OR r.batch_id=? OR instr(COALESCE(r.receipt,''),?)>0)");
      params.push(query, query, query, query, query, query);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const source = userId ? 'FROM rewards r' : ADMIN_REWARDS_FROM;
    const total = this.db.prepare(`SELECT COUNT(*) AS total ${source} ${where}`).get(...params).total;
    const rows = this.db.prepare(`SELECT ${userId ? 'r.*' : ADMIN_REWARDS_SELECT} ${source} ${where}
      ORDER BY r.created_at DESC,r.batch_id DESC,r.sequence DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize);
    return { rows: rows.map(r => publicReward(r, !userId)), total, page, pageSize };
  }
  detail(id) {
    const row = this.db.prepare(`SELECT ${ADMIN_REWARDS_SELECT} ${ADMIN_REWARDS_FROM} WHERE r.id=?`).get(id);
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
  auditSummary() {
    const result = this.db.prepare(`SELECT COUNT(*) AS totalCount,
      COALESCE(SUM(audit_status='passed'),0) AS passedCount,
      COALESCE(SUM(audit_status='violation'),0) AS violationCount,
      COUNT(DISTINCT CASE WHEN audit_status='violation' THEN user_id END) AS violationUsers,
      COALESCE(SUM(CASE WHEN audit_status='violation' THEN amount_minor ELSE 0 END),0) AS violationMinor,
      COALESCE(SUM(CASE WHEN audit_status='violation' AND status='paid' THEN amount_minor ELSE 0 END),0) AS violationPaidMinor,
      COALESCE(SUM(audit_status='unverifiable'),0) AS unverifiableCount
      FROM (SELECT r.user_id,r.amount_minor,r.status,(${AUDIT_STATUS}) AS audit_status
        ${ADMIN_REWARDS_FROM} WHERE (${AUDIT_REQUIRED})>0)`).get();
    if (Object.values(result).some(v => !Number.isSafeInteger(v))) throw new AppError('AUDIT_OVERFLOW', '门槛审计汇总超出支持范围', 503);
    return result;
  }
  compensationProfiles() {
    return this.db.prepare('SELECT * FROM compensation_profiles ORDER BY CASE status WHEN \'enabled\' THEN 0 ELSE 1 END,name').all().map(row => ({
      id: row.id, name: row.name, status: row.status, version: row.version, weights: parseWeights(row.weights_json).map(item => ({ amountMinor: item.amount, weight: item.weight })),
      createdAt: row.created_at, updatedAt: row.updated_at, createdBy: row.created_by
    }));
  }
  createCompensationProfile({ name, weights, status = 'enabled' }, actorId) {
    const cleanName = String(name || '').trim();
    if (!cleanName || cleanName.length > 80 || !['enabled','disabled'].includes(status)) throw new AppError('INVALID_PROFILE', '概率方案信息无效');
    const serialized = weightsJson(weights);
    const id = crypto.randomUUID(); const at = new Date(this.now()).toISOString();
    try {
      this.db.transaction(() => {
        this.db.prepare('INSERT INTO compensation_profiles(id,name,weights_json,status,version,created_at,updated_at,created_by) VALUES (?,?,?,?,?,?,?,?)')
          .run(id,cleanName,serialized,status,1,at,at,actorId);
        this.db.prepare('INSERT INTO compensation_audit(profile_id,actor_id,action,detail,created_at) VALUES (?,?,?,?,?)')
          .run(id,actorId,'profile_created',JSON.stringify({ name: cleanName, status }),at);
      }).immediate();
    } catch (error) {
      if (String(error?.message || '').includes('UNIQUE')) throw new AppError('INVALID_PROFILE', '概率方案名称已存在', 409);
      throw error;
    }
    return this.compensationProfiles().find(profile => profile.id === id);
  }
  updateCompensationProfile(id, { name, weights, status }, actorId) {
    const current = this.db.prepare('SELECT * FROM compensation_profiles WHERE id=?').get(id);
    if (!current) throw new AppError('PROFILE_NOT_FOUND', '概率方案不存在', 404);
    const cleanName = String(name ?? current.name).trim();
    const serialized = weights === undefined ? current.weights_json : weightsJson(weights);
    const nextStatus = status ?? current.status;
    if (!cleanName || cleanName.length > 80 || !['enabled','disabled'].includes(nextStatus)) throw new AppError('INVALID_PROFILE', '概率方案信息无效');
    const at = new Date(this.now()).toISOString();
    try {
      this.db.transaction(() => {
        this.db.prepare('UPDATE compensation_profiles SET name=?,weights_json=?,status=?,version=version+1,updated_at=? WHERE id=?')
          .run(cleanName,serialized,nextStatus,at,id);
        this.db.prepare('INSERT INTO compensation_audit(profile_id,actor_id,action,detail,created_at) VALUES (?,?,?,?,?)')
          .run(id,actorId,'profile_updated',JSON.stringify({ name: cleanName, status: nextStatus }),at);
      }).immediate();
    } catch (error) {
      if (String(error?.message || '').includes('UNIQUE')) throw new AppError('INVALID_PROFILE', '概率方案名称已存在', 409);
      throw error;
    }
    return this.compensationProfiles().find(profile => profile.id === id);
  }
  createCompensationGrant({ audience, userIds = [], chanceCount, profileId, startsAt, expiresAt = null, reason }, actorId) {
    if (!['all','selected'].includes(audience)) throw new AppError('INVALID_GRANT', '发放对象无效');
    const ids = [...new Set(userIds.map(value => String(value).trim()))];
    if (audience === 'selected' && !ids.length) throw new AppError('INVALID_GRANT', '指定用户不能为空');
    if (audience === 'all' && ids.length) throw new AppError('INVALID_GRANT', '全体用户发放不能包含指定用户');
    if (ids.some(value => !/^[1-9]\d{0,14}$/.test(value)) || ids.length > 100) throw new AppError('INVALID_GRANT', '指定用户 ID 无效');
    if (!Number.isSafeInteger(chanceCount) || chanceCount < 1 || chanceCount > 100000) throw new AppError('INVALID_GRANT', '额外抽奖次数无效');
    const profile = this.db.prepare('SELECT * FROM compensation_profiles WHERE id=? AND status=\'enabled\'').get(profileId);
    if (!profile) throw new AppError('PROFILE_NOT_FOUND', '请选择启用中的概率方案', 409);
    const start = iso(startsAt, '生效时间'); const end = iso(expiresAt, '结束时间', { optional: true });
    if (end && Date.parse(end) <= Date.parse(start)) throw new AppError('INVALID_GRANT', '结束时间必须晚于生效时间');
    const cleanReason = String(reason || '').trim();
    if (!cleanReason || cleanReason.length > 200) throw new AppError('INVALID_GRANT', '补偿原因不能为空且不超过 200 字');
    const id = crypto.randomUUID(); const at = new Date(this.now()).toISOString();
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO compensation_grants(id,audience,chance_count,profile_id,profile_name,weights_json,starts_at,expires_at,reason,status,created_at,created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,audience,chanceCount,profileId,profile.name,profile.weights_json,start,end,cleanReason,'active',at,actorId);
      const insert = this.db.prepare('INSERT INTO compensation_grant_users(grant_id,user_id,used,created_at) VALUES (?,?,0,?)');
      for (const userId of audience === 'selected' ? ids : []) insert.run(id,userId,at);
      this.db.prepare('INSERT INTO compensation_audit(grant_id,profile_id,actor_id,action,detail,created_at) VALUES (?,?,?,?,?,?)')
        .run(id,profileId,actorId,'grant_created',JSON.stringify({ audience, userIds: audience === 'selected' ? ids : [], chanceCount, reason: cleanReason }),at);
    }).immediate();
    return this.compensationGrant(id);
  }
  compensationGrant(id) {
    const row = this.db.prepare(`SELECT g.*,COUNT(u.user_id) AS selected_users,COUNT(DISTINCT CASE WHEN u.used>0 THEN u.user_id END) AS used_users,
      COALESCE(SUM(u.used),0) AS used_count FROM compensation_grants g LEFT JOIN compensation_grant_users u ON u.grant_id=g.id WHERE g.id=? GROUP BY g.id`).get(id);
    if (!row) throw new AppError('GRANT_NOT_FOUND', '补偿发放记录不存在', 404);
    return { id: row.id, audience: row.audience, chanceCount: row.chance_count, profileId: row.profile_id, profileName: row.profile_name,
      startsAt: row.starts_at, expiresAt: row.expires_at, reason: row.reason, status: row.status, createdAt: row.created_at, createdBy: row.created_by,
      selectedUsers: row.audience === 'selected' ? row.selected_users : null, usedUsers: row.used_users, usedCount: row.used_count,
      userIds: row.audience === 'selected' ? this.db.prepare('SELECT user_id AS userId,used FROM compensation_grant_users WHERE grant_id=? ORDER BY user_id').all(id) : [] };
  }
  compensationGrants({ page = 1, pageSize = 20 } = {}) {
    const total = this.db.prepare('SELECT COUNT(*) AS total FROM compensation_grants').get().total;
    const rows = this.db.prepare(`SELECT g.*,COUNT(u.user_id) AS selected_users,COUNT(DISTINCT CASE WHEN u.used>0 THEN u.user_id END) AS used_users,
      COALESCE(SUM(u.used),0) AS used_count FROM compensation_grants g LEFT JOIN compensation_grant_users u ON u.grant_id=g.id
      GROUP BY g.id ORDER BY g.created_at DESC,g.id DESC LIMIT ? OFFSET ?`).all(pageSize,(page-1)*pageSize);
    return { rows: rows.map(row => ({ id: row.id, audience: row.audience, chanceCount: row.chance_count, profileId: row.profile_id, profileName: row.profile_name,
      startsAt: row.starts_at, expiresAt: row.expires_at, reason: row.reason, status: row.status, createdAt: row.created_at, createdBy: row.created_by,
      selectedUsers: row.audience === 'selected' ? row.selected_users : null, usedUsers: row.used_users, usedCount: row.used_count })), total, page, pageSize };
  }
  disableCompensationGrant(id, actorId) {
    const at = new Date(this.now()).toISOString();
    const changed = this.db.transaction(() => {
      const result = this.db.prepare("UPDATE compensation_grants SET status='disabled' WHERE id=? AND status='active'").run(id);
      if (result.changes) this.db.prepare('INSERT INTO compensation_audit(grant_id,profile_id,actor_id,action,detail,created_at) SELECT id,profile_id,?,?,?,? FROM compensation_grants WHERE id=?')
        .run(actorId,'grant_disabled','{}',at,id);
      return result.changes;
    }).immediate();
    if (!changed) throw new AppError('GRANT_NOT_ACTIVE', '补偿发放记录不存在或已停用', 409);
    return this.compensationGrant(id);
  }
  compensationSummary() {
    const grants = this.db.prepare(`SELECT COUNT(*) AS total,COALESCE(SUM(status='active'),0) AS active,COALESCE(SUM(audience='all'),0) AS all_count,
      COALESCE(SUM(audience='selected'),0) AS selected_count FROM compensation_grants`).get();
    const usage = this.db.prepare('SELECT COALESCE(SUM(used),0) AS used,COUNT(DISTINCT user_id) AS users FROM compensation_grant_users').get();
    const rewards = this.db.prepare(`SELECT COALESCE(SUM(CASE WHEN status='paid' THEN amount_minor ELSE 0 END),0) AS paid,
      COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END),0) AS pending,COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END),0) AS failed
      FROM rewards WHERE chance_source='compensation'`).get();
    return { grantCount: grants.total, activeGrantCount: grants.active, allGrantCount: grants.all_count, selectedGrantCount: grants.selected_count,
      usedChances: usage.used, recipients: usage.users, paidMinor: rewards.paid, pendingCount: rewards.pending, failedCount: rewards.failed };
  }
  compensationAudit({ limit = 30 } = {}) {
    return this.db.prepare('SELECT id,grant_id AS grantId,profile_id AS profileId,actor_id AS actorId,action,detail,created_at AS createdAt FROM compensation_audit ORDER BY id DESC LIMIT ?').all(limit);
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
      WHERE id=? AND status='pending' AND attempts=? AND credit_code=? AND credit_type=? AND credit_notes=?`)
      .run(JSON.stringify(receipt), at, day(at, this.config.timezone), row.id, row.attempts, row.credit_code, row.credit_type, row.credit_notes).changes;
  }
  replaceLegacyCredit(row, codeLimit) {
    if (codeLimit !== 32 || !legacyCredit(row) || row.credit_migration) throw new AppError('CREDIT_LEGACY_REVIEW_REQUIRED', '原奖励入账信息需要核查', 409);
    return this.db.transaction(() => {
      const code = creditCode(), notes = creditNotes(row);
      const migration = JSON.stringify({ code: row.credit_code,type: row.credit_type,notes: row.credit_notes,
        attempts: row.attempts-1,verifiedAt: new Date(this.now()).toISOString(),codeLimit });
      const changed = this.db.prepare(`UPDATE rewards SET credit_code=?,credit_type='balance',credit_notes=?,credit_migration=?,attempts=1,error_code=NULL
        WHERE id=? AND status='pending' AND attempts=? AND credit_code=? AND credit_type=? AND credit_notes=? AND credit_migration IS NULL`)
        .run(code,notes,migration,row.id,row.attempts,row.credit_code,row.credit_type,row.credit_notes).changes;
      return changed ? this.db.prepare('SELECT * FROM rewards WHERE id=?').get(row.id) : null;
    }).immediate();
  }
  fail(row, code, permanent = false) {
    const failed = permanent || row.attempts >= 8;
    this.db.prepare(`UPDATE rewards SET status=?,lease_until=0,error_code=?,next_attempt_at=?
      WHERE id=? AND status='pending' AND attempts=? AND credit_code=? AND credit_type=? AND credit_notes=?`)
      .run(failed ? 'failed' : 'pending', code, this.now() + Math.min(3600000, 15000 * 2 ** Math.min(row.attempts, 8)),
        row.id,row.attempts,row.credit_code,row.credit_type,row.credit_notes);
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
