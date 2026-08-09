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
  LEGACY_CONFIGURED_API_KEY_ID,
  apiKeyIdentityHash,
  cleanApiKey,
  normalizeConfiguredApiKeys
} = require('../security/configured-api-keys');

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

function usesApiKey(connection) {
  return String(connection?.auth_mode || '').toLowerCase() === 'api_key';
}

function configuredApiKey(credentials = {}) {
  return normalizeConfiguredApiKeys(credentials)[0]?.key || '';
}

function rechargeTargetPath(connection, targetUrl) {
  try {
    const base = new URL(connection.base_url);
    const target = new URL(targetUrl);
    if (base.origin !== target.origin) return null;
    return `${target.pathname}${target.search}${target.hash}` || '/';
  } catch {
    return null;
  }
}

function gatewayQuota(data = {}) {
  const quota = data.quota && typeof data.quota === 'object' ? data.quota : {};
  const limit = toFiniteNumber(quota.limit);
  const used = toFiniteNumber(
    data.usage?.total?.actual_cost ?? quota.used ?? data.usage?.total?.cost
  );
  let remaining = toFiniteNumber(quota.remaining ?? data.remaining ?? data.balance);
  const unlimited = remaining === -1;
  if (unlimited) remaining = null;
  return {
    currency: String(quota.unit || data.unit || 'USD'),
    limit: limit != null && limit > 0 ? limit : null,
    used,
    remaining,
    unlimited,
    resetAt: toIsoDate(quota.reset_at),
    resetInterval: quota.reset_interval || null
  };
}

function gatewayKeyStatus(data = {}) {
  const status = String(data.status || '').trim().toLowerCase();
  if (status === 'quota_exhausted') return 'exhausted';
  if (status === 'expired') return 'expired';
  if (data.isValid === false) return status || 'disabled';
  return status || 'active';
}

function gatewayUsageItem(data, period) {
  const item = data?.usage?.[period];
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const inputTokens = toFiniteNumber(item.input_tokens, 0);
  const outputTokens = toFiniteNumber(item.output_tokens, 0);
  const cacheCreationTokens = toFiniteNumber(item.cache_creation_tokens, 0);
  const cacheReadTokens = toFiniteNumber(item.cache_read_tokens, 0);
  return {
    currency: String(data.unit || data.quota?.unit || 'USD'),
    cost: toFiniteNumber(item.actual_cost ?? item.cost),
    requests: toFiniteNumber(item.requests),
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    averageDurationMs: toFiniteNumber(item.average_duration_ms),
    totalTokens: toFiniteNumber(
      item.total_tokens,
      inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens
    ),
    model: null,
    period: period === 'total' ? 'cumulative' : period,
    raw: item
  };
}

function gatewayDailyUsageItems(data) {
  const rows = Array.isArray(data?.daily_usage)
    ? data.daily_usage.filter((item) => (
        item && typeof item === 'object' && !Array.isArray(item) &&
        /^\d{4}-\d{2}-\d{2}$/.test(String(item.date || ''))
      ))
    : [];
  if (rows.length === 0) return [];

  const items = rows.map((item) => {
    const inputTokens = toFiniteNumber(item.input_tokens, 0);
    const outputTokens = toFiniteNumber(item.output_tokens, 0);
    const cacheCreationTokens = toFiniteNumber(
      item.cache_creation_tokens ?? item.cache_write_tokens,
      0
    );
    const cacheReadTokens = toFiniteNumber(item.cache_read_tokens, 0);
    return {
      currency: String(data.unit || data.quota?.unit || 'USD'),
      cost: toFiniteNumber(item.actual_cost ?? item.cost),
      requests: toFiniteNumber(item.requests, 0),
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      averageDurationMs: null,
      totalTokens: toFiniteNumber(
        item.total_tokens,
        inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens
      ),
      model: null,
      period: `day:${item.date}`,
      usageDate: String(item.date),
      raw: item
    };
  });
  const total = gatewayUsageItem(data, 'total');
  const sums = items.reduce((result, item) => ({
    requests: result.requests + Number(item.requests || 0),
    totalTokens: result.totalTokens + Number(item.totalTokens || 0),
    cost: result.cost + Number(item.cost || 0)
  }), { requests: 0, totalTokens: 0, cost: 0 });
  const near = (left, right) => Math.abs(Number(left) - Number(right)) <=
    Math.max(1e-8, Math.abs(Number(right)) * 1e-9);
  const historyComplete = Boolean(total) &&
    sums.requests === Number(total.requests || 0) &&
    sums.totalTokens === Number(total.totalTokens || 0) &&
    near(sums.cost, Number(total.cost || 0));
  const dates = items.map((item) => item.usageDate).sort();
  return items.map((item) => ({
    ...item,
    dailyHistoryComplete: historyComplete,
    dailyCoverageStart: dates[0],
    dailyCoverageEnd: dates.at(-1)
  }));
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed)
    ? Math.min(maximum, Math.max(minimum, parsed))
    : fallback;
}

function dateKey(value, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(value);
    const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${byType.year}-${byType.month}-${byType.day}`;
  } catch {
    return value.toISOString().slice(0, 10);
  }
}

function nextDateKey(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return value;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1));
  return date.toISOString().slice(0, 10);
}

function usesGatewayApiKeyUsageLogs(connection) {
  return usesApiKey(connection) && connection.type_config_json?.apiKeySource !== 'remote';
}

function supportsUserUsageLogs(connection, credentials = {}) {
  if (!usesApiKey(connection)) return true;
  if (usesGatewayApiKeyUsageLogs(connection)) return false;
  return Boolean(
    credentials.accessToken || credentials.refreshToken ||
    (credentials.email && credentials.password)
  );
}

function normalizeRequestLog(row, expectedKey, options = {}) {
  const remoteKeyId = String(expectedKey.remoteId);
  if (
    options.validateRemoteKeyId !== false &&
    row?.api_key_id != null &&
    String(row.api_key_id) !== remoteKeyId
  ) {
    throw new AppError(
      'SUB2API_USAGE_KEY_MISMATCH',
      `Sub2API returned usage for API Key ${row.api_key_id} while querying ${remoteKeyId}`,
      { status: 502, details: { expectedKeyId: remoteKeyId, actualKeyId: String(row.api_key_id) } }
    );
  }
  const sourceLogId = row?.id ?? row?.usage_id;
  const createdAt = toIsoDate(row?.created_at ?? row?.timestamp);
  if (sourceLogId == null || !createdAt) return null;
  const durationMs = toFiniteNumber(row.duration_ms);
  const firstTokenMs = toFiniteNumber(row.first_token_ms);
  return {
    sourceLogId: String(sourceLogId),
    remoteKeyId,
    keyName: expectedKey.name || remoteKeyId,
    requestId: row.request_id == null ? null : String(row.request_id),
    model: row.model || row.requested_model || null,
    upstreamModel: row.upstream_model || null,
    stream: row.stream === true || row.stream === 1,
    status: 'success',
    durationMs: durationMs == null || durationMs < 0 ? null : Math.round(durationMs),
    firstTokenMs: firstTokenMs == null || firstTokenMs <= 0 ? null : Math.round(firstTokenMs),
    inputTokens: Math.max(0, Math.round(toFiniteNumber(row.input_tokens, 0))),
    outputTokens: Math.max(0, Math.round(toFiniteNumber(row.output_tokens, 0))),
    cacheCreationTokens: Math.max(0, Math.round(toFiniteNumber(row.cache_creation_tokens, 0))),
    cacheReadTokens: Math.max(0, Math.round(toFiniteNumber(row.cache_read_tokens, 0))),
    actualCost: toFiniteNumber(row.actual_cost ?? row.total_cost),
    currency: 'USD',
    createdAt
  };
}

function translateSub2ApiAuthError(error) {
  const remoteCode = String(error?.details?.remoteCode || '');
  if (remoteCode === 'REFRESH_TOKEN_INVALID') {
    return new AppError(
      'AUTH_EXPIRED',
      'Sub2API refresh token is invalid or has already been rotated; configure a fresh OAuth token pair',
      { status: 401, details: error.details, cause: error }
    );
  }
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
  constructor(context) {
    super(context);
    this.apiKeyEntries = normalizeConfiguredApiKeys(this.credentials, {
      defaultName: `${this.connection.name} API Key`
    });
    const monitoredKeyIds = this.connection.type_config_json?.monitoredKeyIds;
    if (
      usesApiKey(this.connection) &&
      this.connection.type_config_json?.apiKeySource !== 'remote' &&
      Array.isArray(monitoredKeyIds)
    ) {
      const selected = new Set(monitoredKeyIds.map((value) => String(value || '').trim()));
      this.apiKeyEntries = this.apiKeyEntries.filter((entry) => selected.has(entry.id));
    }
    this.apiKeyUsageInfo = new Map();
    this.apiKeyBillingInfo = new Map();
    this.gatewayRequestLogsSupported = null;
    this.gatewayRequestLogsProbe = null;
  }

  capabilities() {
    if (usesApiKey(this.connection)) {
      return {
        ...super.capabilities(),
        accountBalance: true,
        listKeys: true,
        keyQuota: true,
        listGroups: true,
        keyGroup: true,
        usageHistory: true,
        requestLogs: supportsUserUsageLogs(this.connection, this.credentials) ||
          (usesGatewayApiKeyUsageLogs(this.connection) && this.gatewayRequestLogsSupported === true),
        rechargeQuote: true
      };
    }
    return {
      ...super.capabilities(),
      accountBalance: true,
      listKeys: true,
      keyQuota: true,
      listGroups: true,
      keyGroup: true,
      groupsDerivedFromKeys: true,
      usageHistory: true,
      requestLogs: true,
      priceCatalog: true,
      rechargeQuote: true,
      rechargeLogin: true,
      credentialRefresh: true
    };
  }

  async probe() {
    if (usesGatewayApiKeyUsageLogs(this.connection)) {
      await this.detectGatewayRequestLogs();
    }
    return {
      adapterType: this.type,
      detectedFamily: 'sub2api',
      version: null,
      capabilities: this.capabilities()
    };
  }

  async detectGatewayRequestLogs() {
    if (!usesGatewayApiKeyUsageLogs(this.connection)) return false;
    if (this.gatewayRequestLogsSupported != null) return this.gatewayRequestLogsSupported;
    if (!this.gatewayRequestLogsProbe) {
      this.gatewayRequestLogsProbe = (async () => {
        const [entry] = await this.monitoredApiKeyEntries();
        if (!entry) return false;
        try {
          const query = new URLSearchParams({ page: '1', page_size: '1' });
          const response = await this.http.requestJson(
            joinUrl(this.connection.base_url, `/v1/usage/logs?${query.toString()}`),
            { headers: this.apiKeyHeaders(entry), retries: 0 }
          );
          const payload = unwrapEnvelope(response.data, { allowNull: true });
          const valid = Array.isArray(payload) || Boolean(
            payload && typeof payload === 'object' && !Array.isArray(payload) &&
            ['items', 'list', 'records', 'data'].some((field) => Array.isArray(payload[field]))
          );
          if (!valid) {
            throw new AppError(
              'SCHEMA_MISMATCH',
              'Sub2API API Key request-log response is invalid',
              { status: 502 }
            );
          }
          return true;
        } catch (error) {
          if (error?.code === 'CAPABILITY_UNSUPPORTED') return false;
          throw error;
        }
      })();
    }
    try {
      this.gatewayRequestLogsSupported = await this.gatewayRequestLogsProbe;
      return this.gatewayRequestLogsSupported;
    } finally {
      this.gatewayRequestLogsProbe = null;
    }
  }

  configuredApiKeys() {
    if (this.apiKeyEntries.length === 0) {
      throw new AppError('AUTH_EXPIRED', 'Sub2API API Key credentials are missing', {
        status: 401
      });
    }
    return this.apiKeyEntries;
  }

  configuredApiKey(entry = null) {
    return entry || this.configuredApiKeys()[0];
  }

  async monitoredApiKeyEntries() {
    if (this.connection.type_config_json?.apiKeySource !== 'remote') {
      return this.configuredApiKeys();
    }
    if (!this.remoteApiKeyEntriesPromise) {
      this.remoteApiKeyEntriesPromise = this.loadRemoteApiKeyEntries();
    }
    return this.remoteApiKeyEntriesPromise;
  }

  async loadRemoteApiKeyEntries() {
    const configuredIds = this.connection.type_config_json?.monitoredKeyIds;
    const selected = Array.isArray(configuredIds)
      ? new Set(configuredIds.map((value) => String(value || '').trim()).filter(Boolean))
      : null;
    const entries = [];
    const availableIds = new Set();
    const pageSize = 100;
    for (let page = 1; page <= 100; page += 1) {
      const response = await this.authenticatedRequest(
        `/api/v1/keys?page=${page}&page_size=${pageSize}`
      );
      const { items, total } = extractItems(response.data);
      for (const key of items) {
        const id = String(key.id ?? '').trim();
        if (!id) continue;
        availableIds.add(id);
        if (selected && !selected.has(id)) continue;
        const value = cleanApiKey(key.key);
        if (!value || value.includes('...') || /[*•]/.test(value)) {
          throw new AppError(
            'SUB2API_KEY_SECRET_UNAVAILABLE',
            `Sub2API did not expose the full value for API Key ${key.name || id}`,
            { status: 409, details: { remoteKeyId: id } }
          );
        }
        entries.push({ id, name: key.name || `Key ${id}`, key: value });
      }
      if (items.length < pageSize || entries.length >= total || (selected && entries.length >= selected.size)) break;
    }
    const missingIds = selected
      ? [...selected].filter((id) => !availableIds.has(id))
      : [];
    if (missingIds.length > 0) {
      throw new AppError(
        'MONITORED_KEY_NOT_FOUND',
        `${missingIds.length} configured Sub2API API Key(s) were not returned by the provider`,
        { status: 409, details: { remoteKeyIds: missingIds } }
      );
    }
    if (entries.length === 0) {
      throw new AppError('AUTH_EXPIRED', 'No Sub2API API Key was selected for monitoring', {
        status: 401
      });
    }
    return entries;
  }

  configuredGroupRef(entry, billing = {}) {
    const billingScope = String(billing.billing_scope || 'token');
    return entry.id === LEGACY_CONFIGURED_API_KEY_ID
      ? billingScope
      : `configured-api-key:${entry.id}`;
  }

  apiKeyHeaders(entry = null) {
    const configured = this.configuredApiKey(entry);
    return {
      Accept: 'application/json',
      Authorization: `Bearer ${configured.key}`
    };
  }

  async getApiKeyUsage(entry = null) {
    const configured = this.configuredApiKey(entry);
    if (!this.apiKeyUsageInfo.has(configured.id)) {
      this.apiKeyUsageInfo.set(configured.id, (async () => {
        const response = await this.http.requestJson(
          joinUrl(this.connection.base_url, '/v1/usage'),
          { headers: this.apiKeyHeaders(configured), retries: 1 }
        );
        const data = unwrapEnvelope(response.data, { allowNull: true });
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          throw new AppError('SCHEMA_MISMATCH', 'Sub2API API Key usage response is invalid', {
            status: 502
          });
        }
        return data;
      })());
    }
    return this.apiKeyUsageInfo.get(configured.id);
  }

  async getApiKeyBilling(entry = null) {
    const configured = this.configuredApiKey(entry);
    if (!this.apiKeyBillingInfo.has(configured.id)) {
      this.apiKeyBillingInfo.set(configured.id, (async () => {
        const response = await this.http.requestJson(
          joinUrl(this.connection.base_url, '/v1/sub2api/billing'),
          { headers: this.apiKeyHeaders(configured), retries: 1 }
        );
        const data = unwrapEnvelope(response.data, { allowNull: true });
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          throw new AppError('SCHEMA_MISMATCH', 'Sub2API API Key billing response is invalid', {
            status: 502
          });
        }
        return data;
      })());
    }
    return this.apiKeyBillingInfo.get(configured.id);
  }

  async apiKeyResults(loader) {
    const entries = await this.monitoredApiKeyEntries();
    const settled = await Promise.allSettled(entries.map((entry) => loader(entry)));
    return entries.map((entry, index) => ({ entry, result: settled[index] }));
  }

  firstSuccessfulApiKeyResult(results) {
    const successful = results.find((item) => item.result.status === 'fulfilled');
    if (successful) return successful;
    throw results[0]?.result.reason || new AppError(
      'AUTH_EXPIRED',
      'No configured Sub2API API Key could be monitored',
      { status: 401 }
    );
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
        if (!['AUTH_FAILED', 'AUTH_EXPIRED', 'BUSINESS_ERROR'].includes(error.code)) throw error;
      }
    }
    return this.login();
  }

  rechargeLoginSupport(targetUrl) {
    if (usesApiKey(this.connection)) return { supported: false, reason: 'api_key_has_no_user_session' };
    if (!rechargeTargetPath(this.connection, targetUrl)) {
      return { supported: false, reason: 'recharge_target_origin_mismatch' };
    }
    const hasSession = Boolean(this.credentials.accessToken || this.credentials.refreshToken);
    const hasAccount = Boolean(this.credentials.email && this.credentials.password);
    return hasSession || hasAccount
      ? { supported: true, mode: 'sub2api_token_fragment' }
      : { supported: false, reason: 'login_credentials_missing' };
  }

  async createRechargeLogin(targetUrl) {
    const support = this.rechargeLoginSupport(targetUrl);
    if (!support.supported) {
      throw new AppError('RECHARGE_LOGIN_UNAVAILABLE', 'Sub2API recharge login is not available', {
        status: 409,
        details: { reason: support.reason }
      });
    }
    const accessToken = await this.getAccessToken();
    const expiry = Number(this.credentials.tokenExpiresAt) || decodeJwtExpiration(accessToken);
    const expiresIn = expiry
      ? Math.max(60, Math.floor((expiry - Date.now()) / 1000))
      : Math.max(60, Number(this.credentials.expiresIn) || 3600);
    const fragment = new URLSearchParams({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: String(expiresIn),
      redirect: rechargeTargetPath(this.connection, targetUrl)
    });
    return {
      mode: 'redirect',
      adapterType: 'sub2api',
      targetUrl,
      url: `${joinUrl(this.connection.base_url, '/auth/callback')}#${fragment.toString()}`
    };
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
    if (usesApiKey(this.connection)) {
      const results = await this.apiKeyResults((entry) => this.getApiKeyUsage(entry));
      const { result } = this.firstSuccessfulApiKeyResult(results);
      const usage = result.value;
      return {
        remoteId: String(
          this.connection.remote_user_id ||
          this.connection.account_dedupe_key ||
          this.connection.id
        ),
        displayName: this.connection.name,
        userGroup: usage.planName || null,
        status: results.some((item) => item.result.status === 'fulfilled' && item.result.value.isValid !== false)
          ? 'active'
          : 'disabled',
        metadata: this.safeRaw({
          authMode: 'api_key',
          mode: usage.mode || null,
          planName: usage.planName || null,
          configuredKeyCount: results.length,
          reachableKeyCount: results.filter((item) => item.result.status === 'fulfilled').length
        })
      };
    }
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
    if (usesApiKey(this.connection)) {
      const results = await this.apiKeyResults((entry) => this.getApiKeyUsage(entry));
      const { result } = this.firstSuccessfulApiKeyResult(results);
      const usage = result.value;
      const quota = gatewayQuota(usage);
      return [{
        scope: 'account',
        remoteSubjectId: account?.remoteId || this.connection.id,
        currency: quota.currency,
        available: quota.remaining,
        total: quota.limit,
        used: quota.used,
        granted: null,
        toppedUp: null,
        frozen: null,
        unlimited: quota.unlimited,
        sourceField: usage.quota ? 'quota.remaining' : 'remaining',
        raw: this.safeRaw({
          mode: usage.mode,
          planName: usage.planName,
          quota: usage.quota,
          balance: usage.balance,
          remaining: usage.remaining
        })
      }];
    }
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

  async getRechargeQuote() {
    if (usesApiKey(this.connection)) {
      try {
        const results = await this.apiKeyResults((entry) => this.getApiKeyBilling(entry));
        const available = results
          .filter((item) => item.result.status === 'fulfilled')
          .map((item) => item.result.value)
          .find((billing) => toFiniteNumber(
            billing.balance_recharge_multiplier ?? billing.recharge_multiplier
          ) > 0);
        const multiplier = toFiniteNumber(
          available?.balance_recharge_multiplier ?? available?.recharge_multiplier
        );
        if (multiplier != null && multiplier > 0) {
          return {
            available: true,
            multiplier,
            paidAmount: 1,
            creditedAmount: multiplier,
            paidCurrency: available.payment_currency || null,
            balanceCurrency: available.balance_currency || 'USD',
            source: 'provider_billing',
            metadata: this.safeRaw({ billingScope: available.billing_scope || null })
          };
        }
        return {
          available: false,
          multiplier: null,
          source: 'provider_billing',
          errorCode: 'RECHARGE_RATE_NOT_EXPOSED',
          metadata: { authMode: 'api_key' }
        };
      } catch (error) {
        return {
          available: false,
          multiplier: null,
          source: 'provider_billing',
          errorCode: error.code || 'RECHARGE_RATE_UNAVAILABLE',
          metadata: { authMode: 'api_key' }
        };
      }
    }

    try {
      let response;
      try {
        response = await this.authenticatedRequest('/api/v1/payment/checkout-info', { retries: 0 });
      } catch (error) {
        if (error.code !== 'CAPABILITY_UNSUPPORTED') throw error;
        response = await this.authenticatedRequest('/api/v1/payment/config', { retries: 0 });
      }
      const data = unwrapEnvelope(response.data, { allowNull: true }) || {};
      const multiplier = toFiniteNumber(
        data.balance_recharge_multiplier ?? data.recharge_multiplier
      );
      if (multiplier != null && multiplier > 0) {
        return {
          available: true,
          multiplier,
          paidAmount: 1,
          creditedAmount: multiplier,
          paidCurrency: data.payment_currency || data.default_currency || null,
          balanceCurrency: data.balance_currency || 'USD',
          source: 'provider_payment_config',
          metadata: this.safeRaw({
            balanceDisabled: data.balance_disabled ?? null,
            rechargeFeeRate: toFiniteNumber(data.recharge_fee_rate)
          })
        };
      }
      return {
        available: false,
        multiplier: null,
        source: 'provider_payment_config',
        errorCode: 'RECHARGE_RATE_NOT_EXPOSED',
        metadata: {}
      };
    } catch (error) {
      return {
        available: false,
        multiplier: null,
        source: 'provider_payment_config',
        errorCode: error.code || 'RECHARGE_RATE_UNAVAILABLE',
        metadata: {}
      };
    }
  }

  async listGroups() {
    if (usesApiKey(this.connection)) {
      const results = await this.apiKeyResults((entry) => this.getApiKeyBilling(entry));
      this.groupListComplete = results.every((item) => item.result.status === 'fulfilled');
      const groups = results.flatMap(({ entry, result }) => {
        if (result.status !== 'fulfilled') return [];
        const billing = result.value;
        const billingScope = String(billing.billing_scope || 'token');
        return [{
          remoteId: this.configuredGroupRef(entry, billing),
          type: 'key_route_group',
          name: `${entry.name} · ${billingScope}`,
          ratio: toFiniteNumber(
            billing.effective_rate_multiplier ??
            billing.resolved_rate_multiplier ??
            billing.group_rate_multiplier
          ),
          status: 'active',
          metadata: this.safeRaw({
            source: 'sub2api_key_billing',
            configuredKeyId: entry.id,
            billingScope,
            ...billing
          })
        }];
      });
      if (groups.length === 0) this.firstSuccessfulApiKeyResult(results);
      return groups;
    }
    const [groupsResponse, ratesResponse, keysResult] = await Promise.all([
      this.authenticatedRequest('/api/v1/groups/available'),
      this.authenticatedRequest('/api/v1/groups/rates').catch(() => ({ data: { data: {} } })),
      this.listKeys().then(
        (value) => ({ ok: true, value }),
        () => ({ ok: false, value: [] })
      )
    ]);
    this.groupListComplete = keysResult.ok;
    const groups = unwrapEnvelope(groupsResponse.data) || [];
    const rates = normalizeGroupRates(unwrapEnvelope(ratesResponse.data, { allowNull: true }));
    const merged = new Map(groups.map((group) => {
      const normalized = this.normalizeUserGroup(group, rates);
      return [normalized.remoteId, normalized];
    }));
    for (const key of keysResult.value) {
      for (const snapshot of key.groupSnapshots || []) {
        if (merged.has(snapshot.remoteId)) continue;
        const normalized = this.normalizeUserGroup(snapshot.metadata, rates);
        merged.set(normalized.remoteId, normalized);
      }
    }
    return [...merged.values()];
  }

  async listKeys() {
    if (!this.keyListPromise) this.keyListPromise = this.loadKeys();
    return this.keyListPromise;
  }

  normalizeUserGroup(group, rates = null, { derivedFromKey = Boolean(group?.derivedFromKey) } = {}) {
    const remoteId = String(group.id);
    const defaultRateMultiplier = toFiniteNumber(group.rate_multiplier, derivedFromKey ? null : 1);
    const embeddedRateMultiplier = derivedFromKey
      ? toFiniteNumber(group.effective_rate_multiplier, defaultRateMultiplier)
      : defaultRateMultiplier;
    const effectiveRateMultiplier = rates == null
      ? embeddedRateMultiplier
      : resolveGroupRate(rates, group.id, embeddedRateMultiplier);
    return {
      remoteId,
      type: 'key_route_group',
      name: group.name || remoteId,
      ratio: effectiveRateMultiplier,
      status: group.status || 'active',
      metadata: this.safeRaw({
        ...group,
        default_rate_multiplier: defaultRateMultiplier,
        effective_rate_multiplier: effectiveRateMultiplier,
        personalized_rate: effectiveRateMultiplier !== defaultRateMultiplier,
        selectable: !derivedFromKey,
        ...(derivedFromKey ? { derivedFromKey: true } : {})
      })
    };
  }

  async loadKeys() {
    if (usesApiKey(this.connection)) {
      const entries = await this.monitoredApiKeyEntries();
      return Promise.all(entries.map(async (entry) => {
        const [usageResult, billingResult] = await Promise.allSettled([
          this.getApiKeyUsage(entry),
          this.getApiKeyBilling(entry)
        ]);
        const usage = usageResult.status === 'fulfilled' ? usageResult.value : null;
        const billing = billingResult.status === 'fulfilled' ? billingResult.value : null;
        const identityHash = apiKeyIdentityHash(entry.key, this.config.secret);
        return {
          remoteId: entry.id,
          name: entry.name,
          maskedKey: this.maskKey(entry.key),
          status: usage ? gatewayKeyStatus(usage) : 'unknown',
          primaryGroupRef: billing ? this.configuredGroupRef(entry, billing) : null,
          backupGroupRef: null,
          additionalGroupRefs: [],
          quota: usage ? gatewayQuota(usage) : null,
          expiresAt: usage ? toIsoDate(usage.expires_at ?? usage.subscription?.expires_at) : null,
          lastUsedAt: null,
          metadata: this.safeRaw({
            source: 'sub2api_gateway_usage',
            configuredKeyId: entry.id,
            ...(identityHash ? { identityHash, identityAlgorithm: 'hmac-sha256-v1' } : {}),
            billingScope: billing?.billing_scope || null,
            mode: usage?.mode || null,
            planName: usage?.planName || null,
            daysUntilExpiry: usage?.days_until_expiry ?? null,
            usageError: usageResult.status === 'rejected'
              ? usageResult.reason?.code || 'KEY_USAGE_UNAVAILABLE'
              : null,
            billingError: billingResult.status === 'rejected'
              ? billingResult.reason?.code || 'KEY_BILLING_UNAVAILABLE'
              : null
          })
        };
      }));
    }
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
        const groupSnapshot = key.group?.id == null
          ? null
          : this.normalizeUserGroup(key.group, null, { derivedFromKey: true });
        result.push({
          remoteId: String(key.id),
          name: key.name || `Key ${key.id}`,
          maskedKey: key.key || '',
          status: key.status || 'unknown',
          primaryGroupRef: key.group_id == null ? null : String(key.group_id),
          backupGroupRef: null,
          additionalGroupRefs: [],
          groupSnapshots: groupSnapshot ? [groupSnapshot] : [],
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
    if (usesApiKey(this.connection)) {
      const results = await this.apiKeyResults((entry) => this.getApiKeyUsage(entry));
      const usage = results.flatMap(({ entry, result }) => {
        if (result.status !== 'fulfilled') return [];
        const credentialIdentity = apiKeyIdentityHash(entry.key, this.config.secret);
        return [
          ...['today', 'total'].map((period) => gatewayUsageItem(result.value, period)),
          ...gatewayDailyUsageItems(result.value)
        ]
          .filter(Boolean)
          .map((item) => ({
            ...item,
            scope: 'key',
            remoteSubjectId: entry.id,
            raw: {
              ...this.safeRaw({ ...item.raw, configuredKeyId: entry.id }),
              monitorMetrics: {
                actualCost: item.cost,
                cacheCreationCount: item.cacheCreationTokens,
                cacheReadCount: item.cacheReadTokens,
                averageDurationMs: item.averageDurationMs,
                credentialIdentity,
                usageDate: item.usageDate || null,
                dailyHistoryComplete: item.dailyHistoryComplete ?? null,
                dailyCoverageStart: item.dailyCoverageStart || null,
                dailyCoverageEnd: item.dailyCoverageEnd || null,
                timezone: this.config.timezone || 'UTC'
              }
            }
          }));
      });
      if (usage.length === 0) this.firstSuccessfulApiKeyResult(results);
      return usage;
    }
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

  async getRequestLogs(options = {}) {
    const gatewayApiKeyLogs = usesGatewayApiKeyUsageLogs(this.connection);
    if (gatewayApiKeyLogs && !(await this.detectGatewayRequestLogs())) {
      throw new AppError(
        'CAPABILITY_UNSUPPORTED',
        'Sub2API has not enabled API Key request-log access at /v1/usage/logs',
        { status: 404, details: { endpoint: '/v1/usage/logs' } }
      );
    }
    if (!gatewayApiKeyLogs && !supportsUserUsageLogs(this.connection, this.credentials)) {
      return super.getRequestLogs(options);
    }

    const lookbackDays = boundedInteger(options.lookbackDays, 30, 1, 90);
    const maxRecords = boundedInteger(options.maxRecords, 5000, 100, 10000);
    const suppliedKeys = Array.isArray(options.keys) ? options.keys : [];
    const knownKeys = suppliedKeys.length > 0 ? suppliedKeys : await this.listKeys();
    const requestedKeys = knownKeys.filter((key) => key?.remoteId != null);
    const endAt = new Date();
    const startAt = new Date(endAt.getTime() - lookbackDays * 86400000);
    const coverageFrom = startAt.toISOString();
    const coverageTo = endAt.toISOString();
    const timeZone = this.config.timezone || 'UTC';
    const endDate = nextDateKey(dateKey(endAt, timeZone));
    const configuredEntries = gatewayApiKeyLogs ? await this.monitoredApiKeyEntries() : [];
    const configuredEntriesById = new Map(
      configuredEntries.map((entry) => [String(entry.id), entry])
    );

    if (requestedKeys.length === 0) {
      return {
        items: [],
        total: 0,
        truncated: false,
        coverageFrom,
        coverageTo,
        keyCoverage: []
      };
    }

    const queryableKeys = requestedKeys.slice(0, maxRecords);
    const perKeyLimit = Math.max(1, Math.floor(maxRecords / queryableKeys.length));
    const results = new Array(queryableKeys.length);
    let cursor = 0;
    const workerCount = Math.min(
      boundedInteger(options.concurrency, 4, 1, 10),
      queryableKeys.length
    );
    const workers = Array.from({ length: workerCount }, async () => {
      while (cursor < queryableKeys.length) {
        const index = cursor;
        cursor += 1;
        const key = queryableKeys[index];
        const remoteKeyId = String(key.remoteId);
        try {
          if (!gatewayApiKeyLogs && !/^\d+$/.test(remoteKeyId)) {
            throw new AppError(
              'SUB2API_USAGE_KEY_ID_INVALID',
              `Sub2API request logs require a numeric remote API Key ID, received ${remoteKeyId}`,
              { status: 409, details: { remoteKeyId } }
            );
          }
          const rows = [];
          let total = null;
          let hasTotal = false;
          const configuredEntry = gatewayApiKeyLogs
            ? configuredEntriesById.get(remoteKeyId)
            : null;
          if (gatewayApiKeyLogs && !configuredEntry) {
            throw new AppError(
              'SUB2API_CONFIGURED_KEY_NOT_FOUND',
              `Sub2API configured API Key ${remoteKeyId} is unavailable`,
              { status: 409, details: { remoteKeyId } }
            );
          }
          for (let page = 1; rows.length < perKeyLimit; page += 1) {
            const pageSize = Math.min(100, perKeyLimit - rows.length);
            const query = new URLSearchParams({
              start_date: dateKey(startAt, timeZone),
              end_date: endDate,
              timezone: timeZone,
              page: String(page),
              page_size: String(pageSize)
            });
            if (!gatewayApiKeyLogs) {
              query.set('api_key_id', remoteKeyId);
              query.set('sort_by', 'created_at');
              query.set('sort_order', 'desc');
            }
            const endpoint = gatewayApiKeyLogs ? '/v1/usage/logs' : '/api/v1/usage';
            const response = gatewayApiKeyLogs
              ? await this.http.requestJson(
                  joinUrl(this.connection.base_url, `${endpoint}?${query.toString()}`),
                  { headers: this.apiKeyHeaders(configuredEntry), retries: 1 }
                )
              : await this.authenticatedRequest(`${endpoint}?${query.toString()}`, { retries: 1 });
            const extracted = extractItems(response.data);
            if (extracted.hasTotal) {
              total = extracted.total;
              hasTotal = true;
            }
            rows.push(...extracted.items.slice(0, perKeyLimit - rows.length));
            if (
              extracted.items.length === 0 ||
              extracted.items.length < pageSize ||
              (extracted.hasTotal && rows.length >= extracted.total)
            ) break;
          }
          const items = rows.map((row) => normalizeRequestLog(row, key, {
            validateRemoteKeyId: !gatewayApiKeyLogs
          })).filter(Boolean);
          const truncated = rows.length >= perKeyLimit && (!hasTotal || Number(total) > rows.length);
          results[index] = {
            ok: true,
            items,
            coverage: {
              remoteKeyId,
              status: 'succeeded',
              coverageFrom,
              coverageTo,
              truncated,
              total: hasTotal ? total : rows.length,
              errorCode: null,
              errorMessage: null
            }
          };
        } catch (error) {
          results[index] = {
            ok: false,
            error,
            items: [],
            coverage: {
              remoteKeyId,
              status: 'unavailable',
              coverageFrom: null,
              coverageTo: null,
              truncated: false,
              total: null,
              errorCode: error?.code || 'REQUEST_LOG_UNAVAILABLE',
              errorMessage: String(error?.message || 'Sub2API request logs are unavailable')
            }
          };
        }
      }
    });
    await Promise.all(workers);

    for (const key of requestedKeys.slice(queryableKeys.length)) {
      results.push({
        ok: false,
        items: [],
        coverage: {
          remoteKeyId: String(key.remoteId),
          status: 'unavailable',
          coverageFrom: null,
          coverageTo: null,
          truncated: false,
          total: null,
          errorCode: 'REQUEST_LOG_KEY_LIMIT',
          errorMessage: 'The configured request-log record limit is lower than the number of monitored keys'
        }
      });
    }

    const successful = results.filter((result) => result?.ok);
    if (successful.length === 0) {
      throw results.find((result) => result?.error)?.error || new AppError(
        'REQUEST_LOG_UNAVAILABLE',
        'Sub2API request logs are unavailable for every monitored API Key',
        { status: 502 }
      );
    }
    const items = successful.flatMap((result) => result.items);
    const keyCoverage = results.map((result) => result.coverage);
    return {
      items,
      total: keyCoverage.reduce((sum, item) => sum + (Number(item.total) || 0), 0),
      truncated: keyCoverage.some((item) => item.truncated || item.status !== 'succeeded'),
      coverageFrom,
      coverageTo,
      keyCoverage
    };
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
      groupsComplete: this.groupListComplete !== false,
      source: channels.length > 0 ? 'sub2api_channels' : 'sub2api_group_rates',
      status: prices.size > 0 ? 'succeeded' : 'partial',
      warning
    };
  }
}

module.exports = {
  Sub2ApiAdapter,
  configuredApiKey,
  decodeJwtExpiration,
  gatewayKeyStatus,
  gatewayQuota,
  translateSub2ApiAuthError,
  usesApiKey,
  usesTokenPair
};
