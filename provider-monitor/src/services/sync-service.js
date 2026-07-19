const crypto = require('crypto');
const { createAdapter } = require('../adapters/registry');
const { AppError, asAppError } = require('../errors');
const { nowIso, stringifyJson } = require('../db');
const { maskKey, redact, redactText } = require('../security/redaction');
const { upsertGroups } = require('./group-store');

function schemaShape(value, depth = 0) {
  if (depth >= 8) return 'depth-limit';
  if (value == null) return 'null';
  if (Array.isArray(value)) {
    if (value.length === 0) return ['unknown'];
    const shapes = value.slice(0, 20).map((item) => schemaShape(item, depth + 1));
    const unique = [...new Map(shapes.map((shape) => [JSON.stringify(shape), shape])).values()];
    return unique.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (typeof value !== 'object') return typeof value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, schemaShape(value[key], depth + 1)])
  );
}

function schemaComponent(value, previous) {
  if (Array.isArray(value) && value.length === 0 && previous) return previous;
  return schemaShape(value);
}

class SyncService {
  constructor({ db, config, providers, http, metrics, analysis, onCompleted }) {
    this.db = db;
    this.config = config;
    this.providers = providers;
    this.http = http;
    this.metrics = metrics;
    this.analysis = analysis;
    this.onCompleted = onCompleted || (async () => {});
    this.inFlight = new Map();
  }

  async #optional(label, operation, warnings) {
    try {
      return { ok: true, value: await operation() };
    } catch (error) {
      const appError = asAppError(error);
      if (appError.code === 'INTERNAL_ERROR') throw appError;
      warnings.push({ capability: label, code: appError.code, message: redactText(appError.message) });
      return { ok: false, value: [] };
    }
  }

  run(connectionId, options = {}) {
    const existing = this.inFlight.get(connectionId);
    if (existing) return existing;
    const operation = this.#run(connectionId, options).finally(() => {
      if (this.inFlight.get(connectionId) === operation) this.inFlight.delete(connectionId);
    });
    this.inFlight.set(connectionId, operation);
    return operation;
  }

  #nextCheckAt(connection) {
    const baseDelay = connection.refresh_interval_minutes * 60000;
    const configured = Number(connection.type_config_json?.refreshJitterPercent ?? 0.2);
    const jitterPercent = Math.min(0.2, Math.max(0, Number.isFinite(configured) ? configured : 0.2));
    return new Date(Date.now() + baseDelay + Math.random() * baseDelay * jitterPercent).toISOString();
  }

  #assertCircuitClosed(connection) {
    const threshold = Math.min(20, Math.max(2, Number(connection.type_config_json?.circuitFailureThreshold || 5)));
    const cooldownMinutes = Math.min(1440, Math.max(1, Number(connection.type_config_json?.circuitCooldownMinutes || 15)));
    const rows = this.db.prepare(`
      SELECT status, error_code, completed_at, started_at FROM check_runs
      WHERE connection_id = ? AND job_type IN ('provider_sync', 'manual_sync', 'manual_refresh')
      ORDER BY started_at DESC LIMIT ?
    `).all(connection.id, threshold);
    if (rows.length < threshold || rows.some((row) => row.status !== 'failed')) return;
    const lastFailureAt = Date.parse(rows[0].completed_at || rows[0].started_at);
    const openUntil = lastFailureAt + cooldownMinutes * 60000;
    if (!Number.isFinite(openUntil) || openUntil <= Date.now()) return;
    const codes = rows.map((row) => row.error_code).filter(Boolean);
    const reason = codes.every((code) => ['AUTH_FAILED', 'AUTH_EXPIRED', 'PERMISSION_DENIED'].includes(code))
      ? 'authentication'
      : codes.every((code) => ['SCHEMA_MISMATCH', 'BUSINESS_ERROR'].includes(code))
        ? 'contract'
        : 'availability';
    this.db.prepare(`UPDATE provider_connections SET next_check_at = ?, updated_at = ? WHERE id = ?`)
      .run(new Date(openUntil).toISOString(), nowIso(), connection.id);
    throw new AppError(
      'CIRCUIT_OPEN',
      `Provider circuit is open until ${new Date(openUntil).toISOString()}`,
      { status: 503, details: { reason, failureCount: rows.length, openUntil: new Date(openUntil).toISOString() } }
    );
  }

  async #run(connectionId, options = {}) {
    const connection = this.providers.get(connectionId, { forAdapter: true });
    if (!options.manual) this.#assertCircuitClosed(connection);
    const credentials = this.providers.getCredentials(connection);
    const runId = crypto.randomUUID();
    const startedAt = nowIso();
    const started = Date.now();
    const inventoryBefore = this.analysis?.captureInventory(connectionId);
    this.db.prepare(`
      INSERT INTO check_runs(id, job_type, connection_id, status, started_at)
      VALUES (?, ?, ?, 'running', ?)
    `).run(runId, options.jobType || 'provider_sync', connectionId, startedAt);

    try {
      const adapter = createAdapter(connection.adapter_type, {
        connection,
        credentials,
        http: this.http,
        config: this.config,
        onCredentialsUpdated: async (nextCredentials) => {
          this.providers.updateCredentials(connection, nextCredentials);
        }
      });
      const warnings = [];
      let probe;
      try {
        probe = await adapter.probe();
      } catch (error) {
        const appError = asAppError(error);
        warnings.push({ capability: 'probe', code: appError.code, message: appError.message });
        probe = {
          adapterType: connection.adapter_type,
          detectedFamily: connection.adapter_type,
          version: null,
          capabilities: adapter.capabilities()
        };
      }
      const account = await adapter.getAccount();
      const balances = await adapter.getAccountBalances(account);
      const groupsResult = await this.#optional('listGroups', () => adapter.listGroups(), warnings);
      const keysResult = await this.#optional('listKeys', () => adapter.listKeys(), warnings);
      const usageResult = await this.#optional('getUsage', () => adapter.getUsage(), warnings);
      const groupsComplete = groupsResult.ok &&
        (!probe.capabilities?.groupsDerivedFromKeys || keysResult.ok);
      if (keysResult.ok) {
        const knownGroupRefs = new Set(groupsResult.value.map((group) => String(group.remoteId)));
        for (const key of keysResult.value) {
          const refs = [key.primaryGroupRef, key.backupGroupRef, ...(key.additionalGroupRefs || [])];
          for (const ref of refs) {
            if (ref == null || ref === '' || knownGroupRefs.has(String(ref))) continue;
            knownGroupRefs.add(String(ref));
            groupsResult.value.push({
              remoteId: String(ref),
              type: 'key_route_group',
              name: String(ref),
              ratio: null,
              status: 'active',
              metadata: { derivedFromKey: true }
            });
          }
        }
      }
      const capturedAt = nowIso();
      const previousSchemas = connection.fingerprint?.schemas || {};
      const schemas = {
        probe: schemaComponent(probe, previousSchemas.probe),
        account: schemaComponent(account, previousSchemas.account),
        balances: schemaComponent(balances, previousSchemas.balances),
        groups: groupsResult.ok
          ? schemaComponent(groupsResult.value, previousSchemas.groups)
          : previousSchemas.groups || ['unknown'],
        keys: keysResult.ok
          ? schemaComponent(keysResult.value, previousSchemas.keys)
          : previousSchemas.keys || ['unknown'],
        usage: usageResult.ok
          ? schemaComponent(usageResult.value, previousSchemas.usage)
          : previousSchemas.usage || ['unknown']
      };
      const fingerprint = {
        ...probe,
        responseSchemaHash: crypto.createHash('sha256').update(JSON.stringify(schemas)).digest('hex'),
        schemas,
        detectedAt: capturedAt
      };
      const result = this.#persist(connection, {
        probe: fingerprint,
        account,
        balances,
        groups: groupsResult.value,
        groupsComplete,
        keys: keysResult.value,
        keysComplete: keysResult.ok,
        usage: usageResult.value,
        capturedAt,
        warnings
      });
      this.analysis?.recordInventoryChanges(connectionId, inventoryBefore, {
        probe: fingerprint,
        groups: groupsResult.value,
        groupsComplete,
        keys: keysResult.value,
        keysComplete: keysResult.ok
      });
      this.analysis?.analyzeConnection(connectionId);
      try {
        await this.onCompleted({ connectionId, runId, status: warnings.length ? 'partial' : 'succeeded', summary: result });
      } catch (error) {
        const appError = asAppError(error, 'POST_SYNC_FAILED');
        warnings.push({ capability: 'postSync', code: appError.code, message: redactText(appError.message) });
      }
      const duration = Date.now() - started;
      const status = warnings.length > 0 ? 'partial' : 'succeeded';
      const summary = { ...result, warnings };
      this.db.prepare(`
        UPDATE check_runs SET status = ?, completed_at = ?, duration_ms = ?, summary_json = ?
        WHERE id = ?
      `).run(status, nowIso(), duration, stringifyJson(summary), runId);
      this.metrics?.recordSync(connection.adapter_type, status, duration / 1000);
      return { runId, status, ...summary };
    } catch (error) {
      const appError = asAppError(error, 'PROVIDER_SYNC_FAILED');
      const duration = Date.now() - started;
      this.db.transaction(() => {
        this.db.prepare(`
          UPDATE check_runs SET status = 'failed', completed_at = ?, duration_ms = ?,
            http_status = ?, error_code = ?, error_message = ?, summary_json = ?
          WHERE id = ?
        `).run(
          nowIso(),
          duration,
          appError.status || null,
          appError.code,
          redactText(appError.message),
          stringifyJson({ details: redact(appError.details || {}) }),
          runId
        );
        this.db.prepare(`
          UPDATE provider_connections SET last_sync_at = ?, last_error_code = ?,
            last_error_message = ?, next_check_at = ?, updated_at = ? WHERE id = ?
        `).run(
          nowIso(),
          appError.code,
          redactText(appError.message),
          this.#nextCheckAt(connection),
          nowIso(),
          connectionId
        );
      })();
      this.metrics?.recordSync(connection.adapter_type, 'failed', duration / 1000);
      throw appError;
    }
  }

  #persist(connection, data) {
    const transaction = this.db.transaction(() => {
      const accountId = this.#upsertAccount(connection.id, data.account, data.capturedAt);
      this.#upsertGroups(connection.id, data.groups, data.capturedAt, data.groupsComplete);
      this.#upsertKeys(connection.id, accountId, data.keys, data.capturedAt, data.keysComplete);
      if (data.keysComplete) this.#replaceKeyGroupRelations(connection.id, data.keys);
      this.#insertSnapshots(connection.id, accountId, data.balances, data.groups, data.keys, data.capturedAt);
      this.#insertUsage(connection.id, accountId, data.usage || [], data.capturedAt);

      const nextCheckAt = this.#nextCheckAt(connection);
      this.db.prepare(`
        UPDATE provider_connections SET remote_user_id = ?, capabilities_json = ?,
          fingerprint_json = ?, last_sync_at = ?, last_success_at = ?,
          last_error_code = NULL, last_error_message = NULL, next_check_at = ?, updated_at = ?
        WHERE id = ?
      `).run(
        data.account.remoteId,
        stringifyJson(data.probe.capabilities || {}),
        stringifyJson(data.probe),
        data.capturedAt,
        data.capturedAt,
        nextCheckAt,
        data.capturedAt,
        connection.id
      );
      return {
        accountId,
        balanceCount: data.balances.length,
        groupCount: data.groups.length,
        keyCount: data.keys.length,
        usageCount: (data.usage || []).length,
        capturedAt: data.capturedAt
      };
    });
    return transaction();
  }

  #upsertAccount(connectionId, account, capturedAt) {
    const existing = this.db.prepare(`
      SELECT id FROM remote_accounts WHERE connection_id = ? AND remote_id = ?
    `).get(connectionId, String(account.remoteId));
    const id = existing?.id || crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO remote_accounts(
        id, connection_id, remote_id, display_name, user_group, status,
        metadata_json, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(connection_id, remote_id) DO UPDATE SET
        display_name = excluded.display_name, user_group = excluded.user_group,
        status = excluded.status, metadata_json = excluded.metadata_json,
        last_seen_at = excluded.last_seen_at
    `).run(
      id,
      connectionId,
      String(account.remoteId),
      account.displayName || String(account.remoteId),
      account.userGroup || null,
      account.status || 'unknown',
      stringifyJson(account.metadata || {}),
      capturedAt,
      capturedAt
    );
    return id;
  }

  #upsertGroups(connectionId, groups, capturedAt, complete) {
    upsertGroups(this.db, connectionId, groups, capturedAt, { complete });
  }

  #upsertKeys(connectionId, accountId, keys, capturedAt, complete) {
    const seen = [];
    const statement = this.db.prepare(`
      INSERT INTO remote_keys(
        id, connection_id, remote_account_id, remote_id, name, masked_key, status,
        primary_group_ref, backup_group_ref, unlimited, quota_limit, quota_used,
        quota_remaining, currency, expires_at, last_used_at, metadata_json,
        first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(connection_id, remote_id) DO UPDATE SET
        remote_account_id = excluded.remote_account_id, name = excluded.name,
        masked_key = excluded.masked_key, status = excluded.status,
        primary_group_ref = excluded.primary_group_ref,
        backup_group_ref = excluded.backup_group_ref, unlimited = excluded.unlimited,
        quota_limit = excluded.quota_limit, quota_used = excluded.quota_used,
        quota_remaining = excluded.quota_remaining, currency = excluded.currency,
        expires_at = excluded.expires_at, last_used_at = excluded.last_used_at,
        metadata_json = excluded.metadata_json, last_seen_at = excluded.last_seen_at
    `);
    for (const key of keys) {
      const remoteId = String(key.remoteId);
      seen.push(remoteId);
      statement.run(
        crypto.randomUUID(),
        connectionId,
        accountId,
        remoteId,
        key.name || remoteId,
        maskKey(key.maskedKey || ''),
        key.status || 'unknown',
        key.primaryGroupRef == null ? null : String(key.primaryGroupRef),
        key.backupGroupRef == null ? null : String(key.backupGroupRef),
        key.quota?.unlimited ? 1 : 0,
        key.quota?.limit ?? null,
        key.quota?.used ?? null,
        key.quota?.remaining ?? null,
        key.quota?.currency || null,
        key.expiresAt || null,
        key.lastUsedAt || null,
        stringifyJson(key.metadata || {}),
        capturedAt,
        capturedAt
      );
    }
    if (complete) {
      if (seen.length === 0) {
        this.db.prepare("UPDATE remote_keys SET status = 'missing' WHERE connection_id = ?").run(connectionId);
      } else {
        const placeholders = seen.map(() => '?').join(',');
        this.db.prepare(`
          UPDATE remote_keys SET status = 'missing'
          WHERE connection_id = ? AND remote_id NOT IN (${placeholders})
        `).run(connectionId, ...seen);
      }
    }
  }

  #replaceKeyGroupRelations(connectionId, keys) {
    const groups = this.db.prepare(`
      SELECT id, remote_id, name FROM remote_groups WHERE connection_id = ?
    `).all(connectionId);
    const byRef = new Map();
    for (const group of groups) {
      byRef.set(String(group.remote_id), group.id);
      byRef.set(String(group.name), group.id);
    }
    const keyRows = this.db.prepare(`
      SELECT id, remote_id FROM remote_keys WHERE connection_id = ?
    `).all(connectionId);
    const keyByRemote = new Map(keyRows.map((row) => [String(row.remote_id), row.id]));
    this.db.prepare(`
      DELETE FROM remote_key_groups WHERE key_id IN (
        SELECT id FROM remote_keys WHERE connection_id = ?
      )
    `).run(connectionId);
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO remote_key_groups(key_id, group_id, relation_type)
      VALUES (?, ?, ?)
    `);
    for (const key of keys) {
      const keyId = keyByRemote.get(String(key.remoteId));
      if (!keyId) continue;
      const refs = [
        [key.primaryGroupRef, 'primary'],
        [key.backupGroupRef, 'backup'],
        ...((key.additionalGroupRefs || []).map((ref) => [ref, 'additional']))
      ];
      for (const [ref, relation] of refs) {
        if (ref == null) continue;
        const groupId = byRef.get(String(ref));
        if (groupId) insert.run(keyId, groupId, relation);
      }
    }
  }

  #insertSnapshots(connectionId, accountId, balances, groups, keys, capturedAt) {
    const insert = this.db.prepare(`
      INSERT INTO balance_snapshots(
        connection_id, subject_type, subject_id, currency, available, total,
        used, granted, topped_up, frozen, unlimited, source_field, raw_json, captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const balance of balances) {
      insert.run(
        connectionId,
        balance.scope || 'account',
        accountId,
        balance.currency || 'USD',
        balance.available ?? null,
        balance.total ?? null,
        balance.used ?? null,
        balance.granted ?? null,
        balance.toppedUp ?? null,
        balance.frozen ?? null,
        balance.unlimited ? 1 : 0,
        balance.sourceField || null,
        stringifyJson(balance.raw || {}),
        capturedAt
      );
    }
    const groupIdQuery = this.db.prepare(`
      SELECT id FROM remote_groups WHERE connection_id = ? AND group_type = ? AND remote_id = ?
    `);
    for (const group of groups) {
      const maxBudget = Number(group.metadata?.max_budget);
      const spend = Number(group.metadata?.spend);
      if (!Number.isFinite(maxBudget) && !Number.isFinite(spend)) continue;
      const row = groupIdQuery.get(connectionId, group.type || 'key_route_group', String(group.remoteId));
      if (!row) continue;
      const unlimited = !Number.isFinite(maxBudget) || maxBudget <= 0;
      insert.run(
        connectionId,
        group.type === 'team' ? 'team' : 'group',
        row.id,
        group.metadata?.currency || 'USD',
        unlimited ? null : Math.max(0, maxBudget - (Number.isFinite(spend) ? spend : 0)),
        unlimited ? null : maxBudget,
        Number.isFinite(spend) ? spend : null,
        null,
        null,
        null,
        unlimited ? 1 : 0,
        'group.metadata.max_budget',
        stringifyJson({ budgetDuration: group.metadata?.budget_duration, budgetResetAt: group.metadata?.budget_reset_at }),
        capturedAt
      );
    }
    const keyIdQuery = this.db.prepare(`
      SELECT id FROM remote_keys WHERE connection_id = ? AND remote_id = ?
    `);
    for (const key of keys) {
      if (!key.quota) continue;
      const row = keyIdQuery.get(connectionId, String(key.remoteId));
      if (!row) continue;
      insert.run(
        connectionId,
        'key',
        row.id,
        key.quota.currency || 'USD',
        key.quota.remaining ?? null,
        key.quota.limit ?? null,
        key.quota.used ?? null,
        null,
        null,
        null,
        key.quota.unlimited ? 1 : 0,
        'key.quota.remaining',
        stringifyJson({ resetAt: key.quota.resetAt, resetInterval: key.quota.resetInterval }),
        capturedAt
      );
    }
  }

  #insertUsage(connectionId, accountId, usage, capturedAt) {
    const insert = this.db.prepare(`
      INSERT INTO usage_snapshots(
        connection_id, subject_type, subject_id, currency, cost, requests,
        input_tokens, output_tokens, total_tokens, model, period, raw_json, captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of usage) {
      insert.run(
        connectionId,
        item.scope || 'account',
        item.scope === 'account' ? accountId : item.remoteSubjectId || null,
        item.currency || 'USD',
        item.cost ?? null,
        item.requests ?? null,
        item.inputTokens ?? null,
        item.outputTokens ?? null,
        item.totalTokens ?? null,
        item.model || null,
        item.period || 'cumulative',
        stringifyJson(item.raw || {}),
        capturedAt
      );
    }
  }
}

module.exports = {
  SyncService,
  schemaShape
};
