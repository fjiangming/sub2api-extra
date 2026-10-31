'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

class DailyProfitStore {
  constructor(directory, { now = () => Date.now() } = {}) {
    this.directory = directory;
    this.now = now;
  }

  initialize() {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.db = new Database(path.join(this.directory, 'daily-profit.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS daily_profit_snapshots (
      scope TEXT NOT NULL, date TEXT NOT NULL, payload TEXT NOT NULL, computed_at TEXT NOT NULL,
      PRIMARY KEY(scope,date));
      CREATE TABLE IF NOT EXISTS daily_profit_jobs (
      scope TEXT NOT NULL, date TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1,
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
      lease_until INTEGER NOT NULL DEFAULT 0, lease_token TEXT, last_error TEXT,
      PRIMARY KEY(scope,date));
      CREATE INDEX IF NOT EXISTS daily_profit_due ON daily_profit_jobs(scope,next_attempt_at,lease_until);
      CREATE TABLE IF NOT EXISTS daily_profit_metadata (
      scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(scope,key));`);
  }

  list(scope, start, end) {
    return this.db.prepare('SELECT * FROM daily_profit_snapshots WHERE scope=? AND date>=? AND date<=?')
      .all(scope, start, end).map(row => ({ ...JSON.parse(row.payload), computedAt: row.computed_at }));
  }

  jobs(scope, start, end) {
    return this.db.prepare('SELECT date,attempts,last_error FROM daily_profit_jobs WHERE scope=? AND date>=? AND date<=?')
      .all(scope, start, end);
  }

  enqueue(scope, date, { force = false, dueAt = this.now() } = {}) {
    this.db.prepare(`INSERT INTO daily_profit_jobs(scope,date,next_attempt_at) VALUES (?,?,?)
      ON CONFLICT(scope,date) DO ${force ? `UPDATE SET generation=generation+1,attempts=0,
      next_attempt_at=excluded.next_attempt_at,lease_until=0,lease_token=NULL,last_error=NULL` : 'NOTHING'}`)
      .run(scope, date, dueAt);
  }

  enqueueDays(scope, days, { force = false } = {}) {
    this.db.transaction(() => {
      for (const { date, dueAt } of days) this.enqueue(scope, date, { force, dueAt });
    })();
  }

  claim(scope) {
    return this.db.transaction(() => {
      const job = this.db.prepare(`SELECT * FROM daily_profit_jobs WHERE scope=?
        AND next_attempt_at<=? AND lease_until<=? ORDER BY date DESC LIMIT 1`).get(scope, this.now(), this.now());
      if (!job) return null;
      const token = crypto.randomUUID();
      this.db.prepare('UPDATE daily_profit_jobs SET lease_until=?,lease_token=? WHERE scope=? AND date=?')
        .run(this.now() + 300000, token, scope, job.date);
      return { ...job, lease_token: token };
    })();
  }

  finish(job, payload, errorCode = null) {
    return this.db.transaction(() => {
      const current = this.db.prepare('SELECT * FROM daily_profit_jobs WHERE scope=? AND date=?').get(job.scope, job.date);
      if (!current || current.generation !== job.generation || current.lease_token !== job.lease_token) return false;
      if (payload) this.db.prepare(`INSERT INTO daily_profit_snapshots(scope,date,payload,computed_at) VALUES (?,?,?,?)
        ON CONFLICT(scope,date) DO UPDATE SET payload=excluded.payload,computed_at=excluded.computed_at`)
        .run(job.scope, job.date, JSON.stringify(payload), new Date(this.now()).toISOString());
      if (!errorCode) this.db.prepare('DELETE FROM daily_profit_jobs WHERE scope=? AND date=?').run(job.scope, job.date);
      else this.db.prepare(`UPDATE daily_profit_jobs SET attempts=attempts+1,next_attempt_at=?,lease_until=0,
        lease_token=NULL,last_error=? WHERE scope=? AND date=?`)
        .run(this.now() + Math.min(3600000, 60000 * 2 ** Math.min(job.attempts, 6)), errorCode, job.scope, job.date);
      return true;
    })();
  }

  metadata(scope, key, value) {
    if (value !== undefined) this.db.prepare(`INSERT INTO daily_profit_metadata(scope,key,value) VALUES (?,?,?)
      ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value`).run(scope, key, String(value));
    return this.db.prepare('SELECT value FROM daily_profit_metadata WHERE scope=? AND key=?').get(scope, key)?.value;
  }

  close() { this.db?.close(); this.db = null; }
}

module.exports = { DailyProfitStore };
