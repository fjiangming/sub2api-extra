'use strict';

const net = require('node:net');
const { AppError } = require('./errors');

async function requestJson(url, options = {}, timeout = 10000, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetchImpl(url, { ...options, redirect: 'error', signal: controller.signal });
    const reader = response.body?.getReader();
    const chunks = [];
    let size = 0;
    if (!reader) throw new Error();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 256 * 1024) { await reader.cancel(); throw new Error(); }
      chunks.push(Buffer.from(value));
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!response.ok || payload?.success === false || (payload?.code != null && ![0, 200].includes(Number(payload.code)))) {
      throw new AppError('UPSTREAM_REJECTED', '主站服务暂不可用', [401, 403].includes(response.status) ? response.status : 503);
    }
    return Object.hasOwn(payload || {}, 'data') ? payload.data : payload;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('UPSTREAM_UNAVAILABLE', '暂时无法连接主站服务，请稍后重试', 503);
  } finally { clearTimeout(timer); }
}

class CoreClient {
  constructor(config, fetchImpl = fetch) { this.config = config; this.fetch = fetchImpl; }

  async me(token, context) {
    const headers = { authorization: `Bearer ${token}`, accept: 'application/json', 'user-agent': context.userAgent };
    if (this.config.forwardFingerprint && net.isIP(context.ip)) {
      headers['x-forwarded-for'] = context.ip;
      headers['x-real-ip'] = context.ip;
    }
    const data = await requestJson(`${this.config.sub2apiBaseUrl}/api/v1/auth/me`, { headers }, this.config.timeoutMs, this.fetch);
    const user = data?.user || data?.profile || data;
    const id = String(user?.id ?? '');
    if (!/^[1-9]\d{0,14}$/.test(id) || !Number.isSafeInteger(Number(id))) throw new AppError('INVALID_IDENTITY', '主站身份信息无效', 502);
    if (user.status !== 'active') throw new AppError('ACCOUNT_UNAVAILABLE', '当前账号不可用', 403);
    return { id, email: String(user.email || '').slice(0, 320), name: String(user.username || user.email || `用户 ${id}`).slice(0, 320), role: user.role === 'admin' ? 'admin' : 'user' };
  }

  credit(row) {
    if (!['balance', 'affiliate_balance'].includes(row.credit_type)) throw new AppError('CREDIT_TYPE_INVALID', '奖励入账类型无效', 502);
    return requestJson(`${this.config.sub2apiBaseUrl}/api/v1/admin/redeem-codes/create-and-redeem`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': this.config.adminKey,
        'idempotency-key': `activity-${row.id}-${row.attempts}` },
      body: JSON.stringify({ code: row.credit_code, type: row.credit_type, value: row.amount_minor / 100,
        user_id: Number(row.user_id), notes: `活动奖励; activity=recharge-lottery; reward=${row.id}; batch=${row.batch_id}` })
    }, this.config.timeoutMs, this.fetch);
  }
}

module.exports = { CoreClient, requestJson };
