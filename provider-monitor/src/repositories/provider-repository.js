const crypto = require('crypto');
const { AppError } = require('../errors');
const { encryptJson, decryptJson } = require('../security/encryption');
const { maskValue } = require('../security/redaction');
const {
  configuredApiKeyMetadata,
  mergeConfiguredApiKeyCredentials
} = require('../security/configured-api-keys');
const { nowIso, parseJson, stringifyJson } = require('../db');

function booleanValue(value, fallback = true) {
  if (value == null) return fallback ? 1 : 0;
  return value ? 1 : 0;
}

const SUB2API_SESSION_CREDENTIAL_FIELDS = [
  'accessToken',
  'refreshToken',
  'expiresIn',
  'tokenExpiresAt',
  'accessTokenExpiresAt',
  'refreshTokenExpiresAt'
];

const PROVIDER_SELECT = `
  SELECT p.*,
    rr.detected_multiplier AS recharge_detected_multiplier,
    rr.manual_multiplier AS recharge_manual_multiplier,
    rr.quote_paid_amount AS recharge_quote_paid_amount,
    rr.quote_credited_amount AS recharge_quote_credited_amount,
    rr.paid_currency AS recharge_paid_currency,
    rr.balance_currency AS recharge_balance_currency,
    rr.detection_source AS recharge_detection_source,
    rr.status AS recharge_status,
    rr.error_code AS recharge_error_code,
    rr.metadata_json AS recharge_metadata_json,
    rr.detected_at AS recharge_detected_at,
    rr.checked_at AS recharge_checked_at
  FROM provider_connections p
  LEFT JOIN provider_recharge_rates rr ON rr.connection_id = p.id
`;

function positiveNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function validateRefreshInterval(value) {
  if (!Number.isInteger(value) || value < 1 || value > 1440) {
    throw new AppError('PROVIDER_INTERVAL_INVALID', 'Refresh interval must be an integer from 1 to 1440 minutes', { status: 400 });
  }
}

function validateBalanceThresholds(warningThreshold, secondaryWarningThreshold) {
  for (const threshold of [warningThreshold, secondaryWarningThreshold]) {
    if (threshold != null && (!Number.isFinite(Number(threshold)) || Number(threshold) < 0)) {
      throw new AppError('PROVIDER_THRESHOLD_INVALID', '余额阈值必须是大于或等于 0 的数字', { status: 400 });
    }
  }
  if (secondaryWarningThreshold == null) return;
  if (warningThreshold == null) {
    throw new AppError('PROVIDER_THRESHOLD_INVALID', '二级余额阈值需要先设置一级余额阈值', { status: 400 });
  }
  if (Number(secondaryWarningThreshold) >= Number(warningThreshold)) {
    throw new AppError('PROVIDER_THRESHOLD_INVALID', '二级余额阈值必须小于一级余额阈值', { status: 400 });
  }
}

function rechargeInfo(row) {
  const manualMultiplier = positiveNumber(row.recharge_manual_multiplier);
  const detectedMultiplier = positiveNumber(row.recharge_detected_multiplier);
  const usesDefault = manualMultiplier == null && detectedMultiplier == null;
  const multiplier = manualMultiplier ?? detectedMultiplier ?? 1;
  return {
    multiplier,
    manualMultiplier,
    detectedMultiplier,
    source: manualMultiplier != null
      ? 'manual'
      : usesDefault ? 'default' : row.recharge_detection_source || null,
    status: manualMultiplier != null
      ? 'manual'
      : usesDefault ? 'default' : row.recharge_status || 'unknown',
    detectionStatus: row.recharge_status || 'unknown',
    paidAmount: positiveNumber(row.recharge_quote_paid_amount),
    creditedAmount: positiveNumber(row.recharge_quote_credited_amount),
    paidCurrency: row.recharge_paid_currency || null,
    balanceCurrency: row.recharge_balance_currency || null,
    errorCode: row.recharge_error_code || null,
    detectedAt: row.recharge_detected_at || null,
    checkedAt: row.recharge_checked_at || null,
    metadata: parseJson(row.recharge_metadata_json, {})
  };
}

function removeRechargeColumns(result) {
  for (const key of Object.keys(result)) {
    if (key.startsWith('recharge_')) delete result[key];
  }
  return result;
}

function mergeProviderCredentials(existing = {}, incoming = {}, adapterType = '', authMode = '') {
  const normalizedAuthMode = String(authMode || '').toLowerCase();
  if (
    adapterType === 'sub2api' &&
    (normalizedAuthMode === 'api_key' || Object.prototype.hasOwnProperty.call(incoming, 'apiKeys'))
  ) {
    const merged = mergeConfiguredApiKeyCredentials(existing, incoming);
    const accountCredentialsChanged = ['email', 'password']
      .some((field) => Object.prototype.hasOwnProperty.call(incoming, field));
    if (accountCredentialsChanged) {
      for (const field of SUB2API_SESSION_CREDENTIAL_FIELDS) delete merged[field];
    }
    return merged;
  }
  const merged = { ...existing, ...incoming };
  if (adapterType !== 'sub2api') return merged;

  const tokenOnlyMode = ['token_pair', 'bearer'].includes(normalizedAuthMode);
  if (tokenOnlyMode) {
    delete merged.email;
    delete merged.password;
  }

  const accountCredentialsChanged = ['email', 'password']
    .some((field) => Object.prototype.hasOwnProperty.call(incoming, field));
  if (accountCredentialsChanged && !tokenOnlyMode) {
    for (const field of SUB2API_SESSION_CREDENTIAL_FIELDS) delete merged[field];
    return merged;
  }

  if (Object.prototype.hasOwnProperty.call(incoming, 'accessToken')) {
    delete merged.expiresIn;
    delete merged.tokenExpiresAt;
    delete merged.accessTokenExpiresAt;
  }
  return merged;
}

function publicConnection(row, credentialFields = [], configuredApiKeys = []) {
  if (!row) return null;
  return removeRechargeColumns({
    ...row,
    enabled: Boolean(row.enabled),
    capabilities: parseJson(row.capabilities_json, {}),
    fingerprint: parseJson(row.fingerprint_json, {}),
    typeConfig: parseJson(row.type_config_json, {}),
    tags: parseJson(row.tags_json, []),
    rechargeUrl: row.recharge_url || null,
    recharge: rechargeInfo(row),
    credentialFields,
    configuredApiKeys,
    capabilities_json: undefined,
    fingerprint_json: undefined,
    type_config_json: undefined,
    tags_json: undefined,
    credential_id: undefined
  });
}

function adapterConnection(row) {
  return {
    ...row,
    capabilities: parseJson(row.capabilities_json, {}),
    fingerprint: parseJson(row.fingerprint_json, {}),
    type_config_json: parseJson(row.type_config_json, {}),
    tags: parseJson(row.tags_json, [])
  };
}

class ProviderRepository {
  constructor(db, config) {
    this.db = db;
    this.config = config;
    this.credentialRefreshes = new Map();
    this.credentialStates = new Map();
  }

  #credentialInfo(connection) {
    const credentialRow = this.db
      .prepare('SELECT payload FROM encrypted_credentials WHERE id = ?')
      .get(connection.credential_id);
    if (!credentialRow) return { fields: [], configuredApiKeys: [] };
    const credentials = decryptJson(credentialRow.payload, this.config.secret);
    const fields = Object.entries(credentials)
      .filter(([, value]) => value != null && value !== '')
      .map(([name, value]) => ({
        name,
        masked: Array.isArray(value) ? `${value.length} configured` : maskValue(value)
      }));
    const configuredApiKeys = connection.adapter_type === 'sub2api' && connection.auth_mode === 'api_key'
      ? configuredApiKeyMetadata(credentials, maskValue)
      : [];
    return { fields, configuredApiKeys };
  }

  list() {
    return this.db
      .prepare(`${PROVIDER_SELECT} ORDER BY p.name COLLATE NOCASE`)
      .all()
      .map((row) => {
        const credentialInfo = this.#credentialInfo(row);
        return publicConnection(row, credentialInfo.fields, credentialInfo.configuredApiKeys);
      });
  }

  get(id, options = {}) {
    const row = this.db.prepare(`${PROVIDER_SELECT} WHERE p.id = ?`).get(id);
    if (!row) {
      if (options.required === false) return null;
      throw new AppError('PROVIDER_NOT_FOUND', 'Provider connection was not found', {
        status: 404
      });
    }
    if (options.forAdapter) return adapterConnection(row);
    const credentialInfo = this.#credentialInfo(row);
    return publicConnection(row, credentialInfo.fields, credentialInfo.configuredApiKeys);
  }

  getCredentials(connectionOrId) {
    const connection =
      typeof connectionOrId === 'string'
        ? this.db.prepare('SELECT credential_id FROM provider_connections WHERE id = ?').get(connectionOrId)
        : connectionOrId;
    if (!connection?.credential_id) {
      throw new AppError('CREDENTIAL_NOT_FOUND', 'Provider credentials were not found', {
        status: 404
      });
    }
    const row = this.db
      .prepare('SELECT payload FROM encrypted_credentials WHERE id = ?')
      .get(connection.credential_id);
    if (!row) {
      throw new AppError('CREDENTIAL_NOT_FOUND', 'Provider credentials were not found', {
        status: 404
      });
    }
    return decryptJson(row.payload, this.config.secret);
  }

  #credentialSnapshot(connection) {
    const credentials = this.getCredentials(connection);
    const key = JSON.stringify(credentials);
    const previous = this.credentialStates.get(connection.id);
    // Only our completed automatic rotations may be adopted by an existing read.
    const epoch = previous ? previous.epoch + Number(previous.key !== key) : 0;
    this.credentialStates.set(connection.id, { key, epoch });
    return { credentials, epoch };
  }

  adapterContext(connection, http) {
    const scope = (row) => JSON.stringify([row.adapter_type, row.base_url, row.auth_mode, row.credential_id,
      row.remote_user_id, row.account_dedupe_key, row.type_config_json]);
    const expectedScope = scope(connection);
    const initial = this.#credentialSnapshot(connection);
    let credentials = initial.credentials;
    const currentConnection = () => {
      const current = this.get(connection.id, { forAdapter: true });
      if (scope(current) !== expectedScope) {
        throw new AppError('CONFIG_CHANGED', 'Provider changed during upstream read', { status: 409 });
      }
      return current;
    };
    const readCurrent = () => {
      const current = currentConnection();
      const snapshot = this.#credentialSnapshot(current);
      if (snapshot.epoch !== initial.epoch) {
        throw new AppError('CONFIG_CHANGED', 'Provider credentials changed during upstream read', { status: 409 });
      }
      return { current, credentials: snapshot.credentials };
    };
    return {
      connection, credentials, http, config: this.config,
      verifyCredentials: () => readCurrent().current,
      getCredentials: () => {
        credentials = readCurrent().credentials;
        return credentials;
      },
      withCredentialsRefresh: (operation) => {
        const previous = this.credentialRefreshes.get(connection.id) || Promise.resolve();
        const pending = previous.catch(() => {}).then(operation).finally(() => {
          if (this.credentialRefreshes.get(connection.id) === pending) this.credentialRefreshes.delete(connection.id);
        });
        this.credentialRefreshes.set(connection.id, pending);
        return pending;
      },
      onCredentialsUpdated: async (updated) => {
        const saved = readCurrent();
        if (JSON.stringify(saved.credentials) !== JSON.stringify(credentials)) {
          throw new AppError('CONFIG_CHANGED', 'Provider session changed during token refresh', { status: 409 });
        }
        this.updateCredentials(saved.current, updated);
        this.credentialStates.set(connection.id, { key: JSON.stringify(updated), epoch: initial.epoch });
        credentials = updated;
      }
    };
  }

  upsertAccount(connectionId, account, capturedAt) {
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
    `).run(id, connectionId, String(account.remoteId), account.displayName || String(account.remoteId),
      account.userGroup || null, account.status || 'unknown', stringifyJson(account.metadata || {}), capturedAt, capturedAt);
    return id;
  }

  create(input) {
    const id = crypto.randomUUID();
    const credentialId = crypto.randomUUID();
    const now = nowIso();
    const refreshMinutes = input.refreshIntervalMinutes ?? this.config.defaultRefreshMinutes;
    const balanceRefreshMinutes = input.balanceRefreshIntervalMinutes ?? 1;
    validateRefreshInterval(balanceRefreshMinutes);
    validateRefreshInterval(refreshMinutes);
    const nextCheckAt = input.enabled === false
      ? null
      : new Date(Date.now() + refreshMinutes * 60000).toISOString();
    validateBalanceThresholds(input.warningThreshold, input.secondaryWarningThreshold);

    const credentials = mergeProviderCredentials(
      {},
      input.credentials || {},
      input.adapterType,
      input.authMode || 'api_key'
    );
    const insert = this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO encrypted_credentials(id, payload, created_at) VALUES (?, ?, ?)'
        )
        .run(credentialId, encryptJson(credentials, this.config.secret), now);
      this.db.prepare(`
        INSERT INTO provider_connections(
          id, name, adapter_type, base_url, auth_mode, credential_id, remote_user_id,
          enabled, refresh_interval_minutes, balance_refresh_interval_minutes, warning_threshold, secondary_warning_threshold, threshold_currency,
          recharge_url, type_config_json, tags_json, note, account_dedupe_key, next_check_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.name,
        input.adapterType,
        input.baseUrl.replace(/\/+$/, ''),
        input.authMode || 'api_key',
        credentialId,
        input.remoteUserId || null,
        booleanValue(input.enabled),
        refreshMinutes,
        balanceRefreshMinutes,
        input.warningThreshold ?? null,
        input.secondaryWarningThreshold ?? null,
        input.thresholdCurrency || 'USD',
        input.rechargeUrl || null,
        stringifyJson(input.typeConfig || {}),
        stringifyJson(input.tags || []),
        input.note || '',
        input.accountDedupeKey || null,
        nextCheckAt,
        now,
        now
      );
      if (positiveNumber(input.rechargeMultiplier) != null) {
        this.db.prepare(`
          INSERT INTO provider_recharge_rates(
            connection_id, manual_multiplier, status, metadata_json, updated_at
          ) VALUES (?, ?, 'unknown', '{}', ?)
        `).run(id, positiveNumber(input.rechargeMultiplier), now);
      }
    });

    try {
      insert();
    } catch (error) {
      if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) {
        throw new AppError('PROVIDER_DUPLICATE', 'An equivalent provider connection already exists', {
          status: 409
        });
      }
      throw error;
    }
    return this.get(id);
  }

  update(id, input) {
    const existing = this.get(id, { forAdapter: true });
    const now = nowIso();
    const refreshMinutes = input.refreshIntervalMinutes ?? existing.refresh_interval_minutes;
    const balanceRefreshMinutes = input.balanceRefreshIntervalMinutes ?? existing.balance_refresh_interval_minutes;
    validateRefreshInterval(balanceRefreshMinutes);
    validateRefreshInterval(refreshMinutes);
    const enabled = input.enabled == null ? existing.enabled : booleanValue(input.enabled);
    const nextCheckAt = enabled
      ? refreshMinutes !== existing.refresh_interval_minutes ? now : existing.next_check_at || now
      : null;
    const balanceSettingsChanged = ['balanceRefreshIntervalMinutes', 'credentials', 'baseUrl', 'adapterType',
      'authMode', 'remoteUserId', 'typeConfig', 'warningThreshold', 'secondaryWarningThreshold', 'thresholdCurrency']
      .some((key) => Object.hasOwn(input, key));
    const nextBalanceCheckAt = enabled
      ? balanceSettingsChanged || !existing.enabled
        ? now : existing.next_balance_check_at
      : null;
    const warningThreshold = input.warningThreshold === undefined
      ? existing.warning_threshold
      : input.warningThreshold;
    const secondaryWarningThreshold = input.secondaryWarningThreshold === undefined
      ? existing.secondary_warning_threshold
      : input.secondaryWarningThreshold;
    validateBalanceThresholds(warningThreshold, secondaryWarningThreshold);

    const update = this.db.transaction(() => {
      if (input.credentials && Object.keys(input.credentials).length > 0) {
        this.updateCredentials(
          existing,
          mergeProviderCredentials(
            this.getCredentials(existing),
            input.credentials,
            input.adapterType ?? existing.adapter_type,
            input.authMode ?? existing.auth_mode
          )
        );
      }
      this.db.prepare(`
        UPDATE provider_connections SET
          name = ?, adapter_type = ?, base_url = ?, auth_mode = ?, remote_user_id = ?,
          enabled = ?, refresh_interval_minutes = ?, balance_refresh_interval_minutes = ?, warning_threshold = ?, secondary_warning_threshold = ?,
          threshold_currency = ?, recharge_url = ?, type_config_json = ?, tags_json = ?, note = ?,
          account_dedupe_key = ?, next_check_at = ?, next_balance_check_at = ?, balance_failure_count = ?, updated_at = ?
        WHERE id = ?
      `).run(
        input.name ?? existing.name,
        input.adapterType ?? existing.adapter_type,
        (input.baseUrl ?? existing.base_url).replace(/\/+$/, ''),
        input.authMode ?? existing.auth_mode,
        input.remoteUserId === undefined ? existing.remote_user_id : input.remoteUserId || null,
        enabled,
        refreshMinutes,
        balanceRefreshMinutes,
        warningThreshold,
        secondaryWarningThreshold,
        input.thresholdCurrency ?? existing.threshold_currency,
        input.rechargeUrl === undefined ? existing.recharge_url : input.rechargeUrl || null,
        stringifyJson(input.typeConfig ?? existing.type_config_json),
        stringifyJson(input.tags ?? existing.tags),
        input.note ?? existing.note,
        input.accountDedupeKey === undefined
          ? existing.account_dedupe_key
          : input.accountDedupeKey || null,
        nextCheckAt,
        nextBalanceCheckAt,
        balanceSettingsChanged ? 0 : existing.balance_failure_count,
        now,
        id
      );
      if (input.rechargeMultiplier !== undefined) {
        this.db.prepare(`
          INSERT INTO provider_recharge_rates(
            connection_id, manual_multiplier, status, metadata_json, updated_at
          ) VALUES (?, ?, 'unknown', '{}', ?)
          ON CONFLICT(connection_id) DO UPDATE SET
            manual_multiplier = excluded.manual_multiplier,
            updated_at = excluded.updated_at
        `).run(id, positiveNumber(input.rechargeMultiplier), now);
      }
    });
    try {
      update();
    } catch (error) {
      if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) {
        throw new AppError('PROVIDER_DUPLICATE', 'An equivalent provider connection already exists', {
          status: 409
        });
      }
      throw error;
    }
    return this.get(id);
  }

  recordRecharge(connectionId, recharge, checkedAt = nowIso()) {
    if (!recharge) return this.get(connectionId).recharge;
    const multiplier = positiveNumber(recharge.multiplier);
    const metadata = stringifyJson(recharge.metadata || {});
    if (recharge.available !== false && multiplier != null) {
      this.db.prepare(`
        INSERT INTO provider_recharge_rates(
          connection_id, detected_multiplier, quote_paid_amount, quote_credited_amount,
          paid_currency, balance_currency, detection_source, status, error_code,
          metadata_json, detected_at, checked_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'detected', NULL, ?, ?, ?, ?)
        ON CONFLICT(connection_id) DO UPDATE SET
          detected_multiplier = excluded.detected_multiplier,
          quote_paid_amount = excluded.quote_paid_amount,
          quote_credited_amount = excluded.quote_credited_amount,
          paid_currency = excluded.paid_currency,
          balance_currency = excluded.balance_currency,
          detection_source = excluded.detection_source,
          status = 'detected',
          error_code = NULL,
          metadata_json = excluded.metadata_json,
          detected_at = excluded.detected_at,
          checked_at = excluded.checked_at,
          updated_at = excluded.updated_at
      `).run(
        connectionId,
        multiplier,
        positiveNumber(recharge.paidAmount),
        positiveNumber(recharge.creditedAmount),
        recharge.paidCurrency || null,
        recharge.balanceCurrency || null,
        recharge.source || 'provider_api',
        metadata,
        checkedAt,
        checkedAt,
        checkedAt
      );
    } else {
      this.db.prepare(`
        INSERT INTO provider_recharge_rates(
          connection_id, detection_source, status, error_code, metadata_json,
          checked_at, updated_at
        ) VALUES (?, ?, 'unavailable', ?, ?, ?, ?)
        ON CONFLICT(connection_id) DO UPDATE SET
          detection_source = COALESCE(provider_recharge_rates.detection_source, excluded.detection_source),
          status = 'unavailable',
          error_code = excluded.error_code,
          metadata_json = excluded.metadata_json,
          checked_at = excluded.checked_at,
          updated_at = excluded.updated_at
      `).run(
        connectionId,
        recharge.source || 'provider_api',
        recharge.errorCode || 'RECHARGE_RATE_UNAVAILABLE',
        metadata,
        checkedAt,
        checkedAt
      );
    }
    return this.get(connectionId).recharge;
  }

  updateCredentials(connectionOrId, credentials) {
    const connection =
      typeof connectionOrId === 'string'
        ? this.db.prepare('SELECT credential_id FROM provider_connections WHERE id = ?').get(connectionOrId)
        : connectionOrId;
    if (!connection?.credential_id) {
      throw new AppError('PROVIDER_NOT_FOUND', 'Provider connection was not found', {
        status: 404
      });
    }
    this.db.prepare(`
      UPDATE encrypted_credentials SET payload = ?, rotated_at = ? WHERE id = ?
    `).run(encryptJson(credentials, this.config.secret), nowIso(), connection.credential_id);
  }

  delete(id) {
    const row = this.db
      .prepare('SELECT credential_id FROM provider_connections WHERE id = ?')
      .get(id);
    if (!row) throw new AppError('PROVIDER_NOT_FOUND', 'Provider connection was not found', { status: 404 });
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM provider_connections WHERE id = ?').run(id);
      this.db.prepare('DELETE FROM encrypted_credentials WHERE id = ?').run(row.credential_id);
    })();
  }
}

module.exports = {
  ProviderRepository,
  publicConnection,
  adapterConnection,
  mergeProviderCredentials
};
