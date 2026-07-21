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
  return {
    ...row,
    enabled: Boolean(row.enabled),
    capabilities: parseJson(row.capabilities_json, {}),
    fingerprint: parseJson(row.fingerprint_json, {}),
    typeConfig: parseJson(row.type_config_json, {}),
    tags: parseJson(row.tags_json, []),
    credentialFields,
    capabilities_json: undefined,
    fingerprint_json: undefined,
    type_config_json: undefined,
    tags_json: undefined,
    credential_id: undefined
  };
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
      .prepare('SELECT * FROM provider_connections ORDER BY name COLLATE NOCASE')
      .all()
      .map((row) => publicConnection(row, this.#credentialFields(row.credential_id)));
  }

  get(id, options = {}) {
    const row = this.db.prepare('SELECT * FROM provider_connections WHERE id = ?').get(id);
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
          type_config_json, tags_json, note, account_dedupe_key, next_check_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        stringifyJson(input.typeConfig || {}),
        stringifyJson(input.tags || []),
        input.note || '',
        input.accountDedupeKey || null,
        nextCheckAt,
        now,
        now
      );
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
          threshold_currency = ?, type_config_json = ?, tags_json = ?, note = ?,
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
