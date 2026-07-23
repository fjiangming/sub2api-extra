const { AppError } = require('../errors');
const { redact, maskKey } = require('../security/redaction');

function joinUrl(baseUrl, endpoint) {
  return new URL(endpoint, `${baseUrl.replace(/\/+$/, '')}/`).toString();
}

function toFiniteNumber(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toIsoDate(value) {
  if (value == null || value === '' || value === -1 || value === 0) return null;
  const numeric = Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 1e12 ? numeric * 1000 : numeric)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function unwrapEnvelope(payload, options = {}) {
  if (payload == null) {
    if (options.allowNull) return null;
    throw new AppError('SCHEMA_MISMATCH', 'Provider returned an empty response', {
      status: 502
    });
  }

  if (payload.success === false) {
    throw new AppError('BUSINESS_ERROR', payload.message || 'Provider reported a business error', {
      status: 502,
      details: { remoteCode: payload.code ?? null }
    });
  }
  if (typeof payload.code === 'number' && payload.code !== 0 && payload.code !== 200) {
    throw new AppError('BUSINESS_ERROR', payload.message || 'Provider reported a business error', {
      status: payload.code === 401 ? 401 : 502,
      details: { remoteCode: payload.code }
    });
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'data')) return payload.data;
  return payload;
}

function extractItems(payload) {
  const data = unwrapEnvelope(payload, { allowNull: true });
  if (Array.isArray(data)) return { items: data, total: data.length, hasTotal: false };
  if (!data || typeof data !== 'object') return { items: [], total: 0, hasTotal: false };
  const items =
    data.items ||
    data.list ||
    data.records ||
    data.data ||
    data.tokens ||
    data.keys ||
    [];
  const rawTotal = data.total ?? data.count ?? data.total_count;
  return {
    items: Array.isArray(items) ? items : [],
    total: toFiniteNumber(rawTotal, Array.isArray(items) ? items.length : 0),
    hasTotal: rawTotal != null
  };
}

class ProviderAdapter {
  constructor(context) {
    this.connection = context.connection;
    this.credentials = context.credentials || {};
    this.http = context.http;
    this.config = context.config;
    this.onCredentialsUpdated = context.onCredentialsUpdated || (async () => {});
  }

  get type() {
    return this.connection.adapter_type;
  }

  capabilities() {
    return {
      accountBalance: false,
      multiCurrencyBalance: false,
      listKeys: false,
      revealKey: false,
      keyQuota: false,
      listGroups: false,
      keyGroup: false,
      backupGroup: false,
      groupsDerivedFromKeys: false,
      usageHistory: false,
      priceCatalog: false,
      rechargeQuote: false,
      dynamicRouteRates: false,
      checkIn: false,
      credentialRefresh: false,
      writeOperations: false
    };
  }

  async probe() {
    return {
      adapterType: this.type,
      detectedFamily: this.type,
      version: null,
      capabilities: this.capabilities()
    };
  }

  async validateCredentials() {
    await this.getAccount();
    return true;
  }

  async getAccount() {
    return {
      remoteId: this.connection.remote_user_id || this.connection.account_dedupe_key || this.connection.id,
      displayName: this.connection.name,
      userGroup: null,
      status: 'active',
      metadata: {}
    };
  }

  async getAccountBalances() {
    return [];
  }

  async listGroups() {
    return [];
  }

  async listKeys() {
    return [];
  }

  async getUsage() {
    return [];
  }

  async getDynamicRouteRates() {
    return [];
  }

  async getPriceCatalog() {
    return [];
  }

  async getRechargeQuote() {
    return null;
  }

  async getCheckInStatus() {
    return { supported: false, checkedInToday: null };
  }

  async checkIn() {
    throw new AppError('CAPABILITY_UNSUPPORTED', 'Provider does not support automated check-in', {
      status: 404
    });
  }

  safeRaw(value) {
    return redact(value);
  }

  maskKey(value) {
    return maskKey(value);
  }
}

module.exports = {
  ProviderAdapter,
  joinUrl,
  toFiniteNumber,
  toIsoDate,
  unwrapEnvelope,
  extractItems
};
