'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { z } = require('zod');
const { DateTime } = require('luxon');
const { AppError } = require('./errors');
const { decodeBody, maskPayload } = require('./services/conversation-redaction');
const { REDACTION_VERSION, redactionPolicyHash } = require('./services/conversation-sensitive');
const { recommendedModels, normalizeModel, modelAllowed } = require('./services/conversation-models');
const { inspectCompletion } = require('./services/conversation-completion');
const { projection, initializeMetadata, metadataStatus, backfillMetadata } = require('./services/conversation-metadata');

const userId = z.number().int().positive().safe();
const policySchema = z.object({
  version: z.number().int().positive(), enabled: z.boolean(), mode: z.enum(['dual', 'masked', 'original']),
  excludedUserIds: z.array(userId).max(1000), email: z.boolean(), phone: z.boolean(), secret: z.boolean(), ip: z.boolean(),
  identity: z.boolean().default(true), financial: z.boolean().default(true), personal: z.boolean().default(true), device: z.boolean().default(true),
  modelFilterEnabled: z.boolean().default(false),
  allowedModels: z.array(z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9 ._:/[\]-]*$/)).max(100).default([]),
  kimiK3Plus: z.boolean().default(false),
  custom: z.array(z.object({ from: z.string().trim().min(2).max(120), to: z.string().min(1).max(80) }).strict()).max(50),
  retention: z.number().int().min(0).max(365), capacity: z.number().int().min(1).max(1024),
  reserve: z.number().int().min(0).max(1024), overflow: z.enum(['stop', 'evict']), maxBodyBytes: z.number().int().min(65536).max(16777216)
}).strict();
const defaults = { version: 1, enabled: false, mode: 'dual', excludedUserIds: [], email: true, phone: true, secret: true, ip: true,
  identity: true, financial: true, personal: true, device: true,
  modelFilterEnabled: true, allowedModels: recommendedModels, kimiK3Plus: true,
  custom: [], retention: 7, capacity: 10, reserve: 2, overflow: 'stop', maxBodyBytes: 8388608 };
const frameSchema = z.object({ direction: z.enum(['in', 'out']), at: z.number().int().nonnegative().safe(), body: z.string(), binary: z.boolean().default(false) }).strict();
const eventSchema = z.object({
  schema: z.literal(1), id: z.string().regex(/^[a-f0-9]{32}$/), request_id: z.string().regex(/^[a-f0-9]{32}$/),
  user_id: userId, key_id: userId, account_id: z.number().int().nonnegative().safe(),
  session_id: z.string().regex(/^(?:[a-f0-9]{64})?$/), at: z.number().int().positive().safe(), duration_ms: z.number().int().nonnegative().safe(),
  host: z.string().max(255).regex(/^[a-zA-Z0-9.:[\]-]*$/), path: z.string().max(1024).regex(/^\/[^?#\s]*$/),
  method: z.enum(['POST', 'GET', 'PUT', 'PATCH', 'DELETE', 'WS']), protocol: z.enum(['JSON', 'SSE', 'WebSocket']),
  model: z.string().max(200).default(''), status: z.number().int().min(0).max(599), complete: z.boolean(),
  reason: z.enum(['', 'body_limit', 'memory_limit', 'transport_error', 'read_error', 'closed_early', 'session_closed']),
  policy_version: z.number().int().positive(), encoding: z.enum(['', 'identity', 'gzip', 'br', 'deflate', 'zstd', 'unknown']).default(''),
  request: z.string(), response: z.string(), frames: z.array(frameSchema).default([]),
  capture_version: z.union([z.literal(1),z.literal(2)]).default(1), body_sha256: z.string().regex(/^(?:[a-f0-9]{64})?$/).default('')
}).strict();
function invalid(code = 'CONVERSATION_INVALID_INPUT', status = 400) { return new AppError(code, '对话日志参数无效', { status }); }
function parse(schema, value) { const result = schema.safeParse(value); if (!result.success) throw invalid(); return result.data; }
function b64(value) {
  if (value.length % 4 || /[^A-Za-z0-9+/=]/.test(value)) throw invalid();
  const result = Buffer.from(value, 'base64');
  if (result.toString('base64') !== value) throw invalid();
  return result;
}
function pack(raw) { return { request: raw.request.toString('base64'), response: raw.response.toString('base64'), frames: raw.frames.map(frame => ({ ...frame, body: frame.body.toString('base64') })) }; }
function unpack(raw) { return { request: b64(raw.request), response: b64(raw.response), frames: raw.frames.map(frame => ({ ...frame, body: b64(frame.body) })) }; }
function bodyDigest(raw) {
  const hash = crypto.createHash('sha256');
  const number = value => { const buffer = Buffer.alloc(8); buffer.writeBigUInt64BE(BigInt(value)); hash.update(buffer); };
  const body = buffer => { number(buffer.length); hash.update(buffer); };
  body(raw.request); body(raw.response); number(raw.frames.length);
  for (const frame of raw.frames) { hash.update(frame.direction); number(frame.at); hash.update(Buffer.from([Number(frame.binary)])); body(frame.body); }
  return hash.digest('hex');
}
function processingError(error) {
  if (['REDACTION_MEMORY_PRESSURE','REDACTION_VALUE_LIMIT'].includes(error.code)) return error.code;
  const allowed = ['INVALID_JSON', 'PROTECTED_FIELD_MATCH', 'UNSUPPORTED_ENCODING', 'UNSAFE_SSE_REPLACEMENT',
    'DOCUMENT_TOO_DEEP', 'NESTED_ARGUMENTS_TOO_DEEP', 'BINARY_MESSAGE_REQUIRES_ORIGINAL_MODE', 'UNINSPECTABLE_CONTENT', 'REDACTION_RESOURCE_LIMIT', 'INCOMPLETE_PRIVATE_KEY'];
  if (allowed.includes(error.message)) return error.message;
  if (error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') return 'INVALID_UTF8';
  if (['Z_DATA_ERROR', 'Z_BUF_ERROR', 'ERR_BUFFER_TOO_LARGE'].includes(error.code)) return 'DECOMPRESSION_FAILED';
  return 'PROCESSING_FAILED';
}

class ConversationLogStore {
  constructor(directory, { now = Date.now, timezone = 'Asia/Shanghai', freeBytes, usedBytes, processingLimits = () => ({}) } = {}) {
    this.directory = path.join(directory, 'conversation-logs'); this.now = now; this.timezone = timezone;
    this.processingLimits = processingLimits;
    this.freeBytes = freeBytes || (() => { const stat = fs.statfsSync(this.directory); return Number(stat.bavail) * Number(stat.bsize); });
    this.usedBytes = usedBytes || (() => ['', '-wal', '-shm'].reduce((sum, suffix) => sum + (fs.existsSync(this.file + suffix) ? fs.statSync(this.file + suffix).size : 0), 0));
    this.lastContact = 0; this.lastError = null; this.collectorDropped = 0;
  }
  initialize() {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 }); this.file = path.join(this.directory, 'archive.sqlite');
    const keyFile = path.join(this.directory, 'archive.key');
    if (!fs.existsSync(keyFile)) {
      if (fs.existsSync(this.file)) throw new Error('CONVERSATION_KEY_MISSING');
      fs.writeFileSync(keyFile, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 });
    }
    this.key = fs.readFileSync(keyFile); if (this.key.length !== 32) throw new Error('CONVERSATION_KEY_INVALID');
    this.db = new Database(this.file);
    this.db.pragma('auto_vacuum = INCREMENTAL'); this.db.pragma('journal_mode = WAL'); this.db.pragma('synchronous = FULL');
    this.db.pragma('busy_timeout = 5000'); this.db.pragma('secure_delete = ON');
    this.db.exec(`CREATE TABLE IF NOT EXISTS cl_policies(version INTEGER PRIMARY KEY,body BLOB NOT NULL,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cl_records(id TEXT PRIMARY KEY,request_id TEXT NOT NULL,user_id INTEGER NOT NULL,key_id INTEGER NOT NULL,
        account_id INTEGER NOT NULL,session_id TEXT NOT NULL,at INTEGER NOT NULL,duration_ms INTEGER NOT NULL,
        host TEXT NOT NULL,path TEXT NOT NULL,method TEXT NOT NULL,protocol TEXT NOT NULL,model TEXT NOT NULL,status INTEGER NOT NULL,
        complete INTEGER NOT NULL,reason TEXT NOT NULL,policy_version INTEGER NOT NULL,mode TEXT NOT NULL,encoding TEXT NOT NULL,
        original BLOB,masked BLOB,hits TEXT NOT NULL,bytes INTEGER NOT NULL,fingerprint TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS cl_time ON cl_records(at DESC,id);
      CREATE INDEX IF NOT EXISTS cl_request ON cl_records(request_id,at);
      CREATE INDEX IF NOT EXISTS cl_session ON cl_records(user_id,key_id,session_id,at);`);
    this.db.transaction(() => {
      const columns = new Set(this.db.pragma('table_info(cl_records)').map(column => column.name));
      for (const [name, definition] of [['processing_error', "TEXT NOT NULL DEFAULT ''"], ['processing_policy_version', 'INTEGER NOT NULL DEFAULT 0'], ['processed_at', 'INTEGER NOT NULL DEFAULT 0'],
        ['redaction_version','INTEGER NOT NULL DEFAULT 0'], ['redaction_policy_hash',"TEXT NOT NULL DEFAULT ''"], ['capture_version','INTEGER NOT NULL DEFAULT 1'], ['body_sha256',"TEXT NOT NULL DEFAULT ''"],
        ['inspection_warnings',"TEXT NOT NULL DEFAULT '[]'"], ['upstream_status',"TEXT NOT NULL DEFAULT 'unknown'"],
        ['upstream_evidence',"TEXT NOT NULL DEFAULT ''"], ['completion_version','INTEGER NOT NULL DEFAULT 0'], ['completion_source',"TEXT NOT NULL DEFAULT ''"], ['archived_at','INTEGER NOT NULL DEFAULT 0']]) {
        if (!columns.has(name)) this.db.exec(`ALTER TABLE cl_records ADD COLUMN ${name} ${definition}`);
      }
    })();
    initializeMetadata(this.db);
    if (!this.db.prepare('SELECT 1 FROM cl_policies LIMIT 1').get()) this.db.prepare('INSERT INTO cl_policies VALUES(?,?,?)').run(1, this.seal(defaults, 'policy:1'), this.now());
    this.policy();
    try { fs.chmodSync(this.file, 0o600); } catch { /* Windows uses the directory ACL. */ }
    return this;
  }
  openReader() {
    this.file = path.join(this.directory, 'archive.sqlite');
    this.key = fs.readFileSync(path.join(this.directory, 'archive.key'));
    if (this.key.length !== 32) throw new Error('CONVERSATION_KEY_INVALID');
    this.db = new Database(this.file, { fileMustExist:true, timeout:1 });
    this.db.pragma('cache_size = -2048');
    this.db.pragma('wal_autocheckpoint = 0');
    return this;
  }
  metadataStatus() { return metadataStatus(this.db); }
  backfillMetadata() { return backfillMetadata(this.db); }
  seal(value, aad) {
    const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', this.key, nonce); cipher.setAAD(Buffer.from(aad));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
  }
  open(value, aad) {
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, value.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(value.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8'));
  }
  policy(version) {
    const row = version ? this.db.prepare('SELECT * FROM cl_policies WHERE version=?').get(version) : this.db.prepare('SELECT * FROM cl_policies ORDER BY version DESC LIMIT 1').get();
    if (!row) throw invalid('CONVERSATION_POLICY_NOT_FOUND', 409);
    return parse(policySchema, this.open(row.body, 'policy:' + row.version));
  }
  configure(body) {
    return this.db.transaction(() => {
      const current = this.policy();
      const candidate = parse(policySchema, { identity: current.identity, financial: current.financial, personal: current.personal, device: current.device,
        modelFilterEnabled: current.modelFilterEnabled, allowedModels: current.allowedModels, kimiK3Plus: current.kimiK3Plus, ...body });
      if (candidate.version !== current.version) throw invalid('CONVERSATION_POLICY_CONFLICT', 409);
      candidate.version++; candidate.excludedUserIds = [...new Set(candidate.excludedUserIds)].sort((a, b) => a - b);
      candidate.overflow = 'stop';
      candidate.allowedModels = [...new Set(candidate.allowedModels.map(normalizeModel))].sort();
      this.db.prepare('INSERT INTO cl_policies VALUES(?,?,?)').run(candidate.version, this.seal(candidate, 'policy:' + candidate.version), this.now());
      return candidate;
    })();
  }
  collectorPolicy(dropped = 0, collectorVersion = '') {
    if (/^\d{1,16}$/.test(String(dropped)) && Number.isSafeInteger(Number(dropped))) this.collectorDropped = Number(dropped);
    this.lastContact = this.now(); const policy = this.policy();
    this.collectorVersion = collectorVersion === '2' ? 2 : 1;
    const available = this.usedBytes() + 1048576 < policy.capacity * 1024 ** 3 && this.freeBytes() - 1048576 >= policy.reserve * 1024 ** 3;
    if (!available) this.lastError = 'capacity';
    else if (this.lastError === 'capacity') this.lastError = null;
    return { version: policy.version, enabled: policy.enabled && available, excluded_user_ids: policy.excludedUserIds, max_body_bytes: policy.maxBodyBytes,
      capture_version: 2, model_filter_version: 1, model_filter_enabled: policy.modelFilterEnabled, allowed_models: policy.allowedModels, kimi_k3_plus: policy.kimiK3Plus };
  }
  ingest(input) {
    const current = this.policy();
    // The second exclusion gate also discards in-flight events created before an exclusion was saved.
    if (!current.enabled || (Number.isSafeInteger(input?.user_id) && current.excludedUserIds.includes(input.user_id)) || !modelAllowed(current, input?.model)) return { accepted: false };
    const event = parse(eventSchema, input), policy = this.policy(event.policy_version);
    if (!policy.enabled || policy.excludedUserIds.includes(event.user_id) || !modelAllowed(policy, event.model)) return { accepted: false };
    if (event.at > this.now() + 60000 || current.retention && event.at < this.now() - current.retention * 86400000) return { accepted: false };
    const raw = { request: b64(event.request), response: b64(event.response), frames: event.frames.map(frame => ({ ...frame, body: b64(frame.body) })) };
    const rawBytes = raw.request.length + raw.response.length + raw.frames.reduce((sum, frame) => sum + frame.body.length, 0);
    // The transport safety bound covers the collector's global 64 MiB observation budget, including WS aliases.
    if (rawBytes > 192 * 1024 * 1024) throw invalid('CONVERSATION_RESOURCE_LIMIT', 413);
    const digest = bodyDigest(raw);
    if (event.capture_version === 2 && event.body_sha256 !== digest) throw invalid('CONVERSATION_INTEGRITY_FAILED', 422);
    const ack = { accepted: true, id: event.id, body_sha256: digest };
    const { capture_version, body_sha256, ...legacy } = event;
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(event.capture_version === 1 ? legacy : event)).digest('hex');
    const existing = this.db.prepare('SELECT fingerprint FROM cl_records WHERE id=?').get(event.id);
    if (existing) { if (existing.fingerprint !== fingerprint) throw invalid('CONVERSATION_ID_CONFLICT', 409); return { ...ack, duplicate: true }; }
    const canFit = bytes => this.usedBytes() + bytes < current.capacity * 1024 ** 3 && this.freeBytes() - bytes >= current.reserve * 1024 ** 3;
    if (!canFit(rawBytes * (policy.mode === 'dual' ? 3 : 1.5) + 4096)) { this.lastError = 'capacity'; return { accepted: false, reason: 'capacity' }; }
    let original = null, masked = null, hits = [], warnings = [], reason = event.reason, processing_error = '';
    const limits = this.processingLimits(), completion = inspectCompletion(raw, event, limits);
    if (rawBytes || !['body_limit', 'memory_limit'].includes(reason)) {
      try {
        if (policy.mode !== 'original') { const result = maskPayload(raw, policy, this.key, event.encoding, limits); masked = this.seal(pack(result.payload), event.id + ':masked'); hits = result.hits; warnings = result.warnings; }
        if (policy.mode !== 'masked' || warnings.length) original = this.seal(pack(raw), event.id + ':original');
      } catch (error) {
        // Explicit operator policy: failed processing retains the exact encrypted source, even in masked mode.
        original = this.seal(pack(raw), event.id + ':original'); masked = null; hits = []; warnings = []; processing_error = processingError(error);
      }
    }
    const storedBytes = (original?.length || 0) + (masked?.length || 0) + 2048;
    const { schema, request, response, frames, ...metadata } = event;
    try { return this.db.transaction(() => {
      // Processing runs outside the write lock; a policy saved by the API process wins here.
      const latest = this.policy();
      if (!latest.enabled || latest.excludedUserIds.includes(event.user_id) || !modelAllowed(latest, event.model) ||
        latest.retention && event.at < this.now() - latest.retention * 86400000) return { accepted: false };
      const duplicate = this.db.prepare('SELECT fingerprint FROM cl_records WHERE id=?').get(event.id);
      if (duplicate) { if (duplicate.fingerprint !== fingerprint) throw invalid('CONVERSATION_ID_CONFLICT', 409); return { ...ack, duplicate: true }; }
      if (this.usedBytes() + storedBytes >= latest.capacity * 1024 ** 3 || this.freeBytes() - storedBytes < latest.reserve * 1024 ** 3) {
        this.lastError = 'capacity'; return { accepted: false, reason: 'capacity' };
      }
      this.db.prepare(`INSERT INTO cl_records(id,request_id,user_id,key_id,account_id,session_id,at,duration_ms,
      host,path,method,protocol,model,status,complete,reason,policy_version,mode,encoding,original,masked,hits,bytes,fingerprint,
      processing_error,processing_policy_version,processed_at,redaction_version,redaction_policy_hash,capture_version,body_sha256,inspection_warnings,upstream_status,upstream_evidence,completion_version,completion_source,archived_at) VALUES(@id,@request_id,@user_id,@key_id,@account_id,@session_id,@at,@duration_ms,
      @host,@path,@method,@protocol,@model,@status,@complete,@reason,@policy_version,@mode,@encoding,@original,@masked,@hits,@bytes,@fingerprint,
      @processing_error,@processing_policy_version,@processed_at,@redaction_version,@redaction_policy_hash,@capture_version,@body_sha256,@inspection_warnings,@upstream_status,@upstream_evidence,@completion_version,@completion_source,@archived_at)`)
      .run({ ...metadata, ...completion, completion_source: 'original', archived_at: this.now(), complete: event.complete && !reason ? 1 : 0, reason, mode: policy.mode, original, masked, hits: JSON.stringify(hits), bytes: storedBytes, fingerprint,
        body_sha256: digest, redaction_version: masked ? REDACTION_VERSION : 0, redaction_policy_hash: masked ? redactionPolicyHash(policy) : '',
        inspection_warnings: JSON.stringify(warnings), processing_error, processing_policy_version: policy.mode === 'original' ? 0 : policy.version, processed_at: this.now() });
      this.lastError = null; return ack;
    }).immediate();
    } catch (error) {
      if (!/^SQLITE_(?:FULL|IOERR|READONLY|BUSY|CANTOPEN|NOMEM|CORRUPT)/.test(error.code || '')) throw error;
      this.lastError = 'storage_failed'; return { accepted: false, reason: 'storage_failed' };
    }
  }
  retry(id, input, { beforeCommit = () => {}, afterCommit = () => {}, detail = true } = {}) {
    const expected = parse(z.object({ policy_version: z.number().int().positive(), processed_at: z.number().int().nonnegative().safe() }).strict(), input);
    const fields = 'user_id,model,mode,protocol,status,encoding,processed_at,processing_error,redaction_version,redaction_policy_hash,inspection_warnings,hits';
    const policy = this.policy(), row = this.db.prepare(`SELECT ${fields},original FROM cl_records WHERE id=?`).get(id);
    const validate = (policy, row) => {
      if (!row) throw invalid('CONVERSATION_NOT_FOUND', 404);
      if (policy.excludedUserIds.includes(row.user_id)) throw new AppError('CONVERSATION_USER_EXCLUDED', '该用户已排除，不能重新处理', { status: 409 });
      if (!modelAllowed(policy, row.model)) throw new AppError('CONVERSATION_MODEL_EXCLUDED', '该模型不在采集名单中，不能重新处理', { status: 409 });
      if (policy.version !== expected.policy_version || row.processed_at !== expected.processed_at) throw new AppError('CONVERSATION_RETRY_CONFLICT', '策略或记录已更新，请刷新后重试', { status: 409 });
      if (!this.publicRow(row).retry_available) throw new AppError('CONVERSATION_RETRY_UNAVAILABLE', '没有待处理的原文；历史缺失正文无法恢复', { status: 409 });
    };
    validate(policy, row);
    let result, errorCode = '', completion;
    try {
      const raw = unpack(this.open(row.original, id + ':original')), limits = this.processingLimits();
      completion = inspectCompletion(raw, row, limits);
      result = maskPayload(raw, policy, this.key, row.encoding, limits);
    }
    catch (error) { errorCode = processingError(error); }
    const masked = result ? this.seal(pack(result.payload), id + ':masked') : null;
    this.db.transaction(() => {
      validate(this.policy(), this.db.prepare(`SELECT ${fields},original IS NOT NULL original FROM cl_records WHERE id=?`).get(id));
      beforeCommit();
      if (completion) this.db.prepare("UPDATE cl_records SET upstream_status=@upstream_status,upstream_evidence=@upstream_evidence,completion_version=@completion_version,completion_source='original' WHERE id=@id").run({ id, ...completion });
      const processedAt = Math.max(this.now(), row.processed_at + 1);
      if (errorCode) {
        this.db.prepare('UPDATE cl_records SET processing_error=?,processing_policy_version=?,processed_at=? WHERE id=?')
          .run(errorCode, policy.version, processedAt, id);
        afterCommit({ processing_error: errorCode, inspection_warnings: [] });
        return;
      }
      const original = row.mode === 'masked' && !result.warnings.length ? null : row.original;
      // Reserve space for the new encrypted copy before atomically removing a fallback source.
      if (this.usedBytes() + masked.length + 2048 >= policy.capacity * 1024 ** 3 || this.freeBytes() - masked.length - 2048 < policy.reserve * 1024 ** 3) {
        throw new AppError('CONVERSATION_RETRY_CAPACITY', '空间不足，已保留原文，请释放空间后重试', { status: 409 });
      }
      this.db.prepare(`UPDATE cl_records SET original=?,masked=?,hits=?,bytes=?,processing_error='',processing_policy_version=?,processed_at=?,redaction_version=?,redaction_policy_hash=?,inspection_warnings=? WHERE id=?`)
        .run(original, masked, JSON.stringify(result.hits), (original?.length || 0) + masked.length + 2048, policy.version, processedAt, REDACTION_VERSION, redactionPolicyHash(policy), JSON.stringify(result.warnings), id);
      afterCommit({ processing_error: '', inspection_warnings: result.warnings });
    }).immediate();
    return detail ? this.detail(id) : undefined;
  }
  analyze(id, expected, { beforeCommit = () => {}, afterCommit = () => {} } = {}) {
    const policy = this.policy(), row = this.db.prepare(`SELECT user_id,model,bytes,processed_at,protocol,status,encoding,
      CASE WHEN original IS NOT NULL THEN original ELSE masked END payload,
      CASE WHEN original IS NOT NULL THEN 'original' WHEN masked IS NOT NULL THEN 'masked' ELSE '' END source FROM cl_records WHERE id=?`).get(id);
    if (!row || policy.version !== expected.policy_version || row.processed_at !== expected.processed_at || policy.excludedUserIds.includes(row.user_id) || !modelAllowed(policy, row.model)) {
      throw invalid('CONVERSATION_RETRY_CONFLICT', 409);
    }
    const source = row.source;
    if (!source) return false;
    const ensureSpace = () => {
      const bytes = row.bytes + 4096;
      if (this.usedBytes() + bytes >= policy.capacity * 1024 ** 3 || this.freeBytes() - bytes < policy.reserve * 1024 ** 3) {
        throw new AppError('CONVERSATION_RETRY_CAPACITY', '空间不足，已保留原记录，请释放空间后重试', { status: 409 });
      }
    };
    ensureSpace();
    const raw = unpack(this.open(row.payload, id + ':' + source));
    const completion = inspectCompletion(raw, { ...row, encoding: source === 'masked' ? '' : row.encoding }, this.processingLimits());
    this.db.transaction(() => {
      const latest = this.db.prepare('SELECT processed_at FROM cl_records WHERE id=?').get(id);
      if (this.policy().version !== policy.version || latest?.processed_at !== row.processed_at) throw invalid('CONVERSATION_RETRY_CONFLICT', 409);
      beforeCommit();
      ensureSpace();
      this.db.prepare('UPDATE cl_records SET upstream_status=@upstream_status,upstream_evidence=@upstream_evidence,completion_version=@completion_version,completion_source=@source WHERE id=@id')
        .run({ ...completion, source, id });
      afterCommit(completion);
    }).immediate();
    return true;
  }
  prune() {
    const removed = this.db.transaction(() => {
      const { retention } = this.policy();
      return retention ? this.db.prepare('DELETE FROM cl_records WHERE at<?').run(this.now() - retention * 86400000).changes : 0;
    }).immediate();
    if (removed) { this.db.pragma('wal_checkpoint(TRUNCATE)'); this.db.pragma('incremental_vacuum(128)'); }
    return removed;
  }
  where(query = {}, indexed = false) {
    const clauses = [], args = [];
    for (const [field, max] of [['request_id', 32], ['session_id', 64], ['protocol', 16]]) if (query[field]) {
      clauses.push(`${field}=?`); args.push(String(query[field]).slice(0, max));
    }
    for (const field of ['user_id', 'key_id']) if (query[field]) { const id = Number(query[field]); if (!Number.isSafeInteger(id) || id < 1) throw invalid(); clauses.push(`${field}=?`); args.push(id); }
    if (query.search) { clauses.push('(id LIKE ? OR request_id LIKE ? OR model LIKE ? OR CAST(user_id AS TEXT)=?)'); const search = String(query.search).slice(0, 200); args.push('%' + search + '%', '%' + search + '%', '%' + search + '%', search); }
    if (query.capture === 'complete') clauses.push('complete=1');
    else if (query.capture === 'partial') clauses.push(indexed ? 'complete=0 AND (original!=0 OR masked!=0)' : 'complete=0 AND (original IS NOT NULL OR masked IS NOT NULL)');
    else if (query.capture === 'missing') clauses.push(indexed ? 'original=0 AND masked=0' : 'original IS NULL AND masked IS NULL');
    else if (query.capture === 'redaction_failed') clauses.push("(processing_error!='' OR reason='redaction_failed')");
    for (const field of ['start', 'end']) if (query[field]) {
      const date = DateTime.fromISO(String(query[field]), { zone: this.timezone }); if (!date.isValid) throw invalid();
      clauses.push(`at${field === 'start' ? '>=' : '<'}?`); args.push((field === 'start' ? date.startOf('day') : date.plus({ days: 1 }).startOf('day')).toMillis());
    }
    if (query.start && query.end && String(query.start) > String(query.end)) throw invalid();
    return { sql: clauses.length ? ' WHERE ' + clauses.join(' AND ') : '', args };
  }
  publicRow(row) {
    const { original, masked, fingerprint, hits, inspection_warnings, ...metadata } = row;
    const warnings = JSON.parse(inspection_warnings || '[]');
    const policy = this.policy(), excluded = policy.excludedUserIds.includes(row.user_id);
    const modelExcluded = !modelAllowed(policy, row.model);
    const outdated = row.mode !== 'original' && (row.redaction_version !== REDACTION_VERSION || row.redaction_policy_hash !== redactionPolicyHash(policy));
    return { ...metadata, inspection_warnings: warnings, complete: Boolean(row.complete), original: Boolean(original), masked: Boolean(masked), hits: JSON.parse(hits),
      redaction_outdated: outdated, retry_available: Boolean(original && (row.processing_error || outdated || warnings.length) && !excluded && !modelExcluded), retry_blocked: excluded ? 'user_excluded' : modelExcluded ? 'model_excluded' : !original ? 'no_original' : '' };
  }
  list(query = {}) {
    return this.db.transaction(() => {
    const page = Math.max(1, Math.min(1000000, Number(query.page) || 1)) | 0, pageSize = 20;
    const filter = this.where(query,true);
    const summary = this.db.prepare(`SELECT COUNT(*) total,COUNT(DISTINCT request_id) requests,COALESCE(SUM(complete),0) complete,COALESCE(SUM(bytes),0) bytes FROM cl_record_metadata${filter.sql}`).get(...filter.args);
    const items = this.db.prepare(`SELECT * FROM cl_record_metadata${filter.sql} ORDER BY at DESC,id LIMIT ? OFFSET ?`).all(...filter.args, pageSize, (page - 1) * pageSize).map(row => this.publicRow(row));
    return { items, summary, page, pageSize, pages: Math.ceil(summary.total / pageSize), metadataIndex:this.metadataStatus() };
    })();
  }
  detail(id) {
    const row = this.db.prepare('SELECT * FROM cl_record_metadata WHERE id=?').get(id)
      || this.db.prepare('SELECT ' + projection() + ' FROM cl_records WHERE id=?').get(id); if (!row) throw invalid('CONVERSATION_NOT_FOUND', 404);
    const result = this.publicRow(row);
    result.attempts = this.db.prepare('SELECT id,account_id,status,protocol,at,complete,reason FROM cl_records WHERE request_id=? AND user_id=? AND key_id=? ORDER BY at,id LIMIT 100')
      .all(row.request_id, row.user_id, row.key_id);
    const source = row.masked ? 'masked' : row.original ? 'original' : '';
    const payload = row.protocol === 'WebSocket' && source ? this.db.prepare(`SELECT ${source} payload FROM cl_records WHERE id=?`).get(id)?.payload : null;
    const copy = payload ? unpack(this.open(payload,id + ':' + source)) : null;
    result.frames = copy?.frames.map((frame, index) => ({ index, direction: frame.direction, at: frame.at, binary: frame.binary, bytes: frame.body.length })) || [];
    return result;
  }
  payload(id, source, side, {decodeText=true} = {}) {
    if (!['original', 'masked'].includes(source) || !/^(request|response|frame-\d+)$/.test(side)) throw invalid();
    const row = this.db.prepare(`SELECT encoding,${source} FROM cl_records WHERE id=?`).get(id);
    if (!row || !row[source]) throw invalid('CONVERSATION_COPY_NOT_FOUND', 404);
    const raw = unpack(this.open(row[source], id + ':' + source));
    const body = side.startsWith('frame-') ? raw.frames[Number(side.slice(6))]?.body : raw[side]; if (!body) throw invalid('CONVERSATION_MESSAGE_NOT_FOUND', 404);
    let text = null, textLimited = false;
    if (decodeText) try { text = decodeBody(body, source === 'original' && side === 'response' ? row.encoding : '',this.processingLimits().maxOutputBytes); }
    catch(error) { textLimited = error.code === 'REDACTION_MEMORY_PRESSURE'; /* Raw bytes remain downloadable even when text decoding fails. */ }
    return { body, text, textLimited, sha256: crypto.createHash('sha256').update(body).digest('hex'), bytes: body.length };
  }
  sessions(query = {}) {
    return this.db.transaction(() => {
    const filter = this.where(query,true), clause = filter.sql ? filter.sql + " AND session_id!=''" : " WHERE session_id!=''";
    return { items: this.db.prepare(`SELECT session_id,user_id,key_id,COUNT(DISTINCT request_id) turns,COUNT(*) attempts,MIN(at) first_at,MAX(at) last_at FROM cl_record_metadata${clause}
      GROUP BY user_id,key_id,session_id ORDER BY last_at DESC LIMIT 100`).all(...filter.args), metadataIndex:this.metadataStatus() };
    })();
  }
  exportIndex(query = {}) {
    if (!this.metadataStatus().ready) throw new AppError('CONVERSATION_HISTORY_PREPARING','历史日志仍在准备，请稍后导出完整索引',{status:409});
    const filter = this.where(query,true);
    const columns = ['id', 'request_id', 'user_id', 'key_id', 'account_id', 'at', 'protocol', 'model', 'status', 'complete', 'reason'];
    const rows = this.db.prepare(`SELECT ${columns.join(',')} FROM cl_record_metadata${filter.sql} ORDER BY at DESC,id LIMIT 10001`).all(...filter.args);
    if (rows.length > 10000) throw invalid('CONVERSATION_EXPORT_TOO_LARGE', 400);
    const cell = value => {
      let text = String(value ?? '');
      if (/^\s*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
      return '"' + text.replaceAll('"', '""') + '"';
    };
    return { csv: [columns, ...rows.map(row => columns.map(column => row[column]))].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n', count: rows.length };
  }
  status() {
    return this.db.transaction(() => {
    const metadataIndex = this.metadataStatus();
    const counts = this.db.prepare("SELECT COUNT(*) records,COALESCE(SUM(bytes),0) bytes,COALESCE(SUM(complete=0),0) gaps,COALESCE(SUM(processing_error!='' OR reason='redaction_failed'),0) processingFailures FROM cl_record_metadata").get();
    if (!metadataIndex.ready) { counts.records = metadataIndex.total; counts.bytes = null; counts.gaps = null; counts.processingFailures = null; }
    return { ...counts, metadataIndex, ...this.liveStatus(), redactionVersion: REDACTION_VERSION, policy: this.policy(), diskBytes: this.usedBytes(), freeBytes: this.freeBytes(), timezone: this.timezone,
      coverage: ['HTTP JSON / SSE (including TLS fingerprint and transport fallbacks)', 'OpenAI pooled WebSocket / passthrough messages'],
      limitations: ['Only bytes consumed by the gateway are observed; early close is marked incomplete.', 'Queue/process failure can lose archives; this archive does not control inference or billing.'] };
    })();
  }
  liveStatus() { return {lastContact:this.lastContact || null,lastError:this.lastError,collectorDropped:this.collectorDropped,collectorVersion:this.collectorVersion || null}; }
  start() { this.timer = setInterval(() => { try { this.prune(); } catch { this.lastError = 'retention_failed'; } }, 60000); this.timer.unref(); }
  close() { clearInterval(this.timer); this.db?.close(); this.db = null; this.key?.fill(0); }
}

module.exports = { ConversationLogStore, policySchema, eventSchema, defaults, bodyDigest };
