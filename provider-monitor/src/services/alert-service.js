const crypto = require('crypto');
const { AppError } = require('../errors');
const { nowIso, parseJson, stringifyJson } = require('../db');

const ALERT_TERM_LABELS = {
  aligned: '综合倍率一致',
  rate_mismatch: '综合倍率偏差',
  missing_base_group: '基座分组缺失',
  base_group_unselected: '未选择基座分组',
  missing_provider_group: '供应商分组缺失',
  missing_dynamic_route_rate: '动态路由倍率缺失',
  missing_rate: '倍率缺失',
  invalid_provider_rate: '供应商倍率无效',
  enabled: '启用',
  disabled: '停用',
  expired: '已到期',
  exhausted: '已耗尽',
  missing: '缺失',
  created: '新增',
  updated: '变更',
  removed: '移除',
  contract_changed: '接口协议变更',
  key: 'Key',
  group: '分组',
  provider: '供应商',
  disable_sub2api_channel: '停用 Sub2API 渠道',
  switch_to_backup: '切换到备用渠道'
};

function alertTermLabel(value) {
  return ALERT_TERM_LABELS[value] || value;
}

function localizeLegacyAlertMessage(message) {
  const text = String(message || '');
  let match = text.match(/^(.+) recovered: (.+)$/s);
  if (match) return `${match[1]} 已恢复：${localizeLegacyAlertMessage(match[2])}`;

  match = text.match(/^(.+) mapped group (.+) has rate status ([a-z0-9_]+)(?: \((-?\d+(?:\.\d+)?)%\))?\.$/i);
  if (match) {
    return `${match[1]} 映射分组“${match[2]}”的倍率状态为${alertTermLabel(match[3])}${match[4] == null ? '' : `（偏差 ${match[4]}%）`}。`;
  }

  match = text.match(/^(.+) team (.+) has (-?\d+(?:\.\d+)?) ([A-Z]+) remaining\.$/);
  if (match) return `${match[1]} 团队“${match[2]}”的剩余额度为 ${match[3]} ${match[4]}。`;

  match = text.match(/^(.+) key (.+) has (-?\d+(?:\.\d+)?) ([A-Z]+) remaining\.$/);
  if (match) return `${match[1]} Key“${match[2]}”的剩余额度为 ${match[3]} ${match[4]}。`;

  match = text.match(/^(.+) balance is (-?\d+(?:\.\d+)?) ([A-Z]+), at or below (-?\d+(?:\.\d+)?) ([A-Z]+)\.$/);
  if (match) return `${match[1]} 余额为 ${match[2]} ${match[3]}，已低于或等于预警值 ${match[4]} ${match[5]}。`;

  match = text.match(/^(.+) estimated runway is (-?\d+(?:\.\d+)?) days\.$/);
  if (match) return `${match[1]} 预计还可使用 ${match[2]} 天。`;

  match = text.match(/^(.+) has no successful balance update within (-?\d+(?:\.\d+)?) minutes\.$/);
  if (match) return `${match[1]} 已连续 ${match[2]} 分钟未成功更新余额。`;

  match = text.match(/^(.+) sync failed: (.+)\.$/s);
  if (match) return `${match[1]} 同步失败：${match[2]}。`;

  match = text.match(/^(.+) key (.+) expires at (.+)\.$/s);
  if (match) return `${match[1]} Key“${match[2]}”将于 ${match[3]} 到期。`;

  match = text.match(/^(.+) key (.+) is ([a-z0-9_]+)\.$/i);
  if (match) return `${match[1]} Key“${match[2]}”当前状态为${alertTermLabel(match[3])}。`;

  match = text.match(/^(.+) detected ([a-z0-9_]+) on ([a-z0-9_]+)\.$/i);
  if (match) return `${match[1]} 检测到${alertTermLabel(match[3])}发生${alertTermLabel(match[2])}。`;

  match = text.match(/^(.+) credentials have not been rotated for (\d+) days\.$/);
  if (match) return `${match[1]} 的凭据已 ${match[2]} 天未轮换。`;

  match = text.match(/^(.+) automation ([a-z0-9_]+) failed: (.+)\.$/is);
  if (match) return `${match[1]} 自动化动作“${alertTermLabel(match[2])}”执行失败：${match[3]}。`;

  match = text.match(/^(.+) balance dropped (-?\d+(?:\.\d+)?)% in ([A-Z]+)\.$/);
  if (match) return `${match[1]} 的 ${match[3]} 余额下降了 ${match[2]}%。`;

  match = text.match(/^(.+) balance decreased without a matching usage increase\.$/);
  if (match) return `${match[1]} 的余额下降，但未检测到对应的用量增长。`;

  match = text.match(/^(.+) cumulative usage counter moved backwards or reset\.$/);
  if (match) return `${match[1]} 的累计用量计数发生回退或重置。`;

  match = text.match(/^(.+) balance source field changed from (.+) to (.+)\.$/s);
  if (match) return `${match[1]} 的余额来源字段从 ${match[2]} 变更为 ${match[3]}。`;

  match = text.match(/^(.+) key usage does not match account usage\.$/);
  if (match) return `${match[1]} 的 Key 用量与账户用量不一致。`;

  match = text.match(/^(.+) recent burn rate is (-?\d+(?:\.\d+)?)x its baseline\.$/);
  if (match) return `${match[1]} 的近期消耗速率为基准值的 ${match[2]} 倍。`;

  return text;
}

class AlertService {
  constructor({ db, config, queries, notifications }) {
    this.db = db;
    this.config = config;
    this.queries = queries;
    this.notifications = notifications;
  }

  listRules() {
    return this.db.prepare(`SELECT * FROM alert_rules ORDER BY name COLLATE NOCASE`).all().map((row) => ({
      ...row,
      enabled: Boolean(row.enabled),
      config: parseJson(row.config_json, {}),
      config_json: undefined
    }));
  }

  saveRule(input, id = null) {
    const now = nowIso();
    const ruleId = id || crypto.randomUUID();
    const existing = id ? this.db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(id) : null;
    if (id && !existing) throw new AppError('ALERT_RULE_NOT_FOUND', 'Alert rule was not found', { status: 404 });
    if (existing) {
      this.db.prepare(`
        UPDATE alert_rules SET name = ?, enabled = ?, connection_id = ?, rule_type = ?,
          scope = ?, currency = ?, threshold = ?, consecutive_matches = ?,
          cooldown_minutes = ?, config_json = ?, updated_at = ? WHERE id = ?
      `).run(
        input.name ?? existing.name,
        input.enabled == null ? existing.enabled : input.enabled ? 1 : 0,
        input.connectionId === undefined ? existing.connection_id : input.connectionId || null,
        input.ruleType ?? existing.rule_type,
        input.scope ?? existing.scope,
        input.currency === undefined ? existing.currency : input.currency || null,
        input.threshold === undefined ? existing.threshold : input.threshold,
        input.consecutiveMatches ?? existing.consecutive_matches,
        input.cooldownMinutes ?? existing.cooldown_minutes,
        stringifyJson(input.config ?? parseJson(existing.config_json, {})),
        now,
        ruleId
      );
    } else {
      this.db.prepare(`
        INSERT INTO alert_rules(
          id, name, enabled, connection_id, rule_type, scope, currency, threshold,
          consecutive_matches, cooldown_minutes, config_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        ruleId,
        input.name,
        input.enabled === false ? 0 : 1,
        input.connectionId || null,
        input.ruleType,
        input.scope || 'account',
        input.currency || null,
        input.threshold ?? null,
        input.consecutiveMatches || 1,
        input.cooldownMinutes ?? 60,
        stringifyJson(input.config || {}),
        now,
        now
      );
    }
    return this.listRules().find((rule) => rule.id === ruleId);
  }

  deleteRule(id) {
    const result = this.db.prepare('DELETE FROM alert_rules WHERE id = ?').run(id);
    if (!result.changes) throw new AppError('ALERT_RULE_NOT_FOUND', 'Alert rule was not found', { status: 404 });
  }

  listEvents(status = null, limit = 200) {
    const rows = status
      ? this.db.prepare(`SELECT * FROM alert_events WHERE status = ? ORDER BY triggered_at DESC LIMIT ?`).all(status, limit)
      : this.db.prepare(`SELECT * FROM alert_events ORDER BY triggered_at DESC LIMIT ?`).all(limit);
    return rows.map((row) => ({
      ...row,
      message: localizeLegacyAlertMessage(row.message),
      details: parseJson(row.details_json, {}),
      details_json: undefined
    }));
  }

  acknowledge(id) {
    const result = this.db.prepare(`
      UPDATE alert_events SET status = 'acknowledged', acknowledged_at = ?
      WHERE id = ? AND status = 'active'
    `).run(nowIso(), id);
    if (!result.changes) throw new AppError('ALERT_NOT_ACTIVE', 'Active alert event was not found', { status: 404 });
    return this.listEvents().find((event) => event.id === id);
  }

  async evaluateAll() {
    const providers = this.db.prepare('SELECT id FROM provider_connections WHERE enabled = 1').all();
    for (const provider of providers) await this.evaluateConnection(provider.id);
  }

  async evaluateConnection(connectionId) {
    const provider = this.db.prepare('SELECT * FROM provider_connections WHERE id = ?').get(connectionId);
    if (!provider) return [];
    const rules = this.db.prepare(`
      SELECT * FROM alert_rules WHERE enabled = 1 AND (connection_id IS NULL OR connection_id = ?)
    `).all(connectionId);
    const implicitRules = [
      {
        id: `implicit-${connectionId}`,
        threshold: provider.warning_threshold,
        level: 1,
        severity: 'warning'
      },
      {
        id: `implicit-secondary-${connectionId}`,
        threshold: provider.secondary_warning_threshold,
        level: 2,
        severity: 'error'
      }
    ].map((definition) => ({
      id: definition.id,
      rule_type: 'low_balance',
      scope: 'account',
      currency: provider.threshold_currency || 'USD',
      threshold: definition.threshold,
      consecutive_matches: 1,
      cooldown_minutes: 60,
      config_json: stringifyJson({
        implicitBalanceLevel: definition.level,
        severity: definition.severity
      })
    }));
    const events = [];
    for (const rule of implicitRules) {
      if (rule.threshold != null) {
        rules.push(rule);
      } else {
        events.push(await this.#applyEvaluation(provider, rule, {
          matched: false,
          subjectType: 'account',
          subjectId: provider.id,
          severity: parseJson(rule.config_json, {}).severity
        }));
      }
    }
    for (const rule of rules) {
      if (rule.rule_type === 'rate_mismatch') {
        for (const evaluation of this.#evaluateRateMismatch(provider, rule)) {
          events.push(await this.#applyEvaluation(provider, rule, evaluation));
        }
        continue;
      }
      const evaluation = this.#evaluateRule(provider, rule);
      events.push(await this.#applyEvaluation(provider, rule, evaluation));
    }
    return events.filter(Boolean);
  }

  #evaluateRateMismatch(provider, rule) {
    const config = parseJson(rule.config_json, {});
    const thresholdRatio = rule.threshold == null ? null : Math.max(0, Number(rule.threshold) / 100);
    const states = this.db.prepare(`
      SELECT s.*, m.group_id FROM sub2api_mapping_states s
      JOIN sub2api_mappings m ON m.id = s.mapping_id
      WHERE m.connection_id = ? AND m.enabled = 1 AND s.status != 'mapping_disabled'
      ORDER BY CASE s.status
        WHEN 'missing_base_group' THEN 0 WHEN 'rate_mismatch' THEN 1 ELSE 2 END,
        ABS(COALESCE(s.difference_ratio, 0)) DESC
    `).all(provider.id);
    const evaluations = states.map((state) => {
      const comparisonDetails = parseJson(state.details_json, {});
      const effectiveThreshold = thresholdRatio ?? state.tolerance_ratio;
      const differenceExceeded = state.difference_ratio != null &&
        Math.abs(state.difference_ratio) > Number(effectiveThreshold ?? 0);
      const structuralMismatch = !['aligned', 'rate_mismatch'].includes(state.status);
      const matched = structuralMismatch || differenceExceeded;
      const differencePercent = state.difference_ratio == null ? null : state.difference_ratio * 100;
      const alertStatus = differenceExceeded ? 'rate_mismatch' : state.status;
      return {
        matched,
        subjectType: 'mapping',
        subjectId: state.mapping_id,
        severity: config.severity || (state.status === 'missing_base_group' ? 'error' : 'warning'),
        message: matched
          ? `${provider.name} 映射分组“${state.base_group_name || state.group_id}”的倍率状态为${alertTermLabel(alertStatus)}${differencePercent == null ? '' : `（偏差 ${differencePercent.toFixed(2)}%）`}。`
          : '',
        details: matched ? {
          mappingId: state.mapping_id,
          groupId: state.group_id,
          groupName: state.base_group_name,
          status: alertStatus,
          comparisonStatus: state.status,
          providerGroup: state.provider_group_name,
          providerRate: state.provider_rate,
          rechargeMultiplier: comparisonDetails.rechargeMultiplier ?? null,
          compositeRate: comparisonDetails.compositeRate ?? null,
          baseGroup: state.base_group_name,
          baseRate: state.base_group_rate,
          differenceRateScope: comparisonDetails.differenceRateScope || 'composite_rate',
          differenceRatio: state.difference_ratio,
          thresholdRatio: effectiveThreshold,
          checkedAt: state.checked_at
        } : {}
      };
    });

    const evaluatedIds = new Set(states.map((state) => state.mapping_id));
    const staleEvents = this.db.prepare(`
      SELECT subject_id FROM alert_events
      WHERE rule_id = ? AND connection_id = ? AND subject_type = 'mapping' AND status != 'resolved'
    `).all(rule.id, provider.id);
    for (const event of staleEvents) {
      if (evaluatedIds.has(event.subject_id)) continue;
      evaluations.push({
        matched: false,
        subjectType: 'mapping',
        subjectId: event.subject_id,
        severity: config.severity || 'warning',
        message: '',
        details: {}
      });
    }
    return evaluations;
  }

  #evaluateRule(provider, rule) {
    const config = parseJson(rule.config_json, {});
    if (rule.rule_type === 'low_balance') {
      const currency = rule.currency || 'USD';
      if (rule.scope === 'team') {
        const required = Math.max(1, rule.consecutive_matches || 1);
        const teams = this.db.prepare(`
          SELECT DISTINCT s.subject_id FROM balance_snapshots s
          JOIN remote_groups g ON g.id = s.subject_id AND g.connection_id = s.connection_id
          WHERE s.connection_id = ? AND s.subject_type = 'team' AND s.currency = ?
            AND g.status NOT IN ('missing', 'disabled')
        `).all(provider.id, currency);
        let matchedTeam = null;
        for (const team of teams) {
          const rows = this.db.prepare(`
            SELECT available, captured_at FROM balance_snapshots
            WHERE connection_id = ? AND subject_type = 'team' AND subject_id = ?
              AND currency = ? AND available IS NOT NULL
            ORDER BY captured_at DESC, id DESC LIMIT ?
          `).all(provider.id, team.subject_id, currency, required);
          if (rows.length >= required && rows.every((row) => Number(row.available) <= Number(rule.threshold))) {
            matchedTeam = { id: team.subject_id, latest: rows[0] };
            break;
          }
        }
        const group = matchedTeam ? this.db.prepare('SELECT name FROM remote_groups WHERE id = ?').get(matchedTeam.id) : null;
        return {
          matched: Boolean(matchedTeam), subjectType: 'team', subjectId: matchedTeam?.id || provider.id,
          severity: config.severity || 'warning',
          message: matchedTeam ? `${provider.name} 团队“${group?.name || matchedTeam.id}”的剩余额度为 ${Number(matchedTeam.latest.available).toFixed(2)} ${currency}。` : '',
          details: { team: matchedTeam, threshold: rule.threshold, currency }
        };
      }
      if (rule.scope === 'key') {
        const required = Math.max(1, rule.consecutive_matches || 1);
        const candidates = this.db.prepare(`
          SELECT id, name, currency FROM remote_keys
          WHERE connection_id = ? AND unlimited = 0
            AND (? IS NULL OR currency = ?)
            AND status NOT IN ('missing', 'disabled', 'expired')
          ORDER BY name COLLATE NOCASE
        `).all(provider.id, rule.currency || null, rule.currency || null);
        let matchedKey = null;
        for (const candidate of candidates) {
          const rows = this.db.prepare(`
            SELECT available, currency, captured_at FROM balance_snapshots
            WHERE connection_id = ? AND subject_type = 'key' AND subject_id = ?
              AND available IS NOT NULL AND (? IS NULL OR currency = ?)
            ORDER BY captured_at DESC, id DESC LIMIT ?
          `).all(provider.id, candidate.id, rule.currency || null, rule.currency || null, required);
          if (rows.length >= required && rows.every((row) => Number(row.available) <= Number(rule.threshold))) {
            matchedKey = { ...candidate, latest: rows[0] };
            break;
          }
        }
        return {
          matched: Boolean(matchedKey), subjectType: 'key', subjectId: matchedKey?.id || provider.id,
          severity: config.severity || 'warning',
          message: matchedKey ? `${provider.name} Key“${matchedKey.name}”的剩余额度为 ${Number(matchedKey.latest.available).toFixed(2)} ${matchedKey.latest.currency || currency}。` : '',
          details: { key: matchedKey, threshold: rule.threshold, consecutiveMatches: required }
        };
      }
      const rows = this.db.prepare(`
        SELECT available, captured_at FROM balance_snapshots
        WHERE connection_id = ? AND subject_type = 'account' AND currency = ?
          AND available IS NOT NULL
        ORDER BY captured_at DESC, id DESC LIMIT ?
      `).all(provider.id, currency, Math.max(1, rule.consecutive_matches || 1));
      const matched = rows.length >= (rule.consecutive_matches || 1) &&
        rows.every((row) => Number(row.available) <= Number(rule.threshold));
      const implicitBalanceLevel = Number(config.implicitBalanceLevel) || null;
      return {
        matched,
        subjectType: 'account',
        subjectId: provider.id,
        severity: config.severity || 'warning',
        message: matched
          ? implicitBalanceLevel
            ? `${provider.name} 触发${implicitBalanceLevel}级余额告警：当前余额为 ${Number(rows[0].available).toFixed(2)} ${currency}，已低于或等于阈值 ${rule.threshold} ${currency}。`
            : `${provider.name} 余额为 ${Number(rows[0].available).toFixed(2)} ${currency}，已低于或等于预警值 ${rule.threshold} ${currency}。`
          : '',
        details: {
          currency,
          threshold: rule.threshold,
          ...(implicitBalanceLevel ? { alertLevel: implicitBalanceLevel } : {}),
          latest: rows[0] || null,
          ...(matched && provider.recharge_url ? { rechargeUrl: provider.recharge_url } : {})
        }
      };
    }
    if (rule.rule_type === 'runway_below') {
      const forecast = this.queries.forecast(provider.id, rule.currency || 'USD', config.lookbackDays || 14);
      const matched = forecast.runwayDays != null && forecast.runwayDays <= Number(rule.threshold);
      return {
        matched,
        subjectType: 'account',
        subjectId: provider.id,
        severity: config.severity || 'warning',
        message: matched ? `${provider.name} 预计还可使用 ${forecast.runwayDays.toFixed(1)} 天。` : '',
        details: forecast
      };
    }
    if (rule.rule_type === 'stale_data') {
      const minutes = rule.threshold ?? this.config.staleAfterMinutes;
      const ageMinutes = provider.last_success_at
        ? (Date.now() - Date.parse(provider.last_success_at)) / 60000
        : Number.POSITIVE_INFINITY;
      const matched = ageMinutes >= minutes;
      return {
        matched,
        subjectType: 'connection',
        subjectId: provider.id,
        severity: config.severity || 'warning',
        message: matched ? `${provider.name} 已连续 ${minutes} 分钟未成功更新余额。` : '',
        details: { lastSuccessAt: provider.last_success_at, ageMinutes }
      };
    }
    if (rule.rule_type === 'sync_failed') {
      const matched = Boolean(provider.last_error_code);
      return {
        matched,
        subjectType: 'connection',
        subjectId: provider.id,
        severity: config.severity || 'error',
        message: matched ? `${provider.name} 同步失败：${provider.last_error_message || provider.last_error_code}。` : '',
        details: { code: provider.last_error_code, message: provider.last_error_message }
      };
    }
    if (rule.rule_type === 'key_expiry') {
      const days = Number(rule.threshold ?? 7);
      const deadline = new Date(Date.now() + days * 86400000).toISOString();
      const key = this.db.prepare(`
        SELECT id, name, expires_at FROM remote_keys
        WHERE connection_id = ? AND expires_at IS NOT NULL AND expires_at <= ?
          AND status NOT IN ('missing', 'disabled')
        ORDER BY expires_at ASC LIMIT 1
      `).get(provider.id, deadline);
      return {
        matched: Boolean(key),
        subjectType: 'key',
        subjectId: key?.id || provider.id,
        severity: config.severity || 'warning',
        message: key ? `${provider.name} Key“${key.name}”将于 ${key.expires_at} 到期。` : '',
        details: { key, days }
      };
    }
    if (rule.rule_type === 'key_disabled') {
      const key = this.db.prepare(`
        SELECT id, name, status FROM remote_keys WHERE connection_id = ?
          AND status IN ('disabled', 'expired', 'exhausted', 'missing')
        ORDER BY last_seen_at DESC LIMIT 1
      `).get(provider.id);
      return {
        matched: Boolean(key), subjectType: 'key', subjectId: key?.id || provider.id,
        severity: config.severity || 'error',
        message: key ? `${provider.name} Key“${key.name}”当前状态为${alertTermLabel(key.status)}。` : '', details: { key }
      };
    }
    if (rule.rule_type === 'asset_drift' || rule.rule_type === 'contract_changed') {
      const changeType = rule.rule_type === 'contract_changed' ? 'contract_changed' : (config.changeType || null);
      const since = new Date(Date.now() - Number(config.lookbackMinutes || 60) * 60000).toISOString();
      const change = this.db.prepare(`
        SELECT * FROM asset_change_events WHERE connection_id = ? AND detected_at >= ?
          AND (? IS NULL OR change_type = ?) ORDER BY detected_at DESC LIMIT 1
      `).get(provider.id, since, changeType, changeType);
      return {
        matched: Boolean(change), subjectType: change?.asset_type || 'connection', subjectId: change?.asset_id || provider.id,
        severity: config.severity || change?.severity || 'warning',
        message: change ? `${provider.name} 检测到${alertTermLabel(change.asset_type)}发生${alertTermLabel(change.change_type)}。` : '', details: { change }
      };
    }
    if (rule.rule_type === 'anomaly') {
      const anomaly = this.db.prepare(`
        SELECT * FROM anomaly_events WHERE connection_id = ? AND resolved_at IS NULL
          AND (? IS NULL OR anomaly_type = ?) ORDER BY detected_at DESC LIMIT 1
      `).get(provider.id, config.anomalyType || null, config.anomalyType || null);
      return {
        matched: Boolean(anomaly), subjectType: anomaly?.subject_type || 'account', subjectId: anomaly?.subject_id || provider.id,
        severity: config.severity || anomaly?.severity || 'warning',
        message: anomaly?.message || '', details: { anomaly }
      };
    }
    if (rule.rule_type === 'credential_expiry') {
      const connection = this.db.prepare(`
        SELECT e.rotated_at, e.created_at FROM encrypted_credentials e
        JOIN provider_connections p ON p.credential_id = e.id WHERE p.id = ?
      `).get(provider.id);
      const ageDays = (Date.now() - Date.parse(connection?.rotated_at || connection?.created_at || 0)) / 86400000;
      const threshold = Number(rule.threshold || config.maxAgeDays || 90);
      const matched = ageDays >= threshold;
      return {
        matched, subjectType: 'credential', subjectId: provider.id, severity: config.severity || 'warning',
        message: matched ? `${provider.name} 的凭据已 ${Math.floor(ageDays)} 天未轮换。` : '',
        details: { ageDays, threshold, rotatedAt: connection?.rotated_at || null }
      };
    }
    if (rule.rule_type === 'automation_failed') {
      const action = this.db.prepare(`
        SELECT id, action_type, error_message, created_at FROM automation_actions
        WHERE connection_id = ? AND status = 'failed' AND created_at >= ?
        ORDER BY created_at DESC LIMIT 1
      `).get(provider.id, new Date(Date.now() - Number(config.lookbackMinutes || 60) * 60000).toISOString());
      return {
        matched: Boolean(action), subjectType: 'automation', subjectId: action?.id || provider.id,
        severity: config.severity || 'error',
        message: action ? `${provider.name} 自动化动作“${alertTermLabel(action.action_type)}”执行失败：${action.error_message}。` : '', details: { action }
      };
    }
    if (rule.rule_type === 'rate_mismatch') {
      return this.#evaluateRateMismatch(provider, rule)[0] || {
        matched: false,
        subjectType: 'mapping',
        subjectId: provider.id
      };
    }
    return { matched: false, subjectType: rule.scope || 'account', subjectId: provider.id };
  }

  #maintenanceActive(connectionId) {
    const row = this.db.prepare(`SELECT value_json FROM settings WHERE key = 'maintenanceWindows'`).get();
    const windows = parseJson(row?.value_json, []);
    const now = Date.now();
    return windows.some((window) => {
      if (window.connectionIds?.length && !window.connectionIds.includes(connectionId)) return false;
      return Date.parse(window.start) <= now && Date.parse(window.end) >= now;
    });
  }

  async #applyEvaluation(provider, rule, evaluation) {
    const fingerprint = `${rule.id}:${provider.id}:${evaluation.subjectType}:${evaluation.subjectId}`;
    const existing = this.db.prepare('SELECT * FROM alert_events WHERE fingerprint = ?').get(fingerprint);
    if (!evaluation.matched) {
      if (existing && existing.status !== 'resolved') {
        this.db.prepare(`
          UPDATE alert_events SET status = 'resolved', resolved_at = ? WHERE id = ?
        `).run(nowIso(), existing.id);
        if (!this.#maintenanceActive(provider.id)) {
          await this.notifications.dispatch({
            id: existing.id,
            severity: 'info',
            message: `${provider.name} 已恢复：${localizeLegacyAlertMessage(existing.message)}`,
            triggered_at: nowIso(),
            details: { recoveredFrom: existing.severity, originalTriggeredAt: existing.triggered_at }
          });
        }
        return { ...existing, status: 'resolved' };
      }
      return null;
    }

    const now = nowIso();
    const eventId = existing?.id || crypto.randomUUID();
    const cooldownElapsed = existing?.status === 'active' && Date.now() - Date.parse(existing.triggered_at) >= Number(rule.cooldown_minutes || 60) * 60000;
    const config = parseJson(rule.config_json, {});
    const escalationDue = existing?.status === 'active' && config.escalateAfterMinutes &&
      Date.now() - Date.parse(existing.triggered_at) >= Number(config.escalateAfterMinutes) * 60000;
    const shouldNotify = !existing || existing.status === 'resolved' || cooldownElapsed || escalationDue;
    if (escalationDue && config.escalationSeverity) evaluation.severity = config.escalationSeverity;
    const activeStatus = existing?.status === 'acknowledged' ? 'acknowledged' : 'active';
    this.db.prepare(`
      INSERT INTO alert_events(
        id, rule_id, connection_id, subject_type, subject_id, status, severity,
        message, fingerprint, details_json, triggered_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(fingerprint) DO UPDATE SET
        status = excluded.status, severity = excluded.severity, message = excluded.message,
        details_json = excluded.details_json, triggered_at = excluded.triggered_at,
        resolved_at = NULL,
        acknowledged_at = CASE WHEN alert_events.status = 'resolved' THEN NULL ELSE alert_events.acknowledged_at END
    `).run(
      eventId,
      String(rule.id).startsWith('implicit-') ? null : rule.id,
      provider.id,
      evaluation.subjectType,
      evaluation.subjectId,
      activeStatus,
      evaluation.severity || 'warning',
      evaluation.message,
      fingerprint,
      stringifyJson(evaluation.details || {}),
      shouldNotify ? now : existing.triggered_at
    );
    const event = {
      id: eventId,
      connection_id: provider.id,
      status: activeStatus,
      severity: evaluation.severity || 'warning',
      message: evaluation.message,
      triggered_at: shouldNotify ? now : existing.triggered_at,
      details: evaluation.details || {}
    };
    if (shouldNotify && !this.#maintenanceActive(provider.id)) await this.notifications.dispatch(event);
    return event;
  }
}

module.exports = {
  AlertService,
  localizeLegacyAlertMessage
};
