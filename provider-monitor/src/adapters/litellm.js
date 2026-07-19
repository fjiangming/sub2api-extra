const { ProviderAdapter, joinUrl, toFiniteNumber, toIsoDate, extractItems } = require('./base');

class LiteLlmAdapter extends ProviderAdapter {
  capabilities() {
    return {
      ...super.capabilities(),
      accountBalance: true,
      listKeys: true,
      keyQuota: true,
      listGroups: true,
      keyGroup: true,
      usageHistory: true,
      priceCatalog: true
    };
  }

  headers() {
    return {
      Accept: 'application/json',
      Authorization: `Bearer ${this.credentials.masterKey || this.credentials.apiKey}`
    };
  }

  async getAccount() {
    return {
      remoteId: this.connection.account_dedupe_key || this.connection.id,
      displayName: this.connection.name,
      userGroup: null,
      status: 'active',
      metadata: { budgetSemantics: true }
    };
  }

  async getGlobalSpend() {
    if (this.globalSpend) return this.globalSpend;
    const response = await this.http.requestJson(
      joinUrl(this.connection.base_url, '/global/spend'),
      { headers: this.headers(), retries: 1 }
    );
    this.globalSpend = response.data || {};
    return this.globalSpend;
  }

  async getAccountBalances(account) {
    const data = await this.getGlobalSpend();
    const spend = toFiniteNumber(data.spend, 0);
    const maxBudget = toFiniteNumber(data.max_budget);
    const unlimited = maxBudget == null || maxBudget <= 0;
    return [{
      scope: 'account',
      remoteSubjectId: account?.remoteId || this.connection.id,
      currency: 'USD',
      available: unlimited ? null : Math.max(0, maxBudget - spend),
      total: unlimited ? null : maxBudget,
      used: spend,
      granted: null,
      toppedUp: null,
      frozen: null,
      unlimited,
      sourceField: 'max_budget - spend',
      raw: this.safeRaw(data)
    }];
  }

  async listGroups() {
    const response = await this.http.requestJson(
      joinUrl(this.connection.base_url, '/team/list'),
      { headers: this.headers() }
    );
    const { items } = extractItems(response.data);
    const teams = items.length ? items : Array.isArray(response.data) ? response.data : [];
    return teams.map((team) => ({
      remoteId: String(team.team_id || team.id || team.team_alias),
      type: 'team',
      name: team.team_alias || team.team_id || team.id,
      ratio: null,
      status: team.blocked ? 'disabled' : 'active',
      metadata: this.safeRaw({
        max_budget: team.max_budget,
        spend: team.spend,
        budget_duration: team.budget_duration,
        budget_reset_at: team.budget_reset_at
      })
    }));
  }

  async listKeys() {
    const keys = [];
    const pageSize = 100;
    for (let page = 1; page <= 100; page += 1) {
      const response = await this.http.requestJson(
        joinUrl(
          this.connection.base_url,
          `/key/list?return_full_object=true&page=${page}&size=${pageSize}`
        ),
        { headers: this.headers() }
      );
      const pageKeys = Array.isArray(response.data?.keys) ? response.data.keys : [];
      keys.push(...pageKeys);
      const total = toFiniteNumber(response.data?.total_count);
      if (pageKeys.length === 0 || (total != null && keys.length >= total) || pageKeys.length < pageSize) {
        break;
      }
    }
    return keys.map((key, index) => {
      const maxBudget = toFiniteNumber(key.max_budget);
      const spend = toFiniteNumber(key.spend, 0);
      const unlimited = maxBudget == null || maxBudget <= 0;
      const expiresAt = toIsoDate(key.expires);
      return {
        remoteId: String(key.token || key.key_alias || key.key_name || index),
        name: key.key_alias || key.key_name || `LiteLLM Key ${index + 1}`,
        maskedKey: key.token || '',
        status: key.blocked
          ? 'disabled'
          : expiresAt && expiresAt < new Date().toISOString()
            ? 'expired'
            : 'enabled',
        primaryGroupRef: key.team_id ? String(key.team_id) : null,
        backupGroupRef: null,
        additionalGroupRefs: [],
        quota: {
          currency: 'USD',
          limit: maxBudget,
          used: spend,
          remaining: unlimited ? null : Math.max(0, maxBudget - spend),
          unlimited,
          resetAt: toIsoDate(key.budget_reset_at),
          resetInterval: key.budget_duration || null
        },
        expiresAt,
        lastUsedAt: toIsoDate(key.last_active),
        metadata: this.safeRaw({
          models: key.models,
          user_id: key.user_id,
          team_id: key.team_id,
          tpm_limit: key.tpm_limit,
          rpm_limit: key.rpm_limit
        })
      };
    });
  }

  async getUsage() {
    const data = await this.getGlobalSpend();
    return [{
      scope: 'account',
      remoteSubjectId: this.connection.account_dedupe_key || this.connection.id,
      currency: 'USD',
      cost: toFiniteNumber(data.spend, 0),
      requests: null,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      model: null,
      period: 'cumulative',
      raw: this.safeRaw(data)
    }];
  }

  async getPriceCatalog() {
    const response = await this.http.requestJson(
      joinUrl(this.connection.base_url, '/model/info'),
      { headers: this.headers(), retries: 1 }
    );
    const rows = Array.isArray(response.data?.data)
      ? response.data.data
      : Array.isArray(response.data)
        ? response.data
        : [];
    const models = [];
    const prices = [];
    for (const row of rows) {
      const modelId = row.model_name || row.model_info?.id || row.litellm_params?.model;
      if (!modelId) continue;
      const info = { ...(row.model_info || {}), ...(row.litellm_params || {}) };
      models.push({
        remoteId: String(modelId),
        name: String(modelId),
        vendor: info.litellm_provider || null,
        contextLength: toFiniteNumber(info.max_input_tokens ?? info.max_tokens),
        capabilities: this.safeRaw({ mode: info.mode, supports_function_calling: info.supports_function_calling }),
        metadata: this.safeRaw(row)
      });
      prices.push({
        modelId: String(modelId),
        groupRef: row.model_group || null,
        currency: 'USD',
        billingMode: 'token',
        inputPerMillion: toFiniteNumber(info.input_cost_per_token) == null
          ? null
          : toFiniteNumber(info.input_cost_per_token) * 1000000,
        outputPerMillion: toFiniteNumber(info.output_cost_per_token) == null
          ? null
          : toFiniteNumber(info.output_cost_per_token) * 1000000,
        cacheReadPerMillion: toFiniteNumber(info.cache_read_input_token_cost) == null
          ? null
          : toFiniteNumber(info.cache_read_input_token_cost) * 1000000,
        cacheWritePerMillion: toFiniteNumber(info.cache_creation_input_token_cost) == null
          ? null
          : toFiniteNumber(info.cache_creation_input_token_cost) * 1000000,
        requestPrice: toFiniteNumber(info.input_cost_per_request),
        imagePrice: toFiniteNumber(info.cost_per_image),
        audioPrice: toFiniteNumber(info.input_cost_per_audio_token),
        raw: this.safeRaw(info)
      });
    }
    return { models, prices };
  }
}

module.exports = {
  LiteLlmAdapter
};
