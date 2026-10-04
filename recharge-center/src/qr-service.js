'use strict';

const fs = require('fs');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { AppError } = require('./errors');

function detectImageType(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { contentType: 'image/png', extension: 'png' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { contentType: 'image/jpeg', extension: 'jpg' };
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return { contentType: 'image/webp', extension: 'webp' };
  }
  throw new Error('ALIPAY_QR_IMAGE_PATH 仅支持 PNG、JPEG 或 WebP 图片');
}

class QrService {
  constructor(config) {
    this.config = config;
    this.asset = null;
    if (config.qrImagePath) this.asset = this.#load(config.qrImagePath);
  }

  #load(filePath) {
    const realPath = fs.realpathSync(filePath);
    const stat = fs.statSync(realPath);
    if (!stat.isFile()) throw new Error('ALIPAY_QR_IMAGE_PATH 必须指向普通文件');
    if (stat.size < 128 || stat.size > this.config.qrMaxBytes) {
      throw new Error(`收款码图片大小必须在 128 字节到 ${this.config.qrMaxBytes} 字节之间`);
    }
    if (process.platform !== 'win32' && (stat.mode & 0o022) !== 0) {
      throw new Error('收款码图片不能允许同组或其他用户写入，请将权限设置为 0400 或 0440');
    }
    const buffer = fs.readFileSync(realPath);
    const detected = detectImageType(buffer);
    return {
      ...detected,
      buffer,
      bytes: buffer.length,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex')
    };
  }

  status() {
    if (this.config.automaticPersonalMode) {
      return { available: Boolean(this.config.transferQrTemplate), dynamic: true };
    }
    return this.asset
      ? { available: true, bytes: this.asset.bytes, fingerprint: this.asset.sha256.slice(0, 12) }
      : { available: false };
  }

  async send(res, payment = null) {
    if (this.config.automaticPersonalMode) return this.#sendDynamic(res, payment);
    if (!this.asset) {
      throw new AppError('PAYMENT_QR_UNAVAILABLE', '收款码暂不可用，请联系管理员', { status: 503 });
    }
    res.set({
      'Content-Type': this.asset.contentType,
      'Content-Length': String(this.asset.buffer.length),
      'Content-Disposition': `inline; filename="alipay-payment.${this.asset.extension}"`,
      'Cache-Control': 'no-store, max-age=0, private',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox"
    });
    res.end(this.asset.buffer);
  }

  async #sendDynamic(res, payment) {
    if (!this.config.transferQrTemplate || !payment?.amount || !payment?.memo) {
      throw new AppError('PAYMENT_QR_UNAVAILABLE', '订单支付二维码暂不可用', { status: 503 });
    }
    const payload = this.config.transferQrTemplate
      .replace('{amount}', encodeURIComponent(payment.amount))
      .replace('{memo}', encodeURIComponent(payment.memo));
    let buffer;
    try {
      buffer = await QRCode.toBuffer(payload, {
        type: 'png',
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 480,
        color: { dark: '#000000', light: '#ffffff' }
      });
    } catch (error) {
      throw new AppError('PAYMENT_QR_GENERATION_FAILED', '订单支付二维码生成失败', { status: 503, cause: error });
    }
    res.set({
      'Content-Type': 'image/png',
      'Content-Length': String(buffer.length),
      'Content-Disposition': 'inline; filename="alipay-transfer.png"',
      'Cache-Control': 'no-store, max-age=0, private',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox"
    });
    res.end(buffer);
  }
}

module.exports = { QrService, detectImageType };
