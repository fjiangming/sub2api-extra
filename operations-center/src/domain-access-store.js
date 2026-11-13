'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

class DomainAccessStore {
  constructor(directory, { now = () => Date.now(), timezone = 'Asia/Shanghai' } = {}) {
    this.directory = directory; this.now = now; this.timezone = timezone;
  }

  initialize() {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.db = new Database(path.join(this.directory, 'domain-access.sqlite'));
    this.db.pragma('auto_vacuum = INCREMENTAL');
    this.db.pragma('journal_mode = WAL'); this.db.pragma('synchronous = FULL'); this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS da_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS da_files(id TEXT PRIMARY KEY,payload TEXT NOT NULL,seen_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS da_requests(
        id TEXT PRIMARY KEY,at INTEGER NOT NULL,day TEXT NOT NULL,domain TEXT NOT NULL,path TEXT NOT NULL,
        method TEXT NOT NULL,status INTEGER NOT NULL,trusted INTEGER NOT NULL,fingerprint TEXT NOT NULL,
        identity TEXT NOT NULL,reason TEXT NOT NULL,user_id INTEGER NOT NULL DEFAULT 0,key_id INTEGER NOT NULL DEFAULT 0,
        evidence TEXT NOT NULL DEFAULT '[]',attempts INTEGER NOT NULL DEFAULT 0,due_at INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS da_requests_range ON da_requests(domain,at DESC);
      CREATE INDEX IF NOT EXISTS da_requests_day ON da_requests(domain,day);
      CREATE INDEX IF NOT EXISTS da_requests_due ON da_requests(identity,due_at);
      CREATE TABLE IF NOT EXISTS da_daily(domain TEXT NOT NULL,day TEXT NOT NULL,user_id INTEGER NOT NULL,
        identity TEXT NOT NULL,count INTEGER NOT NULL,first_at INTEGER NOT NULL,last_at INTEGER NOT NULL,
        PRIMARY KEY(domain,day,user_id,identity));
      CREATE INDEX IF NOT EXISTS da_daily_user ON da_daily(user_id,domain,day);
      CREATE TABLE IF NOT EXISTS da_profiles(id INTEGER PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL,role TEXT NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS da_history(id TEXT PRIMARY KEY,domain TEXT NOT NULL,at INTEGER NOT NULL,
        day TEXT NOT NULL,evidence TEXT NOT NULL,path TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS da_history_range ON da_history(domain,day);
      CREATE TABLE IF NOT EXISTS da_notifications(domain TEXT NOT NULL,user_id INTEGER NOT NULL,state TEXT NOT NULL,
        note TEXT NOT NULL,actor TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(domain,user_id));
      CREATE TABLE IF NOT EXISTS da_audit(id INTEGER PRIMARY KEY,domain TEXT NOT NULL,user_id INTEGER NOT NULL,
        action TEXT NOT NULL,note TEXT NOT NULL,actor TEXT NOT NULL,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS da_drafts(id TEXT PRIMARY KEY,domain TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL);
    `);
    try { fs.chmodSync(path.join(this.directory, 'domain-access.sqlite'), 0o600); } catch { /* Windows ACLs inherit from the data directory. */ }
  }

  meta(key, value) {
    if (value === undefined) {
      const row = this.db.prepare('SELECT value FROM da_meta WHERE key=?').get(key);
      return row ? JSON.parse(row.value) : null;
    }
    this.db.prepare('INSERT INTO da_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
    return value;
  }

  file(id) { const row = this.db.prepare('SELECT payload FROM da_files WHERE id=?').get(id); return row ? JSON.parse(row.payload) : null; }
  files() { return this.db.prepare('SELECT payload FROM da_files ORDER BY seen_at DESC LIMIT 64').all().map(row => JSON.parse(row.payload)); }
  rebuild(groups) {
    for (const [host, day] of groups.values()) {
      this.db.prepare('DELETE FROM da_daily WHERE domain=? AND day=?').run(host, day);
      this.db.prepare(`INSERT INTO da_daily SELECT domain,day,user_id,identity,COUNT(*),MIN(at),MAX(at)
        FROM da_requests WHERE domain=? AND day=? GROUP BY domain,day,user_id,identity`).run(host, day);
    }
  }

  ingest(rows, checkpoint) {
    return this.db.transaction(() => {
      const groups = new Map(); let inserted = 0;
      const rawFloor = this.meta('rawFloor') || '';
      for (const row of rows) {
        if (row.kind === 'history') {
          inserted += this.db.prepare('INSERT OR IGNORE INTO da_history VALUES (@id,@domain,@at,@day,@evidence,@path)').run(row).changes;
          continue;
        }
        if (row.day < rawFloor) continue;
        const existing = this.db.prepare('SELECT * FROM da_requests WHERE id=?').get(row.id);
        if (!existing) {
          inserted += this.db.prepare(`INSERT INTO da_requests(id,at,day,domain,path,method,status,trusted,fingerprint,identity,reason)
            VALUES (@id,@at,@day,@domain,@path,@method,@status,@trusted,@fingerprint,@identity,@reason)`).run(row).changes;
        } else if (existing.fingerprint !== row.fingerprint) {
          this.db.prepare(`UPDATE da_requests SET identity='ambiguous',reason='gateway_id_collision',user_id=0,key_id=0 WHERE id=?`).run(row.id);
          groups.set(existing.domain + existing.day, [existing.domain, existing.day]);
          this.meta('collisionAt', this.now());
        } else continue;
        groups.set(row.domain + row.day, [row.domain, row.day]);
      }
      this.rebuild(groups);
      if (checkpoint) this.db.prepare('INSERT INTO da_files VALUES (@id,@payload,@seen) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,seen_at=excluded.seen_at')
        .run({ id: checkpoint.id, payload: JSON.stringify(checkpoint), seen: this.now() });
      if (inserted && !this.meta('startedAt')) this.meta('startedAt', this.now());
      return inserted;
    })();
  }

  due(limit = 80) {
    return this.db.prepare(`SELECT * FROM da_requests WHERE identity='pending' AND due_at<=?
      ORDER BY due_at,at LIMIT ?`).all(this.now(), limit);
  }

  resolve(results) {
    this.db.transaction(() => {
      const groups = new Map();
      for (const result of results) {
        const row = this.db.prepare('SELECT * FROM da_requests WHERE id=?').get(result.id);
        if (!row || row.identity !== 'pending') continue;
        const attempts = row.attempts + 1;
        this.db.prepare(`UPDATE da_requests SET identity=?,reason=?,user_id=?,key_id=?,evidence=?,attempts=?,due_at=? WHERE id=?`)
          .run(result.identity, result.reason, result.userId || 0, result.keyId || 0, JSON.stringify(result.evidence || []),
            attempts, this.now() + Math.min(86400000, 30000 * 2 ** Math.min(attempts, 12)), result.id);
        if (result.profile) this.db.prepare(`INSERT INTO da_profiles VALUES (@id,@name,@email,@role,@at)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name,email=excluded.email,role=excluded.role,updated_at=excluded.updated_at`)
          .run({ ...result.profile, at: this.now() });
        groups.set(row.domain + row.day, [row.domain, row.day]);
      }
      this.rebuild(groups);
    })();
  }

  draft(id, value) {
    if (!value) { const row = this.db.prepare('SELECT payload FROM da_drafts WHERE id=?').get(id); return row ? JSON.parse(row.payload) : null; }
    this.db.prepare('INSERT INTO da_drafts VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload')
      .run(id, value.domain, JSON.stringify(value), value.createdAt);
    return value;
  }
  drafts(host, limit = 200) { return this.db.prepare('SELECT payload FROM da_drafts WHERE domain=? ORDER BY created_at DESC LIMIT ?').all(host, limit).map(row => JSON.parse(row.payload)); }
  pendingDrafts() { return this.db.prepare('SELECT payload FROM da_drafts ORDER BY created_at LIMIT 1000').all().map(row => JSON.parse(row.payload)).filter(row => row.recipients.some(r => r.state === 'pending')); }

  notify(host, ids, state, note, actor) {
    this.db.transaction(() => {
      for (const id of ids) {
        this.db.prepare(`INSERT INTO da_notifications VALUES (?,?,?,?,?,?) ON CONFLICT(domain,user_id) DO UPDATE SET
          state=excluded.state,note=excluded.note,actor=excluded.actor,at=excluded.at`).run(host, id, state, note, actor, this.now());
        this.db.prepare('INSERT INTO da_audit(domain,user_id,action,note,actor,at) VALUES (?,?,?,?,?,?)').run(host, id, state, note, actor, this.now());
      }
    })();
  }

  prune({ rawDays, summaryDays }, today) {
    const { DateTime } = require('luxon');
    const cutoff = DateTime.fromISO(today, { zone: this.timezone }).minus({ days: rawDays - 1 }).toISODate();
    const summaryCutoff = DateTime.fromISO(today, { zone: this.timezone }).minus({ days: summaryDays - 1 }).toISODate();
    const rawFloor = [cutoff, this.meta('rawFloor') || ''].sort().at(-1);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM da_requests WHERE day<?').run(rawFloor);
      this.db.prepare('DELETE FROM da_daily WHERE day<?').run(summaryCutoff);
      this.db.prepare('DELETE FROM da_history WHERE day<?').run(summaryCutoff);
      this.db.prepare('DELETE FROM da_files WHERE seen_at<?').run(this.now() - 90 * 86400000);
      this.db.prepare('DELETE FROM da_audit WHERE at<?').run(this.now() - summaryDays * 86400000);
      this.meta('rawFloor', rawFloor);
    })();
    this.db.pragma('incremental_vacuum(100)');
    return { rawSince: rawFloor, summarySince: summaryCutoff };
  }
  close() { this.db?.close(); this.db = null; }
}

module.exports = { DomainAccessStore };
