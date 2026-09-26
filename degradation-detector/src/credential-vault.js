'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { AppError } = require('./errors');

function validGroupId(value) {
  return /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(String(value || ''));
}

function validateDedicatedKey(value) {
  const key = String(value || '').trim();
  if (key.length < 16 || key.length > 8192 || /[\u0000-\u0020\u007f]/.test(key)) {
    throw new AppError('DETECTION_KEY_INVALID', '专用 Key 格式无效或不是完整值', { status: 400 });
  }
  if (key.includes('***') || key.includes('...') || /^(replace|change)-/i.test(key)) {
    throw new AppError('DETECTION_KEY_INVALID', '专用 Key 不能使用掩码值或占位值', { status: 400 });
  }
  return key;
}

class CredentialVault {
  constructor(config) {
    this.keyPath = path.resolve(config.credentialKeyPath);
    this.key = this.#loadOrCreateKey();
  }

  #loadOrCreateKey() {
    fs.mkdirSync(path.dirname(this.keyPath), { recursive: true });
    let encoded;
    try {
      encoded = fs.readFileSync(this.keyPath, 'utf8').trim();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      encoded = crypto.randomBytes(32).toString('base64url');
      try {
        fs.writeFileSync(this.keyPath, `${encoded}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      } catch (writeError) {
        if (writeError.code !== 'EEXIST') throw writeError;
        encoded = fs.readFileSync(this.keyPath, 'utf8').trim();
      }
    }
    const key = Buffer.from(encoded, 'base64url');
    if (key.length !== 32 || key.toString('base64url') !== encoded) {
      throw new Error('凭据主密钥文件无效，拒绝启动以避免损坏已保存的专用 Key');
    }
    try { fs.chmodSync(this.keyPath, 0o600); } catch {}
    return key;
  }

  #aad(groupId) {
    if (!validGroupId(groupId)) throw new Error('分组 ID 无效');
    return Buffer.from(`sub2api-degradation-detector:${groupId}`, 'utf8');
  }

  encrypt(groupId, value) {
    const key = validateDedicatedKey(value);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(this.#aad(groupId));
    const encrypted = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      'v1',
      iv.toString('base64url'),
      tag.toString('base64url'),
      encrypted.toString('base64url')
    ].join('.');
  }

  decrypt(groupId, value) {
    const parts = String(value || '').split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') {
      throw new AppError('DETECTION_KEY_UNREADABLE', '专用 Key 无法读取，请由管理员重新配置', { status: 409 });
    }
    try {
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        this.key,
        Buffer.from(parts[1], 'base64url')
      );
      decipher.setAAD(this.#aad(groupId));
      decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
      return validateDedicatedKey(Buffer.concat([
        decipher.update(Buffer.from(parts[3], 'base64url')),
        decipher.final()
      ]).toString('utf8'));
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('DETECTION_KEY_UNREADABLE', '专用 Key 无法读取，请由管理员重新配置', { status: 409 });
    }
  }

  fingerprint(value) {
    const key = validateDedicatedKey(value);
    return crypto.createHmac('sha256', this.key).update(key, 'utf8').digest('base64url');
  }
}

module.exports = { CredentialVault, validGroupId, validateDedicatedKey };
