'use strict';

const { performance } = require('node:perf_hooks');
const { targetHash,target,targets:policyTargets,CLEANUP_BATCH_DEFAULT_MIB } = require('./services/conversation-push-policy');

// Keep deletion in the background, but use a bounded default. The policy can
// select 32-64 MiB; record and transaction-time limits remain in force.
const CLEANUP_BATCH_BYTES = CLEANUP_BATCH_DEFAULT_MIB * 1024 ** 2;
const CLEANUP_BATCH_RECORDS = 256;
const CLEANUP_BATCH_MS = 40;
const historyColumns = 'id,record_id,destination,source,delivery_source,delivery_fallback_reason,envelope_version,batch_id,status,attempts,next_at,created_at,updated_at,error_code,http_status,model,user_id,local_deleted_at,request_id';
const historySource = `(SELECT j.id,j.record_id,j.destination,j.source,j.delivery_source,j.delivery_fallback_reason,j.envelope_version,j.batch_id,j.status,j.attempts,j.next_at,j.created_at,j.updated_at,j.error_code,j.http_status,r.model,r.user_id,0 local_deleted_at,r.request_id
  FROM cl_push_jobs j LEFT JOIN cl_record_metadata r ON r.id=j.record_id
  UNION ALL SELECT id,record_id,destination,source,delivery_source,delivery_fallback_reason,envelope_version,batch_id,'sent',attempts,0,created_at,updated_at,'',http_status,model,NULL,local_deleted_at,request_id FROM cl_push_receipts)`;

class ConversationPushCleanupStore {
  constructor(push) { this.push = push; this.archive = push.archive; this.db = push.db; this.now = push.now; }
  initialize() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS cl_push_cleanup_queue(record_id TEXT PRIMARY KEY REFERENCES cl_records(id) ON DELETE CASCADE,next_at INTEGER NOT NULL,reason TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS cl_push_cleanup_due ON cl_push_cleanup_queue(next_at,record_id);
      CREATE TABLE IF NOT EXISTS cl_push_cleanup_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),cursor INTEGER NOT NULL DEFAULT 0,deleted INTEGER NOT NULL DEFAULT 0,bytes INTEGER NOT NULL DEFAULT 0,last_at INTEGER NOT NULL DEFAULT 0);
      INSERT OR IGNORE INTO cl_push_cleanup_state(singleton) VALUES(1);
      CREATE TABLE IF NOT EXISTS cl_push_receipts(id TEXT PRIMARY KEY,record_id TEXT NOT NULL,destination TEXT NOT NULL,source TEXT NOT NULL,
        delivery_source TEXT NOT NULL,delivery_fallback_reason TEXT NOT NULL,envelope_version INTEGER NOT NULL,batch_id TEXT NOT NULL,
        attempts INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,http_status INTEGER NOT NULL,model TEXT NOT NULL,
        local_deleted_at INTEGER NOT NULL,request_id TEXT NOT NULL,object_key TEXT NOT NULL,sha256 TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS cl_push_receipt_expiry ON cl_push_receipts(local_deleted_at);
      CREATE INDEX IF NOT EXISTS cl_push_receipt_batch ON cl_push_receipts(batch_id);
      CREATE INDEX IF NOT EXISTS cl_push_receipt_record_destination ON cl_push_receipts(record_id,destination);
      CREATE INDEX IF NOT EXISTS cl_push_receipt_order ON cl_push_receipts(created_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS cl_push_history_order ON cl_push_jobs(created_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS cl_push_batch_unfinished ON cl_push_jobs(batch_id) WHERE status!='sent' OR http_status<200 OR http_status>=300;
      DROP TRIGGER IF EXISTS cl_push_cleanup_sent;
      CREATE TRIGGER IF NOT EXISTS cl_push_cleanup_sent AFTER UPDATE OF status ON cl_push_jobs WHEN NEW.status='sent' AND OLD.status!='sent'
        BEGIN INSERT INTO cl_push_cleanup_queue(record_id,next_at) VALUES(NEW.record_id,NEW.updated_at)
          ON CONFLICT(record_id) DO UPDATE SET next_at=MIN(cl_push_cleanup_queue.next_at,excluded.next_at),reason=''; END;`);
    return this;
  }
  status() {
    return { enabled: this.push.policy().deleteAfterPush, ...this.db.prepare('SELECT deleted,bytes,last_at FROM cl_push_cleanup_state WHERE singleton=1').get(),
      pending: this.db.prepare('SELECT COUNT(*) n FROM cl_push_cleanup_queue').get().n };
  }
  backfill() {
    const state = this.db.prepare('SELECT cursor FROM cl_push_cleanup_state WHERE singleton=1').get();
    const rows = this.db.prepare('SELECT rowid cursor,record_id,status FROM cl_push_jobs WHERE rowid>? ORDER BY rowid LIMIT 64').all(state.cursor);
    for (const row of rows) if (row.status === 'sent') this.db.prepare('INSERT OR IGNORE INTO cl_push_cleanup_queue(record_id,next_at) VALUES(?,?)').run(row.record_id, this.now());
    if (rows.length) this.db.prepare('UPDATE cl_push_cleanup_state SET cursor=? WHERE singleton=1').run(rows.at(-1).cursor);
  }
  batch({ canWork = () => true, maxRecords = CLEANUP_BATCH_RECORDS, maxBytes = CLEANUP_BATCH_BYTES, maxMs = CLEANUP_BATCH_MS } = {}) {
    const result = { deleted: 0, bytes: 0, scanned: 0 };
    if (!canWork()) return result;
    const cursor = this.db.prepare('SELECT cursor FROM cl_push_cleanup_state WHERE singleton=1').get().cursor;
    if (!this.db.prepare('SELECT 1 FROM cl_push_cleanup_queue WHERE next_at<=? LIMIT 1').get(this.now()) &&
      !this.db.prepare('SELECT 1 FROM cl_push_jobs WHERE rowid>? LIMIT 1').get(cursor)) return result;
    const timeout = this.db.pragma('busy_timeout', { simple: true });
    this.db.pragma('busy_timeout = 1');
    try {
      return this.db.transaction(() => {
        if (!canWork()) return result;
        const began = performance.now();
        const policy = this.push.policy();
        if (!policy.enabled || !policy.deleteAfterPush) return result;
        this.backfill();
        while (result.scanned < maxRecords && result.bytes < maxBytes && performance.now() - began < maxMs && canWork()) {
          // The first oversized record must still be able to make progress.
          const next = this.deleteCandidate({ policy, backfill: false, maxBytes: result.deleted ? maxBytes - result.bytes : Infinity });
          result.scanned++;
          if (next.deleted) { result.deleted++; result.bytes += next.bytes; }
          else if (!next.reason || ['reading','budget','disabled'].includes(next.reason)) break;
        }
        return result;
      }).immediate();
    } finally { this.db.pragma('busy_timeout = ' + timeout); }
  }
  step(options) { return this.db.transaction(() => this.deleteCandidate(options)).immediate(); }
  deleteCandidate({ policy = this.push.policy(), backfill = true, maxBytes = Infinity } = {}) {
    if (!this.db.inTransaction) throw new Error('CONVERSATION_CLEANUP_TRANSACTION_REQUIRED');
    if (!policy.enabled || !policy.deleteAfterPush) return { deleted: false, reason: 'disabled' };
    if (backfill) this.backfill();
    if (this.db.prepare('SELECT 1 FROM cl_payload_leases WHERE expires_at>? LIMIT 1').get(this.now())) return { deleted: false, reason: 'reading' };
    const candidate = this.db.prepare('SELECT record_id FROM cl_push_cleanup_queue WHERE next_at<=? ORDER BY next_at,record_id LIMIT 1').get(this.now());
    if (!candidate) return { deleted: false };
    const row = this.db.prepare(`SELECT id,request_id,model,fingerprint,body_sha256,processed_at,processing_pending,processing_policy_version,bytes FROM cl_record_metadata WHERE id=?`).get(candidate.record_id);
    if (!row?.fingerprint) {
      this.db.prepare('UPDATE cl_push_cleanup_queue SET next_at=?,reason=? WHERE record_id=?').run(this.now() + 30000, 'metadata_pending', candidate.record_id);
      return { deleted: false, reason: 'metadata_pending' };
    }
    if (row.bytes > maxBytes) return { deleted: false, reason: 'budget' };
    const jobs = this.db.prepare(`SELECT id,record_id,destination,target_hash,source,content_version,batch_id,status,attempts,created_at,updated_at,
      http_status,delivery_source,delivery_fallback_reason,delivery_version,envelope_version,jsonl_file_id FROM cl_push_jobs WHERE record_id=?`).all(row.id);
    let reason = row.processing_pending ? 'processing' : jobs.some(job => job.status !== 'sent' || job.http_status < 200 || job.http_status >= 300) ? 'delivery_pending' : '';
    const targets = [...new Set([...jobs.map(job=>job.destination),...policyTargets(policy).filter(target=>target.enabled&&(target.id==='s3'||target.id==='webhook')).map(target=>target.id)])];
    if (!jobs.length) reason = 'delivery_pending';
    for (const id of targets) {
      const configured=target(policy,id),expected=configured&&(configured.endpoint||configured.url)?targetHash(policy,id):'';
      if (!jobs.some(job => job.destination === id && (!expected||job.target_hash === expected) &&
        job.source === policy.source && job.content_version === this.push.version(row, policy.source) &&
        (!job.delivery_source || job.delivery_version === this.push.version(row, job.delivery_source)))) reason = 'content_changed';
    }
    for (const job of jobs) if (job.jsonl_file_id) {
      const file = this.db.prepare('SELECT status,object_key,sha256,bytes,uploaded_bytes FROM cl_push_jsonl_files WHERE id=?').get(job.jsonl_file_id);
      if (!file || file.status !== 'sent' || !/^[a-f0-9]{64}$/.test(file.sha256) || file.uploaded_bytes !== file.bytes) reason = 'delivery_pending';
    }
    for(const batchId of new Set(jobs.map(job=>job.batch_id).filter(Boolean)))if(this.db.prepare("SELECT 1 FROM cl_push_jobs WHERE batch_id=? AND (status!='sent' OR http_status<200 OR http_status>=300) LIMIT 1").get(batchId))reason='delivery_pending';
    if (reason) {
      this.db.prepare('UPDATE cl_push_cleanup_queue SET next_at=?,reason=? WHERE record_id=?').run(this.now() + 30000, reason, row.id);
      return { deleted: false, reason };
    }
    const at = this.now();
    for (const job of jobs) {
      const file = job.jsonl_file_id && this.db.prepare('SELECT object_key,sha256 FROM cl_push_jsonl_files WHERE id=?').get(job.jsonl_file_id);
      this.db.prepare(`INSERT OR IGNORE INTO cl_push_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(job.id,row.id,job.destination,job.source,
        job.delivery_source,job.delivery_fallback_reason,job.envelope_version,job.batch_id,job.attempts,job.created_at,job.updated_at,job.http_status,row.model,at,row.request_id,file?.object_key || '',file?.sha256 || '');
    }
    this.db.prepare('INSERT INTO cl_delivered_records VALUES(?,?,?,?)').run(row.id,row.fingerprint,row.body_sha256,at);
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='cl_push_jsonl_members'").get()) {
      this.db.prepare('DELETE FROM cl_push_jsonl_members WHERE job_id IN (SELECT id FROM cl_push_jobs WHERE record_id=?)').run(row.id);
    }
    // Metadata stays atomic with the source under this writer lock; do not read past body BLOBs to compare fingerprints.
    const deleted = this.db.prepare(`DELETE FROM cl_records WHERE id=? AND EXISTS(
      SELECT 1 FROM cl_record_metadata WHERE id=? AND fingerprint=?)`).run(row.id,row.id,row.fingerprint).changes;
    if (deleted !== 1) throw new Error('CONVERSATION_CLEANUP_CHANGED');
    this.db.prepare('UPDATE cl_push_cleanup_state SET deleted=deleted+1,bytes=bytes+?,last_at=? WHERE singleton=1').run(row.bytes,at);
    return { deleted: true, bytes: row.bytes };
  }
  reclaim({ pages = 128 } = {}) {
    const timeout = this.db.pragma('busy_timeout', { simple: true });
    try {
      this.db.pragma('busy_timeout = 0');
      this.db.pragma(`incremental_vacuum(${Math.max(1, Math.min(1024, Math.trunc(pages)))})`);
      this.db.pragma('wal_checkpoint(PASSIVE)');
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } finally { this.db.pragma(`busy_timeout = ${timeout}`); }
  }
  prune() {
    const cutoff = this.now() - 30 * 86400000;
    this.db.prepare('DELETE FROM cl_payload_leases WHERE expires_at<=?').run(this.now());
    for (const [table, column] of [['cl_push_receipts','local_deleted_at'], ['cl_delivered_records','deleted_at']]) {
      this.db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${column}<? ORDER BY ${column} LIMIT 256)`).run(cutoff);
      this.db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} ORDER BY ${column} DESC,rowid DESC LIMIT 256 OFFSET 100000)`).run();
    }
  }
}

module.exports = { ConversationPushCleanupStore, CLEANUP_BATCH_BYTES, historyColumns, historySource };
