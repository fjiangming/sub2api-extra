const { JSONPath } = require('jsonpath-plus');
const { ProviderAdapter, joinUrl, toFiniteNumber, toIsoDate } = require('./base');
const { AppError } = require('../errors');

function firstJsonPath(json, path, fallback = null) {
  if (!path) return fallback;
  validateJsonPath(path);
  const result = JSONPath({ path, json, wrap: true, preventEval: true });
  return result.length ? result[0] : fallback;
}

function jsonPathItems(json, path) {
  if (!path) return Array.isArray(json) ? json : [json];
  validateJsonPath(path);
  return JSONPath({ path, json, wrap: true, preventEval: true }).flat().slice(0, 5000);
}

function validateJsonPath(path) {
  const value = String(path || '');
  if (value.length > 500 || !value.startsWith('$') || value.includes('?(') || value.includes('`')) {
    throw new AppError('CUSTOM_JSONPATH_BLOCKED', 'Custom JSONPath is invalid or uses blocked expressions', {
      status: 400
    });
  }
}

function booleanValue(value, fallback = false) {
  if (value == null) return fallback;
  if (typeof value === 'string') return !['false', '0', 'disabled', 'no'].includes(value.toLowerCase());
  return Boolean(value);
}

class CustomAdapter extends ProviderAdapter {
  capabilities() {
    const configured = this.connection.type_config_json?.capabilities || {};
    const requests = this.connection.type_config_json?.requests || {};
    return {
      ...super.capabilities(),
      accountBalance: Boolean(requests.accountBalance),
      listKeys: Boolean(requests.keys),
      keyQuota: Boolean(requests.keys),
      listGroups: Boolean(requests.groups),
      keyGroup: Boolean(requests.keys && requests.groups),
      usageHistory: Boolean(requests.usage),
      priceCatalog: Boolean(requests.prices),
      checkIn: Boolean(requests.checkInStatus && requests.checkIn),
      ...configured
    };
  }

  async execute(name) {
    const request = this.connection.type_config_json?.requests?.[name];
    if (!request) {
      throw new AppError('CAPABILITY_UNSUPPORTED', `Custom request ${name} is not configured`, {
        status: 404
      });
    }
    const method = String(request.method || 'GET').toUpperCase();
    if (!['GET', 'POST'].includes(method)) {
      throw new AppError('CUSTOM_METHOD_BLOCKED', 'Custom adapters only allow GET and POST', {
        status: 400
      });
    }
    const headers = {
      ...(this.credentials.customHeaders || {}),
      ...(request.headers || {})
    };
    if (this.credentials.apiKey && !headers.Authorization) {
      headers.Authorization = `Bearer ${this.credentials.apiKey}`;
    }
    const response = await this.http.requestJson(
      joinUrl(this.connection.base_url, request.path),
      {
        method,
        headers,
        body: method === 'POST' ? request.body || {} : undefined,
        maxResponseBytes: this.config.maxResponseBytes
      }
    );
    return { config: request, data: response.data };
  }

  async getAccount() {
    const configured = this.connection.type_config_json?.requests?.account;
    if (!configured) return super.getAccount();
    const { config, data } = await this.execute('account');
    return {
      remoteId: String(firstJsonPath(data, config.idJsonPath, this.connection.id)),
      displayName: String(
        firstJsonPath(data, config.nameJsonPath, this.connection.name)
      ),
      userGroup: firstJsonPath(data, config.groupJsonPath),
      status: String(firstJsonPath(data, config.statusJsonPath, 'active')),
      metadata: {}
    };
  }

  async getAccountBalances(account) {
    const { config, data } = await this.execute('accountBalance');
    const itemPath = config.balanceItemsJsonPath;
    const items = itemPath
      ? jsonPathItems(data, itemPath)
      : [data];
    return items.slice(0, 1000).map((item) => ({
      scope: 'account',
      remoteSubjectId: account?.remoteId || this.connection.id,
      currency: String(
        firstJsonPath(item, config.currencyJsonPath, config.defaultCurrency || 'USD')
      ),
      available: toFiniteNumber(firstJsonPath(item, config.availableJsonPath), 0),
      total: toFiniteNumber(firstJsonPath(item, config.totalJsonPath)),
      used: toFiniteNumber(firstJsonPath(item, config.usedJsonPath)),
      granted: toFiniteNumber(firstJsonPath(item, config.grantedJsonPath)),
      toppedUp: toFiniteNumber(firstJsonPath(item, config.toppedUpJsonPath)),
      frozen: toFiniteNumber(firstJsonPath(item, config.frozenJsonPath)),
      unlimited: Boolean(firstJsonPath(item, config.unlimitedJsonPath, false)),
      sourceField: config.availableJsonPath,
      raw: this.safeRaw(item)
    }));
  }

  async listGroups() {
    if (!this.connection.type_config_json?.requests?.groups) return super.listGroups();
    const { config, data } = await this.execute('groups');
    return jsonPathItems(data, config.itemsJsonPath).map((item, index) => {
      const remoteId = firstJsonPath(item, config.idJsonPath, index);
      return {
        remoteId: String(remoteId),
        type: String(firstJsonPath(item, config.typeJsonPath, config.defaultType || 'key_route_group')),
        name: String(firstJsonPath(item, config.nameJsonPath, remoteId)),
        ratio: toFiniteNumber(firstJsonPath(item, config.ratioJsonPath)),
        status: String(firstJsonPath(item, config.statusJsonPath, 'active')),
        metadata: this.safeRaw(item)
      };
    });
  }

  async listKeys() {
    if (!this.connection.type_config_json?.requests?.keys) return super.listKeys();
    const { config, data } = await this.execute('keys');
    return jsonPathItems(data, config.itemsJsonPath).map((item, index) => {
      const remoteId = firstJsonPath(item, config.idJsonPath, index);
      const unlimited = booleanValue(firstJsonPath(item, config.unlimitedJsonPath), false);
      const limit = toFiniteNumber(firstJsonPath(item, config.limitJsonPath));
      const used = toFiniteNumber(firstJsonPath(item, config.usedJsonPath));
      const explicitRemaining = toFiniteNumber(firstJsonPath(item, config.remainingJsonPath));
      const remaining = unlimited ? null : explicitRemaining ?? (limit == null || used == null ? null : Math.max(0, limit - used));
      const additional = firstJsonPath(item, config.additionalGroupsJsonPath, []);
      return {
        remoteId: String(remoteId),
        name: String(firstJsonPath(item, config.nameJsonPath, `Key ${index + 1}`)),
        maskedKey: String(firstJsonPath(item, config.maskedKeyJsonPath, '')),
        status: String(firstJsonPath(item, config.statusJsonPath, 'unknown')),
        primaryGroupRef: firstJsonPath(item, config.primaryGroupJsonPath),
        backupGroupRef: firstJsonPath(item, config.backupGroupJsonPath),
        additionalGroupRefs: Array.isArray(additional) ? additional.map(String) : [],
        quota: {
          currency: String(firstJsonPath(item, config.currencyJsonPath, config.defaultCurrency || 'USD')),
          limit: unlimited ? null : limit,
          used,
          remaining,
          unlimited,
          resetAt: toIsoDate(firstJsonPath(item, config.resetAtJsonPath)),
          resetInterval: firstJsonPath(item, config.resetIntervalJsonPath)
        },
        expiresAt: toIsoDate(firstJsonPath(item, config.expiresAtJsonPath)),
        lastUsedAt: toIsoDate(firstJsonPath(item, config.lastUsedAtJsonPath)),
        metadata: this.safeRaw(item)
      };
    });
  }

  async getUsage() {
    if (!this.connection.type_config_json?.requests?.usage) return super.getUsage();
    const { config, data } = await this.execute('usage');
    return jsonPathItems(data, config.itemsJsonPath).map((item) => ({
      scope: String(firstJsonPath(item, config.scopeJsonPath, 'account')),
      remoteSubjectId: firstJsonPath(item, config.subjectIdJsonPath),
      currency: String(firstJsonPath(item, config.currencyJsonPath, config.defaultCurrency || 'USD')),
      cost: toFiniteNumber(firstJsonPath(item, config.costJsonPath)),
      requests: toFiniteNumber(firstJsonPath(item, config.requestsJsonPath)),
      inputTokens: toFiniteNumber(firstJsonPath(item, config.inputTokensJsonPath)),
      outputTokens: toFiniteNumber(firstJsonPath(item, config.outputTokensJsonPath)),
      totalTokens: toFiniteNumber(firstJsonPath(item, config.totalTokensJsonPath)),
      model: firstJsonPath(item, config.modelJsonPath),
      period: String(firstJsonPath(item, config.periodJsonPath, config.defaultPeriod || 'cumulative')),
      raw: this.safeRaw(item)
    }));
  }

  async getPriceCatalog() {
    if (!this.connection.type_config_json?.requests?.prices) return super.getPriceCatalog();
    const { config, data } = await this.execute('prices');
    const rows = jsonPathItems(data, config.itemsJsonPath);
    const models = [];
    const prices = [];
    for (const item of rows) {
      const modelId = firstJsonPath(item, config.modelIdJsonPath);
      if (modelId == null) continue;
      models.push({
        remoteId: String(modelId),
        name: String(firstJsonPath(item, config.modelNameJsonPath, modelId)),
        vendor: firstJsonPath(item, config.vendorJsonPath),
        contextLength: toFiniteNumber(firstJsonPath(item, config.contextLengthJsonPath)),
        capabilities: {},
        metadata: this.safeRaw(item)
      });
      prices.push({
        modelId: String(modelId),
        groupRef: firstJsonPath(item, config.groupJsonPath),
        currency: String(firstJsonPath(item, config.currencyJsonPath, config.defaultCurrency || 'USD')),
        billingMode: String(firstJsonPath(item, config.billingModeJsonPath, 'token')),
        inputPerMillion: toFiniteNumber(firstJsonPath(item, config.inputPriceJsonPath)),
        outputPerMillion: toFiniteNumber(firstJsonPath(item, config.outputPriceJsonPath)),
        cacheReadPerMillion: toFiniteNumber(firstJsonPath(item, config.cacheReadPriceJsonPath)),
        cacheWritePerMillion: toFiniteNumber(firstJsonPath(item, config.cacheWritePriceJsonPath)),
        requestPrice: toFiniteNumber(firstJsonPath(item, config.requestPriceJsonPath)),
        imagePrice: toFiniteNumber(firstJsonPath(item, config.imagePriceJsonPath)),
        audioPrice: toFiniteNumber(firstJsonPath(item, config.audioPriceJsonPath)),
        raw: this.safeRaw(item)
      });
    }
    return { models, prices };
  }

  async getCheckInStatus() {
    if (!this.connection.type_config_json?.requests?.checkInStatus) return super.getCheckInStatus();
    const { config, data } = await this.execute('checkInStatus');
    return {
      supported: booleanValue(firstJsonPath(data, config.supportedJsonPath, true), true),
      checkedInToday: booleanValue(firstJsonPath(data, config.checkedInJsonPath), false),
      details: this.safeRaw(data)
    };
  }

  async checkIn() {
    if (!this.connection.type_config_json?.requests?.checkIn) return super.checkIn();
    const { config, data } = await this.execute('checkIn');
    return {
      status: String(firstJsonPath(data, config.statusJsonPath, 'succeeded')),
      rewardAmount: toFiniteNumber(firstJsonPath(data, config.rewardJsonPath)),
      currency: String(firstJsonPath(data, config.currencyJsonPath, config.defaultCurrency || 'USD')),
      details: this.safeRaw(data)
    };
  }
}

module.exports = {
  CustomAdapter,
  firstJsonPath,
  jsonPathItems,
  booleanValue,
  validateJsonPath
};
