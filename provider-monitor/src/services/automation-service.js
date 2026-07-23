const crypto = require('crypto');
const { AppError } = require('../errors');
const { safeFetch } = require('../http/safe-fetch');
const { redactText } = require('../security/redaction');
const { nowIso, parseJson, stringifyJson } = require('../db');

function unwrap(payload) {
  if (payload?.success === false) {
    throw new AppError('SUB2API_WRITE_FAILED', payload.message || 'Sub2API rejected the operation', {
      status: 502
    });
  }
  return Object.prototype.hasOwnProperty.call(payload || {}, 'data') ? payload.data : payload;
}

class AutomationService {
  constructor({ db, config, sub2api }) {
    this.db = db;
    this.config = config;
    this.sub2api = sub2api;
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
      SELECT * FROM automation_actions ORDER BY created_at DESC LIMIT ?
    `).all(Math.min(500, Math.max(1, Number(limit) || 200))).map((row) => ({
      ...row,
      dryRun: Boolean(row.dry_run),
      before: parseJson(row.before_json, {}),
      after: parseJson(row.after_json, {}),
      dry_run: undefined,
      before_json: undefined,
      after_json: undefined
    }));
  }

  async evaluateConnection(connectionId) {
    const rules = this.db.prepare(`
      SELECT * FROM automation_rules
      WHERE enabled = 1 AND (connection_id IS NULL OR connection_id = ?)
    `).all(connectionId);
    const actions = [];
    for (const rule of rules) {
      const config = parseJson(rule.config_json, {});
      const safety = this.#safetyState(rule, connectionId, config);
      if (!safety.allowed || !this.#matches(connectionId, rule.trigger_type, config)) continue;
      const targetChannelIds = config.action === 'trigger_recharge_webhook'
        ? [null]
        : config.channelIds || [];
      for (const channelId of targetChannelIds) {
        const normalizedChannelId = channelId == null ? null : Number(channelId);
        if (this.#deduplicated(rule, connectionId, config, normalizedChannelId)) continue;
        actions.push(await this.#execute(rule, connectionId, normalizedChannelId, config.action));
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
    return ids.map((id) => {
      const safety = this.#safetyState(rule, id, config);
      return {
        connectionId: id,
        matched: this.#matches(id, rule.trigger_type, config),
        safety,
        proposedActions: (config.action === 'trigger_recharge_webhook' ? [null] : config.channelIds || [])
          .map((channelId) => ({
            action: config.action,
            ...(channelId == null ? {} : { channelId: Number(channelId) }),
            deduplicated: this.#deduplicated(rule, id, config, channelId == null ? null : Number(channelId))
          }))
      };
    });
  }

  #safetyState(rule, connectionId, config) {
    const contractPauseHours = Math.max(1, Number(config.contractPauseHours || 24));
    const contractChange = this.db.prepare(`
      SELECT id, detected_at FROM asset_change_events
      WHERE connection_id = ? AND change_type = 'contract_changed' AND detected_at >= ?
      ORDER BY detected_at DESC LIMIT 1
    `).get(connectionId, new Date(Date.now() - contractPauseHours * 3600000).toISOString());
    const highRiskAction = ['disable_sub2api_channel', 'enable_sub2api_channel', 'switch_to_backup'].includes(config.action);
    if (contractChange && highRiskAction && config.allowDuringContractChange !== true) {
      return { allowed: false, reason: 'contract_change_pause', contractChange };
    }
    const dailyMaximum = Math.max(1, Number(config.dailyMaximumActions || 10));
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const dailyCount = this.db.prepare(`
      SELECT COUNT(*) count FROM automation_actions
      WHERE rule_id = ? AND created_at >= ? AND status IN ('succeeded', 'dry_run')
    `).get(rule.id, today.toISOString()).count;
    if (dailyCount >= dailyMaximum) return { allowed: false, reason: 'daily_action_limit', dailyCount, dailyMaximum };
    return { allowed: true, dailyCount, dailyMaximum };
  }

  #deduplicated(rule, connectionId, config, channelId) {
    const cooldownMinutes = Math.max(1, Number(config.cooldownMinutes || 60));
    return Boolean(this.db.prepare(`
      SELECT id FROM automation_actions
      WHERE rule_id = ? AND connection_id = ? AND action_type = ?
        AND (
          (? IS NULL AND json_type(after_json, '$.channelId') IS NULL)
          OR json_extract(after_json, '$.channelId') = ?
        )
        AND status IN ('succeeded', 'dry_run') AND rolled_back_at IS NULL
        AND created_at >= ?
      ORDER BY created_at DESC LIMIT 1
    `).get(
      rule.id,
      connectionId,
      config.action,
      channelId,
      channelId,
      new Date(Date.now() - cooldownMinutes * 60000).toISOString()
    ));
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

  async #execute(rule, connectionId, channelId, actionType) {
    const supported = new Set([
      'disable_sub2api_channel', 'enable_sub2api_channel', 'switch_to_backup',
      'trigger_recharge_webhook', 'remind_credential_rotation', 'create_route_recommendation'
    ]);
    if (!supported.has(actionType)) {
      throw new AppError('AUTOMATION_ACTION_UNSUPPORTED', `Unsupported action: ${actionType}`, { status: 400 });
    }
    const id = crypto.randomUUID();
    const dryRun = Boolean(rule.dry_run) || !this.config.automationEnabled;
    const desiredStatus = actionType === 'disable_sub2api_channel' ? 'disabled'
      : actionType === 'enable_sub2api_channel' ? 'active' : null;
    let before = channelId == null ? {} : { channelId, status: null };
    let after = channelId == null ? {} : { channelId, status: desiredStatus };
    this.db.prepare(`
      INSERT INTO automation_actions(
        id, rule_id, connection_id, action_type, status, dry_run,
        before_json, after_json, created_at
      ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)
    `).run(id, rule.id, connectionId, actionType, dryRun ? 1 : 0, stringifyJson(before), stringifyJson(after), nowIso());
    try {
      if (!dryRun) {
        if (desiredStatus) {
          const channel = await this.sub2api.data(`/api/v1/admin/channels/${channelId}`);
          before = { channelId, status: channel.status, name: channel.name };
          const updated = await this.sub2api.data(`/api/v1/admin/channels/${channelId}`, {
            method: 'PUT', body: { status: desiredStatus }
          });
          after = { channelId, status: updated.status, name: updated.name };
        } else if (actionType === 'switch_to_backup') {
          const mappings = this.db.prepare(`SELECT * FROM sub2api_mappings WHERE channel_id = ? ORDER BY role`).all(channelId);
          const backup = mappings.find((mapping) => mapping.role === 'backup');
          if (!backup) throw new AppError('BACKUP_MAPPING_NOT_FOUND', 'No backup provider mapping is configured', { status: 409 });
          before = { channelId, mappings: mappings.map((mapping) => ({ id: mapping.id, role: mapping.role, enabled: Boolean(mapping.enabled) })) };
          this.db.transaction(() => {
            this.db.prepare(`UPDATE sub2api_mappings SET enabled = 0, updated_at = ? WHERE channel_id = ?`).run(nowIso(), channelId);
            this.db.prepare(`
              UPDATE sub2api_mappings SET role = 'backup', updated_at = ?
              WHERE channel_id = ? AND role = 'primary' AND id != ?
            `).run(nowIso(), channelId, backup.id);
            this.db.prepare(`UPDATE sub2api_mappings SET enabled = 1, role = 'primary', updated_at = ? WHERE id = ?`).run(nowIso(), backup.id);
          })();
          after = { channelId, activeMappingId: backup.id };
        } else if (actionType === 'trigger_recharge_webhook') {
          const config = parseJson(rule.config_json, {});
          if (!config.webhookUrl) throw new AppError('WEBHOOK_URL_REQUIRED', 'Recharge webhook URL is required', { status: 400 });
          const response = await safeFetch(config.webhookUrl, this.config, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event: 'provider_monitor.recharge_required', connectionId, ruleId: rule.id })
          });
          if (!response.ok) throw new AppError('WEBHOOK_FAILED', `Recharge webhook returned HTTP ${response.status}`, { status: 502 });
          after = { delivered: true };
        } else {
          after = { channelId, recommendation: actionType, connectionId, createdAt: nowIso() };
        }
      }
      this.db.prepare(`
        UPDATE automation_actions SET status = ?, before_json = ?, after_json = ?,
          completed_at = ? WHERE id = ?
      `).run(dryRun ? 'dry_run' : 'succeeded', stringifyJson(before), stringifyJson(after), nowIso(), id);
      return { id, status: dryRun ? 'dry_run' : 'succeeded', dryRun, before, after };
    } catch (error) {
      this.db.prepare(`
        UPDATE automation_actions SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?
      `).run(redactText(error?.message || error).slice(0, 1000), nowIso(), id);
      throw error;
    }
  }

  async rollback(actionId) {
    const action = this.db.prepare('SELECT * FROM automation_actions WHERE id = ?').get(actionId);
    if (!action) throw new AppError('AUTOMATION_ACTION_NOT_FOUND', 'Automation action was not found', { status: 404 });
    if (action.dry_run) throw new AppError('AUTOMATION_DRY_RUN', 'Dry-run actions do not require rollback', { status: 409 });
    if (action.rolled_back_at) throw new AppError('AUTOMATION_ALREADY_ROLLED_BACK', 'Action was already rolled back', { status: 409 });
    const before = parseJson(action.before_json, {});
    if (['disable_sub2api_channel', 'enable_sub2api_channel'].includes(action.action_type)) {
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
