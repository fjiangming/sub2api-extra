'use strict';

const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { z } = require('zod');
const { AppError } = require('./errors');
const { MAX_NEARBY_ORDERS } = require('./order-alert-context');

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_FIELD_LENGTH = 180;
const MAX_EMAIL_LENGTH = 320;
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const USER_EMAIL_SCHEMA = z.string().email().max(MAX_EMAIL_LENGTH).refine((value) => !UNSAFE_TEXT.test(value));
const MONEY_SCHEMA = z.string().regex(/^(0|[1-9]\d{0,11})\.\d{2}$/);
const DATE_SCHEMA = z.string().datetime({ offset: true });
const PAYMENT_SCHEMA = z.object({
  amount: z.string().regex(/^-?(0|[1-9]\d{0,11})\.\d{2}$/),
  direction: z.enum(['income', 'expense', 'unknown']),
  paidAt: DATE_SCHEMA
});
const NEARBY_ORDERS_SCHEMA = z.object({
  from: DATE_SCHEMA,
  until: DATE_SCHEMA,
  total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  totalUsers: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  orders: z.array(z.object({
    orderNo: z.string().regex(/^[A-Za-z0-9_-]{3,80}$/),
    userId: z.string().regex(/^[1-9]\d{0,15}$/).refine((value) => Number.isSafeInteger(Number(value))),
    userEmail: USER_EMAIL_SCHEMA.nullable(),
    requestedAmount: MONEY_SCHEMA,
    payableAmount: MONEY_SCHEMA,
    status: z.enum(['awaiting_payment', 'payment_reported', 'fulfilling', 'needs_attention',
      'completed', 'rejected', 'expired', 'cancelled']),
    createdAt: DATE_SCHEMA,
    expiresAt: DATE_SCHEMA
  })).max(MAX_NEARBY_ORDERS)
}).refine((value) => value.total >= value.orders.length && value.totalUsers <= value.total &&
  value.totalUsers >= new Set(value.orders.map((order) => order.userId)).size &&
  Date.parse(value.from) <= Date.parse(value.until));

function containsUnsafeText(value) {
  if (typeof value === 'string') return UNSAFE_TEXT.test(value);
  if (value && typeof value === 'object') return Object.values(value).some(containsUnsafeText);
  return false;
}

function sanitizeContext(schema, input) {
  if (input == null) return null;
  const result = schema.safeParse(input);
  if (!result.success || containsUnsafeText(result.data)) {
    throw new AppError('ALERT_EVENT_INVALID', '异常通知事件不符合安全字段白名单', { status: 500 });
  }
  return result.data;
}

function sanitizeEvent(input) {
  const event = {
    eventId: String(input?.eventId || ''),
    anomalyCode: String(input?.anomalyCode || ''),
    orderNo: input?.orderNo == null ? null : String(input.orderNo),
    userId: input?.userId == null ? null : String(input.userId),
    userEmail: input?.userEmail == null ? null : String(input.userEmail),
    amount: String(input?.amount || ''),
    tradeLast6: String(input?.tradeLast6 || ''),
    memoLast6: String(input?.memoLast6 || ''),
    occurredAt: String(input?.occurredAt || '')
  };
  if (!/^[A-Za-z0-9._:-]{8,180}$/.test(event.eventId) ||
      !/^[A-Z0-9_]{3,80}$/.test(event.anomalyCode) ||
      (event.orderNo != null && !/^[A-Za-z0-9_-]{3,80}$/.test(event.orderNo)) ||
      (event.userId != null && (!/^[1-9]\d{0,15}$/.test(event.userId) || !Number.isSafeInteger(Number(event.userId)))) ||
      (event.userEmail != null && (event.userId == null || !USER_EMAIL_SCHEMA.safeParse(event.userEmail).success)) ||
      !/^(0|[1-9]\d{0,11})\.\d{2}$/.test(event.amount) ||
      !/^(?:|[A-Za-z0-9_-]{6})$/.test(event.tradeLast6) ||
      (event.tradeLast6 === '' && !event.anomalyCode.startsWith('QR_')) ||
      !/^(?:|[A-Za-z0-9_-]{1,6})$/.test(event.memoLast6) ||
      !Number.isFinite(Date.parse(event.occurredAt)) ||
      Object.entries(event).some(([key, value]) => value != null &&
        (UNSAFE_TEXT.test(value) || String(value).length > (key === 'userEmail' ? MAX_EMAIL_LENGTH : MAX_FIELD_LENGTH)))) {
    throw new AppError('ALERT_EVENT_INVALID', '异常通知事件不符合安全字段白名单', { status: 500 });
  }
  event.occurredAt = new Date(event.occurredAt).toISOString();
  const payment = sanitizeContext(PAYMENT_SCHEMA, input?.payment);
  event.payment = payment ? Object.freeze({ ...payment, paidAt: new Date(payment.paidAt).toISOString() }) : null;
  const nearby = sanitizeContext(NEARBY_ORDERS_SCHEMA, input?.nearbyOrders);
  event.nearbyOrders = nearby ? Object.freeze({
    ...nearby,
    from: new Date(nearby.from).toISOString(),
    until: new Date(nearby.until).toISOString(),
    orders: Object.freeze(nearby.orders.map((order) => Object.freeze({
      ...order,
      createdAt: new Date(order.createdAt).toISOString(),
      expiresAt: new Date(order.expiresAt).toISOString()
    })))
  }) : null;
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

function beijingTime(value) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).format(new Date(value));
}

function nearbyOrdersText(nearby) {
  if (!nearby) return [];
  const statusLabels = {
    awaiting_payment: '待付款', payment_reported: '待核验', fulfilling: '入账中', needs_attention: '待人工处理',
    completed: '已完成', rejected: '已拒绝', expired: '已过期', cancelled: '已取消'
  };
  return [
    '',
    '附近订单候选（仅供人工核对，归属未确认，不能据此自动补款）',
    `查询时段（北京时间）: ${beijingTime(nearby.from)} 至 ${beijingTime(nearby.until)}`,
    '范围: 付款窗口与流水交易时间前后各 3 分钟有交集的充值订单；先列出每位用户的一笔订单，再列其他订单，金额相同者优先。',
    `共 ${nearby.totalUsers} 位用户、${nearby.total} 笔订单；展示 ${new Set(nearby.orders.map((order) => order.userId)).size} 位用户、${nearby.orders.length} 笔订单。`,
    ...nearby.orders.map((order, index) => [
      `${index + 1}. 用户 ID: ${order.userId}; 完整邮箱: ${order.userEmail || '不可用，请按用户 ID 查找'}`,
      `   订单号: ${order.orderNo}; 目标金额: CNY ${order.requestedAmount}; 应付金额: CNY ${order.payableAmount}; 状态: ${statusLabels[order.status]}`,
      `   创建时间（北京时间）: ${beijingTime(order.createdAt)}; 到期时间: ${beijingTime(order.expiresAt)}`
    ].join('\n')),
    ...(nearby.total === 0 ? ['该时间段内没有充值订单，不能认定该流水来自充值用户。'] : []),
    ...(nearby.total > nearby.orders.length
      ? [`另有 ${nearby.total - nearby.orders.length} 笔未展开，请按上述时间段在充值中心管理页面继续核对。`]
      : [])
  ];
}

function emailText(event) {
  return [
    event.orderNo
      ? '充值中心检测到异常订单，已停止本次自动放款，请人工核对。'
      : '充值中心检测到未能唯一关联订单的支付宝流水，本次未自动充值，请人工核对。',
    '',
    `异常代码: ${event.anomalyCode}`,
    `订单号: ${event.orderNo || '未识别'}`,
    `下单用户 ID: ${event.userId || '未识别'}`,
    `下单账号（完整邮箱）: ${event.userId
      ? event.userEmail || '未记录完整邮箱，请按用户 ID 查找'
      : '归属未确认，未匹配到唯一订单，请人工核对'}`,
    `${event.orderNo ? '应付金额' : '流水金额（绝对值）'}: CNY ${event.amount}`,
    ...(event.payment ? [
      `账单收支方向: ${{ income: '收入', expense: '支出', unknown: '无法识别' }[event.payment.direction]}`,
      `账单原始金额（保留正负号）: CNY ${event.payment.amount}`,
      `账单交易时间（北京时间）: ${beijingTime(event.payment.paidAt)}`
    ] : []),
    `支付宝交易/账务流水末六位: ${event.tradeLast6 || '无（付款前异常）'}`,
    `备注末六位: ${event.memoLast6 || '无'}`,
    `告警时间（北京时间）: ${beijingTime(event.occurredAt)}`,
    ...nearbyOrdersText(event.nearbyOrders),
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
