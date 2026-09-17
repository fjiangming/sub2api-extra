const crypto = require('crypto');
const { performance } = require('node:perf_hooks');
const { AppError } = require('../errors');
const { nowIso, parseJson, stringifyJson } = require('../db');
const { resolvePagination } = require('../pagination');
const { redactText } = require('../security/redaction');
const {
  DIRECT_PROBE_PLATFORMS,
  DirectKeyProbeTransport,
  Sub2ApiProbeCredentialExporter,
  clearCredentialMap
} = require('./direct-key-probe');

const COMPLEXITIES = new Set(['simple', 'medium', 'complex']);
const ACTIVE_ACCOUNT_STATUSES = new Set(['active', 'enabled', 'unknown', 'rate_limited']);
const UPSTREAM_ENABLED_STATUSES = new Set(['active', 'enabled']);
const UPSTREAM_DISABLED_STATUSES = new Set(['inactive', 'disabled']);
const TRAFFIC_SAMPLE_COUNT = 10;
const UNGROUPED_GROUP_ID = '__ungrouped__';
const DEFAULT_PROMPTS = Object.freeze({
  simple: Object.freeze([
    '请用一句话说明水在标准大气压下的沸点，只给出核心结论。',
    '计算 27 + 58，并只返回数字结果。',
    '将英文单词 reliability 翻译成中文，只返回译文。'
  ]),
  medium: Object.freeze([
    '一个接口连续 5 次响应耗时分别为 820、940、760、1100、880 毫秒。计算平均耗时，并用 JSON 返回 average_ms 和 sample_count。',
    '按优先级给出三条降低 API 请求延迟的可执行措施，每条不超过 20 个汉字。',
    '判断命题“所有 A 都是 B，且没有 B 是 C，因此没有 A 是 C”是否成立，并用两句话说明理由。'
  ]),
  complex: Object.freeze([
    '你正在评审一个上游 AI API：最近五次耗时为 1.2、2.8、1.9、4.6、2.1 秒，其中第四次返回 429 后重试成功。请计算平均耗时，识别主要风险，并给出三项按优先级排序的改进建议。用 JSON 返回 average_seconds、risk、actions。',
    '设计一个不超过五步的故障排查方案，用于区分 DNS、TLS、上游排队和模型生成导致的 API 延迟。每一步必须包含观测指标和判断条件。',
    '某服务有 A、B 两个上游：A 成功率 99.5%、平均 2.4 秒、成本 1.0；B 成功率 98.8%、平均 1.1 秒、成本 1.35。请提出带阈值的路由策略，同时说明何时切换和何时恢复。'
  ])
});
const ACCOUNT_LIMIT = 5000;

function finite(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integer(value, fallback = 0) {
  const number = finite(value);
  return number == null ? fallback : Math.trunc(number);
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function normalizePlatform(value) {
  const platform = String(value || '').trim().toLowerCase();
  return ({ chatgpt: 'openai', 'open-ai': 'openai', claude: 'anthropic', google: 'gemini' })[platform] || platform || 'unknown';
}

function normalizePrompts(input, fallback = DEFAULT_PROMPTS) {
  const source = input && typeof input === 'object' ? input : {};
  return Object.fromEntries([...COMPLEXITIES].map((complexity) => {
    const raw = Array.isArray(source[complexity]) ? source[complexity] : fallback[complexity];
    const prompts = raw
      .map((prompt) => String(prompt || '').trim().slice(0, 4000))
      .filter(Boolean)
      .slice(0, 5);
    if (prompts.length === 0) {
      throw new AppError('VALIDATION_ERROR', `测试输入 ${complexity} 至少需要一条非空对话`, {
        status: 400
      });
    }
    return [complexity, prompts];
  }));
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

function probeHealth({ succeededCount, failedCount, averageMs, warningMs, criticalMs }) {
  if (succeededCount === 0 || averageMs == null || averageMs >= criticalMs) return 'critical';
  if (failedCount > 0 || averageMs >= warningMs) return 'warning';
  return 'healthy';
}

function accountIsActive(row) {
  return ACTIVE_ACCOUNT_STATUSES.has(String(row.status || '').toLowerCase());
}

function upstreamIsEnabled(row) {
  return UPSTREAM_ENABLED_STATUSES.has(String(row.status || row.accountStatus || '').toLowerCase());
}

function upstreamIsDisabled(row) {
  return UPSTREAM_DISABLED_STATUSES.has(String(row.status || row.accountStatus || '').toLowerCase());
}

function accountGroups(row) {
  const metadata = parseJson(row?.metadata_json, {});
  const groups = new Map();
  const add = (value) => {
    const rawId = value && typeof value === 'object'
      ? value.id ?? value.group_id ?? value.groupId
      : value;
    if (rawId == null || String(rawId).trim() === '') return;
    const id = String(rawId).trim();
    const existing = groups.get(id);
    const name = value && typeof value === 'object'
      ? String(value.name || value.display_name || `分组 #${id}`).trim().slice(0, 240)
      : `分组 #${id}`;
    groups.set(id, {
      id,
      name: existing && !existing.name.startsWith('分组 #') ? existing.name : name,
      platform: value && typeof value === 'object' && value.platform != null
        ? normalizePlatform(value.platform)
        : existing?.platform || null,
      status: value && typeof value === 'object' && value.status != null
        ? String(value.status).trim().toLowerCase()
        : existing?.status || 'unknown'
    });
  };
  for (const value of Array.isArray(metadata.groupIds) ? metadata.groupIds : []) add(value);
  for (const value of Array.isArray(metadata.groups) ? metadata.groups : []) add(value);
  return [...groups.values()];
}

function average(values) {
  return values.length
    ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
    : null;
}

class KeyProbeService {
  constructor({ db, config, sub2api, http, credentialExporter, directProbe }) {
    this.db = db;
    this.config = config;
    this.sub2api = sub2api;
    this.credentialExporter = credentialExporter || new Sub2ApiProbeCredentialExporter({ sub2api });
    this.directProbe = directProbe || new DirectKeyProbeTransport({ http, config });
  }

  settings() {
    const row = this.db.prepare('SELECT * FROM sub2api_key_probe_settings WHERE id = 1').get();
    const storedPrompts = parseJson(row.prompts_json, {});
    return {
      enabled: Boolean(row.enabled),
      autoControlEnabled: Boolean(row.auto_control_enabled),
      autoDisableThresholdMs: row.auto_disable_threshold_ms,
      autoEnableThresholdMs: row.auto_enable_threshold_ms,
      recoveryIntervalMinutes: row.recovery_interval_minutes,
      trafficSampleCount: TRAFFIC_SAMPLE_COUNT,
      defaultIntervalMinutes: row.default_interval_minutes,
      sampleCount: row.sample_count,
      complexity: COMPLEXITIES.has(row.complexity) ? row.complexity : 'medium',
      timeoutSeconds: row.timeout_seconds,
      warningThresholdMs: row.warning_threshold_ms,
      criticalThresholdMs: row.critical_threshold_ms,
      staleAfterMinutes: row.stale_after_minutes,
      concurrency: row.concurrency,
      scheduledBatchSize: row.scheduled_batch_size,
      retentionDays: row.retention_days,
      models: parseJson(row.models_json, {}),
      prompts: normalizePrompts(storedPrompts, DEFAULT_PROMPTS),
      updatedAt: row.updated_at
    };
  }

  saveSettings(input = {}) {
    const current = this.settings();
    const next = {
      ...current,
      ...input,
      models: Object.fromEntries(Object.entries(input.models ?? current.models)
        .map(([platform, model]) => [normalizePlatform(platform), String(model || '').trim().slice(0, 200)])
        .filter(([, model]) => model)),
      prompts: normalizePrompts(input.prompts ?? current.prompts, current.prompts)
    };
    if (!COMPLEXITIES.has(next.complexity)) {
      throw new AppError('VALIDATION_ERROR', '测试复杂度必须为 simple、medium 或 complex', { status: 400 });
    }
    if (integer(next.criticalThresholdMs) <= integer(next.warningThresholdMs)) {
      throw new AppError('VALIDATION_ERROR', '红色阈值必须大于黄色阈值', { status: 400 });
    }
    if (integer(next.autoEnableThresholdMs) >= integer(next.autoDisableThresholdMs)) {
      throw new AppError('VALIDATION_ERROR', '自动启用阈值必须小于自动停用阈值，以避免 Key 反复切换', {
        status: 400
      });
    }
    const updatedAt = nowIso();
    this.db.prepare(`
      UPDATE sub2api_key_probe_settings SET
        enabled = ?, auto_control_enabled = ?, auto_disable_threshold_ms = ?,
        auto_enable_threshold_ms = ?, recovery_interval_minutes = ?,
        default_interval_minutes = ?, sample_count = ?, complexity = ?,
        timeout_seconds = ?, warning_threshold_ms = ?, critical_threshold_ms = ?,
        stale_after_minutes = ?, concurrency = ?, scheduled_batch_size = ?,
        retention_days = ?, models_json = ?, prompts_json = ?, updated_at = ?
      WHERE id = 1
    `).run(
      next.enabled ? 1 : 0,
      next.autoControlEnabled ? 1 : 0,
      clamp(integer(next.autoDisableThresholdMs, 8000), 100, 600000),
      clamp(integer(next.autoEnableThresholdMs, 3000), 50, 300000),
      clamp(integer(next.recoveryIntervalMinutes, 30), 1, 10080),
      clamp(integer(next.defaultIntervalMinutes, 360), 1, 10080),
      clamp(integer(next.sampleCount, 3), 1, 5),
      next.complexity,
      clamp(integer(next.timeoutSeconds, 120), 5, 300),
      clamp(integer(next.warningThresholdMs, 5000), 100, 300000),
      clamp(integer(next.criticalThresholdMs, 15000), 200, 600000),
      clamp(integer(next.staleAfterMinutes, 1440), 5, 43200),
      clamp(integer(next.concurrency, 3), 1, 10),
      clamp(integer(next.scheduledBatchSize, 100), 1, 500),
      clamp(integer(next.retentionDays, 30), 1, 3650),
      stringifyJson(next.models),
      stringifyJson(next.prompts),
      updatedAt
    );
    return this.settings();
  }

  #accountConfigRow(accountId) {
    return this.db.prepare(`
      SELECT * FROM sub2api_key_probe_configs WHERE account_id = ?
    `).get(String(accountId)) || null;
  }

  #accountRow(accountId) {
    const row = this.db.prepare(`
      SELECT * FROM sub2api_monitored_accounts
      WHERE account_id = ? AND missing_since IS NULL
    `).get(String(accountId));
    if (!row) throw new AppError('NOT_FOUND', 'Sub2API Key 不存在或已从基座移除', { status: 404 });
    return row;
  }

  #effectiveConfig(account, configRow = null, settings = this.settings()) {
    return {
      enabled: configRow ? Boolean(configRow.enabled) : true,
      intervalMinutes: configRow?.interval_minutes ?? settings.defaultIntervalMinutes,
      model: configRow?.model || settings.models[normalizePlatform(account.platform)] || '',
      complexity: configRow?.complexity || settings.complexity,
      sampleCount: configRow?.sample_count ?? settings.sampleCount,
      timeoutSeconds: configRow?.timeout_seconds ?? settings.timeoutSeconds,
      warningThresholdMs: configRow?.warning_threshold_ms ?? settings.warningThresholdMs,
      criticalThresholdMs: configRow?.critical_threshold_ms ?? settings.criticalThresholdMs,
      recoveryIntervalMinutes: configRow?.interval_minutes ?? settings.recoveryIntervalMinutes,
      nextProbeAt: configRow?.next_probe_at || null,
      lastProbeAt: configRow?.last_probe_at || null,
      nextRecoveryProbeAt: configRow?.next_recovery_probe_at || null,
      lastRecoveryProbeAt: configRow?.last_recovery_probe_at || null,
      overrides: {
        intervalMinutes: configRow?.interval_minutes ?? null,
        model: configRow?.model || null,
        complexity: configRow?.complexity || null,
        sampleCount: configRow?.sample_count ?? null,
        timeoutSeconds: configRow?.timeout_seconds ?? null,
        warningThresholdMs: configRow?.warning_threshold_ms ?? null,
        criticalThresholdMs: configRow?.critical_threshold_ms ?? null
      },
      hasOverrides: Boolean(configRow && [
        configRow.interval_minutes, configRow.model, configRow.complexity,
        configRow.sample_count, configRow.timeout_seconds,
        configRow.warning_threshold_ms, configRow.critical_threshold_ms
      ].some((value) => value != null && value !== ''))
    };
  }

  async #prepareDirectProbeContext(rows, settings) {
    const eligible = rows.filter((account) => {
      const platform = normalizePlatform(account.platform);
      const accountType = String(account.account_type || '').trim().toLowerCase();
      const model = this.#effectiveConfig(account, this.#accountConfigRow(account.account_id), settings).model;
      return accountType === 'apikey' && DIRECT_PROBE_PLATFORMS.has(platform) && Boolean(model);
    });
    if (eligible.length === 0) return { credentials: new Map(), exportError: null };
    try {
      return {
        credentials: await this.credentialExporter.export(eligible),
        exportError: null
      };
    } catch (error) {
      return {
        credentials: new Map(),
        exportError: error
      };
    }
  }

  #disposeDirectProbeContext(context) {
    clearCredentialMap(context?.credentials);
  }

  saveAccountConfig(accountId, input = {}) {
    const account = this.#accountRow(accountId);
    const current = this.#accountConfigRow(accountId);
    const value = (name) => Object.prototype.hasOwnProperty.call(input, name)
      ? input[name]
      : current?.[({
          intervalMinutes: 'interval_minutes', sampleCount: 'sample_count',
          timeoutSeconds: 'timeout_seconds', warningThresholdMs: 'warning_threshold_ms',
          criticalThresholdMs: 'critical_threshold_ms'
        })[name] || name] ?? null;
    const enabled = Object.prototype.hasOwnProperty.call(input, 'enabled')
      ? Boolean(input.enabled)
      : current ? Boolean(current.enabled) : true;
    const complexity = value('complexity');
    const warning = value('warningThresholdMs');
    const critical = value('criticalThresholdMs');
    if (complexity != null && !COMPLEXITIES.has(complexity)) {
      throw new AppError('VALIDATION_ERROR', 'Key 复杂度覆盖值无效', { status: 400 });
    }
    const settings = this.settings();
    const effectiveWarning = warning ?? settings.warningThresholdMs;
    const effectiveCritical = critical ?? settings.criticalThresholdMs;
    if (Number(effectiveCritical) <= Number(effectiveWarning)) {
      throw new AppError('VALIDATION_ERROR', 'Key 红色阈值必须大于黄色阈值', { status: 400 });
    }
    const updatedAt = nowIso();
    this.db.prepare(`
      INSERT INTO sub2api_key_probe_configs(
        account_id, enabled, interval_minutes, model, complexity, sample_count,
        timeout_seconds, warning_threshold_ms, critical_threshold_ms,
        next_probe_at, last_probe_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        enabled = excluded.enabled, interval_minutes = excluded.interval_minutes,
        model = excluded.model, complexity = excluded.complexity,
        sample_count = excluded.sample_count, timeout_seconds = excluded.timeout_seconds,
        warning_threshold_ms = excluded.warning_threshold_ms,
        critical_threshold_ms = excluded.critical_threshold_ms,
        next_probe_at = excluded.next_probe_at, updated_at = excluded.updated_at
    `).run(
      String(accountId), enabled ? 1 : 0,
      value('intervalMinutes'),
      value('model') == null ? null : String(value('model')).trim().slice(0, 200) || null,
      complexity,
      value('sampleCount'), value('timeoutSeconds'), warning, critical,
      enabled ? (current?.next_probe_at || nowIso()) : null,
      current?.last_probe_at || null,
      updatedAt
    );
    return {
      accountId: String(accountId),
      accountName: account.name,
      platform: normalizePlatform(account.platform),
      config: this.#effectiveConfig(account, this.#accountConfigRow(accountId))
    };
  }

  saveBulkConfig(accountIds, input = {}) {
    const ids = [...new Set((accountIds || []).map(String).filter(Boolean))];
    if (ids.length === 0) {
      throw new AppError('VALIDATION_ERROR', '请至少选择一个 Key', { status: 400 });
    }
    const transaction = this.db.transaction(() => ids.map((accountId) => this.saveAccountConfig(accountId, input)));
    return { count: ids.length, items: transaction() };
  }

  #latestBatchRows() {
    return this.db.prepare(`
      SELECT b.* FROM sub2api_key_probe_batches b
      JOIN (
        SELECT account_id, MAX(completed_at) AS completed_at
        FROM sub2api_key_probe_batches GROUP BY account_id
      ) latest ON latest.account_id = b.account_id AND latest.completed_at = b.completed_at
      WHERE b.id = (
        SELECT id FROM sub2api_key_probe_batches same
        WHERE same.account_id = b.account_id AND same.completed_at = b.completed_at
        ORDER BY same.id DESC LIMIT 1
      )
    `).all();
  }

  #trafficMetricRows() {
    return this.db.prepare(`
      WITH last_action AS (
        SELECT account_id, MAX(completed_at) AS changed_at
        FROM sub2api_key_probe_actions
        WHERE status IN ('succeeded', 'skipped') AND completed_at IS NOT NULL
        GROUP BY account_id
      ), ranked AS (
        SELECT sample.account_id, sample.first_token_ms, sample.created_at,
          ROW_NUMBER() OVER (
            PARTITION BY sample.account_id
            ORDER BY sample.created_at DESC, sample.source_log_id DESC
          ) AS row_number
        FROM sub2api_account_request_samples sample
        LEFT JOIN last_action ON last_action.account_id = sample.account_id
        WHERE sample.stream = 1 AND sample.first_token_ms > 0
          AND (last_action.changed_at IS NULL OR sample.created_at > last_action.changed_at)
      )
      SELECT account_id, COUNT(*) AS sample_count,
        ROUND(AVG(first_token_ms)) AS avg_first_token_ms,
        MIN(first_token_ms) AS min_first_token_ms,
        MAX(first_token_ms) AS max_first_token_ms,
        MAX(created_at) AS last_request_at
      FROM ranked WHERE row_number <= ${TRAFFIC_SAMPLE_COUNT}
      GROUP BY account_id
    `).all();
  }

  #latestActionRows() {
    return this.db.prepare(`
      SELECT action.* FROM sub2api_key_probe_actions action
      WHERE action.id = (
        SELECT latest.id FROM sub2api_key_probe_actions latest
        WHERE latest.account_id = action.account_id
        ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1
      )
    `).all();
  }

  #serializeAction(row) {
    if (!row) return null;
    return {
      id: row.id,
      accountId: String(row.account_id),
      action: row.action,
      reason: row.reason,
      status: row.status,
      measuredFirstTokenMs: row.measured_first_token_ms,
      thresholdMs: row.threshold_ms,
      sampleCount: row.sample_count,
      groupIds: parseJson(row.group_ids_json, []),
      beforeStatus: row.before_status,
      afterStatus: row.after_status,
      probeBatchId: row.probe_batch_id,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      createdAt: row.created_at,
      completedAt: row.completed_at
    };
  }

  #groupDefinitions(items) {
    const groups = new Map();
    for (const item of items) {
      for (const group of item.groups) {
        const current = groups.get(group.id) || {
          ...group,
          accountCount: 0,
          enabledCount: 0,
          disabledCount: 0
        };
        current.accountCount += 1;
        if (upstreamIsEnabled(item)) current.enabledCount += 1;
        else if (upstreamIsDisabled(item)) current.disabledCount += 1;
        if (current.name.startsWith('分组 #') && !group.name.startsWith('分组 #')) {
          current.name = group.name;
        }
        if (!current.platform && group.platform) current.platform = group.platform;
        if (current.status === 'unknown' && group.status !== 'unknown') current.status = group.status;
        groups.set(group.id, current);
      }
    }
    return [...groups.values()].sort((left, right) => {
      if (left.id === UNGROUPED_GROUP_ID) return 1;
      if (right.id === UNGROUPED_GROUP_ID) return -1;
      return left.name.localeCompare(right.name, 'zh-CN');
    });
  }

  #healthFor(batch, effective, settings, at = Date.now()) {
    if (!effective.enabled) return 'disabled';
    if (!batch) return 'unknown';
    const completed = Date.parse(batch.completed_at || 0);
    const staleMinutes = Math.max(settings.staleAfterMinutes, effective.intervalMinutes * 2);
    if (!Number.isFinite(completed) || at - completed > staleMinutes * 60000) return 'stale';
    return batch.status;
  }

  list(filters = {}) {
    const settings = this.settings();
    const accounts = this.db.prepare(`
      SELECT a.*, c.enabled AS probe_enabled, c.interval_minutes, c.model AS probe_model,
        c.complexity AS probe_complexity, c.sample_count AS probe_sample_count,
        c.timeout_seconds AS probe_timeout_seconds,
        c.warning_threshold_ms AS probe_warning_threshold_ms,
        c.critical_threshold_ms AS probe_critical_threshold_ms,
        c.next_probe_at, c.last_probe_at, c.next_recovery_probe_at,
        c.last_recovery_probe_at, c.last_shortage_signature,
        c.updated_at AS probe_config_updated_at
      FROM sub2api_monitored_accounts a
      LEFT JOIN sub2api_key_probe_configs c ON c.account_id = a.account_id
      WHERE a.missing_since IS NULL
      ORDER BY a.platform, a.name, a.account_id
      LIMIT ${ACCOUNT_LIMIT}
    `).all();
    const latest = new Map(this.#latestBatchRows().map((row) => [String(row.account_id), row]));
    const traffic = new Map(this.#trafficMetricRows().map((row) => [String(row.account_id), row]));
    const latestActions = new Map(this.#latestActionRows().map((row) => [String(row.account_id), row]));
    const at = Date.now();
    let items = accounts.map((row) => {
      const configRow = row.probe_config_updated_at == null ? null : {
        enabled: row.probe_enabled,
        interval_minutes: row.interval_minutes,
        model: row.probe_model,
        complexity: row.probe_complexity,
        sample_count: row.probe_sample_count,
        timeout_seconds: row.probe_timeout_seconds,
        warning_threshold_ms: row.probe_warning_threshold_ms,
        critical_threshold_ms: row.probe_critical_threshold_ms,
        next_probe_at: row.next_probe_at,
        last_probe_at: row.last_probe_at,
        next_recovery_probe_at: row.next_recovery_probe_at,
        last_recovery_probe_at: row.last_recovery_probe_at,
        last_shortage_signature: row.last_shortage_signature
      };
      const effective = this.#effectiveConfig(row, configRow, settings);
      const batch = latest.get(String(row.account_id)) || null;
      const trafficRow = traffic.get(String(row.account_id)) || null;
      const groups = accountGroups(row);
      return {
        accountId: String(row.account_id),
        name: row.name,
        platform: normalizePlatform(row.platform),
        accountType: row.account_type,
        accountStatus: row.status,
        schedulable: Boolean(row.schedulable),
        groups: groups.length ? groups : [{
          id: UNGROUPED_GROUP_ID,
          name: '未分组',
          platform: null,
          status: 'unknown'
        }],
        health: this.#healthFor(batch, effective, settings, at),
        config: effective,
        latest: batch ? this.#serializeBatch(batch, false) : null,
        traffic: {
          sampleCount: trafficRow?.sample_count || 0,
          requiredSampleCount: TRAFFIC_SAMPLE_COUNT,
          ready: Number(trafficRow?.sample_count || 0) >= TRAFFIC_SAMPLE_COUNT,
          avgFirstTokenMs: trafficRow?.avg_first_token_ms ?? null,
          minFirstTokenMs: trafficRow?.min_first_token_ms ?? null,
          maxFirstTokenMs: trafficRow?.max_first_token_ms ?? null,
          lastRequestAt: trafficRow?.last_request_at || null,
          exceedsDisableThreshold: Number(trafficRow?.sample_count || 0) >= TRAFFIC_SAMPLE_COUNT &&
            Number(trafficRow?.avg_first_token_ms) > settings.autoDisableThresholdMs
        },
        latestAction: this.#serializeAction(latestActions.get(String(row.account_id)))
      };
    });
    const allItems = items;
    const groups = this.#groupDefinitions(allItems);
    if (filters.groupId) {
      items = items.filter((item) => item.groups.some((group) => group.id === String(filters.groupId)));
    }
    const platform = normalizePlatform(filters.platform || '');
    if (filters.platform) items = items.filter((item) => item.platform === platform);
    if (filters.health) items = items.filter((item) => item.health === String(filters.health));
    if (filters.accountStatus) items = items.filter((item) => item.accountStatus === String(filters.accountStatus));
    if (filters.enabled === 'true' || filters.enabled === true) items = items.filter((item) => item.config.enabled);
    if (filters.enabled === 'false' || filters.enabled === false) items = items.filter((item) => !item.config.enabled);
    const search = String(filters.search || '').trim().toLowerCase();
    if (search) {
      items = items.filter((item) => [
        item.accountId, item.name, item.platform, item.accountType,
        ...item.groups.flatMap((group) => [group.id, group.name])
      ]
        .some((value) => String(value || '').toLowerCase().includes(search)));
    }
    const direction = filters.order === 'asc' ? 1 : -1;
    const sortBy = ['name', 'platform', 'avgDurationMs', 'trafficFirstTokenMs', 'completedAt', 'health'].includes(filters.sortBy)
      ? filters.sortBy
      : 'completedAt';
    const healthRank = { critical: 5, warning: 4, stale: 3, unknown: 2, disabled: 1, healthy: 0 };
    items.sort((left, right) => {
      let a;
      let b;
      if (sortBy === 'name') [a, b] = [left.name, right.name];
      else if (sortBy === 'platform') [a, b] = [left.platform, right.platform];
      else if (sortBy === 'avgDurationMs') [a, b] = [left.latest?.avgDurationMs ?? -1, right.latest?.avgDurationMs ?? -1];
      else if (sortBy === 'trafficFirstTokenMs') [a, b] = [left.traffic.avgFirstTokenMs ?? -1, right.traffic.avgFirstTokenMs ?? -1];
      else if (sortBy === 'health') [a, b] = [healthRank[left.health] ?? 0, healthRank[right.health] ?? 0];
      else [a, b] = [Date.parse(left.latest?.completedAt || 0) || 0, Date.parse(right.latest?.completedAt || 0) || 0];
      if (typeof a === 'string') return a.localeCompare(b, 'zh-CN') * direction;
      return (a - b) * direction;
    });
    const resolved = resolvePagination({
      page: filters.page,
      pageSize: filters.pageSize,
      total: items.length,
      defaultPageSize: 50,
      maxPageSize: 200
    });
    const counts = allItems.reduce((result, item) => {
      result[item.health] = (result[item.health] || 0) + 1;
      return result;
    }, { healthy: 0, warning: 0, critical: 0, stale: 0, unknown: 0, disabled: 0 });
    return {
      settings,
      summary: {
        total: allItems.length,
        enabled: allItems.filter((item) => item.config.enabled).length,
        upstreamEnabled: allItems.filter(upstreamIsEnabled).length,
        upstreamDisabled: allItems.filter(upstreamIsDisabled).length,
        trafficReady: allItems.filter((item) => item.traffic.ready).length,
        counts,
        lastCompletedAt: allItems.map((item) => item.latest?.completedAt).filter(Boolean)
          .sort((left, right) => Date.parse(right) - Date.parse(left))[0] || null
      },
      platforms: [...new Set(allItems.map((item) => item.platform))].sort(),
      groups,
      items: items.slice(resolved.offset, resolved.offset + resolved.limit),
      pagination: resolved.pagination
    };
  }

  #serializeBatch(row, includeDetails = true) {
    const batch = {
      id: row.id,
      runId: row.run_id,
      accountId: String(row.account_id),
      triggerType: row.trigger_type,
      model: row.model,
      complexity: row.complexity,
      sampleCount: row.sample_count,
      succeededCount: row.succeeded_count,
      failedCount: row.failed_count,
      status: row.status,
      avgDurationMs: row.avg_duration_ms,
      minDurationMs: row.min_duration_ms,
      maxDurationMs: row.max_duration_ms,
      p95DurationMs: row.p95_duration_ms,
      avgFirstTokenMs: row.avg_first_token_ms,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      startedAt: row.started_at,
      completedAt: row.completed_at
    };
    if (includeDetails) {
      batch.prompts = parseJson(row.prompts_json, []);
      batch.details = parseJson(row.details_json, {});
    }
    return batch;
  }

  history(filters = {}) {
    const clauses = [];
    const params = [];
    if (filters.accountId != null) {
      clauses.push('b.account_id = ?');
      params.push(String(filters.accountId));
    }
    if (filters.runId) {
      clauses.push('b.run_id = ?');
      params.push(String(filters.runId));
    }
    const limit = clamp(integer(filters.limit, 50), 1, 200);
    const rows = this.db.prepare(`
      SELECT b.*, a.name AS account_name, a.platform
      FROM sub2api_key_probe_batches b
      JOIN sub2api_monitored_accounts a ON a.account_id = b.account_id
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY b.completed_at DESC, b.id DESC LIMIT ?
    `).all(...params, limit);
    const samplesStatement = this.db.prepare(`
      SELECT * FROM sub2api_key_probe_samples WHERE batch_id = ? ORDER BY sample_index
    `);
    const actionRows = filters.accountId == null
      ? []
      : this.db.prepare(`
          SELECT * FROM sub2api_key_probe_actions
          WHERE account_id = ?
          ORDER BY created_at DESC, id DESC LIMIT ?
        `).all(String(filters.accountId), limit);
    return {
      items: rows.map((row) => ({
        ...this.#serializeBatch(row),
        accountName: row.account_name,
        platform: normalizePlatform(row.platform),
        samples: samplesStatement.all(row.id).map((sample) => ({
          id: sample.id,
          index: sample.sample_index,
          prompt: sample.prompt,
          status: sample.status,
          durationMs: sample.duration_ms,
          firstTokenMs: sample.first_token_ms,
          responseExcerpt: sample.response_excerpt,
          errorCode: sample.error_code,
          errorMessage: sample.error_message,
          startedAt: sample.started_at,
          completedAt: sample.completed_at
        }))
      })),
      actions: actionRows.map((row) => this.#serializeAction(row))
    };
  }

  #managedAccountRows() {
    return this.db.prepare(`
      SELECT a.*, c.enabled AS probe_enabled, c.interval_minutes,
        c.next_recovery_probe_at, c.last_recovery_probe_at,
        c.last_shortage_signature, c.updated_at AS probe_config_updated_at
      FROM sub2api_monitored_accounts a
      LEFT JOIN sub2api_key_probe_configs c ON c.account_id = a.account_id
      WHERE a.missing_since IS NULL
      ORDER BY a.platform, a.name, a.account_id
      LIMIT ${ACCOUNT_LIMIT}
    `).all();
  }

  #shortageState(account, enabledByGroup) {
    const lowGroups = accountGroups(account)
      .map((group) => ({
        id: group.id,
        name: group.name,
        enabledAccountIds: [...(enabledByGroup.get(group.id) || [])].sort()
      }))
      .filter((group) => group.enabledAccountIds.length <= 1)
      .sort((left, right) => left.id.localeCompare(right.id));
    if (lowGroups.length === 0) return { groups: [], signature: null };
    return {
      groups: lowGroups,
      signature: crypto.createHash('sha256').update(JSON.stringify(lowGroups)).digest('hex')
    };
  }

  async #mapConcurrent(items, concurrency, operation) {
    const results = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(items.length, concurrency) }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await operation(items[index], index);
      }
    });
    await Promise.all(workers);
    return results;
  }

  async #changeUpstreamStatus(account, desiredStatus, context) {
    const id = crypto.randomUUID();
    const createdAt = nowIso();
    const accountId = String(account.account_id);
    const beforeStatus = String(account.status || 'unknown').toLowerCase();
    this.db.prepare(`
      INSERT INTO sub2api_key_probe_actions(
        id, account_id, action, reason, status, measured_first_token_ms,
        threshold_ms, sample_count, group_ids_json, before_status,
        probe_batch_id, created_at
      ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, accountId, context.action, context.reason,
      context.measuredFirstTokenMs ?? null, context.thresholdMs ?? null,
      context.sampleCount || 0, stringifyJson(context.groupIds || [], []),
      beforeStatus, context.probeBatchId || null, createdAt
    );
    try {
      const currentPayload = await this.sub2api.data(
        `/api/v1/admin/accounts/${encodeURIComponent(accountId)}`
      );
      const current = currentPayload?.account ?? currentPayload ?? {};
      const remoteStatus = String(current.status || beforeStatus).toLowerCase();
      let afterStatus = remoteStatus;
      let actionStatus = 'skipped';
      if (remoteStatus !== desiredStatus) {
        const updatedPayload = await this.sub2api.data(
          `/api/v1/admin/accounts/${encodeURIComponent(accountId)}`,
          { method: 'PUT', body: { status: desiredStatus } }
        );
        const updated = updatedPayload?.account ?? updatedPayload ?? {};
        afterStatus = String(updated.status || desiredStatus).toLowerCase();
        if (afterStatus !== desiredStatus) {
          throw new AppError(
            'SUB2API_ACCOUNT_STATUS_UPDATE_FAILED',
            `Sub2API 未将 Key 状态更新为 ${desiredStatus}`,
            { status: 502 }
          );
        }
        actionStatus = 'succeeded';
      }
      const completedAt = nowIso();
      this.db.transaction(() => {
        this.db.prepare(`
          UPDATE sub2api_monitored_accounts SET status = ?, last_seen_at = ?
          WHERE account_id = ?
        `).run(afterStatus, completedAt, accountId);
        this.db.prepare(`
          UPDATE sub2api_key_probe_actions SET status = ?, after_status = ?,
            completed_at = ? WHERE id = ?
        `).run(actionStatus, afterStatus, completedAt, id);
      })();
      account.status = afterStatus;
      return {
        id,
        accountId,
        status: actionStatus,
        beforeStatus: remoteStatus,
        afterStatus,
        changed: actionStatus === 'succeeded'
      };
    } catch (error) {
      const completedAt = nowIso();
      const errorCode = String(error?.code || 'KEY_PROBE_AUTOMATION_FAILED').slice(0, 120);
      const errorMessage = redactText(error?.message || error).slice(0, 1000);
      this.db.prepare(`
        UPDATE sub2api_key_probe_actions SET status = 'failed', error_code = ?,
          error_message = ?, completed_at = ? WHERE id = ?
      `).run(errorCode, errorMessage, completedAt, id);
      return {
        id,
        accountId,
        status: 'failed',
        beforeStatus,
        afterStatus: beforeStatus,
        changed: false,
        errorCode,
        errorMessage
      };
    }
  }

  async reconcileAutomation(options = {}) {
    const settings = this.settings();
    const runId = crypto.randomUUID();
    const summary = {
      runId,
      enabled: settings.autoControlEnabled,
      trafficSampleCount: TRAFFIC_SAMPLE_COUNT,
      disableCandidates: 0,
      disabled: 0,
      disableFailed: 0,
      recoveryCandidates: 0,
      recoveryProbed: 0,
      reenabled: 0,
      enableFailed: 0,
      actions: [],
      probes: []
    };
    if (!settings.autoControlEnabled) return summary;

    const at = Number.isFinite(options.at) ? options.at : Date.now();
    const atIso = new Date(at).toISOString();
    const allRows = this.#managedAccountRows();
    const rows = allRows.filter((row) =>
      row.probe_config_updated_at == null || Boolean(row.probe_enabled));
    const traffic = new Map(this.#trafficMetricRows().map((row) => [String(row.account_id), row]));
    const disableCandidates = rows.filter((row) => {
      const metric = traffic.get(String(row.account_id));
      return upstreamIsEnabled(row) && Number(metric?.sample_count || 0) >= TRAFFIC_SAMPLE_COUNT &&
        Number(metric?.avg_first_token_ms) > settings.autoDisableThresholdMs;
    }).slice(0, settings.scheduledBatchSize);
    summary.disableCandidates = disableCandidates.length;

    const disableResults = await this.#mapConcurrent(
      disableCandidates,
      settings.concurrency,
      (account) => {
        const metric = traffic.get(String(account.account_id));
        return this.#changeUpstreamStatus(account, 'inactive', {
          action: 'auto_disable',
          reason: 'traffic_ttft_exceeded',
          measuredFirstTokenMs: metric.avg_first_token_ms,
          thresholdMs: settings.autoDisableThresholdMs,
          sampleCount: metric.sample_count,
          groupIds: accountGroups(account).map((group) => group.id)
        });
      }
    );
    summary.actions.push(...disableResults);
    summary.disabled = disableResults.filter((result) => result.status === 'succeeded').length;
    summary.disableFailed = disableResults.filter((result) => result.status === 'failed').length;
    const disabledThisRun = new Set(disableResults
      .filter((result) => UPSTREAM_DISABLED_STATUSES.has(result.afterStatus))
      .map((result) => result.accountId));

    const enabledByGroup = new Map();
    for (const account of allRows.filter(upstreamIsEnabled)) {
      for (const group of accountGroups(account)) {
        const ids = enabledByGroup.get(group.id) || new Set();
        ids.add(String(account.account_id));
        enabledByGroup.set(group.id, ids);
      }
    }

    const clearShortage = this.db.prepare(`
      UPDATE sub2api_key_probe_configs SET last_shortage_signature = NULL,
        updated_at = ? WHERE account_id = ? AND last_shortage_signature IS NOT NULL
    `);
    const recoveryCandidates = [];
    for (const account of rows) {
      if (!upstreamIsDisabled(account) || disabledThisRun.has(String(account.account_id))) continue;
      const shortage = this.#shortageState(account, enabledByGroup);
      const configRow = this.#accountConfigRow(account.account_id);
      if (!shortage.signature && configRow?.last_shortage_signature) {
        clearShortage.run(atIso, String(account.account_id));
      }
      const nextAt = Date.parse(configRow?.next_recovery_probe_at || 0);
      const intervalDue = !Number.isFinite(nextAt) || nextAt <= at;
      const shortageChanged = Boolean(shortage.signature) &&
        shortage.signature !== configRow?.last_shortage_signature;
      if (!intervalDue && !shortageChanged) continue;
      recoveryCandidates.push({
        account,
        shortage,
        reason: shortageChanged ? 'group_capacity_low' : 'recovery_interval_due',
        priority: shortageChanged ? 1 : 0,
        nextAt: Number.isFinite(nextAt) ? nextAt : 0
      });
    }
    recoveryCandidates.sort((left, right) =>
      right.priority - left.priority || left.nextAt - right.nextAt ||
      left.account.name.localeCompare(right.account.name, 'zh-CN'));
    const selectedRecoveries = recoveryCandidates.slice(0, settings.scheduledBatchSize);
    summary.recoveryCandidates = recoveryCandidates.length;

    const directContext = await this.#prepareDirectProbeContext(
      selectedRecoveries.map((candidate) => candidate.account),
      settings
    );
    let recoveryResults;
    try {
      recoveryResults = await this.#mapConcurrent(
        selectedRecoveries,
        settings.concurrency,
        async (candidate) => {
          const probe = await this.#probeAccount(candidate.account, {
            runId,
            triggerType: 'recovery',
            settings,
            directContext,
            recoverySignature: candidate.shortage.signature,
            recoveryReason: candidate.reason
          });
          const completeVerifiedCoverage = probe.succeededCount === probe.sampleCount &&
            probe.failedCount === 0 && probe.firstTokenSampleCount === probe.sampleCount &&
            probe.directSampleCount === probe.sampleCount &&
            probe.verifiedSampleCount === probe.sampleCount;
          let action = null;
          if (completeVerifiedCoverage && probe.avgFirstTokenMs < settings.autoEnableThresholdMs) {
            action = await this.#changeUpstreamStatus(candidate.account, 'active', {
              action: 'auto_enable',
              reason: 'recovery_probe_passed',
              measuredFirstTokenMs: probe.avgFirstTokenMs,
              thresholdMs: settings.autoEnableThresholdMs,
              sampleCount: probe.firstTokenSampleCount,
              groupIds: accountGroups(candidate.account).map((group) => group.id),
              probeBatchId: probe.id
            });
          }
          return { candidate, probe, action };
        }
      );
    } finally {
      this.#disposeDirectProbeContext(directContext);
    }
    summary.recoveryProbed = recoveryResults.length;
    summary.probes.push(...recoveryResults.map((result) => result.probe));
    const enableActions = recoveryResults.map((result) => result.action).filter(Boolean);
    summary.actions.push(...enableActions);
    summary.reenabled = enableActions.filter((result) => result.status === 'succeeded').length;
    summary.enableFailed = enableActions.filter((result) => result.status === 'failed').length;
    return summary;
  }

  dueAccountIds(at = Date.now()) {
    const settings = this.settings();
    if (!settings.enabled) return [];
    const rows = this.db.prepare(`
      SELECT a.account_id
      FROM sub2api_monitored_accounts a
      LEFT JOIN sub2api_key_probe_configs c ON c.account_id = a.account_id
      WHERE a.missing_since IS NULL
        AND a.status NOT IN ('disabled', 'inactive')
        AND COALESCE(c.enabled, 1) = 1
        AND (c.next_probe_at IS NULL OR c.next_probe_at <= ?)
      ORDER BY c.next_probe_at IS NOT NULL, c.next_probe_at, a.platform, a.name
      LIMIT ?
    `).all(new Date(at).toISOString(), settings.scheduledBatchSize);
    return rows.map((row) => String(row.account_id));
  }

  cleanup() {
    const before = new Date(Date.now() - this.settings().retentionDays * 86400000).toISOString();
    const actions = this.db.prepare(`
      DELETE FROM sub2api_key_probe_actions WHERE created_at < ?
    `).run(before).changes;
    const batches = this.db.prepare(`
      DELETE FROM sub2api_key_probe_batches WHERE completed_at < ?
    `).run(before).changes;
    return { batches, actions, before };
  }

  #selectAccounts(options = {}) {
    const requestedIds = [...new Set((options.accountIds || []).map(String).filter(Boolean))];
    const platforms = [...new Set((options.platforms || []).map(normalizePlatform).filter(Boolean))];
    const rows = this.db.prepare(`
      SELECT * FROM sub2api_monitored_accounts
      WHERE missing_since IS NULL
      ORDER BY platform, name LIMIT ${ACCOUNT_LIMIT}
    `).all().filter((row) => {
      if (requestedIds.length > 0 && !requestedIds.includes(String(row.account_id))) return false;
      if (platforms.length > 0 && !platforms.includes(normalizePlatform(row.platform))) return false;
      if (options.triggerType === 'scheduled' && !accountIsActive(row)) return false;
      if (options.triggerType === 'recovery' && !upstreamIsDisabled(row)) return false;
      if (['scheduled', 'recovery'].includes(options.triggerType) || requestedIds.length === 0) {
        const config = this.#accountConfigRow(row.account_id);
        return config ? Boolean(config.enabled) : true;
      }
      return true;
    });
    if (rows.length === 0 && options.triggerType !== 'scheduled') {
      throw new AppError('ACCOUNT_SELECTION_EMPTY', '没有符合检测范围的 Sub2API Key', { status: 409 });
    }
    return rows;
  }

  async run(options = {}) {
    const settings = this.settings();
    const triggerType = ['scheduled', 'recovery'].includes(options.triggerType)
      ? options.triggerType
      : 'manual';
    const scheduledIds = triggerType === 'scheduled' && !options.accountIds?.length
      ? this.dueAccountIds()
      : options.accountIds;
    if (triggerType === 'scheduled' && !scheduledIds?.length) {
      return { runId: crypto.randomUUID(), triggerType, accountCount: 0, succeeded: 0, failed: 0, warning: 0, results: [] };
    }
    const rows = this.#selectAccounts({ ...options, accountIds: scheduledIds, triggerType });
    if (rows.length === 0) {
      return { runId: crypto.randomUUID(), triggerType, accountCount: 0, succeeded: 0, failed: 0, results: [] };
    }
    const runId = crypto.randomUUID();
    const results = new Array(rows.length);
    const concurrency = clamp(integer(options.concurrency, settings.concurrency), 1, 10);
    const directContext = await this.#prepareDirectProbeContext(rows, settings);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
      while (cursor < rows.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await this.#probeAccount(rows[index], {
          runId,
          triggerType,
          settings,
          directContext
        });
      }
    });
    try {
      await Promise.all(workers);
    } finally {
      this.#disposeDirectProbeContext(directContext);
    }
    return {
      runId,
      triggerType,
      accountCount: rows.length,
      succeeded: results.filter((item) => item.status === 'healthy').length,
      failed: results.filter((item) => item.status === 'critical').length,
      warning: results.filter((item) => item.status === 'warning').length,
      results
    };
  }

  async #probeAccount(account, {
    runId,
    triggerType,
    settings,
    directContext,
    recoverySignature = null,
    recoveryReason = null
  }) {
    const configRow = this.#accountConfigRow(account.account_id);
    const effective = this.#effectiveConfig(account, configRow, settings);
    const prompts = settings.prompts[effective.complexity];
    const selectedPrompts = Array.from(
      { length: effective.sampleCount },
      (_, index) => prompts[index % prompts.length]
    );
    const batchId = crypto.randomUUID();
    const startedAt = nowIso();
    const samples = [];
    for (let index = 0; index < selectedPrompts.length; index += 1) {
      samples.push(await this.#probeSample(account, {
        batchId,
        index: index + 1,
        prompt: selectedPrompts[index],
        model: effective.model,
        timeoutMs: effective.timeoutSeconds * 1000,
        directContext
      }));
    }
    const successful = samples.filter((sample) => sample.status === 'succeeded');
    const durations = successful.map((sample) => sample.durationMs);
    const firstTokens = successful.map((sample) => sample.firstTokenMs).filter((value) => value != null);
    const directSampleCount = samples.filter((sample) => sample.direct).length;
    const verifiedSampleCount = samples.filter((sample) => sample.promptVerified).length;
    const averageMs = durations.length
      ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
      : null;
    const status = probeHealth({
      succeededCount: successful.length,
      failedCount: samples.length - successful.length,
      averageMs,
      warningMs: effective.warningThresholdMs,
      criticalMs: effective.criticalThresholdMs
    });
    const firstFailure = samples.find((sample) => sample.status !== 'succeeded') || null;
    const completedAt = nowIso();
    const intervalMinutes = triggerType === 'recovery'
      ? effective.recoveryIntervalMinutes
      : effective.intervalMinutes;
    const nextProbeAt = new Date(Date.parse(completedAt) + intervalMinutes * 60000).toISOString();
    const averageFirstTokenMs = average(firstTokens);
    const details = {
      intervalMinutes,
      timeoutSeconds: effective.timeoutSeconds,
      warningThresholdMs: effective.warningThresholdMs,
      criticalThresholdMs: effective.criticalThresholdMs,
      transport: 'direct_api_key',
      directSampleCount,
      verifiedSampleCount,
      capabilities: [...new Set(samples.map((sample) => sample.capability).filter(Boolean))],
      ...(triggerType === 'recovery' ? {
        recoveryReason: recoveryReason || 'recovery_interval_due'
      } : {})
    };
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO sub2api_key_probe_batches(
          id, run_id, account_id, trigger_type, model, complexity, sample_count,
          succeeded_count, failed_count, status, avg_duration_ms, min_duration_ms,
          max_duration_ms, p95_duration_ms, avg_first_token_ms, error_code,
          error_message, prompts_json, details_json, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        batchId, runId, String(account.account_id), triggerType, effective.model || null,
        effective.complexity, samples.length, successful.length,
        samples.length - successful.length, status, averageMs,
        durations.length ? Math.min(...durations) : null,
        durations.length ? Math.max(...durations) : null,
        percentile(durations, 0.95),
        averageFirstTokenMs,
        firstFailure?.errorCode || null, firstFailure?.errorMessage || null,
        stringifyJson(selectedPrompts, []), stringifyJson(details), startedAt, completedAt
      );
      const insertSample = this.db.prepare(`
        INSERT INTO sub2api_key_probe_samples(
          id, batch_id, sample_index, prompt, status, duration_ms, first_token_ms,
          response_excerpt, error_code, error_message, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const sample of samples) {
        insertSample.run(
          sample.id, batchId, sample.index, sample.prompt, sample.status,
          sample.durationMs, sample.firstTokenMs, sample.responseExcerpt,
          sample.errorCode, sample.errorMessage, sample.startedAt, sample.completedAt
        );
      }
      this.db.prepare(`
        INSERT INTO sub2api_key_probe_configs(
          account_id, enabled, next_probe_at, last_probe_at, updated_at
        ) VALUES (?, 1, ?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET
          next_probe_at = excluded.next_probe_at,
          last_probe_at = excluded.last_probe_at,
          updated_at = excluded.updated_at
      `).run(String(account.account_id), nextProbeAt, completedAt, completedAt);
      if (triggerType === 'recovery') {
        this.db.prepare(`
          UPDATE sub2api_key_probe_configs SET
            next_recovery_probe_at = ?, last_recovery_probe_at = ?,
            last_shortage_signature = ?, updated_at = ?
          WHERE account_id = ?
        `).run(
          nextProbeAt,
          completedAt,
          recoverySignature,
          completedAt,
          String(account.account_id)
        );
      }
    })();
    return {
      id: batchId,
      runId,
      accountId: String(account.account_id),
      accountName: account.name,
      platform: normalizePlatform(account.platform),
      triggerType,
      model: effective.model || null,
      complexity: effective.complexity,
      sampleCount: samples.length,
      succeededCount: successful.length,
      failedCount: samples.length - successful.length,
      status,
      avgDurationMs: averageMs,
      minDurationMs: durations.length ? Math.min(...durations) : null,
      maxDurationMs: durations.length ? Math.max(...durations) : null,
      p95DurationMs: percentile(durations, 0.95),
      avgFirstTokenMs: averageFirstTokenMs,
      firstTokenSampleCount: firstTokens.length,
      directSampleCount,
      verifiedSampleCount,
      nextProbeAt,
      startedAt,
      completedAt
    };
  }

  async #probeSample(account, options) {
    const startedAt = nowIso();
    const started = performance.now();
    let firstTokenMs = null;
    let responseText = '';
    let durationMs = null;
    let direct = false;
    let promptVerified = false;
    let capability = null;
    let errorCode = null;
    let errorMessage = null;
    try {
      const platform = normalizePlatform(account.platform);
      const accountType = String(account.account_type || '').trim().toLowerCase();
      if (accountType !== 'apikey') {
        throw new AppError('DIRECT_PROBE_ACCOUNT_TYPE_UNSUPPORTED', `账号类型 ${accountType || 'unknown'} 无法安全直连检测`, {
          status: 409
        });
      }
      if (!DIRECT_PROBE_PLATFORMS.has(platform)) {
        throw new AppError('DIRECT_PROBE_PLATFORM_UNSUPPORTED', `平台 ${platform} 暂不支持安全直连检测`, {
          status: 409
        });
      }
      if (!options.model) {
        throw new AppError('DIRECT_PROBE_MODEL_REQUIRED', '直连检测必须为该平台或 Key 配置具体模型', {
          status: 409
        });
      }
      if (options.directContext?.exportError) throw options.directContext.exportError;
      const credential = options.directContext?.credentials?.get(String(account.account_id)) || null;
      if (!credential?.apiKey) {
        throw new AppError('DIRECT_PROBE_CREDENTIAL_UNAVAILABLE', '未能取得该 Key 的临时直连凭据', {
          status: 409
        });
      }
      if (credential.proxyConfigured) {
        throw new AppError('DIRECT_PROBE_PROXY_UNSUPPORTED', '该 Key 配置了账号代理，Provider Monitor 不会绕过代理直接检测', {
          status: 409
        });
      }
      direct = true;
      const result = await this.directProbe.probe({
        platform,
        credential,
        model: options.model,
        prompt: options.prompt,
        timeoutMs: options.timeoutMs
      });
      if (!result?.completed || !result?.promptVerified) {
        throw new AppError('PROMPT_VERIFICATION_FAILED', '直连检测没有完成提示词校验', { status: 502 });
      }
      firstTokenMs = Number.isFinite(result.firstTokenMs) ? result.firstTokenMs : null;
      durationMs = Number.isFinite(result.durationMs) ? result.durationMs : null;
      responseText = String(result.responseText || '').slice(0, 4000);
      capability = String(result.capability || '').slice(0, 80) || null;
      promptVerified = true;
    } catch (error) {
      errorCode = String(error?.code || errorCode || 'KEY_PROBE_FAILED').slice(0, 120);
      errorMessage = redactText(error?.message || errorMessage || error).slice(0, 1000);
      if (!responseText && error?.details?.responseExcerpt) {
        responseText = String(error.details.responseExcerpt).slice(0, 500);
      }
    }
    return {
      id: crypto.randomUUID(),
      index: options.index,
      prompt: options.prompt,
      status: errorMessage || !promptVerified ? 'failed' : 'succeeded',
      durationMs: durationMs ?? Math.round(performance.now() - started),
      firstTokenMs,
      responseExcerpt: responseText
        ? redactText(responseText).replace(/\s+/g, ' ').trim().slice(0, 500)
        : null,
      direct,
      promptVerified,
      capability,
      errorCode,
      errorMessage,
      startedAt,
      completedAt: nowIso()
    };
  }
}

module.exports = {
  KeyProbeService,
  DEFAULT_PROMPTS,
  normalizePrompts,
  probeHealth
};
