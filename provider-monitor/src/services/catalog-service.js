const crypto = require('crypto');
const { createAdapter } = require('../adapters/registry');
const { nowIso, parseJson, stringifyJson } = require('../db');
const { AppError } = require('../errors');
const { resolvePagination } = require('../pagination');
const { availablePriceGroupSql } = require('./group-availability');
const { upsertGroups } = require('./group-store');

function normalizeRateSort(value) {
  return value === 'asc' || value === 'desc' ? value : '';
}

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

  prices({ connectionId, model, platform, rateSort, limit = 5000, page, pageSize } = {}) {
    const clauses = ['row_number = 1', 'group_available = 1'];
    const params = [];
    if (connectionId) { clauses.push('connection_id = ?'); params.push(connectionId); }
    if (model) { clauses.push('model_id LIKE ?'); params.push(`%${model}%`); }
    if (platform) { clauses.push('platform = ? COLLATE NOCASE'); params.push(platform); }
    const paginated = page != null || pageSize != null;
    const settings = Object.fromEntries(this.db.prepare(`
      SELECT key, value_json FROM settings WHERE key IN ('displayCurrency', 'currencyRates')
    `).all().map((row) => [row.key, parseJson(row.value_json, null)]));
    const displayCurrency = settings.displayCurrency || 'USD';
    const rates = settings.currencyRates || { USD: 1 };
    const rechargeMultiplierSql = `CASE
      WHEN rr.manual_multiplier > 0 THEN rr.manual_multiplier
      WHEN rr.detected_multiplier > 0 THEN rr.detected_multiplier
      ELSE 1
    END`;
    const rankedSql = `
      WITH enriched AS (
        SELECT mp.*, p.name AS provider_name, p.adapter_type,
          COALESCE(
            NULLIF(TRIM(CAST(json_extract(mp.raw_json, '$.platform') AS TEXT)), ''),
            NULLIF(TRIM(rm.vendor), ''),
            NULLIF(TRIM(CAST(json_extract(rm.metadata_json, '$.platform') AS TEXT)), ''),
            p.adapter_type
          ) AS platform,
          COALESCE(
            CAST(json_extract(mp.raw_json, '$.groupRatio') AS REAL),
            (
              SELECT g.ratio FROM remote_groups g
              WHERE g.connection_id = mp.connection_id AND g.remote_id = mp.group_ref
              ORDER BY g.last_seen_at DESC, g.id LIMIT 1
            )
          ) AS group_ratio,
          ${rechargeMultiplierSql} AS recharge_multiplier,
          CASE
            WHEN rr.manual_multiplier > 0 THEN 'manual'
            WHEN rr.detected_multiplier > 0 THEN rr.detection_source
            ELSE 'default'
          END AS recharge_source,
          CASE
            WHEN rr.manual_multiplier > 0 THEN 'manual'
            WHEN rr.detected_multiplier > 0 THEN COALESCE(rr.status, 'unknown')
            ELSE 'default'
          END AS recharge_status,
          rr.paid_currency AS recharge_paid_currency,
          rr.balance_currency AS recharge_balance_currency,
          ${availablePriceGroupSql('mp')} AS group_available
        FROM model_prices mp JOIN provider_connections p ON p.id = mp.connection_id
        LEFT JOIN remote_models rm
          ON rm.connection_id = mp.connection_id AND rm.remote_id = mp.model_id
        LEFT JOIN provider_recharge_rates rr ON rr.connection_id = mp.connection_id
      ), ranked AS (
        SELECT enriched.*,
          CASE WHEN group_ratio IS NULL THEN NULL
            ELSE group_ratio / recharge_multiplier END AS composite_rate,
          ROW_NUMBER() OVER (
            PARTITION BY connection_id, model_id, COALESCE(group_ref, ''), currency
            ORDER BY captured_at DESC, id DESC
          ) row_number
        FROM enriched
      )`;
    const normalizedRateSort = normalizeRateSort(rateSort);
    const orderBy = normalizedRateSort
      ? `composite_rate IS NULL, composite_rate ${normalizedRateSort.toUpperCase()},
        group_ratio ${normalizedRateSort.toUpperCase()}, model_id COLLATE NOCASE,
        connection_id, COALESCE(group_ref, ''), id DESC`
      : `model_id COLLATE NOCASE, input_per_million ASC,
        connection_id, COALESCE(group_ref, ''), id DESC`;
    let rows;
    let pagination;
    let summary;
    let filterOptions;
    if (paginated) {
      const optionClauses = ['row_number = 1', 'group_available = 1'];
      const optionParams = [];
      if (model) { optionClauses.push('model_id LIKE ?'); optionParams.push(`%${model}%`); }
      filterOptions = {
        providers: this.db.prepare(`
          ${rankedSql}
          SELECT DISTINCT connection_id AS id, provider_name AS name
          FROM ranked WHERE ${optionClauses.join(' AND ')}
          ORDER BY provider_name COLLATE NOCASE, connection_id
        `).all(...optionParams),
        platforms: this.db.prepare(`
          ${rankedSql}
          SELECT DISTINCT platform FROM ranked
          WHERE ${optionClauses.join(' AND ')} AND platform IS NOT NULL AND platform != ''
          ORDER BY platform COLLATE NOCASE
        `).all(...optionParams).map((row) => row.platform)
      };
      const totals = this.db.prepare(`
        ${rankedSql}
        SELECT COUNT(*) AS total, COUNT(DISTINCT model_id) AS models
        FROM ranked WHERE ${clauses.join(' AND ')}
      `).get(...params);
      const resolved = resolvePagination({ page, pageSize, total: totals.total });
      pagination = resolved.pagination;
      summary = { models: Number(totals.models || 0) };
      rows = this.db.prepare(`
        ${rankedSql}
        SELECT * FROM ranked WHERE ${clauses.join(' AND ')}
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?
      `).all(...params, resolved.limit, resolved.offset);
    } else {
      rows = this.db.prepare(`
        ${rankedSql}
        SELECT * FROM ranked WHERE ${clauses.join(' AND ')}
        ORDER BY ${orderBy}
        LIMIT ?
      `).all(...params, Math.min(10000, Math.max(1, Number(limit) || 5000)));
    }
    const items = rows.map((row) => {
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
        groupRatio: row.group_ratio == null ? null : Number(row.group_ratio),
        compositeRate: row.composite_rate == null ? null : Number(row.composite_rate),
        recharge: {
          multiplier: Number(row.recharge_multiplier),
          source: row.recharge_source || null,
          status: row.recharge_status || null,
          paidCurrency: row.recharge_paid_currency || null,
          balanceCurrency: row.recharge_balance_currency || null
        },
        channelName: raw.channelName || null,
        catalogSource: raw.source || row.adapter_type,
        raw,
        raw_json: undefined,
        group_ratio: undefined,
        composite_rate: undefined,
        recharge_multiplier: undefined,
        recharge_source: undefined,
        recharge_status: undefined,
        recharge_paid_currency: undefined,
        recharge_balance_currency: undefined,
        group_available: undefined,
        row_number: undefined
      };
    });
    return paginated ? { items, pagination, summary, filterOptions } : items;
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

  modelOptions({ query = '', limit = 50 } = {}) {
    const search = String(query || '').trim();
    const source = `
      SELECT model_id AS name FROM model_prices
      UNION
      SELECT name FROM remote_models
    `;
    const where = search ? 'WHERE name LIKE ? COLLATE NOCASE' : '';
    const params = search ? [`%${search}%`] : [];
    const total = this.db.prepare(`SELECT COUNT(*) AS total FROM (${source}) models ${where}`).get(...params).total;
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
    const items = this.db.prepare(`
      SELECT name FROM (${source}) models ${where}
      ORDER BY name COLLATE NOCASE
      LIMIT ?
    `).all(...params, safeLimit);
    return { items, total: Number(total || 0) };
  }
}

module.exports = { CatalogService };
