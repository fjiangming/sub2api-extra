'use strict';

const crypto = require('node:crypto');
const { targetHash, invalid } = require('./services/conversation-push-policy');
const { dayAt, objectKey, jsonlBytes } = require('./services/conversation-jsonl-format');
const { modelAllowed } = require('./services/conversation-models');
const { REDACTION_VERSION, redactionPolicyHash } = require('./services/conversation-sensitive');

class ConversationJsonlStore {
  constructor(push, { maxFileBytes, memoryBudget = () => Infinity } = {}) {
    this.push = push; this.archive = push.archive; this.db = push.db; this.now = push.now;
    this.maxFileBytes = maxFileBytes; this.memoryBudget = memoryBudget;
  }
  initialize() {
    this.db.transaction(() => {
      if (!this.db.pragma('table_info(cl_push_jobs)').some(column => column.name === 'jsonl_file_id')) {
        this.db.exec("ALTER TABLE cl_push_jobs ADD COLUMN jsonl_file_id TEXT NOT NULL DEFAULT ''");
      }
      this.db.exec(`CREATE TABLE IF NOT EXISTS cl_push_jsonl_files(
        id TEXT PRIMARY KEY,target_hash TEXT NOT NULL,source TEXT NOT NULL,model TEXT NOT NULL,day TEXT NOT NULL,object_key TEXT NOT NULL,
        policy_version INTEGER NOT NULL,archive_version INTEGER NOT NULL,status TEXT NOT NULL,bytes INTEGER NOT NULL DEFAULT 0,
        records INTEGER NOT NULL DEFAULT 0,force_flush INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
        sealed_at INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,
        lease_token TEXT NOT NULL DEFAULT '',lease_until INTEGER NOT NULL DEFAULT 0,upload_id TEXT NOT NULL DEFAULT '',
        sha256 TEXT NOT NULL DEFAULT '',error_code TEXT NOT NULL DEFAULT '',http_status INTEGER NOT NULL DEFAULT 0);
        CREATE UNIQUE INDEX IF NOT EXISTS cl_push_jsonl_open ON cl_push_jsonl_files(target_hash,source,model,day) WHERE status='open';
        CREATE INDEX IF NOT EXISTS cl_push_jsonl_due ON cl_push_jsonl_files(status,next_at);
        CREATE INDEX IF NOT EXISTS cl_push_jsonl_jobs ON cl_push_jobs(jsonl_file_id,status);
        CREATE TABLE IF NOT EXISTS cl_push_jsonl_members(
          job_id TEXT PRIMARY KEY,file_id TEXT NOT NULL REFERENCES cl_push_jsonl_files(id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL,metadata BLOB NOT NULL,fingerprint TEXT NOT NULL,processed_at INTEGER NOT NULL,
          processing_policy_version INTEGER NOT NULL,UNIQUE(file_id,ordinal));
        CREATE TABLE IF NOT EXISTS cl_push_jsonl_control(singleton INTEGER PRIMARY KEY CHECK(singleton=1),flush_before INTEGER NOT NULL);
        INSERT OR IGNORE INTO cl_push_jsonl_control VALUES(1,0);`);
      const columns = new Set(this.db.pragma('table_info(cl_push_jsonl_files)').map(row => row.name));
      for (const [name, definition] of [['upload_version','INTEGER NOT NULL DEFAULT 0'],['uploaded_bytes','INTEGER NOT NULL DEFAULT 0'],
        ['uploaded_parts','INTEGER NOT NULL DEFAULT 0'],['pause_reason',"TEXT NOT NULL DEFAULT ''"],['first_at','INTEGER NOT NULL DEFAULT 0']]) {
        if (!columns.has(name)) this.db.exec(`ALTER TABLE cl_push_jsonl_files ADD COLUMN ${name} ${definition}`);
      }
      this.db.exec(`CREATE TABLE IF NOT EXISTS cl_push_jsonl_parts(
        file_id TEXT NOT NULL REFERENCES cl_push_jsonl_files(id) ON DELETE CASCADE,number INTEGER NOT NULL,
        bytes INTEGER NOT NULL,etag TEXT NOT NULL,sha256 TEXT NOT NULL,PRIMARY KEY(file_id,number));`);
      const memberColumns = new Set(this.db.pragma('table_info(cl_push_jsonl_members)').map(row => row.name));
      for (const name of ['payload_source','fallback_reason']) {
        if (!memberColumns.has(name)) this.db.exec(`ALTER TABLE cl_push_jsonl_members ADD COLUMN ${name} TEXT NOT NULL DEFAULT ''`);
      }
    })();
    return this;
  }
  enabled(policy = this.push.policy()) { return policy.enabled && policy.s3.enabled && policy.s3.format === 'jsonl'; }
  get(id) { return this.db.prepare('SELECT * FROM cl_push_jsonl_files WHERE id=?').get(id); }
  list() {
    const files = this.db.prepare(`SELECT id,model,day,object_key,source,status,bytes,records,attempts,created_at,updated_at,error_code,http_status,sha256,
      uploaded_bytes,uploaded_parts,pause_reason,first_at
      FROM cl_push_jsonl_files ORDER BY created_at DESC,id DESC LIMIT 30`).all();
    const backlog = this.db.prepare(`SELECT COUNT(*) files,COALESCE(SUM(bytes),0) bytes,COALESCE(SUM(records),0) records,
      MIN(NULLIF(first_at,0)) firstAt,MIN(created_at) queuedAt FROM cl_push_jsonl_files WHERE status IN ('open','pending','running','failed')`).get();
    const retention = this.archive.policy().retention;
    backlog.expiryAt = retention && backlog.firstAt ? backlog.firstAt + retention * 86400000 : 0;
    backlog.atRisk = Boolean(backlog.expiryAt && backlog.expiryAt <= this.now() + 6 * 3600000);
    return { files, backlog, counts: this.db.prepare('SELECT status,COUNT(*) count FROM cl_push_jsonl_files GROUP BY status').all() };
  }
  admit(job, pinnedCopy) {
    const row = this.db.prepare(`SELECT original IS NOT NULL AS original,masked IS NOT NULL AS masked,length(original) original_bytes,length(masked) masked_bytes,
      processing_pending,processing_error,inspection_warnings,redaction_version,redaction_policy_hash FROM cl_records WHERE id=?`).get(job.record_id);
    const copy = row && (pinnedCopy || this.push.copySelection(row, job.source, this.archive.policy()));
    const bytes = copy && !copy.blocked && row[copy.source + '_bytes'];
    if (!bytes) throw Object.assign(new Error('COPY_UNAVAILABLE'), { code: 'COPY_UNAVAILABLE' });
    const budgetBytes = !pinnedCopy && copy.source === 'masked' ? Math.max(bytes, row.original_bytes || 0) : bytes;
    if (budgetBytes * 6 + 16777216 > this.memoryBudget()) throw Object.assign(new Error('EXPORT_MEMORY'), { code: 'EXPORT_MEMORY' });
  }
  defer(job, code, retryable = true) {
    const policy = this.push.policy(), attempts = job.attempts + 1;
    this.db.prepare(`UPDATE cl_push_jobs SET status=?,attempts=?,error_code=?,next_at=?,updated_at=? WHERE id=? AND status='pending'`)
      .run(retryable && attempts < policy.maxAttempts ? 'pending' : 'failed', attempts, code, this.now() + policy.retrySeconds * 1000, this.now(), job.id);
  }
  assignOne() {
    const policy = this.push.policy(); if (!this.enabled(policy)) return false;
    const job = this.db.prepare("SELECT * FROM cl_push_jobs WHERE destination='s3' AND status='pending' AND next_at<=? ORDER BY created_at,id LIMIT 1").get(this.now());
    if (!job) return false;
    const valid = this.push.validJob(job, policy);
    if (valid.cancel) {
      this.db.prepare("UPDATE cl_push_jobs SET status='cancelled',error_code=?,updated_at=? WHERE id=? AND status='pending'").run(valid.cancel, this.now(), job.id);
      return true;
    }
    let envelope;
    try { this.admit(job); envelope = this.push.envelope(job); }
    catch (error) { this.defer(job, error.code === 'EXPORT_MEMORY' ? 'EXPORT_MEMORY' : 'COPY_UNAVAILABLE'); return true; }
    const bytes = jsonlBytes(envelope), limit = this.maxFileBytes ?? policy.s3.jsonl.maxFileBytes;
    if (bytes > limit) { this.defer(job, 'JSONL_RECORD_TOO_LARGE', false); return true; }
    const day = dayAt(envelope.metadata.at, policy.s3.jsonl.timezone);
    const metadata = this.archive.seal(envelope.metadata, 'jsonl-metadata:' + job.id);
    if (this.archive.freeBytes() - metadata.length - 1048576 < this.archive.policy().reserve * 1024 ** 3) {
      this.defer(job, 'EXPORT_CAPACITY');
      for (const file of this.db.prepare("SELECT id FROM cl_push_jsonl_files WHERE status='open'").all()) this.seal(file.id);
      return true;
    }
    return this.db.transaction(() => {
      const current = this.db.prepare('SELECT status FROM cl_push_jobs WHERE id=?').get(job.id);
      if (current?.status !== 'pending' || this.push.policy().version !== policy.version || this.push.validJob(job).cancel) return true;
      let file = this.db.prepare("SELECT * FROM cl_push_jsonl_files WHERE target_hash=? AND source=? AND model=? AND day=? AND status='open'")
        .get(job.target_hash, job.source, envelope.metadata.model, day);
      if (file && file.bytes + bytes > limit) { this.seal(file.id); file = null; }
      if (!file) {
        const id = crypto.randomBytes(16).toString('hex'), at = this.now();
        this.db.prepare(`INSERT INTO cl_push_jsonl_files(id,target_hash,source,model,day,object_key,policy_version,archive_version,status,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,'open',?,?)`).run(id, job.target_hash, job.source, envelope.metadata.model, day,
          objectKey(policy.s3.prefix, day, envelope.metadata.model, at, id), policy.version, this.archive.policy().version, at, at);
        file = this.get(id);
      }
      const cutoff = this.db.prepare('SELECT flush_before FROM cl_push_jsonl_control WHERE singleton=1').get().flush_before;
      this.db.prepare(`INSERT INTO cl_push_jsonl_members(job_id,file_id,ordinal,metadata,fingerprint,processed_at,processing_policy_version,payload_source,fallback_reason)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(job.id, file.id, file.records, metadata,
        valid.row.fingerprint, valid.row.processed_at, valid.row.processing_policy_version, envelope.source, envelope.fallback_reason || '');
      this.db.prepare("UPDATE cl_push_jobs SET status='buffered',jsonl_file_id=?,error_code='',updated_at=? WHERE id=?").run(file.id, this.now(), job.id);
      this.db.prepare('UPDATE cl_push_jsonl_files SET bytes=bytes+?,records=records+1,force_flush=MAX(force_flush,?),first_at=CASE WHEN first_at=0 THEN ? ELSE MIN(first_at,?) END,updated_at=? WHERE id=?')
        .run(bytes, Number(Boolean(job.batch_id) || job.created_at <= cutoff), envelope.metadata.at, envelope.metadata.at, this.now(), file.id);
      if (file.bytes + bytes === limit) this.seal(file.id);
      return true;
    }).immediate();
  }
  seal(id) {
    return this.db.prepare("UPDATE cl_push_jsonl_files SET status='pending',sealed_at=?,next_at=?,updated_at=? WHERE id=? AND status='open'")
      .run(this.now(), this.now(), this.now(), id).changes;
  }
  sealDue() {
    const policy = this.push.policy(); if (!this.enabled(policy)) return 0;
    const backlog = this.db.prepare("SELECT 1 FROM cl_push_jobs WHERE destination='s3' AND status='pending' AND target_hash=? LIMIT 1").get(targetHash(policy, 's3'));
    let count = 0;
    const retention = this.archive.policy().retention;
    for (const file of this.db.prepare("SELECT * FROM cl_push_jsonl_files WHERE status='open'").all()) {
      const elapsed = policy.s3.jsonl.flushMinutes && this.now() - file.created_at >= policy.s3.jsonl.flushMinutes * 60000;
      const expiring = retention && file.first_at && file.first_at + retention * 86400000 <= this.now() + 6 * 3600000;
      if (elapsed || expiring || !backlog && (file.force_flush || file.day !== dayAt(this.now(), policy.s3.jsonl.timezone))) count += this.seal(file.id);
    }
    return count;
  }
  flush() {
    if (!this.enabled()) throw invalid('请先启用 S3 JSONL 推送', 'CONVERSATION_JSONL_DISABLED', 409);
    return this.db.transaction(() => {
      this.db.prepare('UPDATE cl_push_jsonl_control SET flush_before=? WHERE singleton=1').run(this.now());
      const files = this.db.prepare("UPDATE cl_push_jsonl_files SET force_flush=1 WHERE status='open'").run().changes;
      const queued = this.db.prepare("SELECT COUNT(*) n FROM cl_push_jobs WHERE destination='s3' AND status='pending'").get().n;
      return { files, queued };
    }).immediate();
  }
  invalidReason(file, { full = false } = {}) {
    const policy = this.push.policy();
    if (policy.source !== file.source || policy.s3.format !== 'jsonl' || targetHash(policy, 's3') !== file.target_hash) return 'TARGET_CHANGED';
    const archivePolicy = this.archive.policy();
    if (!modelAllowed(archivePolicy, file.model)) return 'COLLECTION_EXCLUDED';
    const counts = this.db.prepare(`SELECT COUNT(*) total,SUM(CASE WHEN j.status IN ('buffered','failed') AND j.jsonl_file_id=m.file_id THEN 1 ELSE 0 END) valid
      FROM cl_push_jsonl_members m LEFT JOIN cl_push_jobs j ON j.id=m.job_id WHERE m.file_id=?`).get(file.id);
    if (counts.total !== file.records || counts.valid !== file.records) return 'DELIVERY_INVALIDATED';
    if (full || file.archive_version !== archivePolicy.version) {
      const row = this.db.prepare(`SELECT r.id,r.user_id,r.model,r.complete,r.reason,r.fingerprint,m.fingerprint expected_fingerprint,
        r.original IS NOT NULL has_original,r.masked IS NOT NULL has_masked,r.processing_error,r.redaction_version,r.redaction_policy_hash,r.inspection_warnings,
        r.processed_at,r.processing_pending,m.processed_at expected_processed_at,r.processing_policy_version,m.processing_policy_version expected_processing_version,m.payload_source
        FROM cl_push_jsonl_members m JOIN cl_push_jobs j ON j.id=m.job_id LEFT JOIN cl_records r ON r.id=j.record_id
        WHERE m.file_id=? AND (r.id IS NULL OR r.model!=? OR (?='complete' AND (r.complete!=1 OR r.reason!='')) OR r.fingerprint!=m.fingerprint
          OR r.user_id IN (SELECT value FROM json_each(?)) OR CASE WHEN COALESCE(NULLIF(m.payload_source,''),?)='original' THEN r.original IS NULL
          ELSE r.processing_pending=1 OR r.masked IS NULL OR r.processing_error!='' OR r.inspection_warnings!='[]' OR r.redaction_version!=? OR r.redaction_policy_hash!=? END
          OR (?='masked' AND (r.processed_at!=m.processed_at OR r.processing_policy_version!=m.processing_policy_version))) LIMIT 1`)
        .get(file.id, file.model, policy.captureScope, JSON.stringify(archivePolicy.excludedUserIds), file.source, REDACTION_VERSION, redactionPolicyHash(archivePolicy), file.source);
      if (row) {
        const source = row.payload_source || file.source;
        if (!row.id) return 'RECORD_EXPIRED';
        if (source === 'masked' && row.processing_pending) return 'PROCESSING_PENDING';
        if (archivePolicy.excludedUserIds.includes(row.user_id) || row.model !== file.model) return 'COLLECTION_EXCLUDED';
        if (policy.captureScope === 'complete' && (!row.complete || row.reason)) return 'INCOMPLETE_CAPTURE';
        if (!(source === 'original' ? row.has_original : row.has_masked)) return 'COPY_UNAVAILABLE';
        if (source === 'masked' && row.inspection_warnings !== '[]') return 'INSPECTION_INCOMPLETE';
        if (row.fingerprint !== row.expected_fingerprint) return 'CONTENT_CHANGED';
        return source === 'masked' && (row.processing_error || row.redaction_version !== REDACTION_VERSION || row.redaction_policy_hash !== redactionPolicyHash(archivePolicy)) ? 'REDACTION_OUTDATED' : 'CONTENT_CHANGED';
      }
      this.db.prepare('UPDATE cl_push_jsonl_files SET archive_version=? WHERE id=?').run(archivePolicy.version, file.id);
    }
    return '';
  }
  cancel(file, reason) {
    this.db.prepare("UPDATE cl_push_jsonl_files SET status='cancelled',error_code=?,pause_reason='',lease_token='',lease_until=0,next_at=?,updated_at=? WHERE id=?")
      .run(reason, this.now(), this.now(), file.id);
    // Requeue in short transactions; assignment rechecks each remaining record.
    while (true) {
      const members = this.db.prepare('SELECT job_id FROM cl_push_jsonl_members WHERE file_id=? ORDER BY ordinal LIMIT 100').all(file.id);
      if (!members.length) break;
      this.db.transaction(() => {
        for (const member of members) {
          this.db.prepare("UPDATE cl_push_jobs SET status=?,jsonl_file_id='',error_code=?,next_at=?,updated_at=? WHERE id=? AND jsonl_file_id=? AND status IN ('buffered','failed')")
            .run(reason === 'TARGET_CHANGED' ? 'cancelled' : 'pending', reason === 'TARGET_CHANGED' ? reason : '', this.now(), this.now(), member.job_id, file.id);
          this.db.prepare('DELETE FROM cl_push_jsonl_members WHERE job_id=?').run(member.job_id);
        }
      }).immediate();
    }
  }
  reconcile() {
    const files = this.db.prepare(`SELECT * FROM cl_push_jsonl_files f WHERE (status IN ('open','pending','running','failed')
      OR status='cancelled' AND EXISTS(SELECT 1 FROM cl_push_jsonl_members m WHERE m.file_id=f.id)) AND id>? ORDER BY id LIMIT 30`).all(this.reconcileCursor || '');
    this.reconcileCursor = files.at(-1)?.id || '';
    for (const file of files) {
      if (file.status === 'cancelled') { this.cancel(file, file.error_code); continue; }
      const reason = this.invalidReason(file); if (reason) this.cancel(file, reason);
    }
  }
  recover() {
    this.db.prepare("UPDATE cl_push_jsonl_files SET status='pending',pause_reason='',lease_token='',lease_until=0,error_code='DELIVERY_UNKNOWN',next_at=? WHERE status='running'").run(this.now());
  }
  claim() {
    const policy = this.push.policy(); if (!this.enabled(policy)) return null;
    return this.db.transaction(() => {
      const file = this.db.prepare("SELECT * FROM cl_push_jsonl_files WHERE status='pending' AND (upload_id='' OR upload_version=1) AND next_at<=? ORDER BY sealed_at,id LIMIT 1").get(this.now());
      if (!file) return null;
      const token = crypto.randomUUID();
      this.db.prepare("UPDATE cl_push_jsonl_files SET status='running',attempts=attempts+1,lease_token=?,lease_until=?,updated_at=? WHERE id=? AND status='pending'")
        .run(token, this.now() + (policy.timeoutSeconds + 30) * 3000, this.now(), file.id);
      this.db.prepare("UPDATE cl_push_jobs SET status='buffered',attempts=?,updated_at=? WHERE jsonl_file_id=? AND status IN ('buffered','failed')").run(file.attempts + 1, this.now(), file.id);
      return { ...file, attempts: file.attempts + 1, lease_token: token };
    }).immediate();
  }
  guard(file, policyVersion, archiveVersion) {
    const current = this.get(file.id);
    if (current?.status !== 'running' || current.lease_token !== file.lease_token || this.push.policy().version !== policyVersion ||
      this.archive.policy().version !== archiveVersion) throw new Error('DELIVERY_INVALIDATED');
    if (current.lease_until - this.now() < 60000) this.db.prepare('UPDATE cl_push_jsonl_files SET lease_until=? WHERE id=? AND lease_token=?')
      .run(this.now() + 270000, file.id, file.lease_token);
  }
  uploadId(file, id) {
    return this.db.transaction(() => {
      const changed = this.db.prepare("UPDATE cl_push_jsonl_files SET upload_id=?,upload_version=1,uploaded_bytes=0,uploaded_parts=0,updated_at=? WHERE id=? AND status='running' AND lease_token=? AND upload_id=''")
        .run(id, this.now(), file.id, file.lease_token).changes;
      if (changed) this.db.prepare('DELETE FROM cl_push_jsonl_parts WHERE file_id=?').run(file.id);
      return changed;
    })();
  }
  clearUpload(id, uploadId, leaseToken = '') {
    return this.db.transaction(() => {
      const changed = this.db.prepare(`UPDATE cl_push_jsonl_files SET upload_id='',upload_version=0,uploaded_bytes=0,uploaded_parts=0 WHERE id=? AND upload_id=? AND
        ${leaseToken ? "status='running' AND lease_token=?" : "status!='running'"}`).run(id, uploadId, ...(leaseToken ? [leaseToken] : [])).changes;
      if (changed) this.db.prepare('DELETE FROM cl_push_jsonl_parts WHERE file_id=?').run(id);
      return changed;
    })();
  }
  abandonUpload(file, uploadId) {
    return this.db.prepare("UPDATE cl_push_jsonl_files SET upload_version=0 WHERE id=? AND upload_id=? AND status='running' AND lease_token=?")
      .run(file.id, uploadId, file.lease_token).changes;
  }
  parts(file) { return this.db.prepare('SELECT number,bytes,etag,sha256 FROM cl_push_jsonl_parts WHERE file_id=? ORDER BY number').all(file.id); }
  savePart(file, uploadId, part) {
    return this.db.transaction(() => {
      const current = this.get(file.id);
      if (current?.status !== 'running' || current.lease_token !== file.lease_token || current.upload_id !== uploadId ||
        part.number !== current.uploaded_parts + 1 || current.uploaded_bytes + part.bytes > current.bytes) return false;
      this.db.prepare('INSERT INTO cl_push_jsonl_parts VALUES(?,?,?,?,?)').run(file.id, part.number, part.bytes, part.etag, part.sha256);
      this.db.prepare('UPDATE cl_push_jsonl_files SET uploaded_bytes=uploaded_bytes+?,uploaded_parts=uploaded_parts+1,updated_at=? WHERE id=?')
        .run(part.bytes, this.now(), file.id);
      return true;
    })();
  }
  pause(file, reason) {
    this.db.prepare("UPDATE cl_push_jsonl_files SET pause_reason=?,updated_at=? WHERE id=? AND status='running' AND lease_token=? AND pause_reason!=?")
      .run(reason, this.now(), file.id, file.lease_token, reason);
  }
  async *envelopes(file, guard, checkpoint = async () => {}) {
    let ordinal = -1;
    while (true) {
      const members = this.db.prepare(`SELECT m.job_id,m.ordinal,m.metadata,m.payload_source,m.fallback_reason,j.* FROM cl_push_jsonl_members m
        LEFT JOIN cl_push_jobs j ON j.id=m.job_id WHERE m.file_id=? AND m.ordinal>? ORDER BY m.ordinal LIMIT 20`).all(file.id, ordinal);
      if (!members.length) break;
      for (const member of members) {
        await checkpoint();
        guard(); if (!member.id) throw new Error('DELIVERY_INVALIDATED');
        const valid = this.push.validJob(member);
        if (valid.paused || valid.cancel) throw new Error('DELIVERY_INVALIDATED');
        const copy = {source:member.payload_source || member.source,fallbackReason:member.fallback_reason};
        this.admit(member, copy);
        const envelope = this.push.envelope(member, copy);
        envelope.metadata = this.archive.open(member.metadata, 'jsonl-metadata:' + member.id);
        yield envelope; ordinal = member.ordinal;
        await new Promise(resolve => setImmediate(resolve));
      }
    }
  }
  finish(file, result) {
    const policy = this.push.policy(), retry = result.retryable && file.attempts < policy.maxAttempts;
    const status = retry ? 'pending' : result.status;
    return this.db.transaction(() => {
      const changed = this.db.prepare(`UPDATE cl_push_jsonl_files SET status=?,error_code=?,http_status=?,sha256=?,next_at=?,lease_token='',lease_until=0,pause_reason='',updated_at=?,
        upload_id=CASE WHEN ?='sent' THEN '' ELSE upload_id END WHERE id=? AND status='running' AND lease_token=?`)
        .run(status, result.errorCode || '', result.httpStatus || 0, result.sha256 || '', this.now() + Math.min(3600000, policy.retrySeconds * 1000 * 2 ** Math.max(0, file.attempts - 1)),
          this.now(), status, file.id, file.lease_token).changes;
      if (!changed) return 0;
      this.db.prepare("UPDATE cl_push_jobs SET status=?,error_code=?,http_status=?,updated_at=? WHERE jsonl_file_id=? AND status='buffered'")
        .run(status === 'sent' ? 'sent' : status === 'failed' ? 'failed' : 'buffered', result.errorCode || '', result.httpStatus || 0, this.now(), file.id);
      return changed;
    }).immediate();
  }
  retry(id) {
    const file = this.get(id);
    const policy = this.push.policy();
    if (!file || file.status !== 'failed' || !this.enabled(policy) || policy.source !== file.source || targetHash(policy, 's3') !== file.target_hash) {
      throw invalid('请先核对 JSONL 文件、当前目标和日志副本', 'CONVERSATION_PUSH_RETRY_BLOCKED', 409);
    }
    this.db.transaction(() => {
      this.db.prepare("UPDATE cl_push_jsonl_files SET status='pending',attempts=0,error_code='',next_at=?,updated_at=? WHERE id=? AND status='failed'").run(this.now(), this.now(), id);
    }).immediate();
    return { id, status: 'pending' };
  }
  cleanupMembers() {
    this.db.prepare(`DELETE FROM cl_push_jsonl_parts WHERE rowid IN (SELECT p.rowid FROM cl_push_jsonl_parts p
      JOIN cl_push_jsonl_files f ON f.id=p.file_id WHERE f.status='sent' LIMIT 200)`).run();
    return this.db.prepare(`DELETE FROM cl_push_jsonl_members WHERE rowid IN (SELECT m.rowid FROM cl_push_jsonl_members m
      JOIN cl_push_jsonl_files f ON f.id=m.file_id WHERE f.status='sent' LIMIT 200)`).run().changes;
  }
}

module.exports = { ConversationJsonlStore };
