'use strict';

const crypto = require('node:crypto');
const { setImmediate: yieldToRequests } = require('node:timers/promises');
const { nextScheduledRunAt } = require('./schedule');
const { defaultModelPlatform, defaultSchedule, modelGroupContext } = require('./model-config');
const { modelConclusion, modelRunSummary } = require('./model-results');

const summaryColumns = 'id, group_id, channel, status, model, conclusion, total, item_count, started_at, created_at, finished_at, duration_ms, trigger_type, progress, reason, (response_json IS NOT NULL) AS has_response';
const parse = (value, fallback = null) => { try { return JSON.parse(value); } catch { return fallback; } };

class ModelStore {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.maintenanceCursor = ['', ''];
    this.maintenancePending = false;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS model_settings (id INTEGER PRIMARY KEY CHECK(id=1), schedule_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_platforms (platform TEXT PRIMARY KEY, config_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_groups (
        group_id TEXT PRIMARY KEY, group_name TEXT NOT NULL, platform TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0, key_cipher TEXT, key_fingerprint TEXT,
        models_json TEXT NOT NULL DEFAULT '{}', revision TEXT NOT NULL, next_run_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS model_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, group_id TEXT NOT NULL, channel TEXT NOT NULL,
        model TEXT NOT NULL, trigger_type TEXT NOT NULL, status TEXT NOT NULL,
        snapshot_json TEXT NOT NULL, revision TEXT NOT NULL, remote_id TEXT,
        conclusion TEXT, total REAL, item_count INTEGER NOT NULL DEFAULT 0,
        response_json TEXT, reason TEXT, error_code TEXT, progress REAL,
        created_at INTEGER NOT NULL, started_at INTEGER, submitted_at INTEGER, finished_at INTEGER, duration_ms INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS model_runs_active_idx ON model_runs(group_id,channel) WHERE status IN ('queued','running');
      CREATE INDEX IF NOT EXISTS model_runs_history_idx ON model_runs(group_id,channel,id DESC);
      CREATE INDEX IF NOT EXISTS model_runs_submit_idx ON model_runs(channel,submitted_at);
      CREATE INDEX IF NOT EXISTS model_runs_queue_idx ON model_runs(status,id);
      CREATE INDEX IF NOT EXISTS model_groups_due_idx ON model_groups(enabled,next_run_at);
      CREATE TABLE IF NOT EXISTS model_archives (group_id TEXT NOT NULL, channel TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(group_id,channel));
      CREATE TABLE IF NOT EXISTS model_throttles (channel TEXT PRIMARY KEY, until_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS model_submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, submitted_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS model_submissions_time_idx ON model_submissions(channel,submitted_at);
    `);
    this.db.prepare('INSERT OR IGNORE INTO model_settings VALUES (1,?)').run(JSON.stringify(defaultSchedule));
    // Without a remote task ID the outcome of an interrupted submission is unknown: never replay POST.
    this.db.prepare(`UPDATE model_runs SET status='error', conclusion='error', reason='服务重启中断了提交；未自动重发，请核对检测网站任务后再手动检测', error_code='SERVICE_RESTARTED', finished_at=? WHERE (status='running' OR (status='queued' AND submitted_at IS NOT NULL)) AND remote_id IS NULL`).run(Date.now());
  }

  schedule() { return parse(this.db.prepare('SELECT schedule_json FROM model_settings WHERE id=1').get().schedule_json, defaultSchedule); }
  platform(id) { return parse(this.db.prepare('SELECT config_json FROM model_platforms WHERE platform=?').get(id)?.config_json, defaultModelPlatform(id)); }
  group(id) { return this.db.prepare('SELECT * FROM model_groups WHERE group_id=?').get(String(id)); }
  groups() { return this.db.prepare('SELECT * FROM model_groups ORDER BY group_id').all(); }
  enabledGroups() { return this.groups().filter(group => group.enabled && this.platform(group.platform).enabled); }
  visibleGroups(groups) {
    const enabled = new Map(this.enabledGroups().map(group => [group.group_id, group.platform]));
    return groups.filter(group => enabled.get(String(group.id)) === group.platform);
  }
  nextAt(from = Date.now()) {
    const schedule = this.schedule();
    return schedule.enabled ? nextScheduledRunAt({ mode: schedule.mode, times: schedule.times, intervalMinutes: schedule.interval_minutes }, from, this.store.config.scheduleTimezone) : null;
  }

  save(input) {
    const oldSchedule = JSON.stringify(this.schedule());
    const schedule = input.schedule || this.schedule();
    const scheduleChanged = JSON.stringify(schedule) !== oldSchedule;
    this.db.prepare('UPDATE model_settings SET schedule_json=? WHERE id=1').run(JSON.stringify(schedule));
    for (const platform of input.platforms) {
      const previous = this.platform(platform.id);
      const config = platform.config || previous;
      this.db.prepare('INSERT INTO model_platforms VALUES (?,?) ON CONFLICT(platform) DO UPDATE SET config_json=excluded.config_json').run(platform.id, JSON.stringify(config));
      for (const group of platform.groups) {
        const old = this.group(group.id);
        const revision = crypto.createHash('sha256').update(JSON.stringify([config, group.models || {}, group.keyFingerprint])).digest('hex');
        const changed = scheduleChanged || revision !== old?.revision || Number(group.enabled) !== old?.enabled;
        const next = group.enabled && config.enabled ? changed ? this.nextAt() : old?.next_run_at ?? this.nextAt() : null;
        this.db.prepare(`INSERT INTO model_groups VALUES (?,?,?,?,?,?,?,?,?)
          ON CONFLICT(group_id) DO UPDATE SET group_name=excluded.group_name, platform=excluded.platform,
          enabled=excluded.enabled, key_cipher=excluded.key_cipher, key_fingerprint=excluded.key_fingerprint,
          models_json=excluded.models_json, revision=excluded.revision, next_run_at=excluded.next_run_at`)
          .run(group.id, group.name, platform.id, group.enabled ? 1 : 0, group.keyCipher || null, group.keyFingerprint || null, JSON.stringify(group.models || {}), revision, next);
      }
    }
  }

  effective(group, channel) {
    const platform = this.platform(group.platform);
    const config = platform.channels[channel];
    return { ...config, model: parse(group.models_json, {})[channel] || config.model, target_url: platform.target_url, timeout_seconds: platform.timeout_seconds, platform: group.platform };
  }

  active(groupId, channel) { return this.db.prepare("SELECT * FROM model_runs WHERE group_id=? AND channel=? AND status IN ('queued','running')").get(String(groupId), channel); }
  create(group, channel, triggerType) {
    const existing = this.active(group.group_id, channel);
    if (existing) return existing;
    const config = this.effective(group, channel);
    const snapshot = { ...config, target_key_cipher: group.key_cipher, target_key_context: modelGroupContext(group.group_id) };
    const result = this.db.prepare(`INSERT INTO model_runs (group_id,channel,model,trigger_type,status,snapshot_json,revision,created_at,conclusion)
      VALUES (?,?,?,?,'queued',?,?,?,'queued')`).run(group.group_id, channel, config.model, triggerType, JSON.stringify(snapshot), group.revision, Date.now());
    return this.run(result.lastInsertRowid);
  }
  run(id) { return this.db.prepare('SELECT * FROM model_runs WHERE id=?').get(id); }
  queued(limit = 100) { return this.db.prepare("SELECT * FROM model_runs WHERE status IN ('queued','running') ORDER BY id LIMIT ?").all(limit); }
  nextRunnable(allowed) {
    return this.db.prepare(`SELECT * FROM model_runs WHERE status IN ('queued','running')
      AND (remote_id IS NOT NULL ${allowed.length ? `OR channel IN (${allowed.map(() => '?').join(',')})` : ''}) ORDER BY (remote_id IS NOT NULL) DESC,id LIMIT 1`).get(...allowed);
  }
  cancelObsolete() {
    this.db.prepare(`UPDATE model_runs SET status='error', conclusion='error', reason='配置已停用或变更，本地任务已停止', error_code='MODEL_CONFIG_CHANGED', finished_at=?
      WHERE status IN ('queued','running') AND NOT EXISTS (SELECT 1 FROM model_groups g WHERE g.group_id=model_runs.group_id AND g.enabled=1 AND g.revision=model_runs.revision)`).run(Date.now());
  }
  due(limit = 20) { return this.db.prepare('SELECT * FROM model_groups WHERE enabled=1 AND next_run_at<=? ORDER BY next_run_at LIMIT ?').all(Date.now(), limit); }
  advance(groupId, from = Date.now()) { this.db.prepare('UPDATE model_groups SET next_run_at=? WHERE group_id=?').run(this.nextAt(from), String(groupId)); }
  markRunning(id) { this.db.prepare("UPDATE model_runs SET status='running', conclusion='running', started_at=COALESCE(started_at,?) WHERE id=? AND status='queued'").run(Date.now(), id); }
  markSubmitted(id) {
    this.db.transaction(() => {
      const row = this.run(id);
      this.db.prepare('UPDATE model_runs SET submitted_at=? WHERE id=?').run(Date.now(), id);
      this.db.prepare('INSERT INTO model_submissions(channel,submitted_at) VALUES (?,?)').run(row.channel, Date.now());
      this.db.prepare('DELETE FROM model_submissions WHERE submitted_at<?').run(Date.now() - 3600000);
    })();
  }
  rememberRemote(id, remoteId) { this.db.prepare('UPDATE model_runs SET remote_id=? WHERE id=?').run(remoteId, id); }
  throttled(channel, now = Date.now()) {
    const until = this.db.prepare('SELECT until_at FROM model_throttles WHERE channel=?').get(channel)?.until_at || 0;
    const recent = channel === 'bazaarlink' ? this.db.prepare('SELECT COUNT(*) AS n, MIN(submitted_at) AS first FROM model_submissions WHERE channel=? AND submitted_at>?').get(channel, now - 3600000) : null;
    return Math.max(until, recent?.n >= 30 ? recent.first + 3600001 : 0) > now;
  }
  throttle(channel, seconds) { this.db.prepare('INSERT INTO model_throttles VALUES (?,?) ON CONFLICT(channel) DO UPDATE SET until_at=MAX(until_at,excluded.until_at)').run(channel, Date.now() + seconds * 1000); }

  updateResponse(id, response, status = 'running') {
    const row = this.run(id);
    const itemCount = row.channel === 'bazaarlink' ? (Array.isArray(response.items) ? response.items.length : 0) : Object.keys(response.scores || {}).length;
    this.db.prepare('UPDATE model_runs SET response_json=?, conclusion=?, total=?, item_count=?, progress=? WHERE id=?')
      .run(JSON.stringify(response), modelConclusion(row.channel, response, status), typeof response.total === 'number' && Number.isFinite(response.total) ? response.total : null, itemCount || 0, typeof response.progress === 'number' ? Math.min(1, Math.max(0, response.progress)) : null, id);
  }
  finish(id, status, reason = '', code = '') {
    const row = this.run(id);
    this.db.prepare('UPDATE model_runs SET status=?, conclusion=?, reason=?, error_code=?, finished_at=?, duration_ms=? WHERE id=?')
      .run(status, modelConclusion(row.channel, parse(row.response_json), status), reason, code || null, Date.now(), Date.now() - (row.started_at || row.created_at), id);
  }
  history(groupId, channel, before = Number.MAX_SAFE_INTEGER, limit = 51) {
    return this.db.prepare(`SELECT ${summaryColumns} FROM model_runs WHERE group_id=? AND channel=? AND id<? ORDER BY id DESC LIMIT ?`)
      .all(String(groupId), channel, before, limit).map(modelRunSummary);
  }
  latest(groupId, channel) { return this.history(groupId, channel, Number.MAX_SAFE_INTEGER, 1)[0] || null; }
  counts(groupId, channel) { return { total: this.db.prepare('SELECT COUNT(*) AS n FROM model_runs WHERE group_id=? AND channel=?').get(String(groupId), channel).n, archived: this.db.prepare('SELECT count FROM model_archives WHERE group_id=? AND channel=?').get(String(groupId), channel)?.count || 0 }; }
  deleteHistory(groupId, channel, ids) {
    return this.db.transaction(() => {
      if (!ids) {
        const result = this.db.prepare("DELETE FROM model_runs WHERE group_id=? AND channel=? AND status NOT IN ('queued','running')").run(String(groupId), channel);
        this.db.prepare('DELETE FROM model_archives WHERE group_id=? AND channel=?').run(String(groupId), channel);
        return result.changes;
      }
      const rows = ids.map(id => this.run(id));
      if (rows.some(row => !row || row.group_id !== String(groupId) || row.channel !== channel || ['queued', 'running'].includes(row.status))) return null;
      const remove = this.db.prepare("DELETE FROM model_runs WHERE id=? AND group_id=? AND channel=? AND status NOT IN ('queued','running')");
      return rows.reduce((count, row) => count + remove.run(row.id, String(groupId), channel).changes, 0);
    })();
  }

  async maintain(policy, timestamp = Date.now()) {
    const pairs = this.db.prepare(`SELECT group_id,channel FROM model_runs WHERE (group_id,channel)>(?,?) GROUP BY group_id,channel ORDER BY group_id,channel LIMIT 21`).all(...this.maintenanceCursor);
    let removed = 0;
    let pending = this.maintenancePending;
    for (const pair of pairs.slice(0, 20)) {
      const args = [pair.group_id, pair.channel];
      const boundary = this.db.prepare('SELECT id FROM model_runs WHERE group_id=? AND channel=? ORDER BY id DESC LIMIT 1 OFFSET ?').get(...args, policy.history_per_group - 1)?.id || 0;
      const keepId = this.db.prepare('SELECT id FROM model_runs WHERE group_id=? AND channel=? ORDER BY id DESC LIMIT 1 OFFSET 59').get(...args)?.id || 0;
      const candidates = policy.enabled ? this.db.prepare("SELECT id FROM model_runs WHERE group_id=? AND channel=? AND id<? AND status NOT IN ('queued','running') AND (id<? OR created_at<?) ORDER BY id LIMIT 201")
        .all(...args, keepId, boundary, timestamp - policy.history_days * 86400000) : [];
      const ids = candidates.slice(0, 200);
      pending ||= candidates.length > 200;
      this.db.transaction(() => {
        if (ids.length) {
          this.db.prepare('INSERT INTO model_archives VALUES (?,?,?) ON CONFLICT(group_id,channel) DO UPDATE SET count=count+excluded.count').run(...args, ids.length);
          const remove = this.db.prepare('DELETE FROM model_runs WHERE id=?');
          for (const row of ids) remove.run(row.id);
          removed += ids.length;
        }
        const payloadBoundary = this.db.prepare('SELECT id FROM model_runs WHERE group_id=? AND channel=? ORDER BY id DESC LIMIT 1 OFFSET ?').get(...args, policy.artifact_per_group - 1)?.id || 0;
        const payloads = this.db.prepare("SELECT id FROM model_runs WHERE group_id=? AND channel=? AND id<? AND status NOT IN ('queued','running') AND (response_json IS NOT NULL OR snapshot_json<>'{}' OR remote_id IS NOT NULL) ORDER BY id LIMIT 201").all(...args, payloadBoundary);
        const prune = this.db.prepare("UPDATE model_runs SET response_json=NULL, snapshot_json='{}', remote_id=NULL WHERE id=?");
        for (const row of payloads.slice(0, 200)) prune.run(row.id);
        pending ||= payloads.length > 200;
      })();
      await yieldToRequests();
    }
    if (pairs.length > 20) {
      const last = pairs[19];
      this.maintenanceCursor = [last.group_id, last.channel];
      this.maintenancePending = pending;
      pending = true;
    } else {
      this.maintenanceCursor = ['', ''];
      this.maintenancePending = false;
    }
    this.db.prepare('DELETE FROM model_submissions WHERE submitted_at<?').run(timestamp - 3600000);
    this.db.prepare('DELETE FROM model_throttles WHERE until_at<=?').run(timestamp);
    return { archived: removed, pending };
  }
}

module.exports = { ModelStore };
