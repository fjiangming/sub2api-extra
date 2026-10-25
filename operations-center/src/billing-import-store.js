'use strict';

const crypto = require('node:crypto');
const { AppError } = require('./errors');
const REVIEW_STATUSES = "'ambiguous','assignment_conflict','needs_review','unmatched','unmapped','invalid','duplicate','usage_difference','billing_unresolved','owner_candidate','time_uncertain','recorded_conflict','import_pending'";

class BillingImportStore {
  constructor(store) { this.store = store; this.now = store.now; }
  get db() { return this.store.db; }
  initialize() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS import_batches (
      id TEXT PRIMARY KEY, file_name TEXT NOT NULL, content_hash TEXT NOT NULL UNIQUE,
      csv TEXT NOT NULL, options TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS import_rows (
      id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES import_batches(id), number INTEGER NOT NULL,
      record TEXT NOT NULL, match TEXT, selection TEXT, selection_confirmed INTEGER NOT NULL DEFAULT 0,
      preview TEXT, status TEXT NOT NULL DEFAULT 'unmatched', case_id TEXT, result TEXT,
      version INTEGER NOT NULL DEFAULT 1, lease_until INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL, UNIQUE(batch_id,number));
      CREATE INDEX IF NOT EXISTS import_rows_batch ON import_rows(batch_id,number);
      CREATE UNIQUE INDEX IF NOT EXISTS import_one_preview_per_request ON import_rows(batch_id,json_extract(preview,'$.reference'))
        WHERE preview IS NOT NULL AND status IN ('preview','confirming','failed','settled');`);
    if (!this.db.pragma('table_info(import_batches)').some(column => column.name === 'metadata')) this.db.exec('ALTER TABLE import_batches ADD COLUMN metadata TEXT');
  }
  create(fileName, csv, contentHash, options, rows, metadata) {
    const existing = this.db.prepare('SELECT id FROM import_batches WHERE content_hash=?').get(contentHash);
    if (existing) return existing.id;
    const id = crypto.randomUUID();
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO import_batches(id,file_name,content_hash,csv,options,created_at,metadata) VALUES(?,?,?,?,?,?,?)').run(id, fileName, contentHash, csv, JSON.stringify(options), this.now(), JSON.stringify(metadata));
      const insert = this.db.prepare('INSERT INTO import_rows(id,batch_id,number,record,updated_at) VALUES(?,?,?,?,?)');
      for (const row of rows) insert.run(crypto.randomUUID(), id, row.number, JSON.stringify(row), this.now());
    })();
    return id;
  }
  batches() {
    return this.db.prepare(`SELECT b.id,b.file_name,b.created_at,COUNT(r.id) AS total,
      SUM(CASE WHEN r.status='settled' THEN 1 ELSE 0 END) AS settled FROM import_batches b
      LEFT JOIN import_rows r ON r.batch_id=b.id GROUP BY b.id ORDER BY b.created_at DESC LIMIT 50`).all();
  }
  defaults(metadata) {
    const signature = value => JSON.stringify([value.headers, value.keys?.slice().sort()]);
    for (const row of this.db.prepare('SELECT options,metadata FROM import_batches WHERE metadata IS NOT NULL ORDER BY created_at DESC LIMIT 50').all()) {
      const info = JSON.parse(row.metadata);
      if (info.matchDiagnostics && signature(info) === signature(metadata)) return JSON.parse(row.options);
    }
    return {};
  }
  batch(id) {
    const row = this.db.prepare('SELECT * FROM import_batches WHERE id=?').get(id);
    if (!row) throw new AppError('NOT_FOUND', '导入批次不存在', { status: 404 });
    return { ...row, options: JSON.parse(row.options), metadata: row.metadata ? JSON.parse(row.metadata) : null };
  }
  rows(id) { return this.db.prepare('SELECT * FROM import_rows WHERE batch_id=? ORDER BY number').all(id).map(decode); }
  page(id, filter, page, size = 20, userId = '') {
    let where = { all: '', actionable: " AND status IN ('exact','time_candidate','group_candidate','preview','failed','confirming')",
      review: ` AND status IN (${REVIEW_STATUSES})`,
      owners: " AND status='owner_candidate'", unresolved: " AND status='billing_unresolved'",
      recorded: " AND status IN ('already_recorded','already_imported')", settled: " AND status='settled'" }[filter];
    const args = [id];
    if (userId) {
      where += " AND COALESCE(json_extract(preview,'$.userId'),json_extract(match,'$.owner.userId'))=?";
      args.push(userId);
    }
    const summary = Object.fromEntries(this.db.prepare('SELECT status,COUNT(*) AS total FROM import_rows WHERE batch_id=? GROUP BY status').all(id).map(row => [row.status, row.total]));
    const total = Object.values(summary).reduce((sum, count) => sum + count, 0);
    const filteredTotal = this.db.prepare(`SELECT COUNT(*) AS total FROM import_rows WHERE batch_id=?${where}`).get(...args).total;
    page = Math.max(1, Math.min(Math.max(1, Math.ceil(filteredTotal / size)), page));
    const rows = this.db.prepare(`SELECT * FROM import_rows WHERE batch_id=?${where} ORDER BY number LIMIT ? OFFSET ?`).all(...args, size, (page - 1) * size).map(decode);
    const reviewUsers = this.db.prepare(`SELECT json_extract(match,'$.owner.userId') AS userId,COUNT(*) AS count,
      COUNT(DISTINCT json_extract(match,'$.owner.apiKeyId')) AS keys,
      COUNT(DISTINCT json_extract(match,'$.owner.accountId')) AS accounts
      FROM import_rows WHERE batch_id=? AND status IN (${REVIEW_STATUSES})
      AND json_extract(match,'$.owner.userId') IS NOT NULL GROUP BY userId ORDER BY count DESC,userId`).all(id);
    return { rows, total, filteredTotal, summary, page, pageSize: size, filter, userId, reviewUsers };
  }
  hasPreview(batchId, reference, excludeId) {
    return Boolean(this.db.prepare(`SELECT 1 FROM import_rows WHERE batch_id=? AND id<>? AND json_extract(preview,'$.reference')=?
      AND status IN ('preview','confirming','failed','settled') LIMIT 1`).get(batchId, excludeId, reference));
  }
  metadata(id, value) { this.db.prepare('UPDATE import_batches SET metadata=? WHERE id=?').run(JSON.stringify(value), id); }
  get(id) {
    const row = this.db.prepare('SELECT * FROM import_rows WHERE id=?').get(id);
    if (!row) throw new AppError('NOT_FOUND', '导入记录不存在', { status: 404 });
    return decode(row);
  }
  save(id, values, version) {
    const allowed = ['record', 'match', 'selection', 'selection_confirmed', 'preview', 'status', 'case_id', 'result', 'lease_until'];
    const keys = Object.keys(values).filter(key => allowed.includes(key));
    const json = new Set(['record', 'match', 'selection', 'preview', 'result']);
    const args = keys.map(key => json.has(key) && values[key] != null ? JSON.stringify(values[key]) : values[key]);
    const result = this.db.prepare(`UPDATE import_rows SET ${keys.map(key => `${key}=?`).join(',')},
      version=version+1,updated_at=? WHERE id=? AND version=?`).run(...args, this.now(), id, version);
    if (!result.changes) throw new AppError('PREVIEW_CONFLICT', '记录已变化，请刷新预览', { status: 409 });
    return this.get(id);
  }
  configure(id, options, records, metadata) {
    this.db.transaction(() => {
      const started = this.db.prepare("SELECT 1 FROM import_rows WHERE batch_id=? AND (status IN ('confirming','settled','failed') OR case_id IS NOT NULL) LIMIT 1").get(id);
      if (started && JSON.stringify(this.batch(id).options) !== JSON.stringify(options)) {
        throw new AppError('IMPORT_LOCKED', '已开始结算的批次不能更改匹配设置', { status: 409 });
      }
      this.db.prepare('UPDATE import_batches SET options=? WHERE id=?').run(JSON.stringify(options), id);
      this.metadata(id, metadata);
      for (const record of records) this.db.prepare(`UPDATE import_rows SET record=?,match=NULL,selection=NULL,selection_confirmed=0,
        preview=NULL,status='unmatched',result=NULL,updated_at=?,version=version+1 WHERE batch_id=? AND number=?
        AND case_id IS NULL AND status NOT IN ('confirming','settled','failed')`).run(JSON.stringify(record), this.now(), id, record.number);
    })();
  }
  claim(id, version, previewId) {
    const result = this.db.prepare(`UPDATE import_rows SET status='confirming',lease_until=?,version=version+1
      WHERE id=? AND version=? AND json_extract(preview,'$.id')=? AND
      (status='preview' OR (status IN ('confirming','failed') AND lease_until<=?))`).run(this.now() + 5 * 60000, id, version, previewId, this.now());
    if (!result.changes) throw new AppError('PREVIEW_CONFLICT', '预览已变化或结算正在进行，请刷新', { status: 409 });
    return this.get(id);
  }
}
function decode(row) {
  const result = { ...row };
  for (const key of ['record', 'match', 'selection', 'preview', 'result']) result[key] = row[key] ? JSON.parse(row[key]) : null;
  return result;
}

module.exports = { BillingImportStore };
