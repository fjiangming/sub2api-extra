'use strict';

const net = require('net');
const { AppError } = require('./errors');

const MAX_RESPONSE_BYTES = 1024 * 1024;

function unwrap(payload) {
  if (payload?.code != null && ![0, 200].includes(Number(payload.code))) {
    throw new AppError('SUB2API_REQUEST_REJECTED', 'Sub2API 拒绝了请求', {
      status: 502,
      details: { remoteCode: payload.reason || String(payload.code) }
    });
  }
  if (payload?.success === false) {
    throw new AppError('SUB2API_REQUEST_REJECTED', 'Sub2API 拒绝了请求', { status: 502 });
  }
  return Object.prototype.hasOwnProperty.call(payload || {}, 'data') ? payload.data : payload;
}

async function readJsonLimited(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new AppError('SUB2API_RESPONSE_TOO_LARGE', 'Sub2API 返回内容超出限制', { status: 502 });
  }
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new AppError('SUB2API_RESPONSE_TOO_LARGE', 'Sub2API 返回内容超出限制', { status: 502 });
    }
    chunks.push(Buffer.from(value));
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AppError('SUB2API_RESPONSE_INVALID', 'Sub2API 返回了无效响应', { status: 502 });
  }
}

function remoteFailure(payload, status) {
  const remoteCode = String(payload?.reason || payload?.error?.code || payload?.code || '');
  if (remoteCode === 'SESSION_BINDING_MISMATCH') {
    return new AppError('SUB2API_SESSION_BINDING_MISMATCH', '登录会话的网络环境与 Sub2API 不一致，请重新登录', {
      status: 401,
      details: { remoteCode }
    });
  }
  const authStatus = status === 401 || status === 403;
  return new AppError(authStatus ? 'SUB2API_AUTH_FAILED' : 'SUB2API_REQUEST_FAILED',
    authStatus ? 'Sub2API 身份验证失败' : 'Sub2API 请求失败', {
      status: authStatus ? status : 502,
      details: { remoteStatus: status, remoteCode: remoteCode || null }
    });
}

class Sub2ApiClient {
  constructor(config, options = {}) {
    this.config = config;
    this.fetch = options.fetch || globalThis.fetch;
  }

  async request(endpoint, options = {}) {
    const url = new URL(endpoint, `${this.config.sub2apiBaseUrl}/`);
    if (url.origin !== new URL(this.config.sub2apiBaseUrl).origin) {
      throw new AppError('SUB2API_URL_INVALID', 'Sub2API 请求地址无效', { status: 500 });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.sub2apiRequestTimeoutMs);
    const headers = { Accept: 'application/json' };
    if (options.body != null) headers['Content-Type'] = 'application/json';
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (options.apiKey) headers['X-API-Key'] = options.apiKey;
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
    if (options.client?.userAgent) headers['User-Agent'] = options.client.userAgent;
    if (this.config.forwardClientFingerprint && net.isIP(options.client?.ip || '')) {
      headers['X-Forwarded-For'] = options.client.ip;
      headers['X-Real-IP'] = options.client.ip;
    }
    try {
      const response = await this.fetch(url, {
        method: options.method || 'GET',
        headers,
        body: options.body == null ? undefined : JSON.stringify(options.body),
        redirect: 'error',
        signal: controller.signal
      });
      const payload = await readJsonLimited(response);
      if (!response.ok) throw remoteFailure(payload, response.status);
      return unwrap(payload);
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new AppError('SUB2API_TIMEOUT', 'Sub2API 请求超时，结果状态需要人工确认', { status: 504 });
      }
      if (error instanceof AppError) throw error;
      throw new AppError('SUB2API_UNAVAILABLE', '无法连接 Sub2API', { status: 503, cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }

  async getCurrentUser(token, client) {
    const payload = await this.request('/api/v1/auth/me', { token, client });
    return payload?.user || payload?.profile || payload;
  }

  login(input, client) {
    return this.request('/api/v1/auth/login', {
      method: 'POST',
      body: {
        email: input.email,
        password: input.password,
        turnstile_token: input.turnstileToken || '',
        tencent_captcha_ticket: input.tencentCaptchaTicket || '',
        tencent_captcha_randstr: input.tencentCaptchaRandstr || ''
      },
      client
    });
  }

  login2fa(tempToken, totpCode, client) {
    return this.request('/api/v1/auth/login/2fa', {
      method: 'POST',
      body: { temp_token: tempToken, totp_code: totpCode },
      client
    });
  }

  createAndRedeem(token, input, client) {
    return this.request('/api/v1/admin/redeem-codes/create-and-redeem', {
      method: 'POST',
      token,
      idempotencyKey: input.idempotencyKey,
      client,
      body: {
        code: input.code,
        type: 'balance',
        value: input.value,
        user_id: input.userId,
        notes: input.notes
      }
    });
  }

  createAndRedeemWithAdminKey(input) {
    if (!this.config.sub2apiAdminApiKey) {
      throw new AppError('SUB2API_ADMIN_API_KEY_MISSING', '自动入账管理密钥未配置', { status: 503 });
    }
    return this.request('/api/v1/admin/redeem-codes/create-and-redeem', {
      method: 'POST',
      apiKey: this.config.sub2apiAdminApiKey,
      idempotencyKey: input.idempotencyKey,
      body: {
        code: input.code,
        type: 'balance',
        value: input.value,
        user_id: input.userId,
        notes: input.notes
      }
    });
  }

  getPaymentCheckoutInfo(token, client) {
    return this.request('/api/v1/payment/checkout-info', { token, client });
  }

  createPaymentOrder(token, input, client) {
    return this.request('/api/v1/payment/orders', {
      method: 'POST',
      token,
      client,
      body: {
        amount: input.amount,
        payment_type: 'alipay',
        payment_source: 'official_alipay',
        order_type: 'balance',
        return_url: input.returnUrl || '',
        is_mobile: input.isMobile === true
      }
    });
  }

  getPaymentOrders(token, client, options = {}) {
    const query = new URLSearchParams({
      page: String(options.page || 1),
      page_size: String(options.pageSize || 50),
      order_type: 'balance',
      payment_type: 'alipay'
    });
    return this.request(`/api/v1/payment/orders/my?${query}`, { token, client });
  }

  getPaymentOrder(token, orderId, client) {
    return this.request(`/api/v1/payment/orders/${encodeURIComponent(orderId)}`, { token, client });
  }

  verifyPaymentOrder(token, outTradeNo, client) {
    return this.request('/api/v1/payment/orders/verify', {
      method: 'POST',
      token,
      client,
      body: { out_trade_no: outTradeNo }
    });
  }

  cancelPaymentOrder(token, orderId, client) {
    return this.request(`/api/v1/payment/orders/${encodeURIComponent(orderId)}/cancel`, {
      method: 'POST',
      token,
      client,
      body: {}
    });
  }
}

module.exports = { Sub2ApiClient, readJsonLimited, unwrap };
