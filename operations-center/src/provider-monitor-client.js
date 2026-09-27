'use strict';

const { AppError } = require('./errors');

function normalizeProvider(provider) {
  return {
    id: String(provider.id),
    name: String(provider.name || provider.id),
    adapterType: String(provider.adapterType || provider.adapter_type || 'unknown'),
    enabled: Boolean(provider.enabled),
    currency: String(provider.currency || provider.threshold_currency || 'USD').toUpperCase()
  };
}

class ProviderMonitorClient {
  constructor(config, fetchImpl = globalThis.fetch) {
    this.baseUrl = config.providerMonitorBaseUrl;
    this.integrationToken = config.providerMonitorIntegrationToken;
    this.timeoutMs = config.providerMonitorRequestTimeoutMs;
    this.fetch = fetchImpl;
  }

  configured() {
    return Boolean(this.baseUrl);
  }

  async listProviders(accessToken = null) {
    if (!this.baseUrl) {
      throw new AppError('PROVIDER_MONITOR_NOT_CONFIGURED', '未配置供应商监控服务地址', { status: 503 });
    }
    if (this.integrationToken) {
      const payload = await this.#request('/api/integrations/providers', {
        headers: { authorization: `Bearer ${this.integrationToken}` }
      });
      return (payload?.items || []).map(normalizeProvider);
    }
    const token = String(accessToken || '').trim();
    if (!token) {
      throw new AppError(
        'PROVIDER_MONITOR_AUTH_NOT_CONFIGURED',
        '供应商同步需要当前 Sub2API SSO 会话，或配置服务间集成 Token',
        { status: 409 }
      );
    }
    const session = await this.#request('/api/auth/sso', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: '{}'
    });
    if (!session?.sessionToken) {
      throw new AppError('PROVIDER_MONITOR_INVALID_RESPONSE', '供应商监控未返回有效会话', { status: 502 });
    }
    const payload = await this.#request('/api/providers', {
      headers: { authorization: `Session ${session.sessionToken}` }
    });
    return (payload?.items || []).map(normalizeProvider);
  }

  async #request(endpoint, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(`${this.baseUrl}${endpoint}`, {
        ...options,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...(options.headers || {})
        },
        signal: controller.signal
      });
      const text = await response.text();
      let payload = {};
      try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
      if (!response.ok) {
        throw new AppError(
          'PROVIDER_MONITOR_REQUEST_FAILED',
          payload?.error?.message || payload?.message || `供应商监控返回 ${response.status}`,
          {
            status: response.status === 401 || response.status === 403 ? 409 : 502,
            details: {
              upstreamStatus: response.status,
              upstreamCode: payload?.error?.code || payload?.code || null
            }
          }
        );
      }
      return payload;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error.name === 'AbortError') {
        throw new AppError('PROVIDER_MONITOR_TIMEOUT', '供应商监控请求超时', { status: 504 });
      }
      throw new AppError('PROVIDER_MONITOR_UNAVAILABLE', '无法连接供应商监控服务', { status: 503 });
    } finally {
      clearTimeout(timeout);
    }
  }
}

module.exports = { ProviderMonitorClient, normalizeProvider };
