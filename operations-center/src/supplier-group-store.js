'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

class SupplierGroupStore {
  constructor(directory) { this.directory = directory; }
  initialize() {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.db = new Database(path.join(this.directory, 'supplier-group-costs.sqlite'));
    this.db.pragma('journal_mode = WAL'); this.db.pragma('synchronous = FULL'); this.db.pragma('busy_timeout = 5000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS sg_days(scope TEXT NOT NULL,date TEXT NOT NULL,payload TEXT NOT NULL,
      finalized INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(scope,date));
      CREATE TABLE IF NOT EXISTS sg_observations(scope TEXT NOT NULL,date TEXT NOT NULL,account_id TEXT NOT NULL,
      payload TEXT NOT NULL,changed INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(scope,date,account_id));
      CREATE TABLE IF NOT EXISTS sg_settings(scope TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sg_margin_alerts(scope TEXT NOT NULL,date TEXT NOT NULL,group_id TEXT NOT NULL,
      threshold TEXT NOT NULL,channel_hash TEXT NOT NULL,sent_at TEXT NOT NULL,
      PRIMARY KEY(scope,date,group_id,threshold,channel_hash));
      CREATE TABLE IF NOT EXISTS sg_audit(id INTEGER PRIMARY KEY,scope TEXT NOT NULL,actor TEXT NOT NULL,
      before_json TEXT NOT NULL,after_json TEXT NOT NULL,created_at TEXT NOT NULL);`);
  }
  get(scope, date) {
    const row = this.db.prepare('SELECT * FROM sg_days WHERE scope=? AND date=?').get(scope, date);
    return row ? { ...JSON.parse(row.payload), finalized: row.finalized === 1 } : null;
  }
  save(scope, date, report, finalized) {
    this.db.prepare(`INSERT INTO sg_days VALUES(?,?,?,?) ON CONFLICT(scope,date)
      DO UPDATE SET payload=excluded.payload,finalized=MAX(sg_days.finalized,excluded.finalized)`)
      .run(scope, date, JSON.stringify(report), finalized ? 1 : 0);
    return report;
  }
  observe(scope, date, accounts, usage, from, to) {
    const firstByAccount = new Map();
    for (const row of usage) {
      const first = Date.parse(row.first_at), prior = firstByAccount.get(row.account_id);
      firstByAccount.set(row.account_id, prior === undefined ? first : Math.min(prior, first));
    }
    return this.db.transaction(() => accounts.map(account => {
      const stored = this.db.prepare('SELECT * FROM sg_observations WHERE scope=? AND date=? AND account_id=?').get(scope, date, account.id);
      const prior = stored && JSON.parse(stored.payload);
      const updated = Date.parse(account.updatedAt);
      // A later-day rotation must not rewrite a previously observed historical identity.
      const sameIdentity = prior && prior.identity === account.identity && prior.name === account.name;
      if (prior && updated >= Date.parse(to)) {
        // Older workers treated a routine late `updated_at` touch as an
        // identity change. Clear that legacy false positive once the current
        // identity and name still match; actual rotations remain blocked.
        if (sameIdentity && stored.changed) {
          const repaired = { ...prior, stable: true };
          this.db.prepare('UPDATE sg_observations SET payload=?,changed=0 WHERE scope=? AND date=? AND account_id=?')
            .run(JSON.stringify(repaired), scope, date, account.id);
          return repaired;
        }
        return { ...prior, stable: !stored.changed };
      }
      const first = firstByAccount.get(account.id);
      const legacyLateUpdate = Boolean(sameIdentity && stored?.changed && Number.isFinite(updated) && updated >= Date.parse(to));
      const unchanged = Boolean(sameIdentity && (!stored.changed || legacyLateUpdate));
      // accounts.updated_at is touched by ordinary reads on the main site. For a
      // first observation, a valid identity and name are the useful evidence;
      // updated_at alone must not turn an otherwise matchable day into an
      // all-day ownership warning. Subsequent observations still block actual
      // identity/name changes through `unchanged` and `changed`.
      const firstIdentityKnown = !prior && Boolean(account.identity) && Boolean(account.name);
      const stable = unchanged || firstIdentityKnown || (Number.isFinite(updated) && updated < Date.parse(to) && (first === undefined || updated <= first));
      const changed = Boolean((stored?.changed && !legacyLateUpdate) || (prior && !sameIdentity) || !stable);
      this.db.prepare(`INSERT INTO sg_observations VALUES(?,?,?,?,?) ON CONFLICT(scope,date,account_id)
        DO UPDATE SET payload=excluded.payload,changed=excluded.changed`)
        .run(scope, date, account.id, JSON.stringify(account), changed ? 1 : 0);
      return { ...account, stable: !changed };
    }))();
  }
  settings(scope) {
    const row = this.db.prepare('SELECT payload FROM sg_settings WHERE scope=?').get(scope);
    const value = row ? JSON.parse(row.payload) : {};
    return {
      aliases: value.aliases && typeof value.aliases === 'object' ? value.aliases : {},
      alert: { enabled: true, amount: 10, percent: 5, ...(value.alert || {}) },
      marginAlert: { enabled: true, threshold: 10, channelIds: [], ...(value.marginAlert || {}) }
    };
  }
  configure(scope, settings, actor, at) {
    this.db.transaction(() => {
      const before = this.settings(scope);
      this.db.prepare('INSERT INTO sg_audit(scope,actor,before_json,after_json,created_at) VALUES(?,?,?,?,?)')
        .run(scope, JSON.stringify(actor || null), JSON.stringify(before), JSON.stringify(settings), at);
      this.db.prepare('INSERT INTO sg_settings VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET payload=excluded.payload')
        .run(scope, JSON.stringify(settings));
    })();
    return settings;
  }
  claimMarginAlert(scope, date, groupId, threshold, channelHash, at) {
    const result = this.db.prepare(`INSERT INTO sg_margin_alerts(scope,date,group_id,threshold,channel_hash,sent_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(scope,date,group_id,threshold,channel_hash) DO NOTHING`)
      .run(scope, date, groupId, String(threshold), channelHash, at);
    return result.changes === 1;
  }
  releaseMarginAlert(scope, date, groupId, threshold, channelHash) {
    this.db.prepare('DELETE FROM sg_margin_alerts WHERE scope=? AND date=? AND group_id=? AND threshold=? AND channel_hash=?')
      .run(scope, date, groupId, String(threshold), channelHash);
  }
  close() { this.db?.close(); this.db = null; }
}
module.exports = { SupplierGroupStore };
