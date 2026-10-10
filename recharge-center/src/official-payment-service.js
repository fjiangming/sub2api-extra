'use strict';

const QRCode = require('qrcode');
const { AppError } = require('./errors');
const { DailyOrderLimit } = require('./daily-order-limit');
const { minorToDecimal, parseMoneyToMinor, parseRechargeAmount } = require('./security');

const ACTIVE_REMOTE_STATUSES = new Set(['PENDING', 'PAID', 'RECHARGING']);
const TERMINAL_REMOTE_STATUSES = new Set([
  'COMPLETED',
  'EXPIRED',
  'CANCELLED',
  'FAILED',
  'REFUND_REQUESTED',
  'REFUNDING',
  'REFUND_PENDING',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
  'REFUND_FAILED'
]);
const ORDER_NUMBER_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;
const MAX_QR_PAYLOAD_BYTES = 4096;
const MAX_PAY_URL_BYTES = 8192;

function isAlipayHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'alipay.com' || host.endsWith('.alipay.com')
    || host === 'alipaydev.com' || host.endsWith('.alipaydev.com');
}

function invalidRemoteResponse(message = 'Sub2API 返回的支付数据无效') {
  return new AppError('SUB2API_PAYMENT_RESPONSE_INVALID', message, { status: 502 });
}

function paymentStatus(status) {
  switch (String(status || '').trim().toUpperCase()) {
    case 'PENDING': return 'awaiting_payment';
    case 'PAID':
    case 'RECHARGING': return 'fulfilling';
    case 'COMPLETED': return 'completed';
    case 'EXPIRED': return 'expired';
    case 'CANCELLED': return 'cancelled';
    case 'FAILED': return 'failed';
    case 'REFUND_REQUESTED': return 'refund_requested';
    case 'REFUNDING':
    case 'REFUND_PENDING':
    case 'PARTIALLY_REFUNDED': return 'refunding';
    case 'REFUNDED': return 'refunded';
    case 'REFUND_FAILED': return 'refund_failed';
    default: throw invalidRemoteResponse('Sub2API 返回了未知的支付订单状态');
  }
}

function parseRemoteMoney(value, field) {
  try {
    return parseMoneyToMinor(value);
  } catch {
    throw invalidRemoteResponse(`Sub2API 支付字段 ${field} 无效`);
  }
}

function parseOptionalLimit(value, field) {
  const number = Number(value || 0);
  if (number === 0) return 0;
  return parseRemoteMoney(value, field);
}

function parseOrderId(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d{1,16}$/.test(raw)) throw invalidRemoteResponse('Sub2API 返回的支付订单 ID 无效');
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw invalidRemoteResponse('Sub2API 返回的支付订单 ID 无效');
  return id;
}

function parseDate(value, field) {
  const date = new Date(String(value || ''));
  if (Number.isNaN(date.getTime())) throw invalidRemoteResponse(`Sub2API 支付字段 ${field} 无效`);
  return date.toISOString();
}

function normalizeOrderNumber(value) {
  const orderNumber = String(value || '').trim();
  if (!ORDER_NUMBER_PATTERN.test(orderNumber)) {
    throw invalidRemoteResponse('Sub2API 返回的商户订单号无效');
  }
  return orderNumber;
}

function normalizeQrPayload(value) {
  const payload = String(value || '').trim();
  if (!payload) return '';
  if (Buffer.byteLength(payload, 'utf8') > MAX_QR_PAYLOAD_BYTES || /[\u0000-\u001f\u007f]/.test(payload)) {
    throw invalidRemoteResponse('Sub2API 返回的支付宝二维码内容无效');
  }
  let url;
  try {
    url = new URL(payload);
  } catch {
    throw invalidRemoteResponse('Sub2API 返回的支付宝二维码内容无效');
  }
  if (url.protocol !== 'https:' || url.username || url.password || !isAlipayHost(url.hostname)) {
    throw invalidRemoteResponse('支付宝动态二维码指向了未授权的域名');
  }
  return url.toString();
}

function normalizePayUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (Buffer.byteLength(raw, 'utf8') > MAX_PAY_URL_BYTES) {
    throw invalidRemoteResponse('Sub2API 返回的支付宝收银台地址无效');
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw invalidRemoteResponse('Sub2API 返回的支付宝收银台地址无效');
  }
  if (url.protocol !== 'https:' || url.username || url.password || !isAlipayHost(url.hostname)) {
    throw invalidRemoteResponse('支付宝收银台指向了未授权的域名');
  }
  return url.toString();
}

function normalizeRemoteOrder(raw, expectedUserId, expectedProviderInstanceIds = null) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalidRemoteResponse();
  const id = parseOrderId(raw.id);
  const userId = Number(raw.user_id);
  if (!Number.isSafeInteger(userId) || userId <= 0 || userId !== Number(expectedUserId)) {
    throw invalidRemoteResponse('Sub2API 支付订单归属校验失败');
  }
  const paymentType = String(raw.payment_type || '').trim().toLowerCase();
  const orderType = String(raw.order_type || '').trim().toLowerCase();
  if (paymentType !== 'alipay' || orderType !== 'balance') {
    throw invalidRemoteResponse('Sub2API 返回了不属于支付宝余额充值的订单');
  }
  const providerInstanceId = String(raw.provider_instance_id || '').trim();
  if (expectedProviderInstanceIds && !expectedProviderInstanceIds.includes(providerInstanceId)) {
    throw invalidRemoteResponse('支付订单未使用充值中心允许的官方支付宝通道');
  }
  const currency = String(raw.currency || 'CNY').trim().toUpperCase();
  if (currency !== 'CNY') throw invalidRemoteResponse('充值中心只允许人民币支付宝订单');
  const status = String(raw.status || '').trim().toUpperCase();
  paymentStatus(status);
  const feeRate = Number(raw.fee_rate || 0);
  if (!Number.isFinite(feeRate) || feeRate < 0) throw invalidRemoteResponse('Sub2API 返回的手续费率无效');
  return {
    id,
    userId,
    amountMinor: parseRemoteMoney(raw.amount, 'amount'),
    payAmountMinor: parseRemoteMoney(raw.pay_amount, 'pay_amount'),
    feeRate,
    currency,
    paymentType,
    orderType,
    providerInstanceId,
    outTradeNo: normalizeOrderNumber(raw.out_trade_no),
    status,
    createdAt: parseDate(raw.created_at, 'created_at'),
    expiresAt: parseDate(raw.expires_at, 'expires_at'),
    paidAt: raw.paid_at ? parseDate(raw.paid_at, 'paid_at') : null,
    completedAt: raw.completed_at ? parseDate(raw.completed_at, 'completed_at') : null
  };
}

function publicOrder(order, paymentDetails) {
  return {
    id: String(order.id),
    orderNo: order.outTradeNo,
    userId: String(order.userId),
    payableAmount: minorToDecimal(order.payAmountMinor),
    creditAmount: minorToDecimal(order.amountMinor),
    currency: order.currency,
    status: paymentStatus(order.status),
    providerStatus: order.status,
    expiresAt: order.expiresAt,
    alipayPaidAt: order.paidAt,
    completedAt: order.completedAt,
    createdAt: order.createdAt,
    updatedAt: order.completedAt || order.paidAt || order.createdAt,
    automaticConfirmation: true,
    qrAvailable: Boolean(paymentDetails?.qrPayload),
    payUrl: paymentDetails?.payUrl || null
  };
}

class OfficialPaymentService {
  constructor({ db, config, sub2api, dailyOrderLimit = null, clock = () => new Date() }) {
    this.config = config;
    this.sub2api = sub2api;
    this.clock = clock;
    this.dailyOrderLimit = dailyOrderLimit || new DailyOrderLimit({ db, clock });
    this.tracked = new Map();
    this.paymentDetails = new Map();
    this.creatingUsers = new Set();
    this.pollingCount = 0;
    this.pollTimer = setInterval(() => {
      this.#dispatchPolls().catch(() => {});
    }, 1000);
    this.pollTimer.unref?.();
  }

  close() {
    clearInterval(this.pollTimer);
    this.tracked.clear();
    this.paymentDetails.clear();
    this.creatingUsers.clear();
  }

  releaseSession(sessionId) {
    for (const [key, entry] of this.tracked) {
      if (entry.sessionId === sessionId) this.tracked.delete(key);
    }
    for (const [key, details] of this.paymentDetails) {
      if (details.sessionId === sessionId) this.paymentDetails.delete(key);
    }
  }

  async pollNow() {
    const now = this.clock().getTime();
    for (const entry of this.tracked.values()) entry.nextPollAt = Math.min(entry.nextPollAt, now);
    await this.#dispatchPolls();
  }

  async checkout(auth) {
    this.#requireSession(auth);
    const payload = await this.sub2api.getPaymentCheckoutInfo(auth.upstreamToken, auth.client);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw invalidRemoteResponse();
    if (payload.balance_disabled === true) {
      throw new AppError('BALANCE_RECHARGE_DISABLED', 'Sub2API 当前已关闭余额充值', { status: 503 });
    }
    if (Number(payload.balance_recharge_multiplier) !== 1 || Number(payload.recharge_fee_rate || 0) !== 0) {
      throw new AppError(
        'EXACT_AMOUNT_POLICY_REQUIRED',
        '为确保实付金额与到账额度完全一致，请将 Sub2API 充值倍率设为 1、手续费率设为 0',
        { status: 503 }
      );
    }
    const method = payload.methods?.alipay;
    if (!method || typeof method !== 'object' || method.available === false) {
      throw new AppError('OFFICIAL_ALIPAY_UNAVAILABLE', 'Sub2API 当前未启用支付宝支付', { status: 503 });
    }
    const currency = String(method.currency || 'CNY').trim().toUpperCase();
    if (currency !== 'CNY') {
      throw new AppError('OFFICIAL_ALIPAY_CURRENCY_INVALID', '自动充值仅支持人民币支付宝通道', { status: 503 });
    }
    const remoteMinMinor = parseOptionalLimit(method.single_min, 'single_min');
    const remoteMaxMinor = parseOptionalLimit(method.single_max, 'single_max');
    const localMinMinor = parseRemoteMoney(this.config.minAmount, 'local_min');
    const localMaxMinor = parseRemoteMoney(this.config.maxAmount, 'local_max');
    const minMinor = Math.max(localMinMinor, remoteMinMinor || localMinMinor);
    const maxMinor = remoteMaxMinor > 0 ? Math.min(localMaxMinor, remoteMaxMinor) : localMaxMinor;
    if (minMinor > maxMinor) {
      throw new AppError('OFFICIAL_ALIPAY_LIMITS_INVALID', '支付宝通道金额范围与充值中心配置没有交集', { status: 503 });
    }
    return {
      paymentMode: 'sub2api_official',
      automaticConfirmation: true,
      currency,
      minAmount: Number(minorToDecimal(minMinor)),
      maxAmount: Number(minorToDecimal(maxMinor)),
      quickAmounts: this.config.quickAmounts.filter((value) => {
        const minor = parseRemoteMoney(value, 'quick_amount');
        return minor >= minMinor && minor <= maxMinor;
      }),
      balanceRechargeMultiplier: 1,
      rechargeFeeRate: 0
    };
  }

  async create(auth, sessionId, amount) {
    this.#requireSession(auth);
    const userId = Number(auth.user.id);
    if (this.creatingUsers.has(userId)) {
      throw new AppError('ORDER_CREATE_IN_PROGRESS', '充值订单正在创建，请勿重复提交', { status: 409 });
    }
    this.creatingUsers.add(userId);
    try {
      this.dailyOrderLimit.assertAvailable(userId);
      const checkout = await this.checkout(auth);
      const amountMinor = parseRechargeAmount(amount, checkout.minAmount, checkout.maxAmount);
      const current = await this.#listRemote(auth);
      const activeCount = current.filter((order) => ACTIVE_REMOTE_STATUSES.has(order.status)).length;
      if (activeCount >= this.config.maxActiveOrders) {
        throw new AppError('ACTIVE_ORDER_EXISTS', '请先处理当前充值订单', { status: 409 });
      }
      const quotaReservation = this.dailyOrderLimit.reserveOfficial(userId);
      let result;
      try {
        result = await this.sub2api.createPaymentOrder(auth.upstreamToken, {
          amount: Number(minorToDecimal(amountMinor)),
          // Sub2API only accepts its own /payment/result URL here. This QR flow
          // settles through webhook/query, so no cross-origin browser return is needed.
          returnUrl: '',
          isMobile: false
        }, auth.client);
      } catch (error) {
        // Only explicit client rejection proves that no remote order was created.
        const remoteStatus = Number(error?.details?.remoteStatus);
        if (['SUB2API_AUTH_FAILED', 'SUB2API_SESSION_BINDING_MISMATCH'].includes(error?.code) ||
            (error?.code === 'SUB2API_REQUEST_FAILED' && remoteStatus >= 400 && remoteStatus < 500)) {
          this.dailyOrderLimit.releaseOfficial(quotaReservation);
        }
        throw error;
      }
      let created;
      try {
        created = this.#normalizeCreatedOrder(result, auth.user.id);
        this.dailyOrderLimit.confirmOfficial(quotaReservation, created.id);
      } catch (error) {
        try {
          await this.#cancelUnsafeOrder(auth, parseOrderId(result?.order_id));
        } catch {}
        throw error;
      }
      try {
        const authoritative = normalizeRemoteOrder(
          await this.sub2api.getPaymentOrder(auth.upstreamToken, created.id, auth.client),
          auth.user.id,
          this.config.officialAlipayInstanceIds
        );
        if (authoritative.id !== created.id || authoritative.outTradeNo !== created.outTradeNo) {
          throw invalidRemoteResponse('Sub2API 回读的支付宝订单与创建结果不一致');
        }
        created = authoritative;
      } catch (error) {
        await this.#cancelUnsafeOrder(auth, created.id);
        throw error;
      }
      if (Date.parse(created.expiresAt) <= this.clock().getTime()) {
        await this.#cancelUnsafeOrder(auth, created.id);
        throw invalidRemoteResponse('Sub2API 返回了已经过期的支付宝订单');
      }
      if (created.amountMinor !== amountMinor || created.payAmountMinor !== amountMinor || created.feeRate !== 0) {
        await this.#cancelUnsafeOrder(auth, created.id);
        throw new AppError(
          'PAYMENT_AMOUNT_POLICY_CHANGED',
          'Sub2API 返回的实付金额或到账额度与所选金额不一致，订单已停止展示',
          { status: 502 }
        );
      }
      let qrPayload;
      let payUrl;
      try {
        qrPayload = normalizeQrPayload(result.qr_code);
        payUrl = normalizePayUrl(result.pay_url);
      } catch (error) {
        await this.#cancelUnsafeOrder(auth, created.id);
        throw error;
      }
      if (!qrPayload && !payUrl) {
        await this.#cancelUnsafeOrder(auth, created.id);
        throw invalidRemoteResponse('Sub2API 未返回支付宝动态二维码或收银台地址');
      }
      const detailsKey = this.#detailsKey(userId, created.id);
      this.paymentDetails.set(detailsKey, {
        sessionId,
        qrPayload,
        qrBuffer: null,
        payUrl,
        expiresAt: created.expiresAt
      });
      this.#track(created, auth, sessionId);
      return publicOrder(created, this.paymentDetails.get(detailsKey));
    } finally {
      this.creatingUsers.delete(userId);
    }
  }

  async listForUser(auth, sessionId) {
    this.#requireSession(auth);
    const orders = await this.#listRemote(auth);
    for (const order of orders) this.#observe(order, auth, sessionId);
    return orders
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .map((order) => publicOrder(order, this.paymentDetails.get(this.#detailsKey(order.userId, order.id))));
  }

  async getForUser(auth, sessionId, orderId) {
    this.#requireSession(auth);
    const id = parseOrderId(orderId);
    const raw = await this.sub2api.getPaymentOrder(auth.upstreamToken, id, auth.client);
    const order = normalizeRemoteOrder(raw, auth.user.id, this.config.officialAlipayInstanceIds);
    this.#observe(order, auth, sessionId);
    return publicOrder(order, this.paymentDetails.get(this.#detailsKey(order.userId, order.id)));
  }

  async cancel(auth, sessionId, orderId) {
    this.#requireSession(auth);
    const id = parseOrderId(orderId);
    await this.sub2api.cancelPaymentOrder(auth.upstreamToken, id, auth.client);
    this.tracked.delete(this.#trackedKey(auth.user.id, id));
    this.paymentDetails.delete(this.#detailsKey(auth.user.id, id));
    return this.getForUser(auth, sessionId, id);
  }

  async sendQr(res, auth, orderId) {
    this.#requireSession(auth);
    const id = parseOrderId(orderId);
    const details = this.paymentDetails.get(this.#detailsKey(auth.user.id, id));
    if (!details?.qrPayload) {
      throw new AppError('PAYMENT_QR_UNAVAILABLE', '该订单的动态二维码已失效，请取消后重新创建', { status: 409 });
    }
    if (Date.parse(details.expiresAt) <= this.clock().getTime()) {
      this.paymentDetails.delete(this.#detailsKey(auth.user.id, id));
      throw new AppError('ORDER_EXPIRED', '订单已过期，请勿继续付款', { status: 410 });
    }
    if (!details.qrBuffer) {
      details.qrBuffer = await QRCode.toBuffer(details.qrPayload, {
        type: 'png',
        width: 220,
        margin: 2,
        errorCorrectionLevel: 'M',
        color: { dark: '#111827', light: '#ffffff' }
      });
    }
    res.set({
      'Content-Type': 'image/png',
      'Content-Length': String(details.qrBuffer.length),
      'Content-Disposition': `inline; filename="alipay-${id}.png"`,
      'Cache-Control': 'no-store, max-age=0, private',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox"
    });
    res.end(details.qrBuffer);
  }

  async #listRemote(auth) {
    const payload = await this.sub2api.getPaymentOrders(auth.upstreamToken, auth.client, { page: 1, pageSize: 50 });
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.items) || payload.items.length > 50) {
      throw invalidRemoteResponse('Sub2API 返回的支付订单列表无效');
    }
    return payload.items
      .filter((raw) => String(raw?.payment_type || '').toLowerCase() === 'alipay'
        && String(raw?.order_type || '').toLowerCase() === 'balance'
        && this.config.officialAlipayInstanceIds.includes(String(raw?.provider_instance_id || '').trim()))
      .map((raw) => normalizeRemoteOrder(raw, auth.user.id, this.config.officialAlipayInstanceIds));
  }

  #normalizeCreatedOrder(raw, userId) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalidRemoteResponse();
    const status = String(raw.status || 'PENDING').trim().toUpperCase();
    if (status !== 'PENDING') throw invalidRemoteResponse('新建支付宝订单不是待付款状态');
    const currency = String(raw.currency || 'CNY').trim().toUpperCase();
    if (currency !== 'CNY') throw invalidRemoteResponse('充值中心只允许人民币支付宝订单');
    if (String(raw.payment_type || 'alipay').trim().toLowerCase() !== 'alipay') {
      throw invalidRemoteResponse('Sub2API 返回了非支付宝订单');
    }
    const feeRate = Number(raw.fee_rate || 0);
    if (!Number.isFinite(feeRate)) throw invalidRemoteResponse('Sub2API 返回的手续费率无效');
    return {
      id: parseOrderId(raw.order_id),
      userId: Number(userId),
      amountMinor: parseRemoteMoney(raw.amount, 'amount'),
      payAmountMinor: parseRemoteMoney(raw.pay_amount, 'pay_amount'),
      feeRate,
      currency,
      paymentType: 'alipay',
      orderType: 'balance',
      outTradeNo: normalizeOrderNumber(raw.out_trade_no),
      status,
      createdAt: this.clock().toISOString(),
      expiresAt: parseDate(raw.expires_at, 'expires_at'),
      paidAt: null,
      completedAt: null
    };
  }

  async #cancelUnsafeOrder(auth, orderId) {
    try {
      await this.sub2api.cancelPaymentOrder(auth.upstreamToken, orderId, auth.client);
    } catch {
      // The payment details are never exposed, even if best-effort cancellation fails.
    }
  }

  #requireSession(auth) {
    if (!auth?.upstreamToken || !auth?.user?.id || auth.expiresAt <= this.clock().getTime()) {
      throw new AppError('SUB2API_PAYMENT_SESSION_REQUIRED', '支付会话已失效，请重新进入充值中心', { status: 401 });
    }
  }

  #detailsKey(userId, orderId) {
    return `${Number(userId)}:${Number(orderId)}`;
  }

  #trackedKey(userId, orderId) {
    return `${Number(userId)}:${Number(orderId)}`;
  }

  #observe(order, auth, sessionId) {
    if (ACTIVE_REMOTE_STATUSES.has(order.status)) {
      this.#track(order, auth, sessionId);
      return;
    }
    this.tracked.delete(this.#trackedKey(order.userId, order.id));
    if (TERMINAL_REMOTE_STATUSES.has(order.status)) {
      this.paymentDetails.delete(this.#detailsKey(order.userId, order.id));
    }
  }

  #track(order, auth, sessionId) {
    const key = this.#trackedKey(order.userId, order.id);
    const previous = this.tracked.get(key);
    this.tracked.set(key, {
      key,
      orderId: order.id,
      outTradeNo: order.outTradeNo,
      userId: order.userId,
      token: auth.upstreamToken,
      client: { ip: auth.client?.ip || '', userAgent: auth.client?.userAgent || '' },
      sessionId,
      sessionExpiresAt: auth.expiresAt,
      orderExpiresAt: Date.parse(order.expiresAt),
      failures: previous?.failures || 0,
      inFlight: previous?.inFlight || false,
      nextPollAt: previous?.nextPollAt || (this.clock().getTime() + this.config.officialPollSeconds * 1000)
    });
  }

  async #dispatchPolls() {
    const now = this.clock().getTime();
    if (this.pollingCount >= this.config.officialPollConcurrency) return;
    const pending = [];
    for (const entry of this.tracked.values()) {
      if (this.pollingCount >= this.config.officialPollConcurrency) break;
      if (entry.inFlight || entry.nextPollAt > now) continue;
      if (entry.sessionExpiresAt <= now || entry.orderExpiresAt + 10 * 60000 <= now) {
        this.tracked.delete(entry.key);
        this.paymentDetails.delete(this.#detailsKey(entry.userId, entry.orderId));
        continue;
      }
      entry.inFlight = true;
      this.pollingCount += 1;
      const operation = this.#pollEntry(entry).finally(() => {
        entry.inFlight = false;
        this.pollingCount -= 1;
      });
      pending.push(operation);
    }
    await Promise.allSettled(pending);
  }

  async #pollEntry(entry) {
    try {
      const raw = await this.sub2api.verifyPaymentOrder(entry.token, entry.outTradeNo, entry.client);
      const order = normalizeRemoteOrder(raw, entry.userId, this.config.officialAlipayInstanceIds);
      if (order.id !== entry.orderId || order.outTradeNo !== entry.outTradeNo) {
        throw invalidRemoteResponse('Sub2API 主动查询返回了不匹配的支付订单');
      }
      entry.failures = 0;
      if (ACTIVE_REMOTE_STATUSES.has(order.status)) {
        entry.nextPollAt = this.clock().getTime() + this.config.officialPollSeconds * 1000;
      } else {
        this.tracked.delete(entry.key);
        this.paymentDetails.delete(this.#detailsKey(entry.userId, entry.orderId));
      }
    } catch (error) {
      if (['SUB2API_AUTH_FAILED', 'SUB2API_SESSION_BINDING_MISMATCH'].includes(error?.code)) {
        this.tracked.delete(entry.key);
        this.paymentDetails.delete(this.#detailsKey(entry.userId, entry.orderId));
        return;
      }
      entry.failures += 1;
      const backoffSeconds = Math.min(300, this.config.officialPollSeconds * (2 ** Math.min(entry.failures, 6)));
      entry.nextPollAt = this.clock().getTime() + backoffSeconds * 1000;
    }
  }
}

module.exports = {
  OfficialPaymentService,
  normalizeRemoteOrder,
  paymentStatus,
  publicOrder
};
