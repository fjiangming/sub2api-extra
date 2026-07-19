const { ProviderAdapter, joinUrl, toFiniteNumber, toIsoDate } = require('./base');

class OpenRouterAdapter extends ProviderAdapter {
  isManagement() {
    return this.connection.auth_mode === 'management_key' || Boolean(this.credentials.managementKey);
  }

  key() {
    return this.credentials.managementKey || this.credentials.apiKey;
  }

  headers() {
    return {
      Accept: 'application/json',
      Authorization: `Bearer ${this.key()}`
    };
  }

  capabilities() {
    return {
      ...super.capabilities(),
      accountBalance: this.isManagement(),
      listKeys: true,
      keyQuota: true,
      listGroups: false,
      keyGroup: false,
      priceCatalog: true
    };
  }

  async getCurrentKey() {
    const response = await this.http.requestJson(
      joinUrl(this.connection.base_url || 'https://openrouter.ai', '/api/v1/key'),
      { headers: this.headers() }
    );
    return response.data?.data || response.data;
  }

  async getAccount() {
    const key = await this.getCurrentKey();
    return {
      remoteId:
        this.connection.account_dedupe_key ||
        key.workspace_id ||
        key.creator_user_id ||
        this.connection.id,
      displayName: key.workspace_id || this.connection.name,
      userGroup: null,
      status: key.disabled ? 'disabled' : 'active',
      metadata: {
        workspaceId: key.workspace_id || null,
        isManagementKey: key.is_management_key ?? this.isManagement()
      }
    };
  }

  async getAccountBalances(account) {
    if (!this.isManagement()) return [];
    const response = await this.http.requestJson(
      joinUrl(this.connection.base_url || 'https://openrouter.ai', '/api/v1/credits'),
      { headers: this.headers() }
    );
    const data = response.data?.data || response.data;
    const total = toFiniteNumber(data.total_credits, 0);
    const used = toFiniteNumber(data.total_usage, 0);
    return [
      {
        scope: 'account',
        remoteSubjectId: account?.remoteId || this.connection.id,
        currency: 'USD',
        available: total - used,
        total,
        used,
        granted: null,
        toppedUp: total,
        frozen: null,
        unlimited: false,
        sourceField: 'data.total_credits - data.total_usage',
        raw: this.safeRaw(data)
      }
    ];
  }

  normalizeKey(key, index = 0) {
    const unlimited = key.limit == null;
    return {
      remoteId: String(key.hash || key.id || key.label || index),
      name: key.name || key.label || `OpenRouter Key ${index + 1}`,
      maskedKey: key.label || '',
      status: key.disabled ? 'disabled' : 'enabled',
      primaryGroupRef: null,
      backupGroupRef: null,
      additionalGroupRefs: [],
      quota: {
        currency: 'USD',
        limit: toFiniteNumber(key.limit),
        used: toFiniteNumber(key.usage),
        remaining: toFiniteNumber(key.limit_remaining),
        unlimited,
        resetAt: null,
        resetInterval: key.limit_reset || null
      },
      expiresAt: toIsoDate(key.expires_at),
      lastUsedAt: null,
      metadata: this.safeRaw({
        workspace_id: key.workspace_id,
        usage_daily: key.usage_daily,
        usage_weekly: key.usage_weekly,
        usage_monthly: key.usage_monthly,
        byok_usage: key.byok_usage,
        is_free_tier: key.is_free_tier
      })
    };
  }

  async listKeys() {
    if (!this.isManagement()) {
      return [this.normalizeKey(await this.getCurrentKey())];
    }
    const response = await this.http.requestJson(
      joinUrl(this.connection.base_url || 'https://openrouter.ai', '/api/v1/keys'),
      { headers: this.headers() }
    );
    const keys = response.data?.data || [];
    return (Array.isArray(keys) ? keys : []).map((key, index) =>
      this.normalizeKey(key, index)
    );
  }

  async getPriceCatalog() {
    const response = await this.http.requestJson(
      joinUrl(this.connection.base_url || 'https://openrouter.ai', '/api/v1/models'),
      { headers: this.headers(), retries: 1 }
    );
    const rows = Array.isArray(response.data?.data) ? response.data.data : [];
    return {
      models: rows.map((model) => ({
        remoteId: model.id,
        name: model.name || model.id,
        vendor: String(model.id || '').split('/')[0] || null,
        contextLength: toFiniteNumber(model.context_length),
        capabilities: this.safeRaw(model.architecture || {}),
        metadata: this.safeRaw({ description: model.description, top_provider: model.top_provider })
      })),
      prices: rows.map((model) => ({
        modelId: model.id,
        groupRef: model.top_provider?.name || null,
        currency: 'USD',
        billingMode: 'token',
        inputPerMillion: toFiniteNumber(model.pricing?.prompt) == null
          ? null
          : toFiniteNumber(model.pricing.prompt) * 1000000,
        outputPerMillion: toFiniteNumber(model.pricing?.completion) == null
          ? null
          : toFiniteNumber(model.pricing.completion) * 1000000,
        cacheReadPerMillion: toFiniteNumber(model.pricing?.input_cache_read) == null
          ? null
          : toFiniteNumber(model.pricing.input_cache_read) * 1000000,
        cacheWritePerMillion: toFiniteNumber(model.pricing?.input_cache_write) == null
          ? null
          : toFiniteNumber(model.pricing.input_cache_write) * 1000000,
        requestPrice: toFiniteNumber(model.pricing?.request),
        imagePrice: toFiniteNumber(model.pricing?.image),
        audioPrice: toFiniteNumber(model.pricing?.audio),
        raw: this.safeRaw(model.pricing || {})
      }))
    };
  }
}

module.exports = {
  OpenRouterAdapter
};
