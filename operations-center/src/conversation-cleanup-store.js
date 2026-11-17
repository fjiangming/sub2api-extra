'use strict';

const crypto = require('node:crypto');
const { AppError } = require('./errors');
const { modelAllowed, normalizeModel } = require('./services/conversation-models');

function modelPolicyHash(policy) {
  return crypto.createHash('sha256').update(JSON.stringify([policy.modelFilterEnabled,
    [...new Set(policy.allowedModels.map(normalizeModel))].sort(), policy.kimiK3Plus])).digest('hex');
}
function blocked(code, message) { return new AppError(code, message, { status: 409 }); }

class ConversationCleanupStore {
  constructor(archive, { now = Date.now } = {}) { this.archive = archive; this.db = archive.db; this.now = now; }
  initialize() {
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`CREATE TABLE IF NOT EXISTS cl_model_cleanups(
      id TEXT PRIMARY KEY,policy_version INTEGER NOT NULL,model_policy_hash TEXT NOT NULL,status TEXT NOT NULL,
      upper_rowid INTEGER NOT NULL,cursor_rowid INTEGER NOT NULL DEFAULT 0,scanned INTEGER NOT NULL DEFAULT 0,
      deleted INTEGER NOT NULL DEFAULT 0,requested_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,error_code TEXT NOT NULL DEFAULT '');
      CREATE UNIQUE INDEX IF NOT EXISTS cl_model_cleanup_active ON cl_model_cleanups((1)) WHERE status IN ('pending','running');`);
    this.db.transaction(() => {
      const columns = new Set(this.db.pragma('table_info(cl_model_cleanups)').map(column => column.name));
      for (const [name, definition] of [['scope', "TEXT NOT NULL DEFAULT 'models'"], ['upper_arrival', 'INTEGER NOT NULL DEFAULT 0'], ['boundary_version', 'INTEGER NOT NULL DEFAULT 0']]) {
        if (!columns.has(name)) this.db.exec(`ALTER TABLE cl_model_cleanups ADD COLUMN ${name} ${definition}`);
      }
      // Reuse the existing monotonic push arrival marker. Older rows need no backfill.
      this.db.exec(`CREATE TABLE IF NOT EXISTS cl_push_arrivals(seq INTEGER PRIMARY KEY AUTOINCREMENT,record_id TEXT NOT NULL UNIQUE REFERENCES cl_records(id) ON DELETE CASCADE);
        CREATE TRIGGER IF NOT EXISTS cl_push_arrival AFTER INSERT ON cl_records BEGIN INSERT INTO cl_push_arrivals(record_id) VALUES(NEW.id); END;`);
    })();
    return this;
  }
  latest(scope) {
    return (scope ? this.db.prepare('SELECT * FROM cl_model_cleanups WHERE scope=? ORDER BY requested_at DESC,rowid DESC LIMIT 1').get(scope)
      : this.db.prepare('SELECT * FROM cl_model_cleanups ORDER BY requested_at DESC,rowid DESC LIMIT 1').get()) || null;
  }
  pending() { return this.db.prepare("SELECT * FROM cl_model_cleanups WHERE status IN ('pending','running') LIMIT 1").get() || null; }
  request(input) {
    if (!input || Object.keys(input).some(key => key !== 'policy_version') || !Number.isSafeInteger(input.policy_version)) {
      throw new AppError('CONVERSATION_INVALID_INPUT', '清理参数无效', { status: 400 });
    }
    return this.db.transaction(() => {
      const policy = this.archive.policy();
      if (policy.version !== input.policy_version) throw blocked('CONVERSATION_POLICY_CONFLICT', '模型名单已更新，请刷新后重试');
      if (!policy.modelFilterEnabled || !policy.allowedModels.length && !policy.kimiK3Plus) {
        throw blocked('CONVERSATION_CLEANUP_MODELS_REQUIRED', '请先保存启用的模型名单，至少选择一个模型');
      }
      const existing = this.pending();
      if (existing) {
        if (existing.scope !== 'models') throw blocked('CONVERSATION_CLEANUP_ACTIVE', '正在清空全部历史，请等待完成或先停止');
        return existing;
      }
      return this.create(crypto.randomUUID(), 'models', policy);
    }).immediate();
  }
  requestAll(input) {
    if (!input || Object.keys(input).some(key => !['request_id','confirm'].includes(key)) ||
      typeof input.request_id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.request_id) || input.confirm !== 'clear-all-history') {
      throw new AppError('CONVERSATION_INVALID_INPUT', '请确认清空全部历史日志', { status: 400 });
    }
    return this.db.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM cl_model_cleanups WHERE id=?').get(input.request_id);
      if (previous) {
        if (previous.scope !== 'all') throw blocked('CONVERSATION_CLEANUP_CONFLICT', '清理请求标识已被使用');
        return previous;
      }
      const active = this.pending();
      if (active) {
        if (active.scope !== 'all') throw blocked('CONVERSATION_CLEANUP_ACTIVE', '正在清理名单外日志，请等待完成或先停止');
        return active;
      }
      return this.create(input.request_id, 'all', this.archive.policy());
    }).immediate();
  }
  create(id, scope, policy) {
    const at = this.now(), upper = this.db.prepare('SELECT COALESCE(MAX(rowid),0) n FROM cl_records').get().n;
    const arrival = this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='cl_push_arrivals'").get()?.seq || 0;
    this.db.prepare(`INSERT INTO cl_model_cleanups(id,policy_version,model_policy_hash,status,upper_rowid,requested_at,updated_at,scope,upper_arrival,boundary_version)
      VALUES(?,?,?,'pending',?,?,?,?,?,1)`).run(id, policy.version, scope === 'models' ? modelPolicyHash(policy) : '', upper, at, at, scope, arrival);
    return this.pending();
  }
  cancel(id, scope) {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new AppError('CONVERSATION_INVALID_INPUT', '清理任务无效', { status: 400 });
    if (scope) this.db.prepare("UPDATE cl_model_cleanups SET status='cancelled',error_code='',updated_at=? WHERE id=? AND scope=? AND status IN ('pending','running')").run(this.now(), id, scope);
    else this.db.prepare("UPDATE cl_model_cleanups SET status='cancelled',error_code='',updated_at=? WHERE id=? AND status IN ('pending','running')").run(this.now(), id);
  }
  step({ scanSize = 64, maxDeletes = 1 } = {}) {
    return this.db.transaction(() => {
      const job = this.pending(); if (!job) return { worked: false };
      const policy = this.archive.policy();
      if (job.scope === 'models' && modelPolicyHash(policy) !== job.model_policy_hash) {
        this.db.prepare("UPDATE cl_model_cleanups SET status='paused',error_code='MODEL_POLICY_CHANGED',updated_at=? WHERE id=?").run(this.now(), job.id);
        return { worked: false };
      }
      // These columns precede the body BLOBs; never read/decrypt large payloads to select deletions.
      const rows = this.db.prepare(`SELECT rowid cursor,id,model,
        CASE WHEN ?=1 THEN EXISTS(SELECT 1 FROM cl_push_arrivals a WHERE a.record_id=cl_records.id AND a.seq>?) ELSE 0 END after_boundary
        FROM cl_records WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT ?`)
        .all(job.boundary_version, job.upper_arrival, job.cursor_rowid, job.upper_rowid, scanSize);
      let scanned = 0, deleted = 0, cursor = job.cursor_rowid;
      for (const row of rows) {
        scanned++; cursor = row.cursor;
        if (!row.after_boundary && (job.scope === 'all' || !modelAllowed(policy, row.model))) {
          if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cl_push_jsonl_members'").get()) {
            this.db.prepare('DELETE FROM cl_push_jsonl_members WHERE job_id IN (SELECT id FROM cl_push_jobs WHERE record_id=?)').run(row.id);
          }
          deleted += this.db.prepare('DELETE FROM cl_records WHERE rowid=? AND id=?').run(row.cursor, row.id).changes;
          if (deleted >= maxDeletes) break;
        }
      }
      this.db.prepare('UPDATE cl_model_cleanups SET status=?,cursor_rowid=?,scanned=scanned+?,deleted=deleted+?,updated_at=?,error_code=\'\' WHERE id=?')
        .run(!rows.length || cursor >= job.upper_rowid ? 'done' : 'running', cursor, scanned, deleted, this.now(), job.id);
      return { worked: rows.length > 0, scanned, deleted };
    }).immediate();
  }
}

module.exports = { ConversationCleanupStore, modelPolicyHash };
