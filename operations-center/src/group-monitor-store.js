'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { AppError } = require('./errors');

const DEFAULT_POLICY = { revision: 0, automatic: false, intervalMinutes: 5, timeoutSeconds: 30, concurrency: 2, maxOutputTokens: 128 };

class GroupMonitorStore {
  constructor(directory, { key, now = () => Date.now() } = {}) { this.directory = directory; this.key = key; this.now = now; }

  initialize() {
    if (!Buffer.isBuffer(this.key) || this.key.length !== 32) throw new Error('group monitor encryption key unavailable');
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const filename = path.join(this.directory, 'group-monitor.sqlite');
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL'); this.db.pragma('synchronous = FULL'); this.db.pragma('busy_timeout = 1000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS gm_meta(scope TEXT NOT NULL,key TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(scope,key));
      CREATE TABLE IF NOT EXISTS gm_profiles(scope TEXT NOT NULL,group_id TEXT NOT NULL,model TEXT NOT NULL,protocol TEXT NOT NULL,
        secret TEXT,revision INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(scope,group_id));
      CREATE TABLE IF NOT EXISTS gm_runs(id TEXT PRIMARY KEY,scope TEXT NOT NULL,payload TEXT NOT NULL,started_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS gm_runs_scope ON gm_runs(scope,started_at DESC);
      CREATE TABLE IF NOT EXISTS gm_results(id INTEGER PRIMARY KEY,scope TEXT NOT NULL,group_id TEXT NOT NULL,run_id TEXT NOT NULL,
        payload TEXT NOT NULL,at INTEGER NOT NULL,UNIQUE(run_id,group_id));
      CREATE INDEX IF NOT EXISTS gm_results_group ON gm_results(scope,group_id,at DESC,id DESC);
      CREATE TABLE IF NOT EXISTS gm_findings(id TEXT PRIMARY KEY,scope TEXT NOT NULL,group_id TEXT NOT NULL,account_id TEXT NOT NULL,
        kind TEXT NOT NULL,state TEXT NOT NULL,payload TEXT NOT NULL,first_at INTEGER NOT NULL,last_at INTEGER NOT NULL,resolved_at INTEGER);
      CREATE INDEX IF NOT EXISTS gm_findings_scope ON gm_findings(scope,state,last_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS gm_findings_open ON gm_findings(scope,group_id,account_id,kind) WHERE state='open';`);
    for (const row of this.db.prepare('SELECT id,payload FROM gm_runs').iterate()) {
      const run = JSON.parse(row.payload);
      if (['running', 'preparing', 'stopping'].includes(run.state)) this.run({ ...run, state: 'interrupted', finishedAt: this.now() });
    }
    try { fs.chmodSync(filename, 0o600); } catch { /* Windows inherits the data directory ACL. */ }
    return this;
  }

  meta(scope, key, value) {
    if (value === undefined) { const row = this.db.prepare('SELECT payload FROM gm_meta WHERE scope=? AND key=?').get(scope, key); return row ? JSON.parse(row.payload) : null; }
    this.db.prepare('INSERT INTO gm_meta VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET payload=excluded.payload').run(scope, key, JSON.stringify(value));
    return value;
  }

  policy(scope) { return this.meta(scope, 'policy') || { ...DEFAULT_POLICY }; }
  savePolicy(scope, input) {
    return this.db.transaction(() => {
      const current = this.policy(scope);
      if (input.revision !== current.revision) throw new AppError('GROUP_MONITOR_CONFLICT', '巡检设置已更新，请刷新后重试', { status: 409 });
      return this.meta(scope, 'policy', { ...input, revision: current.revision + 1 });
    }).immediate();
  }

  profiles(scope) { return this.db.prepare('SELECT group_id,model,protocol,revision,secret IS NOT NULL AS key_configured FROM gm_profiles WHERE scope=?').all(scope); }
  profile(scope, id, decrypt = false) {
    const row = this.db.prepare('SELECT * FROM gm_profiles WHERE scope=? AND group_id=?').get(scope, id);
    if (!row) return { group_id: id, model: '', protocol: 'auto', revision: 0, keyConfigured: false, key: null };
    const key = decrypt && row.secret ? this.decrypt(scope, id, row.secret) : null;
    return { group_id: id, model: row.model, protocol: row.protocol, revision: row.revision, keyConfigured: Boolean(row.secret), key };
  }
  encrypt(scope, id, value) {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`group-monitor:${scope}:${id}`));
    const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), bytes].map(v => v.toString('base64url')).join('.');
  }
  decrypt(scope, id, value) {
    const [iv, tag, bytes] = value.split('.').map(v => Buffer.from(v, 'base64url'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAAD(Buffer.from(`group-monitor:${scope}:${id}`)); decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(bytes), decipher.final()]).toString('utf8');
  }
  saveProfile(scope, id, input) {
    return this.db.transaction(() => {
      const old = this.db.prepare('SELECT * FROM gm_profiles WHERE scope=? AND group_id=?').get(scope, id);
      if (input.revision !== (old?.revision || 0)) throw new AppError('GROUP_MONITOR_CONFLICT', '检测参数已更新，请刷新后重试', { status: 409 });
      const secret = input.clearKey ? null : input.apiKey ? this.encrypt(scope, id, input.apiKey) : old?.secret || null;
      this.db.prepare(`INSERT INTO gm_profiles VALUES(?,?,?,?,?,?,?) ON CONFLICT(scope,group_id) DO UPDATE SET
        model=excluded.model,protocol=excluded.protocol,secret=excluded.secret,revision=excluded.revision,updated_at=excluded.updated_at`)
        .run(scope, id, input.model, input.protocol, secret, input.revision + 1, this.now());
      return this.profile(scope, id);
    }).immediate();
  }

  inventory(scope) { return this.meta(scope, 'inventory'); }
  scan(scope, groups, findings) {
    return this.db.transaction(() => {
      const at = this.now(), active = new Set(findings.map(f => `${f.groupId}:${f.accountId}:${f.kind}`));
      for (const old of this.db.prepare("SELECT * FROM gm_findings WHERE scope=? AND state='open'").all(scope)) {
        if (!active.has(`${old.group_id}:${old.account_id}:${old.kind}`)) this.db.prepare("UPDATE gm_findings SET state='resolved',resolved_at=? WHERE id=?").run(at, old.id);
      }
      for (const finding of findings) {
        const old = this.db.prepare("SELECT id FROM gm_findings WHERE scope=? AND group_id=? AND account_id=? AND kind=? AND state='open'").get(scope, finding.groupId, finding.accountId, finding.kind);
        if (old) this.db.prepare('UPDATE gm_findings SET payload=?,last_at=? WHERE id=?').run(JSON.stringify(finding), at, old.id);
        else this.db.prepare("INSERT INTO gm_findings VALUES(?,?,?,?,?,'open',?,?,?,NULL)").run(crypto.randomUUID(), scope, finding.groupId, finding.accountId, finding.kind, JSON.stringify(finding), at, at);
      }
      this.meta(scope, 'inventory', { groups, at });
      this.meta(scope, 'sourceError', null);
    }).immediate();
  }
  findings(scope, state = 'open') {
    return this.db.prepare('SELECT * FROM gm_findings WHERE scope=? AND state=? ORDER BY last_at DESC,id LIMIT 50001').all(scope, state)
      .map(row => ({ ...JSON.parse(row.payload), id: row.id, firstAt: row.first_at, lastAt: row.last_at, resolvedAt: row.resolved_at, state: row.state }));
  }
  finding(scope, id) {
    const row = this.db.prepare('SELECT * FROM gm_findings WHERE scope=? AND id=?').get(scope, id);
    return row ? { ...JSON.parse(row.payload), id: row.id, firstAt: row.first_at, lastAt: row.last_at, resolvedAt: row.resolved_at, state: row.state } : null;
  }
  result(scope, groupId, runId, payload) {
    this.db.prepare('INSERT INTO gm_results(scope,group_id,run_id,payload,at) VALUES(?,?,?,?,?)').run(scope, groupId, runId, JSON.stringify(payload), this.now());
  }
  history(scope, groupId, limit = 10) {
    return this.db.prepare('SELECT payload,at FROM gm_results WHERE scope=? AND group_id=? ORDER BY at DESC,id DESC LIMIT ?').all(scope, groupId, limit).map(row => ({ ...JSON.parse(row.payload), at: row.at }));
  }
  latest(scope) {
    return new Map(this.db.prepare(`SELECT r.group_id,r.payload,r.at FROM gm_results r JOIN
      (SELECT group_id,MAX(id) AS id FROM gm_results WHERE scope=? GROUP BY group_id) latest ON r.id=latest.id`).all(scope)
      .map(row => [row.group_id, { ...JSON.parse(row.payload), at: row.at }]));
  }
  run(value) { this.db.prepare('INSERT INTO gm_runs VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(value.id, value.scope, JSON.stringify(value), value.startedAt); }
  lastRun(scope) { const row = this.db.prepare('SELECT payload FROM gm_runs WHERE scope=? ORDER BY started_at DESC,rowid DESC LIMIT 1').get(scope); return row ? JSON.parse(row.payload) : null; }
  prune() {
    const floor = this.now() - 30 * 86400000;
    this.db.prepare('DELETE FROM gm_results WHERE id IN (SELECT id FROM gm_results WHERE at<? ORDER BY id LIMIT 2000)').run(floor);
    this.db.prepare("DELETE FROM gm_findings WHERE id IN (SELECT id FROM gm_findings WHERE state='resolved' AND resolved_at<? LIMIT 2000)").run(floor);
    this.db.prepare('DELETE FROM gm_runs WHERE id IN (SELECT id FROM gm_runs WHERE started_at<? LIMIT 1000)').run(floor);
  }
  close() { this.db?.close(); }
}

module.exports = { GroupMonitorStore, DEFAULT_POLICY };
