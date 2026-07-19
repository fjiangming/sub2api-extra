const crypto = require('crypto');
const { createAdapter } = require('../adapters/registry');
const { AppError } = require('../errors');
const { encryptJson, decryptJson } = require('../security/encryption');
const { maskValue } = require('../security/redaction');
const { nowIso } = require('../db');

function credentialExpiry(credentials) {
  const candidates = [
    credentials.tokenExpiresAt,
    credentials.expiresAt,
    credentials.expiry,
    credentials.accessTokenExpiresAt,
    credentials.refreshTokenExpiresAt
  ].filter((value) => value != null && value !== '');
  const dates = candidates.map((value) => {
    const numeric = Number(value);
    const date = Number.isFinite(numeric)
      ? new Date(numeric < 1e12 ? numeric * 1000 : numeric)
      : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }).filter(Boolean).sort((a, b) => a - b);
  return dates[0]?.toISOString() || null;
}

class CredentialService {
  constructor({ db, config, providers, http }) {
    this.db = db;
    this.config = config;
    this.providers = providers;
    this.http = http;
  }

  listLifecycle() {
    return this.db.prepare(`
      SELECT p.id, p.name, p.adapter_type, p.last_error_code, p.last_success_at,
        p.credential_id, e.created_at, e.rotated_at, e.payload
      FROM provider_connections p JOIN encrypted_credentials e ON e.id = p.credential_id
      ORDER BY p.name COLLATE NOCASE
    `).all().map((row) => {
      const credentials = decryptJson(row.payload, this.config.secret);
      const expiresAt = credentialExpiry(credentials);
      return {
        providerId: row.id,
        providerName: row.name,
        adapterType: row.adapter_type,
        fields: Object.entries(credentials)
          .filter(([, value]) => value != null && value !== '')
          .map(([name, value]) => ({ name, masked: maskValue(value) })),
        createdAt: row.created_at,
        rotatedAt: row.rotated_at,
        expiresAt,
        expiryStatus: !expiresAt ? 'unknown' : Date.parse(expiresAt) <= Date.now()
          ? 'expired' : Date.parse(expiresAt) <= Date.now() + 7 * 86400000 ? 'warning' : 'healthy',
        lastErrorCode: row.last_error_code,
        lastSuccessAt: row.last_success_at
      };
    });
  }

  listBackups(providerId) {
    const provider = this.providers.get(providerId, { forAdapter: true });
    return this.db.prepare(`
      SELECT id, reason, created_at, expires_at, restored_at
      FROM credential_backups WHERE credential_id = ? ORDER BY created_at DESC
    `).all(provider.credential_id);
  }

  async rotate(providerId, candidate, options = {}) {
    const connection = this.providers.get(providerId, { forAdapter: true });
    const current = this.providers.getCredentials(connection);
    const credentials = options.replace ? { ...candidate } : { ...current, ...candidate };
    let validatedCredentials = credentials;
    const adapter = createAdapter(connection.adapter_type, {
      connection,
      credentials,
      http: this.http,
      config: this.config,
      onCredentialsUpdated: async (next) => { validatedCredentials = { ...validatedCredentials, ...next }; }
    });
    const probe = await adapter.probe();
    const account = await adapter.getAccount();
    const balances = await adapter.getAccountBalances(account);
    const credentialRow = this.db.prepare('SELECT payload FROM encrypted_credentials WHERE id = ?').get(connection.credential_id);
    const backupId = crypto.randomUUID();
    const now = nowIso();
    const expiresAt = new Date(Date.now() + Math.min(30, Math.max(1, Number(options.retentionDays) || 7)) * 86400000).toISOString();
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO credential_backups(id, credential_id, payload, reason, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(backupId, connection.credential_id, credentialRow.payload, options.reason || 'credential_rotation', now, expiresAt);
      this.db.prepare(`UPDATE encrypted_credentials SET payload = ?, rotated_at = ? WHERE id = ?`).run(
        encryptJson(validatedCredentials, this.config.secret), now, connection.credential_id
      );
      this.db.prepare(`UPDATE provider_connections SET updated_at = ? WHERE id = ?`).run(now, providerId);
    })();
    return {
      providerId,
      backupId,
      backupExpiresAt: expiresAt,
      fields: Object.entries(validatedCredentials).map(([name, value]) => ({ name, masked: maskValue(value) })),
      validation: { probe, account: { remoteId: account.remoteId, displayName: account.displayName }, balanceCount: balances.length }
    };
  }

  rollback(providerId, backupId) {
    const connection = this.providers.get(providerId, { forAdapter: true });
    const backup = this.db.prepare(`
      SELECT * FROM credential_backups WHERE id = ? AND credential_id = ?
    `).get(backupId, connection.credential_id);
    if (!backup) throw new AppError('CREDENTIAL_BACKUP_NOT_FOUND', 'Credential backup was not found', { status: 404 });
    if (backup.restored_at) throw new AppError('CREDENTIAL_BACKUP_USED', 'Credential backup was already restored', { status: 409 });
    if (Date.parse(backup.expires_at) < Date.now()) throw new AppError('CREDENTIAL_BACKUP_EXPIRED', 'Credential backup has expired', { status: 410 });
    const current = this.db.prepare('SELECT payload FROM encrypted_credentials WHERE id = ?').get(connection.credential_id);
    const safetyBackupId = crypto.randomUUID();
    const now = nowIso();
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO credential_backups(id, credential_id, payload, reason, created_at, expires_at)
        VALUES (?, ?, ?, 'pre_rollback', ?, ?)
      `).run(safetyBackupId, connection.credential_id, current.payload, now, new Date(Date.now() + 7 * 86400000).toISOString());
      this.db.prepare(`UPDATE encrypted_credentials SET payload = ?, rotated_at = ? WHERE id = ?`).run(backup.payload, now, connection.credential_id);
      this.db.prepare(`UPDATE credential_backups SET restored_at = ? WHERE id = ?`).run(now, backupId);
    })();
    return { providerId, backupId, safetyBackupId, restoredAt: now };
  }

  reencryptMasterSecret(newSecret) {
    if (String(newSecret || '').length < 32) {
      throw new AppError('SECRET_TOO_SHORT', 'New master secret must contain at least 32 characters', { status: 400 });
    }
    if (newSecret === this.config.secret) throw new AppError('SECRET_UNCHANGED', 'New master secret must be different', { status: 409 });
    const rows = this.db.prepare('SELECT id, payload FROM encrypted_credentials').all();
    const reencrypted = rows.map((row) => ({
      id: row.id,
      payload: encryptJson(decryptJson(row.payload, this.config.secret), newSecret)
    }));
    this.db.transaction(() => {
      const update = this.db.prepare('UPDATE encrypted_credentials SET payload = ?, rotated_at = ? WHERE id = ?');
      for (const row of reencrypted) update.run(row.payload, nowIso(), row.id);
      const backupRows = this.db.prepare('SELECT id, payload FROM credential_backups').all();
      const updateBackup = this.db.prepare('UPDATE credential_backups SET payload = ? WHERE id = ?');
      for (const row of backupRows) {
        updateBackup.run(encryptJson(decryptJson(row.payload, this.config.secret), newSecret), row.id);
      }
    })();
    this.config.secret = newSecret;
    return { reencrypted: rows.length, rotatedAt: nowIso(), restartEnvironmentRequired: true };
  }

  cleanupExpiredBackups() {
    return this.db.prepare(`DELETE FROM credential_backups WHERE expires_at < ?`).run(nowIso()).changes;
  }
}

module.exports = {
  CredentialService,
  credentialExpiry
};
