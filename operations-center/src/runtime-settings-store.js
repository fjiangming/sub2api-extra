'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { AppError } = require('./errors');

const KEY_BYTES = 32;

class RuntimeSettingsStore {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    this.keyPath = path.join(this.dataDir, 'settings.key');
    this.settingsPath = path.join(this.dataDir, 'settings.enc.json');
    this.key = null;
    this.settings = {};
    this.queue = Promise.resolve();
  }

  async initialize() {
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    this.key = await this.loadOrCreateKey();
    this.settings = await this.readEncrypted();
    return this.snapshot();
  }

  snapshot() {
    return structuredClone(this.settings || {});
  }

  async update(mutator) {
    const operation = async () => {
      const next = structuredClone(this.settings || {});
      const result = await mutator(next);
      this.settings = result && typeof result === 'object' ? result : next;
      await this.writeEncrypted(this.settings);
      return this.snapshot();
    };
    this.queue = this.queue.then(operation, operation);
    return this.queue;
  }

  async loadOrCreateKey() {
    try {
      const encoded = (await fs.readFile(this.keyPath, 'utf8')).trim();
      const key = Buffer.from(encoded, 'base64url');
      if (key.length !== KEY_BYTES) throw new Error('invalid key length');
      return key;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new AppError('SETTINGS_KEY_INVALID', '运营中心配置密钥无效', { expose: false });
      }
      const key = crypto.randomBytes(KEY_BYTES);
      await fs.writeFile(this.keyPath, key.toString('base64url'), { mode: 0o600, flag: 'wx' });
      return key;
    }
  }

  async readEncrypted() {
    try {
      const envelope = JSON.parse(await fs.readFile(this.settingsPath, 'utf8'));
      if (envelope.version !== 1) throw new Error('unsupported settings version');
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        this.key,
        Buffer.from(envelope.iv, 'base64url')
      );
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
        decipher.final()
      ]);
      const value = JSON.parse(plaintext.toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid settings payload');
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw new AppError('SETTINGS_DECRYPT_FAILED', '无法解密运营中心运行配置', { expose: false });
    }
  }

  async writeEncrypted(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), 'utf8'),
      cipher.final()
    ]);
    const envelope = JSON.stringify({
      version: 1,
      iv: iv.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
      ciphertext: ciphertext.toString('base64url')
    });
    const temporaryPath = `${this.settingsPath}.${process.pid}.tmp`;
    await fs.writeFile(temporaryPath, envelope, { mode: 0o600 });
    await fs.rename(temporaryPath, this.settingsPath);
  }
}

module.exports = { RuntimeSettingsStore };
