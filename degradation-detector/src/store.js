'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { defaultStoragePolicy, storagePolicySchema, validateTestConfig } = require('./config');
const { nextScheduledRunAt, parseDailyTime } = require('./schedule');
const { snapshotValidation } = require('./visual-config');

const runSummaryColumns = `
  id, started_at, finished_at, status, quality, reason, source, duration_ms,
  output_type, model, reasoning_effort, score, validation_result_json, trigger_type,
  manual_status, manual_reason, manual_updated_at, manual_updated_by,
  (artifact_path IS NOT NULL OR (output_type = 'html' AND output_text IS NOT NULL)) AS has_artifact,
  (output_type = 'html' AND output_text IS NOT NULL) AS has_html
`;

function nowMs() {
  return Date.now();
}

function nullableNumber(value) {
  return value == null ? null : Number(value);
}

function reviewedStatus(row) {
  const status = String(row?.manual_status || '');
  return ['normal', 'degraded', 'unknown'].includes(status) ? status : null;
}

function publicReview(row) {
  const status = reviewedStatus(row);
  if (!status) return null;
  return {
    status,
    automated_status: row.status,
    reason: String(row.manual_reason || ''),
    reviewed_at: row.manual_updated_at == null ? null : row.manual_updated_at / 1000
  };
}

function parsedObject(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function publicValidationResult(row, includeRules = false) {
  const parsed = parsedObject(row?.validation_result_json);
  if (!parsed) return null;
  const exactScore = nullableNumber(row.score ?? parsed.score);
  const result = {
    score: exactScore,
    passed: Number(parsed.passed || 0),
    total: Number(parsed.total || 0),
    hard_failures: Number(parsed.hard_failures || 0),
    integrity_failures: Array.isArray(parsed.integrity_failures)
      ? parsed.integrity_failures.map(String).slice(0, 10)
      : []
  };
  if (parsed.score_min != null) result.score_min = nullableNumber(parsed.score_min);
  if (parsed.score_max != null) result.score_max = nullableNumber(parsed.score_max);
  if (parsed.coverage != null) result.coverage = nullableNumber(parsed.coverage);
  if (Number(parsed.indeterminate) > 0) result.indeterminate = Number(parsed.indeterminate);
  if (parsed.visual) {
    const visual = parsed.visual;
    result.local_status = ['normal', 'degraded', 'unknown'].includes(parsed.local_status) ? parsed.local_status : 'unknown';
    result.visual = {
      protocol: visual.protocol === 'manxue' ? 'manxue' : 'html_review',
      decision_mode: visual.decision_mode === 'both' ? 'both' : 'visual',
      status: ['normal', 'degraded'].includes(visual.status) ? visual.status : 'unknown',
      state: visual.state === 'completed' ? 'completed' : 'failed',
      reason: String(visual.reason || '').slice(0, 300),
      duration_ms: Math.max(0, Number(visual.duration_ms) || 0),
      ...(visual.error_code ? { error_code: String(visual.error_code).slice(0, 60) } : {})
    };
  }
  if (includeRules) {
    result.rules = Array.isArray(parsed.results) ? parsed.results.slice(0, 50).map((rule) => ({
      id: String(rule.id || '').slice(0, 64),
      label: String(rule.label || '').slice(0, 80),
      type: String(rule.type || '').slice(0, 40),
      severity: rule.severity === 'soft' ? 'soft' : 'hard',
      weight: Number(rule.weight || 0),
      passed: rule.passed === true,
      indeterminate: rule.indeterminate === true,
      message: String(rule.message || '').slice(0, 500)
    })) : [];
  }
  return result;
}

function testSnapshot(test) {
  if (!test) return null;
  return JSON.stringify({
    model: test.model,
    api: test.api,
    prompt: test.prompt,
    output_type: test.output_type,
    reasoning_effort: test.reasoning_effort || 'none',
    max_output_tokens: test.max_output_tokens,
    mime_type: test.mime_type || null,
    validation: snapshotValidation(test.validation) || null
  });
}

function storedSchedule(row) {
  let times = [];
  try {
    const parsed = JSON.parse(row?.schedule_times_json || '[]');
    if (Array.isArray(parsed)) {
      times = parsed.map((time) => parseDailyTime(time).value);
    }
  } catch {
    times = [];
  }
  if (times.length === 0) {
    try {
      times = [parseDailyTime(row?.schedule_time || '09:00').value];
    } catch {
      times = ['09:00'];
    }
  }
  times = [...new Set(times)].sort().slice(0, 24);
  const intervalMinutes = Number(row?.schedule_interval_minutes);
  return {
    mode: row?.schedule_mode === 'interval' ? 'interval' : 'daily',
    times,
    intervalMinutes: Number.isInteger(intervalMinutes) && intervalMinutes >= 1 && intervalMinutes <= 43200
      ? intervalMinutes
      : 60
  };
}

function publicRun(row) {
  if (!row) return null;
  const review = publicReview(row);
  return {
    id: row.id,
    started: row.started_at == null ? null : row.started_at / 1000,
    finished: row.finished_at == null ? null : row.finished_at / 1000,
    status: review?.status || row.status,
    quality: review?.status || row.quality,
    reason: review ? `人工复核：${review.reason}` : row.reason,
    source: row.source,
    duration_ms: nullableNumber(row.duration_ms),
    output_type: row.output_type,
    model: row.model,
    reasoning_effort: row.reasoning_effort || null,
    score: nullableNumber(row.score),
    validation: publicValidationResult(row),
    review,
    has_artifact: row.has_artifact == null
      ? Boolean(row.artifact_path || (row.output_type === 'html' && row.output_text)) : Boolean(row.has_artifact),
    has_html: row.has_html == null
      ? row.output_type === 'html' && Boolean(row.output_text) : Boolean(row.has_html)
  };
}

function rowTest(row) {
  if (!row) return null;
  try {
    return validateTestConfig(row.platform, {
      label: row.label,
      model: row.model,
      api: row.api,
      prompt: row.prompt,
      output_type: row.output_type,
      ...(row.reasoning_effort ? { reasoning_effort: row.reasoning_effort } : {}),
      max_output_tokens: row.max_output_tokens,
      ...(row.mime_type ? { mime_type: row.mime_type } : {}),
      validation: JSON.parse(row.validation_json || '{}')
    });
  } catch {
    return null;
  }
}

function rowMonitorTest(row) {
  if (!row?.test_config_json) return null;
  try {
    return validateTestConfig(row.platform, JSON.parse(row.test_config_json));
  } catch {
    return null;
  }
}

function storedTestConfig(test) {
  if (!test) return null;
  const { platform: _platform, ...config } = test;
  return JSON.stringify(config);
}

function emptyAssessmentState() {
  return { status: 'unknown', evidence: [], recoveryStreak: 0, recent: [] };
}

function advanceAssessment(state, current, confirmation) {
  state.recent.push(current);
  state.recent = state.recent.slice(-confirmation.window);
  if (state.status === 'degraded') {
    state.recoveryStreak = current === 'normal' ? state.recoveryStreak + 1 : 0;
    if (state.recoveryStreak >= confirmation.recovery_passes) {
      state.status = 'normal';
      state.evidence = [];
      state.recoveryStreak = 0;
    }
    return;
  }
  state.evidence.push(current);
  state.evidence = state.evidence.slice(-confirmation.window);
  if (state.evidence.filter((status) => status === 'degraded').length >= confirmation.required_failures) {
    state.status = 'degraded';
    state.evidence = [];
    state.recoveryStreak = 0;
  } else if (state.status === 'unknown' && current === 'normal') {
    state.status = 'normal';
  }
}

class Store {
  constructor(config) {
    this.config = config;
    fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
    fs.mkdirSync(config.artifactDir, { recursive: true });
    this.db = new Database(config.databasePath);
    if (this.db.pragma('page_count', { simple: true }) === 0) {
      this.db.pragma('auto_vacuum = INCREMENTAL');
    }
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.summaryCache = new Map();
    this.#migrate();
    this.recoverInterruptedRuns();
  }

  #ensureColumn(table, name, declaration) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((column) => column.name === name)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`);
    }
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS monitors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        group_name TEXT NOT NULL,
        platform TEXT NOT NULL,
        key_cipher TEXT,
        key_fingerprint TEXT,
        test_config_json TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at INTEGER,
        next_run_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(user_id, group_id)
      );

      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt TEXT NOT NULL,
        trigger_type TEXT NOT NULL,
        status TEXT NOT NULL,
        quality TEXT,
        reason TEXT,
        source TEXT,
        started_at INTEGER,
        finished_at INTEGER,
        duration_ms INTEGER,
        output_type TEXT NOT NULL,
        reasoning_effort TEXT,
        test_snapshot TEXT,
        validation_snapshot TEXT,
        validation_result_json TEXT,
        score REAL,
        manual_status TEXT,
        manual_reason TEXT,
        manual_updated_by TEXT,
        manual_updated_at INTEGER,
        output_text TEXT,
        artifact_path TEXT,
        artifact_name TEXT,
        artifact_mime TEXT,
        preview_token TEXT UNIQUE,
        error_code TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS service_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        schedule_time TEXT NOT NULL,
        schedule_mode TEXT NOT NULL DEFAULT 'daily',
        schedule_times_json TEXT,
        schedule_interval_minutes INTEGER NOT NULL DEFAULT 60,
        schedule_timezone TEXT NOT NULL,
        updated_by TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS platform_configs (
        platform TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        model TEXT NOT NULL,
        api TEXT NOT NULL,
        prompt TEXT NOT NULL,
        output_type TEXT NOT NULL,
        reasoning_effort TEXT,
        max_output_tokens INTEGER NOT NULL,
        mime_type TEXT,
        validation_json TEXT NOT NULL,
        updated_by TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS run_archives (
        monitor_id INTEGER PRIMARY KEY REFERENCES monitors(id) ON DELETE CASCADE,
        attempts INTEGER NOT NULL DEFAULT 0,
        valid INTEGER NOT NULL DEFAULT 0,
        passed INTEGER NOT NULL DEFAULT 0,
        assessment_snapshot TEXT,
        assessment_state TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS monitors_due_idx
        ON monitors(enabled, next_run_at);
      CREATE INDEX IF NOT EXISTS runs_monitor_created_idx
        ON runs(monitor_id, id DESC);
      CREATE INDEX IF NOT EXISTS runs_user_group_idx
        ON runs(user_id, group_id, id DESC);
      CREATE INDEX IF NOT EXISTS runs_preview_idx
        ON runs(preview_token);
      CREATE INDEX IF NOT EXISTS runs_artifact_idx
        ON runs(artifact_path) WHERE artifact_path IS NOT NULL;
    `);
    this.#ensureColumn('monitors', 'key_fingerprint', 'TEXT');
    this.#ensureColumn('monitors', 'test_config_json', 'TEXT');
    this.#ensureColumn('runs', 'reasoning_effort', 'TEXT');
    this.#ensureColumn('runs', 'test_snapshot', 'TEXT');
    this.#ensureColumn('runs', 'validation_snapshot', 'TEXT');
    this.#ensureColumn('runs', 'validation_result_json', 'TEXT');
    this.#ensureColumn('runs', 'score', 'REAL');
    this.#ensureColumn('runs', 'manual_status', 'TEXT');
    this.#ensureColumn('runs', 'manual_reason', 'TEXT');
    this.#ensureColumn('runs', 'manual_updated_by', 'TEXT');
    this.#ensureColumn('runs', 'manual_updated_at', 'INTEGER');
    this.#ensureColumn('service_settings', 'schedule_mode', "TEXT NOT NULL DEFAULT 'daily'");
    this.#ensureColumn('service_settings', 'schedule_times_json', 'TEXT');
    this.#ensureColumn('service_settings', 'schedule_interval_minutes', 'INTEGER NOT NULL DEFAULT 60');
    this.#ensureColumn('service_settings', 'storage_policy_json', 'TEXT');
    this.#ensureColumn('service_settings', 'maintenance_last_run_at', 'INTEGER');
    this.#ensureColumn('service_settings', 'maintenance_last_result_json', 'TEXT');
    this.#ensureColumn('service_settings', 'maintenance_last_compact_at', 'INTEGER');
    this.db.prepare(`
      INSERT OR IGNORE INTO service_settings (
        id, schedule_time, schedule_mode, schedule_times_json,
        schedule_interval_minutes, schedule_timezone, updated_by, updated_at
      ) VALUES (1, '09:00', 'daily', '["09:00"]', 60, ?, NULL, ?)
    `).run(this.config.scheduleTimezone, nowMs());
    const settings = this.db.prepare('SELECT * FROM service_settings WHERE id = 1').get();
    const schedule = storedSchedule(settings);
    this.db.prepare(`
      UPDATE service_settings SET
        schedule_time = ?, schedule_mode = ?, schedule_times_json = ?,
        schedule_interval_minutes = ?
      WHERE id = 1
    `).run(
      schedule.times[0],
      schedule.mode,
      JSON.stringify(schedule.times),
      schedule.intervalMinutes
    );
  }

  close() {
    this.summaryCache.clear();
    this.db.close();
  }

  invalidateSummary(userId, groupId) {
    if (userId == null) this.summaryCache.clear();
    else this.summaryCache.delete(JSON.stringify([String(userId), String(groupId)]));
  }

  getServiceSettings() {
    const row = this.db.prepare('SELECT * FROM service_settings WHERE id = 1').get();
    const schedule = storedSchedule(row);
    const { schedule_times_json: omitted, storage_policy_json: omittedPolicy,
      maintenance_last_result_json: omittedResult, ...settings } = row;
    const policy = storagePolicySchema.safeParse(parsedObject(row.storage_policy_json));
    return {
      ...settings,
      schedule_mode: schedule.mode,
      schedule_times: schedule.times,
      schedule_interval_minutes: schedule.intervalMinutes,
      storage_policy: policy.success ? policy.data : { ...defaultStoragePolicy },
      maintenance_last_result: parsedObject(row.maintenance_last_result_json)
    };
  }

  nextScheduledAt(from = nowMs()) {
    const settings = this.getServiceSettings();
    return nextScheduledRunAt({
      mode: settings.schedule_mode,
      times: settings.schedule_times,
      intervalMinutes: settings.schedule_interval_minutes
    }, from, settings.schedule_timezone);
  }

  getPlatformConfig(platform) {
    const row = this.db.prepare('SELECT * FROM platform_configs WHERE platform = ?')
      .get(String(platform));
    if (!row) return null;
    return { ...row, enabled: Boolean(row.enabled), test: rowTest(row) };
  }

  listPlatformConfigs(enabledOnly = false) {
    const rows = this.db.prepare(`
      SELECT * FROM platform_configs
      ${enabledOnly ? 'WHERE enabled = 1' : ''}
      ORDER BY platform ASC
    `).all();
    return rows.map((row) => ({ ...row, enabled: Boolean(row.enabled), test: rowTest(row) }));
  }

  getPlatformTest(platform, enabledOnly = true) {
    const config = this.getPlatformConfig(platform);
    if (!config || (enabledOnly && !config.enabled)) return null;
    return config.test;
  }

  getMonitorTestOverride(monitor) {
    return rowMonitorTest(monitor);
  }

  getMonitorTest(monitor, enabledOnly = true) {
    if (!monitor) return null;
    const platform = this.getPlatformConfig(monitor.platform);
    if (!platform || (enabledOnly && !platform.enabled)) return null;
    return this.getMonitorTestOverride(monitor) || platform.test;
  }

  saveAdminConfiguration(input) {
    const timestamp = nowMs();
    const storagePolicy = storagePolicySchema.parse(input.storagePolicy || this.getServiceSettings().storage_policy);
    const transaction = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE service_settings SET
          schedule_time = ?, schedule_mode = ?, schedule_times_json = ?,
          schedule_interval_minutes = ?, schedule_timezone = ?, updated_by = ?, updated_at = ?, storage_policy_json = ?
        WHERE id = 1
      `).run(
        input.scheduleTimes[0],
        input.scheduleMode,
        JSON.stringify(input.scheduleTimes),
        input.scheduleIntervalMinutes,
        input.scheduleTimezone,
        input.updatedBy,
        timestamp,
        JSON.stringify(storagePolicy)
      );

      this.db.prepare('UPDATE platform_configs SET enabled = 0').run();
      const upsertPlatform = this.db.prepare(`
        INSERT INTO platform_configs (
          platform, label, enabled, model, api, prompt, output_type,
          reasoning_effort, max_output_tokens, mime_type, validation_json,
          updated_by, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(platform) DO UPDATE SET
          label = excluded.label,
          enabled = excluded.enabled,
          model = excluded.model,
          api = excluded.api,
          prompt = excluded.prompt,
          output_type = excluded.output_type,
          reasoning_effort = excluded.reasoning_effort,
          max_output_tokens = excluded.max_output_tokens,
          mime_type = excluded.mime_type,
          validation_json = excluded.validation_json,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at
      `);
      for (const platform of input.platforms) {
        const test = platform.test;
        upsertPlatform.run(
          platform.id,
          test.label || platform.id,
          platform.enabled ? 1 : 0,
          test.model,
          test.api,
          test.prompt,
          test.output_type,
          test.reasoning_effort || null,
          test.max_output_tokens,
          test.mime_type || null,
          JSON.stringify(test.validation || {}),
          input.updatedBy,
          timestamp
        );
      }

      this.db.prepare(`
        UPDATE monitors SET
          enabled = 0,
          next_run_at = NULL,
          key_cipher = NULL,
          key_fingerprint = NULL,
          updated_at = ?
        WHERE user_id = ?
      `).run(timestamp, input.serviceOwnerId);

      const nextRunAt = nextScheduledRunAt({
        mode: input.scheduleMode,
        times: input.scheduleTimes,
        intervalMinutes: input.scheduleIntervalMinutes
      }, timestamp, input.scheduleTimezone);
      for (const group of input.groups) {
        const groupEnabled = group.enabled !== false;
        this.upsertMonitor({
          userId: input.serviceOwnerId,
          groupId: group.id,
          groupName: group.name,
          platform: group.platform,
          keyCipher: group.keyCipher,
          keyFingerprint: group.keyFingerprint,
          testConfigJson: storedTestConfig(group.test),
          enabled: groupEnabled,
          nextRunAt: groupEnabled ? nextRunAt : null
        });
      }
      return { nextRunAt, groupsEnabled: input.groups.filter((group) => group.enabled !== false).length };
    });
    const result = transaction();
    this.invalidateSummary();
    return result;
  }

  recoverInterruptedRuns() {
    this.invalidateSummary();
    const timestamp = nowMs();
    const transaction = this.db.transaction(() => {
      const monitorIds = this.db.prepare(`
        SELECT DISTINCT monitor_id FROM runs WHERE status IN ('queued', 'running')
      `).all().map((row) => row.monitor_id);
      if (monitorIds.length === 0) return 0;
      const result = this.db.prepare(`
        UPDATE runs SET
          status = 'error', quality = NULL,
          reason = '服务重启中断了本次检测，已安排重新检测',
          source = 'service_restart', finished_at = ?,
          duration_ms = CASE WHEN started_at IS NULL THEN 0 ELSE MAX(0, ? - started_at) END,
          error_code = 'SERVICE_RESTARTED'
        WHERE status IN ('queued', 'running')
      `).run(timestamp, timestamp);
      const placeholders = monitorIds.map(() => '?').join(',');
      this.db.prepare(`
        UPDATE monitors SET
          last_run_at = ?,
          next_run_at = CASE WHEN enabled = 1 THEN ? ELSE NULL END,
          updated_at = ?
        WHERE id IN (${placeholders})
      `).run(timestamp, timestamp, timestamp, ...monitorIds);
      return result.changes;
    });
    return transaction();
  }

  prepareServiceOwnership(serviceOwnerId) {
    this.invalidateSummary();
    const owner = String(serviceOwnerId);
    const timestamp = nowMs();
    const transaction = this.db.transaction(() => {
      const credentialsCleared = this.db.prepare(`
        UPDATE monitors SET key_cipher = NULL, key_fingerprint = NULL, enabled = 0,
          next_run_at = NULL, updated_at = ?
        WHERE key_cipher IS NOT NULL AND key_cipher NOT LIKE 'v1.%'
      `).run(timestamp).changes;
      const legacyDisabled = this.db.prepare(`
        UPDATE monitors SET enabled = 0, next_run_at = NULL,
          key_cipher = NULL, key_fingerprint = NULL, updated_at = ?
        WHERE user_id <> ?
          AND (enabled = 1 OR key_cipher IS NOT NULL OR key_fingerprint IS NOT NULL)
      `).run(timestamp, owner).changes;
      const unconfiguredDisabled = this.db.prepare(`
        UPDATE monitors SET enabled = 0, next_run_at = NULL, updated_at = ?
        WHERE user_id = ? AND enabled = 1
          AND (key_cipher IS NULL OR key_fingerprint IS NULL)
      `).run(timestamp, owner).changes;
      return { credentialsCleared, legacyDisabled, unconfiguredDisabled };
    });
    return transaction();
  }

  upsertMonitor(input) {
    this.invalidateSummary(input.userId, input.groupId);
    const timestamp = nowMs();
    const existing = this.getMonitor(input.userId, input.groupId);
    const keyCipher = input.keyCipher === undefined ? existing?.key_cipher || null : input.keyCipher;
    const keyFingerprint = input.keyFingerprint === undefined
      ? existing?.key_fingerprint || null
      : input.keyFingerprint;
    const testConfigJson = input.testConfigJson === undefined
      ? existing?.test_config_json || null
      : input.testConfigJson;
    this.db.prepare(`
      INSERT INTO monitors (
        user_id, group_id, group_name, platform, key_cipher, key_fingerprint,
        test_config_json, enabled, next_run_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, group_id) DO UPDATE SET
        group_name = excluded.group_name,
        platform = excluded.platform,
        key_cipher = excluded.key_cipher,
        key_fingerprint = excluded.key_fingerprint,
        test_config_json = excluded.test_config_json,
        enabled = excluded.enabled,
        next_run_at = excluded.next_run_at,
        updated_at = excluded.updated_at
    `).run(
      String(input.userId),
      String(input.groupId),
      String(input.groupName),
      String(input.platform),
      keyCipher,
      keyFingerprint,
      testConfigJson,
      input.enabled === false ? 0 : 1,
      input.enabled === false ? null : (input.nextRunAt ?? timestamp),
      existing?.created_at || timestamp,
      timestamp
    );
    return this.getMonitor(input.userId, input.groupId);
  }

  getMonitor(userId, groupId) {
    return this.db.prepare('SELECT * FROM monitors WHERE user_id = ? AND group_id = ?')
      .get(String(userId), String(groupId)) || null;
  }

  getEnabledMonitor(userId, groupId) {
    return this.db.prepare(`
      SELECT m.* FROM monitors m
      JOIN platform_configs p ON p.platform = m.platform AND p.enabled = 1
      WHERE m.user_id = ? AND m.group_id = ? AND m.enabled = 1
        AND m.key_cipher IS NOT NULL AND m.key_fingerprint IS NOT NULL
    `).get(String(userId), String(groupId)) || null;
  }

  getMonitorById(id) {
    return this.db.prepare('SELECT * FROM monitors WHERE id = ?').get(Number(id)) || null;
  }

  listMonitors(userId) {
    return this.db.prepare('SELECT * FROM monitors WHERE user_id = ? ORDER BY id ASC')
      .all(String(userId));
  }

  listEnabledMonitors(userId) {
    return this.db.prepare(`
      SELECT m.* FROM monitors m
      JOIN platform_configs p ON p.platform = m.platform AND p.enabled = 1
      WHERE m.user_id = ? AND m.enabled = 1
        AND m.key_cipher IS NOT NULL AND m.key_fingerprint IS NOT NULL
      ORDER BY m.id ASC
    `).all(String(userId));
  }

  setMonitorEnabled(userId, groupId, enabled, nextRunAt = this.nextScheduledAt()) {
    this.invalidateSummary(userId, groupId);
    this.db.prepare(`
      UPDATE monitors SET enabled = ?, next_run_at = ?, updated_at = ?
      WHERE user_id = ? AND group_id = ?
    `).run(enabled ? 1 : 0, enabled ? nextRunAt : null, nowMs(), String(userId), String(groupId));
    return this.getMonitor(userId, groupId);
  }

  disableUnavailableMonitors(userId, groupIds) {
    this.invalidateSummary();
    const available = [...new Set(groupIds.map((groupId) => String(groupId)))];
    const timestamp = nowMs();
    if (available.length === 0) {
      return this.db.prepare(`
        UPDATE monitors SET enabled = 0, next_run_at = NULL, key_cipher = NULL,
          key_fingerprint = NULL, updated_at = ?
        WHERE user_id = ? AND enabled = 1
      `).run(timestamp, String(userId)).changes;
    }
    const placeholders = available.map(() => '?').join(',');
    return this.db.prepare(`
      UPDATE monitors SET enabled = 0, next_run_at = NULL, key_cipher = NULL,
        key_fingerprint = NULL, updated_at = ?
      WHERE user_id = ? AND enabled = 1 AND group_id NOT IN (${placeholders})
    `).run(timestamp, String(userId), ...available).changes;
  }

  listDueMonitors(limit = 100) {
    return this.db.prepare(`
      SELECT m.* FROM monitors m
      JOIN platform_configs p ON p.platform = m.platform AND p.enabled = 1
      WHERE m.enabled = 1 AND m.next_run_at IS NOT NULL AND m.next_run_at <= ?
        AND m.key_cipher IS NOT NULL AND m.key_fingerprint IS NOT NULL
      ORDER BY m.next_run_at ASC
      LIMIT ?
    `).all(nowMs(), Number(limit));
  }

  createRun(monitor, test, triggerType) {
    this.invalidateSummary(monitor.user_id, monitor.group_id);
    const result = this.db.prepare(`
      INSERT INTO runs (
        monitor_id, user_id, group_id, platform, model, prompt, trigger_type,
        status, output_type, reasoning_effort, test_snapshot, validation_snapshot, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)
    `).run(
      monitor.id,
      monitor.user_id,
      monitor.group_id,
      monitor.platform,
      test.model,
      test.prompt,
      triggerType,
      test.output_type,
      test.reasoning_effort || 'none',
      testSnapshot(test),
      test.validation ? JSON.stringify(snapshotValidation(test.validation)) : null,
      nowMs()
    );
    return this.getRun(result.lastInsertRowid);
  }

  markRunRunning(id) {
    const run = this.getRun(id);
    if (run) this.invalidateSummary(run.user_id, run.group_id);
    const startedAt = nowMs();
    this.db.prepare(`
      UPDATE runs SET status = 'running', started_at = ?
      WHERE id = ? AND status = 'queued'
    `).run(startedAt, Number(id));
    return this.getRun(id);
  }

  saveRunOutput(id, output) {
    this.db.prepare(`
      UPDATE runs SET output_text = ?, artifact_path = ?, artifact_name = ?, artifact_mime = ?, preview_token = ?
      WHERE id = ? AND status = 'running'
    `).run(output.outputText, output.artifactPath, output.artifactName, output.artifactMime, output.previewToken, Number(id));
  }

  completeRun(id, result, nextRunAt) {
    const finishedAt = nowMs();
    const run = this.getRun(id);
    if (!run) throw new Error(`Run ${id} does not exist`);
    this.invalidateSummary(run.user_id, run.group_id);
    const startedAt = run.started_at || finishedAt;
    const currentMonitor = this.getMonitorById(run.monitor_id);
    const resolvedNextRunAt = nextRunAt !== undefined
      ? nextRunAt
      : (run.trigger_type === 'manual' ? currentMonitor?.next_run_at : this.nextScheduledAt(finishedAt));
    const transaction = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE runs SET
          status = ?, quality = ?, reason = ?, source = ?, finished_at = ?,
          duration_ms = ?, output_text = ?, artifact_path = ?, artifact_name = ?,
          artifact_mime = ?, preview_token = ?, error_code = ?,
          validation_result_json = ?, score = ?
        WHERE id = ?
      `).run(
        result.status,
        result.quality || null,
        result.reason || null,
        result.source || null,
        finishedAt,
        Math.max(0, finishedAt - startedAt),
        result.outputText || null,
        result.artifactPath || null,
        result.artifactName || null,
        result.artifactMime || null,
        result.previewToken || null,
        result.errorCode || null,
        result.validationResult ? JSON.stringify(result.validationResult) : null,
        result.score == null ? null : Number(result.score),
        Number(id)
      );
      this.db.prepare(`
        UPDATE monitors SET
          last_run_at = ?,
          next_run_at = CASE WHEN enabled = 1 THEN ? ELSE NULL END,
          updated_at = ?
        WHERE id = ?
      `).run(finishedAt, resolvedNextRunAt ?? null, finishedAt, run.monitor_id);
    });
    transaction();
    return this.getRun(id);
  }

  failRun(id, result, nextRunAt) {
    return this.completeRun(id, {
      status: 'error',
      quality: null,
      reason: result.reason || '分组请求异常，本次不计入有效结果',
      source: result.source || 'request_error',
      outputText: result.outputText || null,
      errorCode: result.errorCode || null
    }, nextRunAt);
  }

  getRun(id) {
    return this.db.prepare('SELECT * FROM runs WHERE id = ?').get(Number(id)) || null;
  }

  getRunForUser(id, userId) {
    return this.db.prepare('SELECT * FROM runs WHERE id = ? AND user_id = ?')
      .get(Number(id), String(userId)) || null;
  }

  getRunByPreviewToken(token) {
    return this.db.prepare('SELECT * FROM runs WHERE preview_token = ?')
      .get(String(token)) || null;
  }

  activeRun(userId, groupId) {
    return this.db.prepare(`
      SELECT * FROM runs
      WHERE user_id = ? AND group_id = ? AND status IN ('queued', 'running')
      ORDER BY id DESC LIMIT 1
    `).get(String(userId), String(groupId)) || null;
  }

  listHistory(userId, groupId, limit) {
    return this.db.prepare(`
      SELECT * FROM runs WHERE user_id = ? AND group_id = ?
      ORDER BY id DESC LIMIT ?
    `).all(String(userId), String(groupId), Number(limit));
  }

  historyCounts(userId) {
    return this.db.prepare(`
      SELECT group_id, COUNT(*) AS count
      FROM runs
      WHERE user_id = ?
      GROUP BY group_id
    `).all(String(userId)).map((row) => ({
      group_id: String(row.group_id),
      count: Number(row.count || 0)
    }));
  }

  historyStats(userId, groupId) {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status NOT IN ('queued', 'running') THEN 1 ELSE 0 END) AS deletable
      FROM runs
      WHERE user_id = ? AND group_id = ?
    `).get(String(userId), String(groupId));
    return {
      total: Number(row?.total || 0),
      deletable: Number(row?.deletable || 0)
    };
  }

  listHistoryPage(userId, groupId, limit, beforeId = null) {
    const pageSize = Math.floor(Math.max(1, Math.min(101, Number(limit) || 50)));
    if (beforeId == null) {
      return this.db.prepare(`
        SELECT ${runSummaryColumns} FROM runs
        WHERE user_id = ? AND group_id = ?
        ORDER BY id DESC LIMIT ?
      `).all(String(userId), String(groupId), pageSize);
    }
    return this.db.prepare(`
      SELECT ${runSummaryColumns} FROM runs
      WHERE user_id = ? AND group_id = ? AND id < ?
      ORDER BY id DESC LIMIT ?
    `).all(String(userId), String(groupId), Number(beforeId), pageSize);
  }

  reviewRun(userId, groupId, runId, review, reviewedBy) {
    this.invalidateSummary(userId, groupId);
    const owner = String(userId);
    const group = String(groupId);
    const id = Number(runId);
    const run = this.db.prepare(`
      SELECT * FROM runs WHERE id = ? AND user_id = ? AND group_id = ?
    `).get(id, owner, group);
    if (!run) return { outcome: 'not_found', run: null };
    if (!['normal', 'degraded', 'unknown'].includes(run.status)) {
      return { outcome: 'not_reviewable', run };
    }

    const status = review?.status == null ? null : String(review.status);
    const reason = status == null ? null : String(review.reason || '').trim();
    if (status != null && !['normal', 'degraded', 'unknown'].includes(status)) {
      throw new TypeError('Invalid manual review status');
    }
    if (status != null && (reason.length < 2 || reason.length > 500)) {
      throw new TypeError('Invalid manual review reason');
    }
    const timestamp = status == null ? null : nowMs();
    this.db.prepare(`
      UPDATE runs SET
        manual_status = ?, manual_reason = ?, manual_updated_by = ?, manual_updated_at = ?
      WHERE id = ? AND user_id = ? AND group_id = ?
    `).run(
      status,
      reason,
      status == null ? null : String(reviewedBy),
      timestamp,
      id,
      owner,
      group
    );
    return { outcome: 'updated', run: this.getRun(id) };
  }

  deleteHistory(userId, groupId, runIds = null) {
    this.invalidateSummary(userId, groupId);
    const owner = String(userId);
    const group = String(groupId);
    const all = runIds == null;
    const requestedIds = all
      ? []
      : [...new Set(runIds.map((id) => Number(id)))];
    if (!all && requestedIds.length === 0) {
      return { deleted: 0, artifactPaths: [], missingIds: [], activeIds: [] };
    }
    let rows;
    if (all) {
      rows = this.db.prepare(`
        SELECT id, status, artifact_path FROM runs
        WHERE user_id = ? AND group_id = ? AND status NOT IN ('queued', 'running')
        ORDER BY id DESC
      `).all(owner, group);
    } else {
      const placeholders = requestedIds.map(() => '?').join(',');
      rows = this.db.prepare(`
        SELECT id, status, artifact_path FROM runs
        WHERE user_id = ? AND group_id = ? AND id IN (${placeholders})
        ORDER BY id DESC
      `).all(owner, group, ...requestedIds);
    }

    const found = new Set(rows.map((row) => Number(row.id)));
    const missingIds = all ? [] : requestedIds.filter((id) => !found.has(id));
    const activeIds = rows
      .filter((row) => ['queued', 'running'].includes(row.status))
      .map((row) => Number(row.id));
    if (all && rows.length === 0) {
      this.db.prepare(`DELETE FROM run_archives WHERE monitor_id IN (
        SELECT id FROM monitors WHERE user_id = ? AND group_id = ?
      )`).run(owner, group);
    }
    if (missingIds.length || activeIds.length || rows.length === 0) {
      return { deleted: 0, artifactPaths: [], missingIds, activeIds };
    }

    const ids = rows.map((row) => Number(row.id));
    const remove = all
      ? this.db.prepare(`
          DELETE FROM runs
          WHERE user_id = ? AND group_id = ? AND status NOT IN ('queued', 'running')
        `)
      : this.db.prepare(`
          DELETE FROM runs
          WHERE user_id = ? AND group_id = ? AND id IN (${ids.map(() => '?').join(',')})
        `);
    const updateMonitor = this.db.prepare(`
      UPDATE monitors SET
        last_run_at = (
          SELECT MAX(COALESCE(finished_at, started_at, created_at))
          FROM runs
          WHERE monitor_id = monitors.id AND status NOT IN ('queued', 'running')
        ),
        updated_at = ?
      WHERE user_id = ? AND group_id = ?
    `);
    const transaction = this.db.transaction(() => {
      const result = all ? remove.run(owner, group) : remove.run(owner, group, ...ids);
      if (all) this.db.prepare(`DELETE FROM run_archives WHERE monitor_id IN (
        SELECT id FROM monitors WHERE user_id = ? AND group_id = ?
      )`).run(owner, group);
      updateMonitor.run(nowMs(), owner, group);
      return result.changes;
    });
    return {
      deleted: transaction(),
      artifactPaths: rows.map((row) => row.artifact_path).filter(Boolean),
      missingIds: [],
      activeIds: []
    };
  }

  groupSummary(userId, groupId, historyLimit) {
    const monitor = this.getMonitor(userId, groupId);
    const key = JSON.stringify([String(userId), String(groupId)]);
    const limit = Math.max(0, Math.min(2000, Math.floor(Number(historyLimit) || 0)));
    const cached = this.summaryCache.get(key);
    if (cached?.limit === limit) {
      this.summaryCache.delete(key);
      this.summaryCache.set(key, cached);
      return { monitor, ...cached.value };
    }
    const totals = this.db.prepare(`
      SELECT
        COUNT(*) AS history_total,
        SUM(CASE WHEN status NOT IN ('queued', 'running') THEN 1 ELSE 0 END) AS attempts,
        SUM(CASE WHEN status NOT IN ('queued', 'running') AND COALESCE(manual_status, status) IN ('normal', 'degraded') THEN 1 ELSE 0 END) AS valid,
        SUM(CASE WHEN status NOT IN ('queued', 'running') AND COALESCE(manual_status, status) = 'normal' THEN 1 ELSE 0 END) AS passed
      FROM runs
      WHERE user_id = ? AND group_id = ?
    `).get(String(userId), String(groupId));
    const archived = monitor ? this.db.prepare('SELECT * FROM run_archives WHERE monitor_id = ?').get(monitor.id) : null;
    const value = {
      historyTotal: Number(totals?.history_total || 0) + Number(archived?.attempts || 0),
      historyArchived: Number(archived?.attempts || 0),
      totals: {
        passed: Number(totals?.passed || 0) + Number(archived?.passed || 0),
        valid: Number(totals?.valid || 0) + Number(archived?.valid || 0),
        attempts: Number(totals?.attempts || 0) + Number(archived?.attempts || 0)
      },
      assessment: this.groupAssessment(userId, groupId, monitor),
      history: this.db.prepare(`
        SELECT ${runSummaryColumns} FROM runs WHERE user_id = ? AND group_id = ? ORDER BY id DESC LIMIT ?
      `).all(String(userId), String(groupId), limit).map(publicRun)
    };
    this.summaryCache.set(key, { limit, value });
    if (this.summaryCache.size > 128) this.summaryCache.delete(this.summaryCache.keys().next().value);
    return { monitor, ...value };
  }

  groupAssessment(userId, groupId, monitor = this.getMonitor(userId, groupId)) {
    const test = this.getMonitorTest(monitor);
    const confirmation = test?.validation?.confirmation || {
      window: 3,
      required_failures: 2,
      recovery_passes: 2
    };
    const snapshot = testSnapshot(test);
    const state = this.archivedAssessmentState(monitor?.id, snapshot);
    const rows = this.db.prepare(`
      SELECT COALESCE(manual_status, status) AS effective_status FROM runs
      WHERE user_id = ? AND group_id = ?
        AND COALESCE(manual_status, status) IN ('normal', 'degraded')
        ${snapshot ? 'AND test_snapshot = ?' : ''}
      ORDER BY id ASC
    `).iterate(
      String(userId),
      String(groupId),
      ...(snapshot ? [snapshot] : [])
    );
    for (const row of rows) advanceAssessment(state, row.effective_status, confirmation);
    const statuses = state.recent;
    const status = state.status;

    let consecutiveNormal = 0;
    for (let index = statuses.length - 1; index >= 0; index -= 1) {
      if (statuses[index] !== 'normal') break;
      consecutiveNormal += 1;
    }
    const failures = statuses.filter((status) => status === 'degraded').length;
    let reason = '暂无与当前检测配置匹配的有效结果';
    if (status === 'normal') {
      if (statuses.at(-1) === 'degraded') {
        reason = `综合状态保持正常；最近 ${statuses.length} 次有效检测中有 ${failures} 次疑似降智，尚未达到 ${confirmation.required_failures} 次确认条件`;
      } else {
        reason = consecutiveNormal > 1
          ? `最近连续 ${consecutiveNormal} 次有效检测正常`
          : '最近一次有效检测正常';
      }
    } else if (status === 'degraded') {
      reason = consecutiveNormal > 0
        ? `综合状态仍为疑似降智；已连续 ${consecutiveNormal}/${confirmation.recovery_passes} 次有效检测正常`
        : `综合状态为疑似降智；需连续 ${confirmation.recovery_passes} 次有效检测正常后恢复`;
    } else if (statuses.length > 0) {
      reason = `最近 ${statuses.length} 次有效检测中有 ${failures} 次疑似降智，尚未达到 ${confirmation.required_failures} 次确认条件`;
    }
    return {
      status,
      reason,
      considered: statuses.length,
      window: confirmation.window,
      required_failures: confirmation.required_failures,
      recovery_passes: confirmation.recovery_passes
    };
  }

  archivedAssessmentState(monitorId, snapshot) {
    const archive = monitorId == null ? null : this.db.prepare(
      'SELECT assessment_snapshot, assessment_state FROM run_archives WHERE monitor_id = ?'
    ).get(Number(monitorId));
    const state = archive?.assessment_snapshot === snapshot ? parsedObject(archive.assessment_state) : null;
    return state && ['normal', 'degraded', 'unknown'].includes(state.status)
      && Array.isArray(state.evidence) && Array.isArray(state.recent) ? state : emptyAssessmentState();
  }

  archiveCounts(userId) {
    return this.db.prepare(`
      SELECT m.group_id, a.attempts AS count FROM run_archives a
      JOIN monitors m ON m.id = a.monitor_id WHERE m.user_id = ?
    `).all(String(userId));
  }

  archivedCount(userId, groupId) {
    return Number(this.db.prepare(`
      SELECT a.attempts FROM run_archives a JOIN monitors m ON m.id = a.monitor_id
      WHERE m.user_id = ? AND m.group_id = ?
    `).get(String(userId), String(groupId))?.attempts || 0);
  }

  listMaintenanceMonitors(afterId = 0, limit = 20) {
    return this.db.prepare('SELECT * FROM monitors WHERE id > ? ORDER BY id LIMIT ?')
      .all(Number(afterId), Number(limit));
  }

  archiveHistory(monitor, policy, timestamp = nowMs(), batchSize = 200) {
    const empty = { archived: 0, artifactPaths: [], pending: false };
    if (!policy.enabled) return empty;
    const protectedId = this.db.prepare(`
      SELECT id FROM runs WHERE monitor_id = ? ORDER BY id DESC LIMIT 1 OFFSET 59
    `).get(monitor.id)?.id;
    if (!protectedId) return empty;
    const countBoundary = this.db.prepare(`
      SELECT id FROM runs WHERE monitor_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?
    `).get(monitor.id, policy.history_per_group - 1)?.id || 0;
    const activeId = this.db.prepare(`
      SELECT MIN(id) AS id FROM runs WHERE monitor_id = ? AND status IN ('queued', 'running')
    `).get(monitor.id)?.id;
    const rows = this.db.prepare(`
      SELECT id, status, COALESCE(manual_status, status) AS effective_status,
        test_snapshot, created_at, artifact_path FROM runs
      WHERE monitor_id = ? AND id < ? ORDER BY id LIMIT ?
    `).all(monitor.id, Math.min(protectedId, activeId ?? protectedId), batchSize + 1);
    const cutoff = timestamp - policy.history_days * 86400000;
    const eligible = [];
    for (const row of rows) {
      if (row.id >= countBoundary && row.created_at >= cutoff) break;
      eligible.push(row);
    }
    const selected = eligible.slice(0, batchSize);
    if (!selected.length) return empty;
    const test = this.getMonitorTest(monitor);
    const snapshot = testSnapshot(test);
    const confirmation = test?.validation?.confirmation || { window: 3, required_failures: 2, recovery_passes: 2 };
    const state = this.archivedAssessmentState(monitor.id, snapshot);
    let valid = 0;
    let passed = 0;
    for (const row of selected) {
      if (!['normal', 'degraded'].includes(row.effective_status)) continue;
      valid += 1;
      if (row.effective_status === 'normal') passed += 1;
      if (!snapshot || row.test_snapshot === snapshot) advanceAssessment(state, row.effective_status, confirmation);
    }
    // Archive only the chronological prefix so the saved state precedes every retained verdict.
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO run_archives (monitor_id, attempts, valid, passed, assessment_snapshot, assessment_state, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(monitor_id) DO UPDATE SET
          attempts = attempts + excluded.attempts, valid = valid + excluded.valid, passed = passed + excluded.passed,
          assessment_snapshot = excluded.assessment_snapshot, assessment_state = excluded.assessment_state,
          updated_at = excluded.updated_at
      `).run(monitor.id, selected.length, valid, passed, snapshot, JSON.stringify(state), timestamp);
      this.db.prepare(`DELETE FROM runs WHERE monitor_id = ? AND id IN (${selected.map(() => '?').join(',')})`)
        .run(monitor.id, ...selected.map((row) => row.id));
    })();
    this.invalidateSummary(monitor.user_id, monitor.group_id);
    return {
      archived: selected.length,
      artifactPaths: selected.map((row) => row.artifact_path).filter(Boolean),
      pending: eligible.length > batchSize
    };
  }

  isArtifactReferenced(filename) {
    return Boolean(this.db.prepare('SELECT 1 FROM runs WHERE artifact_path = ? LIMIT 1').get(String(filename)));
  }

  recordMaintenance(result, timestamp = nowMs()) {
    this.db.prepare(`UPDATE service_settings SET maintenance_last_run_at = ?, maintenance_last_result_json = ? WHERE id = 1`)
      .run(timestamp, JSON.stringify(result));
  }

  compactDatabase(timestamp = nowMs()) {
    if (this.db.prepare("SELECT 1 FROM runs WHERE status IN ('queued', 'running') LIMIT 1").get()) return false;
    const settings = this.getServiceSettings();
    this.db.pragma('wal_checkpoint(PASSIVE)');
    if (timestamp - Number(settings.maintenance_last_compact_at || 0) < 86400000) return false;
    const freePages = this.db.pragma('freelist_count', { simple: true });
    const pageSize = this.db.pragma('page_size', { simple: true });
    if (freePages * pageSize < 8 * 1024 * 1024) return false;
    if (this.db.pragma('auto_vacuum', { simple: true }) === 0) {
      this.db.pragma('auto_vacuum = INCREMENTAL');
      this.db.exec('VACUUM');
    } else {
      this.db.exec('PRAGMA incremental_vacuum(2048)');
    }
    this.db.prepare('UPDATE service_settings SET maintenance_last_compact_at = ? WHERE id = 1').run(timestamp);
    this.db.pragma('wal_checkpoint(TRUNCATE)');
    return true;
  }

  hasExpiredPayloads(monitorId, keep) {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM runs WHERE monitor_id = ? AND status NOT IN ('queued', 'running')
        AND (output_text IS NOT NULL OR artifact_path IS NOT NULL OR preview_token IS NOT NULL)
        AND id < (SELECT id FROM runs WHERE monitor_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)
      LIMIT 1
    `).get(Number(monitorId), Number(monitorId), Number(keep) - 1));
  }

  pruneRuns(monitorId, keep, limit = 200) {
    const stale = this.db.prepare(`
      SELECT id, artifact_path FROM runs
      WHERE monitor_id = ? AND status NOT IN ('queued', 'running')
        AND (output_text IS NOT NULL OR artifact_path IS NOT NULL OR preview_token IS NOT NULL)
        AND id < (SELECT id FROM runs WHERE monitor_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)
      ORDER BY id LIMIT ?
    `).all(Number(monitorId), Number(monitorId), Number(keep) - 1, Number(limit));
    if (stale.length === 0) return [];
    const monitor = this.getMonitorById(monitorId);
    if (monitor) this.invalidateSummary(monitor.user_id, monitor.group_id);
    const ids = stale.map((row) => row.id);
    const placeholders = ids.map(() => '?').join(',');
    this.db.prepare(`
      UPDATE runs SET output_text = NULL, artifact_path = NULL, artifact_name = NULL,
        artifact_mime = NULL, preview_token = NULL
      WHERE id IN (${placeholders})
    `).run(...ids);
    return stale.map((row) => row.artifact_path).filter(Boolean);
  }
}

module.exports = {
  Store,
  nowMs,
  publicRun,
  publicValidationResult,
  rowMonitorTest,
  rowTest,
  storedTestConfig,
  testSnapshot
};
