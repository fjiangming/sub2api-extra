const crypto = require('crypto');
const { AppError } = require('../errors');

const CURRENT_VERSION = 1;
const KEY_LENGTH = 32;

function deriveKey(secret, salt) {
  return crypto.scryptSync(secret, salt, KEY_LENGTH, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024
  });
}

function encryptJson(value, secret) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(secret, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return JSON.stringify({
    version: CURRENT_VERSION,
    algorithm: 'aes-256-gcm',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: ciphertext.toString('base64')
  });
}

function decryptJson(payload, secret) {
  try {
    const envelope = typeof payload === 'string' ? JSON.parse(payload) : payload;
    if (
      envelope?.version !== CURRENT_VERSION ||
      envelope?.algorithm !== 'aes-256-gcm'
    ) {
      throw new Error('Unsupported credential envelope');
    }

    const salt = Buffer.from(envelope.salt, 'base64');
    const iv = Buffer.from(envelope.iv, 'base64');
    const authTag = Buffer.from(envelope.authTag, 'base64');
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
    const key = deriveKey(secret, salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]);
    return JSON.parse(plaintext.toString('utf8'));
  } catch (error) {
    throw new AppError('CREDENTIAL_DECRYPT_FAILED', 'Stored credentials could not be decrypted', {
      status: 500,
      cause: error
    });
  }
}

function hashSecret(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function verifyScryptPassword(password, encoded) {
  try {
    const [version, saltB64, expectedB64] = String(encoded || '').split('$');
    if (version !== 'scrypt-v1' || !saltB64 || !expectedB64) return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(expectedB64, 'base64');
    const actual = crypto.scryptSync(String(password), salt, expected.length);
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function createScryptPasswordHash(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32);
  return ['scrypt-v1', salt.toString('base64'), hash.toString('base64')].join('$');
}

module.exports = {
  encryptJson,
  decryptJson,
  hashSecret,
  verifyScryptPassword,
  createScryptPasswordHash
};
