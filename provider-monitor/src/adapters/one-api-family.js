const {
  ProviderAdapter,
  joinUrl,
  toFiniteNumber,
  toIsoDate,
  unwrapEnvelope,
  extractItems
} = require('./base');
const { AppError } = require('../errors');
const {
  finiteNonnegative,
  finitePositive,
  normalizeDynamicRouteConfig,
  summarizeDynamicRouteObservations
} = require('../services/dynamic-route-rate');

const FAMILY_CONFIG = {
  'new-api': {
    userHeader: 'New-Api-User',
    selfGroups: true,
    tokenGroups: true,
    backupGroup: false,
    pagination: { start: 1, pageParam: 'p', sizeParam: 'page_size', size: 100 }
  },
  'one-api': {
    userHeader: null,
    selfGroups: false,
    tokenGroups: false,
    backupGroup: false,
    pagination: { start: 0, pageParam: 'p', sizeParam: null, size: 10 }
  },
  'one-hub': {
    userHeader: null,
    selfGroups: false,
    tokenGroups: true,
    backupGroup: true,
    pagination: { start: 1, pageParam: 'page', sizeParam: 'size', size: 100 }
  },
  'done-hub': {
    userHeader: null,
    selfGroups: false,
    tokenGroups: true,
    backupGroup: true,
    pagination: { start: 1, pageParam: 'page', sizeParam: 'size', size: 100 }
  },
  veloera: {
    userHeader: 'Veloera-User',
    selfGroups: true,
    tokenGroups: true,
    backupGroup: false,
    pagination: { start: 0, pageParam: 'p', sizeParam: 'size', size: 100 }
  }
};

class OneApiFamilyAdapter extends ProviderAdapter {
  constructor(context) {
    super(context);
    this.family = FAMILY_CONFIG[this.type] || FAMILY_CONFIG['new-api'];
    this.statusInfo = null;
  }

  capabilities() {
    return {
      ...super.capabilities(),
      accountBalance: true,
      listKeys: true,
      keyQuota: true,
      listGroups: this.family.selfGroups || this.family.tokenGroups || this.type === 'one-api',
      keyGroup: this.family.tokenGroups,
      backupGroup: this.family.backupGroup,
      groupsDerivedFromKeys: ['one-hub', 'done-hub'].includes(this.type),
      usageHistory: true,
      priceCatalog: ['new-api', 'veloera'].includes(this.type),
      rechargeQuote: true,
      dynamicRouteRates: this.type === 'new-api',
      checkIn: ['new-api', 'veloera'].includes(this.type)
    };
  }

  headers(apiKey = null) {
    const token = apiKey || this.credentials.systemToken || this.credentials.accessToken;
    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`
    };
    if (this.family.userHeader) {
      headers[this.family.userHeader] =
        this.connection.remote_user_id || this.credentials.userId;
    }
    return headers;
  }

  async probe() {
    const response = await this.http.requestJson(joinUrl(this.connection.base_url, '/api/status'), {
      retries: 1
    });
    const data = unwrapEnvelope(response.data);
    this.statusInfo = data;
    return {
      adapterType: this.type,
      detectedFamily: this.type,
      version: data?.version || null,
      quotaPerUnit: toFiniteNumber(data?.quota_per_unit, 500000),
      quotaDisplayType: data?.quota_display_type || null,
      customCurrencySymbol: data?.custom_currency_symbol || null,
      customCurrencyExchangeRate: toFiniteNumber(data?.custom_currency_exchange_rate),
      capabilities: this.capabilities()
    };
  }

  async ensureStatus() {
    if (!this.statusInfo) {
      try {
        await this.probe();
      } catch {
        this.statusInfo = { quota_per_unit: 500000 };
      }
    }
    return this.statusInfo;
  }

  async getSelf() {
    if (this.selfInfo) return this.selfInfo;
    const response = await this.http.requestJson(joinUrl(this.connection.base_url, '/api/user/self'), {
      headers: this.headers()
    });
    this.selfInfo = unwrapEnvelope(response.data);
    return this.selfInfo;
  }

  async getAccount() {
    const user = await this.getSelf();
    return {
      remoteId: String(user.id ?? this.connection.remote_user_id ?? this.connection.id),
      displayName: user.display_name || user.username || user.email || this.connection.name,
      userGroup: user.group || null,
      status: Number(user.status) === 2 ? 'disabled' : 'active',
      metadata: {
        email: user.email || null,
        requestCount: user.request_count ?? null
      }
    };
  }

  async getAccountBalances(account) {
    const [user, status] = await Promise.all([this.getSelf(), this.ensureStatus()]);
    const divisor = toFiniteNumber(status?.quota_per_unit, 500000) || 500000;
    return [
      {
        scope: 'account',
        remoteSubjectId: account?.remoteId || String(user.id ?? this.connection.id),
        currency: 'USD',
        available: (toFiniteNumber(user.quota, 0) || 0) / divisor,
        used: (toFiniteNumber(user.used_quota, 0) || 0) / divisor,
        total: null,
        granted: null,
        toppedUp: null,
        frozen: null,
        unlimited: false,
        sourceField: 'data.quota',
        raw: this.safeRaw({
          quota: user.quota,
          used_quota: user.used_quota,
          quota_per_unit: divisor
        })
      }
    ];
  }

  async getRechargeQuote() {
    const status = await this.ensureStatus();
    const quotaPerUnit = toFiniteNumber(status?.quota_per_unit, 500000) || 500000;
    const quotaDisplayType = String(status?.quota_display_type || 'USD').toUpperCase();
    const statusPrice = toFiniteNumber(status?.price);
    const paidCurrency = status?.payment_fx_rate_cny_per_usd != null || status?.usd_exchange_rate != null
      ? 'CNY'
      : null;
    const balanceCurrency = quotaDisplayType === 'TOKENS' ? 'USD' : quotaDisplayType;

    try {
      const infoResponse = await this.http.requestJson(
        joinUrl(this.connection.base_url, '/api/user/topup/info'),
        { headers: this.headers(), retries: 0 }
      );
      const info = unwrapEnvelope(infoResponse.data, { allowNull: true }) || {};
      const minimum = Math.max(1, Math.ceil(toFiniteNumber(info.min_topup, 1) || 1));
      const quoteAmount = minimum;
      const amountResponse = await this.http.requestJson(
        joinUrl(this.connection.base_url, '/api/user/amount'),
        {
          method: 'POST',
          headers: { ...this.headers(), 'Content-Type': 'application/json' },
          body: { amount: quoteAmount },
          retries: 0
        }
      );
      const paidAmount = toFiniteNumber(unwrapEnvelope(amountResponse.data));
      const creditedAmount = quotaDisplayType === 'TOKENS'
        ? quoteAmount / quotaPerUnit
        : quoteAmount;
      if (paidAmount != null && paidAmount > 0 && creditedAmount > 0) {
        return {
          available: true,
          multiplier: creditedAmount / paidAmount,
          paidAmount,
          creditedAmount,
          paidCurrency,
          balanceCurrency,
          source: 'provider_quote',
          metadata: this.safeRaw({
            quoteAmount,
            minimumTopUp: minimum,
            quotaDisplayType,
            quotaPerUnit,
            amountDiscount: info.discount?.[quoteAmount] ?? info.discount?.[String(quoteAmount)] ?? null
          })
        };
      }
    } catch (error) {
      if (!(statusPrice != null && statusPrice > 0)) {
        return {
          available: false,
          multiplier: null,
          source: 'provider_quote',
          errorCode: error.code || 'RECHARGE_QUOTE_UNAVAILABLE',
          metadata: { quotaDisplayType }
        };
      }
    }

    if (statusPrice != null && statusPrice > 0) {
      return {
        available: true,
        multiplier: 1 / statusPrice,
        paidAmount: statusPrice,
        creditedAmount: 1,
        paidCurrency,
        balanceCurrency,
        source: 'provider_status_price',
        metadata: this.safeRaw({ quotaDisplayType, quotaPerUnit, price: statusPrice })
      };
    }
    return {
      available: false,
      multiplier: null,
      source: 'provider_quote',
      errorCode: 'RECHARGE_QUOTE_UNAVAILABLE',
      metadata: { quotaDisplayType }
    };
  }

  async listGroups() {
    if (this.family.selfGroups) {
      const response = await this.http.requestJson(
        joinUrl(this.connection.base_url, '/api/user/self/groups'),
        { headers: this.headers(), retries: 1 }
      );
      const data = unwrapEnvelope(response.data);
      if (Array.isArray(data)) {
        return data.map((group) => ({
          remoteId: String(group.id ?? group.name ?? group),
          type: 'key_route_group',
          name: String(group.name ?? group),
          ratio: toFiniteNumber(group.ratio),
          status: 'active',
          metadata: this.safeRaw(group)
        }));
      }
      return Object.entries(data || {}).map(([name, info]) => ({
        remoteId: name,
        type: 'key_route_group',
        name,
        ratio: toFiniteNumber(info?.ratio),
        status: 'active',
        metadata: this.safeRaw(info || {})
      }));
    }

    // One Hub and Done Hub expose token group references to users, while the
    // full group catalog is admin-only. SyncService derives those groups from keys.
    if (this.family.tokenGroups) return [];

    const account = await this.getAccount();
    return account.userGroup
      ? [
          {
            remoteId: account.userGroup,
            type: 'user_group',
            name: account.userGroup,
            ratio: null,
            status: 'active',
            metadata: {}
          }
        ]
      : [];
  }

  async listKeys() {
    const keys = [];
    const pagination = this.family.pagination;
    for (let index = 0; index < 100; index += 1) {
      const page = pagination.start + index;
      const query = new URLSearchParams({ [pagination.pageParam]: String(page) });
      if (pagination.sizeParam) query.set(pagination.sizeParam, String(pagination.size));
      const endpoint = `/api/token/?${query.toString()}`;
      const response = await this.http.requestJson(joinUrl(this.connection.base_url, endpoint), {
        headers: this.headers()
      });
      const { items, total, hasTotal } = extractItems(response.data);
      for (const token of items) {
        const unlimited = Boolean(token.unlimited_quota);
        keys.push({
          remoteId: String(token.id ?? token.hash ?? token.name),
          name: token.name || `Token ${token.id ?? keys.length + 1}`,
          maskedKey: token.key || token.token || '',
          status: normalizeTokenStatus(token),
          primaryGroupRef: this.family.tokenGroups ? token.group || null : null,
          backupGroupRef: this.family.backupGroup ? token.backup_group || null : null,
          additionalGroupRefs: [],
          quota: {
            currency: 'USD',
            limit: unlimited
              ? null
              : toFiniteNumber(token.remain_quota, 0) + toFiniteNumber(token.used_quota, 0),
            used: toFiniteNumber(token.used_quota),
            remaining: unlimited ? null : toFiniteNumber(token.remain_quota, 0),
            unlimited,
            resetAt: null,
            resetInterval: null,
            rawInternalUnits: true
          },
          expiresAt: toIsoDate(token.expired_time),
          lastUsedAt: toIsoDate(token.accessed_time),
          metadata: this.safeRaw({
            model_limits: token.model_limits,
            model_limits_enabled: token.model_limits_enabled,
            allow_ips: token.allow_ips,
            cross_group_retry: token.cross_group_retry
          })
        });
      }
      if (items.length === 0) break;
      if (hasTotal && keys.length >= total) break;
      if (items.length < pagination.size) break;
    }

    const status = await this.ensureStatus();
    const divisor = toFiniteNumber(status?.quota_per_unit, 500000) || 500000;
    return keys.map((key) => {
      if (!key.quota || !key.quota.rawInternalUnits) return key;
      return {
        ...key,
        quota: {
          ...key.quota,
          limit: key.quota.limit == null ? null : key.quota.limit / divisor,
          used: key.quota.used == null ? null : key.quota.used / divisor,
          remaining: key.quota.remaining == null ? null : key.quota.remaining / divisor,
          rawInternalUnits: undefined
        }
      };
    });
  }

  async getUsage() {
    const now = new Date();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const query = new URLSearchParams({
      start_timestamp: String(Math.floor(start.getTime() / 1000)),
      end_timestamp: String(Math.floor(now.getTime() / 1000))
    });
    const response = await this.http.requestJson(
      joinUrl(this.connection.base_url, `/api/log/self/stat?${query.toString()}`),
      { headers: this.headers(), retries: 1 }
    );
    const data = unwrapEnvelope(response.data);
    const status = await this.ensureStatus();
    const divisor = toFiniteNumber(status?.quota_per_unit, 500000) || 500000;
    const rawQuota = toFiniteNumber(data?.quota?.Quota ?? data?.quota, 0);
    return [{
      scope: 'account',
      remoteSubjectId: this.connection.remote_user_id || this.connection.id,
      currency: 'USD',
      cost: rawQuota / divisor,
      requests: null,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      model: null,
      period: 'today',
      raw: this.safeRaw(data)
    }];
  }

  async getDynamicRouteRates(options = {}) {
    const config = normalizeDynamicRouteConfig(options);
    if (this.type !== 'new-api' || !config.enabled) return [];

    const knownKeys = Array.isArray(options.keys) ? options.keys : [];
    const keysById = new Map(knownKeys.map((key) => [String(key.remoteId), key]));
    const keysByName = new Map();
    for (const key of knownKeys) {
      const name = String(key.name || '').trim();
      if (!name) continue;
      if (keysByName.has(name)) keysByName.set(name, null);
      else keysByName.set(name, key);
    }

    const endTimestamp = Math.floor(Date.now() / 1000);
    const startTimestamp = endTimestamp - config.lookbackDays * 86400;
    const pageSize = 100;
    const rows = [];
    for (let page = 1; rows.length < config.maxRecords; page += 1) {
      const query = new URLSearchParams({
        p: String(page),
        page_size: String(pageSize),
        type: '0',
        start_timestamp: String(startTimestamp),
        end_timestamp: String(endTimestamp)
      });
      const response = await this.http.requestJson(
        joinUrl(this.connection.base_url, `/api/log/self?${query.toString()}`),
        { headers: this.headers(), retries: 1 }
      );
      const { items, total, hasTotal } = extractItems(response.data);
      rows.push(...items.slice(0, config.maxRecords - rows.length));
      if (items.length === 0 || (hasTotal && rows.length >= total) || items.length < pageSize) break;
    }

    const observationsByKey = new Map(knownKeys.map((key) => [String(key.remoteId), []]));
    for (const row of rows) {
      let other = row.other || {};
      if (typeof other === 'string') {
        try { other = JSON.parse(other); } catch { other = {}; }
      }
      if (!other || typeof other !== 'object' || Array.isArray(other)) other = {};
      if (other.request_final_status && other.request_final_status !== 'success') continue;
      const modelRatio = finitePositive(row.model_ratio ?? other.model_ratio);
      const groupRatio = finitePositive(row.group_ratio ?? other.group_ratio) ?? 1;
      if (modelRatio == null) continue;

      const tokenId = row.token_id == null ? null : String(row.token_id);
      const tokenName = String(row.token_name || '').trim();
      const knownKey = (tokenId && keysById.get(tokenId)) || keysByName.get(tokenName) || null;
      const remoteKeyId = String(knownKey?.remoteId ?? tokenId ?? tokenName);
      if (!remoteKeyId) continue;
      if (!observationsByKey.has(remoteKeyId)) observationsByKey.set(remoteKeyId, []);
      observationsByKey.get(remoteKeyId).push({
        keyName: knownKey?.name || tokenName || remoteKeyId,
        requestAt: toIsoDate(row.created_at),
        model: row.model_name || null,
        channelId: other.actual_channel_id ?? row.channel ?? null,
        channelName: row.channel_name || null,
        multiplier: modelRatio * groupRatio,
        modelRatio,
        groupRatio,
        completionRatio: finitePositive(other.completion_ratio) ?? 1,
        cacheRatio: finiteNonnegative(other.cache_ratio) ?? 1,
        promptTokens: toFiniteNumber(row.prompt_tokens, 0) || 0,
        completionTokens: toFiniteNumber(row.completion_tokens, 0) || 0,
        cacheTokens: toFiniteNumber(other.cache_tokens, 0) || 0
      });
    }

    const allKeysById = new Map(knownKeys.map((key) => [String(key.remoteId), key]));
    for (const [remoteId, observations] of observationsByKey) {
      if (!allKeysById.has(remoteId)) {
        allKeysById.set(remoteId, {
          remoteId,
          name: observations[0]?.keyName || remoteId
        });
      }
    }
    const allKeys = [...allKeysById.values()];
    return allKeys.map((key) => ({
      remoteKeyId: String(key.remoteId),
      keyName: key.name || String(key.remoteId),
      ...summarizeDynamicRouteObservations(
        observationsByKey.get(String(key.remoteId)) || [],
        config
      )
    }));
  }

  async getPriceCatalog() {
    if (!['new-api', 'veloera'].includes(this.type)) return [];
    const response = await this.http.requestJson(joinUrl(this.connection.base_url, '/api/pricing'), {
      headers: this.headers(),
      retries: 1
    });
    if (response.data?.success === false) {
      throw new AppError('BUSINESS_ERROR', response.data.message || 'Pricing catalog is unavailable', {
        status: 502
      });
    }
    const rows = Array.isArray(response.data?.data) ? response.data.data : [];
    const groupRatios = response.data?.group_ratio || {};
    const status = await this.ensureStatus();
    const quotaPerUnit = toFiniteNumber(status?.quota_per_unit, 500000) || 500000;
    const models = [];
    const prices = [];
    for (const row of rows) {
      const modelId = String(row.model_name || '').trim();
      if (!modelId) continue;
      models.push({
        remoteId: modelId,
        name: modelId,
        vendor: row.owner_by || null,
        contextLength: null,
        capabilities: { endpointTypes: row.supported_endpoint_types || [] },
        metadata: {
          description: row.description || null,
          tags: row.tags || null,
          pricingVersion: row.pricing_version || response.data?.pricing_version || null
        }
      });
      const baseInput = Number(row.quota_type) === 0
        ? (1000000 / quotaPerUnit) * (toFiniteNumber(row.model_ratio, 0) || 0)
        : null;
      const enabledGroups = Array.isArray(row.enable_groups) ? row.enable_groups : [];
      const groupRefs = enabledGroups.includes('all') || enabledGroups.length === 0
        ? Object.keys(groupRatios)
        : enabledGroups;
      const targets = groupRefs.length > 0 ? groupRefs : [null];
      for (const groupRef of targets) {
        const groupRatio = groupRef == null ? 1 : toFiniteNumber(groupRatios[groupRef], 1) || 1;
        const input = baseInput == null ? null : baseInput * groupRatio;
        prices.push({
          modelId,
          groupRef,
          currency: 'USD',
          billingMode: Number(row.quota_type) === 1 ? 'per_request' : row.billing_mode || 'token',
          inputPerMillion: input,
          outputPerMillion: input == null ? null : input * (toFiniteNumber(row.completion_ratio, 1) || 1),
          cacheReadPerMillion: input == null || row.cache_ratio == null
            ? null
            : input * toFiniteNumber(row.cache_ratio, 1),
          cacheWritePerMillion: input == null || row.create_cache_ratio == null
            ? null
            : input * toFiniteNumber(row.create_cache_ratio, 1),
          requestPrice: Number(row.quota_type) === 1 && toFiniteNumber(row.model_price) != null
            ? toFiniteNumber(row.model_price) * groupRatio
            : null,
          imagePrice: row.image_ratio == null || input == null
            ? null
            : input * toFiniteNumber(row.image_ratio, 1),
          audioPrice: row.audio_ratio == null || input == null
            ? null
            : input * toFiniteNumber(row.audio_ratio, 1),
          raw: this.safeRaw(row)
        });
      }
    }
    return { models, prices };
  }

  async getCheckInStatus() {
    if (this.type === 'new-api') {
      const response = await this.http.requestJson(
        joinUrl(this.connection.base_url, '/api/user/checkin'),
        { headers: this.headers(), retries: 0 }
      );
      const data = unwrapEnvelope(response.data);
      return {
        supported: Boolean(data?.enabled ?? true),
        checkedInToday: Boolean(data?.stats?.checked_in_today),
        details: this.safeRaw(data)
      };
    }
    if (this.type === 'veloera') {
      const response = await this.http.requestJson(
        joinUrl(this.connection.base_url, '/api/user/check_in_status'),
        { headers: this.headers(), retries: 0 }
      );
      const data = unwrapEnvelope(response.data);
      return {
        supported: true,
        checkedInToday: data?.can_check_in === false,
        details: this.safeRaw(data)
      };
    }
    return super.getCheckInStatus();
  }

  async checkIn() {
    const endpoint = this.type === 'new-api'
      ? '/api/user/checkin'
      : this.type === 'veloera'
        ? '/api/user/check_in'
        : null;
    if (!endpoint) return super.checkIn();
    const response = await this.http.requestJson(joinUrl(this.connection.base_url, endpoint), {
      method: 'POST',
      headers: this.headers(),
      retries: 0
    });
    const data = unwrapEnvelope(response.data);
    const status = await this.ensureStatus();
    const divisor = toFiniteNumber(status?.quota_per_unit, 500000) || 500000;
    const rawReward = toFiniteNumber(data?.quota_awarded ?? data?.quota);
    return {
      status: 'succeeded',
      rewardAmount: rawReward == null ? null : rawReward / divisor,
      currency: 'USD',
      details: this.safeRaw(data)
    };
  }
}

function normalizeTokenStatus(token) {
  const status = Number(token.status);
  if (status === 2) return 'disabled';
  if (status === 3) return 'expired';
  if (status === 4) return 'exhausted';
  if (token.expired_time && toIsoDate(token.expired_time) < new Date().toISOString()) {
    return 'expired';
  }
  return 'enabled';
}

module.exports = {
  OneApiFamilyAdapter,
  normalizeTokenStatus,
  FAMILY_CONFIG
};
