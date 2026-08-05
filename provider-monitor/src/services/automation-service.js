const crypto = require('crypto');
const { AppError, asAppError } = require('../errors');
const { safeFetch } = require('../http/safe-fetch');
const { redact, redactText } = require('../security/redaction');
const { nowIso, parseJson, stringifyJson } = require('../db');

function unwrap(payload) {
  if (payload?.success === false) {
    throw new AppError('SUB2API_WRITE_FAILED', payload.message || 'Sub2API rejected the operation', {
      status: 502
    });
  }
  return Object.prototype.hasOwnProperty.call(payload || {}, 'data') ? payload.data : payload;
}

const ACCOUNT_ACTIONS = new Set([
  'disable_sub2api_account',
  'enable_sub2api_account'
]);
const TARGETLESS_ACTIONS = new Set([
  'trigger_recharge_webhook',
  'rebuild_sub2api_mappings'
]);
const SUPPORTED_ACTIONS = new Set([
  ...ACCOUNT_ACTIONS,
  'switch_to_backup',
  'trigger_recharge_webhook',
  'remind_credential_rotation',
  'create_route_recommendation',
  'rebuild_sub2api_mappings'
]);
const ACTION_LABELS = {
  disable_sub2api_account: '停用 Sub2API 账号',
  enable_sub2api_account: '启用 Sub2API 账号',
  switch_to_backup: '切换备用映射',
  trigger_recharge_webhook: '触发充值 Webhook',
  remind_credential_rotation: '提醒凭据轮换',
  create_route_recommendation: '创建线路推荐',
  rebuild_sub2api_mappings: '重建全部 Sub2API 映射'
};
const TRIGGER_LABELS = {
  low_balance: '低余额',
  balance_recovered: '余额恢复',
  key_failed: 'Key 健康检查失败',
  anomaly_detected: '检测到异常',
  contract_changed: '接口协议变更',
  scheduled: '定时任务'
};
const CONDITION_OPERATOR_LABELS = { lt: '<', lte: '≤', gt: '>', gte: '≥' };

function actionTargets(config) {
  if (TARGETLESS_ACTIONS.has(config.action)) return [null];
  if (ACCOUNT_ACTIONS.has(config.action)) return config.accountIds || [];
  return config.channelIds || [];
}

function actionTargetDetails(actionType, targetId) {
  if (targetId == null) return {};
  return ACCOUNT_ACTIONS.has(actionType)
    ? { targetId, accountId: targetId }
    : { targetId, channelId: targetId };
}

function comparisonConditionMatches(value, operator, threshold) {
  if (!Number.isFinite(value) || !Number.isFinite(threshold)) return false;
  if (operator === 'lt') return value < threshold;
  if (operator === 'lte') return value <= threshold;
  if (operator === 'gt') return value > threshold;
  if (operator === 'gte') return value >= threshold;
  return false;
}

function actionFailure(error, stage) {
  const fallbackCode = typeof error?.code === 'string' && error.code
    ? error.code
    : 'AUTOMATION_ACTION_FAILED';
  const appError = asAppError(error, fallbackCode);
  const status = Number(appError.status);
  return {
    code: appError.code || fallbackCode,
    message: redactText(appError.message || error || 'Automation action failed').slice(0, 1000),
    stage: String(appError.details?.stage || stage || 'execute_action'),
    retryable: Boolean(appError.retryable),
    status: Number.isFinite(status) ? status : null,
    details: redact(appError.details || {})
  };
}

class AutomationService {
  constructor({ db, config, sub2api, mappings = null, notifications = null }) {
    this.db = db;
    this.config = config;
    this.sub2api = sub2api;
    this.mappings = mappings;
    this.notifications = notifications;
  }

  listRules() {
    return this.db.prepare(`SELECT * FROM automation_rules ORDER BY name COLLATE NOCASE`).all().map((row) => ({
      ...row,
      enabled: Boolean(row.enabled),
      dryRun: Boolean(row.dry_run),
      config: parseJson(row.config_json, {}),
      config_json: undefined,
      dry_run: undefined
    }));
  }

  saveRule(input, id = null) {
    const now = nowIso();
    const ruleId = id || crypto.randomUUID();
    const existing = id ? this.db.prepare('SELECT * FROM automation_rules WHERE id = ?').get(id) : null;
    if (id && !existing) throw new AppError('AUTOMATION_RULE_NOT_FOUND', 'Automation rule was not found', { status: 404 });
    if (existing) {
      this.db.prepare(`
        UPDATE automation_rules SET name = ?, enabled = ?, dry_run = ?, trigger_type = ?,
          connection_id = ?, config_json = ?, updated_at = ? WHERE id = ?
      `).run(
        input.name ?? existing.name,
        input.enabled == null ? existing.enabled : input.enabled ? 1 : 0,
        input.dryRun == null ? existing.dry_run : input.dryRun ? 1 : 0,
        input.triggerType ?? existing.trigger_type,
        input.connectionId === undefined ? existing.connection_id : input.connectionId || null,
        stringifyJson(input.config ?? parseJson(existing.config_json, {})),
        now,
        ruleId
      );
    } else {
      this.db.prepare(`
        INSERT INTO automation_rules(
          id, name, enabled, dry_run, trigger_type, connection_id,
          config_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        ruleId,
        input.name,
        input.enabled ? 1 : 0,
        input.dryRun === false ? 0 : 1,
        input.triggerType,
        input.connectionId || null,
        stringifyJson(input.config || {}),
        now,
        now
      );
    }
    return this.listRules().find((rule) => rule.id === ruleId);
  }

  deleteRule(id) {
    const result = this.db.prepare('DELETE FROM automation_rules WHERE id = ?').run(id);
    if (!result.changes) throw new AppError('AUTOMATION_RULE_NOT_FOUND', 'Automation rule was not found', { status: 404 });
  }

  listActions(limit = 200) {
    return this.db.prepare(`
      SELECT a.*, r.name AS rule_name
      FROM automation_actions a
      LEFT JOIN automation_rules r ON r.id = a.rule_id
      ORDER BY a.created_at DESC LIMIT ?
    `).all(Math.min(500, Math.max(1, Number(limit) || 200))).map((row) => {
      const errorDetails = parseJson(row.error_details_json, {});
      const error = row.error_message
        ? {
            code: row.error_code || 'AUTOMATION_ACTION_FAILED',
            message: row.error_message,
            stage: row.failure_stage || null,
            retryable: Boolean(errorDetails.retryable),
            status: errorDetails.status ?? null,
            details: errorDetails.details || errorDetails
          }
        : null;
      return {
        ...row,
        dryRun: Boolean(row.dry_run),
        before: parseJson(row.before_json, {}),
        after: parseJson(row.after_json, {}),
        error,
        errorCode: row.error_code || null,
        errorMessage: row.error_message || null,
        failureStage: row.failure_stage || null,
        errorDetails: error?.details || {},
        dry_run: undefined,
        before_json: undefined,
        after_json: undefined,
        error_details_json: undefined
      };
    });
  }

  async evaluateConnection(connectionId) {
    const rules = this.db.prepare(`
      SELECT * FROM automation_rules
      WHERE enabled = 1 AND trigger_type != 'scheduled'
        AND (connection_id IS NULL OR connection_id = ?)
    `).all(connectionId);
    const actions = [];
    for (const rule of rules) {
      const config = parseJson(rule.config_json, {});
      const safety = this.#safetyState(rule, connectionId, config);
      if (!safety.allowed || !this.#matches(connectionId, rule.trigger_type, config)) continue;
      for (const targetId of actionTargets(config)) {
        const normalizedTargetId = targetId == null ? null : Number(targetId);
        if (this.#deduplicated(rule, connectionId, config, normalizedTargetId)) continue;
        actions.push(await this.#execute(rule, connectionId, normalizedTargetId, config.action));
      }
    }
    return actions;
  }

  async evaluateScheduled(at = new Date()) {
    const rules = this.db.prepare(`
      SELECT * FROM automation_rules
      WHERE enabled = 1 AND trigger_type = 'scheduled'
      ORDER BY created_at, id
    `).all();
    const actions = [];
    for (const rule of rules) {
      const config = parseJson(rule.config_json, {});
      const safety = this.#safetyState(rule, null, config, config.action);
      if (!safety.allowed || !this.#scheduleDue(rule, config, at)) continue;
      actions.push(await this.#execute(rule, null, null, config.action));
      if (!config.condition || !config.onMatchAction) continue;
      for (const target of this.#scheduledConditionTargets(config)) {
        const targetSafety = this.#safetyState(rule, target.connectionId, config, config.onMatchAction);
        if (!targetSafety.allowed) {
          if (targetSafety.reason === 'daily_action_limit') break;
          continue;
        }
        if (this.#deduplicated(
          rule,
          target.connectionId,
          config,
          target.targetId,
          config.onMatchAction
        )) continue;
        actions.push(await this.#execute(
          rule,
          target.connectionId,
          target.targetId,
          config.onMatchAction,
          { condition: target.condition }
        ));
      }
    }
    return actions;
  }

  previewRule(ruleId, connectionId = null) {
    const rule = this.db.prepare('SELECT * FROM automation_rules WHERE id = ?').get(ruleId);
    if (!rule) throw new AppError('AUTOMATION_RULE_NOT_FOUND', 'Automation rule was not found', { status: 404 });
    const ids = connectionId
      ? [connectionId]
      : rule.connection_id
        ? [rule.connection_id]
        : this.db.prepare('SELECT id FROM provider_connections WHERE enabled = 1').all().map((row) => row.id);
    const config = parseJson(rule.config_json, {});
    if (rule.trigger_type === 'scheduled') {
      const safety = this.#safetyState(rule, null, config, config.action);
      const due = this.#scheduleDue(rule, config, new Date());
      const conditionTargets = config.condition && config.onMatchAction
        ? this.#scheduledConditionTargets(config)
        : [];
      return [{
        connectionId: null,
        matched: due,
        safety,
        conditionMatchedTargets: conditionTargets.length,
        proposedActions: [{
          action: config.action,
          intervalMinutes: Number(config.scheduleIntervalMinutes),
          deduplicated: !due
        }, ...conditionTargets.map((target) => ({
          action: config.onMatchAction,
          connectionId: target.connectionId,
          ...actionTargetDetails(config.onMatchAction, target.targetId),
          condition: target.condition,
          safety: this.#safetyState(rule, target.connectionId, config, config.onMatchAction),
          deduplicated: this.#deduplicated(
            rule,
            target.connectionId,
            config,
            target.targetId,
            config.onMatchAction
          )
        }))]
      }];
    }
    return ids.map((id) => {
      const safety = this.#safetyState(rule, id, config);
      return {
        connectionId: id,
        matched: this.#matches(id, rule.trigger_type, config),
        safety,
        proposedActions: actionTargets(config)
          .map((targetId) => ({
            action: config.action,
            ...actionTargetDetails(config.action, targetId == null ? null : Number(targetId)),
            deduplicated: this.#deduplicated(rule, id, config, targetId == null ? null : Number(targetId))
          }))
      };
    });
  }

  #safetyState(rule, connectionId, config, actionType = config.action) {
    const contractPauseHours = Math.max(1, Number(config.contractPauseHours || 24));
    const contractChange = this.db.prepare(`
      SELECT id, detected_at FROM asset_change_events
      WHERE connection_id = ? AND change_type = 'contract_changed' AND detected_at >= ?
      ORDER BY detected_at DESC LIMIT 1
    `).get(connectionId, new Date(Date.now() - contractPauseHours * 3600000).toISOString());
    const highRiskAction = [
      'disable_sub2api_account', 'enable_sub2api_account',
      'switch_to_backup', 'rebuild_sub2api_mappings'
    ].includes(actionType);
    if (contractChange && highRiskAction && config.allowDuringContractChange !== true) {
      return { allowed: false, reason: 'contract_change_pause', contractChange };
    }
    const scheduledDefault = Math.ceil(1440 / Math.max(1, Number(config.scheduleIntervalMinutes || 1440))) + 1;
    const defaultDailyMaximum = rule.trigger_type === 'scheduled' ? scheduledDefault : 10;
    const dailyMaximum = Math.max(1, Number(config.dailyMaximumActions || defaultDailyMaximum));
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const dailyCount = this.db.prepare(`
      SELECT COUNT(*) count FROM automation_actions
      WHERE rule_id = ? AND created_at >= ? AND status IN ('succeeded', 'dry_run')
    `).get(rule.id, today.toISOString()).count;
    if (dailyCount >= dailyMaximum) return { allowed: false, reason: 'daily_action_limit', dailyCount, dailyMaximum };
    return { allowed: true, dailyCount, dailyMaximum };
  }

  #deduplicated(rule, connectionId, config, targetId, actionType = config.action) {
    const cooldownMinutes = Math.max(1, Number(config.cooldownMinutes || 60));
    return Boolean(this.db.prepare(`
      SELECT id FROM automation_actions
      WHERE rule_id = ?
        AND ((? IS NULL AND connection_id IS NULL) OR connection_id = ?)
        AND action_type = ?
        AND (
          (? IS NULL AND json_type(after_json, '$.targetId') IS NULL)
          OR json_extract(after_json, '$.targetId') = ?
        )
        AND status IN ('succeeded', 'dry_run') AND rolled_back_at IS NULL
        AND created_at >= ?
      ORDER BY created_at DESC LIMIT 1
    `).get(
      rule.id,
      connectionId,
      connectionId,
      actionType,
      targetId,
      targetId,
      new Date(Date.now() - cooldownMinutes * 60000).toISOString()
    ));
  }

  #scheduleDue(rule, config, at) {
    const intervalMinutes = Math.max(1, Number(config.scheduleIntervalMinutes || 1440));
    const last = this.db.prepare(`
      SELECT created_at FROM automation_actions
      WHERE rule_id = ? AND action_type = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(rule.id, config.action);
    if (!last?.created_at) return true;
    const elapsed = at.getTime() - Date.parse(last.created_at);
    return !Number.isFinite(elapsed) || elapsed >= intervalMinutes * 60000;
  }

  #scheduledConditionTargets(config) {
    const condition = config.condition || {};
    if (
      condition.type !== 'composite_rate_difference' ||
      config.targetMode !== 'matched_mapping_accounts'
    ) return [];
    const threshold = Number(condition.threshold);
    const rows = this.db.prepare(`
      SELECT m.id AS mapping_id, m.connection_id, m.account_id, m.group_id,
        s.difference_ratio, s.checked_at
      FROM sub2api_mappings m
      JOIN sub2api_mapping_states s ON s.mapping_id = m.id
      WHERE m.enabled = 1 AND m.account_id IS NOT NULL AND s.difference_ratio IS NOT NULL
      ORDER BY m.account_id, m.connection_id, m.group_id, m.id
    `).all().filter((row) => comparisonConditionMatches(
      Number(row.difference_ratio) * 100,
      condition.operator,
      threshold
    ));
    const targets = new Map();
    for (const row of rows) {
      const targetId = Number(row.account_id);
      if (!targets.has(targetId)) {
        targets.set(targetId, {
          targetId,
          connectionId: row.connection_id,
          connectionIds: [],
          matches: []
        });
      }
      const target = targets.get(targetId);
      if (!target.connectionIds.includes(row.connection_id)) target.connectionIds.push(row.connection_id);
      target.matches.push({
        mappingId: row.mapping_id,
        groupId: row.group_id,
        differencePercent: Number(row.difference_ratio) * 100,
        checkedAt: row.checked_at
      });
    }
    return [...targets.values()].map((target) => ({
      targetId: target.targetId,
      connectionId: target.connectionId,
      condition: {
        type: condition.type,
        operator: condition.operator,
        threshold,
        unit: 'percent',
        connectionIds: target.connectionIds,
        matchedMappings: target.matches
      }
    }));
  }

  #matches(connectionId, triggerType, config) {
    if (triggerType === 'key_failed') {
      const required = Math.max(1, Number(config.consecutiveMatches || 1));
      const keyIdClause = config.keyId ? 'AND key_id = ?' : '';
      const params = [connectionId];
      if (config.keyId) params.push(config.keyId);
      params.push(required);
      const checks = this.db.prepare(`
        SELECT status FROM key_health_checks WHERE connection_id = ? ${keyIdClause}
        ORDER BY checked_at DESC LIMIT ?
      `).all(...params);
      return checks.length >= required && checks.every((row) => row.status === 'failed');
    }
    if (triggerType === 'anomaly_detected') {
      return Boolean(this.db.prepare(`
        SELECT id FROM anomaly_events WHERE connection_id = ? AND resolved_at IS NULL
          AND (? IS NULL OR anomaly_type = ?) LIMIT 1
      `).get(connectionId, config.anomalyType || null, config.anomalyType || null));
    }
    if (triggerType === 'contract_changed') {
      const hours = Math.max(1, Number(config.lookbackHours || 24));
      return Boolean(this.db.prepare(`
        SELECT id FROM asset_change_events WHERE connection_id = ?
          AND change_type = 'contract_changed' AND detected_at >= ? LIMIT 1
      `).get(connectionId, new Date(Date.now() - hours * 3600000).toISOString()));
    }
    const required = Math.max(1, Number(config.consecutiveMatches || 1));
    const rows = this.db.prepare(`
      SELECT available FROM balance_snapshots
      WHERE connection_id = ? AND subject_type = 'account' AND currency = ?
        AND available IS NOT NULL ORDER BY captured_at DESC, id DESC LIMIT ?
    `).all(connectionId, config.currency || 'USD', required);
    if (rows.length < required) return false;
    if (triggerType === 'low_balance') return rows.every((row) => Number(row.available) <= Number(config.threshold));
    if (triggerType === 'balance_recovered') return rows.every((row) => Number(row.available) >= Number(config.threshold));
    return false;
  }

  async #execute(rule, connectionId, targetId, actionType, workflowContext = null) {
    if (!SUPPORTED_ACTIONS.has(actionType)) {
      throw new AppError('AUTOMATION_ACTION_UNSUPPORTED', `Unsupported action: ${actionType}`, { status: 400 });
    }
    const id = crypto.randomUUID();
    const dryRun = Boolean(rule.dry_run) || !this.config.automationEnabled;
    const desiredAccountStatus = actionType === 'disable_sub2api_account' ? 'inactive'
      : actionType === 'enable_sub2api_account' ? 'active' : null;
    const contextDetails = workflowContext ? { workflowContext } : {};
    let before = {
      ...actionTargetDetails(actionType, targetId),
      ...(targetId == null ? {} : { status: null }),
      ...contextDetails
    };
    let after = {
      ...actionTargetDetails(actionType, targetId),
      ...(desiredAccountStatus ? { status: desiredAccountStatus } : {}),
      ...contextDetails
    };
    let failureStage = 'record_action';
    this.db.prepare(`
      INSERT INTO automation_actions(
        id, rule_id, connection_id, action_type, status, dry_run,
        before_json, after_json, created_at
      ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)
    `).run(id, rule.id, connectionId, actionType, dryRun ? 1 : 0, stringifyJson(before), stringifyJson(after), nowIso());
    try {
      if (actionType === 'rebuild_sub2api_mappings') {
        failureStage = 'prepare_mapping_rebuild';
        if (!this.mappings) {
          throw new AppError('MAPPING_SERVICE_UNAVAILABLE', 'Sub2API mapping service is unavailable', { status: 503 });
        }
        before = {
          mappingCount: this.db.prepare('SELECT COUNT(*) count FROM sub2api_mappings').get().count,
          ...contextDetails
        };
        failureStage = 'rebuild_mappings';
        const result = await this.mappings.rebuildAutoMappings({ preview: dryRun });
        after = dryRun
          ? {
              replacementPreview: true,
              wouldDeleteMappings: result.summary.wouldDeleteMappings,
              wouldCreateMappings: result.summary.wouldCreateMappings,
              skipped: result.summary.skipped,
              ...contextDetails
            }
          : {
              replaced: true,
              deletedMappings: result.summary.deletedMappings,
              createdMappings: result.summary.createdMappings,
              skipped: result.summary.skipped,
              ...contextDetails
            };
      } else if (!dryRun) {
        if (desiredAccountStatus) {
          failureStage = 'read_sub2api_account';
          const accountPayload = await this.sub2api.data(`/api/v1/admin/accounts/${targetId}`);
          const account = accountPayload?.account ?? accountPayload;
          if (!['active', 'inactive', 'error'].includes(account?.status)) {
            throw new AppError(
              'SUB2API_ACCOUNT_STATUS_INVALID',
              'Sub2API account response did not contain a supported status',
              { status: 502 }
            );
          }
          before = {
            ...actionTargetDetails(actionType, targetId),
            status: account.status,
            name: account.name,
            ...contextDetails
          };
          failureStage = 'update_sub2api_account';
          const updatedPayload = await this.sub2api.data(`/api/v1/admin/accounts/${targetId}`, {
            method: 'PUT', body: { status: desiredAccountStatus }
          });
          const updated = updatedPayload?.account ?? updatedPayload;
          after = {
            ...actionTargetDetails(actionType, targetId),
            status: updated?.status || desiredAccountStatus,
            name: updated?.name || account.name,
            ...contextDetails
          };
        } else if (actionType === 'switch_to_backup') {
          failureStage = 'switch_backup_mapping';
          const mappings = this.db.prepare(`SELECT * FROM sub2api_mappings WHERE channel_id = ? ORDER BY role`).all(targetId);
          const backup = mappings.find((mapping) => mapping.role === 'backup');
          if (!backup) throw new AppError('BACKUP_MAPPING_NOT_FOUND', 'No backup provider mapping is configured', { status: 409 });
          before = { ...actionTargetDetails(actionType, targetId), mappings: mappings.map((mapping) => ({ id: mapping.id, role: mapping.role, enabled: Boolean(mapping.enabled) })), ...contextDetails };
          this.db.transaction(() => {
            this.db.prepare(`UPDATE sub2api_mappings SET enabled = 0, updated_at = ? WHERE channel_id = ?`).run(nowIso(), targetId);
            this.db.prepare(`
              UPDATE sub2api_mappings SET role = 'backup', updated_at = ?
              WHERE channel_id = ? AND role = 'primary' AND id != ?
            `).run(nowIso(), targetId, backup.id);
            this.db.prepare(`UPDATE sub2api_mappings SET enabled = 1, role = 'primary', updated_at = ? WHERE id = ?`).run(nowIso(), backup.id);
          })();
          after = { ...actionTargetDetails(actionType, targetId), activeMappingId: backup.id, ...contextDetails };
        } else if (actionType === 'trigger_recharge_webhook') {
          failureStage = 'deliver_recharge_webhook';
          const config = parseJson(rule.config_json, {});
          if (!config.webhookUrl) throw new AppError('WEBHOOK_URL_REQUIRED', 'Recharge webhook URL is required', { status: 400 });
          const response = await safeFetch(config.webhookUrl, this.config, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event: 'provider_monitor.recharge_required', connectionId, ruleId: rule.id })
          });
          if (!response.ok) throw new AppError('WEBHOOK_FAILED', `Recharge webhook returned HTTP ${response.status}`, { status: 502 });
          after = { delivered: true, ...contextDetails };
        } else {
          after = { ...actionTargetDetails(actionType, targetId), recommendation: actionType, connectionId, createdAt: nowIso(), ...contextDetails };
        }
      }
      failureStage = 'record_result';
      this.db.prepare(`
        UPDATE automation_actions SET status = ?, before_json = ?, after_json = ?,
          completed_at = ? WHERE id = ?
      `).run(dryRun ? 'dry_run' : 'succeeded', stringifyJson(before), stringifyJson(after), nowIso(), id);
      await this.#notifyActionExecution(rule, {
        actionId: id, actionType, connectionId, targetId, dryRun, after, workflowContext
      });
      return { id, actionType, status: dryRun ? 'dry_run' : 'succeeded', dryRun, before, after };
    } catch (error) {
      const failure = actionFailure(error, failureStage);
      this.db.prepare(`
        UPDATE automation_actions SET status = 'failed', before_json = ?, after_json = ?,
          error_code = ?, error_message = ?, failure_stage = ?, error_details_json = ?,
          completed_at = ? WHERE id = ?
      `).run(
        stringifyJson(before),
        stringifyJson(after),
        failure.code,
        failure.message,
        failure.stage,
        stringifyJson({
          retryable: failure.retryable,
          status: failure.status,
          details: failure.details
        }),
        nowIso(),
        id
      );
      throw error;
    }
  }

  #actionConditionSummary(rule, workflowContext) {
    const condition = workflowContext?.condition;
    if (condition?.type === 'composite_rate_difference') {
      const operator = CONDITION_OPERATOR_LABELS[condition.operator] || condition.operator;
      const matched = condition.matchedMappings?.length || 0;
      return `综合倍率偏差 ${operator} ${condition.threshold}%${matched ? `（命中 ${matched} 个映射）` : ''}`;
    }
    return TRIGGER_LABELS[rule.trigger_type] || rule.trigger_type;
  }

  async #notifyActionExecution(rule, execution) {
    if (!this.notifications) return;
    const config = parseJson(rule.config_json, {});
    if (config.notifyOnAction !== true) return;
    if (rule.trigger_type === 'scheduled' && !execution.workflowContext) return;
    const actionLabel = ACTION_LABELS[execution.actionType] || execution.actionType;
    const targetLabel = execution.targetId == null
      ? ''
      : ACCOUNT_ACTIONS.has(execution.actionType)
        ? ` #${execution.targetId}${execution.after?.name ? `（${execution.after.name}）` : ''}`
        : `（渠道 #${execution.targetId}）`;
    const message = `${execution.dryRun ? '[演练] ' : ''}自动化规则「${rule.name}」已触发：` +
      `${this.#actionConditionSummary(rule, execution.workflowContext)}，` +
      `${execution.dryRun ? '计划执行' : '已执行'}「${actionLabel}${targetLabel}」`;
    try {
      await this.notifications.dispatch({
        id: null,
        severity: execution.dryRun ? 'info' : 'warning',
        message,
        triggered_at: nowIso(),
        connection_id: execution.connectionId || null,
        details: {
          source: 'automation_rule',
          ruleId: rule.id,
          ruleName: rule.name,
          actionId: execution.actionId,
          actionType: execution.actionType,
          dryRun: execution.dryRun,
          ...(execution.targetId == null ? {} : { targetId: execution.targetId }),
          ...(execution.workflowContext?.condition ? { condition: execution.workflowContext.condition } : {})
        }
      });
    } catch {
      // The action already completed; notification failures are recorded per channel and must not fail it.
    }
  }

  async rollback(actionId) {
    const action = this.db.prepare('SELECT * FROM automation_actions WHERE id = ?').get(actionId);
    if (!action) throw new AppError('AUTOMATION_ACTION_NOT_FOUND', 'Automation action was not found', { status: 404 });
    if (action.dry_run) throw new AppError('AUTOMATION_DRY_RUN', 'Dry-run actions do not require rollback', { status: 409 });
    if (action.rolled_back_at) throw new AppError('AUTOMATION_ALREADY_ROLLED_BACK', 'Action was already rolled back', { status: 409 });
    const before = parseJson(action.before_json, {});
    if (['disable_sub2api_account', 'enable_sub2api_account'].includes(action.action_type)) {
      await this.sub2api.data(`/api/v1/admin/accounts/${before.accountId}`, {
        method: 'PUT', body: { status: before.status }
      });
    } else if (['disable_sub2api_channel', 'enable_sub2api_channel'].includes(action.action_type)) {
      await this.sub2api.data(`/api/v1/admin/channels/${before.channelId}`, {
        method: 'PUT', body: { status: before.status }
      });
    } else if (action.action_type === 'switch_to_backup') {
      this.db.transaction(() => {
        const update = this.db.prepare(`UPDATE sub2api_mappings SET role = ?, enabled = ?, updated_at = ? WHERE id = ?`);
        for (const mapping of before.mappings || []) update.run(mapping.role, mapping.enabled ? 1 : 0, nowIso(), mapping.id);
      })();
    } else {
      throw new AppError('AUTOMATION_ROLLBACK_UNSUPPORTED', 'This action has no state to roll back', { status: 409 });
    }
    this.db.prepare(`UPDATE automation_actions SET rolled_back_at = ? WHERE id = ?`).run(nowIso(), actionId);
    return { id: actionId, rolledBackAt: nowIso() };
  }

}

module.exports = {
  AutomationService
};
