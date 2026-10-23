'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

// The core owns usage and money. This database only retains reconciliation work
// and evidence, including cases that cannot yet be priced or uniquely matched.
class BillingRecoveryStore {
  constructor(directory, { now = () => Date.now() } = {}) {
    this.directory = directory; this.now = now; this.db = null;
  }

  initialize() {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.db = new Database(path.join(this.directory, 'billing-recovery.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS cases (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, api_key_id INTEGER NOT NULL,
      account_id INTEGER NOT NULL, state TEXT NOT NULL, snapshot TEXT NOT NULL,
      lookup TEXT, lookup_status TEXT NOT NULL DEFAULT 'not_checked',
      attempts INTEGER NOT NULL DEFAULT 0, next_check_at INTEGER NOT NULL DEFAULT 0,
      last_error TEXT, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS billing_due ON cases(state,next_check_at);
      CREATE INDEX IF NOT EXISTS billing_user ON cases(user_id,updated_at);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }

  observe(entry) {
    const state = entry.state === 'settled' && entry.observed_usage?._recovery?.complete === false
      ? 'settled_incomplete' : entry.state;
    const previous = this.get(entry.id);
    const evidence = value => JSON.stringify([value.version, value.state, value.upstream_request_id,
      value.observed_usage, value.usage_record]);
    const reset = previous?.lookup_status === 'verified' && evidence(previous.snapshot) !== evidence(entry);
    this.db.prepare(`INSERT INTO cases(id,user_id,api_key_id,account_id,state,snapshot,updated_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,
      snapshot=excluded.snapshot,updated_at=excluded.updated_at,
      lookup_status=CASE WHEN ? THEN 'not_checked' ELSE cases.lookup_status END,
      next_check_at=CASE WHEN ? THEN 0 ELSE cases.next_check_at END`).run(entry.id, entry.user_id,
      entry.api_key_id, entry.account_id, state, JSON.stringify(entry), this.now(), reset ? 1 : 0, reset ? 1 : 0);
  }

  get(id) {
    const row = this.db.prepare('SELECT * FROM cases WHERE id=?').get(id);
    return row ? { ...row, snapshot: JSON.parse(row.snapshot), lookup: row.lookup ? JSON.parse(row.lookup) : null } : null;
  }

  due(limit = 20) {
    return this.db.prepare(`SELECT id FROM cases WHERE state IN ('unknown','review','settled_incomplete')
      AND lookup_status<>'verified' AND next_check_at<=? ORDER BY next_check_at,updated_at,id LIMIT ?`).all(this.now(), limit);
  }

  claim(id) {
    return this.db.prepare(`UPDATE cases SET next_check_at=? WHERE id=? AND next_check_at<=?`)
      .run(this.now() + 5 * 60000, id, this.now()).changes === 1;
  }

  checked(id, result, errorCode = null) {
    const previous = this.get(id);
    if (!previous) return;
    const attempts = previous.attempts + 1;
    const delay = Math.min(6 * 3600000, 60000 * 2 ** Math.min(attempts, 9));
    this.db.prepare(`UPDATE cases SET lookup=COALESCE(?,lookup),lookup_status=?,attempts=?,
      next_check_at=?,last_error=?,updated_at=? WHERE id=?`).run(result ? JSON.stringify(result) : null,
      errorCode || result?.status || 'unresolved', attempts, this.now() + delay, errorCode, this.now(), id);
  }

  cursor(value, state = 'unknown') {
    const key = `discovery_page:${state}`;
    if (value !== undefined) this.db.prepare(`INSERT INTO metadata(key,value) VALUES(?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, String(value));
    return Number(this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value || 1);
  }

  summary() {
    return this.db.prepare(`SELECT lookup_status AS status,count(*) AS count FROM cases
      WHERE state IN ('unknown','review','settled_incomplete') GROUP BY lookup_status`).all();
  }

  close() { this.db?.close(); this.db = null; }
}

module.exports = { BillingRecoveryStore };
