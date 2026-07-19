const crypto = require('crypto');
const { createAdapter } = require('../adapters/registry');
const { nowIso, parseJson, stringifyJson } = require('../db');
const { AppError } = require('../errors');
const { upsertGroups } = require('./group-store');

class CatalogService {
  constructor({ db, config, providers, http, queries }) {
    this.db = db;
    this.config = config;
    this.providers = providers;
    this.http = http;
    this.queries = queries;
  }

  async sync(connectionId) {
    const connection = this.providers.get(connectionId, { forAdapter: true });
    const adapter = createAdapter(connection.adapter_type, {
      connection,
      credentials: this.providers.getCredentials(connection),
      http: this.http,
      config: this.config,
      onCredentialsUpdated: async (credentials) => this.providers.updateCredentials(connection, credentials)
    });
    if (!adapter.capabilities().priceCatalog) {
      throw new AppError('CAPABILITY_UNSUPPORTED', `${connection.name} does not support price catalog synchronization`, {
        status: 409
      });
    }
    const catalog = await adapter.getPriceCatalog();
    const models = Array.isArray(catalog) ? [] : catalog.models || [];
    const prices = Array.isArray(catalog) ? catalog : catalog.prices || [];
    const groups = Array.isArray(catalog) ? [] : catalog.groups || [];
    const capturedAt = nowIso();
    this.db.transaction(() => {
      if (groups.length > 0 || catalog.groupsComplete) {
        upsertGroups(this.db, connectionId, groups, capturedAt, {
          complete: Boolean(catalog.groupsComplete)
        });
      }
      const upsertModel = this.db.prepare(`
        INSERT INTO remote_models(
          id, connection_id, remote_id, name, vendor, context_length,
          capabilities_json, metadata_json, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(connection_id, remote_id) DO UPDATE SET name = excluded.name,
          vendor = excluded.vendor, context_length = excluded.context_length,
          capabilities_json = excluded.capabilities_json, metadata_json = excluded.metadata_json,
          last_seen_at = excluded.last_seen_at
      `);
      for (const model of models) {
        upsertModel.run(crypto.randomUUID(), connectionId, String(model.remoteId), model.name || String(model.remoteId), model.vendor || null, model.contextLength ?? null, stringifyJson(model.capabilities || {}), stringifyJson(model.metadata || {}), capturedAt, capturedAt);
      }
      const insertPrice = this.db.prepare(`
        INSERT INTO model_prices(
          connection_id, model_id, group_ref, currency, billing_mode,
          input_per_million, output_per_million, cache_read_per_million,
          cache_write_per_million, request_price, image_price, audio_price,
          raw_json, captured_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const price of prices) {
        insertPrice.run(connectionId, String(price.modelId), price.groupRef || null, price.currency || 'USD', price.billingMode || 'token', price.inputPerMillion ?? null, price.outputPerMillion ?? null, price.cacheReadPerMillion ?? null, price.cacheWritePerMillion ?? null, price.requestPrice ?? null, price.imagePrice ?? null, price.audioPrice ?? null, stringifyJson(price.raw || {}), capturedAt);
      }
    })();
    const groupRateCount = groups.filter((group) => group.ratio != null).length;
    return {
      connectionId,
      status: Array.isArray(catalog) ? 'succeeded' : catalog.status || 'succeeded',
      source: Array.isArray(catalog) ? connection.adapter_type : catalog.source || connection.adapter_type,
      modelCount: models.length,
      priceCount: prices.length,
      groupCount: groups.length,
      groupRateCount,
      warning: Array.isArray(catalog) ? null : catalog.warning || null,
      capturedAt
    };
  }

  prices({ connectionId, model, limit = 5000 } = {}) {
    const clauses = ['row_number = 1'];
    const params = [];
    if (connectionId) { clauses.push('connection_id = ?'); params.push(connectionId); }
    if (model) { clauses.push('model_id LIKE ?'); params.push(`%${model}%`); }
    params.push(Math.min(10000, Math.max(1, Number(limit) || 5000)));
    const settings = Object.fromEntries(this.db.prepare(`
      SELECT key, value_json FROM settings WHERE key IN ('displayCurrency', 'currencyRates')
    `).all().map((row) => [row.key, parseJson(row.value_json, null)]));
    const displayCurrency = settings.displayCurrency || 'USD';
    const rates = settings.currencyRates || { USD: 1 };
    return this.db.prepare(`
      WITH ranked AS (
        SELECT mp.*, p.name AS provider_name, p.adapter_type,
          ROW_NUMBER() OVER (
            PARTITION BY mp.connection_id, mp.model_id, COALESCE(mp.group_ref, ''), mp.currency
            ORDER BY mp.captured_at DESC, mp.id DESC
          ) row_number
        FROM model_prices mp JOIN provider_connections p ON p.id = mp.connection_id
      ) SELECT * FROM ranked WHERE ${clauses.join(' AND ')}
      ORDER BY model_id, input_per_million ASC LIMIT ?
    `).all(...params).map((row) => {
      const rate = row.currency === displayCurrency ? 1 : Number(rates[row.currency]);
      const normalize = (value) => value == null || !Number.isFinite(rate) ? null : Number(value) * rate;
      const raw = parseJson(row.raw_json, {});
      return {
        ...row,
        displayCurrency,
        effectiveInputPrice: normalize(row.input_per_million),
        effectiveOutputPrice: normalize(row.output_per_million),
        effectiveRequestPrice: normalize(row.request_price),
        groupName: raw.groupName || null,
        groupRatio: raw.groupRatio ?? null,
        channelName: raw.channelName || null,
        catalogSource: raw.source || row.adapter_type,
        raw,
        raw_json: undefined,
        row_number: undefined
      };
    });
  }

  comparisons(model) {
    const rows = this.prices({ model, limit: 1000 }).filter((row) => row.model_id === model);
    const maxPrice = Math.max(0, ...rows.map((row) => Number(row.effectiveInputPrice ?? row.effectiveRequestPrice ?? 0)));
    return rows.map((row) => {
      const provider = this.db.prepare(`SELECT last_error_code, last_success_at FROM provider_connections WHERE id = ?`).get(row.connection_id);
      const balance = this.db.prepare(`
        SELECT available FROM balance_snapshots WHERE connection_id = ? AND subject_type = 'account'
        ORDER BY captured_at DESC, id DESC LIMIT 1
      `).get(row.connection_id)?.available;
      const price = Number(row.effectiveInputPrice ?? row.effectiveRequestPrice ?? 0);
      const healthScore = provider.last_error_code ? 25 : provider.last_success_at ? 100 : 50;
      const priceScore = maxPrice > 0 ? Math.max(0, 100 - (price / maxPrice) * 100) : 50;
      const balanceScore = balance == null ? 40 : Number(balance) > 20 ? 100 : Number(balance) > 5 ? 70 : 30;
      return { ...row, effectivePrice: price, availableBalance: balance ?? null, healthScore, recommendationScore: healthScore * 0.45 + priceScore * 0.35 + balanceScore * 0.2 };
    }).sort((a, b) => b.recommendationScore - a.recommendationScore);
  }

  models(connectionId = null) {
    const rows = connectionId
      ? this.db.prepare(`SELECT * FROM remote_models WHERE connection_id = ? ORDER BY name`).all(connectionId)
      : this.db.prepare(`SELECT * FROM remote_models ORDER BY name`).all();
    return rows.map((row) => ({ ...row, capabilities: parseJson(row.capabilities_json, {}), metadata: parseJson(row.metadata_json, {}), capabilities_json: undefined, metadata_json: undefined }));
  }
}

module.exports = { CatalogService };
