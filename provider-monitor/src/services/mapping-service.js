const crypto = require('crypto');
const { AppError, asAppError } = require('../errors');
const { nowIso, parseJson, stringifyJson } = require('../db');
const { maskKey } = require('../security/redaction');

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
    groupIds: normalizeGroupIds(account),
    hasApiKey: Boolean(
      account?.credentials_status?.has_api_key ||
      ['api_key', 'apikey', 'upstream'].includes(String(account?.type || '').toLowerCase())
    )
  };
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
      const rate = finite(item.comparison?.providerRate);
      return rate != null && rate > 0;
    })
    .sort((left, right) => {
      const rateDifference = Number(right.comparison.providerRate) - Number(left.comparison.providerRate);
      if (rateDifference !== 0) return rateDifference;
      const providerDifference = String(left.provider_name || '').localeCompare(String(right.provider_name || ''), undefined, { sensitivity: 'base' });
      if (providerDifference !== 0) return providerDifference;
      const keyDifference = String(left.key_id || '').localeCompare(String(right.key_id || ''));
      if (keyDifference !== 0) return keyDifference;
      return String(left.id).localeCompare(String(right.id));
    })[0] || null;
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
  constructor({ db, config, sub2api, http = null }) {
    this.db = db;
    this.config = config;
    this.sub2api = sub2api;
    this.http = http;
    this.baseCatalogCache = null;
    this.baseCatalogRequest = null;
  }

  list({ connectionId } = {}) {
    const clauses = [];
    const params = [];
    if (connectionId) { clauses.push('m.connection_id = ?'); params.push(connectionId); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`
      SELECT m.*, p.name AS provider_name, k.name AS key_name, k.masked_key,
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
      LEFT JOIN remote_keys k ON k.id = m.key_id
      LEFT JOIN sub2api_mapping_states s ON s.mapping_id = m.id
      LEFT JOIN reconciliation_runs r ON r.id = (
        SELECT id FROM reconciliation_runs latest
        WHERE latest.mapping_id = m.id ORDER BY latest.created_at DESC LIMIT 1
      )
      ${where}
      ORDER BY m.group_id, CASE m.role WHEN 'primary' THEN 0 ELSE 1 END, p.name
    `).all(...params).map((row) => {
      const comparison = row.comparison_status ? {
        status: row.comparison_status,
        providerGroupRef: row.comparison_provider_group_ref,
        providerGroupName: row.comparison_provider_group_name,
        providerRate: row.comparison_provider_rate,
        baseGroupId: row.comparison_base_group_id,
        baseGroupName: row.comparison_base_group_name,
        baseGroupRate: row.comparison_base_group_rate,
        differenceRatio: row.comparison_difference_ratio,
        toleranceRatio: row.comparison_tolerance_ratio,
        details: parseJson(row.comparison_details_json, {}),
        checkedAt: row.comparison_checked_at
      } : null;
      const result = {
        ...row,
        enabled: Boolean(row.enabled),
        models: parseJson(row.models_json, []),
        config: parseJson(row.config_json, {}),
        comparison
      };
      for (const key of Object.keys(result)) {
        if (key === 'models_json' || key === 'config_json' || key.startsWith('comparison_')) delete result[key];
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

  async comparisons({ connectionId = null, catalog = null } = {}) {
    const baseCatalog = catalog || await this.#baseCatalog();
    const items = this.list({ connectionId });
    return {
      status: this.status(),
      summary: comparisonSummary(items),
      items,
      ...groupComparisons(items, baseCatalog)
    };
  }

  async refreshComparisons({ connectionId = null, force = true, catalog = null } = {}) {
    const baseCatalog = catalog || await this.#baseCatalog({ force });
    const mappings = this.list({ connectionId });
    const states = mappings.map((mapping) => this.#compareMapping(mapping, baseCatalog));
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
    this.db.transaction(() => {
      for (const state of states) {
        upsert.run(
          state.mappingId, state.status, state.providerGroupRef, state.providerGroupName,
          state.providerRate, state.baseGroupId, state.baseGroupName,
          state.baseGroupRate, state.differenceRatio,
          state.toleranceRatio, stringifyJson(state.details), state.checkedAt
        );
      }
    })();
    return this.comparisons({ connectionId, catalog: baseCatalog });
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
        const config = {
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

    const comparisons = await this.refreshComparisons({ force: false, catalog: discovery.catalog });
    return {
      mode,
      summary: autoMappingSummary(discovery.items),
      items: discovery.items,
      comparisons
    };
  }

  async #discoverAutoMappings({ accessToken = null } = {}) {
    const [catalog, accountsResult] = await Promise.all([
      this.#baseCatalog({ force: true, accessToken }),
      this.sub2api.listAll('/api/v1/admin/accounts', {}, { maxItems: 50000, accessToken })
    ]);
    const accounts = accountsResult.items.map(normalizeBaseAccount).filter((account) => account.id != null);
    if (accounts.length !== accountsResult.items.length) {
      throw new AppError('SCHEMA_MISMATCH', 'Sub2API account list contained an item without an ID', {
        status: 502,
        details: { endpoint: '/api/v1/admin/accounts' }
      });
    }
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
        SELECT id, name, masked_key, primary_group_ref, status
        FROM remote_keys
        WHERE connection_id = ? AND status != 'missing'
        ORDER BY name COLLATE NOCASE, id
      `).all(provider.id);
      const remoteGroups = this.db.prepare(`
        SELECT id, remote_id, name, ratio, status
        FROM remote_groups
        WHERE connection_id = ? AND status != 'missing'
        ORDER BY name COLLATE NOCASE, id
      `).all(provider.id);
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
      if (!fingerprint) {
        items.push({ ...baseItem, status: 'missing_api_key', reason: 'account_api_key_missing' });
        continue;
      }
      const assets = providerAssets.get(provider.id);
      let keyMatches = assets.remoteKeys.filter((key) => key.masked_key && key.masked_key === fingerprint);
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
      const providerRef = String(key.primary_group_ref || '').trim();
      const providerGroup = gatewayMatch?.matched
        ? gatewayMatch.providerGroup
        : providerRef
        ? assets.remoteGroups.find((group) =>
          [group.id, group.remote_id, group.name].some((value) => String(value) === providerRef)
        )
        : null;
      const keyItem = {
        ...baseItem,
        keyId: key.id,
        keyName: key.name,
        maskedKey: key.masked_key,
        baseMaskedKey: fingerprint,
        providerMaskedKey: key.masked_key,
        keyMatch: gatewayMatch?.matched ? 'verified_gateway_billing' : 'fingerprint',
        verifiedBillingScope: gatewayMatch?.billingScope || null,
        providerGroupRef: providerGroup?.remote_id || providerRef || null,
        providerGroupName: providerGroup?.name || null,
        providerRate: finite(providerGroup?.ratio)
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
    return { catalog, items };
  }

  async #verifyGatewayKeyMatch(provider, accountKey, assets) {
    const rejected = (reason) => ({ matched: false, reason });
    if (!this.http || provider.adapter_type !== 'sub2api' || provider.auth_mode !== 'api_key') {
      return rejected('gateway_verification_not_supported');
    }
    if (assets.remoteKeys.length !== 1) return rejected('gateway_remote_key_ambiguous');

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
    const providerGroup = assets.remoteGroups.find((group) =>
      [group.id, group.remote_id, group.name].some((value) => String(value) === billingScope)
    );
    if (!providerGroup) return rejected('gateway_billing_group_mismatch');
    if (!equivalentRates(providerGroup.ratio, billingRate)) {
      return rejected('gateway_billing_rate_mismatch');
    }

    const key = assets.remoteKeys[0];
    const providerRef = String(key.primary_group_ref || '').trim();
    if (providerRef && ![providerGroup.id, providerGroup.remote_id, providerGroup.name]
      .some((value) => String(value) === providerRef)) {
      return rejected('gateway_primary_group_mismatch');
    }
    return {
      matched: true,
      key,
      providerGroup,
      billingScope,
      billingRate
    };
  }

  async #accountKeyDetails(accounts, { accessToken = null } = {}) {
    const details = new Map();
    for (let offset = 0; offset < accounts.length; offset += 50) {
      const batch = accounts.slice(offset, offset + 50);
      let payload;
      try {
        payload = await this.sub2api.data('/api/v1/admin/accounts/data', {
          query: { ids: batch.map((account) => account.id).join(','), include_proxies: false },
          ...(accessToken ? { accessToken } : {})
        });
      } catch (error) {
        const remoteCode = String(error?.details?.remoteCode || '');
        const remoteStatus = Number(error?.details?.remoteStatus || error?.status) || null;
        if (remoteCode === 'STEP_UP_REQUIRED') {
          throw new AppError(
            'SUB2API_STEP_UP_REQUIRED',
            'Sub2API requires recent TOTP verification for the current administrator session',
            { status: 403, details: { remoteCode, remoteStatus: remoteStatus || 403 } }
          );
        }
        if (['STEP_UP_TOTP_NOT_ENABLED', 'TOTP_NOT_SETUP'].includes(remoteCode)) {
          throw new AppError(
            'SUB2API_TOTP_NOT_ENABLED',
            'TOTP must be enabled for the current Sub2API administrator before account keys can be read',
            { status: 409, details: { remoteCode, remoteStatus: remoteStatus || 403 } }
          );
        }
        if (remoteCode === 'STEP_UP_ADMIN_API_KEY_FORBIDDEN') {
          throw new AppError(
            'SUB2API_SSO_REQUIRED',
            'A Sub2API administrator SSO session is required to read account keys',
            { status: 409, details: { remoteCode, remoteStatus: remoteStatus || 403 } }
          );
        }
        if (remoteCode === 'STEP_UP_UNAVAILABLE') {
          throw new AppError(
            'SUB2API_STEP_UP_UNAVAILABLE',
            'Sub2API step-up verification is temporarily unavailable',
            { status: 503, retryable: true, details: { remoteCode, remoteStatus: remoteStatus || 503 } }
          );
        }
        if (Number(error?.status) === 403) {
          throw new AppError(
            'SUB2API_KEY_EXPORT_FORBIDDEN',
            'Sub2API requires a recent two-factor verified administrator session to read account API keys',
            { status: 403, details: { remoteStatus: 403 } }
          );
        }
        if ([404, 405, 501].includes(Number(error?.status))) {
          throw new AppError(
            'SUB2API_KEY_EXPORT_UNSUPPORTED',
            'This Sub2API version does not expose the administrator account export endpoint',
            { status: 409, details: { remoteStatus: Number(error?.status) } }
          );
        }
        throw error;
      }
      const exported = payload?.accounts;
      if (!Array.isArray(exported) || exported.length !== batch.length) {
        throw new AppError('SCHEMA_MISMATCH', 'Sub2API account export did not preserve the requested account set', {
          status: 502,
          details: { requested: batch.length, received: Array.isArray(exported) ? exported.length : null }
        });
      }
      for (let index = 0; index < batch.length; index += 1) {
        if (String(exported[index]?.name || '') !== batch[index].name) {
          throw new AppError('SCHEMA_MISMATCH', 'Sub2API account export order did not match the requested account IDs', {
            status: 502,
            details: { accountId: batch[index].id }
          });
        }
        const credentials = exported[index]?.credentials;
        const apiKey = String(credentials?.api_key || '').trim();
        if (apiKey) {
          details.set(batch[index].id, {
            apiKey,
            fingerprint: maskKey(apiKey),
            baseUrl: String(credentials?.base_url || '').trim()
          });
        }
      }
      payload = null;
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
      ? this.db.prepare('SELECT primary_group_ref, backup_group_ref FROM remote_keys WHERE id = ?').get(mapping.key_id)
      : null;
    const explicitProviderRef = config.upstreamGroupRef == null ? null : String(config.upstreamGroupRef);
    const providerRef = explicitProviderRef || key?.primary_group_ref || null;
    const providerRefSpecified = providerRef != null && String(providerRef).trim() !== '';
    let providerGroup = providerRef
      ? providerGroups.find((group) => [group.id, group.remote_id, group.name].some((value) => String(value) === String(providerRef)))
      : null;

    const baseGroupId = finite(mapping.group_id);
    const baseGroup = baseGroupId == null ? null : catalog.groups.find((group) => Number(group.id) === Number(baseGroupId));
    if (!providerGroup && !providerRefSpecified && baseGroup) {
      providerGroup = providerGroups.find((group) => group.name.toLowerCase() === baseGroup.name.toLowerCase()) || null;
    }
    if (!providerGroup && !providerRefSpecified && providerGroups.length === 1) providerGroup = providerGroups[0];

    const storedTolerance = parseJson(this.db.prepare(`SELECT value_json FROM settings WHERE key = 'sub2apiRateToleranceRatio'`).get()?.value_json, 0.05);
    const toleranceRatio = Math.max(0, finite(config.rateToleranceRatio) ?? finite(storedTolerance) ?? 0.05);
    const providerRate = finite(providerGroup?.ratio);
    const baseGroupRate = finite(baseGroup?.effectiveRate ?? baseGroup?.defaultRate);
    const differenceRatio = providerRate != null && providerRate !== 0 && baseGroupRate != null
      ? (baseGroupRate - providerRate) / Math.abs(providerRate)
      : null;
    let status = 'aligned';
    if (!mapping.enabled) status = 'mapping_disabled';
    else if (baseGroupId == null) status = 'base_group_unselected';
    else if (!baseGroup) status = 'missing_base_group';
    else if (!providerGroup) status = 'missing_provider_group';
    else if (providerRate == null || baseGroupRate == null) status = 'missing_rate';
    else if (providerRate <= 0) status = 'invalid_provider_rate';
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
        providerGroupStatus: providerGroup?.status || null
      }
    };
  }

  async #baseCatalog({ force = false, accessToken = null } = {}) {
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
      } catch {}
      const capturedAt = nowIso();
      const normalizedGroups = groups.map((group) => normalizeBaseGroup(group, rates)).filter((item) => item.id != null);
      if (normalizedGroups.length !== groups.length) {
        throw new AppError('SCHEMA_MISMATCH', 'Sub2API group catalog contained an item without an ID', {
          status: 502,
          details: { endpoint: '/api/v1/admin/groups/all' }
        });
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
  groupComparisons,
  comparisonSummary,
  autoMappingSummary
};
