'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { AppError } = require('./errors');

class AccountingStore {
  constructor(directory, scope) { this.directory = directory; this.scope = scope; }

  initialize() {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.db = new Database(path.join(this.directory, 'accounting.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS accounting_documents (
      scope TEXT NOT NULL, key TEXT NOT NULL, date TEXT NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY(scope,key));
      CREATE INDEX IF NOT EXISTS accounting_documents_date ON accounting_documents(scope,date);
      CREATE TABLE IF NOT EXISTS accounting_decisions (
      scope TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL, linked_key TEXT,
      PRIMARY KEY(scope,key));
      CREATE UNIQUE INDEX IF NOT EXISTS accounting_link_unique ON accounting_decisions(scope,linked_key)
        WHERE linked_key IS NOT NULL;
      CREATE TABLE IF NOT EXISTS accounting_settings (
      scope TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(scope,key));
      CREATE TABLE IF NOT EXISTS accounting_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, key TEXT NOT NULL,
      actor TEXT NOT NULL, reason TEXT NOT NULL, before_value TEXT, after_value TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS accounting_results (
      scope TEXT NOT NULL, date TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(scope,date));
      CREATE TABLE IF NOT EXISTS cash_records (
      scope TEXT NOT NULL, key TEXT NOT NULL, source TEXT NOT NULL, date TEXT NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY(scope,key));
      CREATE INDEX IF NOT EXISTS cash_records_date ON cash_records(scope,date);
      CREATE TABLE IF NOT EXISTS cash_requests (
      scope TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, key TEXT NOT NULL,
      PRIMARY KEY(scope,request_id));`);
  }

  documents() { return this.db.prepare('SELECT payload FROM accounting_documents WHERE scope=?').all(this.scope).map(row => JSON.parse(row.payload)); }
  document(key) { const row = this.db.prepare('SELECT payload FROM accounting_documents WHERE scope=? AND key=?').get(this.scope, key); return row ? JSON.parse(row.payload) : null; }
  cashRecords() { return this.db.prepare('SELECT payload FROM cash_records WHERE scope=?').all(this.scope).map(row => JSON.parse(row.payload)); }
  cashRecord(key) { const row = this.db.prepare('SELECT payload FROM cash_records WHERE scope=? AND key=?').get(this.scope, key); return row ? JSON.parse(row.payload) : null; }
  saveCashSync(value) {
    this.db.prepare(`INSERT INTO accounting_settings(scope,key,payload) VALUES (?,'cash:sync',?)
      ON CONFLICT(scope,key) DO UPDATE SET payload=excluded.payload`).run(this.scope, JSON.stringify(value));
  }
  putCash(record, actor = null, reason = '现金记录更新') {
    const previous = this.cashRecord(record.key);
    if (JSON.stringify(previous) === JSON.stringify(record)) return previous;
    this.db.prepare(`INSERT INTO cash_records(scope,key,source,date,payload) VALUES (?,?,?,?,?)
      ON CONFLICT(scope,key) DO UPDATE SET source=excluded.source,date=excluded.date,payload=excluded.payload`)
      .run(this.scope, record.key, record.source, record.date, JSON.stringify(record));
    if (actor || previous) this.audit(`cash:${record.key}`, previous, record, actor || 'source-sync', reason);
    return record;
  }
  decisions() { return Object.fromEntries(this.db.prepare('SELECT key,payload FROM accounting_decisions WHERE scope=?').all(this.scope).map(row => [row.key, JSON.parse(row.payload)])); }
  setting(key, fallback = null) { const row = this.db.prepare('SELECT payload FROM accounting_settings WHERE scope=? AND key=?').get(this.scope, key); return row ? JSON.parse(row.payload) : fallback; }

  audit(key, before, after, actor, reason) {
    this.db.prepare(`INSERT INTO accounting_audit(scope,key,actor,reason,before_value,after_value,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(this.scope, key, String(actor || 'administrator'), reason,
      before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after), new Date().toISOString());
  }

  invalidate(date = '0001-01-01') { this.db.prepare('DELETE FROM accounting_results WHERE scope=? AND date>=?').run(this.scope, date); }

  importDocuments(documents) {
    return this.db.transaction(() => {
      let changed = false;
      for (const document of documents) {
        const previous = this.document(document.key);
        if (JSON.stringify(previous) === JSON.stringify(document)) continue;
        this.db.prepare(`INSERT INTO accounting_documents(scope,key,date,payload) VALUES (?,?,?,?)
          ON CONFLICT(scope,key) DO UPDATE SET date=excluded.date,payload=excluded.payload`)
          .run(this.scope, document.key, document.date, JSON.stringify(document));
        if (previous) this.audit(document.key, previous, document, 'source-sync', '来源记录变化，原值保留在审计中');
        this.invalidate(previous && previous.date < document.date ? previous.date : document.date);
        changed = true;
      }
      return changed;
    })();
  }

  decide(key, input, actor) {
    return this.db.transaction(() => {
      const before = this.decisions()[key] || null;
      if (!this.document(key)) throw new AppError('ACCOUNTING_NOT_FOUND', '核算记录不存在', { status: 404 });
      if (input.linkedKey && !this.document(input.linkedKey)) throw new AppError('ACCOUNTING_LINK_NOT_FOUND', '关联记录不存在，请先完成对应日期同步', { status: 400 });
      const decision = { ...input, updatedAt: new Date().toISOString(), actor: actor || 'administrator' };
      try {
        this.db.prepare(`INSERT INTO accounting_decisions(scope,key,payload,linked_key) VALUES (?,?,?,?)
          ON CONFLICT(scope,key) DO UPDATE SET payload=excluded.payload,linked_key=excluded.linked_key`)
          .run(this.scope, key, JSON.stringify(decision), decision.kind === 'reference' ? null : decision.linkedKey || null);
      } catch (error) {
        if (error.code?.startsWith('SQLITE_CONSTRAINT')) throw new AppError('ACCOUNTING_DUPLICATE_LINK', '该来源已关联其他记录，不能重复入账', { status: 409 });
        throw error;
      }
      this.audit(key, before, decision, actor, input.reason);
      // A funding correction can change every subsequent weighted balance allocation.
      const document = this.document(key);
      this.invalidate([document.date, input.date, input.serviceStart, input.cancelDate,
        before?.date, before?.serviceStart, before?.cancelDate].filter(Boolean).sort()[0]);
      return decision;
    })();
  }

  saveSetting(key, value, actor, reason) {
    return this.db.transaction(() => {
      const before = this.setting(key);
      this.db.prepare(`INSERT INTO accounting_settings(scope,key,payload) VALUES (?,?,?)
        ON CONFLICT(scope,key) DO UPDATE SET payload=excluded.payload`).run(this.scope, key, JSON.stringify(value));
      this.audit(`setting:${key}`, before, value, actor, reason);
      this.invalidate();
      return value;
    })();
  }

  create(document, actor) {
    return this.db.transaction(() => {
      const key = `manual:${document.requestId || crypto.randomUUID()}`;
      const previous = this.document(key);
      if (previous) {
        const { key: _key, createdAt: _createdAt, origin: _origin, ...original } = previous;
        if (JSON.stringify(original) !== JSON.stringify(document)) throw new AppError('ACCOUNTING_REQUEST_CONFLICT', '同一次记账请求不能提交不同内容', { status: 409 });
        return previous;
      }
      if (this.db.prepare('SELECT COUNT(*) AS total FROM accounting_documents WHERE scope=?').get(this.scope).total >= 200000) throw new AppError('ACCOUNTING_CAPACITY', '核算账记录已达到容量限制', { status: 409 });
      const value = { ...document, key, origin: 'manual', createdAt: new Date().toISOString() };
      this.importDocuments([value]);
      this.audit(key, null, value, actor, document.reason);
      return value;
    })();
  }

  results(start, end) { return this.db.prepare('SELECT payload FROM accounting_results WHERE scope=? AND date>=? AND date<=? ORDER BY date').all(this.scope, start, end).map(row => JSON.parse(row.payload)); }
  saveResults(rows) {
    this.db.transaction(() => {
      const write = this.db.prepare(`INSERT INTO accounting_results(scope,date,payload) VALUES (?,?,?)
        ON CONFLICT(scope,date) DO UPDATE SET payload=excluded.payload WHERE accounting_results.payload<>excluded.payload`);
      for (const row of rows) write.run(this.scope, row.date, JSON.stringify(row));
    })();
  }
  history(key, limit = 100) { return this.db.prepare('SELECT * FROM accounting_audit WHERE scope=? AND key=? ORDER BY id DESC LIMIT ?').all(this.scope, key, limit).map(row => ({ ...row, before_value: row.before_value && JSON.parse(row.before_value), after_value: row.after_value && JSON.parse(row.after_value) })); }
  close() { this.db?.close(); this.db = null; }
}

module.exports = { AccountingStore };
