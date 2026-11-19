'use strict';

const { setImmediate: yieldToRequests } = require('node:timers/promises');
const { nextScheduledRunAt } = require('./schedule');
const { defaultConfiguration, channels, providerFor, digest, keyContext, providerParams, providerPlatform, testParams } = require('./provider-config');
const { compactResult, conclusion, runSummary } = require('./provider-results');

class ProviderStore {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.maintenanceCursor = ['', ''];
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS degradation_provider_settings (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, config_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS degradation_provider_groups (
        group_id TEXT NOT NULL, channel TEXT NOT NULL, platform TEXT NOT NULL, group_name TEXT NOT NULL,
        enabled INTEGER NOT NULL, override_json TEXT, key_cipher TEXT, key_fingerprint TEXT, key_destination TEXT,
        next_run_at INTEGER, PRIMARY KEY(group_id,channel)
      );
      CREATE TABLE IF NOT EXISTS degradation_provider_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, group_id TEXT NOT NULL, platform TEXT NOT NULL, channel TEXT NOT NULL,
        model TEXT NOT NULL, trigger_type TEXT NOT NULL, status TEXT NOT NULL, conclusion TEXT NOT NULL,
        revision TEXT NOT NULL, snapshot_json TEXT NOT NULL, parts_json TEXT NOT NULL DEFAULT '{}',
        summary_json TEXT NOT NULL DEFAULT '{}', response_json TEXT, reason TEXT, error_code TEXT,
        created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, duration_ms INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS degradation_provider_active ON degradation_provider_runs(group_id,channel) WHERE status IN ('queued','running');
      CREATE INDEX IF NOT EXISTS degradation_provider_history ON degradation_provider_runs(group_id,channel,id DESC);
      CREATE INDEX IF NOT EXISTS degradation_provider_queue ON degradation_provider_runs(status,id);
      CREATE INDEX IF NOT EXISTS degradation_provider_due ON degradation_provider_groups(enabled,next_run_at);
      CREATE TABLE IF NOT EXISTS degradation_provider_archives (group_id TEXT NOT NULL, channel TEXT NOT NULL, platform TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(group_id,channel,platform));
      CREATE TABLE IF NOT EXISTS degradation_provider_throttles (provider TEXT PRIMARY KEY, until_at INTEGER NOT NULL);
    `);
    if (!this.db.prepare('PRAGMA table_info(degradation_provider_groups)').all().some(column => column.name === 'schedule_json')) {
      this.db.exec('ALTER TABLE degradation_provider_groups ADD COLUMN schedule_json TEXT');
    }
    if (!this.db.prepare('PRAGMA table_info(degradation_provider_groups)').all().some(column => column.name === 'group_enabled')) {
      this.db.exec('ALTER TABLE degradation_provider_groups ADD COLUMN group_enabled INTEGER NOT NULL DEFAULT 1');
    }
    this.db.prepare('INSERT OR IGNORE INTO degradation_provider_settings VALUES (1,0,?)').run(JSON.stringify(defaultConfiguration()));
    // A crash between sending a POST and saving its ID must never replay that POST.
    this.db.prepare(`UPDATE degradation_provider_runs SET status='error', conclusion='error', error_code='SERVICE_RESTARTED',
      reason='服务重启中断了提交，结果未知；未自动重发，请核对第三方任务后再检测', finished_at=?,duration_ms=MAX(0,?-COALESCE(started_at,created_at))
      WHERE status='running' AND EXISTS (SELECT 1 FROM json_each(parts_json) WHERE json_extract(value,'$.state')='submitting')`).run(Date.now(), Date.now());
  }

  configuration() {
    const row = this.db.prepare('SELECT * FROM degradation_provider_settings WHERE id=1').get();
    return { revision: row.revision, platforms: [], provider_platforms: [], ...JSON.parse(row.config_json) };
  }
  group(id, channel) { return this.db.prepare('SELECT * FROM degradation_provider_groups WHERE group_id=? AND channel=?').get(String(id), channel); }
  groups() { return this.db.prepare('SELECT * FROM degradation_provider_groups ORDER BY group_id,channel').all(); }
  inheritedModel(group) {
    const monitor = this.store.getMonitor(this.store.config.serviceOwnerId, group.group_id);
    const legacy = monitor?.platform === group.platform ? this.store.getMonitorTest(monitor) : this.store.getPlatformTest(group.platform, false);
    return legacy?.model || null;
  }
  effective(group, configuration = this.configuration()) {
    const channel = configuration.channels[group.channel];
    const platform = configuration.platforms?.find(item => item.id === group.platform);
    const providerId = providerFor(group.channel);
    const scope = providerPlatform(configuration, providerId, group.platform);
    const override = group.override_json ? JSON.parse(group.override_json) : {};
    const params = scope ? { ...testParams(scope, group.channel), ...override } : { ...channel.defaults, ...override, ...platform?.params };
    if (group.channel === 'testllm' && params.model_source === 'group') {
      params.model = this.inheritedModel(group) || params.model;
    }
    if (params.protocol === 'auto') params.protocol = group.platform === 'anthropic' ? 'claude' : group.platform === 'openai' ? 'gpt' : 'unsupported';
    const provider = configuration.providers[providerId];
    return { ...(scope ? providerParams(providerId, params) : params), api_url: provider.api_url.replace(/\/$/, ''), timeout_seconds: scope ? params.timeout_seconds : channel.timeout_seconds,
      enabled: Boolean(group.enabled && group.group_enabled !== 0 && provider.enabled && (scope ? scope.enabled && (scope.tests?.[group.channel] ?? true) : channel.enabled)) };
  }
  schedule(group, configuration = this.configuration()) {
    return group.schedule_json ? JSON.parse(group.schedule_json)
      : providerPlatform(configuration, providerFor(group.channel), group.platform)?.schedule || configuration.channels[group.channel].schedule;
  }
  concurrencyScope(run, configuration = this.configuration()) {
    const provider = providerFor(run.channel);
    const scope = providerPlatform(configuration, provider, run.platform);
    return scope ? { id: `${provider}:${run.platform}`, limit: scope.concurrency }
      : { id: run.channel, limit: configuration.channels[run.channel].concurrency };
  }
  hierarchyPlatforms(discovered, configuration = this.configuration()) {
    const result = structuredClone(configuration.provider_platforms || []);
    const available = new Map(discovered.map(group => [String(group.id), group.platform]));
    const saved = this.groups();
    for (const id of new Set(discovered.map(group => group.platform))) for (const provider of ['manxue', 'testllm']) {
      if (provider === 'testllm' && !['openai', 'anthropic'].includes(id) || providerPlatform(configuration, provider, id)) continue;
      const kinds = channels.filter(channel => providerFor(channel) === provider);
      const active = saved.filter(group => group.platform === id && available.get(group.group_id) === id && kinds.includes(group.channel)
        && group.enabled && group.group_enabled && configuration.channels[group.channel].enabled);
      const channel = active[0]?.channel || kinds.find(channel => configuration.channels[channel].enabled) || kinds[0];
      const sample = discovered.find(group => group.platform === id);
      let params = providerParams(provider, this.effective({ group_id: String(sample.id), platform: id, channel, enabled: 0 }, configuration));
      if ((!params.target_url || !params.model) && active.length) params = providerParams(provider, this.effective(active[0], configuration));
      result.push({ provider, id, enabled: Boolean(kinds.some(channel => configuration.channels[channel].enabled) && params.target_url && params.model), params,
        ...(provider === 'manxue' ? { tests: Object.fromEntries(kinds.map(kind => [kind, configuration.channels[kind].enabled])),
          test_params: Object.fromEntries(kinds.map(kind => {
            const inherited = this.effective({ group_id: String(sample.id), platform: id, channel: kind, enabled: 0 }, configuration);
            return [kind, { model: inherited.model || params.model, reasoning_effort: inherited.reasoning_effort }];
          })) } : {}),
        concurrency: Math.min(...kinds.map(kind => configuration.channels[kind].concurrency)),
        schedule: structuredClone(configuration.channels[channel].schedule) });
    }
    for (const scope of result) if (scope.provider === 'manxue' && !scope.test_params) {
      scope.test_params = Object.fromEntries(['candy', 'pelican'].map(channel => [channel, {
        model: scope.params.model, reasoning_effort: scope.params.reasoning_effort
      }]));
    }
    return result;
  }
  revision(group) { return digest([this.effective(group), group.platform, group.key_fingerprint]); }
  enabled(group) { return this.effective(group).enabled && Boolean(group.key_cipher); }
  visible(groups, channel) {
    return groups.filter(item => {
      const group = this.group(item.id, channel);
      return group?.platform === item.platform && this.enabled(group);
    });
  }
  nextAt(group, from = Date.now(), configuration = this.configuration()) {
    const schedule = this.schedule(group, configuration);
    return schedule.enabled ? nextScheduledRunAt({ mode: schedule.mode, times: schedule.times, intervalMinutes: schedule.interval_minutes }, from, this.store.config.scheduleTimezone) : null;
  }
  save(input, groups) {
    return this.db.transaction(() => {
      const old = this.configuration();
      if (old.revision !== input.revision) return false;
      const oldSchedules = new Map(this.groups().map(group => [`${group.channel}:${group.group_id}`, JSON.stringify(this.schedule(group, old))]));
      const config = { providers: input.providers, channels: input.channels, platforms: input.platforms ?? old.platforms,
        provider_platforms: input.provider_platforms ?? old.provider_platforms };
      this.db.prepare('UPDATE degradation_provider_settings SET revision=revision+1,config_json=? WHERE id=1').run(JSON.stringify(config));
      const upsert = this.db.prepare(`INSERT INTO degradation_provider_groups (group_id,channel,platform,group_name,enabled,override_json,key_cipher,key_fingerprint,schedule_json,group_enabled)
        VALUES (@group_id,@channel,@platform,@group_name,@enabled,@override_json,@key_cipher,@key_fingerprint,@schedule_json,@group_enabled)
        ON CONFLICT(group_id,channel) DO UPDATE SET platform=excluded.platform,group_name=excluded.group_name,enabled=excluded.enabled,
        override_json=excluded.override_json,key_cipher=excluded.key_cipher,key_fingerprint=excluded.key_fingerprint,schedule_json=excluded.schedule_json,group_enabled=excluded.group_enabled`);
      for (const group of groups) upsert.run(group);
      for (const group of this.groups()) {
        const changed = oldSchedules.get(`${group.channel}:${group.group_id}`) !== JSON.stringify(this.schedule(group, config));
        const next = this.enabled(group) ? !group.next_run_at || changed ? this.nextAt(group) : group.next_run_at : null;
        this.db.prepare('UPDATE degradation_provider_groups SET next_run_at=? WHERE group_id=? AND channel=?').run(next, group.group_id, group.channel);
      }
      return true;
    })();
  }
  create(group, trigger = 'manual') {
    const active = this.db.prepare("SELECT * FROM degradation_provider_runs WHERE group_id=? AND channel=? AND status IN ('queued','running')").get(group.group_id, group.channel);
    if (active) return active;
    const snapshot = { ...this.effective(group), key_cipher: group.key_cipher, key_context: keyContext(group.channel, group.group_id) };
    const result = this.db.prepare(`INSERT INTO degradation_provider_runs (group_id,platform,channel,model,trigger_type,status,conclusion,revision,snapshot_json,created_at)
      VALUES (?,?,?,?,?,'queued','queued',?,?,?)`).run(group.group_id, group.platform, group.channel, snapshot.model, trigger, this.revision(group), JSON.stringify(snapshot), Date.now());
    return this.run(result.lastInsertRowid);
  }
  run(id) { return this.db.prepare('SELECT * FROM degradation_provider_runs WHERE id=?').get(id); }
  queued(limit = 100) { return this.db.prepare("SELECT * FROM degradation_provider_runs WHERE status IN ('queued','running') ORDER BY id LIMIT ?").all(limit); }
  due() { return this.db.prepare('SELECT * FROM degradation_provider_groups WHERE enabled=1 AND next_run_at<=? ORDER BY next_run_at LIMIT 100').all(Date.now()); }
  advance(group) { this.db.prepare('UPDATE degradation_provider_groups SET next_run_at=? WHERE group_id=? AND channel=?').run(this.nextAt(group), group.group_id, group.channel); }
  current(run) {
    const group = this.group(run.group_id, run.channel);
    return Boolean(group && this.enabled(group) && group.platform === run.platform && this.revision(group) === run.revision);
  }
  markRunning(id) { this.db.prepare("UPDATE degradation_provider_runs SET status='running',conclusion='running',started_at=COALESCE(started_at,?) WHERE id=? AND status='queued'").run(Date.now(), id); }
  part(id, mode, value) {
    const row = this.run(id);
    const parts = JSON.parse(row.parts_json);
    parts[mode] = value;
    this.db.prepare('UPDATE degradation_provider_runs SET parts_json=? WHERE id=?').run(JSON.stringify(parts), id);
  }
  response(id, value) {
    const run = this.run(id);
    this.db.prepare('UPDATE degradation_provider_runs SET response_json=?,summary_json=? WHERE id=?').run(JSON.stringify(value), JSON.stringify(compactResult(run.channel, value)), id);
  }
  finish(id, status, reason = '', code = '') {
    const run = this.run(id);
    if (!['queued', 'running'].includes(run.status)) return;
    this.db.prepare('UPDATE degradation_provider_runs SET status=?,conclusion=?,reason=?,error_code=?,finished_at=?,duration_ms=? WHERE id=?')
      .run(status, status === 'completed' ? conclusion(run.channel, JSON.parse(run.response_json || '{}')) : 'error', reason, code || null, Date.now(), Date.now() - (run.started_at || run.created_at), id);
  }
  throttle(provider, seconds) { this.db.prepare('INSERT INTO degradation_provider_throttles VALUES (?,?) ON CONFLICT(provider) DO UPDATE SET until_at=MAX(until_at,excluded.until_at)').run(provider, Date.now() + Math.min(86400, seconds) * 1000); }
  throttled(channel) { return (this.db.prepare('SELECT until_at FROM degradation_provider_throttles WHERE provider=?').get(providerFor(channel))?.until_at || 0) > Date.now(); }
  history(id, channel, before = Number.MAX_SAFE_INTEGER, limit = 50, since = 0) {
    return this.db.prepare('SELECT id,group_id,channel,model,status,conclusion,reason,trigger_type,summary_json,created_at,started_at,finished_at,duration_ms FROM degradation_provider_runs WHERE group_id=? AND channel=? AND platform=? AND id<? AND created_at>=? ORDER BY id DESC LIMIT ?').all(String(id), channel, this.group(id, channel)?.platform || '', before, since, limit).map(runSummary);
  }
  counts(id, channel) {
    const platform = this.group(id, channel)?.platform || '';
    const counts = this.db.prepare("SELECT COUNT(*) AS total,SUM(conclusion='passed') AS passed,SUM(conclusion='failed') AS failed FROM degradation_provider_runs WHERE group_id=? AND channel=? AND platform=?").get(String(id), channel, platform);
    const archived = this.db.prepare('SELECT count FROM degradation_provider_archives WHERE group_id=? AND channel=? AND platform=?').get(String(id), channel, platform)?.count || 0;
    return { ...counts, archived };
  }
  deleteHistory(id, channel, ids = null) {
    return this.db.transaction(() => {
      const platform = this.group(id, channel)?.platform || '';
      if (ids && ids.some(value => { const run = this.run(value); return !run || run.group_id !== String(id) || run.channel !== channel || run.platform !== platform || ['queued', 'running'].includes(run.status); })) return null;
      let count = 0;
      if (ids) for (const value of ids) count += this.db.prepare('DELETE FROM degradation_provider_runs WHERE id=?').run(value).changes;
      else {
        count = this.db.prepare("DELETE FROM degradation_provider_runs WHERE group_id=? AND channel=? AND platform=? AND status NOT IN ('queued','running')").run(String(id), channel, platform).changes;
        this.db.prepare('DELETE FROM degradation_provider_archives WHERE group_id=? AND channel=? AND platform=?').run(String(id), channel, platform);
      }
      return count;
    })();
  }
  async maintain(policy, now = Date.now()) {
    const pairs = this.db.prepare('SELECT DISTINCT group_id,channel FROM degradation_provider_runs WHERE (group_id,channel)>(?,?) ORDER BY group_id,channel LIMIT 21').all(...this.maintenanceCursor);
    let archived = 0;
    let pending = pairs.length > 20;
    for (const pair of pairs.slice(0, 20)) {
      const args = [pair.group_id, pair.channel];
      this.db.transaction(() => {
        const boundary = this.db.prepare('SELECT id FROM degradation_provider_runs WHERE group_id=? AND channel=? ORDER BY id DESC LIMIT 1 OFFSET ?').get(...args, Math.max(60, policy.history_per_group) - 1)?.id || 0;
        const keep = this.db.prepare('SELECT id FROM degradation_provider_runs WHERE group_id=? AND channel=? ORDER BY id DESC LIMIT 1 OFFSET 59').get(...args)?.id || 0;
        const remove = policy.enabled ? this.db.prepare("SELECT id,platform FROM degradation_provider_runs WHERE group_id=? AND channel=? AND id<? AND (id<? OR created_at<?) AND status NOT IN ('queued','running') LIMIT 201").all(...args, keep, boundary, now - policy.history_days * 86400000) : [];
        pending ||= remove.length > 200;
        for (const row of remove.slice(0, 200)) this.db.prepare('DELETE FROM degradation_provider_runs WHERE id=?').run(row.id);
        if (remove.length) {
          const count = Math.min(200, remove.length);
          archived += count;
          const platforms = new Map();
          for (const row of remove.slice(0, 200)) platforms.set(row.platform, (platforms.get(row.platform) || 0) + 1);
          for (const [platform, total] of platforms) this.db.prepare('INSERT INTO degradation_provider_archives VALUES (?,?,?,?) ON CONFLICT(group_id,channel,platform) DO UPDATE SET count=count+excluded.count').run(...args, platform, total);
        }
        const payloadBoundary = this.db.prepare('SELECT id FROM degradation_provider_runs WHERE group_id=? AND channel=? ORDER BY id DESC LIMIT 1 OFFSET ?').get(...args, Math.max(60, policy.artifact_per_group) - 1)?.id || 0;
        const payloads = this.db.prepare("SELECT id FROM degradation_provider_runs WHERE group_id=? AND channel=? AND id<? AND status NOT IN ('queued','running') AND (response_json IS NOT NULL OR snapshot_json<>'{}' OR parts_json<>'{}') LIMIT 201").all(...args, payloadBoundary);
        for (const row of payloads.slice(0, 200)) this.db.prepare("UPDATE degradation_provider_runs SET response_json=NULL,snapshot_json='{}',parts_json='{}' WHERE id=?").run(row.id);
        pending ||= payloads.length > 200;
      })();
      await yieldToRequests();
    }
    this.maintenanceCursor = pairs.length > 20 ? [pairs[19].group_id, pairs[19].channel] : ['', ''];
    return { archived, pending };
  }
}

module.exports = { ProviderStore };
