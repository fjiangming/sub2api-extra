const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { AppError, asAppError } = require('../errors');
const { encryptJson, decryptJson } = require('../security/encryption');
const { maskValue, redactText } = require('../security/redaction');
const { safeFetch } = require('../http/safe-fetch');
const { nowIso, parseJson, stringifyJson } = require('../db');

function sha256(value, encoding = 'hex') {
  return crypto.createHash('sha256').update(value).digest(encoding);
}

function hmac(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value).digest(encoding);
}

function awsEncode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodePath(value) {
  return String(value || '').split('/').filter(Boolean).map(awsEncode).join('/');
}

function signS3Put({ url, body, region, accessKeyId, secretAccessKey, sessionToken, now = new Date() }) {
  const target = new URL(url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256(body);
  const headers = {
    host: target.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate
  };
  if (sessionToken) headers['x-amz-security-token'] = sessionToken;
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${String(headers[name]).trim()}\n`).join('');
  const canonicalUri = target.pathname.split('/').map((segment) => {
    try { return awsEncode(decodeURIComponent(segment)); } catch { return awsEncode(segment); }
  }).join('/');
  const canonicalQuery = [...target.searchParams.entries()]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue))
    .map(([key, value]) => `${awsEncode(key)}=${awsEncode(value)}`)
    .join('&');
  const canonicalRequest = [
    'PUT', canonicalUri || '/', canonicalQuery, canonicalHeaders,
    signedHeaderNames.join(';'), payloadHash
  ].join('\n');
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, 's3');
  const signingKey = hmac(serviceKey, 'aws4_request');
  const signature = hmac(signingKey, stringToSign, 'hex');
  return {
    ...headers,
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaderNames.join(';')}, Signature=${signature}`
  };
}

class BackupService {
  constructor({ db, config, transfers, fetcher = safeFetch }) {
    this.db = db;
    this.config = config;
    this.transfers = transfers;
    this.fetcher = fetcher;
  }

  listTargets() {
    return this.db.prepare(`
      SELECT t.*, e.payload credential_payload FROM backup_targets t
      LEFT JOIN encrypted_credentials e ON e.id = t.credential_id
      ORDER BY t.name COLLATE NOCASE
    `).all().map((row) => {
      const credentials = row.credential_payload
        ? decryptJson(row.credential_payload, this.config.secret)
        : {};
      return {
        id: row.id,
        name: row.name,
        type: row.type,
        enabled: Boolean(row.enabled),
        config: parseJson(row.config_json, {}),
        credentialFields: Object.entries(credentials)
          .filter(([, value]) => value != null && value !== '')
          .map(([name, value]) => ({ name, masked: maskValue(value) })),
        lastStatus: row.last_status,
        lastError: row.last_error,
        lastBackupAt: row.last_backup_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    });
  }

  getTarget(id) {
    const row = this.db.prepare(`
      SELECT t.*, e.payload credential_payload FROM backup_targets t
      LEFT JOIN encrypted_credentials e ON e.id = t.credential_id WHERE t.id = ?
    `).get(id);
    if (!row) throw new AppError('BACKUP_TARGET_NOT_FOUND', 'Backup target was not found', { status: 404 });
    return {
      ...row,
      config: parseJson(row.config_json, {}),
      credentials: row.credential_payload ? decryptJson(row.credential_payload, this.config.secret) : {}
    };
  }

  saveTarget(input, id = null) {
    const existing = id ? this.db.prepare('SELECT * FROM backup_targets WHERE id = ?').get(id) : null;
    if (id && !existing) throw new AppError('BACKUP_TARGET_NOT_FOUND', 'Backup target was not found', { status: 404 });
    const targetId = id || crypto.randomUUID();
    const now = nowIso();
    const config = input.config || {};
    const sensitiveConfigKeys = Object.keys(config).filter((key) => /password|secret|token|access.?key|credential/i.test(key));
    if (sensitiveConfigKeys.length > 0) {
      throw new AppError(
        'BACKUP_CREDENTIALS_MISPLACED',
        `Move sensitive backup fields into credentials: ${sensitiveConfigKeys.join(', ')}`,
        { status: 400 }
      );
    }
    let credentialId = existing?.credential_id || null;
    this.db.transaction(() => {
      if (input.credentials && Object.keys(input.credentials).length > 0) {
        if (credentialId) {
          const current = decryptJson(this.db.prepare('SELECT payload FROM encrypted_credentials WHERE id = ?').get(credentialId).payload, this.config.secret);
          this.db.prepare('UPDATE encrypted_credentials SET payload = ?, rotated_at = ? WHERE id = ?')
            .run(encryptJson({ ...current, ...input.credentials }, this.config.secret), now, credentialId);
        } else {
          credentialId = crypto.randomUUID();
          this.db.prepare('INSERT INTO encrypted_credentials(id, payload, created_at) VALUES (?, ?, ?)')
            .run(credentialId, encryptJson(input.credentials, this.config.secret), now);
        }
      }
      if (existing) {
        this.db.prepare(`
          UPDATE backup_targets SET name = ?, type = ?, enabled = ?, credential_id = ?,
            config_json = ?, updated_at = ? WHERE id = ?
        `).run(
          input.name ?? existing.name,
          input.type ?? existing.type,
          input.enabled == null ? existing.enabled : input.enabled ? 1 : 0,
          credentialId,
          stringifyJson(input.config ?? parseJson(existing.config_json, {})),
          now,
          targetId
        );
      } else {
        this.db.prepare(`
          INSERT INTO backup_targets(id, name, type, enabled, credential_id, config_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(targetId, input.name, input.type, input.enabled === false ? 0 : 1, credentialId, stringifyJson(input.config || {}), now, now);
      }
    })();
    return this.listTargets().find((target) => target.id === targetId);
  }

  deleteTarget(id) {
    const row = this.db.prepare('SELECT credential_id FROM backup_targets WHERE id = ?').get(id);
    if (!row) throw new AppError('BACKUP_TARGET_NOT_FOUND', 'Backup target was not found', { status: 404 });
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM backup_targets WHERE id = ?').run(id);
      if (row.credential_id) this.db.prepare('DELETE FROM encrypted_credentials WHERE id = ?').run(row.credential_id);
    })();
  }

  listRuns(limit = 200) {
    return this.db.prepare(`
      SELECT r.*, t.name target_name, t.type target_type FROM backup_runs r
      LEFT JOIN backup_targets t ON t.id = r.target_id
      ORDER BY r.created_at DESC LIMIT ?
    `).all(Math.min(1000, Math.max(1, Number(limit) || 200)));
  }

  async runAll(targetIds = null, label = 'scheduled') {
    const targets = this.listTargets().filter((target) => target.enabled &&
      (!targetIds?.length || targetIds.includes(target.id)));
    if (targets.length === 0) throw new AppError('BACKUP_TARGET_REQUIRED', 'No enabled backup target was selected', { status: 409 });
    const backup = await this.transfers.backupDatabase(label);
    return Promise.allSettled(targets.map((target) => this.#upload(this.getTarget(target.id), backup)));
  }

  async runTarget(id, label = 'manual') {
    const backup = await this.transfers.backupDatabase(label);
    return this.#upload(this.getTarget(id), backup);
  }

  async #upload(target, backup) {
    const runId = crypto.randomUUID();
    const source = path.join(this.config.dataDir, 'backups', backup.filename);
    const body = fs.readFileSync(source);
    this.db.prepare(`
      INSERT INTO backup_runs(id, target_id, status, filename, size, created_at)
      VALUES (?, ?, 'running', ?, ?, ?)
    `).run(runId, target.id, backup.filename, body.length, nowIso());
    try {
      const location = await this.#write(target, backup.filename, body);
      const completedAt = nowIso();
      this.db.transaction(() => {
        this.db.prepare(`UPDATE backup_runs SET status = 'succeeded', location = ?, completed_at = ? WHERE id = ?`)
          .run(location, completedAt, runId);
        this.db.prepare(`UPDATE backup_targets SET last_status = 'succeeded', last_error = NULL, last_backup_at = ?, updated_at = ? WHERE id = ?`)
          .run(completedAt, completedAt, target.id);
      })();
      return { id: runId, targetId: target.id, status: 'succeeded', filename: backup.filename, location, size: body.length };
    } catch (error) {
      const appError = asAppError(error, 'BACKUP_UPLOAD_FAILED');
      const message = redactText(appError.message).slice(0, 1000);
      this.db.transaction(() => {
        this.db.prepare(`UPDATE backup_runs SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?`)
          .run(message, nowIso(), runId);
        this.db.prepare(`UPDATE backup_targets SET last_status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`)
          .run(message, nowIso(), target.id);
      })();
      throw appError;
    }
  }

  async #write(target, filename, body) {
    if (target.type === 'local') {
      const configured = target.config.directory
        ? path.resolve(target.config.directory)
        : path.join(this.config.dataDir, 'remote-backups', target.id);
      fs.mkdirSync(configured, { recursive: true });
      const destination = path.join(configured, path.basename(filename));
      if (path.resolve(destination) === path.resolve(path.join(this.config.dataDir, 'backups', filename))) {
        return destination;
      }
      fs.copyFileSync(path.join(this.config.dataDir, 'backups', filename), destination);
      return destination;
    }
    if (target.type === 'webdav') {
      if (!target.config.url) throw new AppError('BACKUP_TARGET_INVALID', 'WebDAV URL is required', { status: 400 });
      const url = new URL(encodeURIComponent(filename), `${String(target.config.url).replace(/\/+$/, '')}/`).toString();
      const headers = { 'Content-Type': 'application/octet-stream' };
      if (target.credentials.username) {
        headers.Authorization = `Basic ${Buffer.from(`${target.credentials.username}:${target.credentials.password || ''}`).toString('base64')}`;
      } else if (target.credentials.token) {
        headers.Authorization = `Bearer ${target.credentials.token}`;
      }
      const response = await this.fetcher(url, this.config, { method: 'PUT', headers, body });
      if (!response.ok) throw new AppError('BACKUP_UPLOAD_FAILED', `WebDAV returned HTTP ${response.status}`, { status: 502, retryable: response.status >= 500 });
      return url;
    }
    if (target.type === 's3') {
      const { endpoint, bucket, region = 'us-east-1', prefix = '' } = target.config;
      const { accessKeyId, secretAccessKey, sessionToken } = target.credentials;
      if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
        throw new AppError('BACKUP_TARGET_INVALID', 'S3 endpoint, bucket and access credentials are required', { status: 400 });
      }
      const objectKey = [prefix, filename].filter(Boolean).join('/').replace(/^\/+/, '');
      const base = new URL(endpoint);
      const endpointPrefix = base.pathname.replace(/\/+$/, '');
      let url;
      if (target.config.pathStyle === false) {
        base.hostname = `${bucket}.${base.hostname}`;
        base.pathname = `${endpointPrefix}/${encodePath(objectKey)}`;
        url = base.toString();
      } else {
        base.pathname = `${endpointPrefix}/${encodePath(bucket)}/${encodePath(objectKey)}`;
        url = base.toString();
      }
      const headers = signS3Put({ url, body, region, accessKeyId, secretAccessKey, sessionToken });
      delete headers.host;
      const response = await this.fetcher(url, this.config, { method: 'PUT', headers, body });
      if (!response.ok) throw new AppError('BACKUP_UPLOAD_FAILED', `S3 returned HTTP ${response.status}`, { status: 502, retryable: response.status >= 500 });
      return url;
    }
    throw new AppError('BACKUP_TARGET_UNSUPPORTED', `Unsupported backup target: ${target.type}`, { status: 400 });
  }
}

module.exports = { BackupService, signS3Put, encodePath, awsEncode };
