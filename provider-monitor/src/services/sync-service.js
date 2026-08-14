const crypto = require('crypto');
const { createAdapter } = require('../adapters/registry');
const { AppError, asAppError } = require('../errors');
const { nowIso, parseJson, stringifyJson } = require('../db');
const { maskKey, redact, redactText } = require('../security/redaction');
const { upsertGroups } = require('./group-store');
const { normalizeDynamicRouteConfig } = require('./dynamic-route-rate');

function monitoredRemoteKeyIds(connection) {
  const supportsSelection =
    (connection.adapter_type === 'new-api' && connection.auth_mode === 'api_key') ||
    (connection.adapter_type === 'sub2api' &&
      ['account', 'token_pair', 'bearer', 'api_key'].includes(connection.auth_mode));
  if (!supportsSelection) return null;
  const configured = connection.type_config_json?.monitoredKeyIds;
  if (!Array.isArray(configured)) return null;
  return new Set(configured.map((value) => String(value || '').trim()).filter(Boolean));
}

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
      return {
        ok: false,
        value: [],
        error: { code: appError.code, message: redactText(appError.message) }
      };
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

  #requestLogIncrementalOptions(connectionId, keys, options = {}) {
    const lookbackDays = Math.min(90, Math.max(1, Number(options.lookbackDays) || 30));
    const overlapMinutes = Math.min(
      1440,
      Math.max(1, Number(options.incrementalOverlapMinutes) || 60)
    );
    const oldest = Date.now() - lookbackDays * 86400000;
    const rows = this.db.prepare(`
      SELECT key_identity, MAX(last_at) AS latest_at
      FROM provider_cost_rollups
      WHERE connection_id = ?
      GROUP BY key_identity
    `).all(connectionId);
    const latestByIdentity = new Map(
      rows.filter((row) => row.latest_at).map((row) => [String(row.key_identity), row.latest_at])
    );
    const sinceByKey = {};
    for (const key of keys) {
      const keyIdentity = String(key.metadata?.identityHash || key.remoteId || '');
      const latest = Date.parse(latestByIdentity.get(keyIdentity) || '');
      const timestamp = Number.isFinite(latest)
        ? Math.max(oldest, latest - overlapMinutes * 60000)
        : oldest;
      sinceByKey[String(key.remoteId)] = new Date(timestamp).toISOString();
    }
    const since = Object.values(sinceByKey).sort()[0] || new Date(oldest).toISOString();
    return { lookbackDays, since, sinceByKey };
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
      const rechargeResult = probe.capabilities?.rechargeQuote
        ? await this.#optional('getRechargeQuote', () => adapter.getRechargeQuote(), warnings)
        : { ok: true, value: null };
      const monitoredKeyIds = monitoredRemoteKeyIds(connection);
      if (keysResult.ok && monitoredKeyIds) {
        const availableIds = new Set(keysResult.value.map((key) => String(key.remoteId)));
        const missingIds = [...monitoredKeyIds].filter((remoteId) => !availableIds.has(remoteId));
        for (const remoteId of missingIds) {
          warnings.push({
            capability: 'configuredApiKey',
            code: 'MONITORED_KEY_NOT_FOUND',
            message: `Configured API Key ${remoteId} was not returned by the provider`
          });
        }
        keysResult.value = keysResult.value.filter((key) => monitoredKeyIds.has(String(key.remoteId)));
      }
      const mappedRemoteKeyIds = connection.adapter_type === 'sub2api'
        ? new Set(this.db.prepare(`
            SELECT DISTINCT k.remote_id
            FROM sub2api_mappings m
            JOIN remote_keys k ON k.id = m.key_id
            WHERE m.connection_id = ? AND m.enabled = 1 AND k.status != 'missing'
          `).all(connectionId).map((row) => String(row.remote_id)))
        : null;
      const requestLogKeys = keysResult.ok
        ? connection.adapter_type === 'sub2api' && monitoredKeyIds == null
          ? keysResult.value.filter((key) => mappedRemoteKeyIds.has(String(key.remoteId)))
          : keysResult.value
        : [];
      const requestLogOptions = connection.type_config_json?.requestLogs || {};
      const incrementalRequestLogOptions = this.#requestLogIncrementalOptions(
        connectionId,
        requestLogKeys,
        requestLogOptions
      );
      const shouldLoadRequestLogs = probe.capabilities?.requestLogs &&
        (connection.adapter_type !== 'sub2api' || requestLogKeys.length > 0);
      const requestLogResult = shouldLoadRequestLogs
        ? await this.#optional('getRequestLogs', () => adapter.getRequestLogs({
            ...incrementalRequestLogOptions,
            maxRecords: requestLogOptions.maxRecords || 10000,
            keys: requestLogKeys,
            restrictToKeys: monitoredKeyIds != null || mappedRemoteKeyIds?.size > 0
          }), warnings)
        : null;
      if (requestLogResult?.ok && Array.isArray(requestLogResult.value?.keyCoverage)) {
        const unavailableKeys = requestLogResult.value.keyCoverage.filter(
          (item) => item.status !== 'succeeded'
        );
        if (unavailableKeys.length > 0) {
          warnings.push({
            capability: 'getRequestLogs',
            code: 'REQUEST_LOG_KEYS_PARTIAL',
            message: `${unavailableKeys.length} monitored API Key(s) did not return request logs`
          });
        }
      }
      const providerDynamicRouteConfig = connection.type_config_json?.dynamicRouteRate;
      const officialModelPrices = parseJson(
        this.db.prepare(`SELECT value_json FROM settings WHERE key = 'officialModelPrices'`).get()?.value_json,
        {}
      );
      const dynamicRouteConfig = normalizeDynamicRouteConfig({
        ...(providerDynamicRouteConfig === true
          ? { enabled: true }
          : providerDynamicRouteConfig || {}),
        officialModelPrices
      });
      dynamicRouteConfig.restrictToKeys = monitoredKeyIds != null;
      let dynamicRouteResult = null;
      if (dynamicRouteConfig.enabled) {
        if (probe.capabilities?.dynamicRouteRates) {
          const dynamicRouteRequestLogs = requestLogResult?.ok
            ? await this.#optional(
                'getDynamicRouteRequestLogs',
                () => adapter.getRequestLogs({
                  lookbackDays: dynamicRouteConfig.lookbackDays,
                  maxRecords: requestLogOptions.maxRecords || 10000,
                  keys: requestLogKeys,
                  restrictToKeys: dynamicRouteConfig.restrictToKeys
                }),
                warnings
              )
            : null;
          dynamicRouteResult = await this.#optional(
            'getDynamicRouteRates',
            () => adapter.getDynamicRouteRates({
              ...dynamicRouteConfig,
              keys: keysResult.ok ? keysResult.value : [],
              restrictToKeys: dynamicRouteConfig.restrictToKeys,
              requestLogs: dynamicRouteRequestLogs?.ok
                ? dynamicRouteRequestLogs.value
                : undefined
            }),
            warnings
          );
        } else {
          const error = {
            code: 'CAPABILITY_UNSUPPORTED',
            message: 'Provider adapter does not expose dynamic route billing logs'
          };
          warnings.push({ capability: 'getDynamicRouteRates', ...error });
          dynamicRouteResult = { ok: false, value: [], error };
        }
      }
      const groupsComplete = groupsResult.ok &&
        adapter.groupListComplete !== false &&
        (!probe.capabilities?.groupsDerivedFromKeys || keysResult.ok);
      if (keysResult.ok) {
        for (const key of keysResult.value) {
          const monitoringErrors = [key.metadata?.usageError, key.metadata?.billingError].filter(Boolean);
          if (monitoringErrors.length === 0) continue;
          warnings.push({
            capability: 'configuredApiKey',
            code: monitoringErrors[0],
            message: `Configured API Key ${key.name || key.remoteId} could not be fully monitored`
          });
        }
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
              metadata: { derivedFromKey: true, selectable: false }
            });
          }
        }
      }
      const capturedAt = nowIso();
      const mappingSnapshot = {
        capturedAt,
        groupsComplete,
        keysComplete: keysResult.ok,
        rechargeRequired: Boolean(probe.capabilities?.rechargeQuote),
        rechargeComplete: !probe.capabilities?.rechargeQuote || rechargeResult.ok,
        dynamicRouteRequired: Boolean(dynamicRouteConfig.enabled),
        dynamicRouteComplete: !dynamicRouteConfig.enabled || Boolean(dynamicRouteResult?.ok),
        configuredKeysComplete: !warnings.some((warning) => warning.capability === 'configuredApiKey')
      };
      mappingSnapshot.ready = mappingSnapshot.groupsComplete &&
        mappingSnapshot.keysComplete &&
        mappingSnapshot.rechargeComplete &&
        mappingSnapshot.dynamicRouteComplete &&
        mappingSnapshot.configuredKeysComplete;
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
          : previousSchemas.usage || ['unknown'],
        requestLogs: requestLogResult?.ok
          ? schemaComponent(requestLogResult.value?.items || [], previousSchemas.requestLogs)
          : previousSchemas.requestLogs || ['unknown'],
        recharge: rechargeResult.ok
          ? schemaComponent(rechargeResult.value, previousSchemas.recharge)
          : previousSchemas.recharge || ['unknown'],
        dynamicRouteRates: dynamicRouteResult?.ok
          ? schemaComponent(dynamicRouteResult.value, previousSchemas.dynamicRouteRates)
          : previousSchemas.dynamicRouteRates || ['unknown']
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
        requestLogs: requestLogResult,
        requestLogKeys,
        recharge: rechargeResult.ok ? rechargeResult.value : null,
        dynamicRoute: dynamicRouteResult,
        dynamicRouteConfig,
        mappingSnapshot,
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
      const requestLogCount = this.#insertRequestLogs(
        connection.id,
        data.requestLogs,
        data.capturedAt,
        data.requestLogKeys || data.keys
      );
      if (data.recharge) this.providers.recordRecharge(connection.id, data.recharge, data.capturedAt);
      const dynamicRouteKeyCount = this.#recordDynamicRouteRates(
        connection.id,
        data.dynamicRoute,
        data.dynamicRouteConfig,
        data.capturedAt
      );

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
        requestLogCount,
        dynamicRouteKeyCount,
        mappingSnapshot: data.mappingSnapshot,
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

  #recordDynamicRouteRates(connectionId, result, config, capturedAt) {
    if (!config?.enabled || !result) return 0;
    if (!result.ok) {
      this.db.prepare(`
        UPDATE provider_dynamic_route_rates
        SET status = 'unavailable', error_code = ?, checked_at = ?, updated_at = ?
        WHERE connection_id = ?
      `).run(result.error?.code || 'DYNAMIC_ROUTE_RATE_UNAVAILABLE', capturedAt, capturedAt, connectionId);
      return 0;
    }

    const keyByRemoteId = this.db.prepare(`
      SELECT id, remote_id FROM remote_keys WHERE connection_id = ?
    `).all(connectionId).reduce((map, row) => map.set(String(row.remote_id), row.id), new Map());
    const upsert = this.db.prepare(`
      INSERT INTO provider_dynamic_route_rates(
        key_id, connection_id, selected_multiplier, statistic, sample_count,
        min_multiplier, median_multiplier, p90_multiplier, max_multiplier,
        weighted_average_multiplier, latest_multiplier, status, error_code,
        summary_json, observed_from, observed_to, checked_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
      ON CONFLICT(key_id) DO UPDATE SET
        connection_id = excluded.connection_id,
        selected_multiplier = excluded.selected_multiplier,
        statistic = excluded.statistic,
        sample_count = excluded.sample_count,
        min_multiplier = excluded.min_multiplier,
        median_multiplier = excluded.median_multiplier,
        p90_multiplier = excluded.p90_multiplier,
        max_multiplier = excluded.max_multiplier,
        weighted_average_multiplier = excluded.weighted_average_multiplier,
        latest_multiplier = excluded.latest_multiplier,
        status = excluded.status,
        error_code = NULL,
        summary_json = excluded.summary_json,
        observed_from = excluded.observed_from,
        observed_to = excluded.observed_to,
        checked_at = excluded.checked_at,
        updated_at = excluded.updated_at
    `);
    let count = 0;
    for (const item of result.value || []) {
      const keyId = keyByRemoteId.get(String(item.remoteKeyId));
      if (!keyId) continue;
      upsert.run(
        keyId,
        connectionId,
        item.selectedMultiplier ?? null,
        item.statistic || config.statistic,
        item.sampleCount || 0,
        item.minMultiplier ?? null,
        item.medianMultiplier ?? null,
        item.p90Multiplier ?? null,
        item.maxMultiplier ?? null,
        item.weightedAverageMultiplier ?? null,
        item.latestMultiplier ?? null,
        item.status || 'unknown',
        stringifyJson({
          latest: item.latest || null,
          latestObserved: item.latestObserved || null,
          models: item.models || [],
          channels: item.channels || [],
          source: 'provider_request_logs',
          priceBasis: item.priceBasis || config.priceBasis,
          quotaPerUnit: item.quotaPerUnit || null,
          totalObservationCount: item.totalObservationCount || 0,
          providerPriceMissingCount: item.providerPriceMissingCount || 0,
          providerPriceMissingModels: item.providerPriceMissingModels || [],
          referenceMissingCount: item.referenceMissingCount || 0,
          referenceMissingModels: item.referenceMissingModels || [],
          lookbackDays: config.lookbackDays,
          minimumSamples: config.minimumSamples
        }),
        item.observedFrom || null,
        item.observedTo || null,
        capturedAt,
        capturedAt
      );
      count += 1;
    }
    if (config.restrictToKeys) {
      this.db.prepare(`
        UPDATE provider_dynamic_route_rates
        SET selected_multiplier = NULL, sample_count = 0, status = 'not_monitored',
          error_code = NULL, checked_at = ?, updated_at = ?
        WHERE connection_id = ? AND key_id IN (
          SELECT id FROM remote_keys WHERE connection_id = ? AND status = 'missing'
        )
      `).run(capturedAt, capturedAt, connectionId, connectionId);
    }
    return count;
  }

  #upsertGroups(connectionId, groups, capturedAt, complete) {
    upsertGroups(this.db, connectionId, groups, capturedAt, { complete });
  }

  #upsertKeys(connectionId, accountId, keys, capturedAt, complete) {
    const seen = [];
    const existingByRemoteId = this.db.prepare(`
      SELECT remote_id, status, primary_group_ref, backup_group_ref, unlimited,
        quota_limit, quota_used, quota_remaining, currency, expires_at, last_used_at
      FROM remote_keys WHERE connection_id = ?
    `).all(connectionId).reduce(
      (map, row) => map.set(String(row.remote_id), row),
      new Map()
    );
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
      const existing = existingByRemoteId.get(remoteId);
      const preserveUsage = Boolean(key.metadata?.usageError && existing);
      const preserveBilling = Boolean(key.metadata?.billingError && existing);
      seen.push(remoteId);
      statement.run(
        crypto.randomUUID(),
        connectionId,
        accountId,
        remoteId,
        key.name || remoteId,
        maskKey(key.maskedKey || ''),
        preserveUsage ? existing.status : key.status || 'unknown',
        preserveBilling
          ? existing.primary_group_ref
          : key.primaryGroupRef == null ? null : String(key.primaryGroupRef),
        preserveBilling
          ? existing.backup_group_ref
          : key.backupGroupRef == null ? null : String(key.backupGroupRef),
        preserveUsage ? existing.unlimited : key.quota?.unlimited ? 1 : 0,
        preserveUsage ? existing.quota_limit : key.quota?.limit ?? null,
        preserveUsage ? existing.quota_used : key.quota?.used ?? null,
        preserveUsage ? existing.quota_remaining : key.quota?.remaining ?? null,
        preserveUsage ? existing.currency : key.quota?.currency || null,
        preserveUsage ? existing.expires_at : key.expiresAt || null,
        preserveUsage ? existing.last_used_at : key.lastUsedAt || null,
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
        stringifyJson({
          resetAt: key.quota.resetAt,
          resetInterval: key.quota.resetInterval,
          monitorMetrics: {
            credentialIdentity: key.metadata?.identityHash || null
          }
        }),
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
    const keyIdByRemoteId = this.db.prepare(`
      SELECT id, remote_id FROM remote_keys WHERE connection_id = ?
    `).all(connectionId).reduce(
      (map, row) => map.set(String(row.remote_id), row.id),
      new Map()
    );
    for (const item of usage) {
      const subjectId = item.scope === 'account'
        ? accountId
        : item.scope === 'key'
          ? keyIdByRemoteId.get(String(item.remoteSubjectId)) || item.remoteSubjectId || null
          : item.remoteSubjectId || null;
      insert.run(
        connectionId,
        item.scope || 'account',
        subjectId,
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

  #insertRequestLogs(connectionId, result, capturedAt, keys = []) {
    if (!result) return 0;
    const keyIdByRemoteId = this.db.prepare(`
      SELECT id, remote_id FROM remote_keys WHERE connection_id = ?
    `).all(connectionId).reduce(
      (map, row) => map.set(String(row.remote_id), row.id),
      new Map()
    );
    const keyIdentityByRemoteId = this.db.prepare(`
      SELECT remote_id, COALESCE(
        NULLIF(json_extract(metadata_json, '$.identityHash'), ''),
        NULLIF(remote_id, ''),
        id
      ) AS key_identity
      FROM remote_keys WHERE connection_id = ?
    `).all(connectionId).reduce(
      (map, row) => map.set(String(row.remote_id), String(row.key_identity)),
      new Map()
    );
    const markKeyUnavailable = this.db.prepare(`
      INSERT INTO provider_request_key_sync_state(
        key_id, connection_id, status, last_error_code, last_error_message, updated_at
      ) VALUES (?, ?, 'unavailable', ?, ?, ?)
      ON CONFLICT(key_id) DO UPDATE SET
        status = excluded.status,
        last_error_code = excluded.last_error_code,
        last_error_message = excluded.last_error_message,
        updated_at = excluded.updated_at
    `);
    if (!result.ok) {
      const errorCode = result.error?.code || 'REQUEST_LOG_UNAVAILABLE';
      const errorMessage = redactText(
        result.error?.message || 'Provider request logs are unavailable'
      ).slice(0, 1000);
      this.db.prepare(`
        INSERT INTO provider_request_log_sync_state(
          connection_id, status, last_error_code, last_error_message, updated_at
        ) VALUES (?, 'unavailable', ?, ?, ?)
        ON CONFLICT(connection_id) DO UPDATE SET
          status = excluded.status,
          last_error_code = excluded.last_error_code,
          last_error_message = excluded.last_error_message,
          updated_at = excluded.updated_at
      `).run(
        connectionId,
        errorCode,
        errorMessage,
        capturedAt
      );
      for (const key of keys) {
        const keyId = keyIdByRemoteId.get(String(key.remoteId));
        if (keyId) markKeyUnavailable.run(keyId, connectionId, errorCode, errorMessage, capturedAt);
      }
      return 0;
    }

    const insert = this.db.prepare(`
      INSERT INTO provider_request_samples(
        connection_id, key_id, source_log_id, request_id, model, upstream_model,
        stream, status, duration_ms, first_token_ms, input_tokens, output_tokens,
        cache_creation_tokens, cache_read_tokens, actual_cost, currency,
        created_at, ingested_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(connection_id, source_log_id) DO UPDATE SET
        key_id = excluded.key_id,
        request_id = excluded.request_id,
        model = excluded.model,
        upstream_model = excluded.upstream_model,
        stream = excluded.stream,
        status = excluded.status,
        duration_ms = excluded.duration_ms,
        first_token_ms = excluded.first_token_ms,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cache_creation_tokens = excluded.cache_creation_tokens,
        cache_read_tokens = excluded.cache_read_tokens,
        actual_cost = excluded.actual_cost,
        currency = excluded.currency,
        created_at = excluded.created_at,
        ingested_at = excluded.ingested_at
    `);
    const insertCost = this.db.prepare(`
      INSERT INTO provider_cost_ledger(
        connection_id, key_id, remote_key_id, key_identity, source_log_id, status,
        currency, cost, request_count, input_tokens, output_tokens,
        cache_creation_tokens, cache_read_tokens, occurred_at, ingested_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(connection_id, key_identity, source_log_id) DO UPDATE SET
        key_id = COALESCE(excluded.key_id, provider_cost_ledger.key_id),
        remote_key_id = excluded.remote_key_id,
        updated_at = excluded.updated_at
    `);
    const items = Array.isArray(result.value?.items) ? result.value.items : [];
    for (const item of items) {
      const remoteKeyId = String(item.remoteKeyId || '');
      const keyId = keyIdByRemoteId.get(remoteKeyId) || null;
      insert.run(
        connectionId,
        keyId,
        String(item.sourceLogId),
        item.requestId || null,
        item.model || null,
        item.upstreamModel || null,
        item.stream ? 1 : 0,
        item.status || 'unknown',
        item.durationMs ?? null,
        item.firstTokenMs ?? null,
        item.inputTokens || 0,
        item.outputTokens || 0,
        item.cacheCreationTokens || 0,
        item.cacheReadTokens || 0,
        item.actualCost ?? null,
        item.currency || 'USD',
        item.createdAt,
        capturedAt
      );
      insertCost.run(
        connectionId,
        keyId,
        remoteKeyId || null,
        keyIdentityByRemoteId.get(remoteKeyId) || remoteKeyId || 'unassigned',
        String(item.sourceLogId),
        item.status || 'unknown',
        item.currency || 'USD',
        item.actualCost ?? null,
        item.inputTokens || 0,
        item.outputTokens || 0,
        item.cacheCreationTokens || 0,
        item.cacheReadTokens || 0,
        item.createdAt,
        capturedAt,
        capturedAt
      );
    }
    const suppliedCoverage = Array.isArray(result.value?.keyCoverage)
      ? result.value.keyCoverage
      : [];
    const keyCoverage = suppliedCoverage.length > 0
      ? suppliedCoverage
      : keys.map((key) => ({
          remoteKeyId: String(key.remoteId),
          status: 'succeeded',
          coverageFrom: result.value?.coverageFrom || null,
          coverageTo: result.value?.coverageTo || capturedAt,
          truncated: Boolean(result.value?.truncated),
          total: null,
          errorCode: null,
          errorMessage: null
        }));
    const upsertKeyState = this.db.prepare(`
      INSERT INTO provider_request_key_sync_state(
        key_id, connection_id, status, coverage_from, coverage_to, truncated,
        total_count, last_error_code, last_error_message, last_synced_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key_id) DO UPDATE SET
        connection_id = excluded.connection_id,
        status = excluded.status,
        coverage_from = COALESCE(excluded.coverage_from, provider_request_key_sync_state.coverage_from),
        coverage_to = COALESCE(excluded.coverage_to, provider_request_key_sync_state.coverage_to),
        truncated = excluded.truncated,
        total_count = excluded.total_count,
        last_error_code = excluded.last_error_code,
        last_error_message = excluded.last_error_message,
        last_synced_at = COALESCE(excluded.last_synced_at, provider_request_key_sync_state.last_synced_at),
        updated_at = excluded.updated_at
    `);
    for (const coverage of keyCoverage) {
      const keyId = keyIdByRemoteId.get(String(coverage.remoteKeyId));
      if (!keyId) continue;
      const succeeded = coverage.status === 'succeeded';
      upsertKeyState.run(
        keyId,
        connectionId,
        coverage.status || 'unknown',
        coverage.coverageFrom || null,
        coverage.coverageTo || null,
        coverage.truncated ? 1 : 0,
        coverage.total ?? null,
        succeeded ? null : coverage.errorCode || 'REQUEST_LOG_UNAVAILABLE',
        succeeded ? null : redactText(coverage.errorMessage || 'Provider request logs are unavailable').slice(0, 1000),
        succeeded ? capturedAt : null,
        capturedAt
      );
    }
    const partial = keyCoverage.some((coverage) => coverage.status !== 'succeeded');
    this.db.prepare(`
      INSERT INTO provider_request_log_sync_state(
        connection_id, status, coverage_from, coverage_to, truncated,
        total_count, last_error_code, last_error_message, last_synced_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
      ON CONFLICT(connection_id) DO UPDATE SET
        status = excluded.status,
        coverage_from = excluded.coverage_from,
        coverage_to = excluded.coverage_to,
        truncated = excluded.truncated,
        total_count = excluded.total_count,
        last_error_code = NULL,
        last_error_message = NULL,
        last_synced_at = excluded.last_synced_at,
        updated_at = excluded.updated_at
    `).run(
      connectionId,
      partial ? 'partial' : 'succeeded',
      result.value?.coverageFrom || null,
      result.value?.coverageTo || capturedAt,
      result.value?.truncated ? 1 : 0,
      result.value?.total ?? items.length,
      capturedAt,
      capturedAt
    );
    return items.length;
  }
}

module.exports = {
  SyncService,
  schemaShape
};
