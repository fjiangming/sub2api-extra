const crypto = require('crypto');
const { AppError } = require('../errors');
const { encryptJson, decryptJson } = require('../security/encryption');
const { maskValue } = require('../security/redaction');
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

function mergeProviderCredentials(existing = {}, incoming = {}, adapterType = '') {
  const merged = { ...existing, ...incoming };
  if (adapterType !== 'sub2api') return merged;

  const accountCredentialsChanged = ['email', 'password']
    .some((field) => Object.prototype.hasOwnProperty.call(incoming, field));
  if (accountCredentialsChanged) {
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

function publicConnection(row, credentialFields = []) {
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
  }

  #credentialFields(credentialId) {
    const row = this.db
      .prepare('SELECT payload FROM encrypted_credentials WHERE id = ?')
      .get(credentialId);
    if (!row) return [];
    return Object.entries(decryptJson(row.payload, this.config.secret))
      .filter(([, value]) => value != null && value !== '')
      .map(([name, value]) => ({ name, masked: maskValue(value) }));
  }

  list() {
    return this.db
      .prepare(`${PROVIDER_SELECT} ORDER BY p.name COLLATE NOCASE`)
      .all()
      .map((row) => publicConnection(row, this.#credentialFields(row.credential_id)));
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
    return publicConnection(row, this.#credentialFields(row.credential_id));
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

  create(input) {
    const id = crypto.randomUUID();
    const credentialId = crypto.randomUUID();
    const now = nowIso();
    const refreshMinutes = input.refreshIntervalMinutes || this.config.defaultRefreshMinutes;
    const nextCheckAt = input.enabled === false
      ? null
      : new Date(Date.now() + refreshMinutes * 60000).toISOString();

    const insert = this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO encrypted_credentials(id, payload, created_at) VALUES (?, ?, ?)'
        )
        .run(credentialId, encryptJson(input.credentials || {}, this.config.secret), now);
      this.db.prepare(`
        INSERT INTO provider_connections(
          id, name, adapter_type, base_url, auth_mode, credential_id, remote_user_id,
          enabled, refresh_interval_minutes, warning_threshold, threshold_currency,
          recharge_url, type_config_json, tags_json, note, account_dedupe_key, next_check_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        input.warningThreshold ?? null,
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
    const enabled = input.enabled == null ? existing.enabled : booleanValue(input.enabled);
    const nextCheckAt = enabled
      ? existing.next_check_at || new Date().toISOString()
      : null;

    const update = this.db.transaction(() => {
      if (input.credentials && Object.keys(input.credentials).length > 0) {
        this.updateCredentials(
          existing,
          mergeProviderCredentials(
            this.getCredentials(existing),
            input.credentials,
            input.adapterType ?? existing.adapter_type
          )
        );
      }
      this.db.prepare(`
        UPDATE provider_connections SET
          name = ?, adapter_type = ?, base_url = ?, auth_mode = ?, remote_user_id = ?,
          enabled = ?, refresh_interval_minutes = ?, warning_threshold = ?,
          threshold_currency = ?, recharge_url = ?, type_config_json = ?, tags_json = ?, note = ?,
          account_dedupe_key = ?, next_check_at = ?, updated_at = ?
        WHERE id = ?
      `).run(
        input.name ?? existing.name,
        input.adapterType ?? existing.adapter_type,
        (input.baseUrl ?? existing.base_url).replace(/\/+$/, ''),
        input.authMode ?? existing.auth_mode,
        input.remoteUserId === undefined ? existing.remote_user_id : input.remoteUserId || null,
        enabled,
        refreshMinutes,
        input.warningThreshold === undefined ? existing.warning_threshold : input.warningThreshold,
        input.thresholdCurrency ?? existing.threshold_currency,
        input.rechargeUrl === undefined ? existing.recharge_url : input.rechargeUrl || null,
        stringifyJson(input.typeConfig ?? existing.type_config_json),
        stringifyJson(input.tags ?? existing.tags),
        input.note ?? existing.note,
        input.accountDedupeKey === undefined
          ? existing.account_dedupe_key
          : input.accountDedupeKey || null,
        nextCheckAt,
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
