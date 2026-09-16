const crypto = require('crypto');
const { performance } = require('node:perf_hooks');
const { AppError } = require('../errors');
const { nowIso, parseJson, stringifyJson } = require('../db');
const { resolvePagination } = require('../pagination');
const { redactText } = require('../security/redaction');

const COMPLEXITIES = new Set(['simple', 'medium', 'complex']);
const ACTIVE_ACCOUNT_STATUSES = new Set(['active', 'unknown', 'rate_limited']);
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

class KeyProbeService {
  constructor({ db, config, sub2api }) {
    this.db = db;
    this.config = config;
    this.sub2api = sub2api;
  }

  settings() {
    const row = this.db.prepare('SELECT * FROM sub2api_key_probe_settings WHERE id = 1').get();
    const storedPrompts = parseJson(row.prompts_json, {});
    return {
      enabled: Boolean(row.enabled),
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
    const updatedAt = nowIso();
    this.db.prepare(`
      UPDATE sub2api_key_probe_settings SET
        enabled = ?, default_interval_minutes = ?, sample_count = ?, complexity = ?,
        timeout_seconds = ?, warning_threshold_ms = ?, critical_threshold_ms = ?,
        stale_after_minutes = ?, concurrency = ?, scheduled_batch_size = ?,
        retention_days = ?, models_json = ?, prompts_json = ?, updated_at = ?
      WHERE id = 1
    `).run(
      next.enabled ? 1 : 0,
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
      nextProbeAt: configRow?.next_probe_at || null,
      lastProbeAt: configRow?.last_probe_at || null,
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
        c.next_probe_at, c.last_probe_at, c.updated_at AS probe_config_updated_at
      FROM sub2api_monitored_accounts a
      LEFT JOIN sub2api_key_probe_configs c ON c.account_id = a.account_id
      WHERE a.missing_since IS NULL
      ORDER BY a.platform, a.name, a.account_id
      LIMIT ${ACCOUNT_LIMIT}
    `).all();
    const latest = new Map(this.#latestBatchRows().map((row) => [String(row.account_id), row]));
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
        last_probe_at: row.last_probe_at
      };
      const effective = this.#effectiveConfig(row, configRow, settings);
      const batch = latest.get(String(row.account_id)) || null;
      return {
        accountId: String(row.account_id),
        name: row.name,
        platform: normalizePlatform(row.platform),
        accountType: row.account_type,
        accountStatus: row.status,
        schedulable: Boolean(row.schedulable),
        health: this.#healthFor(batch, effective, settings, at),
        config: effective,
        latest: batch ? this.#serializeBatch(batch, false) : null
      };
    });
    const allItems = items;
    const platform = normalizePlatform(filters.platform || '');
    if (filters.platform) items = items.filter((item) => item.platform === platform);
    if (filters.health) items = items.filter((item) => item.health === String(filters.health));
    if (filters.accountStatus) items = items.filter((item) => item.accountStatus === String(filters.accountStatus));
    if (filters.enabled === 'true' || filters.enabled === true) items = items.filter((item) => item.config.enabled);
    if (filters.enabled === 'false' || filters.enabled === false) items = items.filter((item) => !item.config.enabled);
    const search = String(filters.search || '').trim().toLowerCase();
    if (search) {
      items = items.filter((item) => [item.accountId, item.name, item.platform, item.accountType]
        .some((value) => String(value || '').toLowerCase().includes(search)));
    }
    const direction = filters.order === 'asc' ? 1 : -1;
    const sortBy = ['name', 'platform', 'avgDurationMs', 'completedAt', 'health'].includes(filters.sortBy)
      ? filters.sortBy
      : 'completedAt';
    const healthRank = { critical: 5, warning: 4, stale: 3, unknown: 2, disabled: 1, healthy: 0 };
    items.sort((left, right) => {
      let a;
      let b;
      if (sortBy === 'name') [a, b] = [left.name, right.name];
      else if (sortBy === 'platform') [a, b] = [left.platform, right.platform];
      else if (sortBy === 'avgDurationMs') [a, b] = [left.latest?.avgDurationMs ?? -1, right.latest?.avgDurationMs ?? -1];
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
        counts,
        lastCompletedAt: allItems.map((item) => item.latest?.completedAt).filter(Boolean)
          .sort((left, right) => Date.parse(right) - Date.parse(left))[0] || null
      },
      platforms: [...new Set(allItems.map((item) => item.platform))].sort(),
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
      }))
    };
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
    const result = this.db.prepare(`
      DELETE FROM sub2api_key_probe_batches WHERE completed_at < ?
    `).run(before);
    return { batches: result.changes, before };
  }

  #selectAccounts(options = {}) {
    const requestedIds = [...new Set((options.accountIds || []).map(String).filter(Boolean))];
    const platforms = [...new Set((options.platforms || []).map(normalizePlatform).filter(Boolean))];
    const rows = this.db.prepare(`
      SELECT * FROM sub2api_monitored_accounts
      WHERE missing_since IS NULL AND status NOT IN ('disabled', 'inactive')
      ORDER BY platform, name LIMIT ${ACCOUNT_LIMIT}
    `).all().filter((row) => {
      if (requestedIds.length > 0 && !requestedIds.includes(String(row.account_id))) return false;
      if (platforms.length > 0 && !platforms.includes(normalizePlatform(row.platform))) return false;
      if (options.triggerType === 'scheduled' || requestedIds.length === 0) {
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
    const triggerType = options.triggerType === 'scheduled' ? 'scheduled' : 'manual';
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
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
      while (cursor < rows.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await this.#probeAccount(rows[index], { runId, triggerType, settings });
      }
    });
    await Promise.all(workers);
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

  async #probeAccount(account, { runId, triggerType, settings }) {
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
        timeoutMs: effective.timeoutSeconds * 1000
      }));
    }
    const successful = samples.filter((sample) => sample.status === 'succeeded');
    const durations = successful.map((sample) => sample.durationMs);
    const firstTokens = successful.map((sample) => sample.firstTokenMs).filter((value) => value != null);
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
    const nextProbeAt = new Date(Date.parse(completedAt) + effective.intervalMinutes * 60000).toISOString();
    const details = {
      intervalMinutes: effective.intervalMinutes,
      timeoutSeconds: effective.timeoutSeconds,
      warningThresholdMs: effective.warningThresholdMs,
      criticalThresholdMs: effective.criticalThresholdMs
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
        firstTokens.length ? Math.round(firstTokens.reduce((sum, value) => sum + value, 0) / firstTokens.length) : null,
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
    let completed = false;
    let errorCode = null;
    let errorMessage = null;
    try {
      await this.sub2api.sse(`/api/v1/admin/accounts/${encodeURIComponent(account.account_id)}/test`, {
        method: 'POST',
        timeoutMs: options.timeoutMs,
        body: { model_id: options.model || '', prompt: options.prompt, mode: '' },
        onEvent: (event) => {
          if (event?.type === 'content' && event.text) {
            if (firstTokenMs == null) firstTokenMs = Math.round(performance.now() - started);
            responseText += String(event.text);
            if (responseText.length > 4000) responseText = responseText.slice(0, 4000);
          }
          if (event?.type === 'error') {
            errorCode = String(event.code || 'UPSTREAM_TEST_FAILED');
            errorMessage = String(event.error || event.text || 'Sub2API Key 测试失败');
          }
          if (event?.type === 'test_complete' && event.success !== false) completed = true;
        }
      });
      if (errorMessage || !completed) {
        throw new AppError(
          errorCode || 'INCOMPLETE_PROBE',
          errorMessage || 'Sub2API Key 测试未返回完成事件',
          { status: 502 }
        );
      }
    } catch (error) {
      errorCode = String(error?.code || errorCode || 'KEY_PROBE_FAILED');
      errorMessage = redactText(error?.message || errorMessage || error).slice(0, 1000);
    }
    return {
      id: crypto.randomUUID(),
      index: options.index,
      prompt: options.prompt,
      status: errorMessage ? 'failed' : 'succeeded',
      durationMs: Math.round(performance.now() - started),
      firstTokenMs,
      responseExcerpt: responseText
        ? redactText(responseText).replace(/\s+/g, ' ').trim().slice(0, 500)
        : null,
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
