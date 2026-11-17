'use strict';

const crypto = require('node:crypto');
const { AppError } = require('./errors');
const { modelAllowed } = require('./services/conversation-models');
const { REDACTION_VERSION, redactionPolicyHash } = require('./services/conversation-sensitive');
const { COMPLETION_VERSION } = require('./services/conversation-completion');

const transient = new Set(['REDACTION_MEMORY_PRESSURE','REDACTION_RESOURCE_LIMIT']);
class ConversationRepairStore {
  constructor(archive, { now = Date.now, memoryBudget = () => Infinity } = {}) { this.archive = archive; this.db = archive.db; this.now = now; this.memoryBudget = memoryBudget; }
  initialize() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS cl_repairs(id TEXT PRIMARY KEY,policy_version INTEGER NOT NULL,status TEXT NOT NULL,
      upper_rowid INTEGER NOT NULL,cursor_rowid INTEGER NOT NULL DEFAULT 0,current_rowid INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,
      scanned INTEGER NOT NULL DEFAULT 0,analyzed INTEGER NOT NULL DEFAULT 0,repaired INTEGER NOT NULL DEFAULT 0,
      warnings INTEGER NOT NULL DEFAULT 0,deferred INTEGER NOT NULL DEFAULT 0,errors INTEGER NOT NULL DEFAULT 0,skipped INTEGER NOT NULL DEFAULT 0,
      requested_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,error_code TEXT NOT NULL DEFAULT '');
      CREATE UNIQUE INDEX IF NOT EXISTS cl_repair_active ON cl_repairs((1)) WHERE status IN ('pending','running');`);
    return this;
  }
  latest() { return this.db.prepare('SELECT * FROM cl_repairs ORDER BY requested_at DESC,rowid DESC LIMIT 1').get() || null; }
  pending() { return this.db.prepare("SELECT * FROM cl_repairs WHERE status IN ('pending','running') LIMIT 1").get() || null; }
  request(input) {
    if (!input || Object.keys(input).some(key => key !== 'policy_version') || !Number.isSafeInteger(input.policy_version)) throw new AppError('CONVERSATION_INVALID_INPUT','历史检查参数无效',{status:400});
    return this.db.transaction(() => {
      if (this.archive.policy().version !== input.policy_version) throw new AppError('CONVERSATION_POLICY_CONFLICT','策略已更新，请刷新后重试',{status:409});
      if (this.pending()) return this.pending();
      const upper = this.db.prepare('SELECT COALESCE(MAX(rowid),0) n FROM cl_records').get().n, at = this.now();
      this.db.prepare("INSERT INTO cl_repairs(id,policy_version,status,upper_rowid,requested_at,updated_at) VALUES(?,?,'pending',?,?,?)")
        .run(crypto.randomUUID(), input.policy_version, upper, at, at);
      return this.pending();
    }).immediate();
  }
  cancel(id) {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new AppError('CONVERSATION_INVALID_INPUT','历史检查任务无效',{status:400});
    this.db.prepare("UPDATE cl_repairs SET status='cancelled',updated_at=? WHERE id=? AND status IN ('pending','running')").run(this.now(),id);
  }
  check(job) {
    const current = this.pending();
    if (current?.id !== job.id || this.archive.policy().version !== job.policy_version) throw new AppError('CONVERSATION_REPAIR_CONFLICT','任务已停止或策略已更新',{status:409});
  }
  advance(job, row, counts = {}) {
    this.check(job);
    this.db.prepare(`UPDATE cl_repairs SET status=?,cursor_rowid=?,current_rowid=0,attempts=0,scanned=scanned+1,
      analyzed=analyzed+?,repaired=repaired+?,warnings=warnings+?,deferred=deferred+?,errors=errors+?,skipped=skipped+?,updated_at=?,error_code='' WHERE id=?`)
      .run(row.cursor >= job.upper_rowid ? 'done' : 'running',row.cursor,counts.analyzed || 0,counts.repaired || 0,counts.warnings || 0,counts.deferred || 0,counts.errors || 0,counts.skipped || 0,this.now(),job.id);
  }
  step() {
    const job = this.pending(); if (!job) return { worked:false };
    const policy = this.archive.policy();
    if (policy.version !== job.policy_version) {
      this.db.prepare("UPDATE cl_repairs SET status='paused',error_code='POLICY_CHANGED',updated_at=? WHERE id=? AND status IN ('pending','running')").run(this.now(),job.id);
      return { worked:false };
    }
    // Select metadata before loading a body. Each task stops at its initial history boundary.
    const row = this.db.prepare(`SELECT rowid cursor,id,user_id,model,at,archived_at,mode,bytes,processed_at,processing_error,redaction_version,redaction_policy_hash,
      completion_version,upstream_status,upstream_evidence,original IS NOT NULL original,masked IS NOT NULL masked FROM cl_records WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT 1`)
      .get(job.cursor_rowid,job.upper_rowid);
    if (!row) { this.db.prepare("UPDATE cl_repairs SET status='done',updated_at=? WHERE id=? AND status IN ('pending','running')").run(this.now(),job.id); return { worked:false }; }
    const skip = row.archived_at >= job.requested_at || policy.excludedUserIds.includes(row.user_id) || !modelAllowed(policy,row.model) || policy.retention && row.at < this.now() - policy.retention * 86400000;
    const repair = row.original && row.mode !== 'original' && (row.processing_error || row.redaction_version !== REDACTION_VERSION || row.redaction_policy_hash !== redactionPolicyHash(policy));
    const analyze = row.completion_version < COMPLETION_VERSION || row.upstream_status === 'unverified' && row.upstream_evidence === 'resource';
    const finish = counts => this.db.transaction(() => this.advance(job,row,counts)).immediate();
    if (skip || !row.original && !row.masked || !repair && !analyze) { finish({skipped:1}); return {worked:true}; }
    if (row.bytes * 8 > this.memoryBudget() || job.current_rowid === row.cursor && job.attempts >= 3) { finish({deferred:1}); return {worked:true}; }
    this.db.transaction(() => {
      this.check(job);
      this.db.prepare("UPDATE cl_repairs SET status='running',current_rowid=?,attempts=?,updated_at=? WHERE id=?")
        .run(row.cursor,job.current_rowid === row.cursor ? job.attempts + 1 : 1,this.now(),job.id);
    }).immediate();
    try {
      const expected = {policy_version:policy.version,processed_at:row.processed_at}, options = {beforeCommit:() => this.check(job)};
      if (repair) this.archive.retry(row.id,expected,{...options,detail:false,afterCommit:result => this.advance(job,row,{
        analyzed:1,repaired:result.processing_error ? 0 : 1,warnings:result.inspection_warnings.length ? 1 : 0,
        deferred:transient.has(result.processing_error) ? 1 : 0,errors:result.processing_error && !transient.has(result.processing_error) ? 1 : 0
      })});
      else this.archive.analyze(row.id,expected,{...options,afterCommit:result => this.advance(job,row,{
        analyzed:1,deferred:result.upstream_evidence === 'resource' ? 1 : 0
      })});
    } catch (error) {
      if (/^SQLITE_(?:BUSY|LOCKED)/.test(error.code || '')) throw error;
      if (error.code === 'CONVERSATION_REPAIR_CONFLICT') return {worked:false};
      if (this.archive.policy().version !== policy.version) return {worked:false};
      finish({ ...(error.code === 'CONVERSATION_RETRY_CAPACITY' ? {deferred:1} : error.code === 'CONVERSATION_RETRY_CONFLICT' ? {skipped:1} : {errors:1}) });
    }
    return {worked:true,processed:true};
  }
}

module.exports = { ConversationRepairStore };
