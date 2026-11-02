const { createHmac } = require('crypto');
const { AppError } = require('../errors');
const { createAdapter } = require('../adapters/registry');
const { GrossProfitService } = require('./gross-profit-service');

const SOURCE = 'upstream_daily_summary';
const FAILURE_MESSAGES = {
  DAILY_SUMMARY_ACCOUNT_REQUIRED: '账号日汇总需要账号登录或用户 Token，API Key 凭据无法读取整个账号消费',
  CAPABILITY_UNSUPPORTED: '该供应商类型暂不支持账号日汇总',
  CAPTCHA_REQUIRED: '上游登录需要验证码，请在供应商监控更新用户 Token',
  MFA_REQUIRED: '上游登录需要二次认证，请更新用户 Token',
  AUTH_FAILED: '上游账号认证失败，请检查供应商凭据',
  AUTH_EXPIRED: '上游用户 Token 已过期，请更新供应商凭据',
  RATE_LIMITED: '上游日汇总请求被限流，请稍后刷新',
  TIMEOUT: '上游日汇总请求超时，请稍后刷新',
  NETWORK_UNREACHABLE: '无法连接上游日汇总接口',
  SCHEMA_MISMATCH: '上游日汇总缺少有效的实际消费金额或额度单位',
  CONFIG_CHANGED: '查询期间供应商配置发生变化，请刷新',
  BUSINESS_ERROR: '上游拒绝日汇总查询，请检查账号权限和可查询日期范围'
};

function round(value) { return Math.round(value * 1e8) / 1e8; }
function failureMessage(error) {
  if (FAILURE_MESSAGES[error?.code]) return FAILURE_MESSAGES[error.code];
  if (error?.details?.remoteStatus === 404) return '上游未提供兼容的账号日汇总接口';
  return '无法取得上游账号日汇总，请检查供应商状态';
}

class DailyCostService {
  constructor({ db, config, providers, http, grossProfit, now = () => new Date() }) {
    this.db = db;
    this.config = config;
    this.providers = providers;
    this.http = http;
    this.grossProfit = grossProfit || new GrossProfitService({ db, config, now });
    this.now = now;
    this.inFlight = new Map();
    this.providerLocks = new Map();
    this.failures = new Map();
    this.active = 0;
    this.waiters = [];
  }

  #hash(value) {
    return createHmac('sha256', this.config.secret).update(JSON.stringify(value)).digest('hex');
  }

  #scope(connection) {
    return [connection.adapter_type, connection.base_url, connection.auth_mode,
      connection.credential_id, connection.remote_user_id, connection.type_config_json];
  }

  #configKey(connection) {
    return this.#hash([this.#scope(connection), this.providers.getCredentials(connection)]);
  }

  async #limited(operation) {
    const limit = Math.max(1, Math.min(this.config.globalConcurrency || 5, 10));
    if (this.active >= limit) await new Promise((resolve) => this.waiters.push(resolve));
    else this.active += 1;
    try { return await operation(); }
    finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active -= 1;
    }
  }

  async #load(connection, period, timezone, deadline) {
    const previous = this.providerLocks.get(connection.id) || Promise.resolve();
    const operation = previous.catch(() => {}).then(() => this.#limited(async () => {
      const current = this.providers.get(connection.id, { forAdapter: true });
      const scopeKey = this.#hash(this.#scope(current));
      const providerDeadline = Math.min(deadline, Date.now() + 5000);
      const verifyConfig = () => {
        const latest = this.providers.get(connection.id, { forAdapter: true });
        if (this.#hash(this.#scope(latest)) !== scopeKey) {
          throw new AppError('CONFIG_CHANGED', 'Provider changed during daily summary read', { status: 409 });
        }
        adapterContext.verifyCredentials();
        return latest;
      };
      const http = { requestJson: (url, options = {}) => {
        const remaining = providerDeadline - Date.now();
        if (remaining <= 0) throw new AppError('TIMEOUT', 'Daily summary read budget exceeded', { status: 504 });
        return this.http.requestJson(url, { ...options, retries: 0,
          timeoutMs: Math.min(remaining, this.config.queryTimeoutMs || 15000) });
      } };
      const adapterContext = this.providers.adapterContext(current, http);
      const adapter = createAdapter(current.adapter_type, adapterContext);
      const summary = await adapter.getDailyUsageSummary({ date: period.periodKey,
        fromAt: period.from, toAt: period.to, timezone });
      if (Date.now() > providerDeadline) throw new AppError('TIMEOUT', 'Daily summary read budget exceeded', { status: 504 });
      const latest = verifyConfig();
      if (summary.scope !== 'account' || typeof summary.amount !== 'number' ||
          !Number.isFinite(summary.amount) || summary.amount < 0 || !summary.subjectId ||
          !/^[A-Z][A-Z0-9_-]{0,11}$/.test(summary.currency) ||
          !(summary.requests === null || (Number.isSafeInteger(summary.requests) && summary.requests >= 0))) {
        throw new AppError('SCHEMA_MISMATCH', 'Invalid daily summary contract', { status: 502 });
      }
      const row = { connection_id: current.id, usage_date: period.periodKey, timezone,
        config_key: this.#configKey(latest),
        account_key: this.#hash([current.adapter_type, new URL(current.base_url).origin, String(summary.subjectId)]),
        amount: summary.amount, currency: summary.currency, requests: summary.requests,
        fetched_at: this.now().toISOString() };
      this.db.prepare(`INSERT INTO provider_daily_cost_summaries (
        connection_id, usage_date, timezone, config_key, account_key, amount, currency, requests, fetched_at
      ) VALUES (@connection_id, @usage_date, @timezone, @config_key, @account_key, @amount, @currency, @requests, @fetched_at)
      ON CONFLICT(connection_id, usage_date, timezone) DO UPDATE SET
        config_key=excluded.config_key, account_key=excluded.account_key, amount=excluded.amount,
        currency=excluded.currency, requests=excluded.requests, fetched_at=excluded.fetched_at`).run(row);
      return { ...row, cached: false };
    }));
    this.providerLocks.set(connection.id, operation);
    try { return await operation; }
    finally { if (this.providerLocks.get(connection.id) === operation) this.providerLocks.delete(connection.id); }
  }

  async #snapshot(connection, period, timezone, deadline, refresh) {
    const configKey = this.#configKey(connection);
    const cached = this.db.prepare(`SELECT * FROM provider_daily_cost_summaries
      WHERE connection_id=? AND usage_date=? AND timezone=?`).get(connection.id, period.periodKey, timezone);
    const now = this.now().getTime();
    const ttl = now < Date.parse(period.to) ? 60000 : 3600000;
    const age = now - Date.parse(cached?.fetched_at);
    const finalized = now < Date.parse(period.to) || Date.parse(cached?.fetched_at) >= Date.parse(period.to);
    if (!refresh && finalized && cached?.config_key === configKey && age >= 0 && age < ttl) return { ...cached, cached: true };
    const failure = this.failures.get(connection.id);
    if (failure?.configKey === configKey && failure.until > Date.now()) throw failure.error;
    const key = JSON.stringify([connection.id, period.periodKey, timezone, configKey]);
    if (!this.inFlight.has(key)) {
      const operation = this.#load(connection, period, timezone, deadline).catch((error) => {
        this.db.prepare(`UPDATE provider_daily_cost_summaries SET config_key=''
          WHERE connection_id=? AND usage_date=? AND timezone=? AND config_key=?`)
          .run(connection.id, period.periodKey, timezone, configKey);
        if (['TIMEOUT', 'RATE_LIMITED', 'AUTH_FAILED', 'AUTH_EXPIRED', 'CAPTCHA_REQUIRED', 'MFA_REQUIRED'].includes(error?.code)) {
          this.failures.set(connection.id, { configKey, until: Date.now() + 30000, error: { code: error.code } });
        }
        throw error;
      }).finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, operation);
    }
    return this.inFlight.get(key);
  }

  #cashCost(connection, snapshot, period, settings) {
    if (snapshot.amount === 0) return { cost: 0, reasons: [] };
    const end = Math.min(Date.parse(period.to), Date.parse(snapshot.fetched_at));
    const history = this.db.prepare(`SELECT * FROM provider_recharge_rate_history
      WHERE connection_id=? AND valid_from<? AND (valid_to IS NULL OR valid_to>?)
      ORDER BY valid_from, id`).all(connection.id, new Date(end).toISOString(), period.from);
    let covered = Date.parse(period.from);
    const contexts = new Map();
    for (const row of history) {
      if (Date.parse(row.valid_from) > covered || row.source === 'default' || !(row.multiplier > 0)) break;
      const balanceCurrency = row.balance_currency || snapshot.currency;
      const cashCurrency = row.paid_currency || snapshot.currency;
      if (balanceCurrency !== snapshot.currency) return { cost: null, reasons: ['历史充值额度币种与上游汇总币种不一致'] };
      contexts.set(JSON.stringify([row.multiplier, cashCurrency]), { multiplier: row.multiplier, cashCurrency });
      covered = Math.max(covered, Math.min(end, Date.parse(row.valid_to || new Date(end).toISOString())));
    }
    if (covered < end || contexts.size === 0) return { cost: null, reasons: ['该日缺少完整的已确认充值倍率历史'] };
    const coefficients = [...contexts.values()].map(context => this.grossProfit.convertCost(1 / context.multiplier, context.cashCurrency, settings));
    if (coefficients.some(value => value == null)) return { cost: null, reasons: ['缺少币种汇率'] };
    if (coefficients.some(value => Math.abs(value - coefficients[0]) > Math.max(1, Math.abs(coefficients[0])) * 1e-12)) return { cost: null, reasons: ['当日充值倍率发生变化，日汇总无法按单一倍率折算'] };
    const context = [...contexts.values()][0];
    const cost = this.grossProfit.convertCost(snapshot.amount / context.multiplier, context.cashCurrency, settings);
    return { cost: cost == null ? null : round(cost), reasons: cost == null ? ['缺少币种汇率'] : [] };
  }

  async report(input = {}) {
    const { query, settings, periods } = this.grossProfit.dailyCostOptions(input);
    const generatedAt = this.now().toISOString();
    const deadline = Date.now() + 8500;
    const refresh = input.refresh === '1' || input.refresh === true;
    const connections = this.db.prepare(`SELECT id, name FROM provider_connections
      WHERE enabled=1 ORDER BY name, id`).all();
    const items = [];
    for (const period of periods) {
      const suppliers = await Promise.all(connections.map(async ({ id, name }) => {
        const base = { id, name, scope: 'account', source: SOURCE, cost: null, recordedCost: null,
          requests: null, complete: false, reasons: [], lastSyncedAt: null };
        try {
          if (Date.parse(period.from) >= Date.parse(generatedAt)) return { ...base, reasons: ['该资金日尚未发生'] };
          const connection = this.providers.get(id, { forAdapter: true });
          const snapshot = await this.#snapshot(connection, period, query.timezone, deadline, refresh);
          const valuation = this.#cashCost(connection, snapshot, period, settings);
          return { ...base, ...valuation, recordedCost: valuation.cost, complete: valuation.cost != null,
            requests: snapshot.requests, lastSyncedAt: snapshot.fetched_at, cached: snapshot.cached,
            upstreamCost: snapshot.amount, upstreamCurrency: snapshot.currency, accountKey: snapshot.account_key };
        } catch (error) { return { ...base, reasons: [failureMessage(error)] }; }
      }));
      const accounts = new Map();
      for (const supplier of suppliers) {
        const previous = accounts.get(supplier.accountKey);
        if (supplier.accountKey && previous) {
          for (const duplicate of [previous, supplier]) {
            duplicate.cost = null;
            duplicate.complete = false;
            duplicate.reasons = ['同一上游账号重复配置，请合并供应商后刷新'];
          }
        } else if (supplier.accountKey) accounts.set(supplier.accountKey, supplier);
      }
      for (const supplier of suppliers) delete supplier.accountKey;
      const complete = suppliers.length > 0 && suppliers.every((supplier) => supplier.complete);
      items.push({ date: period.periodKey, complete,
        cost: complete ? round(suppliers.reduce((sum, supplier) => sum + supplier.cost, 0)) : null,
        requests: suppliers.length && suppliers.every((supplier) => supplier.requests != null)
          ? suppliers.reduce((sum, supplier) => sum + supplier.requests, 0) : null,
        providers: suppliers });
    }
    return { range: { start: query.from, end: query.to }, timezone: query.timezone,
      currency: settings.currency, source: SOURCE, scope: 'account',
      providerFilter: 'scheduled_enabled', items, generatedAt };
  }

  balanceReport() {
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(this.now());
    const { settings } = this.grossProfit.dailyCostOptions({ from: date, to: date, currency: 'CNY', timezone: 'Asia/Shanghai' });
    const rows = this.db.prepare(`WITH ranked AS (
      SELECT s.*, MAX(captured_at) OVER (PARTITION BY connection_id) AS latest,
        ROW_NUMBER() OVER (PARTITION BY connection_id,currency ORDER BY captured_at DESC,id DESC) AS n
      FROM balance_snapshots s WHERE subject_type='account')
      SELECT p.id AS provider_id,p.name,r.available,r.currency,a.remote_id,r.unlimited,r.captured_at
      FROM provider_connections p LEFT JOIN ranked r ON r.connection_id=p.id AND r.n=1 AND r.captured_at=r.latest
      LEFT JOIN remote_accounts a ON a.id=r.subject_id AND a.connection_id=p.id
      WHERE p.enabled=1 ORDER BY p.id,r.currency`).all();
    const identities = new Set();
    const items = rows.map(row => {
      const connection = this.providers.get(row.provider_id, { forAdapter: true });
      const identity = this.#hash([connection.adapter_type, new URL(connection.base_url).origin, row.remote_id, row.currency]);
      let cost = null, reasons = [];
      if (identities.has(identity)) reasons = ['重复配置的上游账号'];
      else if (!row.remote_id || row.available == null || !Number.isFinite(row.available) || row.unlimited || !Number.isFinite(Date.parse(row.captured_at))) reasons = ['没有可折算的账号余额快照'];
      else if (connection.remote_user_id && String(connection.remote_user_id) !== String(row.remote_id)) reasons = ['余额快照与当前账号不一致，等待监控刷新'];
      else if (this.now().getTime() - Date.parse(row.captured_at) > 3600000 || this.now().getTime() < Date.parse(row.captured_at)) reasons = ['余额快照超出有效时间，等待监控刷新'];
      else {
        const at = new Date(Date.parse(row.captured_at) - 1).toISOString();
        const converted = this.#cashCost(connection, { amount: row.available, currency: row.currency, fetched_at: row.captured_at },
          { from: at, to: row.captured_at }, settings);
        cost = converted.cost; reasons = converted.reasons;
      }
      identities.add(identity);
      return { id: String(row.provider_id), name: row.name, available: row.available, currency: row.currency,
        cashValue: cost, capturedAt: row.captured_at, complete: cost != null, reasons };
    });
    const complete = items.length > 0 && items.every(item => item.complete);
    return { currency: 'CNY', basis: 'current_rate_estimate', providerFilter: 'scheduled_enabled',
      complete, total: complete ? round(items.reduce((sum, item) => sum + item.cashValue, 0)) : null,
      items, generatedAt: this.now().toISOString() };
  }
}

module.exports = { DailyCostService };
