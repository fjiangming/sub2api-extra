'use strict';

const { AppError } = require('./errors');

function unwrap(payload) {
  if (payload?.success === false || (payload?.code != null && ![0, 200].includes(Number(payload.code)))) {
    throw new AppError(
      'SUB2API_API_ERROR',
      payload?.message || payload?.error?.message || 'Sub2API 请求失败',
      {
        status: 502,
        details: { upstreamCode: payload?.code ?? payload?.error?.code ?? null }
      }
    );
  }
  return Object.prototype.hasOwnProperty.call(payload || {}, 'data') ? payload.data : payload;
}

async function readLimited(response, maxBytes) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) {
    throw new AppError('UPSTREAM_RESPONSE_TOO_LARGE', '上游响应超过大小限制', { status: 502 });
  }
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      try { await response.body.cancel(); } catch {}
      throw new AppError('UPSTREAM_RESPONSE_TOO_LARGE', '上游响应超过大小限制', { status: 502 });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

function errorMessage(payload, status) {
  return payload?.error?.message || payload?.message || `Sub2API 返回 HTTP ${status}`;
}

function asItems(payload) {
  const data = unwrap(payload);
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

class Sub2ApiClient {
  constructor(config, fetchImpl = globalThis.fetch) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  async request(path, options = {}) {
    if (!this.config.sub2apiBaseUrl) {
      throw new AppError('SUB2API_NOT_CONFIGURED', '未配置 SUB2API_BASE_URL', { status: 503 });
    }
    const url = new URL(path, `${this.config.sub2apiBaseUrl}/`);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      options.timeoutMs || this.config.requestTimeoutMs
    );
    try {
      const response = await this.fetch(url, {
        method: options.method || 'GET',
        headers: {
          accept: 'application/json',
          ...(options.body == null ? {} : { 'content-type': 'application/json' }),
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          ...(options.headers || {})
        },
        body: options.body == null ? undefined : JSON.stringify(options.body),
        redirect: 'error',
        signal: controller.signal
      });
      const raw = await readLimited(response, options.maxBytes || this.config.maxResponseBytes);
      let payload = null;
      if (raw.length > 0) {
        try {
          payload = JSON.parse(raw.toString('utf8'));
        } catch {
          payload = { message: raw.toString('utf8').slice(0, 1000) };
        }
      }
      if (!response.ok) {
        const status = response.status === 401 ? 401 : response.status === 403 ? 403 : 502;
        throw new AppError(
          response.status === 401 ? 'SUB2API_AUTH_EXPIRED' : 'SUB2API_REQUEST_FAILED',
          errorMessage(payload, response.status),
          {
            status,
            retryable: response.status === 429 || response.status >= 500,
            details: { upstreamStatus: response.status }
          }
        );
      }
      return payload || {};
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error?.name === 'AbortError') {
        throw new AppError('SUB2API_TIMEOUT', 'Sub2API 请求超时', { status: 504, retryable: true });
      }
      throw new AppError('SUB2API_UNAVAILABLE', '无法连接 Sub2API', {
        status: 503,
        retryable: true
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async verifyUser(accessToken) {
    const data = unwrap(await this.request('/api/v1/auth/me', { token: accessToken, timeoutMs: 15000 }));
    const user = data?.user || data?.profile || data || {};
    const id = user.id ?? user.user_id ?? user.sub;
    if (id == null || id === '') {
      throw new AppError('AUTH_INVALID_RESPONSE', 'Sub2API 没有返回有效用户身份', { status: 502 });
    }
    const role = String(user.role || 'user');
    return {
      id: String(id),
      name: String(user.username || user.name || user.email || `用户 ${id}`),
      email: String(user.email || ''),
      role,
      is_admin: user.is_admin === true,
      isAdmin: role.toLowerCase() === 'admin' ||
        role.toLowerCase() === 'root' ||
        user.is_admin === true ||
        user.isAdmin === true
    };
  }

  async listAvailableGroups(accessToken) {
    const groups = asItems(await this.request('/api/v1/groups/available', { token: accessToken }));
    return groups
      .filter((group) => group && group.id != null)
      .map((group) => ({
        ...group,
        id: String(group.id),
        name: String(group.name || `分组 ${group.id}`),
        platform: String(group.platform || '').trim().toLowerCase(),
        status: String(group.status || 'active')
      }));
  }

  async gatewayJson(path, apiKey, body, options = {}) {
    return this.request(path, {
      method: 'POST',
      token: apiKey,
      body,
      timeoutMs: options.timeoutMs || this.config.requestTimeoutMs,
      maxBytes: options.maxBytes || this.config.maxResponseBytes,
      headers: options.headers
    });
  }
}

module.exports = { Sub2ApiClient, asItems, readLimited, unwrap };
