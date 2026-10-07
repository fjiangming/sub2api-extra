'use strict';

const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { AppError } = require('./errors');

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_FIELD_LENGTH = 180;

function sanitizeEvent(input) {
  const event = {
    eventId: String(input?.eventId || ''),
    anomalyCode: String(input?.anomalyCode || ''),
    orderNo: input?.orderNo == null ? null : String(input.orderNo),
    amount: String(input?.amount || ''),
    tradeLast6: String(input?.tradeLast6 || ''),
    memoLast6: String(input?.memoLast6 || ''),
    occurredAt: String(input?.occurredAt || '')
  };
  if (!/^[A-Za-z0-9._:-]{8,180}$/.test(event.eventId) ||
      !/^[A-Z0-9_]{3,80}$/.test(event.anomalyCode) ||
      (event.orderNo != null && !/^[A-Za-z0-9_-]{3,80}$/.test(event.orderNo)) ||
      !/^(0|[1-9]\d{0,11})\.\d{2}$/.test(event.amount) ||
      !/^(?:|\d{6})$/.test(event.tradeLast6) ||
      (event.tradeLast6 === '' && !event.anomalyCode.startsWith('QR_')) ||
      !/^[A-Za-z0-9_-]{1,6}$/.test(event.memoLast6) ||
      !Number.isFinite(Date.parse(event.occurredAt)) ||
      Object.values(event).some((value) => value != null && String(value).length > MAX_FIELD_LENGTH)) {
    throw new AppError('ALERT_EVENT_INVALID', '异常通知事件不符合安全字段白名单', { status: 500 });
  }
  event.occurredAt = new Date(event.occurredAt).toISOString();
  return Object.freeze(event);
}

async function readBoundedResponse(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new AppError('ALERT_RESPONSE_TOO_LARGE', 'Webhook 返回内容超出限制', { status: 502 });
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new AppError('ALERT_RESPONSE_TOO_LARGE', 'Webhook 返回内容超出限制', { status: 502 });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function emailText(event) {
  return [
    '充值中心检测到异常订单，已停止自动放款并进入人工处理。',
    '',
    `异常代码: ${event.anomalyCode}`,
    `订单号: ${event.orderNo || '未识别'}`,
    `应付金额: CNY ${event.amount}`,
    `支付宝交易号末六位: ${event.tradeLast6 || '无（付款前异常）'}`,
    `自动备注末六位: ${event.memoLast6}`,
    `发生时间: ${event.occurredAt}`,
    '',
    '请在受信设备上独立核对支付宝最终交易详情和 Sub2API 兑换记录。不要仅凭本邮件执行补款。'
  ].join('\n');
}

function isRetryable(error) {
  if (error?.details?.retryable === false) return false;
  const remoteStatus = Number(error?.details?.remoteStatus);
  if (remoteStatus >= 400 && remoteStatus < 500 && ![408, 429].includes(remoteStatus)) return false;
  const smtpStatus = Number(error?.details?.smtpStatus);
  if (smtpStatus >= 500 && smtpStatus < 600) return false;
  return true;
}

class NotificationService {
  constructor(config, options = {}) {
    this.config = config;
    this.fetch = options.fetch || globalThis.fetch;
    this.transport = options.transport || (config.alertChannels.includes('email')
      ? nodemailer.createTransport({
          host: config.smtpHost,
          port: config.smtpPort,
          secure: config.smtpSecure,
          requireTLS: config.smtpRequireTls,
          auth: { user: config.smtpUser, pass: config.smtpPassword },
          connectionTimeout: config.alertTimeoutMs,
          greetingTimeout: config.alertTimeoutMs,
          socketTimeout: config.alertTimeoutMs,
          tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true }
        })
      : null);
  }

  async send(input) {
    const event = sanitizeEvent(input);
    if (this.config.alertChannels.length === 0) {
      throw new AppError('ALERT_CHANNEL_UNAVAILABLE', '未配置充值中心异常通知通道', { status: 503 });
    }
    const deliveries = await Promise.allSettled(this.config.alertChannels.map(async (channel) => {
      await this.#withRetry(() => channel === 'email' ? this.#sendEmail(event) : this.#sendWebhook(event));
      return { channel, status: 'delivered' };
    }));
    const failed = deliveries
      .map((result, index) => result.status === 'rejected' ? this.config.alertChannels[index] : null)
      .filter(Boolean);
    if (failed.length > 0) {
      throw new AppError('ALERT_DELIVERY_FAILED', '一个或多个充值异常通知通道投递失败', {
        status: 503,
        details: { channels: failed }
      });
    }
    return deliveries.map((result) => result.value);
  }

  async #withRetry(operation) {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt === 3 || !isRetryable(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** (attempt - 1)));
      }
    }
    throw lastError;
  }

  async #sendEmail(event) {
    if (!this.transport) {
      throw new AppError('ALERT_EMAIL_UNAVAILABLE', '邮件告警通道未初始化', { status: 503 });
    }
    const messageIdHash = crypto.createHash('sha256').update(event.eventId).digest('hex');
    try {
      await this.transport.sendMail({
        from: this.config.smtpFrom,
        to: this.config.alertEmailTo,
        subject: `[充值中心安全告警] ${event.anomalyCode}`,
        text: emailText(event),
        messageId: `<${messageIdHash}@recharge-center.local>`,
        headers: { 'X-Recharge-Alert-Id': event.eventId }
      });
    } catch (error) {
      throw new AppError('ALERT_EMAIL_DELIVERY_FAILED', '邮件告警投递失败', {
        status: 503,
        details: { smtpStatus: Number(error?.responseCode) || null },
        cause: error
      });
    }
  }

  async #sendWebhook(event) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.alertTimeoutMs);
    try {
      const response = await this.fetch(this.config.alertWebhookUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/json, text/plain;q=0.5',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.alertWebhookBearerToken}`,
          'User-Agent': 'sub2api-recharge-center/1.0'
        },
        body: JSON.stringify({
          type: 'recharge.security_alert',
          source: 'recharge-center',
          ...event
        }),
        redirect: 'error',
        signal: controller.signal
      });
      await readBoundedResponse(response);
      if (!response.ok) {
        throw new AppError('ALERT_WEBHOOK_REJECTED', 'Webhook 拒绝了异常通知', {
          status: 502,
          details: { remoteStatus: response.status }
        });
      }
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new AppError('ALERT_WEBHOOK_TIMEOUT', 'Webhook 通知投递超时', { status: 504 });
      }
      if (error instanceof AppError) throw error;
      throw new AppError('ALERT_WEBHOOK_DELIVERY_FAILED', '无法连接 Webhook 通知通道', { status: 503, cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }

  close() {
    this.transport?.close?.();
  }
}

module.exports = { NotificationService, emailText, readBoundedResponse, sanitizeEvent };
