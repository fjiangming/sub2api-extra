'use strict';

const { AppError } = require('./errors');

function unwrap(payload) {
  if (payload?.success === false || (payload?.code != null && ![0, 200].includes(Number(payload.code)))) {
    throw new AppError('SUB2API_API_ERROR', payload?.message || payload?.error?.message || 'Sub2API 请求失败', {
      status: 502,
      details: { upstreamCode: payload?.code || payload?.error?.code || null }
    });
  }
  return Object.prototype.hasOwnProperty.call(payload || {}, 'data') ? payload.data : payload;
}

class Sub2ApiClient {
  constructor(config, fetchImpl = globalThis.fetch) {
    this.config = config;
    this.fetch = fetchImpl;
    this.token = config.sub2apiAdminToken;
    this.tokenExpiresAt = this.token ? Number.POSITIVE_INFINITY : 0;
    this.loginPromise = null;
  }

  configured() {
    return Boolean(this.config.sub2apiBaseUrl && (this.token || (
      this.config.sub2apiAdminEmail && this.config.sub2apiAdminPassword
    )));
  }

  async login() {
    if (this.token && this.tokenExpiresAt > Date.now() + 30000) return this.token;
    if (!this.config.sub2apiBaseUrl || !this.config.sub2apiAdminEmail || !this.config.sub2apiAdminPassword) {
      throw new AppError('SUB2API_AUTH_NOT_CONFIGURED', '未配置 Sub2API 管理员凭据或令牌', { status: 503 });
    }
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = (async () => {
      const response = await this.raw('/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: this.config.sub2apiAdminEmail,
          password: this.config.sub2apiAdminPassword
        })
      }, false);
      const data = unwrap(response);
      if (data?.requires_2fa || data?.requires2fa) {
        throw new AppError('SUB2API_2FA_REQUIRED', '该管理员启用了 2FA，请配置有效的 SUB2API_ADMIN_TOKEN', { status: 409 });
      }
      const token = data?.access_token || data?.accessToken || data?.token;
      if (!token) throw new AppError('SUB2API_TOKEN_MISSING', 'Sub2API 登录响应没有访问令牌', { status: 502 });
      this.token = token;
      const expiresIn = Number(data?.expires_in || data?.expiresIn || 900);
      this.tokenExpiresAt = Date.now() + Math.max(60, expiresIn) * 1000;
      return token;
    })();
    try {
      return await this.loginPromise;
    } finally {
      this.loginPromise = null;
    }
  }

  async raw(path, options = {}, authenticated = true) {
    if (!this.config.sub2apiBaseUrl) {
      throw new AppError('SUB2API_URL_NOT_CONFIGURED', '未配置 SUB2API_BASE_URL', { status: 503 });
    }
    const token = authenticated ? await this.login() : null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.sub2apiRequestTimeoutMs);
    try {
      const response = await this.fetch(`${this.config.sub2apiBaseUrl}${path}`, {
        ...options,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(options.headers || {})
        },
        signal: controller.signal
      });
      const text = await response.text();
      let payload = {};
      try { payload = text ? JSON.parse(text) : {}; } catch { payload = { message: text }; }
      if (!response.ok) {
        if (response.status === 401 && authenticated && this.config.sub2apiAdminToken == null) {
          this.token = null;
          this.tokenExpiresAt = 0;
        }
        throw new AppError('SUB2API_REQUEST_FAILED', payload?.message || payload?.error?.message || `Sub2API 返回 ${response.status}`, {
          status: response.status === 401 || response.status === 403 ? 409 : 502,
          details: { upstreamStatus: response.status, upstreamCode: payload?.code || payload?.error?.code || null }
        });
      }
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new AppError('SUB2API_TIMEOUT', 'Sub2API 请求超时', { status: 504 });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async getVersion() {
    return unwrap(await this.raw('/api/v1/admin/system/version'));
  }

  async listBackups() {
    const data = unwrap(await this.raw('/api/v1/admin/backups'));
    return Array.isArray(data) ? data : (data?.items || []);
  }

  async startBackup() {
    return unwrap(await this.raw('/api/v1/admin/backups', {
      method: 'POST',
      body: JSON.stringify({ expire_days: 14 })
    }));
  }
}

module.exports = { Sub2ApiClient, unwrap };
