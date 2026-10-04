'use strict';

const crypto = require('crypto');
const net = require('net');
const { AppError } = require('./errors');

const TRADE_NO_PATTERN = /^\d{20,64}$/;

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

function hmacHex(secret, namespace, value) {
  return crypto.createHmac('sha256', secret).update(`${namespace}\0${value}`).digest('hex');
}

function encryptionKey(secret, namespace) {
  return crypto.createHmac('sha256', secret).update(`encryption-key:v1\0${namespace}`).digest();
}

function sealText(secret, namespace, value, associatedData = '') {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(secret, namespace), iv);
  cipher.setAAD(Buffer.from(String(associatedData), 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `sealed:v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${ciphertext.toString('base64url')}`;
}

function openText(secret, namespace, envelope, associatedData = '') {
  const raw = String(envelope || '');
  const parts = raw.split(':');
  if (parts.length !== 5 || parts[0] !== 'sealed' || parts[1] !== 'v1') {
    throw new AppError('SEALED_VALUE_INVALID', '加密账本字段格式无效', { status: 500 });
  }
  try {
    const iv = Buffer.from(parts[2], 'base64url');
    const tag = Buffer.from(parts[3], 'base64url');
    const ciphertext = Buffer.from(parts[4], 'base64url');
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) throw new Error('invalid envelope');
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(secret, namespace), iv);
    decipher.setAAD(Buffer.from(String(associatedData), 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (error) {
    throw new AppError('SEALED_VALUE_AUTH_FAILED', '加密账本字段完整性校验失败', { status: 500, cause: error });
  }
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normalizeTradeNo(value) {
  const normalized = String(value || '').replace(/[\s-]+/g, '');
  if (!TRADE_NO_PATTERN.test(normalized)) {
    throw new AppError('ALIPAY_TRADE_NO_INVALID', '请输入支付宝账单中的完整支付宝交易号', { status: 400 });
  }
  return normalized;
}

function tradeNoTail(value) {
  return normalizeTradeNo(value).slice(-6);
}

function maskEmail(value) {
  const email = String(value || '').trim();
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${visible}***@${domain}`;
}

function parseRechargeAmount(value, minAmount, maxAmount) {
  const minor = parseMoneyToMinor(value);
  const minMinor = parseMoneyToMinor(minAmount);
  const maxMinor = parseMoneyToMinor(maxAmount);
  if (minor < minMinor) {
    throw new AppError('AMOUNT_TOO_LOW', `充值金额不能低于 ${minorToDecimal(minMinor)} 元`, { status: 400 });
  }
  if (minor > maxMinor) {
    throw new AppError('AMOUNT_TOO_HIGH', `充值金额不能高于 ${minorToDecimal(maxMinor)} 元`, { status: 400 });
  }
  return minor;
}

function parseMoneyToMinor(value) {
  const raw = typeof value === 'number'
    ? (Number.isFinite(value) ? String(value) : '')
    : String(value || '').trim();
  const match = /^(0|[1-9]\d{0,11})(?:\.(\d{1,2}))?$/.exec(raw);
  if (!match) throw new AppError('AMOUNT_INVALID', '金额格式无效', { status: 400 });
  const minor = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(minor)) throw new AppError('AMOUNT_INVALID', '金额超出支持范围', { status: 400 });
  return minor;
}

function minorToDecimal(minor) {
  const value = Number(minor);
  const sign = value < 0 ? '-' : '';
  const absolute = Math.abs(value);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

function microsToDecimal(micros) {
  const value = Number(micros);
  const sign = value < 0 ? '-' : '';
  const absolute = Math.abs(value);
  const whole = Math.floor(absolute / 100000000);
  const trimmedFraction = String(absolute % 100000000).padStart(8, '0').replace(/0+$/, '');
  const fraction = trimmedFraction.padEnd(2, '0');
  return `${sign}${whole}.${fraction}`;
}

function decodeJwtExpiration(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const expiration = Number(claims.exp) * 1000;
    return Number.isFinite(expiration) ? expiration : null;
  } catch {
    return null;
  }
}

function clientContext(req) {
  const candidate = String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  const ip = net.isIP(candidate) ? candidate : '';
  const userAgent = String(req.get?.('user-agent') || req.headers?.['user-agent'] || '').slice(0, 512);
  return { ip, userAgent };
}

function clientBinding(context) {
  return crypto.createHash('sha256').update(`${context.ip}\0${context.userAgent}`).digest('hex');
}

function redactText(value) {
  return String(value || '')
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b\d{20,64}\b/g, '[TRADE_NO_REDACTED]')
    .replace(/([?&](?:token|access_token)=)[^&\s]+/gi, '$1[REDACTED]')
    .slice(0, 500);
}

module.exports = {
  clientBinding,
  clientContext,
  decodeJwtExpiration,
  hmacHex,
  maskEmail,
  microsToDecimal,
  minorToDecimal,
  normalizeTradeNo,
  openText,
  parseRechargeAmount,
  parseCookies,
  parseMoneyToMinor,
  redactText,
  safeEqual,
  sealText,
  tradeNoTail
};
