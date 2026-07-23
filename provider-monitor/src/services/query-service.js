const { parseJson } = require('../db');

function nullableNumber(value) {
  return value == null ? null : Number(value);
}

function balanceStatus(row, config) {
  if (!row.last_success_at) return 'unknown';
  if (row.last_error_code) return 'error';
  if (Date.now() - Date.parse(row.captured_at) > config.staleAfterMinutes * 60000) {
    return 'stale';
  }
  if (
    row.secondary_warning_threshold != null &&
    row.available != null &&
    Number(row.available) <= Number(row.secondary_warning_threshold) &&
    (!row.threshold_currency || row.threshold_currency === row.currency)
  ) {
    return 'error';
  }
  if (
    row.warning_threshold != null &&
    row.available != null &&
    Number(row.available) <= Number(row.warning_threshold) &&
    (!row.threshold_currency || row.threshold_currency === row.currency)
  ) {
    return 'warning';
  }
  return 'healthy';
}

class QueryService {
  constructor(db, config) {
    this.db = db;
    this.config = config;
  }

  summary() {
    const latest = this.db.prepare(`
      WITH ranked AS (
        SELECT s.*, ROW_NUMBER() OVER (
          PARTITION BY s.connection_id, s.subject_type, s.subject_id, s.currency
          ORDER BY s.captured_at DESC, s.id DESC
        ) AS row_number
        FROM balance_snapshots s
        WHERE s.subject_type = 'account'
      )
      SELECT p.id AS connection_id, p.name, p.adapter_type, p.base_url,
        p.account_dedupe_key, p.warning_threshold, p.secondary_warning_threshold, p.threshold_currency,
        p.last_sync_at, p.last_success_at, p.last_error_code, p.last_error_message,
        r.subject_id, r.currency, r.available, r.total, r.used, r.frozen,
        r.unlimited, r.captured_at
      FROM provider_connections p
      LEFT JOIN ranked r ON r.connection_id = p.id AND r.row_number = 1
      WHERE p.enabled = 1
      ORDER BY p.name COLLATE NOCASE, r.currency
    `).all();

    const accounts = [];
    const deduped = new Map();
    for (const row of latest) {
      const item = {
        connectionId: row.connection_id,
        name: row.name,
        adapterType: row.adapter_type,
        baseUrl: row.base_url,
        currency: row.currency || row.threshold_currency || 'USD',
        available: nullableNumber(row.available),
        total: nullableNumber(row.total),
        used: nullableNumber(row.used),
        frozen: nullableNumber(row.frozen),
        unlimited: Boolean(row.unlimited),
        capturedAt: row.captured_at,
        lastSuccessAt: row.last_success_at,
        lastErrorCode: row.last_error_code,
        lastErrorMessage: row.last_error_message,
        status: balanceStatus(row, this.config)
      };
      const key = `${row.account_dedupe_key || row.connection_id}:${item.currency}`;
      const previous = deduped.get(key);
      if (!previous || Date.parse(item.capturedAt || 0) > Date.parse(previous.capturedAt || 0)) {
        deduped.set(key, item);
      }
    }
    accounts.push(...deduped.values());

    const counts = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM provider_connections WHERE enabled = 1) AS providers,
        (SELECT COUNT(*) FROM remote_keys k JOIN provider_connections p ON p.id = k.connection_id
          WHERE p.enabled = 1 AND k.status NOT IN ('missing', 'disabled')) AS active_keys,
        (SELECT COUNT(*) FROM remote_groups g JOIN provider_connections p ON p.id = g.connection_id
          WHERE p.enabled = 1 AND g.status != 'missing') AS groups,
        (SELECT COUNT(*) FROM alert_events WHERE status IN ('active', 'acknowledged')) AS active_alerts
    `).get();
    const severity = { error: 5, warning: 4, stale: 3, unknown: 2, healthy: 1 };
    const providerStatuses = new Map();
    for (const item of accounts) {
      const previous = providerStatuses.get(item.connectionId);
      if (!previous || severity[item.status] > severity[previous]) {
        providerStatuses.set(item.connectionId, item.status);
      }
    }
    const statusCounts = [...providerStatuses.values()].reduce((result, status) => {
      result[status] = (result[status] || 0) + 1;
      return result;
    }, {});

    const totalsByCurrency = {};
    for (const account of accounts) {
      if (account.available == null || account.unlimited) continue;
      totalsByCurrency[account.currency] =
        (totalsByCurrency[account.currency] || 0) + account.available;
    }
    const budgets = this.db.prepare(`
      WITH ranked AS (
        SELECT s.*, ROW_NUMBER() OVER (
          PARTITION BY s.connection_id, s.subject_type, s.subject_id, s.currency
          ORDER BY s.captured_at DESC, s.id DESC
        ) row_number
        FROM balance_snapshots s WHERE s.subject_type IN ('key', 'team')
      )
      SELECT r.*, p.name provider_name, k.name key_name, g.name group_name
      FROM ranked r JOIN provider_connections p ON p.id = r.connection_id
      LEFT JOIN remote_keys k ON r.subject_type = 'key' AND k.id = r.subject_id
      LEFT JOIN remote_groups g ON r.subject_type = 'team' AND g.id = r.subject_id
      WHERE r.row_number = 1 AND p.enabled = 1 ORDER BY r.subject_type, p.name
    `).all().map((row) => ({
      connectionId: row.connection_id,
      providerName: row.provider_name,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      name: row.key_name || row.group_name || row.subject_id,
      currency: row.currency,
      available: nullableNumber(row.available),
      total: nullableNumber(row.total),
      used: nullableNumber(row.used),
      unlimited: Boolean(row.unlimited),
      capturedAt: row.captured_at,
      status: Date.now() - Date.parse(row.captured_at) > this.config.staleAfterMinutes * 60000
        ? 'stale' : !row.unlimited && row.available != null && Number(row.available) <= 0 ? 'warning' : 'healthy'
    }));
    return {
      generatedAt: new Date().toISOString(),
      counts: {
        providers: counts.providers,
        activeKeys: counts.active_keys,
        groups: counts.groups,
        activeAlerts: counts.active_alerts,
        ...statusCounts
      },
      totalsByCurrency,
      accounts,
      budgets
    };
  }

  providerAssets(connectionId) {
    const account = this.db.prepare(`
      SELECT * FROM remote_accounts WHERE connection_id = ? ORDER BY last_seen_at DESC LIMIT 1
    `).get(connectionId);
    const balances = this.db.prepare(`
      WITH ranked AS (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY subject_type, subject_id, currency ORDER BY captured_at DESC, id DESC
        ) row_number
        FROM balance_snapshots WHERE connection_id = ?
      ) SELECT * FROM ranked WHERE row_number = 1 ORDER BY subject_type, currency
    `).all(connectionId).map((row) => ({ ...row, unlimited: Boolean(row.unlimited), raw: parseJson(row.raw_json, {}), raw_json: undefined }));
    return {
      account: account
        ? { ...account, metadata: parseJson(account.metadata_json, {}), metadata_json: undefined }
        : null,
      balances,
      groups: this.groups(connectionId),
      keys: this.keys({ connectionId }),
      recentChecks: this.checkRuns({ connectionId, limit: 10 })
    };
  }

  keys(filters = {}) {
    const clauses = [];
    const params = [];
    if (filters.connectionId) {
      clauses.push('k.connection_id = ?');
      params.push(filters.connectionId);
    }
    if (filters.status) {
      clauses.push('k.status = ?');
      params.push(filters.status);
    }
    if (filters.group) {
      clauses.push('(k.primary_group_ref = ? OR k.backup_group_ref = ? OR g.name = ?)');
      params.push(filters.group, filters.group, filters.group);
    }
    if (filters.search) {
      clauses.push('(k.name LIKE ? OR k.masked_key LIKE ? OR p.name LIKE ?)');
      const query = `%${filters.search}%`;
      params.push(query, query, query);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`
      SELECT k.*, p.name AS provider_name,
        GROUP_CONCAT(DISTINCT g.name) AS additional_groups,
        h.status AS health_status, h.level AS health_level,
        h.latency_ms AS health_latency_ms, h.checked_at AS health_checked_at,
        h.error_code AS health_error_code
      FROM remote_keys k
      JOIN provider_connections p ON p.id = k.connection_id
      LEFT JOIN remote_key_groups kg ON kg.key_id = k.id
      LEFT JOIN remote_groups g ON g.id = kg.group_id
      LEFT JOIN key_health_checks h ON h.id = (
        SELECT id FROM key_health_checks latest WHERE latest.key_id = k.id
        ORDER BY latest.checked_at DESC LIMIT 1
      )
      ${where}
      GROUP BY k.id
      ORDER BY p.name COLLATE NOCASE, k.name COLLATE NOCASE
      LIMIT 2000
    `).all(...params).map((row) => ({
      ...row,
      unlimited: Boolean(row.unlimited),
      metadata: parseJson(row.metadata_json, {}),
      metadata_json: undefined,
      additionalGroups: row.additional_groups ? row.additional_groups.split(',') : [],
      additional_groups: undefined
    }));
  }

  groups(connectionId = null) {
    const where = connectionId ? 'WHERE g.connection_id = ?' : '';
    const params = connectionId ? [connectionId] : [];
    return this.db.prepare(`
      SELECT g.*, p.name AS provider_name, COUNT(DISTINCT kg.key_id) AS key_count
      FROM remote_groups g
      JOIN provider_connections p ON p.id = g.connection_id
      LEFT JOIN remote_key_groups kg ON kg.group_id = g.id
      ${where}
      GROUP BY g.id
      ORDER BY p.name COLLATE NOCASE, g.name COLLATE NOCASE
    `).all(...params).map((row) => ({
      ...row,
      metadata: parseJson(row.metadata_json, {}),
      metadata_json: undefined
    }));
  }

  history({ connectionId, currency, days = 30, subjectType = 'account' }) {
    const since = new Date(Date.now() - Math.min(3650, Math.max(1, days)) * 86400000).toISOString();
    const clauses = ['subject_type = ?', 'captured_at >= ?'];
    const params = [subjectType, since];
    if (connectionId) {
      clauses.push('connection_id = ?');
      params.push(connectionId);
    }
    if (currency) {
      clauses.push('currency = ?');
      params.push(currency);
    }
    return this.db.prepare(`
      WITH combined AS (
        SELECT connection_id, subject_type, subject_id, currency, available, total, used,
          unlimited, captured_at, 'raw' granularity FROM balance_snapshots
        UNION ALL
        SELECT connection_id, subject_type, subject_id, currency, available, total, used,
          unlimited, captured_at, granularity FROM balance_aggregates
      )
      SELECT connection_id, subject_id, currency, available, total, used, unlimited,
        captured_at, granularity FROM combined
      WHERE ${clauses.join(' AND ')}
      ORDER BY captured_at ASC
      LIMIT 20000
    `).all(...params).map((row) => ({ ...row, unlimited: Boolean(row.unlimited) }));
  }

  forecast(connectionId, currency = 'USD', days = 14) {
    const since = new Date(Date.now() - Math.min(90, Math.max(2, days)) * 86400000).toISOString();
    const rows = this.history({ connectionId, currency, days, subjectType: 'account' })
      .filter((row) => row.available != null && row.captured_at >= since);
    if (rows.length < 3) {
      return { currency, dailyBurn: null, runwayDays: null, confidence: 'insufficient_data' };
    }
    const first = rows[0];
    const last = rows[rows.length - 1];
    const elapsedDays = (Date.parse(last.captured_at) - Date.parse(first.captured_at)) / 86400000;
    const minSpanRow = this.db.prepare(`SELECT value_json FROM settings WHERE key = 'forecastMinSpanHours'`).get();
    const minimumSpanDays = Number(parseJson(minSpanRow?.value_json, 12)) / 24;
    if (elapsedDays < minimumSpanDays) {
      return { currency, dailyBurn: null, runwayDays: null, confidence: 'insufficient_span', sampleCount: rows.length, elapsedDays };
    }
    if (Date.now() - Date.parse(last.captured_at) > this.config.staleAfterMinutes * 60000) {
      return { currency, dailyBurn: null, runwayDays: null, confidence: 'stale_data', sampleCount: rows.length };
    }
    const intervalRates = [];
    for (let index = 1; index < rows.length; index += 1) {
      const older = rows[index - 1];
      const newer = rows[index];
      const intervalDays = (Date.parse(newer.captured_at) - Date.parse(older.captured_at)) / 86400000;
      if (intervalDays > 0) intervalRates.push(Math.max(0, (Number(older.available) - Number(newer.available)) / intervalDays));
    }
    const sorted = intervalRates.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
    const median = sorted.length % 2
      ? sorted[Math.floor(sorted.length / 2)]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    const deviations = sorted.map((value) => Math.abs(value - median)).sort((a, b) => a - b);
    const mad = deviations[Math.floor(deviations.length / 2)] || 0;
    const robustRates = sorted.filter((value) => mad === 0 || Math.abs(value - median) <= mad * 3);
    const robustDailyBurn = robustRates.length
      ? robustRates.reduce((sum, value) => sum + value, 0) / robustRates.length
      : 0;
    const linearDailyBurn = Math.max(0, (Number(first.available) - Number(last.available)) / elapsedDays);
    const recentStart = new Date(Date.parse(last.captured_at) - 7 * 86400000).toISOString();
    const recent = rows.filter((row) => row.captured_at >= recentStart);
    const movingAverageDailyBurn = recent.length >= 2
      ? Math.max(0, (Number(recent[0].available) - Number(recent[recent.length - 1].available)) /
          Math.max((Date.parse(recent[recent.length - 1].captured_at) - Date.parse(recent[0].captured_at)) / 86400000, 0.0001))
      : linearDailyBurn;
    const dailyBurn = robustDailyBurn || movingAverageDailyBurn || linearDailyBurn;
    return {
      currency,
      dailyBurn,
      runwayDays: dailyBurn > 0 ? Number(last.available) / dailyBurn : null,
      currentAvailable: Number(last.available),
      sampleCount: rows.length,
      from: first.captured_at,
      to: last.captured_at,
      methods: { linearDailyBurn, movingAverageDailyBurn, robustDailyBurn },
      confidence: rows.length >= 14 && elapsedDays >= 7 ? 'high' : rows.length >= 7 && elapsedDays >= 3 ? 'medium' : 'low'
    };
  }

  burnRates(connectionId, currency = 'USD', days = 30) {
    const rows = this.history({ connectionId, currency, days, subjectType: 'account' });
    const intervals = [];
    for (let index = 1; index < rows.length; index += 1) {
      const previous = rows[index - 1];
      const current = rows[index];
      if (previous.available == null || current.available == null) continue;
      const hours = (Date.parse(current.captured_at) - Date.parse(previous.captured_at)) / 3600000;
      if (hours <= 0) continue;
      intervals.push({
        at: current.captured_at,
        hourly: Math.max(0, Number(previous.available) - Number(current.available)) / hours
      });
    }
    const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    const now = Date.now();
    const lastHour = intervals.filter((item) => Date.parse(item.at) >= now - 3600000).map((item) => item.hourly);
    const lastDay = intervals.filter((item) => Date.parse(item.at) >= now - 86400000).map((item) => item.hourly);
    const lastWeek = intervals.filter((item) => Date.parse(item.at) >= now - 7 * 86400000).map((item) => item.hourly);
    const weekday = intervals.filter((item) => { const day = new Date(item.at).getUTCDay(); return day > 0 && day < 6; }).map((item) => item.hourly);
    const weekend = intervals.filter((item) => { const day = new Date(item.at).getUTCDay(); return day === 0 || day === 6; }).map((item) => item.hourly);
    return {
      currency,
      hourly1h: average(lastHour),
      hourly24h: average(lastDay),
      daily7d: average(lastWeek) == null ? null : average(lastWeek) * 24,
      weekdayDaily: average(weekday) == null ? null : average(weekday) * 24,
      weekendDaily: average(weekend) == null ? null : average(weekend) * 24,
      peakHourly: intervals.length ? Math.max(...intervals.map((item) => item.hourly)) : null,
      samples: intervals.length
    };
  }

  usageHistory({ connectionId, days = 30 }) {
    const since = new Date(Date.now() - Math.min(3650, Math.max(1, days)) * 86400000).toISOString();
    const params = [since];
    const where = connectionId ? 'AND connection_id = ?' : '';
    if (connectionId) params.push(connectionId);
    return this.db.prepare(`
      WITH combined AS (
        SELECT id, connection_id, subject_type, subject_id, currency, cost, requests,
          input_tokens, output_tokens, total_tokens, model, period, raw_json,
          captured_at, 'raw' granularity FROM usage_snapshots
        UNION ALL
        SELECT id, connection_id, subject_type, subject_id, currency, cost, requests,
          input_tokens, output_tokens, total_tokens, model, period, raw_json,
          captured_at, granularity FROM usage_aggregates
      )
      SELECT * FROM combined WHERE captured_at >= ? ${where}
      ORDER BY captured_at ASC LIMIT 20000
    `).all(...params).map((row) => ({ ...row, raw: parseJson(row.raw_json, {}), raw_json: undefined }));
  }

  checkRuns({ connectionId, limit = 50 } = {}) {
    const safeLimit = Math.min(500, Math.max(1, Number(limit) || 50));
    const rows = connectionId
      ? this.db.prepare(`SELECT * FROM check_runs WHERE connection_id = ? ORDER BY started_at DESC LIMIT ?`).all(connectionId, safeLimit)
      : this.db.prepare(`SELECT * FROM check_runs ORDER BY started_at DESC LIMIT ?`).all(safeLimit);
    return rows.map((row) => ({ ...row, summary: parseJson(row.summary_json, {}), summary_json: undefined }));
  }
}

module.exports = {
  QueryService,
  balanceStatus
};
