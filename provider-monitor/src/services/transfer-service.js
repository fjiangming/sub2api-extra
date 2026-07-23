const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parse: parseCsv } = require('csv-parse/sync');
const { AppError } = require('../errors');
const { encryptJson, decryptJson } = require('../security/encryption');
const { redact, redactText } = require('../security/redaction');
const { nowIso, parseJson, stringifyJson } = require('../db');

const SETTING_DEFAULTS = {
  displayCurrency: 'USD',
  currencyRates: { USD: 1 },
  forecastMinSpanHours: 12,
  reconciliationToleranceRatio: 0.05,
  sub2apiRateToleranceRatio: 0.05,
  anomalyDropPercent: 20,
  anomalySpikeMultiplier: 3,
  keyHealthLevel: 'metadata',
  maintenanceWindows: [],
  catalogRefreshHours: 24,
  credentialBackupDays: 7,
  automationEnabled: false,
  allowedOrigins: [],
  allowedHosts: [],
  allowPrivateNetworks: false,
  sessionTtlMinutes: 480,
  queryTimeoutMs: 15000,
  maxResponseBytes: 2 * 1024 * 1024,
  defaultRefreshMinutes: 15,
  staleAfterMinutes: 60,
  rawSnapshotRetentionDays: 30,
  snapshotRetentionDays: 180,
  jobRetentionDays: 90,
  auditRetentionDays: 365,
  notificationRetentionDays: 180,
  keyHealthConcurrency: 3
};

const RUNTIME_SETTING_KEYS = new Set([
  'automationEnabled', 'allowedOrigins', 'allowedHosts', 'allowPrivateNetworks',
  'sessionTtlMinutes', 'queryTimeoutMs', 'maxResponseBytes', 'defaultRefreshMinutes',
  'staleAfterMinutes', 'rawSnapshotRetentionDays', 'snapshotRetentionDays',
  'jobRetentionDays', 'auditRetentionDays', 'notificationRetentionDays',
  'keyHealthConcurrency'
]);

const BOOLEAN_SETTINGS = new Set(['automationEnabled', 'allowPrivateNetworks']);
const LIST_SETTINGS = new Set(['allowedOrigins', 'allowedHosts']);
const INTEGER_SETTINGS = {
  sessionTtlMinutes: [15, 1440],
  queryTimeoutMs: [1000, 120000],
  maxResponseBytes: [1024, 20 * 1024 * 1024],
  defaultRefreshMinutes: [1, 1440],
  staleAfterMinutes: [5, 10080],
  rawSnapshotRetentionDays: [7, 3650],
  snapshotRetentionDays: [30, 3650],
  jobRetentionDays: [7, 3650],
  auditRetentionDays: [30, 3650],
  notificationRetentionDays: [7, 3650],
  keyHealthConcurrency: [1, 10]
};

const NOTIFICATION_TYPES = new Set([
  'webhook', 'telegram', 'gotify', 'bark', 'email', 'wecom', 'serverchan', 'dingtalk', 'feishu'
]);
const SENSITIVE_NOTIFICATION_URL_TYPES = new Set(['webhook', 'wecom', 'dingtalk', 'feishu']);
const SENSITIVE_CREDENTIAL_FIELD = /password|secret|token|api[_-]?key|authorization|cookie|credential|(?:master|management|device|send|access)[_-]?key|webhook/i;

function normalizeStringList(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
}

function normalizeSettingValue(key, value, fallback) {
  if (BOOLEAN_SETTINGS.has(key)) {
    if (typeof value === 'string') return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
    return Boolean(value);
  }
  if (LIST_SETTINGS.has(key)) return normalizeStringList(value);
  if (INTEGER_SETTINGS[key]) {
    const [min, max] = INTEGER_SETTINGS[key];
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
  }
  return value;
}

function runtimeDefaults(config) {
  return {
    automationEnabled: Boolean(config.automationEnabled),
    allowedOrigins: normalizeStringList(config.allowedOrigins),
    allowedHosts: normalizeStringList(config.allowedHosts),
    allowPrivateNetworks: Boolean(config.allowPrivateNetworks),
    sessionTtlMinutes: config.sessionTtlMinutes,
    queryTimeoutMs: config.queryTimeoutMs,
    maxResponseBytes: config.maxResponseBytes,
    defaultRefreshMinutes: config.defaultRefreshMinutes,
    staleAfterMinutes: config.staleAfterMinutes,
    rawSnapshotRetentionDays: config.rawSnapshotRetentionDays,
    snapshotRetentionDays: config.snapshotRetentionDays,
    jobRetentionDays: config.jobRetentionDays,
    auditRetentionDays: config.auditRetentionDays,
    notificationRetentionDays: config.notificationRetentionDays,
    keyHealthConcurrency: config.keyHealthConcurrency
  };
}

function applyRuntimeSettings(config, settings) {
  for (const key of RUNTIME_SETTING_KEYS) {
    config[key] = normalizeSettingValue(key, settings[key], SETTING_DEFAULTS[key]);
  }
  return config;
}

function csvEscape(value) {
  if (value == null) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function normalizeAdapter(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/_/g, '-');
  const aliases = {
    newapi: 'new-api', oneapi: 'one-api', onehub: 'one-hub', donehub: 'done-hub',
    voapi: 'voapi-v2', openrouterai: 'openrouter', lite_llm: 'litellm'
  };
  return aliases[normalized] || normalized || 'custom';
}

function firstValue(...values) {
  return values.find((value) => value != null && value !== '');
}

function redactConfigurationStrings(value) {
  if (Array.isArray(value)) return value.map((item) => redactConfigurationStrings(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactConfigurationStrings(item)])
    );
  }
  return typeof value === 'string' ? redactText(value) : value;
}

function secretFreeConfiguration(value) {
  return redactConfigurationStrings(redact(value || {}));
}

function secretFreeNotificationConfiguration(type, value) {
  const config = secretFreeConfiguration(value);
  if (SENSITIVE_NOTIFICATION_URL_TYPES.has(type)) {
    for (const field of ['url', 'webhookUrl']) {
      if (config[field]) config[field] = '[REDACTED]';
    }
  }
  return config;
}

function redactKnownSecretStrings(value, secrets) {
  if (Array.isArray(value)) return value.map((item) => redactKnownSecretStrings(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactKnownSecretStrings(item, secrets)])
    );
  }
  if (typeof value !== 'string') return value;
  let result = redactText(value);
  for (const secret of secrets) result = result.split(secret).join('[REDACTED]');
  return result;
}

function hasCredentialValue(credentials, ...names) {
  return names.some((name) => {
    const value = credentials?.[name];
    if (typeof value === 'string') return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === 'object') return Object.keys(value).length > 0;
    return value != null && value !== false;
  });
}

function hasUsableProviderCredentials(provider, credentials) {
  const adapterType = provider.adapterType;
  const authMode = String(provider.authMode || '').toLowerCase();

  if (adapterType === 'sub2api') {
    if (authMode === 'api_key') {
      return hasCredentialValue(credentials, 'apiKey');
    }
    if (['bearer', 'token_pair'].includes(authMode)) {
      return hasCredentialValue(credentials, 'accessToken', 'refreshToken');
    }
    return (
      hasCredentialValue(credentials, 'accessToken', 'refreshToken') ||
      (hasCredentialValue(credentials, 'email') && hasCredentialValue(credentials, 'password'))
    );
  }

  if (['new-api', 'one-api', 'one-hub', 'done-hub', 'veloera'].includes(adapterType)) {
    const hasToken = hasCredentialValue(credentials, 'systemToken', 'accessToken', 'apiKey');
    const needsUserId = ['new-api', 'veloera'].includes(adapterType);
    return hasToken && (!needsUserId || Boolean(provider.remoteUserId || credentials?.userId));
  }

  if (adapterType === 'deepseek') return hasCredentialValue(credentials, 'apiKey');
  if (adapterType === 'openrouter') return hasCredentialValue(credentials, 'managementKey', 'apiKey');
  if (adapterType === 'litellm') return hasCredentialValue(credentials, 'masterKey', 'apiKey');
  if (adapterType === 'voapi-v2') {
    return hasCredentialValue(credentials, 'accessToken', 'apiKey') &&
      Boolean(provider.remoteUserId || credentials?.userId);
  }
  if (adapterType === 'custom' && provider.credentialFields.length === 0) {
    return provider.restoreWithoutCredentials ||
      Object.keys(credentials || {}).some((name) => hasCredentialValue(credentials, name));
  }
  return Object.keys(credentials || {}).some((name) => hasCredentialValue(credentials, name));
}

class TransferService {
  constructor({ db, config, providers }) {
    this.db = db;
    this.config = config;
    this.providers = providers;
    this.defaults = { ...SETTING_DEFAULTS, ...runtimeDefaults(config) };
  }

  settings() {
    const stored = Object.fromEntries(this.db.prepare('SELECT key, value_json FROM settings').all().map((row) => [row.key, parseJson(row.value_json, null)]));
    const merged = { ...this.defaults, ...stored };
    for (const key of RUNTIME_SETTING_KEYS) {
      merged[key] = normalizeSettingValue(key, merged[key], this.defaults[key]);
    }
    return merged;
  }

  applyRuntimeSettings() {
    return applyRuntimeSettings(this.config, this.settings());
  }

  saveSettings(input) {
    const unknown = Object.keys(input).filter((key) => !Object.prototype.hasOwnProperty.call(this.defaults, key));
    if (unknown.length) throw new AppError('SETTING_UNKNOWN', `Unknown settings: ${unknown.join(', ')}`, { status: 400 });
    const upsert = this.db.prepare(`
      INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `);
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(input)) {
        upsert.run(key, stringifyJson(normalizeSettingValue(key, value, this.defaults[key])), nowIso());
      }
    })();
    const settings = this.settings();
    applyRuntimeSettings(this.config, settings);
    return settings;
  }

  #sensitiveCredentialValues(providers) {
    const values = new Set();
    const collect = (credentials) => {
      for (const [field, value] of Object.entries(credentials || {})) {
        if (
          SENSITIVE_CREDENTIAL_FIELD.test(field) &&
          typeof value === 'string' &&
          value.length >= 4
        ) {
          values.add(value);
        }
      }
    };
    for (const provider of providers) collect(this.providers.getCredentials(provider.id));
    for (const row of this.db.prepare(`
      SELECT e.payload FROM notification_channels c
      JOIN encrypted_credentials e ON e.id = c.credential_id
    `).all()) {
      collect(decryptJson(row.payload, this.config.secret));
    }
    return [...values].sort((left, right) => right.length - left.length);
  }

  #exportAlertRules(providerReferences, includeSensitive) {
    return this.db.prepare('SELECT * FROM alert_rules ORDER BY created_at, id').all().map((row) => ({
      ...row,
      connectionRef: row.connection_id
        ? providerReferences.get(row.connection_id) || { sourceId: row.connection_id }
        : null,
      config: includeSensitive
        ? parseJson(row.config_json, {})
        : secretFreeConfiguration(parseJson(row.config_json, {})),
      config_json: undefined
    }));
  }

  #exportNotificationChannels(includeCredentials = false) {
    return this.db.prepare(`
      SELECT c.*, e.payload AS credential_payload
      FROM notification_channels c
      LEFT JOIN encrypted_credentials e ON e.id = c.credential_id
      ORDER BY c.created_at, c.id
    `).all().map((row) => {
      const credentials = row.credential_payload
        ? decryptJson(row.credential_payload, this.config.secret)
        : {};
      const config = parseJson(row.config_json, {});
      return {
        id: row.id,
        name: row.name,
        type: row.type,
        enabled: Boolean(row.enabled),
        config: includeCredentials ? config : secretFreeNotificationConfiguration(row.type, config),
        credentialFields: Object.entries(credentials)
          .filter(([, value]) => value != null && value !== '')
          .map(([name]) => name),
        ...(includeCredentials ? { credentials } : {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    });
  }

  exportConfiguration(options = {}) {
    const includeSensitive = options.includeSensitive === true;
    const providers = this.providers.list();
    const providerReferences = new Map(providers.map((provider) => [provider.id, {
      sourceId: provider.id,
      name: provider.name,
      adapterType: provider.adapter_type,
      baseUrl: provider.base_url,
      accountDedupeKey: provider.account_dedupe_key,
      remoteUserId: provider.remote_user_id
    }]));
    const payload = {
      schema: 'provider-monitor/config-v1',
      exportedAt: nowIso(),
      providers: providers.map((provider) => ({
        sourceId: provider.id,
        name: provider.name,
        adapterType: provider.adapter_type,
        baseUrl: provider.base_url,
        authMode: provider.auth_mode,
        remoteUserId: provider.remote_user_id,
        enabled: provider.enabled,
        refreshIntervalMinutes: provider.refresh_interval_minutes,
        warningThreshold: provider.warning_threshold,
        secondaryWarningThreshold: provider.secondary_warning_threshold,
        thresholdCurrency: provider.threshold_currency,
        rechargeUrl: provider.rechargeUrl,
        rechargeMultiplier: provider.recharge?.manualMultiplier,
        typeConfig: includeSensitive
          ? provider.typeConfig
          : secretFreeConfiguration(provider.typeConfig),
        tags: provider.tags,
        note: includeSensitive ? provider.note : redactText(provider.note),
        accountDedupeKey: provider.account_dedupe_key,
        credentialFields: provider.credentialFields.map((field) => field.name)
      })),
      alertRules: this.#exportAlertRules(providerReferences, includeSensitive),
      notificationChannels: this.#exportNotificationChannels(includeSensitive),
      mappings: this.db.prepare('SELECT * FROM sub2api_mappings').all().map((row) => ({
        ...row,
        models: parseJson(row.models_json, []),
        config: includeSensitive
          ? parseJson(row.config_json, {})
          : secretFreeConfiguration(parseJson(row.config_json, {})),
        models_json: undefined,
        config_json: undefined
      })),
      settings: this.settings()
    };
    return includeSensitive
      ? payload
      : redactKnownSecretStrings(payload, this.#sensitiveCredentialValues(providers));
  }

  exportDisasterBundle(password) {
    if (String(password || '').length < 12) {
      throw new AppError('EXPORT_PASSWORD_WEAK', 'Disaster bundle password must contain at least 12 characters', { status: 400 });
    }
    const configuration = this.exportConfiguration({ includeSensitive: true });
    const providers = this.providers.list().map((provider) => ({
      ...configuration.providers.find((row) => row.sourceId === provider.id),
      credentials: this.providers.getCredentials(provider.id)
    }));
    const payload = {
      ...configuration,
      schema: 'provider-monitor/disaster-v1',
      providers,
      notificationChannels: this.#exportNotificationChannels(true)
    };
    return {
      schema: 'provider-monitor/encrypted-bundle-v1',
      exportedAt: payload.exportedAt,
      payload: encryptJson(payload, password)
    };
  }

  decodeDisasterBundle(bundle, password) {
    if (bundle?.schema !== 'provider-monitor/encrypted-bundle-v1' || !bundle.payload) {
      throw new AppError('IMPORT_FORMAT_INVALID', 'Encrypted disaster bundle is invalid', { status: 400 });
    }
    return decryptJson(bundle.payload, password);
  }

  restoreDisasterConfiguration(decoded, providerImport) {
    const alertRules = Array.isArray(decoded?.alertRules) ? decoded.alertRules : [];
    const notificationChannels = Array.isArray(decoded?.notificationChannels)
      ? decoded.notificationChannels
      : [];
    if (alertRules.length > 1000 || notificationChannels.length > 1000) {
      throw new AppError('IMPORT_TOO_LARGE', 'Disaster configuration exceeds the restore limit', {
        status: 413
      });
    }

    const providerIdMap = new Map();
    for (const result of providerImport?.results || []) {
      const source = decoded.providers?.[result.sourceIndex];
      if (source?.sourceId && result.providerId) providerIdMap.set(source.sourceId, result.providerId);
    }
    const providerExists = this.db.prepare('SELECT id FROM provider_connections WHERE id = ?');
    const now = nowIso();
    const restore = this.db.transaction(() => {
      let restoredAlertRules = 0;
      let restoredNotificationChannels = 0;
      const upsertRule = this.db.prepare(`
        INSERT INTO alert_rules(
          id, name, enabled, connection_id, rule_type, scope, currency, threshold,
          consecutive_matches, cooldown_minutes, config_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          enabled = excluded.enabled,
          connection_id = excluded.connection_id,
          rule_type = excluded.rule_type,
          scope = excluded.scope,
          currency = excluded.currency,
          threshold = excluded.threshold,
          consecutive_matches = excluded.consecutive_matches,
          cooldown_minutes = excluded.cooldown_minutes,
          config_json = excluded.config_json,
          updated_at = excluded.updated_at
      `);
      for (const rule of alertRules) {
        const sourceConnectionId = rule.connectionId ?? rule.connection_id ?? rule.connectionRef?.sourceId ?? null;
        let connectionId = null;
        if (sourceConnectionId) {
          connectionId = providerIdMap.get(sourceConnectionId) ||
            providerExists.get(sourceConnectionId)?.id || null;
          if (!connectionId) {
            throw new AppError(
              'DISASTER_REFERENCE_INVALID',
              `Alert rule ${rule.name || rule.id || 'unknown'} references a provider that was not restored`,
              { status: 409 }
            );
          }
        }
        const name = String(rule.name || '').trim();
        const ruleType = String(rule.ruleType || rule.rule_type || '').trim();
        if (!name || !ruleType) {
          throw new AppError('IMPORT_FORMAT_INVALID', 'Disaster bundle contains an invalid alert rule', {
            status: 400
          });
        }
        upsertRule.run(
          rule.id || crypto.randomUUID(),
          name,
          rule.enabled === false || rule.enabled === 0 ? 0 : 1,
          connectionId,
          ruleType,
          rule.scope || 'account',
          rule.currency || null,
          rule.threshold ?? null,
          Number(rule.consecutiveMatches ?? rule.consecutive_matches ?? 1),
          Number(rule.cooldownMinutes ?? rule.cooldown_minutes ?? 60),
          stringifyJson(rule.config || parseJson(rule.config_json, {})),
          rule.createdAt || rule.created_at || now,
          now
        );
        restoredAlertRules += 1;
      }

      for (const channel of notificationChannels) {
        const type = String(channel.type || '').trim();
        if (!NOTIFICATION_TYPES.has(type) || !String(channel.name || '').trim()) {
          throw new AppError('IMPORT_FORMAT_INVALID', 'Disaster bundle contains an invalid notification channel', {
            status: 400
          });
        }
        const requestedId = channel.id || crypto.randomUUID();
        const existing = this.db.prepare(`
          SELECT * FROM notification_channels
          WHERE id = ? OR (name = ? AND type = ?)
          ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END LIMIT 1
        `).get(requestedId, channel.name, type, requestedId);
        const channelId = existing?.id || requestedId;
        let credentialId = existing?.credential_id || null;
        const channelCredentials = channel.credentials && typeof channel.credentials === 'object' && !Array.isArray(channel.credentials)
          ? channel.credentials
          : {};
        if (Object.keys(channelCredentials).length > 0) {
          credentialId ||= crypto.randomUUID();
          this.db.prepare(`
            INSERT INTO encrypted_credentials(id, payload, created_at, rotated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, rotated_at = excluded.rotated_at
          `).run(
            credentialId,
            encryptJson(channelCredentials, this.config.secret),
            existing?.created_at || now,
            now
          );
        }
        const missingCredentials = Array.isArray(channel.credentialFields) &&
          channel.credentialFields.length > 0 && !credentialId;
        this.db.prepare(`
          INSERT INTO notification_channels(
            id, name, type, enabled, credential_id, config_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            type = excluded.type,
            enabled = excluded.enabled,
            credential_id = excluded.credential_id,
            config_json = excluded.config_json,
            updated_at = excluded.updated_at
        `).run(
          channelId,
          String(channel.name).trim(),
          type,
          missingCredentials || channel.enabled === false || channel.enabled === 0 ? 0 : 1,
          credentialId,
          stringifyJson(channel.config || {}),
          channel.createdAt || channel.created_at || now,
          now
        );
        restoredNotificationChannels += 1;
      }
      return {
        alertRules: restoredAlertRules,
        notificationChannels: restoredNotificationChannels
      };
    });
    return restore();
  }

  #records(format, content) {
    if (format === 'csv') {
      return parseCsv(String(content || ''), {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        bom: true,
        relax_column_count: true
      });
    }
    if (format === 'env') {
      const values = {};
      for (const line of String(content || '').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const separator = trimmed.indexOf('=');
        if (separator < 1) continue;
        values[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
      }
      const indexes = [...new Set(Object.keys(values).map((key) => key.match(/^PROVIDER_(\d+)_/)?.[1]).filter(Boolean))];
      return indexes.map((index) => ({
        name: values[`PROVIDER_${index}_NAME`],
        adapterType: values[`PROVIDER_${index}_ADAPTER`],
        baseUrl: values[`PROVIDER_${index}_BASE_URL`],
        authMode: values[`PROVIDER_${index}_AUTH_MODE`],
        remoteUserId: values[`PROVIDER_${index}_REMOTE_USER_ID`],
        apiKey: values[`PROVIDER_${index}_API_KEY`],
        enabled: values[`PROVIDER_${index}_ENABLED`]
      }));
    }
    const payload = typeof content === 'string' ? JSON.parse(content) : content;
    if (format === 'provider-monitor') return payload.providers || payload.connections || [];
    if (format === 'legacy-config') return payload.providers || payload.sites || Object.values(payload || {});
    if (format === 'all-api-hub') {
      if (Array.isArray(payload)) return payload;
      return payload.providers || payload.accounts || payload.sites || payload.items || payload.data || [];
    }
    throw new AppError('IMPORT_FORMAT_UNSUPPORTED', `Unsupported import format: ${format}`, { status: 400 });
  }

  #normalize(row, index) {
    const credentials = row.credentials && typeof row.credentials === 'object' ? { ...row.credentials } : {};
    const credentialFields = Array.isArray(row.credentialFields)
      ? row.credentialFields.map((field) => String(field).trim()).filter(Boolean)
      : [];
    const apiKey = firstValue(row.apiKey, row.api_key, row.token, row.systemToken, row.system_token);
    if (apiKey && Object.keys(credentials).length === 0) credentials.apiKey = apiKey;
    const adapterType = normalizeAdapter(firstValue(row.adapterType, row.adapter_type, row.provider, row.platform, row.type));
    if (adapterType === 'new-api' || adapterType === 'one-api' || adapterType === 'one-hub' || adapterType === 'done-hub' || adapterType === 'veloera') {
      if (apiKey) { delete credentials.apiKey; credentials.systemToken = apiKey; }
      const userId = firstValue(row.remoteUserId, row.remote_user_id, row.userId, row.user_id);
      if (userId) credentials.userId = userId;
    }
    if (adapterType === 'openrouter' && apiKey) {
      delete credentials.apiKey;
      credentials.managementKey = apiKey;
    }
    if (adapterType === 'litellm' && apiKey) {
      delete credentials.apiKey;
      credentials.masterKey = apiKey;
    }
    const baseUrl = firstValue(row.baseUrl, row.base_url, row.url, row.endpoint, row.host);
    const hasRechargeMultiplier = ['rechargeMultiplier', 'recharge_multiplier']
      .some((field) => Object.prototype.hasOwnProperty.call(row, field));
    const rechargeMultiplier = firstValue(row.rechargeMultiplier, row.recharge_multiplier);
    return {
      sourceIndex: index,
      name: String(firstValue(row.name, row.label, row.title, `${adapterType}-${index + 1}`)),
      adapterType,
      baseUrl: baseUrl ? String(baseUrl).replace(/\/+$/, '') : '',
      authMode: firstValue(row.authMode, row.auth_mode, 'api_key'),
      credentials,
      remoteUserId: firstValue(row.remoteUserId, row.remote_user_id, row.userId, row.user_id, null),
      enabled: row.enabled == null ? true : !['false', '0', 0, false].includes(row.enabled),
      refreshIntervalMinutes: Number(firstValue(row.refreshIntervalMinutes, row.refresh_interval_minutes, this.config.defaultRefreshMinutes)),
      warningThreshold: firstValue(row.warningThreshold, row.warning_threshold, null) == null ? null : Number(firstValue(row.warningThreshold, row.warning_threshold)),
      secondaryWarningThreshold: firstValue(row.secondaryWarningThreshold, row.secondary_warning_threshold, null) == null
        ? null
        : Number(firstValue(row.secondaryWarningThreshold, row.secondary_warning_threshold)),
      thresholdCurrency: firstValue(row.thresholdCurrency, row.threshold_currency, 'USD'),
      rechargeUrl: firstValue(row.rechargeUrl, row.recharge_url, null),
      ...(hasRechargeMultiplier
        ? { rechargeMultiplier: rechargeMultiplier == null ? null : Number(rechargeMultiplier) }
        : {}),
      typeConfig: row.typeConfig || row.type_config || {},
      tags: Array.isArray(row.tags) ? row.tags : String(row.tags || '').split(',').map((value) => value.trim()).filter(Boolean),
      note: row.note || '',
      accountDedupeKey: firstValue(row.accountDedupeKey, row.account_dedupe_key, null),
      credentialFields,
      restoreWithoutCredentials: Array.isArray(row.credentialFields)
    };
  }

  previewImport({ format, content }) {
    let records;
    try {
      records = this.#records(format, content);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('IMPORT_PARSE_FAILED', 'Import content could not be parsed', { status: 400 });
    }
    if (!Array.isArray(records)) throw new AppError('IMPORT_FORMAT_INVALID', 'Import content must contain a provider list', { status: 400 });
    if (records.length > 1000) throw new AppError('IMPORT_TOO_LARGE', 'An import may contain at most 1000 providers', { status: 413 });
    const existing = this.providers.list();
    const supported = new Set(['sub2api', 'new-api', 'one-api', 'one-hub', 'done-hub', 'veloera', 'deepseek', 'openrouter', 'litellm', 'voapi-v2', 'custom']);
    const items = records.map((row, index) => {
      const provider = this.#normalize(row, index);
      const match = existing.find((item) => item.adapter_type === provider.adapterType && item.base_url === provider.baseUrl &&
        String(item.account_dedupe_key || item.remote_user_id || '') === String(provider.accountDedupeKey || provider.remoteUserId || ''));
      const errors = [];
      if (!provider.baseUrl || !/^https?:\/\//i.test(provider.baseUrl)) errors.push('invalid_base_url');
      if (!supported.has(provider.adapterType)) errors.push('unsupported_adapter');
      const existingCredentials = match ? this.providers.getCredentials(match.id) : {};
      const missingCredentials = !hasUsableProviderCredentials(provider, {
        ...existingCredentials,
        ...provider.credentials
      });
      const missingCredentialAction = missingCredentials
        ? provider.restoreWithoutCredentials ? 'disable' : match ? 'preserve' : 'skip'
        : null;
      return {
        action: errors.length ? 'invalid' : match ? 'update' : 'create',
        existingId: match?.id || null,
        missingCredentials,
        missingCredentialAction,
        errors,
        provider
      };
    });
    return {
      format,
      total: items.length,
      create: items.filter((item) => item.action === 'create').length,
      update: items.filter((item) => item.action === 'update').length,
      invalid: items.filter((item) => item.action === 'invalid').length,
      missingCredentials: items.filter((item) => item.missingCredentials).length,
      disableForMissingCredentials: items.filter((item) => item.missingCredentialAction === 'disable').length,
      skipForMissingCredentials: items.filter((item) => item.missingCredentialAction === 'skip').length,
      items
    };
  }

  applyImport(input) {
    const preview = this.previewImport(input);
    if (preview.invalid) throw new AppError('IMPORT_HAS_ERRORS', 'Import contains invalid providers', { status: 409, details: preview });
    const runId = crypto.randomUUID();
    const createdAt = nowIso();
    this.db.prepare(`INSERT INTO import_runs(id, format, status, summary_json, created_at) VALUES (?, ?, 'running', '{}', ?)`).run(runId, input.format, createdAt);
    const results = [];
    try {
      for (const item of preview.items) {
        if (item.missingCredentialAction === 'skip' && item.action === 'create') {
          results.push({ sourceIndex: item.provider.sourceIndex, status: 'skipped', reason: 'missing_credentials' });
          continue;
        }
        const payload = { ...item.provider };
        delete payload.sourceIndex;
        delete payload.credentialFields;
        delete payload.restoreWithoutCredentials;
        if (item.missingCredentialAction === 'disable') payload.enabled = false;
        const provider = item.action === 'update'
          ? this.providers.update(item.existingId, payload)
          : this.providers.create(payload);
        results.push({
          sourceIndex: item.provider.sourceIndex,
          status: item.action === 'update' ? 'updated' : 'created',
          providerId: provider.id,
          disabledForMissingCredentials: item.missingCredentialAction === 'disable'
        });
      }
      const summary = {
        ...preview,
        items: undefined,
        created: results.filter((item) => item.status === 'created').length,
        updated: results.filter((item) => item.status === 'updated').length,
        skipped: results.filter((item) => item.status === 'skipped').length,
        disabledForMissingCredentials: results.filter((item) => item.disabledForMissingCredentials).length,
        results
      };
      this.db.prepare(`UPDATE import_runs SET status = 'succeeded', summary_json = ?, completed_at = ? WHERE id = ?`).run(stringifyJson(summary), nowIso(), runId);
      return { id: runId, ...summary };
    } catch (error) {
      this.db.prepare(`UPDATE import_runs SET status = 'failed', summary_json = ?, completed_at = ? WHERE id = ?`).run(stringifyJson({ message: error.message, results }), nowIso(), runId);
      throw error;
    }
  }

  exportCsv(kind) {
    let headers;
    let rows;
    if (kind === 'balances') {
      headers = ['provider', 'subject_type', 'subject_id', 'currency', 'available', 'total', 'used', 'captured_at'];
      rows = this.db.prepare(`
        WITH combined AS (
          SELECT connection_id, subject_type, subject_id, currency, available, total, used, captured_at
          FROM balance_snapshots
          UNION ALL
          SELECT connection_id, subject_type, subject_id, currency, available, total, used, captured_at
          FROM balance_aggregates
        )
        SELECT p.name provider, s.subject_type, s.subject_id, s.currency, s.available,
          s.total, s.used, s.captured_at FROM combined s
        JOIN provider_connections p ON p.id = s.connection_id ORDER BY s.captured_at DESC
      `).all();
    } else if (kind === 'usage') {
      headers = ['provider', 'subject_type', 'subject_id', 'currency', 'cost', 'requests', 'input_tokens', 'output_tokens', 'total_tokens', 'model', 'captured_at'];
      rows = this.db.prepare(`
        WITH combined AS (
          SELECT connection_id, subject_type, subject_id, currency, cost, requests,
            input_tokens, output_tokens, total_tokens, model, captured_at FROM usage_snapshots
          UNION ALL
          SELECT connection_id, subject_type, subject_id, currency, cost, requests,
            input_tokens, output_tokens, total_tokens, model, captured_at FROM usage_aggregates
        )
        SELECT p.name provider, u.subject_type, u.subject_id, u.currency, u.cost,
          u.requests, u.input_tokens, u.output_tokens, u.total_tokens, u.model, u.captured_at
        FROM combined u JOIN provider_connections p ON p.id = u.connection_id
        ORDER BY u.captured_at DESC
      `).all();
    } else if (kind === 'alerts') {
      headers = ['provider', 'severity', 'status', 'message', 'triggered_at', 'resolved_at', 'acknowledged_at'];
      rows = this.db.prepare(`
        SELECT p.name provider, a.severity, a.status, a.message, a.triggered_at,
          a.resolved_at, a.acknowledged_at FROM alert_events a
        LEFT JOIN provider_connections p ON p.id = a.connection_id ORDER BY a.triggered_at DESC
      `).all();
    } else {
      throw new AppError('EXPORT_KIND_UNSUPPORTED', `Unsupported CSV export: ${kind}`, { status: 400 });
    }
    return `\uFEFF${[headers.join(','), ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(','))].join('\r\n')}`;
  }

  exportEnvironmentTemplate() {
    const lines = ['# Provider Monitor import template. Credentials are intentionally blank.'];
    this.providers.list().forEach((provider, index) => {
      const prefix = `PROVIDER_${index + 1}`;
      lines.push(
        `${prefix}_NAME=${provider.name}`,
        `${prefix}_ADAPTER=${provider.adapter_type}`,
        `${prefix}_BASE_URL=${provider.base_url}`,
        `${prefix}_AUTH_MODE=${provider.auth_mode}`,
        `${prefix}_REMOTE_USER_ID=${provider.remote_user_id || ''}`,
        `${prefix}_API_KEY=`,
        `${prefix}_ENABLED=${provider.enabled}`,
        ''
      );
    });
    return lines.join('\n');
  }

  credentialProfiles({ includeSecrets = false } = {}) {
    return this.providers.list().map((provider) => {
      const credentials = this.providers.getCredentials(provider.id);
      const secret = firstValue(
        credentials.runtimeApiKey,
        credentials.modelApiKey,
        credentials.apiKey,
        credentials.systemToken,
        credentials.managementKey,
        credentials.masterKey,
        credentials.accessToken,
        credentials.bearerToken,
        credentials.token
      );
      return {
        name: provider.name,
        provider: provider.adapter_type,
        baseUrl: provider.base_url,
        apiKey: includeSecrets ? secret || null : secret ? '***' : null,
        credentialReference: `provider-monitor://${provider.id}`,
        models: this.db.prepare('SELECT name FROM remote_models WHERE connection_id = ? ORDER BY name LIMIT 200').all(provider.id).map((row) => row.name)
      };
    });
  }

  async backupDatabase(label = 'manual') {
    const backupDir = path.join(this.config.dataDir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const safeLabel = String(label || 'manual').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40) || 'manual';
    const filename = `provider-monitor-${new Date().toISOString().replace(/[:.]/g, '-')}-${safeLabel}.db`;
    const destination = path.join(backupDir, filename);
    await this.db.backup(destination);
    const stat = fs.statSync(destination);
    return { filename, size: stat.size, createdAt: stat.birthtime.toISOString() };
  }

  listBackups() {
    const backupDir = path.join(this.config.dataDir, 'backups');
    if (!fs.existsSync(backupDir)) return [];
    return fs.readdirSync(backupDir).filter((name) => name.endsWith('.db')).map((filename) => {
      const stat = fs.statSync(path.join(backupDir, filename));
      return { filename, size: stat.size, createdAt: stat.birthtime.toISOString() };
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

module.exports = {
  TransferService,
  SETTING_DEFAULTS,
  RUNTIME_SETTING_KEYS,
  applyRuntimeSettings,
  normalizeStringList,
  csvEscape,
  normalizeAdapter
};
