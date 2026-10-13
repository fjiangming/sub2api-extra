'use strict';

const net = require('node:net');
const { AppError } = require('./errors');
const MAX_RESPONSE_BYTES = 256 * 1024;

async function readJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new AppError('AUTH_UPSTREAM_INVALID', '身份服务返回了无效响应', 502);
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new AppError('AUTH_UPSTREAM_INVALID', '身份服务返回内容超出限制', 502);
      }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof AppError || error.name === 'AbortError') throw error;
    throw new AppError('AUTH_UPSTREAM_INVALID', '身份服务返回了无效响应', 502);
  }
}

class Sub2ApiClient {
  constructor(config, { fetchImpl = globalThis.fetch } = {}) { this.config = config; this.fetch = fetchImpl; }

  async me(token, context) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.upstreamTimeoutMs);
    const headers = { accept: 'application/json', authorization: `Bearer ${token}` };
    if (context.userAgent) headers['user-agent'] = context.userAgent;
    if (this.config.forwardClientFingerprint && net.isIP(context.ip)) {
      headers['x-forwarded-for'] = context.ip;
      headers['x-real-ip'] = context.ip;
    }
    try {
      const response = await this.fetch(`${this.config.sub2apiBaseUrl}/api/v1/auth/me`, {
        headers, redirect: 'error', signal: controller.signal
      });
      const payload = await readJson(response);
      const remoteCode = String(payload?.reason || payload?.error?.code || payload?.code || '');
      if (remoteCode === 'SESSION_BINDING_MISMATCH') {
        throw new AppError('SESSION_BINDING_MISMATCH', '登录环境验证失败，请重新从主站打开排行', 401);
      }
      if (!response.ok || payload?.success === false || (payload?.code != null && ![0, 200].includes(Number(payload.code)))) {
        throw new AppError(response.status >= 500 ? 'AUTH_UPSTREAM_UNAVAILABLE' : 'AUTH_FAILED',
          response.status >= 500 ? '身份服务暂不可用，请稍后重试' : '登录状态已失效，请重新从主站打开排行', response.status >= 500 ? 503 : 401);
      }
      const data = Object.hasOwn(payload || {}, 'data') ? payload.data : payload;
      const user = data?.user || data?.profile || data;
      const sourceId = user?.id ?? user?.user_id;
      const id = String(sourceId ?? '');
      if (!/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n ||
          (typeof sourceId === 'number' && !Number.isSafeInteger(sourceId))) {
        throw new AppError('AUTH_UPSTREAM_INVALID', '身份服务返回的账号信息无效', 502);
      }
      if (user.status && user.status !== 'active') throw new AppError('ACCOUNT_UNAVAILABLE', '当前账号不可用', 403);
      return { id, email: typeof user.email === 'string' ? user.email : '' };
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error.name === 'AbortError') throw new AppError('AUTH_UPSTREAM_TIMEOUT', '身份验证超时，请稍后重试', 504);
      throw new AppError('AUTH_UPSTREAM_UNAVAILABLE', '身份服务暂不可用，请稍后重试', 503);
    } finally { clearTimeout(timer); }
  }
}

module.exports = { Sub2ApiClient };
