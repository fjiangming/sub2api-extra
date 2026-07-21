const {
  ProviderAdapter,
  joinUrl,
  toFiniteNumber,
  toIsoDate,
  unwrapEnvelope,
  extractItems
} = require('./base');
const { AppError } = require('../errors');

function decodeJwtExpiration(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return payload.exp ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function normalizeGroupRates(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  return payload.rates || payload.group_rates || payload;
}

function resolveGroupRate(rates, groupId, fallback) {
  const entry = rates?.[groupId] ?? rates?.[String(groupId)];
  return toFiniteNumber(entry?.rate_multiplier ?? entry?.ratio ?? entry, fallback);
}

function scaledPrice(value, multiplier, scale = 1) {
  const price = toFiniteNumber(value);
  if (price == null) return null;
  return price * multiplier * scale;
}

function hasPrice(price) {
  return [
    price.inputPerMillion,
    price.outputPerMillion,
    price.cacheReadPerMillion,
    price.cacheWritePerMillion,
    price.requestPrice,
    price.imagePrice,
    price.audioPrice
  ].some((value) => value != null);
}

function usesTokenPair(connection) {
  return ['token_pair', 'bearer'].includes(String(connection?.auth_mode || '').toLowerCase());
}

function translateSub2ApiAuthError(error) {
  const remoteCode = String(error?.details?.remoteCode || '');
  if (remoteCode === 'SESSION_BINDING_MISMATCH') {
    return new AppError(
      'SUB2API_SESSION_BINDING_INCOMPATIBLE',
      'Sub2API session binding must be disabled before OAuth tokens can be used by Provider Monitor',
      { status: 409, details: error.details, cause: error }
    );
  }
  if (remoteCode === 'TURNSTILE_VERIFICATION_FAILED') {
    return new AppError(
      'CAPTCHA_REQUIRED',
      'Sub2API requires Turnstile verification; use an OAuth token pair or disable Turnstile for automated account login',
      { status: 409, details: error.details, cause: error }
    );
  }
  return error;
}

class Sub2ApiAdapter extends ProviderAdapter {
  capabilities() {
    return {
      ...super.capabilities(),
      accountBalance: true,
      listKeys: true,
      keyQuota: true,
      listGroups: true,
      keyGroup: true,
      usageHistory: true,
      priceCatalog: true,
      credentialRefresh: true
    };
  }

  async probe() {
    return {
      adapterType: this.type,
      detectedFamily: 'sub2api',
      version: null,
      capabilities: this.capabilities()
    };
  }

  async updateTokenPair(data) {
    const updated = {
      ...this.credentials,
      accessToken: data.access_token,
      refreshToken: data.refresh_token || this.credentials.refreshToken,
      expiresIn: data.expires_in || 3600,
      tokenExpiresAt:
        Date.now() + Number(data.expires_in || 3600) * 1000
    };
    this.credentials = updated;
    await this.onCredentialsUpdated(updated);
    return updated.accessToken;
  }

  async refreshToken() {
    if (!this.credentials.refreshToken) return null;
    let response;
    try {
      response = await this.http.requestJson(
        joinUrl(this.connection.base_url, '/api/v1/auth/refresh'),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: { refresh_token: this.credentials.refreshToken },
          retries: 0
        }
      );
    } catch (error) {
      throw translateSub2ApiAuthError(error);
    }
    return this.updateTokenPair(unwrapEnvelope(response.data));
  }

  async login() {
    if (usesTokenPair(this.connection)) {
      throw new AppError('AUTH_EXPIRED', 'Sub2API OAuth token-pair credentials are missing or expired', {
        status: 401
      });
    }
    if (!this.credentials.email || !this.credentials.password) {
      throw new AppError('AUTH_EXPIRED', 'Sub2API credentials require a refresh token or email and password', {
        status: 401
      });
    }
    let response;
    try {
      response = await this.http.requestJson(
        joinUrl(this.connection.base_url, '/api/v1/auth/login'),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: {
            email: this.credentials.email,
            password: this.credentials.password
          },
          retries: 0
        }
      );
    } catch (error) {
      throw translateSub2ApiAuthError(error);
    }
    const data = unwrapEnvelope(response.data);
    if (data?.requires_2fa) {
      throw new AppError('MFA_REQUIRED', 'Sub2API requires interactive two-factor authentication', {
        status: 409
      });
    }
    if (!data?.access_token) {
      throw new AppError('SCHEMA_MISMATCH', 'Sub2API login response did not include an access token', {
        status: 502
      });
    }
    return this.updateTokenPair(data);
  }

  async getAccessToken(forceRefresh = false) {
    const token = this.credentials.accessToken;
    const expiry =
      Number(this.credentials.tokenExpiresAt) ||
      (token ? decodeJwtExpiration(token) : null);
    if (!forceRefresh && token && (!expiry || expiry > Date.now() + 60000)) {
      return token;
    }
    if (this.credentials.refreshToken) {
      try {
        return await this.refreshToken();
      } catch (error) {
        if (usesTokenPair(this.connection)) throw error;
        if (error.code !== 'AUTH_FAILED' && error.code !== 'BUSINESS_ERROR') throw error;
      }
    }
    return this.login();
  }

  async authenticatedRequest(endpoint, options = {}) {
    let token = await this.getAccessToken();
    try {
      return await this.http.requestJson(joinUrl(this.connection.base_url, endpoint), {
        ...options,
        headers: {
          ...(options.headers || {}),
          Authorization: `Bearer ${token}`
        }
      });
    } catch (error) {
      const translated = translateSub2ApiAuthError(error);
      if (translated.code !== 'AUTH_FAILED') throw translated;
      token = await this.getAccessToken(true);
      try {
        return await this.http.requestJson(joinUrl(this.connection.base_url, endpoint), {
          ...options,
          retries: 0,
          headers: {
            ...(options.headers || {}),
            Authorization: `Bearer ${token}`
          }
        });
      } catch (retryError) {
        throw translateSub2ApiAuthError(retryError);
      }
    }
  }

  async getProfile() {
    if (this.profile) return this.profile;
    const response = await this.authenticatedRequest('/api/v1/user/profile');
    this.profile = unwrapEnvelope(response.data);
    return this.profile;
  }

  async getAccount() {
    const profile = await this.getProfile();
    return {
      remoteId: String(profile.id ?? profile.email ?? this.connection.id),
      displayName: profile.username || profile.email || this.connection.name,
      userGroup: null,
      status: profile.status || 'active',
      metadata: {
        email: profile.email || null,
        role: profile.role || null,
        allowedGroups: profile.allowed_groups || [],
        totalRecharged: toFiniteNumber(profile.total_recharged)
      }
    };
  }

  async getAccountBalances(account) {
    const profile = await this.getProfile();
    return [
      {
        scope: 'account',
        remoteSubjectId: account?.remoteId || String(profile.id ?? this.connection.id),
        currency: 'USD',
        available: toFiniteNumber(profile.balance, 0),
        total: null,
        used: null,
        granted: null,
        toppedUp: toFiniteNumber(profile.total_recharged),
        frozen: toFiniteNumber(profile.frozen_balance),
        unlimited: false,
        sourceField: 'data.balance',
        raw: this.safeRaw({
          balance: profile.balance,
          frozen_balance: profile.frozen_balance,
          total_recharged: profile.total_recharged
        })
      }
    ];
  }

  async listGroups() {
    const [groupsResponse, ratesResponse] = await Promise.all([
      this.authenticatedRequest('/api/v1/groups/available'),
      this.authenticatedRequest('/api/v1/groups/rates').catch(() => ({ data: { data: {} } }))
    ]);
    const groups = unwrapEnvelope(groupsResponse.data) || [];
    const rates = normalizeGroupRates(unwrapEnvelope(ratesResponse.data, { allowNull: true }));
    return groups.map((group) => {
      const defaultRateMultiplier = toFiniteNumber(group.rate_multiplier, 1);
      const effectiveRateMultiplier = resolveGroupRate(rates, group.id, defaultRateMultiplier);
      return {
        remoteId: String(group.id),
        type: 'key_route_group',
        name: group.name || String(group.id),
        ratio: effectiveRateMultiplier,
        status: group.status || 'active',
        metadata: this.safeRaw({
          ...group,
          default_rate_multiplier: defaultRateMultiplier,
          effective_rate_multiplier: effectiveRateMultiplier,
          personalized_rate: effectiveRateMultiplier !== defaultRateMultiplier
        })
      };
    });
  }

  async listKeys() {
    const result = [];
    const pageSize = 100;
    for (let page = 1; page <= 100; page += 1) {
      const response = await this.authenticatedRequest(
        `/api/v1/keys?page=${page}&page_size=${pageSize}`
      );
      const { items, total } = extractItems(response.data);
      for (const key of items) {
        const limit = toFiniteNumber(key.quota, 0);
        const used = toFiniteNumber(key.quota_used, 0);
        const unlimited = limit === 0;
        result.push({
          remoteId: String(key.id),
          name: key.name || `Key ${key.id}`,
          maskedKey: key.key || '',
          status: key.status || 'unknown',
          primaryGroupRef: key.group_id == null ? null : String(key.group_id),
          backupGroupRef: null,
          additionalGroupRefs: [],
          quota: {
            currency: 'USD',
            limit: unlimited ? null : limit,
            used,
            remaining: unlimited ? null : Math.max(0, limit - used),
            unlimited,
            resetAt: null,
            resetInterval: null
          },
          expiresAt: toIsoDate(key.expires_at),
          lastUsedAt: toIsoDate(key.last_used_at),
          metadata: this.safeRaw({
            ip_whitelist: key.ip_whitelist,
            ip_blacklist: key.ip_blacklist,
            current_concurrency: key.current_concurrency,
            rate_limit_5h: key.rate_limit_5h,
            rate_limit_1d: key.rate_limit_1d,
            rate_limit_7d: key.rate_limit_7d
          })
        });
      }
      if (items.length < pageSize || result.length >= total) break;
    }
    return result;
  }

  async getUsage() {
    const response = await this.authenticatedRequest('/api/v1/usage/stats?period=today');
    const data = unwrapEnvelope(response.data);
    const inputTokens = toFiniteNumber(data.total_input_tokens ?? data.input_tokens, 0);
    const outputTokens = toFiniteNumber(data.total_output_tokens ?? data.output_tokens, 0);
    return [{
      scope: 'account',
      remoteSubjectId: this.connection.remote_user_id || this.connection.id,
      currency: 'USD',
      cost: toFiniteNumber(data.total_cost, 0),
      requests: toFiniteNumber(data.total_requests, 0),
      inputTokens,
      outputTokens,
      totalTokens: toFiniteNumber(data.total_tokens, inputTokens + outputTokens),
      model: null,
      period: 'today',
      raw: this.safeRaw(data)
    }];
  }

  async getPriceCatalog() {
    const groups = await this.listGroups();
    let channels = [];
    let warning = null;

    try {
      const response = await this.authenticatedRequest('/api/v1/channels/available', { retries: 0 });
      const data = unwrapEnvelope(response.data, { allowNull: true });
      if (!Array.isArray(data)) {
        throw new AppError('SCHEMA_MISMATCH', 'Sub2API channel catalog response was not an array', {
          status: 502
        });
      }
      channels = data;
    } catch (error) {
      warning = {
        code: error.code || 'PRICE_CATALOG_UNAVAILABLE',
        message: 'Sub2API did not expose its channel model pricing catalog'
      };
    }

    const groupById = new Map(groups.map((group) => [String(group.remoteId), group]));
    const models = new Map();
    const prices = new Map();

    for (const channel of channels) {
      for (const section of Array.isArray(channel.platforms) ? channel.platforms : []) {
        const platform = section.platform || null;
        const sectionGroups = Array.isArray(section.groups) && section.groups.length > 0
          ? section.groups
          : groups.filter((group) => !platform || group.metadata?.platform === platform);

        for (const model of Array.isArray(section.supported_models) ? section.supported_models : []) {
          const modelId = String(model.name || '').trim();
          if (!modelId) continue;
          if (!models.has(modelId)) {
            models.set(modelId, {
              remoteId: modelId,
              name: modelId,
              vendor: model.platform || platform,
              contextLength: null,
              capabilities: {},
              metadata: this.safeRaw({ platform: model.platform || platform, channel: channel.name })
            });
          }
          if (!model.pricing || typeof model.pricing !== 'object') continue;

          for (const sectionGroup of sectionGroups) {
            const remoteId = String(sectionGroup.id ?? sectionGroup.remoteId ?? '');
            const savedGroup = groupById.get(remoteId);
            const defaultRateMultiplier = toFiniteNumber(
              savedGroup?.metadata?.default_rate_multiplier ?? sectionGroup.rate_multiplier,
              1
            );
            const effectiveRateMultiplier = toFiniteNumber(
              savedGroup?.ratio ?? sectionGroup.effective_rate_multiplier ?? sectionGroup.rate_multiplier,
              defaultRateMultiplier
            );
            const billingMode = String(model.pricing.billing_mode || 'token');
            const imageMultiplier = savedGroup?.metadata?.image_rate_independent
              ? toFiniteNumber(savedGroup.metadata.image_rate_multiplier, effectiveRateMultiplier)
              : effectiveRateMultiplier;
            const multiplier = billingMode === 'image' ? imageMultiplier : effectiveRateMultiplier;
            const groupName = savedGroup?.name || sectionGroup.name || remoteId || 'default';
            const channelName = channel.name || 'channel';
            const price = {
              modelId,
              groupRef: `${remoteId || groupName}@${channelName}`,
              currency: 'USD',
              billingMode,
              inputPerMillion: scaledPrice(
                model.pricing.image_input_price ?? model.pricing.input_price,
                multiplier,
                1000000
              ),
              outputPerMillion: scaledPrice(model.pricing.output_price, multiplier, 1000000),
              cacheReadPerMillion: scaledPrice(model.pricing.cache_read_price, multiplier, 1000000),
              cacheWritePerMillion: scaledPrice(model.pricing.cache_write_price, multiplier, 1000000),
              requestPrice: scaledPrice(model.pricing.per_request_price, multiplier),
              imagePrice: scaledPrice(model.pricing.image_output_price, imageMultiplier),
              audioPrice: null,
              raw: this.safeRaw({
                source: 'sub2api_channels_available',
                channelName,
                platform: model.platform || platform,
                groupRemoteId: remoteId,
                groupName,
                defaultRateMultiplier,
                groupRatio: effectiveRateMultiplier,
                appliedMultiplier: multiplier,
                basePricing: model.pricing
              })
            };
            if (hasPrice(price)) prices.set(`${modelId}\u0000${price.groupRef}`, price);
          }
        }
      }
    }

    if (!warning && channels.length === 0) {
      warning = {
        code: 'PRICE_CATALOG_NOT_EXPOSED',
        message: 'Sub2API channel pricing is disabled; group rates were synchronized instead'
      };
    }

    return {
      models: [...models.values()],
      prices: [...prices.values()],
      groups,
      groupsComplete: true,
      source: channels.length > 0 ? 'sub2api_channels' : 'sub2api_group_rates',
      status: prices.size > 0 ? 'succeeded' : 'partial',
      warning
    };
  }
}

module.exports = {
  Sub2ApiAdapter,
  decodeJwtExpiration,
  translateSub2ApiAuthError,
  usesTokenPair
};
