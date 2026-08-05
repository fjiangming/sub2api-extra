const crypto = require('crypto');
const { AppError, asAppError } = require('../errors');
const { nowIso, parseJson, stringifyJson } = require('../db');
const { maskKey } = require('../security/redaction');
const { normalizeDynamicRouteConfig } = require('./dynamic-route-rate');

const ROUTED_GROUP_RATE_ADAPTERS = new Set([
  'new-api', 'one-api', 'one-hub', 'done-hub', 'veloera'
]);

function dayInTimezone(value, timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(value));
}

function finite(value) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function rechargeFromRow(row) {
  const manualMultiplier = finite(row.recharge_manual_multiplier);
  const detectedMultiplier = finite(row.recharge_detected_multiplier);
  const validManual = manualMultiplier != null && manualMultiplier > 0 ? manualMultiplier : null;
  const validDetected = detectedMultiplier != null && detectedMultiplier > 0 ? detectedMultiplier : null;
  const usesDefault = validManual == null && validDetected == null;
  const multiplier = validManual ?? validDetected ?? 1;
  return {
    multiplier,
    manualMultiplier: validManual,
    detectedMultiplier: validDetected,
    source: validManual != null
      ? 'manual'
      : usesDefault ? 'default' : row.recharge_detection_source || null,
    status: validManual != null
      ? 'manual'
      : usesDefault ? 'default' : row.recharge_status || 'unknown',
    detectionStatus: row.recharge_status || 'unknown',
    paidCurrency: row.recharge_paid_currency || null,
    balanceCurrency: row.recharge_balance_currency || null,
    checkedAt: row.recharge_checked_at || null
  };
}

function dynamicRouteFromRow(row) {
  const providerConfig = parseJson(row.provider_type_config_json, {});
  const config = normalizeDynamicRouteConfig(providerConfig.dynamicRouteRate);
  const summary = parseJson(row.dynamic_route_summary_json, {});
  const storedPriceBasis = summary.priceBasis || null;
  const priceBasisMatches = storedPriceBasis === config.priceBasis;
  return {
    enabled: config.enabled,
    statistic: row.dynamic_route_statistic || config.statistic,
    priceBasis: config.priceBasis,
    storedPriceBasis,
    multiplier: priceBasisMatches ? finite(row.dynamic_route_selected_multiplier) : null,
    sampleCount: priceBasisMatches ? Number(row.dynamic_route_sample_count || 0) : 0,
    minMultiplier: priceBasisMatches ? finite(row.dynamic_route_min_multiplier) : null,
    medianMultiplier: priceBasisMatches ? finite(row.dynamic_route_median_multiplier) : null,
    p90Multiplier: priceBasisMatches ? finite(row.dynamic_route_p90_multiplier) : null,
    maxMultiplier: priceBasisMatches ? finite(row.dynamic_route_max_multiplier) : null,
    weightedAverageMultiplier: priceBasisMatches ? finite(row.dynamic_route_weighted_average_multiplier) : null,
    latestMultiplier: priceBasisMatches ? finite(row.dynamic_route_latest_multiplier) : null,
    status: priceBasisMatches
      ? row.dynamic_route_status || (config.enabled ? 'not_checked' : 'disabled')
      : 'recalculation_required',
    errorCode: row.dynamic_route_error_code || null,
    summary,
    observedFrom: row.dynamic_route_observed_from || null,
    observedTo: row.dynamic_route_observed_to || null,
    checkedAt: row.dynamic_route_checked_at || null
  };
}

function groupRateMap(payload) {
  return payload?.rates || payload?.group_rates || payload || {};
}

function groupRate(rates, groupId, fallback = null) {
  const entry = rates?.[groupId] ?? rates?.[String(groupId)];
  return finite(entry?.rate_multiplier ?? entry?.effective_rate_multiplier ?? entry?.ratio ?? entry) ?? fallback;
}

function normalizeGroupIds(channel) {
  let values = channel?.group_ids ?? channel?.groupIds ?? channel?.groups ?? channel?.group_id ?? [];
  if (typeof values === 'string') {
    try {
      values = JSON.parse(values);
    } catch {
      values = values.split(',').map((item) => item.trim()).filter(Boolean);
    }
  }
  const list = Array.isArray(values) ? values : [values];
  return [...new Set(list.map((item) => finite(item?.id ?? item)).filter((item) => item != null))];
}

function hasGroupAssociation(channel) {
  return ['group_ids', 'groupIds', 'groups', 'group_id'].some((key) =>
    Object.prototype.hasOwnProperty.call(channel || {}, key)
  );
}

function normalizeBaseChannel(channel) {
  return {
    id: finite(channel?.id ?? channel?.channel_id),
    name: String(channel?.name || channel?.display_name || channel?.id || 'Unnamed channel'),
    description: String(channel?.description || ''),
    status: String(channel?.status || (channel?.enabled === false ? 'disabled' : 'active')),
    groupIds: normalizeGroupIds(channel),
    groupIdsKnown: hasGroupAssociation(channel),
    modelCount: Array.isArray(channel?.model_pricing) ? channel.model_pricing.length : 0,
    raw: channel
  };
}

function normalizeBaseGroup(group, rates = {}) {
  const id = finite(group?.id ?? group?.group_id);
  const defaultRate = finite(group?.rate_multiplier ?? group?.default_rate_multiplier ?? group?.ratio);
  const effectiveRate = groupRate(rates, id, finite(group?.effective_rate_multiplier) ?? defaultRate);
  return {
    id,
    name: String(group?.name || group?.display_name || id || 'Unnamed group'),
    platform: String(group?.platform || ''),
    status: String(group?.status || (group?.enabled === false ? 'inactive' : 'active')),
    defaultRate,
    effectiveRate,
    raw: group
  };
}

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

function apiKeyFingerprintVariants(value) {
  const apiKey = String(value || '').trim();
  if (!apiKey) return [];
  const variants = [apiKey];
  if (apiKey.startsWith('sk-')) {
    if (apiKey.length > 3) variants.push(apiKey.slice(3));
  } else {
    variants.push(`sk-${apiKey}`);
  }
  return [...new Set(variants.map((item) => maskKey(item)).filter(Boolean))];
}

function normalizeGatewayBaseUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    const path = url.pathname
      .replace(/\/+$/, '')
      .replace(/\/v1$/i, '');
    return `${url.origin.toLowerCase()}${path}`;
  } catch {
    return null;
  }
}

function equivalentRates(left, right) {
  const first = finite(left);
  const second = finite(right);
  if (first == null || second == null) return false;
  return Math.abs(first - second) <= Math.max(1e-9, Math.max(Math.abs(first), Math.abs(second)) * 1e-6);
}

function matchProviderAccounts(providerName, accounts) {
  const needle = normalizeName(providerName);
  if (!needle) return { status: 'unmatched', matchType: null, accounts: [] };
  const exact = accounts.filter((account) => normalizeName(account.name) === needle);
  if (exact.length > 0) return { status: 'matched', matchType: 'exact', accounts: exact };
  const contains = accounts.filter((account) => normalizeName(account.name).includes(needle));
  if (contains.length > 0) return { status: 'matched', matchType: 'contains', accounts: contains };
  return { status: 'unmatched', matchType: null, accounts: [] };
}

function normalizeBaseAccount(account) {
  return {
    id: finite(account?.id ?? account?.account_id),
    name: String(account?.name || account?.id || 'Unnamed account'),
    type: String(account?.type || '').toLowerCase(),
    priority: finite(account?.priority ?? account?.account_priority),
    groupIds: normalizeGroupIds(account),
    hasApiKey: Boolean(
      account?.credentials_status?.has_api_key ||
      ['api_key', 'apikey', 'upstream'].includes(String(account?.type || '').toLowerCase())
    )
  };
}

function accountExportId(account) {
  const value = account?.id ?? account?.account_id ?? account?.accountId;
  return value == null || String(value).trim() === '' ? null : String(value);
}

function accountExportSignature(account) {
  return normalizeName(account?.name);
}

function groupBy(items, keyFor) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFor(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

function mappingRebuildError(error, stage, details = {}) {
  const fallbackCode = typeof error?.code === 'string' && error.code
    ? error.code
    : 'MAPPING_REBUILD_FAILED';
  const appError = asAppError(error, fallbackCode);
  return new AppError(appError.code || fallbackCode, appError.message, {
    status: appError.status,
    retryable: appError.retryable,
    cause: appError,
    details: {
      ...(appError.details || {}),
      operation: 'rebuild_auto_mappings',
      stage,
      ...details
    }
  });
}

function mappingIdentity(mapping) {
  return [
    mapping.connection_id ?? mapping.connectionId,
    mapping.key_id ?? mapping.keyId ?? '',
    Number(mapping.account_id ?? mapping.accountId ?? 0),
    Number(mapping.group_id ?? mapping.groupId ?? 0)
  ].join('|');
}

function highestMapping(items) {
  return [...items]
    .filter((item) => {
      const rate = finite(item.comparison?.compositeRate);
      return rate != null && rate > 0;
    })
    .sort((left, right) => {
      const rateDifference = Number(right.comparison.compositeRate) - Number(left.comparison.compositeRate);
      if (rateDifference !== 0) return rateDifference;
      const providerDifference = String(left.provider_name || '').localeCompare(String(right.provider_name || ''), undefined, { sensitivity: 'base' });
      if (providerDifference !== 0) return providerDifference;
      const keyDifference = String(left.key_id || '').localeCompare(String(right.key_id || ''));
      if (keyDifference !== 0) return keyDifference;
      return String(left.id).localeCompare(String(right.id));
    })[0] || null;
}

function attachBaseAccounts(items, accounts) {
  const accountsById = new Map(accounts.map((account) => [Number(account.id), account]));
  return items.map((item) => {
    const accountId = finite(item.account_id);
    const account = accountId == null ? null : accountsById.get(Number(accountId)) || null;
    return {
      ...item,
      baseAccount: account ? {
        id: account.id,
        name: account.name,
        priority: account.priority
      } : null
    };
  });
}

function groupComparisons(items, catalog) {
  const byGroup = new Map(catalog.groups.map((group) => [Number(group.id), []]));
  const unassignedItems = [];
  for (const item of items) {
    const groupId = finite(item.group_id ?? item.comparison?.baseGroupId);
    if (groupId != null && byGroup.has(Number(groupId))) byGroup.get(Number(groupId)).push(item);
    else unassignedItems.push({ ...item, isHighestRate: false });
  }
  const groups = catalog.groups.map((group) => {
    const groupItems = byGroup.get(Number(group.id)) || [];
    const winner = highestMapping(groupItems);
    const decorated = groupItems.map((item) => ({ ...item, isHighestRate: item.id === winner?.id }));
    return {
      groupId: group.id,
      groupName: group.name,
      status: group.status,
      defaultRate: group.defaultRate,
      effectiveRate: group.effectiveRate,
      baseRate: group.effectiveRate ?? group.defaultRate,
      platform: group.platform,
      mappingCount: decorated.length,
      highest: winner ? decorated.find((item) => item.id === winner.id) : null,
      items: decorated
    };
  });
  return { groups, unassignedItems };
}

const AUTO_MAPPING_STATUSES = [
  'pending_create', 'created', 'existing', 'unmatched', 'conflict',
  'missing_api_key', 'missing_remote_key', 'missing_provider_group'
];
const COMPLETE_REBUILD_COMPARISON_STATUSES = new Set(['aligned', 'rate_mismatch']);

function autoMappingSummary(items) {
  const summary = {
    total: items.length,
    providers: new Set(items.map((item) => item.providerId).filter(Boolean)).size,
    accounts: new Set(items.map((item) => item.accountId).filter((value) => value != null)).size,
    groups: new Set(items.map((item) => item.groupId).filter((value) => value != null)).size
  };
  for (const status of AUTO_MAPPING_STATUSES) {
    const key = status.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase());
    summary[key] = items.filter((item) => item.status === status).length;
  }
  summary.skipped = summary.unmatched + summary.conflict + summary.missingApiKey +
    summary.missingRemoteKey + summary.missingProviderGroup;
  return summary;
}

function autoMappingConfig(item, createdAt) {
  return {
    autoMapping: {
      source: item.keyMatch === 'verified_gateway_billing'
        ? 'provider_account_name_gateway_billing'
        : 'provider_account_name_api_key',
      accountMatch: item.accountMatch,
      keyMatch: item.keyMatch || 'fingerprint',
      billingScope: item.verifiedBillingScope || null,
      createdAt
    }
  };
}

function comparisonSummary(items) {
  const summary = { total: items.length, aligned: 0, warning: 0, error: 0, disabled: 0, unchecked: 0 };
  for (const item of items) {
    const status = item.comparison?.status;
    if (!status) summary.unchecked += 1;
    else if (status === 'aligned') summary.aligned += 1;
    else if (status === 'mapping_disabled') summary.disabled += 1;
    else if (status === 'missing_base_group') summary.error += 1;
    else summary.warning += 1;
  }
  return summary;
}

class MappingService {
  constructor({ db, config, sub2api, http = null, providerSync = null }) {
    this.db = db;
    this.config = config;
    this.sub2api = sub2api;
    this.http = http;
    this.baseCatalogCache = null;
    this.baseCatalogRequest = null;
    this.baseAccountsCache = null;
    this.baseAccountsRequest = null;
    this.baseAccountCache = new Map();
    this.baseAccountRequests = new Map();
    this.providerSync = providerSync;
    this.rebuildInFlight = null;
  }

  setProviderSync(providerSync) {
    this.providerSync = typeof providerSync === 'function' ? providerSync : null;
  }

  list({ connectionId } = {}) {
    const clauses = [];
    const params = [];
    if (connectionId) { clauses.push('m.connection_id = ?'); params.push(connectionId); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`
      SELECT m.*, p.name AS provider_name, p.adapter_type AS provider_adapter_type,
        p.type_config_json AS provider_type_config_json,
        k.name AS key_name, k.masked_key, k.status AS key_status,
        rr.detected_multiplier AS recharge_detected_multiplier,
        rr.manual_multiplier AS recharge_manual_multiplier,
        rr.paid_currency AS recharge_paid_currency,
        rr.balance_currency AS recharge_balance_currency,
        rr.detection_source AS recharge_detection_source,
        rr.status AS recharge_status,
        rr.checked_at AS recharge_checked_at,
        dr.selected_multiplier AS dynamic_route_selected_multiplier,
        dr.statistic AS dynamic_route_statistic,
        dr.sample_count AS dynamic_route_sample_count,
        dr.min_multiplier AS dynamic_route_min_multiplier,
        dr.median_multiplier AS dynamic_route_median_multiplier,
        dr.p90_multiplier AS dynamic_route_p90_multiplier,
        dr.max_multiplier AS dynamic_route_max_multiplier,
        dr.weighted_average_multiplier AS dynamic_route_weighted_average_multiplier,
        dr.latest_multiplier AS dynamic_route_latest_multiplier,
        dr.status AS dynamic_route_status,
        dr.error_code AS dynamic_route_error_code,
        dr.summary_json AS dynamic_route_summary_json,
        dr.observed_from AS dynamic_route_observed_from,
        dr.observed_to AS dynamic_route_observed_to,
        dr.checked_at AS dynamic_route_checked_at,
        r.status AS reconciliation_status, r.difference_amount,
        r.difference_ratio, r.health_score, r.completed_at AS reconciled_at,
        s.status AS comparison_status, s.provider_group_ref AS comparison_provider_group_ref,
        s.provider_group_name AS comparison_provider_group_name, s.provider_rate AS comparison_provider_rate,
        s.base_group_id AS comparison_base_group_id, s.base_group_name AS comparison_base_group_name,
        s.base_group_rate AS comparison_base_group_rate, s.difference_ratio AS comparison_difference_ratio,
        s.tolerance_ratio AS comparison_tolerance_ratio, s.details_json AS comparison_details_json,
        s.checked_at AS comparison_checked_at
      FROM sub2api_mappings m
      JOIN provider_connections p ON p.id = m.connection_id
      LEFT JOIN provider_recharge_rates rr ON rr.connection_id = m.connection_id
      LEFT JOIN remote_keys k ON k.id = m.key_id
      LEFT JOIN provider_dynamic_route_rates dr ON dr.key_id = m.key_id
      LEFT JOIN sub2api_mapping_states s ON s.mapping_id = m.id
      LEFT JOIN reconciliation_runs r ON r.id = (
        SELECT id FROM reconciliation_runs latest
        WHERE latest.mapping_id = m.id ORDER BY latest.created_at DESC LIMIT 1
      )
      ${where}
      ORDER BY m.group_id, CASE m.role WHEN 'primary' THEN 0 ELSE 1 END, p.name
    `).all(...params).map((row) => {
      const recharge = rechargeFromRow(row);
      const dynamicRoute = dynamicRouteFromRow(row);
      const dynamicStatusOverride = row.key_status === 'missing'
        ? 'missing_remote_key'
        : !dynamicRoute.enabled
        ? null
        : dynamicRoute.status === 'missing_provider_price'
          ? 'missing_provider_price'
          : dynamicRoute.status === 'partial_provider_price'
            ? 'partial_provider_price'
            : dynamicRoute.status === 'missing_reference_price'
              ? 'missing_reference_price'
              : dynamicRoute.status === 'partial_reference_price'
                ? 'partial_reference_price'
            : dynamicRoute.multiplier == null ? 'missing_dynamic_route_rate' : null;
      const comparisonProviderRate = dynamicRoute.enabled && dynamicRoute.multiplier == null
        ? null
        : row.comparison_provider_rate;
      const comparisonDetails = parseJson(row.comparison_details_json, {});
      const comparison = row.comparison_status ? {
        status: dynamicStatusOverride || row.comparison_status,
        providerGroupRef: row.comparison_provider_group_ref,
        providerGroupName: row.comparison_provider_group_name,
        providerRate: comparisonProviderRate,
        baseGroupId: row.comparison_base_group_id,
        baseGroupName: row.comparison_base_group_name,
        baseGroupRate: row.comparison_base_group_rate,
        rechargeMultiplier: recharge.multiplier,
        rechargeSource: recharge.source,
        rechargeStatus: recharge.status,
        compositeRate: comparisonProviderRate != null && recharge.multiplier != null
          ? Number(comparisonProviderRate) / recharge.multiplier
          : null,
        differenceRatio: dynamicStatusOverride ? null : row.comparison_difference_ratio,
        toleranceRatio: row.comparison_tolerance_ratio,
        details: dynamicRoute.enabled
          ? {
              ...comparisonDetails,
              providerRateBasis: dynamicRoute.priceBasis,
              dynamicRouteRate: dynamicRoute
            }
          : comparisonDetails,
        checkedAt: row.comparison_checked_at
      } : null;
      const result = {
        ...row,
        enabled: Boolean(row.enabled),
        models: parseJson(row.models_json, []),
        config: parseJson(row.config_json, {}),
        recharge,
        dynamicRoute,
        comparison
      };
      for (const key of Object.keys(result)) {
        if (
          key === 'models_json' || key === 'config_json' || key === 'provider_type_config_json' ||
          key.startsWith('comparison_') || key.startsWith('recharge_') || key.startsWith('dynamic_route_')
        ) delete result[key];
      }
      return result;
    });
  }

  get(id) {
    const row = this.list().find((item) => item.id === id);
    if (!row) throw new AppError('MAPPING_NOT_FOUND', 'Sub2API mapping was not found', { status: 404 });
    return row;
  }

  save(input, id = null) {
    const existing = id ? this.db.prepare('SELECT * FROM sub2api_mappings WHERE id = ?').get(id) : null;
    if (id && !existing) throw new AppError('MAPPING_NOT_FOUND', 'Sub2API mapping was not found', { status: 404 });
    const connectionId = input.connectionId ?? existing?.connection_id;
    const keyId = input.keyId === undefined ? existing?.key_id : input.keyId || null;
    const groupId = finite(input.groupId === undefined ? existing?.group_id : input.groupId);
    const provider = this.db.prepare('SELECT id FROM provider_connections WHERE id = ?').get(connectionId);
    if (!provider) throw new AppError('PROVIDER_NOT_FOUND', 'Provider connection was not found', { status: 404 });
    if (groupId == null || groupId <= 0) {
      throw new AppError('VALIDATION_ERROR', 'A Sub2API group is required for each mapping', { status: 400 });
    }
    if (keyId) {
      const key = this.db.prepare('SELECT id FROM remote_keys WHERE id = ? AND connection_id = ?').get(keyId, connectionId);
      if (!key) throw new AppError('KEY_NOT_FOUND', 'Mapped key does not belong to the selected provider', { status: 400 });
    }
    const mappingId = id || crypto.randomUUID();
    const now = nowIso();
    try {
      if (existing) {
        this.db.prepare(`
          UPDATE sub2api_mappings SET connection_id = ?, key_id = ?, channel_id = NULL,
            account_id = ?, group_id = ?, role = ?, enabled = ?, models_json = ?,
            config_json = ?, updated_at = ? WHERE id = ?
        `).run(
          connectionId, keyId,
          input.accountId === undefined ? existing.account_id : input.accountId ?? null,
          groupId,
          input.role ?? existing.role,
          input.enabled == null ? existing.enabled : input.enabled ? 1 : 0,
          stringifyJson(input.models ?? parseJson(existing.models_json, [])),
          stringifyJson(input.config ?? parseJson(existing.config_json, {})),
          now, mappingId
        );
      } else {
        this.db.prepare(`
          INSERT INTO sub2api_mappings(
            id, connection_id, key_id, account_id, group_id, role,
            enabled, models_json, config_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          mappingId, connectionId, keyId, input.accountId ?? null,
          groupId, input.role || 'primary', input.enabled === false ? 0 : 1,
          stringifyJson(input.models || []), stringifyJson(input.config || {}), now, now
        );
      }
    } catch (error) {
      if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) {
        throw new AppError('MAPPING_DUPLICATE', 'This provider, key, account and group mapping already exists', { status: 409 });
      }
      throw error;
    }
    return this.get(mappingId);
  }

  delete(id) {
    const result = this.db.prepare('DELETE FROM sub2api_mappings WHERE id = ?').run(id);
    if (!result.changes) throw new AppError('MAPPING_NOT_FOUND', 'Sub2API mapping was not found', { status: 404 });
  }

  deleteAll() {
    return this.db.transaction(() => {
      const deletedComparisonStates = this.db.prepare('SELECT COUNT(*) AS count FROM sub2api_mapping_states').get().count;
      const deletedReconciliations = this.db.prepare('SELECT COUNT(*) AS count FROM reconciliation_runs').get().count;
      const result = this.db.prepare('DELETE FROM sub2api_mappings').run();
      return {
        deletedMappings: result.changes,
        deletedComparisonStates,
        deletedReconciliations
      };
    })();
  }

  activateBackup(id) {
    const selected = this.get(id);
    if (selected.role !== 'backup') {
      throw new AppError('BACKUP_MAPPING_REQUIRED', 'Only a backup mapping can be activated', { status: 409 });
    }
    if (selected.group_id == null) {
      throw new AppError('MAPPING_GROUP_REQUIRED', 'The backup mapping does not have a Sub2API group', { status: 409 });
    }
    this.db.transaction(() => {
      this.db.prepare(`UPDATE sub2api_mappings SET enabled = 0, updated_at = ? WHERE group_id = ?`).run(nowIso(), selected.group_id);
      this.db.prepare(`
        UPDATE sub2api_mappings SET role = 'backup', updated_at = ?
        WHERE group_id = ? AND role = 'primary' AND id != ?
      `).run(nowIso(), selected.group_id, id);
      this.db.prepare(`UPDATE sub2api_mappings SET enabled = 1, role = 'primary', updated_at = ? WHERE id = ?`).run(nowIso(), id);
    })();
    return this.get(id);
  }

  async channels(options = {}) {
    const result = await this.sub2api.listAll('/api/v1/admin/channels', {}, {
      maxItems: 5000,
      accessToken: options.accessToken || null
    });
    const items = result.items.map(normalizeBaseChannel).filter((item) => item.id != null);
    if (items.length !== result.items.length) {
      throw new AppError('SCHEMA_MISMATCH', 'Sub2API channel catalog contained an item without an ID', {
        status: 502,
        details: { endpoint: '/api/v1/admin/channels' }
      });
    }
    return { items, total: items.length, capturedAt: nowIso() };
  }

  async groups(options = {}) {
    const catalog = await this.#baseCatalog(options);
    return { items: catalog.groups, total: catalog.groups.length, capturedAt: catalog.capturedAt };
  }

  async channelMonitors() {
    try {
      return await this.sub2api.listAll('/api/v1/admin/channel-monitors', {}, { maxItems: 5000 });
    } catch (error) {
      if ([403, 404, 405, 501].includes(Number(error?.status))) {
        return { items: [], total: 0, truncated: false, pagesFetched: 0, supported: false };
      }
      throw error;
    }
  }

  status() {
    const latest = this.db.prepare(`SELECT MAX(checked_at) checked_at FROM sub2api_mapping_states`).get();
    return {
      configured: Boolean(this.config.sub2apiBaseUrl),
      baseUrl: this.config.sub2apiBaseUrl,
      publicUrl: this.config.sub2apiPublicUrl || null,
      authentication: this.sub2api.authenticationStatus?.() || { available: true, source: 'service' },
      lastCheckedAt: latest?.checked_at || null
    };
  }

  async comparisons({ connectionId = null, catalog = null, accountCatalog = null, force = false, accessToken = null } = {}) {
    const currentItems = this.list({ connectionId });
    const accountIds = [...new Set(currentItems
      .map((item) => finite(item.account_id))
      .filter((accountId) => accountId != null))];
    const [baseCatalog, baseAccounts] = await Promise.all([
      catalog || this.#baseCatalog({ force, accessToken }),
      accountCatalog || this.#mappedBaseAccounts(accountIds, { force, accessToken })
    ]);
    return this.#comparisonPayload({ connectionId, baseCatalog, baseAccounts });
  }

  #comparisonPayload({ connectionId = null, baseCatalog, baseAccounts }) {
    const items = attachBaseAccounts(this.list({ connectionId }), baseAccounts.accounts);
    return {
      status: this.status(),
      summary: comparisonSummary(items),
      items,
      ...groupComparisons(items, baseCatalog)
    };
  }

  #writeComparisonStates(states) {
    const upsert = this.db.prepare(`
      INSERT INTO sub2api_mapping_states(
        mapping_id, status, provider_group_ref, provider_group_name, provider_rate,
        base_group_id, base_group_name, base_group_rate,
        difference_ratio, tolerance_ratio, details_json, checked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(mapping_id) DO UPDATE SET
        status = excluded.status,
        provider_group_ref = excluded.provider_group_ref,
        provider_group_name = excluded.provider_group_name,
        provider_rate = excluded.provider_rate,
        channel_name = NULL,
        channel_status = NULL,
        base_group_id = excluded.base_group_id,
        base_group_name = excluded.base_group_name,
        base_group_rate = excluded.base_group_rate,
        difference_ratio = excluded.difference_ratio,
        tolerance_ratio = excluded.tolerance_ratio,
        details_json = excluded.details_json,
        checked_at = excluded.checked_at
    `);
    for (const state of states) {
      upsert.run(
        state.mappingId, state.status, state.providerGroupRef, state.providerGroupName,
        state.providerRate, state.baseGroupId, state.baseGroupName,
        state.baseGroupRate, state.differenceRatio,
        state.toleranceRatio, stringifyJson(state.details), state.checkedAt
      );
    }
  }

  async refreshComparisons({ connectionId = null, force = true, catalog = null, accountCatalog = null } = {}) {
    const baseCatalog = catalog || await this.#baseCatalog({ force });
    const mappings = this.list({ connectionId });
    const states = mappings.map((mapping) => this.#compareMapping(mapping, baseCatalog));
    this.db.transaction(() => this.#writeComparisonStates(states))();
    return this.comparisons({ connectionId, catalog: baseCatalog, accountCatalog, force });
  }

  async autoMappings({ mode = 'preview' } = {}, { accessToken = null } = {}) {
    if (!['preview', 'apply'].includes(mode)) {
      throw new AppError('VALIDATION_ERROR', 'Auto-mapping mode must be preview or apply', { status: 400 });
    }
    const discovery = await this.#discoverAutoMappings({ accessToken });
    if (mode === 'preview') {
      return {
        mode,
        summary: autoMappingSummary(discovery.items),
        items: discovery.items
      };
    }

    const createdAt = nowIso();
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO sub2api_mappings(
        id, connection_id, key_id, account_id, group_id, role,
        enabled, models_json, config_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'primary', 1, '[]', ?, ?, ?)
    `);
    const findExisting = this.db.prepare(`
      SELECT id FROM sub2api_mappings
      WHERE connection_id = ? AND key_id = ? AND account_id = ? AND group_id = ?
    `);
    this.db.transaction(() => {
      for (const item of discovery.items) {
        if (item.status !== 'pending_create') continue;
        const mappingId = crypto.randomUUID();
        const config = autoMappingConfig(item, createdAt);
        const result = insert.run(
          mappingId, item.providerId, item.keyId, item.accountId,
          item.groupId, stringifyJson(config), createdAt, createdAt
        );
        if (result.changes) {
          item.status = 'created';
          item.mappingId = mappingId;
        } else {
          item.status = 'existing';
          item.mappingId = findExisting.get(
            item.providerId, item.keyId, item.accountId, item.groupId
          )?.id || null;
        }
      }
    })();

    const comparisons = await this.refreshComparisons({
      force: false,
      catalog: discovery.catalog,
      accountCatalog: discovery.accountCatalog
    });
    return {
      mode,
      summary: autoMappingSummary(discovery.items),
      items: discovery.items,
      comparisons
    };
  }

  #providersMatchingAccounts(accounts) {
    return this.db.prepare(`
      SELECT id, name, adapter_type FROM provider_connections
      WHERE enabled = 1 ORDER BY name COLLATE NOCASE, id
    `).all().filter((provider) => matchProviderAccounts(provider.name, accounts).status === 'matched');
  }

  async #refreshProviderSnapshots(accountCatalog) {
    const providers = this.#providersMatchingAccounts(accountCatalog.accounts);
    if (!this.providerSync || providers.length === 0) {
      return {
        required: providers.length,
        refreshed: 0,
        skipped: providers.length,
        capturedAt: nowIso(),
        items: []
      };
    }

    const results = new Array(providers.length);
    let cursor = 0;
    const concurrency = Math.min(
      Math.max(1, Number(this.config.globalConcurrency) || 1),
      providers.length
    );
    const workers = Array.from({ length: concurrency }, async () => {
      while (cursor < providers.length) {
        const index = cursor;
        cursor += 1;
        const provider = providers[index];
        const result = await this.providerSync(provider.id, {
          jobType: 'mapping_rebuild_sync',
          manual: true
        });
        const snapshot = result?.mappingSnapshot;
        if (!snapshot || snapshot.ready !== true) {
          throw new AppError(
            'MAPPING_PROVIDER_SNAPSHOT_INCOMPLETE',
            `Supplier ${provider.name} did not return a complete mapping snapshot`,
            {
              status: 409,
              retryable: Boolean(result?.warnings?.some((warning) =>
                ['TIMEOUT', 'RATE_LIMITED', 'NETWORK_ERROR'].includes(warning.code)
              )),
              details: {
                connectionId: provider.id,
                providerName: provider.name,
                syncStatus: result?.status || null,
                mappingSnapshot: snapshot || null,
                warnings: result?.warnings || []
              }
            }
          );
        }
        results[index] = {
          connectionId: provider.id,
          providerName: provider.name,
          status: result.status,
          capturedAt: snapshot.capturedAt,
          warningCount: result.warnings?.length || 0
        };
      }
    });
    await Promise.all(workers);
    return {
      required: providers.length,
      refreshed: results.length,
      skipped: 0,
      capturedAt: nowIso(),
      items: results
    };
  }

  async rebuildAutoMappings(options = {}) {
    if (this.rebuildInFlight) {
      throw new AppError(
        'MAPPING_REBUILD_IN_PROGRESS',
        'A Sub2API mapping rebuild is already in progress',
        { status: 409, retryable: true }
      );
    }
    const operation = this.#rebuildAutoMappings(options);
    this.rebuildInFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.rebuildInFlight === operation) this.rebuildInFlight = null;
    }
  }

  async #rebuildAutoMappings({ preview = false, accessToken = null } = {}) {
    let providerSnapshots;
    try {
      const initialAccounts = await this.#baseAccounts({ force: true, accessToken });
      providerSnapshots = await this.#refreshProviderSnapshots(initialAccounts);
    } catch (error) {
      throw mappingRebuildError(error, 'refresh_provider_snapshots', { preview: Boolean(preview) });
    }

    let discovery;
    try {
      discovery = await this.#discoverAutoMappings({ accessToken, strictRates: true });
    } catch (error) {
      throw mappingRebuildError(error, 'discover_candidates', { preview: Boolean(preview) });
    }
    const candidates = discovery.items.filter((item) =>
      item.status === 'pending_create' || item.status === 'existing'
    );
    const current = {
      mappings: this.db.prepare('SELECT COUNT(*) count FROM sub2api_mappings').get().count,
      comparisonStates: this.db.prepare('SELECT COUNT(*) count FROM sub2api_mapping_states').get().count,
      reconciliations: this.db.prepare('SELECT COUNT(*) count FROM reconciliation_runs').get().count
    };
    const discoverySummary = autoMappingSummary(discovery.items);

    if (preview) {
      return {
        mode: 'replace_preview',
        summary: {
          ...discoverySummary,
          wouldDeleteMappings: current.mappings,
          wouldCreateMappings: candidates.length,
          providerSnapshots
        },
        items: discovery.items
      };
    }

    const createdAt = nowIso();
    const insert = this.db.prepare(`
      INSERT INTO sub2api_mappings(
        id, connection_id, key_id, account_id, group_id, role,
        enabled, models_json, config_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'primary', 1, '[]', ?, ?, ?)
    `);
    let replacement;
    try {
      replacement = this.db.transaction(() => {
        const deletedMappings = this.db.prepare('DELETE FROM sub2api_mappings').run().changes;
        let createdMappings = 0;
        for (const item of candidates) {
          const mappingId = crypto.randomUUID();
          insert.run(
            mappingId, item.providerId, item.keyId, item.accountId,
            item.groupId, stringifyJson(autoMappingConfig(item, createdAt)), createdAt, createdAt
          );
          item.status = 'created';
          item.mappingId = mappingId;
          createdMappings += 1;
        }
        const mappings = this.list();
        const states = mappings.map((mapping) => this.#compareMapping(mapping, discovery.catalog));
        const incomplete = states.filter((state) =>
          !COMPLETE_REBUILD_COMPARISON_STATUSES.has(state.status)
        );
        if (incomplete.length > 0) {
          throw new AppError(
            'MAPPING_RATE_SNAPSHOT_INCOMPLETE',
            'One or more rebuilt mappings could not calculate a complete composite rate',
            {
              status: 409,
              details: {
                mappings: incomplete.slice(0, 50).map((state) => ({
                  mappingId: state.mappingId,
                  status: state.status,
                  providerGroupRef: state.providerGroupRef,
                  baseGroupId: state.baseGroupId,
                  providerRate: state.providerRate,
                  baseGroupRate: state.baseGroupRate,
                  rechargeMultiplier: state.details?.rechargeMultiplier ?? null
                })),
                omitted: Math.max(0, incomplete.length - 50)
              }
            }
          );
        }
        this.#writeComparisonStates(states);
        const comparisons = this.#comparisonPayload({
          baseCatalog: discovery.catalog,
          baseAccounts: discovery.accountCatalog
        });
        return { deletedMappings, createdMappings, comparisons };
      })();
    } catch (error) {
      throw mappingRebuildError(error, 'replace_mappings', {
        preview: false,
        existingMappings: current.mappings,
        candidateMappings: candidates.length,
        replacementCommitted: false
      });
    }

    const { comparisons, ...replacementSummary } = replacement;
    return {
      mode: 'replace',
      summary: {
        ...autoMappingSummary(discovery.items),
        ...replacementSummary,
        providerSnapshots,
        deletedComparisonStates: current.comparisonStates,
        deletedReconciliations: current.reconciliations
      },
      items: discovery.items,
      comparisons
    };
  }

  async #discoverAutoMappings({ accessToken = null, strictRates = false } = {}) {
    const [catalog, accountCatalog] = await Promise.all([
      this.#baseCatalog({ force: true, accessToken, strictRates }),
      this.#baseAccounts({ force: true, accessToken })
    ]);
    const accounts = accountCatalog.accounts;
    const providers = this.db.prepare(`
      SELECT p.id, p.name, p.adapter_type, p.auth_mode, p.base_url
      FROM provider_connections p
      WHERE p.enabled = 1 AND EXISTS (
        SELECT 1 FROM remote_keys k
        WHERE k.connection_id = p.id AND k.status != 'missing'
      )
      ORDER BY p.name COLLATE NOCASE, p.id
    `).all();
    const work = [];
    const items = [];
    const accountsNeedingKeys = new Map();
    const providerAssets = new Map();
    const gatewayKeyMatches = new Map();
    const workIdentities = new Set();
    const enqueueWork = (entry) => {
      const identity = [entry.provider.id, entry.baseGroup.id, entry.account.id].join('|');
      if (workIdentities.has(identity)) return;
      workIdentities.add(identity);
      work.push(entry);
      accountsNeedingKeys.set(entry.account.id, entry.account);
    };

    for (const provider of providers) {
      const accountMatch = matchProviderAccounts(provider.name, accounts);
      if (accountMatch.status !== 'matched') {
        items.push({
          status: 'unmatched',
          reason: 'account_not_found',
          providerId: provider.id,
          providerName: provider.name,
          accountMatch: accountMatch.matchType
        });
        continue;
      }

      const remoteKeys = this.db.prepare(`
        SELECT k.id, k.name, k.masked_key, k.primary_group_ref, k.status,
          a.user_group AS account_user_group
        FROM remote_keys k
        LEFT JOIN remote_accounts a ON a.id = k.remote_account_id
        WHERE k.connection_id = ? AND k.status != 'missing'
        ORDER BY k.name COLLATE NOCASE, k.id
      `).all(provider.id);
      const remoteGroups = this.db.prepare(`
        SELECT id, remote_id, name, ratio, status, metadata_json
        FROM remote_groups
        WHERE connection_id = ? AND status != 'missing'
        ORDER BY name COLLATE NOCASE, id
      `).all(provider.id).map((group) => ({
        ...group,
        metadata: parseJson(group.metadata_json, {})
      }));
      providerAssets.set(provider.id, { remoteKeys, remoteGroups });

      for (const account of accountMatch.accounts) {
        if (!account.hasApiKey) {
          items.push({
            status: 'missing_api_key',
            reason: 'matched_account_has_no_api_key',
            providerId: provider.id,
            providerName: provider.name,
            accountId: account.id,
            accountName: account.name,
            accountMatch: accountMatch.matchType
          });
          continue;
        }
        if (account.groupIds.length === 0) {
          items.push({
            status: 'unmatched',
            reason: 'account_has_no_groups',
            providerId: provider.id,
            providerName: provider.name,
            accountId: account.id,
            accountName: account.name,
            accountMatch: accountMatch.matchType
          });
          continue;
        }

        for (const groupId of account.groupIds) {
          const baseGroup = catalog.groups.find((group) => Number(group.id) === Number(groupId));
          if (!baseGroup) {
            items.push({
              status: 'unmatched',
              reason: 'account_group_not_found',
              providerId: provider.id,
              providerName: provider.name,
              accountId: account.id,
              accountName: account.name,
              accountMatch: accountMatch.matchType,
              groupId
            });
            continue;
          }
          enqueueWork({ provider, accountMatch: accountMatch.matchType, baseGroup, account });
        }
      }
    }

    const accountKeys = await this.#accountKeyDetails(
      [...accountsNeedingKeys.values()],
      { accessToken }
    );
    const existing = new Map(this.list().map((mapping) => [mappingIdentity(mapping), mapping]));
    for (const entry of work) {
      const { provider, accountMatch, baseGroup, account } = entry;
      const baseItem = {
        providerId: provider.id,
        providerName: provider.name,
        accountMatch,
        groupId: baseGroup.id,
        groupName: baseGroup.name,
        accountId: account.id,
        accountName: account.name
      };
      const accountKey = accountKeys.get(account.id) || null;
      const fingerprint = accountKey?.fingerprint || null;
      const fingerprints = accountKey?.fingerprints || (fingerprint ? [fingerprint] : []);
      if (!fingerprint) {
        items.push({ ...baseItem, status: 'missing_api_key', reason: 'account_api_key_missing' });
        continue;
      }
      const assets = providerAssets.get(provider.id);
      let keyMatches = assets.remoteKeys.filter((key) =>
        key.masked_key && fingerprints.includes(key.masked_key)
      );
      const normalizedFingerprintMatch = keyMatches.length > 0 &&
        keyMatches.every((key) => key.masked_key !== fingerprint);
      let gatewayMatch = null;
      if (keyMatches.length === 0) {
        const cacheKey = `${provider.id}|${account.id}`;
        if (!gatewayKeyMatches.has(cacheKey)) {
          gatewayKeyMatches.set(
            cacheKey,
            await this.#verifyGatewayKeyMatch(provider, accountKey, assets)
          );
        }
        gatewayMatch = gatewayKeyMatches.get(cacheKey);
        if (gatewayMatch.matched) keyMatches = [gatewayMatch.key];
      }
      if (keyMatches.length === 0) {
        items.push({
          ...baseItem,
          status: 'missing_remote_key',
          reason: 'api_key_not_found_in_provider',
          maskedKey: fingerprint,
          baseMaskedKey: fingerprint,
          providerMaskedKey: assets.remoteKeys.length === 1
            ? assets.remoteKeys[0].masked_key || null
            : null,
          providerMaskedKeys: assets.remoteKeys.map((key) => key.masked_key).filter(Boolean),
          keyVerification: gatewayMatch?.reason || null
        });
        continue;
      }
      if (keyMatches.length > 1) {
        items.push({
          ...baseItem,
          status: 'conflict',
          reason: 'remote_key_fingerprint_collision',
          maskedKey: fingerprint,
          keyCandidates: keyMatches.map((key) => ({ id: key.id, name: key.name }))
        });
        continue;
      }
      const key = keyMatches[0];
      const keyProviderRef = String(key.primary_group_ref || '').trim();
      const accountProviderRef = String(key.account_user_group || '').trim();
      const providerRef = keyProviderRef || accountProviderRef;
      let providerGroupSource = keyProviderRef
        ? 'key_explicit'
        : accountProviderRef
          ? 'account_inherited'
          : null;
      let providerGroup = gatewayMatch?.matched
        ? gatewayMatch.providerGroup
        : providerRef
          ? assets.remoteGroups.find((group) =>
            [group.id, group.remote_id, group.name].some((value) => String(value) === providerRef)
          )
          : null;
      if (gatewayMatch?.matched) providerGroupSource = 'gateway_verified';
      if (!providerGroup && !providerRef && assets.remoteGroups.length === 1) {
        providerGroup = assets.remoteGroups[0];
        providerGroupSource = 'sole_group_inferred';
      }
      const keyItem = {
        ...baseItem,
        keyId: key.id,
        keyName: key.name,
        maskedKey: key.masked_key,
        baseMaskedKey: fingerprint,
        providerMaskedKey: key.masked_key,
        keyMatch: gatewayMatch?.matched
          ? 'verified_gateway_billing'
          : normalizedFingerprintMatch
            ? 'normalized_fingerprint'
            : 'fingerprint',
        keyVerification: normalizedFingerprintMatch ? 'api_key_prefix_normalized' : null,
        verifiedBillingScope: gatewayMatch?.billingScope || null,
        providerGroupRef: providerGroup?.remote_id || providerRef || null,
        providerGroupName: providerGroup?.name || null,
        providerGroupSource,
        providerRate: finite(providerGroup?.ratio),
        providerRateScope: 'group_multiplier',
        channelCostVerified: ROUTED_GROUP_RATE_ADAPTERS.has(provider.adapter_type) ? false : null
      };
      if (!providerGroup) {
        items.push({
          ...keyItem,
          status: 'missing_provider_group',
          reason: providerRef ? 'provider_group_not_found' : 'key_has_no_primary_group'
        });
        continue;
      }
      const identity = mappingIdentity({
        connectionId: provider.id,
        keyId: key.id,
        accountId: account.id,
        groupId: baseGroup.id
      });
      const mapped = existing.get(identity);
      items.push({
        ...keyItem,
        status: mapped ? 'existing' : 'pending_create',
        reason: mapped ? 'mapping_exists' : null,
        mappingId: mapped?.id || null
      });
    }
    return { catalog, accountCatalog, items };
  }

  async #verifyGatewayKeyMatch(provider, accountKey, assets) {
    const rejected = (reason) => ({ matched: false, reason });
    if (!this.http || provider.adapter_type !== 'sub2api' || provider.auth_mode !== 'api_key') {
      return rejected('gateway_verification_not_supported');
    }

    const providerBaseUrl = normalizeGatewayBaseUrl(provider.base_url);
    const accountBaseUrl = normalizeGatewayBaseUrl(accountKey.baseUrl);
    if (!providerBaseUrl || !accountBaseUrl) return rejected('gateway_base_url_missing');
    if (providerBaseUrl !== accountBaseUrl) return rejected('gateway_base_url_mismatch');

    let response;
    try {
      response = await this.http.requestJson(
        new URL('/v1/sub2api/billing', `${provider.base_url.replace(/\/+$/, '')}/`).toString(),
        {
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${accountKey.apiKey}`
          },
          retries: 0
        }
      );
    } catch (error) {
      return rejected(`gateway_billing_${error?.code || 'failed'}`);
    }

    const billing = response?.data?.data ?? response?.data;
    if (!billing || typeof billing !== 'object' || Array.isArray(billing)) {
      return rejected('gateway_billing_schema_mismatch');
    }
    const billingScope = String(billing.billing_scope || '').trim();
    const billingRate = finite(
      billing.effective_rate_multiplier ??
      billing.resolved_rate_multiplier ??
      billing.group_rate_multiplier
    );
    if (!billingScope) return rejected('gateway_billing_scope_missing');
    const scopedGroups = assets.remoteGroups.filter((group) => {
      const savedBillingScope = String(group.metadata?.billingScope || '').trim();
      return savedBillingScope
        ? savedBillingScope === billingScope
        : [group.id, group.remote_id, group.name].some((value) => String(value) === billingScope);
    });
    if (scopedGroups.length === 0) return rejected('gateway_billing_group_mismatch');
    const matchingGroups = scopedGroups.filter((group) => equivalentRates(group.ratio, billingRate));
    if (matchingGroups.length === 0) return rejected('gateway_billing_rate_mismatch');
    const candidates = [];
    for (const providerGroup of matchingGroups) {
      const matchingKeys = assets.remoteKeys.filter((key) => {
        const providerRef = String(key.primary_group_ref || '').trim();
        return providerRef && [providerGroup.id, providerGroup.remote_id, providerGroup.name]
          .some((value) => String(value) === providerRef);
      });
      for (const key of matchingKeys) candidates.push({ key, providerGroup });
    }
    if (candidates.length === 0) return rejected('gateway_primary_group_mismatch');
    if (candidates.length > 1) return rejected('gateway_remote_key_ambiguous');
    const { key, providerGroup } = candidates[0];
    return {
      matched: true,
      key,
      providerGroup,
      billingScope,
      billingRate
    };
  }

  #translateAccountKeyExportError(error) {
    const remoteCode = String(error?.details?.remoteCode || '');
    const remoteStatus = Number(error?.details?.remoteStatus || error?.status) || null;
    const endpoint = '/api/v1/admin/accounts/data';
    if (remoteCode === 'STEP_UP_REQUIRED') {
      return new AppError(
        'SUB2API_STEP_UP_REQUIRED',
        'Sub2API requires recent TOTP verification for the current administrator session',
        { status: 403, details: { endpoint, remoteCode, remoteStatus: remoteStatus || 403 } }
      );
    }
    if (['STEP_UP_TOTP_NOT_ENABLED', 'TOTP_NOT_SETUP'].includes(remoteCode)) {
      return new AppError(
        'SUB2API_TOTP_NOT_ENABLED',
        'TOTP must be enabled for the current Sub2API administrator before account keys can be read',
        { status: 409, details: { endpoint, remoteCode, remoteStatus: remoteStatus || 403 } }
      );
    }
    if (remoteCode === 'STEP_UP_ADMIN_API_KEY_FORBIDDEN') {
      return new AppError(
        'SUB2API_ADMIN_API_KEY_EXPORT_FORBIDDEN',
        'Sub2API blocks administrator API Keys from account Key export while sensitive-operation step-up 2FA is enabled',
        {
          status: 409,
          details: {
            endpoint,
            remoteCode,
            remoteStatus: remoteStatus || 403,
            prerequisite: 'disable_sub2api_step_up_enabled_with_a_totp_verified_admin_session'
          }
        }
      );
    }
    if (remoteCode === 'STEP_UP_UNAVAILABLE') {
      return new AppError(
        'SUB2API_STEP_UP_UNAVAILABLE',
        'Sub2API step-up verification is temporarily unavailable',
        { status: 503, retryable: true, details: { endpoint, remoteCode, remoteStatus: remoteStatus || 503 } }
      );
    }
    if (Number(error?.status) === 403) {
      return new AppError(
        'SUB2API_KEY_EXPORT_FORBIDDEN',
        'Sub2API requires a recent two-factor verified administrator session to read account API keys',
        { status: 403, details: { endpoint, remoteStatus: 403 } }
      );
    }
    if ([404, 405, 501].includes(Number(error?.status))) {
      return new AppError(
        'SUB2API_KEY_EXPORT_UNSUPPORTED',
        'This Sub2API version does not expose the administrator account export endpoint',
        { status: 409, details: { endpoint, remoteStatus: Number(error?.status) } }
      );
    }
    return error;
  }

  async #requestAccountKeyExport(accounts, { accessToken = null } = {}) {
    let payload;
    try {
      payload = await this.sub2api.data('/api/v1/admin/accounts/data', {
        query: { ids: accounts.map((account) => account.id).join(','), include_proxies: false },
        ...(accessToken ? { accessToken } : {})
      });
    } catch (error) {
      throw this.#translateAccountKeyExportError(error);
    }
    const exported = payload?.accounts;
    if (!Array.isArray(exported) || exported.length !== accounts.length) {
      throw new AppError('SCHEMA_MISMATCH', 'Sub2API account export did not preserve the requested account set', {
        status: 502,
        details: {
          endpoint: '/api/v1/admin/accounts/data',
          requested: accounts.length,
          received: Array.isArray(exported) ? exported.length : null
        }
      });
    }
    payload = null;
    return exported;
  }

  #captureAccountKeyDetail(details, source, exported) {
    const exportedId = accountExportId(exported);
    if (
      (exportedId != null && exportedId !== String(source.id)) ||
      accountExportSignature(exported) !== accountExportSignature(source)
    ) {
      throw new AppError('SCHEMA_MISMATCH', 'Sub2API account export did not match the requested account', {
        status: 502,
        details: { endpoint: '/api/v1/admin/accounts/data', accountId: source.id }
      });
    }
    const credentials = exported?.credentials;
    const apiKey = String(credentials?.api_key || '').trim();
    if (!apiKey) return;
    const fingerprints = apiKeyFingerprintVariants(apiKey);
    details.set(source.id, {
      apiKey,
      fingerprint: fingerprints[0],
      fingerprints,
      baseUrl: String(credentials?.base_url || '').trim()
    });
  }

  async #accountKeyDetails(accounts, { accessToken = null } = {}) {
    const details = new Map();
    for (let offset = 0; offset < accounts.length; offset += 50) {
      const batch = accounts.slice(offset, offset + 50);
      const exported = await this.#requestAccountKeyExport(batch, { accessToken });
      const matchedAccountIds = new Set();
      const matchedExports = new Set();
      const exportsById = groupBy(
        exported.filter((item) => accountExportId(item) != null),
        accountExportId
      );

      for (const source of batch) {
        const items = exportsById.get(String(source.id)) || [];
        if (items.length !== 1) continue;
        this.#captureAccountKeyDetail(details, source, items[0]);
        matchedAccountIds.add(String(source.id));
        matchedExports.add(items[0]);
      }

      const remainingSources = batch.filter((source) => !matchedAccountIds.has(String(source.id)));
      const remainingExports = exported.filter((item) => !matchedExports.has(item));
      const sourceGroups = groupBy(remainingSources, accountExportSignature);
      const exportGroups = groupBy(remainingExports, accountExportSignature);
      for (const [signature, sources] of sourceGroups) {
        const items = exportGroups.get(signature) || [];
        if (sources.length !== 1 || items.length !== 1) continue;
        this.#captureAccountKeyDetail(details, sources[0], items[0]);
        matchedAccountIds.add(String(sources[0].id));
      }

      for (const source of batch) {
        if (matchedAccountIds.has(String(source.id))) continue;
        const exact = await this.#requestAccountKeyExport([source], { accessToken });
        this.#captureAccountKeyDetail(details, source, exact[0]);
      }
    }
    return details;
  }

  #compareMapping(mapping, catalog) {
    const config = mapping.config || {};
    const providerGroups = this.db.prepare(`
      SELECT id, remote_id, name, ratio, status, metadata_json
      FROM remote_groups WHERE connection_id = ? AND status != 'missing'
      ORDER BY name COLLATE NOCASE
    `).all(mapping.connection_id).map((row) => ({ ...row, metadata: parseJson(row.metadata_json, {}) }));
    const key = mapping.key_id
      ? this.db.prepare(`
          SELECT k.primary_group_ref, k.backup_group_ref, k.status,
            a.user_group AS account_user_group
          FROM remote_keys k
          LEFT JOIN remote_accounts a ON a.id = k.remote_account_id
          WHERE k.id = ?
        `).get(mapping.key_id)
      : null;
    const explicitProviderRef = config.upstreamGroupRef == null ? null : String(config.upstreamGroupRef);
    const keyProviderRef = String(key?.primary_group_ref || '').trim() || null;
    const accountProviderRef = String(key?.account_user_group || '').trim() || null;
    const providerRef = explicitProviderRef || keyProviderRef || accountProviderRef || null;
    const providerRefSpecified = providerRef != null && String(providerRef).trim() !== '';
    let providerGroupSource = explicitProviderRef
      ? 'mapping_explicit'
      : keyProviderRef
        ? 'key_explicit'
        : accountProviderRef
          ? 'account_inherited'
          : null;
    let providerGroup = providerRef
      ? providerGroups.find((group) => [group.id, group.remote_id, group.name].some((value) => String(value) === String(providerRef)))
      : null;

    const baseGroupId = finite(mapping.group_id);
    const baseGroup = baseGroupId == null ? null : catalog.groups.find((group) => Number(group.id) === Number(baseGroupId));
    if (!providerGroup && !providerRefSpecified && baseGroup) {
      providerGroup = providerGroups.find((group) => group.name.toLowerCase() === baseGroup.name.toLowerCase()) || null;
      if (providerGroup) providerGroupSource = 'base_group_name_inferred';
    }
    if (!providerGroup && !providerRefSpecified && providerGroups.length === 1) {
      providerGroup = providerGroups[0];
      providerGroupSource = 'sole_group_inferred';
    }

    const storedTolerance = parseJson(this.db.prepare(`SELECT value_json FROM settings WHERE key = 'sub2apiRateToleranceRatio'`).get()?.value_json, 0.05);
    const toleranceRatio = Math.max(0, finite(config.rateToleranceRatio) ?? finite(storedTolerance) ?? 0.05);
    const providerGroupRate = finite(providerGroup?.ratio);
    const keyMissing = Boolean(mapping.key_id && (!key || key.status === 'missing'));
    const dynamicRouteEnabled = mapping.dynamicRoute?.enabled === true;
    const dynamicRouteRate = finite(mapping.dynamicRoute?.multiplier);
    const dynamicRateStatus = mapping.dynamicRoute?.status;
    const providerRate = keyMissing ? null : dynamicRouteEnabled ? dynamicRouteRate : providerGroupRate;
    const baseGroupRate = finite(baseGroup?.effectiveRate ?? baseGroup?.defaultRate);
    const rechargeMultiplier = finite(mapping.recharge?.multiplier);
    const compositeRate = providerRate != null && rechargeMultiplier != null && rechargeMultiplier > 0
      ? providerRate / rechargeMultiplier
      : null;
    const differenceRatio = compositeRate != null && compositeRate !== 0 && baseGroupRate != null
      ? (baseGroupRate - compositeRate) / Math.abs(compositeRate)
      : null;
    let status = 'aligned';
    if (!mapping.enabled) status = 'mapping_disabled';
    else if (keyMissing) status = 'missing_remote_key';
    else if (baseGroupId == null) status = 'base_group_unselected';
    else if (!baseGroup) status = 'missing_base_group';
    else if (!providerGroup) status = 'missing_provider_group';
    else if (dynamicRouteEnabled && dynamicRateStatus === 'missing_provider_price') status = 'missing_provider_price';
    else if (dynamicRouteEnabled && dynamicRateStatus === 'partial_provider_price') status = 'partial_provider_price';
    else if (dynamicRouteEnabled && dynamicRateStatus === 'missing_reference_price') status = 'missing_reference_price';
    else if (dynamicRouteEnabled && dynamicRateStatus === 'partial_reference_price') status = 'partial_reference_price';
    else if (dynamicRouteEnabled && dynamicRouteRate == null) status = 'missing_dynamic_route_rate';
    else if (providerRate == null || baseGroupRate == null || compositeRate == null) status = 'missing_rate';
    else if (providerRate <= 0 || compositeRate <= 0) status = 'invalid_provider_rate';
    else if (Math.abs(differenceRatio) > toleranceRatio) status = 'rate_mismatch';

    return {
      mappingId: mapping.id,
      status,
      providerGroupRef: providerGroup?.remote_id || providerRef || null,
      providerGroupName: providerGroup?.name || null,
      providerRate,
      baseGroupId,
      baseGroupName: baseGroup?.name || null,
      baseGroupRate,
      differenceRatio,
      toleranceRatio,
      checkedAt: catalog.capturedAt,
      details: {
        explicitProviderGroup: Boolean(explicitProviderRef),
        baseGroupDefaultRate: baseGroup?.defaultRate ?? null,
        baseGroupEffectiveRate: baseGroup?.effectiveRate ?? null,
        baseGroupPlatform: baseGroup?.platform || '',
        providerGroupStatus: providerGroup?.status || null,
        providerGroupSource,
        keyStatus: key?.status || null,
        providerGroupRate,
        providerRateScope: dynamicRouteEnabled ? 'dynamic_route_history' : 'group_multiplier',
        providerRateBasis: dynamicRouteEnabled ? mapping.dynamicRoute?.priceBasis || null : 'group_multiplier',
        dynamicRouteRate: dynamicRouteEnabled ? mapping.dynamicRoute : null,
        rechargeMultiplier,
        rechargeSource: mapping.recharge?.source || null,
        compositeRate,
        compositeFormula: 'provider_rate/recharge_multiplier',
        differenceRateScope: 'composite_rate',
        differenceFormula: '(base_group_rate-composite_rate)/abs(composite_rate)',
        requestBillingVerified: dynamicRouteEnabled && dynamicRouteRate != null,
        channelCostVerified: ROUTED_GROUP_RATE_ADAPTERS.has(mapping.provider_adapter_type) ? false : null,
        providerAdapterType: mapping.provider_adapter_type || null
      }
    };
  }

  async #baseCatalog({ force = false, accessToken = null, strictRates = false } = {}) {
    if (!force && this.baseCatalogCache?.expiresAt > Date.now()) return this.baseCatalogCache.value;
    if (!force && this.baseCatalogRequest) return this.baseCatalogRequest;
    const request = (async () => {
      let groups;
      try {
        const all = await this.sub2api.data('/api/v1/admin/groups/all', {
          query: { include_inactive: true },
          ...(accessToken ? { accessToken } : {})
        });
        groups = Array.isArray(all) ? all : all?.items || all?.groups;
        if (!Array.isArray(groups)) {
          throw new AppError('SCHEMA_MISMATCH', 'Sub2API group response did not contain an array', {
            status: 502,
            details: { endpoint: '/api/v1/admin/groups/all' }
          });
        }
      } catch (error) {
        if (error?.code === 'SCHEMA_MISMATCH') throw error;
        groups = (await this.sub2api.listAll(
          '/api/v1/admin/groups',
          { include_inactive: true },
          { maxItems: 5000, accessToken }
        )).items;
      }
      let rates = {};
      try {
        rates = groupRateMap(await this.sub2api.data('/api/v1/groups/rates', {
          ...(accessToken ? { accessToken } : {})
        }));
      } catch (error) {
        const authSource = this.sub2api.authenticationStatus?.().source || null;
        if (strictRates && (accessToken || authSource !== 'admin_api_key')) throw error;
      }
      const capturedAt = nowIso();
      const normalizedGroups = groups.map((group) => normalizeBaseGroup(group, rates)).filter((item) => item.id != null);
      if (normalizedGroups.length !== groups.length) {
        throw new AppError('SCHEMA_MISMATCH', 'Sub2API group catalog contained an item without an ID', {
          status: 502,
          details: { endpoint: '/api/v1/admin/groups/all' }
        });
      }
      if (strictRates) {
        const invalidRates = normalizedGroups.filter((group) =>
          finite(group.effectiveRate ?? group.defaultRate) == null ||
          Number(group.effectiveRate ?? group.defaultRate) <= 0
        );
        if (invalidRates.length > 0) {
          throw new AppError(
            'SUB2API_GROUP_RATE_INCOMPLETE',
            'Sub2API returned one or more groups without a valid rate multiplier',
            {
              status: 409,
              details: {
                groupIds: invalidRates.slice(0, 100).map((group) => group.id),
                omitted: Math.max(0, invalidRates.length - 100),
                endpoint: '/api/v1/admin/groups/all'
              }
            }
          );
        }
      }
      const value = {
        groups: normalizedGroups,
        capturedAt
      };
      this.baseCatalogCache = { value, expiresAt: Date.now() + 30000 };
      return value;
    })();
    if (!force) this.baseCatalogRequest = request;
    try {
      return await request;
    } finally {
      if (this.baseCatalogRequest === request) this.baseCatalogRequest = null;
    }
  }

  async #baseAccounts({ force = false, accessToken = null } = {}) {
    if (!force && this.baseAccountsCache?.expiresAt > Date.now()) return this.baseAccountsCache.value;
    if (!force && this.baseAccountsRequest) return this.baseAccountsRequest;
    const request = (async () => {
      const result = await this.sub2api.listAll(
        '/api/v1/admin/accounts',
        {},
        { maxItems: 50000, accessToken }
      );
      const accounts = result.items.map(normalizeBaseAccount).filter((account) => account.id != null);
      if (accounts.length !== result.items.length) {
        throw new AppError('SCHEMA_MISMATCH', 'Sub2API account list contained an item without an ID', {
          status: 502,
          details: { endpoint: '/api/v1/admin/accounts' }
        });
      }
      const expiresAt = Date.now() + 30000;
      const value = { accounts, capturedAt: nowIso() };
      this.baseAccountsCache = { value, expiresAt };
      for (const account of accounts) {
        this.baseAccountCache.set(Number(account.id), { value: account, expiresAt });
      }
      return value;
    })();
    if (!force) this.baseAccountsRequest = request;
    try {
      return await request;
    } finally {
      if (this.baseAccountsRequest === request) this.baseAccountsRequest = null;
    }
  }

  async #mappedBaseAccounts(accountIds, { force = false, accessToken = null } = {}) {
    const accounts = [];
    for (let offset = 0; offset < accountIds.length; offset += 10) {
      const batch = await Promise.all(accountIds.slice(offset, offset + 10).map((accountId) =>
        this.#baseAccount(accountId, { force, accessToken })
      ));
      accounts.push(...batch.filter(Boolean));
    }
    return { accounts, capturedAt: nowIso() };
  }

  async #baseAccount(accountId, { force = false, accessToken = null } = {}) {
    const id = Number(accountId);
    const cached = this.baseAccountCache.get(id);
    if (!force && cached?.expiresAt > Date.now()) return cached.value;
    if (!force && this.baseAccountRequests.has(id)) return this.baseAccountRequests.get(id);
    const request = (async () => {
      let payload;
      try {
        payload = await this.sub2api.data(`/api/v1/admin/accounts/${id}`, {
          ...(accessToken ? { accessToken } : {})
        });
      } catch (error) {
        if (Number(error?.status) !== 404) throw error;
        this.baseAccountCache.set(id, { value: null, expiresAt: Date.now() + 30000 });
        return null;
      }
      const account = normalizeBaseAccount(payload?.account ?? payload);
      if (account.id == null) {
        throw new AppError('SCHEMA_MISMATCH', 'Sub2API account response did not contain an ID', {
          status: 502,
          details: { endpoint: `/api/v1/admin/accounts/${id}` }
        });
      }
      this.baseAccountCache.set(id, { value: account, expiresAt: Date.now() + 30000 });
      return account;
    })();
    if (!force) this.baseAccountRequests.set(id, request);
    try {
      return await request;
    } finally {
      if (this.baseAccountRequests.get(id) === request) this.baseAccountRequests.delete(id);
    }
  }

  #snapshot(connectionId, subjectType, subjectId, currency, at) {
    const subjectClause = subjectId ? 'AND subject_id = ?' : '';
    const params = [connectionId, subjectType];
    if (subjectId) params.push(subjectId);
    params.push(currency, at);
    return this.db.prepare(`
      WITH combined AS (
        SELECT id, connection_id, subject_type, subject_id, currency, available,
          total, used, granted, topped_up, frozen, unlimited, source_field,
          raw_json, captured_at FROM balance_snapshots
        UNION ALL
        SELECT id, connection_id, subject_type, subject_id, currency, available,
          total, used, granted, topped_up, frozen, unlimited, source_field,
          raw_json, captured_at FROM balance_aggregates
      )
      SELECT * FROM combined
      WHERE connection_id = ? AND subject_type = ? ${subjectClause}
        AND currency = ? AND captured_at <= ?
      ORDER BY captured_at DESC, id DESC LIMIT 1
    `).get(...params);
  }

  async #sub2apiUsage(mapping, periodStart, periodEnd) {
    const query = {
      start_date: dayInTimezone(periodStart, this.config.timezone),
      end_date: dayInTimezone(periodEnd, this.config.timezone),
      timezone: this.config.timezone,
      exact_total: true
    };
    if (mapping.account_id) query.account_id = mapping.account_id;
    if (mapping.group_id) query.group_id = mapping.group_id;
    const result = await this.sub2api.listAll('/api/v1/admin/usage', query, { maxItems: 20000 });
    const startMs = Date.parse(periodStart);
    const endMs = Date.parse(periodEnd);
    const matching = result.items.filter((row) => {
      const created = Date.parse(row.created_at);
      const inPeriod = !Number.isFinite(created) || (created >= startMs && created <= endMs);
      const accountMatches = mapping.account_id == null || row.account_id == null ||
        Number(row.account_id) === Number(mapping.account_id);
      const groupMatches = mapping.group_id == null || row.group_id == null ||
        Number(row.group_id) === Number(mapping.group_id);
      return inPeriod && accountMatches && groupMatches;
    });
    return {
      records: matching.length,
      totalRequests: matching.length,
      totalTokens: matching.reduce((sum, row) => sum + Number(row.input_tokens || 0) + Number(row.output_tokens || 0), 0),
      userCost: matching.reduce((sum, row) => sum + Number(row.actual_cost || 0), 0),
      upstreamCost: matching.reduce((sum, row) => {
        if (row.account_stats_cost != null) return sum + Number(row.account_stats_cost || 0);
        return sum + Number(row.total_cost || 0) * Number(row.account_rate_multiplier ?? 1);
      }, 0),
      truncated: result.truncated,
      fetched: result.items.length,
      remoteTotal: result.total
    };
  }

  async #monitorHealth(mapping) {
    const config = parseJson(mapping.config_json, {});
    if (!config.channelMonitorId) return { score: null, monitor: null };
    try {
      const list = await this.sub2api.listAll('/api/v1/admin/channel-monitors', {}, { maxItems: 5000 });
      const monitor = list.items.find((item) => Number(item.id) === Number(config.channelMonitorId));
      if (!monitor) return { score: null, monitor: null, error: 'CHANNEL_MONITOR_NOT_FOUND' };
      const status = String(monitor.primary_status || '').toLowerCase();
      const score = status === 'healthy' || status === 'passed' || status === 'success'
        ? 100
        : status === 'degraded' || status === 'warning'
          ? 60
          : status ? 10 : finite(monitor.availability_7d);
      return { score: score == null ? null : Math.max(0, Math.min(100, score)), monitor };
    } catch (error) {
      return { score: null, monitor: null, error: asAppError(error).code };
    }
  }

  async reconcile(id, input = {}) {
    const mapping = this.db.prepare(`
      SELECT m.*, p.name AS provider_name, p.last_success_at, p.last_error_code
      FROM sub2api_mappings m JOIN provider_connections p ON p.id = m.connection_id
      WHERE m.id = ?
    `).get(id);
    if (!mapping) throw new AppError('MAPPING_NOT_FOUND', 'Sub2API mapping was not found', { status: 404 });
    const periodEnd = input.periodEnd ? new Date(input.periodEnd).toISOString() : nowIso();
    const periodStart = input.periodStart
      ? new Date(input.periodStart).toISOString()
      : new Date(Date.parse(periodEnd) - 24 * 3600000).toISOString();
    if (Date.parse(periodStart) >= Date.parse(periodEnd)) {
      throw new AppError('INVALID_PERIOD', 'Reconciliation start must be before end', { status: 400 });
    }
    const currency = input.currency || parseJson(mapping.config_json, {}).currency || 'USD';
    const runId = crypto.randomUUID();
    const createdAt = nowIso();
    this.db.prepare(`
      INSERT INTO reconciliation_runs(id, mapping_id, status, period_start, period_end, details_json, created_at)
      VALUES (?, ?, 'running', ?, ?, '{}', ?)
    `).run(runId, id, periodStart, periodEnd, createdAt);
    try {
      const start = this.#snapshot(mapping.connection_id, 'account', null, currency, periodStart);
      const end = this.#snapshot(mapping.connection_id, 'account', null, currency, periodEnd);
      const keyStart = mapping.key_id ? this.#snapshot(mapping.connection_id, 'key', mapping.key_id, currency, periodStart) : null;
      const keyEnd = mapping.key_id ? this.#snapshot(mapping.connection_id, 'key', mapping.key_id, currency, periodEnd) : null;
      const balanceDecrease = start?.available == null || end?.available == null
        ? null : Number(start.available) - Number(end.available);
      const keyUsageDelta = keyStart?.used == null || keyEnd?.used == null
        ? null : Number(keyEnd.used) - Number(keyStart.used);
      const usage = await this.#sub2apiUsage(mapping, periodStart, periodEnd);
      const expectedCost = usage.upstreamCost;
      const differenceAmount = balanceDecrease == null ? null : balanceDecrease - expectedCost;
      const differenceRatio = differenceAmount == null || expectedCost === 0
        ? null : differenceAmount / Math.abs(expectedCost);
      const assetAge = mapping.last_success_at ? (Date.now() - Date.parse(mapping.last_success_at)) / 60000 : Infinity;
      const assetScore = mapping.last_error_code ? 20 : assetAge > this.config.staleAfterMinutes ? 55 : 100;
      const monitor = await this.#monitorHealth(mapping);
      const healthScore = monitor.score == null ? assetScore : assetScore * 0.55 + monitor.score * 0.45;
      const status = usage.truncated || balanceDecrease == null ? 'partial' : 'succeeded';
      const toleranceSetting = this.db.prepare(`SELECT value_json FROM settings WHERE key = 'reconciliationToleranceRatio'`).get();
      const toleranceRatio = Number(input.toleranceRatio ?? parseJson(toleranceSetting?.value_json, 0.05));
      const details = {
        currency,
        startSnapshot: start ? { available: start.available, capturedAt: start.captured_at } : null,
        endSnapshot: end ? { available: end.available, capturedAt: end.captured_at } : null,
        sub2api: usage,
        channelMonitor: monitor,
        interpretation: differenceAmount == null
          ? 'insufficient_balance_snapshots'
          : Math.abs(differenceRatio || 0) <= toleranceRatio
            ? 'within_tolerance'
            : differenceAmount > 0 ? 'possible_untracked_or_third_party_usage' : 'possible_overbilling_or_balance_credit'
      };
      this.db.prepare(`
        UPDATE reconciliation_runs SET status = ?, upstream_balance_delta = ?,
          upstream_key_usage_delta = ?, sub2api_cost = ?, expected_cost = ?,
          difference_amount = ?, difference_ratio = ?, health_score = ?,
          details_json = ?, completed_at = ? WHERE id = ?
      `).run(status, balanceDecrease, keyUsageDelta, usage.userCost, expectedCost, differenceAmount, differenceRatio, healthScore, stringifyJson(details), nowIso(), runId);
      return this.getReconciliation(runId);
    } catch (error) {
      const appError = asAppError(error, 'RECONCILIATION_FAILED');
      this.db.prepare(`
        UPDATE reconciliation_runs SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?
      `).run(appError.message.slice(0, 1000), nowIso(), runId);
      throw appError;
    }
  }

  getReconciliation(id) {
    const row = this.db.prepare(`
      SELECT r.*, m.connection_id, m.group_id, p.name AS provider_name
      FROM reconciliation_runs r JOIN sub2api_mappings m ON m.id = r.mapping_id
      JOIN provider_connections p ON p.id = m.connection_id WHERE r.id = ?
    `).get(id);
    if (!row) throw new AppError('RECONCILIATION_NOT_FOUND', 'Reconciliation run was not found', { status: 404 });
    return { ...row, details: parseJson(row.details_json, {}), details_json: undefined };
  }

  listReconciliations({ mappingId, limit = 200 } = {}) {
    const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 200));
    const rows = mappingId
      ? this.db.prepare(`SELECT * FROM reconciliation_runs WHERE mapping_id = ? ORDER BY created_at DESC LIMIT ?`).all(mappingId, safeLimit)
      : this.db.prepare(`SELECT * FROM reconciliation_runs ORDER BY created_at DESC LIMIT ?`).all(safeLimit);
    return rows.map((row) => ({ ...row, details: parseJson(row.details_json, {}), details_json: undefined }));
  }
}

module.exports = {
  MappingService,
  dayInTimezone,
  normalizeName,
  normalizeGatewayBaseUrl,
  equivalentRates,
  normalizeBaseChannel,
  normalizeBaseGroup,
  normalizeBaseAccount,
  matchProviderAccounts,
  mappingIdentity,
  highestMapping,
  attachBaseAccounts,
  groupComparisons,
  comparisonSummary,
  autoMappingSummary
};
