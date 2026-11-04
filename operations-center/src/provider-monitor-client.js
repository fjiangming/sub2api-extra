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

  async getDailyCosts(query, accessToken = null) {
    const read = await this.createDailyCostsReader(accessToken);
    return read(query);
  }

  async getFinancialBalances(accessToken = null) {
    if (!this.baseUrl) throw new AppError('PROVIDER_MONITOR_NOT_CONFIGURED', '未配置供应商监控服务地址', { status: 503 });
    if (this.integrationToken) return this.#request('/api/integrations/financial-balances', {
      headers: { authorization: `Bearer ${this.integrationToken}` }
    });
    if (!accessToken) throw new AppError('PROVIDER_MONITOR_AUTH_NOT_CONFIGURED', '余额核对需要管理员 SSO 或服务间 Token', { status: 409 });
    const session = await this.#request('/api/auth/sso', { method: 'POST', headers: { authorization: `Bearer ${accessToken}` }, body: '{}' });
    if (!session?.sessionToken) throw new AppError('PROVIDER_MONITOR_INVALID_RESPONSE', '供应商监控未返回有效会话', { status: 502 });
    return this.#request('/api/financial-balances', { headers: { authorization: `Session ${session.sessionToken}` } });
  }

  async createDailyCostsReader(accessToken = null, { signal } = {}) {
    if (!this.baseUrl) throw new AppError('PROVIDER_MONITOR_NOT_CONFIGURED', '未配置供应商监控服务地址', { status: 503 });
    if (this.integrationToken) {
      return (query, options = {}) => this.#request(`/api/integrations/daily-costs?${new URLSearchParams(query)}`, {
        signal: options.signal,
        headers: { authorization: `Bearer ${this.integrationToken}` }
      });
    }
    if (!accessToken) throw new AppError('PROVIDER_MONITOR_AUTH_NOT_CONFIGURED', '供应商消费需要管理员 SSO 或服务间 Token', { status: 409 });
    const session = await this.#request('/api/auth/sso', {
      method: 'POST', headers: { authorization: `Bearer ${accessToken}` }, body: '{}', signal
    });
    if (!session?.sessionToken) throw new AppError('PROVIDER_MONITOR_INVALID_RESPONSE', '供应商监控未返回有效会话', { status: 502 });
    return (query, options = {}) => this.#request(`/api/daily-costs?${new URLSearchParams(query)}`, {
      signal: options.signal,
      headers: { authorization: `Session ${session.sessionToken}` }
    });
  }

  async getLatencySamples(query, accessToken = null) {
    if (!this.baseUrl) throw new AppError('PROVIDER_MONITOR_NOT_CONFIGURED', '未配置供应商监控服务地址', { status: 503 });
    const search = new URLSearchParams(query);
    if (this.integrationToken) {
      return this.#request(`/api/integrations/latency-samples?${search}`, {
        headers: { authorization: `Bearer ${this.integrationToken}` }
      });
    }
    if (!accessToken) throw new AppError('PROVIDER_MONITOR_AUTH_NOT_CONFIGURED', '上游核对需要管理员 SSO 或服务间 Token', { status: 409 });
    const session = await this.#request('/api/auth/sso', {
      method: 'POST', headers: { authorization: `Bearer ${accessToken}` }, body: '{}'
    });
    if (!session?.sessionToken) throw new AppError('PROVIDER_MONITOR_INVALID_RESPONSE', '供应商监控未返回有效会话', { status: 502 });
    return this.#request(`/api/latency-samples?${search}`, {
      headers: { authorization: `Session ${session.sessionToken}` }
    });
  }

  async getRequestErrorMappings(query, accessToken = null) {
    if (!this.baseUrl) throw new AppError('PROVIDER_MONITOR_NOT_CONFIGURED', '未配置供应商监控服务地址', { status: 503 });
    const search = new URLSearchParams(query);
    if (this.integrationToken) return this.#request(`/api/integrations/request-error-mappings?${search}`, {
      headers: { authorization: `Bearer ${this.integrationToken}` }
    });
    if (!accessToken) throw new AppError('PROVIDER_MONITOR_AUTH_NOT_CONFIGURED', '供应商映射需要管理员 SSO 或服务间 Token', { status: 409 });
    const session = await this.#request('/api/auth/sso', { method: 'POST', headers: { authorization: `Bearer ${accessToken}` }, body: '{}' });
    if (!session?.sessionToken) throw new AppError('PROVIDER_MONITOR_INVALID_RESPONSE', '供应商监控未返回有效会话', { status: 502 });
    return this.#request(`/api/request-error-mappings?${search}`, { headers: { authorization: `Session ${session.sessionToken}` } });
  }

  async refreshBillingSamples(query, accessToken = null) {
    if (!this.baseUrl) throw new AppError('PROVIDER_MONITOR_NOT_CONFIGURED', '未配置供应商监控服务地址', { status: 503 });
    if (this.integrationToken) {
      return this.#request('/api/integrations/billing-samples/refresh', { method: 'POST',
        headers: { authorization: `Bearer ${this.integrationToken}` }, body: JSON.stringify(query) });
    }
    if (!accessToken) throw new AppError('PROVIDER_MONITOR_AUTH_NOT_CONFIGURED', '上游核对需要管理员 SSO 或服务间 Token', { status: 409 });
    const session = await this.#request('/api/auth/sso', {
      method: 'POST', headers: { authorization: `Bearer ${accessToken}` }, body: '{}'
    });
    if (!session?.sessionToken) throw new AppError('PROVIDER_MONITOR_INVALID_RESPONSE', '供应商监控未返回有效会话', { status: 502 });
    return this.#request('/api/billing-samples/refresh', { method: 'POST',
      headers: { authorization: `Session ${session.sessionToken}`, 'x-csrf-token': session.csrfToken || '' }, body: JSON.stringify(query) });
  }

  async #request(endpoint, options = {}) {
    const controller = new AbortController();
    let rejectDeadline;
    const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
    const abort = () => {
      controller.abort();
      rejectDeadline(new AppError('PROVIDER_MONITOR_TIMEOUT', '供应商监控请求超时', { status: 504 }));
    };
    const timeout = setTimeout(abort, this.timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      if (options.signal?.aborted) abort();
      const request = (async () => {
        if (controller.signal.aborted) throw new AppError('PROVIDER_MONITOR_TIMEOUT', '供应商监控请求超时', { status: 504 });
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
      })();
      return await Promise.race([request, deadline]);
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error.name === 'AbortError') {
        throw new AppError('PROVIDER_MONITOR_TIMEOUT', '供应商监控请求超时', { status: 504 });
      }
      throw new AppError('PROVIDER_MONITOR_UNAVAILABLE', '无法连接供应商监控服务', { status: 503 });
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
    }
  }
}

module.exports = { ProviderMonitorClient, normalizeProvider };
