const crypto = require('crypto');
const { nowIso, parseJson, stringifyJson } = require('../db');

const VOLATILE_METADATA_KEY = /^(?:spend|usage(?:_|$)|used(?:_|$)|current_|last_|request_count$|requestCount$|byok_usage$)/i;

function stableMetadata(value) {
  if (Array.isArray(value)) return value.map(stableMetadata);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !VOLATILE_METADATA_KEY.test(key))
      .map(([key, item]) => [key, stableMetadata(item)])
  );
}

function comparableFingerprint(value) {
  const { detectedAt: _detectedAt, detected_at: _detectedAtLegacy, ...rest } = value || {};
  return rest;
}

function comparableKey(row) {
  return {
    status: row.status,
    expiresAt: row.expires_at,
    primaryGroup: row.primary_group_ref,
    backupGroup: row.backup_group_ref,
    unlimited: Boolean(row.unlimited),
    quotaLimit: row.quota_limit,
    metadata: stableMetadata(parseJson(row.metadata_json, {}))
  };
}

function comparableGroup(row) {
  return {
    name: row.name,
    ratio: row.ratio,
    status: row.status,
    metadata: stableMetadata(parseJson(row.metadata_json, {}))
  };
}

function changedFields(before, after) {
  const fields = [];
  for (const key of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
    if (JSON.stringify(before?.[key] ?? null) !== JSON.stringify(after?.[key] ?? null)) fields.push(key);
  }
  return fields;
}

class AnalysisService {
  constructor({ db, config }) {
    this.db = db;
    this.config = config;
  }

  captureInventory(connectionId) {
    const provider = this.db.prepare(`SELECT fingerprint_json FROM provider_connections WHERE id = ?`).get(connectionId);
    return {
      fingerprint: parseJson(provider?.fingerprint_json, {}),
      keys: new Map(this.db.prepare(`SELECT * FROM remote_keys WHERE connection_id = ?`).all(connectionId).map((row) => [String(row.remote_id), { id: row.id, value: comparableKey(row) }])),
      groups: new Map(this.db.prepare(`SELECT * FROM remote_groups WHERE connection_id = ?`).all(connectionId).map((row) => [`${row.group_type}:${row.remote_id}`, { id: row.id, value: comparableGroup(row) }]))
    };
  }

  recordInventoryChanges(connectionId, before, syncData) {
    if (!before) return [];
    const events = [];
    const keyAfter = new Map(syncData.keys.map((key) => [String(key.remoteId), {
      status: key.status || 'unknown',
      expiresAt: key.expiresAt || null,
      primaryGroup: key.primaryGroupRef == null ? null : String(key.primaryGroupRef),
      backupGroup: key.backupGroupRef == null ? null : String(key.backupGroupRef),
      unlimited: Boolean(key.quota?.unlimited),
      quotaLimit: key.quota?.limit ?? null,
      metadata: stableMetadata(key.metadata || {})
    }]));
    const groupAfter = new Map(syncData.groups.map((group) => [`${group.type || 'key_route_group'}:${group.remoteId}`, {
      name: group.name || String(group.remoteId), ratio: group.ratio ?? null,
      status: group.status || 'active', metadata: stableMetadata(group.metadata || {})
    }]));

    for (const [remoteId, after] of keyAfter) {
      const previous = before.keys.get(remoteId);
      if (!previous) {
        events.push(this.#change(connectionId, 'key', null, remoteId, 'added', 'info', {}, after));
        continue;
      }
      const fields = changedFields(previous.value, after);
      if (fields.length > 0) {
        const severity = fields.some((field) => ['status', 'expiresAt', 'primaryGroup', 'backupGroup', 'unlimited'].includes(field)) ? 'warning' : 'info';
        events.push(this.#change(connectionId, 'key', previous.id, remoteId, 'updated', severity, previous.value, { ...after, changedFields: fields }));
      }
    }
    if (syncData.keysComplete) {
      for (const [remoteId, previous] of before.keys) {
        if (!keyAfter.has(remoteId)) events.push(this.#change(connectionId, 'key', previous.id, remoteId, 'removed', 'warning', previous.value, {}));
      }
    }

    for (const [remoteId, after] of groupAfter) {
      const previous = before.groups.get(remoteId);
      if (!previous) {
        events.push(this.#change(connectionId, 'group', null, remoteId, 'added', 'info', {}, after));
        continue;
      }
      const fields = changedFields(previous.value, after);
      if (fields.length > 0) {
        events.push(this.#change(connectionId, 'group', previous.id, remoteId, 'updated', fields.includes('ratio') ? 'warning' : 'info', previous.value, { ...after, changedFields: fields }));
      }
    }
    if (syncData.groupsComplete) {
      for (const [remoteId, previous] of before.groups) {
        if (!groupAfter.has(remoteId)) events.push(this.#change(connectionId, 'group', previous.id, remoteId, 'removed', 'warning', previous.value, {}));
      }
    }

    if (Object.keys(before.fingerprint).length > 0) {
      const fields = changedFields(
        comparableFingerprint(before.fingerprint),
        comparableFingerprint(syncData.probe || {})
      );
      if (fields.length > 0) {
        events.push(this.#change(connectionId, 'provider', connectionId, connectionId, 'contract_changed', 'warning', before.fingerprint, { ...(syncData.probe || {}), changedFields: fields }));
      }
    }
    return events;
  }

  #change(connectionId, assetType, assetId, remoteId, changeType, severity, before, after) {
    const event = {
      id: crypto.randomUUID(), connectionId, assetType, assetId, remoteId,
      changeType, severity, before, after, detectedAt: nowIso()
    };
    this.db.prepare(`
      INSERT INTO asset_change_events(
        id, connection_id, asset_type, asset_id, remote_id, change_type,
        severity, before_json, after_json, detected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(event.id, connectionId, assetType, assetId, remoteId, changeType, severity, stringifyJson(before), stringifyJson(after), event.detectedAt);
    return event;
  }

  analyzeConnection(connectionId) {
    const provider = this.db.prepare(`SELECT * FROM provider_connections WHERE id = ?`).get(connectionId);
    if (!provider) return [];
    const config = parseJson(provider.type_config_json, {});
    const globalConfig = Object.fromEntries(this.db.prepare(`
      SELECT key, value_json FROM settings WHERE key IN ('anomalyDropPercent', 'anomalySpikeMultiplier')
    `).all().map((row) => [row.key, parseJson(row.value_json, null)]));
    const currencies = this.db.prepare(`
      SELECT DISTINCT currency FROM balance_snapshots
      WHERE connection_id = ? AND subject_type = 'account'
    `).all(connectionId).map((row) => row.currency);
    const activeFingerprints = new Set();
    const anomalies = [];
    for (const currency of currencies) {
      const rows = this.db.prepare(`
        SELECT available, total, used, source_field, raw_json, captured_at FROM balance_snapshots
        WHERE connection_id = ? AND subject_type = 'account' AND currency = ?
          AND available IS NOT NULL ORDER BY captured_at DESC, id DESC LIMIT 12
      `).all(connectionId, currency);
      if (rows.length < 2) continue;
      const latest = rows[0];
      const previous = rows[1];
      const delta = Number(latest.available) - Number(previous.available);
      const dropPercent = Number(previous.available) === 0 ? 0 : (-delta / Math.abs(Number(previous.available))) * 100;
      if (delta < 0 && dropPercent >= Number(config.anomalyDropPercent || globalConfig.anomalyDropPercent || 20)) {
        anomalies.push(this.#anomaly({
          connectionId, type: 'balance_drop', currency, severity: dropPercent >= 50 ? 'error' : 'warning',
          message: `${provider.name} balance dropped ${dropPercent.toFixed(1)}% in ${currency}.`,
          score: dropPercent,
          details: { previous, latest, delta, dropPercent }
        }, activeFingerprints));
      }
      const usedDelta = latest.used == null || previous.used == null
        ? null
        : Number(latest.used) - Number(previous.used);
      if (delta < 0 && usedDelta != null && usedDelta <= 0) {
        anomalies.push(this.#anomaly({
          connectionId, type: 'balance_drop_without_usage', currency, severity: 'warning',
          message: `${provider.name} balance decreased without a matching usage increase.`,
          score: Math.abs(delta), details: { previous, latest, delta, usedDelta }
        }, activeFingerprints));
      }
      if (usedDelta != null && usedDelta < 0) {
        anomalies.push(this.#anomaly({
          connectionId, type: 'usage_counter_reset', currency, severity: 'info',
          message: `${provider.name} cumulative usage counter moved backwards or reset.`,
          score: Math.abs(usedDelta), details: { previous, latest, usedDelta }
        }, activeFingerprints));
      }
      if (latest.source_field !== previous.source_field && latest.source_field && previous.source_field) {
        anomalies.push(this.#anomaly({
          connectionId, type: 'balance_unit_or_source_changed', currency, severity: 'warning',
          message: `${provider.name} balance source field changed from ${previous.source_field} to ${latest.source_field}.`,
          score: null, details: { previousSource: previous.source_field, latestSource: latest.source_field }
        }, activeFingerprints));
      }
      if (usedDelta != null) {
        const keyTotals = this.db.prepare(`
          SELECT captured_at, SUM(used) used FROM balance_snapshots
          WHERE connection_id = ? AND subject_type = 'key' AND currency = ? AND used IS NOT NULL
          GROUP BY captured_at ORDER BY captured_at DESC LIMIT 2
        `).all(connectionId, currency);
        if (keyTotals.length >= 2) {
          const keyDelta = Number(keyTotals[0].used) - Number(keyTotals[1].used);
          const tolerance = Math.max(0.01, Math.abs(usedDelta) * Number(config.keyAccountUsageToleranceRatio || 0.1));
          if (keyDelta >= 0 && Math.abs(keyDelta - usedDelta) > tolerance) {
            anomalies.push(this.#anomaly({
              connectionId, type: 'key_account_usage_mismatch', currency, severity: 'warning',
              message: `${provider.name} key usage does not match account usage.`,
              score: Math.abs(keyDelta - usedDelta), details: { accountUsedDelta: usedDelta, keyUsedDelta: keyDelta, tolerance }
            }, activeFingerprints));
          }
        }
      }
      const intervals = [];
      for (let index = 0; index < rows.length - 1; index += 1) {
        const newer = rows[index];
        const older = rows[index + 1];
        const hours = (Date.parse(newer.captured_at) - Date.parse(older.captured_at)) / 3600000;
        if (hours > 0) intervals.push(Math.max(0, Number(older.available) - Number(newer.available)) / hours);
      }
      if (intervals.length >= 4) {
        const latestRate = intervals[0];
        const baseline = intervals.slice(1).reduce((sum, value) => sum + value, 0) / (intervals.length - 1);
        if (baseline > 0 && latestRate >= baseline * Number(config.anomalySpikeMultiplier || globalConfig.anomalySpikeMultiplier || 3)) {
          anomalies.push(this.#anomaly({
            connectionId, type: 'usage_spike', currency, severity: 'warning',
            message: `${provider.name} recent burn rate is ${(latestRate / baseline).toFixed(1)}x its baseline.`,
            score: latestRate / baseline, details: { latestRate, baseline }
          }, activeFingerprints));
        }
      }
    }
    const open = this.db.prepare(`SELECT id, fingerprint FROM anomaly_events WHERE connection_id = ? AND resolved_at IS NULL`).all(connectionId);
    for (const row of open) {
      if (!activeFingerprints.has(row.fingerprint)) {
        this.db.prepare(`UPDATE anomaly_events SET resolved_at = ? WHERE id = ?`).run(nowIso(), row.id);
      }
    }
    return anomalies;
  }

  #anomaly(input, activeFingerprints) {
    const fingerprint = `${input.connectionId}:${input.type}:${input.currency || 'none'}`;
    activeFingerprints.add(fingerprint);
    const existing = this.db.prepare(`SELECT id, detected_at FROM anomaly_events WHERE fingerprint = ?`).get(fingerprint);
    const id = existing?.id || crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO anomaly_events(
        id, connection_id, anomaly_type, severity, subject_type, subject_id,
        message, score, details_json, detected_at, fingerprint
      ) VALUES (?, ?, ?, ?, 'account', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(fingerprint) DO UPDATE SET severity = excluded.severity,
        message = excluded.message, score = excluded.score,
        details_json = excluded.details_json, resolved_at = NULL
    `).run(id, input.connectionId, input.type, input.severity, input.connectionId, input.message, input.score ?? null, stringifyJson(input.details || {}), existing?.detected_at || nowIso(), fingerprint);
    return { id, ...input, fingerprint };
  }

  listChanges({ connectionId, limit = 200 } = {}) {
    const rows = connectionId
      ? this.db.prepare(`SELECT * FROM asset_change_events WHERE connection_id = ? ORDER BY detected_at DESC LIMIT ?`).all(connectionId, limit)
      : this.db.prepare(`SELECT * FROM asset_change_events ORDER BY detected_at DESC LIMIT ?`).all(limit);
    return rows.map((row) => ({ ...row, before: parseJson(row.before_json, {}), after: parseJson(row.after_json, {}), before_json: undefined, after_json: undefined }));
  }

  listAnomalies({ connectionId, activeOnly = false, limit = 200 } = {}) {
    const clauses = [];
    const params = [];
    if (connectionId) { clauses.push('connection_id = ?'); params.push(connectionId); }
    if (activeOnly) clauses.push('resolved_at IS NULL');
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(limit);
    return this.db.prepare(`SELECT * FROM anomaly_events ${where} ORDER BY detected_at DESC LIMIT ?`).all(...params).map((row) => ({ ...row, details: parseJson(row.details_json, {}), details_json: undefined }));
  }
}

module.exports = {
  AnalysisService,
  changedFields,
  stableMetadata
};
