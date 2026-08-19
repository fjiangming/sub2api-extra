const { createHash } = require('crypto');
const { AppError } = require('../errors');
const { parseJson } = require('../db');

const DIMENSIONS = new Set(['provider', 'key', 'account']);
const GRANULARITIES = new Set(['day', 'week', 'month']);
const ACCOUNTING_MODES = new Set(['standard', 'exclude_admin', 'admin_expense']);
const ADMINISTRATOR_USER_ID = '1';
// Kept as an export alias for integrations that consumed the first implementation.
const ADMINISTRATOR_ACCOUNT_ID = ADMINISTRATOR_USER_ID;
const MAX_RETURNED_ENTITIES = 200;

const ACCOUNTING_MODE_ALIASES = {
  default: 'standard',
  normal: 'standard',
  filter_admin: 'exclude_admin',
  exclude_administrator: 'exclude_admin',
  admin_as_expense: 'admin_expense',
  pure: 'admin_expense'
};

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integer(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function round(value, digits = 8) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function dateInTimezone(value, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(value);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function validDateKey(value) {
  const key = String(value || '');
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === key;
}

function shiftDateKey(value, days) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return value;
  return new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]) + days
  )).toISOString().slice(0, 10);
}

function shiftMonthKey(value, months) {
  const match = /^(\d{4})-(\d{2})-01$/.exec(String(value || ''));
  if (!match) return value;
  return new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1 + months,
    1
  )).toISOString().slice(0, 10);
}

function startOfDateInTimezone(value, timezone) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const target = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  let timestamp = target;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value])
    );
    const represented = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second)
    );
    const offset = represented - Math.floor(timestamp / 1000) * 1000;
    timestamp = target - offset;
  }
  return new Date(timestamp);
}

function bucketForDateKey(dateKey, granularity) {
  if (granularity === 'day') return dateKey;
  if (granularity === 'month') return `${dateKey.slice(0, 7)}-01`;
  const day = new Date(`${dateKey}T00:00:00.000Z`).getUTCDay();
  return shiftDateKey(dateKey, -(day === 0 ? 6 : day - 1));
}

function bucketForTimestamp(value, granularity, timezone) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return bucketForDateKey(dateInTimezone(new Date(timestamp), timezone), granularity);
}

function resolvedAccountExpression(alias = 'ledger') {
  return `COALESCE(
    ${alias}.attributed_account_id,
    CASE WHEN ${alias}.source_type = 'request_log' THEN (
      SELECT CASE WHEN COUNT(DISTINCT history.account_id) = 1
        THEN MIN(history.account_id) END
      FROM sub2api_mapping_history history
      WHERE history.connection_id = ${alias}.connection_id
        AND history.key_id = ${alias}.key_id
        AND history.enabled = 1 AND history.role = 'primary'
        AND history.valid_from <= ${alias}.occurred_at
        AND (history.valid_to IS NULL OR history.valid_to > ${alias}.occurred_at)
    ) END
  )`;
}

function nextBucket(value, granularity) {
  if (granularity === 'day') return shiftDateKey(value, 1);
  if (granularity === 'week') return shiftDateKey(value, 7);
  return shiftMonthKey(value, 1);
}

function periodLabel(value, granularity) {
  if (granularity === 'day') return value;
  if (granularity === 'week') return `${value} 至 ${shiftDateKey(value, 6)}`;
  return value.slice(0, 7);
}

function maxRangeDays(granularity) {
  if (granularity === 'day') return 366;
  if (granularity === 'week') return 1095;
  return 3653;
}

function daysBetween(from, to) {
  return Math.round(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86400000
  ) + 1;
}

function safeHistoricalKeyId(connectionId, entityId) {
  if (!String(entityId).startsWith('unattributed:')) return String(entityId);
  const digest = createHash('sha256').update(String(entityId)).digest('hex').slice(0, 12);
  return `historical:${connectionId}:${digest}`;
}

function calculationStatus(item) {
  if (!item.hasActivity) return 'empty';
  if (
    item.missingRevenueRequests > 0 || item.missingCostRequests > 0 ||
    item.missingAdministratorExpenseRequests > 0 ||
    item.unconvertedRevenueRequests > 0 || item.unconvertedCostRequests > 0 ||
    item.unconvertedAdministratorExpenseRequests > 0
  ) return 'partial';
  if (item.unconfirmedCostRequests > 0) return 'estimated';
  return 'complete';
}

function finalizeAmounts(item) {
  const status = calculationStatus(item);
  const administratorExpense = round(item.administratorExpense) || 0;
  const operatingGrossProfit = round(item.revenue - item.upstreamCost);
  const provisionalGrossProfit = round(operatingGrossProfit - administratorExpense);
  return {
    revenue: round(item.revenue),
    upstreamCost: round(item.upstreamCost),
    administratorExpense,
    totalCost: round(item.upstreamCost + administratorExpense),
    operatingGrossProfit,
    grossProfit: status === 'complete' ? provisionalGrossProfit : null,
    estimatedGrossProfit: status === 'estimated' ? provisionalGrossProfit : null,
    provisionalGrossProfit,
    grossMarginRatio: status === 'complete' && item.revenue > 0
      ? round(provisionalGrossProfit / item.revenue, 6)
      : null,
    baseRequestCount: item.baseRequestCount,
    upstreamRequestCount: item.upstreamRequestCount,
    status,
    missingRevenueRequests: item.missingRevenueRequests,
    missingCostRequests: item.missingCostRequests,
    administratorRequestCount: item.administratorRequestCount,
    missingAdministratorExpenseRequests: item.missingAdministratorExpenseRequests,
    unconfirmedCostRequests: item.unconfirmedCostRequests,
    unconvertedRevenueRequests: item.unconvertedRevenueRequests,
    unconvertedCostRequests: item.unconvertedCostRequests,
    unconvertedAdministratorExpenseRequests: item.unconvertedAdministratorExpenseRequests,
    maximumPrecisionSeconds: item.maximumPrecisionSeconds || null
  };
}

function emptyAmounts() {
  return {
    revenue: 0,
    upstreamCost: 0,
    administratorExpense: 0,
    baseRequestCount: 0,
    upstreamRequestCount: 0,
    administratorRequestCount: 0,
    missingRevenueRequests: 0,
    missingCostRequests: 0,
    missingAdministratorExpenseRequests: 0,
    unconfirmedCostRequests: 0,
    unconvertedRevenueRequests: 0,
    unconvertedCostRequests: 0,
    unconvertedAdministratorExpenseRequests: 0,
    maximumPrecisionSeconds: 0,
    hasActivity: false
  };
}

class GrossProfitService {
  constructor({ db, config, now = () => new Date() }) {
    this.db = db;
    this.config = config;
    this.now = now;
    this.db.function('gross_profit_bucket', { deterministic: true }, bucketForTimestamp);
  }

  #query(input = {}) {
    const dimension = String(input.dimension || 'provider').trim().toLowerCase();
    const granularity = String(input.granularity || 'day').trim().toLowerCase();
    const rawAccountingMode = String(
      input.accountingMode || input.accounting_mode || input.statisticalMode ||
      input.statistical_mode || input.mode || 'standard'
    ).trim().toLowerCase();
    const accountingMode = ACCOUNTING_MODE_ALIASES[rawAccountingMode] || rawAccountingMode;
    if (!DIMENSIONS.has(dimension)) {
      throw new AppError('VALIDATION_ERROR', 'Unsupported gross profit dimension', { status: 400 });
    }
    if (!GRANULARITIES.has(granularity)) {
      throw new AppError('VALIDATION_ERROR', 'Unsupported gross profit granularity', { status: 400 });
    }
    if (!ACCOUNTING_MODES.has(accountingMode)) {
      throw new AppError('VALIDATION_ERROR', 'Unsupported gross profit accounting mode', { status: 400 });
    }
    const today = dateInTimezone(this.now(), this.config.timezone);
    const from = String(input.from || shiftDateKey(today, -29));
    const to = String(input.to || today);
    if (!validDateKey(from) || !validDateKey(to) || from > to) {
      throw new AppError('VALIDATION_ERROR', 'Gross profit date range is invalid', { status: 400 });
    }
    const rangeDays = daysBetween(from, to);
    if (rangeDays > maxRangeDays(granularity)) {
      throw new AppError(
        'VALIDATION_ERROR',
        `Gross profit ${granularity} range exceeds ${maxRangeDays(granularity)} days`,
        { status: 400 }
      );
    }
    const connectionId = String(input.connectionId || input.connection_id || '').trim() || null;
    if (connectionId && !this.db.prepare(
      'SELECT 1 FROM provider_connections WHERE id = ?'
    ).get(connectionId)) {
      throw new AppError('PROVIDER_NOT_FOUND', 'Provider connection was not found', { status: 404 });
    }
    const currency = String(input.currency || '').trim().toUpperCase() || null;
    if (currency && !/^[A-Z][A-Z0-9_-]{0,11}$/.test(currency)) {
      throw new AppError('VALIDATION_ERROR', 'Gross profit currency is invalid', { status: 400 });
    }
    const fromAt = startOfDateInTimezone(from, this.config.timezone);
    const toAt = startOfDateInTimezone(shiftDateKey(to, 1), this.config.timezone);
    return {
      dimension,
      granularity,
      from,
      to,
      fromAt: fromAt.toISOString(),
      toAt: toAt.toISOString(),
      connectionId,
      currency,
      timezone: this.config.timezone,
      accountingMode,
      administratorUserId: ADMINISTRATOR_USER_ID
    };
  }

  #currencySettings(targetCurrency = null) {
    const rows = this.db.prepare(`
      SELECT key, value_json FROM settings
      WHERE key IN ('displayCurrency', 'currencyRates')
    `).all();
    const values = Object.fromEntries(
      rows.map((row) => [row.key, parseJson(row.value_json, null)])
    );
    const displayCurrency = String(values.displayCurrency || 'USD').toUpperCase();
    const rates = { USD: 1 };
    if (values.currencyRates && typeof values.currencyRates === 'object') {
      for (const [currency, value] of Object.entries(values.currencyRates)) {
        const rate = finite(value);
        if (rate != null && rate > 0) rates[String(currency).toUpperCase()] = rate;
      }
    }
    rates[displayCurrency] = 1;
    const currency = targetCurrency || displayCurrency;
    if (currency !== displayCurrency && !(finite(rates[currency]) > 0)) {
      throw new AppError('CURRENCY_RATE_MISSING', `No conversion rate is configured for ${currency}`, {
        status: 400
      });
    }
    return { displayCurrency, currency, rates };
  }

  #convert(amount, sourceCurrency, settings) {
    const value = finite(amount);
    if (value == null) return null;
    const source = String(sourceCurrency || settings.displayCurrency).toUpperCase();
    const sourceRate = source === settings.displayCurrency ? 1 : finite(settings.rates[source]);
    const targetRate = settings.currency === settings.displayCurrency
      ? 1
      : finite(settings.rates[settings.currency]);
    if (!(sourceRate > 0) || !(targetRate > 0)) return null;
    return value * sourceRate / targetRate;
  }

  #params(query) {
    return {
      granularity: query.granularity,
      timezone: query.timezone,
      fromAt: query.fromAt,
      toAt: query.toAt,
      connectionId: query.connectionId,
      administratorUserId: query.administratorUserId
    };
  }

  #baseRows(query, purpose = 'included') {
    const excluded = purpose === 'unattributed';
    const administrator = purpose === 'administrator';
    const expressions = {
      provider: {
        id: 'ledger.connection_id',
        name: "COALESCE(connection.name, '历史供应商')"
      },
      key: {
        id: "COALESCE(ledger.key_id, 'unattributed:' || ledger.connection_id)",
        name: "COALESCE(remote_key.name, '历史 / 未归属 Key')"
      },
      account: {
        id: 'ledger.account_id',
        name: "COALESCE(account.name, '账号 #' || ledger.account_id)"
      }
    }[query.dimension];
    const attributionClause = administrator
      ? '1 = 1'
      : excluded
        ? "ledger.attribution_status NOT IN ('attributed', 'attributed_multi_group') OR ledger.connection_id IS NULL OR ledger.key_id IS NULL"
        : "ledger.attribution_status IN ('attributed', 'attributed_multi_group') AND ledger.connection_id IS NOT NULL AND ledger.key_id IS NOT NULL";
    const administratorClause = administrator
      ? 'AND CAST(ledger.user_id AS TEXT) = @administratorUserId'
      : query.accountingMode === 'standard'
        ? ''
        : 'AND (ledger.user_id IS NULL OR CAST(ledger.user_id AS TEXT) <> @administratorUserId)';
    const providerClause = query.connectionId ? 'AND ledger.connection_id = @connectionId' : '';
    return this.db.prepare(`
      SELECT gross_profit_bucket(ledger.occurred_at, @granularity, @timezone) AS period_key,
        ledger.connection_id, ${excluded ? 'NULL' : expressions.id} AS entity_id,
        ${excluded ? "'未归因基座收入'" : `MAX(${expressions.name})`} AS entity_name,
        MAX(COALESCE(connection.name, '历史供应商')) AS provider_name,
        COALESCE(ledger.cash_currency, ledger.currency, 'USD') AS cash_currency,
        SUM(CASE WHEN ledger.cost IS NULL THEN 0 ELSE COALESCE(
          ledger.cash_revenue, ledger.cost / ledger.recharge_multiplier
        ) END) AS amount,
        SUM(CASE WHEN ledger.cost IS NULL THEN 0 ELSE ledger.request_count END) AS request_count,
        SUM(CASE WHEN ledger.cost IS NULL THEN ledger.request_count ELSE 0 END) AS missing_value_requests,
        0 AS unconfirmed_requests, 0 AS maximum_precision_seconds
      FROM sub2api_account_cost_ledger ledger
      LEFT JOIN provider_connections connection ON connection.id = ledger.connection_id
      LEFT JOIN remote_keys remote_key ON remote_key.id = ledger.key_id
      LEFT JOIN sub2api_monitored_accounts account ON account.account_id = ledger.account_id
      WHERE (${attributionClause})
        AND ledger.occurred_at >= @fromAt AND ledger.occurred_at < @toAt
        ${administratorClause}
        ${providerClause}
      GROUP BY period_key, ledger.connection_id, entity_id,
        COALESCE(ledger.cash_currency, ledger.currency, 'USD')
      ORDER BY period_key, entity_name
    `).all(this.#params(query));
  }

  #unknownRequesterUserRequestCount(query) {
    const providerClause = query.connectionId ? 'AND ledger.connection_id = @connectionId' : '';
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(ledger.request_count), 0) AS request_count
      FROM sub2api_account_cost_ledger ledger
      WHERE ledger.user_id IS NULL
        AND ledger.occurred_at >= @fromAt AND ledger.occurred_at < @toAt
        ${providerClause}
    `).get(this.#params(query));
    return integer(row?.request_count);
  }

  #costRows(query) {
    const providerClause = query.connectionId ? 'AND ledger.connection_id = @connectionId' : '';
    const commonWhere = `
      ledger.accounting_status = 'active' AND ledger.comparable = 1
      AND ledger.occurred_at >= @fromAt AND ledger.occurred_at < @toAt
      ${providerClause}
    `;
    const needsResolvedAccount = query.dimension === 'account';
    const source = needsResolvedAccount
      ? `(
          SELECT ledger.*, ${resolvedAccountExpression('ledger')} AS resolved_account_id
          FROM provider_cost_ledger ledger
          WHERE ${commonWhere}
        )`
      : 'provider_cost_ledger';
    const outerWhere = needsResolvedAccount ? '1 = 1' : commonWhere;
    const administratorFlag = '0';
    const expression = {
      provider: {
        id: 'ledger.connection_id',
        name: "COALESCE(connection.name, '历史供应商')"
      },
      key: {
        id: "COALESCE(ledger.key_id, 'unattributed:' || ledger.connection_id)",
        name: "COALESCE(remote_key.name, '历史 / 未归属 Key')"
      },
      account: {
        id: 'ledger.resolved_account_id',
        name: "COALESCE(account.name, '账号 #' || ledger.resolved_account_id)"
      }
    }[query.dimension];
    return this.db.prepare(`
      SELECT gross_profit_bucket(ledger.occurred_at, @granularity, @timezone) AS period_key,
        ledger.connection_id, ${expression.id} AS entity_id,
        MAX(${expression.name}) AS entity_name,
        MAX(COALESCE(connection.name, '历史供应商')) AS provider_name,
        ${administratorFlag} AS is_administrator,
        COALESCE(ledger.cash_currency, ledger.currency, 'USD') AS cash_currency,
        SUM(CASE WHEN ledger.cost IS NULL THEN 0 ELSE COALESCE(
          ledger.cash_cost, ledger.cost / ledger.recharge_multiplier
        ) END) AS amount,
        SUM(CASE WHEN ledger.cost IS NULL THEN 0 ELSE ledger.request_count END) AS request_count,
        SUM(CASE WHEN ledger.cost IS NULL THEN ledger.request_count ELSE 0 END) AS missing_value_requests,
        SUM(CASE WHEN ledger.cost IS NOT NULL
          AND COALESCE(ledger.recharge_source, 'default') = 'default'
          THEN ledger.request_count ELSE 0 END) AS unconfirmed_requests,
        MAX(COALESCE(ledger.precision_seconds, 0)) AS maximum_precision_seconds
      FROM ${source} ledger
      LEFT JOIN provider_connections connection ON connection.id = ledger.connection_id
      LEFT JOIN remote_keys remote_key ON remote_key.id = ledger.key_id
      LEFT JOIN sub2api_monitored_accounts account
        ON account.account_id = ${needsResolvedAccount ? 'ledger.resolved_account_id' : 'ledger.attributed_account_id'}
      WHERE ${outerWhere}
      GROUP BY period_key, ledger.connection_id, entity_id,
        COALESCE(ledger.cash_currency, ledger.currency, 'USD')
      ORDER BY period_key, entity_name
    `).all(this.#params(query));
  }

  #periods(query) {
    const result = [];
    let current = bucketForDateKey(query.from, query.granularity);
    const last = bucketForDateKey(query.to, query.granularity);
    while (current <= last && result.length < 3700) {
      const next = nextBucket(current, query.granularity);
      result.push({
        periodKey: current,
        periodLabel: periodLabel(current, query.granularity),
        from: startOfDateInTimezone(current, query.timezone).toISOString(),
        to: startOfDateInTimezone(next, query.timezone).toISOString()
      });
      current = next;
    }
    return result;
  }

  #filterOptions(settings) {
    const providers = this.db.prepare(`
      SELECT id, name FROM provider_connections ORDER BY name COLLATE NOCASE, id
    `).all().map((row) => ({ id: row.id, name: row.name }));
    const storedCurrencies = this.db.prepare(`
      SELECT currency FROM (
        SELECT DISTINCT UPPER(COALESCE(cash_currency, currency, 'USD')) AS currency
        FROM provider_cost_ledger
        UNION
        SELECT DISTINCT UPPER(COALESCE(cash_currency, currency, 'USD')) AS currency
        FROM sub2api_account_cost_ledger
      ) ORDER BY currency
    `).all().map((row) => row.currency).filter(Boolean);
    const currencies = [...new Set([
      settings.displayCurrency,
      ...Object.keys(settings.rates),
      ...storedCurrencies
    ])].sort().map((currency) => ({
      currency,
      convertible: currency === settings.displayCurrency || finite(settings.rates[currency]) > 0
    }));
    return { providers, currencies };
  }

  report(input = {}) {
    const query = this.#query(input);
    const currencySettings = this.#currencySettings(query.currency);
    query.currency = currencySettings.currency;
    const unknownRequesterUserRequestCount = this.#unknownRequesterUserRequestCount(query);
    const periodDefinitions = this.#periods(query);
    const periodAmounts = new Map(periodDefinitions.map((period) => [
      period.periodKey,
      { ...period, ...emptyAmounts() }
    ]));
    const itemAmounts = new Map();
    const unconvertedCurrencies = new Set();
    const breakdown = {
      unattributedBaseRequestCount: 0,
      unattributedBaseRevenue: 0,
      unattributedUpstreamRequestCount: 0,
      unattributedUpstreamCost: 0,
      unattributedAdministratorRequestCount: 0,
      unattributedAdministratorExpense: 0,
      complete: true
    };

    const ensureItem = (row) => {
      const connectionId = String(row.connection_id || 'unknown');
      const rawEntityId = String(row.entity_id || 'unattributed');
      const entityId = safeHistoricalKeyId(connectionId, rawEntityId);
      const identity = `${row.period_key}\u0000${entityId}`;
      if (!itemAmounts.has(identity)) {
        itemAmounts.set(identity, {
          periodKey: row.period_key,
          periodLabel: periodLabel(row.period_key, query.granularity),
          entityId,
          entityName: row.entity_name || '未归因',
          providerNames: new Set(),
          ...emptyAmounts()
        });
      }
      const item = itemAmounts.get(identity);
      if (row.provider_name) item.providerNames.add(String(row.provider_name));
      return item;
    };

    const apply = (row, side, assignEntity = true, includeInPeriod = true) => {
      const period = periodAmounts.get(row.period_key);
      if (!period) return;
      const sourceCurrency = String(row.cash_currency || 'USD').toUpperCase();
      const amount = this.#convert(row.amount, sourceCurrency, currencySettings);
      const requests = integer(row.request_count);
      const missing = integer(row.missing_value_requests);
      const unconfirmed = integer(row.unconfirmed_requests);
      const precision = integer(row.maximum_precision_seconds);
      const isRevenue = side === 'revenue';
      const isAdministratorExpense = side === 'administratorExpense';
      if (includeInPeriod) {
        period.hasActivity = period.hasActivity || requests > 0 || missing > 0 || finite(row.amount) !== 0;
        period.maximumPrecisionSeconds = Math.max(period.maximumPrecisionSeconds, precision);
        if (isRevenue) {
          period.baseRequestCount += requests;
          period.missingRevenueRequests += missing;
          if (amount == null) {
            period.unconvertedRevenueRequests += requests;
            unconvertedCurrencies.add(sourceCurrency);
          } else {
            period.revenue += amount;
          }
        } else if (isAdministratorExpense) {
          period.administratorRequestCount += requests;
          period.missingAdministratorExpenseRequests += missing;
          if (amount == null) {
            period.unconvertedAdministratorExpenseRequests += requests;
            unconvertedCurrencies.add(sourceCurrency);
          } else {
            period.administratorExpense += amount;
          }
        } else {
          period.upstreamRequestCount += requests;
          period.missingCostRequests += missing;
          period.unconfirmedCostRequests += unconfirmed;
          if (amount == null) {
            period.unconvertedCostRequests += requests;
            unconvertedCurrencies.add(sourceCurrency);
          } else {
            period.upstreamCost += amount;
          }
        }
      }
      if (!assignEntity) {
        breakdown.complete = false;
        if (isRevenue) {
          breakdown.unattributedBaseRequestCount += requests;
          if (amount != null) breakdown.unattributedBaseRevenue += amount;
        } else if (isAdministratorExpense) {
          breakdown.unattributedAdministratorRequestCount += requests;
          if (amount != null) breakdown.unattributedAdministratorExpense += amount;
        } else {
          breakdown.unattributedUpstreamRequestCount += requests;
          if (amount != null) breakdown.unattributedUpstreamCost += amount;
        }
        return;
      }
      const item = ensureItem(row);
      item.hasActivity = item.hasActivity || requests > 0 || missing > 0 || finite(row.amount) !== 0;
      item.maximumPrecisionSeconds = Math.max(item.maximumPrecisionSeconds, precision);
      if (isRevenue) {
        item.baseRequestCount += requests;
        item.missingRevenueRequests += missing;
        if (amount == null) item.unconvertedRevenueRequests += requests;
        else item.revenue += amount;
      } else if (isAdministratorExpense) {
        item.administratorRequestCount += requests;
        item.missingAdministratorExpenseRequests += missing;
        if (amount == null) item.unconvertedAdministratorExpenseRequests += requests;
        else item.administratorExpense += amount;
      } else {
        item.upstreamRequestCount += requests;
        item.missingCostRequests += missing;
        item.unconfirmedCostRequests += unconfirmed;
        if (amount == null) item.unconvertedCostRequests += requests;
        else item.upstreamCost += amount;
      }
    };

    for (const row of this.#baseRows(query)) apply(row, 'revenue');
    if (!query.connectionId) {
      for (const row of this.#baseRows(query, 'unattributed')) apply(row, 'revenue', false, false);
    }
    if (query.accountingMode === 'admin_expense') {
      for (const row of this.#baseRows(query, 'administrator')) {
        const assignEntity = query.dimension === 'account' || row.connection_id != null;
        apply(row, 'administratorExpense', assignEntity);
      }
    }
    for (const row of this.#costRows(query)) {
      apply(row, 'cost', query.dimension !== 'account' || row.entity_id != null);
    }

    const periods = [...periodAmounts.values()].map((period) => ({
      periodKey: period.periodKey,
      periodLabel: period.periodLabel,
      from: period.from,
      to: period.to,
      ...finalizeAmounts(period)
    }));
    const items = [...itemAmounts.values()].map((item) => ({
      periodKey: item.periodKey,
      periodLabel: item.periodLabel,
      entityId: item.entityId,
      entityName: item.entityName,
      providerNames: [...item.providerNames].sort((left, right) => left.localeCompare(right, 'zh-CN')),
      ...finalizeAmounts(item)
    }));
    const entityAmounts = new Map();
    for (const item of items) {
      if (!entityAmounts.has(item.entityId)) {
        entityAmounts.set(item.entityId, {
          entityId: item.entityId,
          entityName: item.entityName,
          providerNames: new Set(),
          ...emptyAmounts()
        });
      }
      const entity = entityAmounts.get(item.entityId);
      for (const providerName of item.providerNames) entity.providerNames.add(providerName);
      entity.revenue += item.revenue;
      entity.upstreamCost += item.upstreamCost;
      entity.administratorExpense += item.administratorExpense;
      entity.baseRequestCount += item.baseRequestCount;
      entity.upstreamRequestCount += item.upstreamRequestCount;
      entity.administratorRequestCount += item.administratorRequestCount;
      entity.missingRevenueRequests += item.missingRevenueRequests;
      entity.missingCostRequests += item.missingCostRequests;
      entity.missingAdministratorExpenseRequests += item.missingAdministratorExpenseRequests;
      entity.unconfirmedCostRequests += item.unconfirmedCostRequests;
      entity.unconvertedRevenueRequests += item.unconvertedRevenueRequests;
      entity.unconvertedCostRequests += item.unconvertedCostRequests;
      entity.unconvertedAdministratorExpenseRequests += item.unconvertedAdministratorExpenseRequests;
      entity.maximumPrecisionSeconds = Math.max(
        entity.maximumPrecisionSeconds,
        item.maximumPrecisionSeconds || 0
      );
      entity.hasActivity = true;
    }
    const allEntities = [...entityAmounts.values()].map((entity) => ({
      entityId: entity.entityId,
      entityName: entity.entityName,
      providerNames: [...entity.providerNames].sort((left, right) => left.localeCompare(right, 'zh-CN')),
      ...finalizeAmounts(entity)
    })).sort((left, right) => {
      const leftValue = Math.abs(left.provisionalGrossProfit || 0);
      const rightValue = Math.abs(right.provisionalGrossProfit || 0);
      return rightValue - leftValue || left.entityName.localeCompare(right.entityName, 'zh-CN');
    });
    const returnedEntities = allEntities.slice(0, MAX_RETURNED_ENTITIES);
    const returnedIds = new Set(returnedEntities.map((entity) => entity.entityId));
    const returnedItems = items.filter((item) => returnedIds.has(item.entityId)).sort((left, right) => (
      right.periodKey.localeCompare(left.periodKey) ||
      Math.abs(right.provisionalGrossProfit || 0) - Math.abs(left.provisionalGrossProfit || 0) ||
      left.entityName.localeCompare(right.entityName, 'zh-CN')
    ));
    const summaryAmounts = periods.reduce((summary, period) => {
      summary.revenue += period.revenue;
      summary.upstreamCost += period.upstreamCost;
      summary.administratorExpense += period.administratorExpense;
      summary.baseRequestCount += period.baseRequestCount;
      summary.upstreamRequestCount += period.upstreamRequestCount;
      summary.administratorRequestCount += period.administratorRequestCount;
      summary.missingRevenueRequests += period.missingRevenueRequests;
      summary.missingCostRequests += period.missingCostRequests;
      summary.missingAdministratorExpenseRequests += period.missingAdministratorExpenseRequests;
      summary.unconfirmedCostRequests += period.unconfirmedCostRequests;
      summary.unconvertedRevenueRequests += period.unconvertedRevenueRequests;
      summary.unconvertedCostRequests += period.unconvertedCostRequests;
      summary.unconvertedAdministratorExpenseRequests += period.unconvertedAdministratorExpenseRequests;
      summary.maximumPrecisionSeconds = Math.max(
        summary.maximumPrecisionSeconds,
        period.maximumPrecisionSeconds || 0
      );
      summary.hasActivity = summary.hasActivity || period.status !== 'empty';
      return summary;
    }, emptyAmounts());
    const summary = {
      ...finalizeAmounts(summaryAmounts),
      currency: currencySettings.currency,
      periodCount: periods.length,
      activePeriodCount: periods.filter((period) => period.status !== 'empty').length,
      profitablePeriodCount: periods.filter(
        (period) => finite(period.provisionalGrossProfit) > 0
      ).length,
      lossPeriodCount: periods.filter(
        (period) => finite(period.provisionalGrossProfit) < 0
      ).length,
      entityCount: allEntities.length,
      returnedEntityCount: returnedEntities.length,
      entityResultsTruncated: allEntities.length > returnedEntities.length,
      breakdownComplete: breakdown.complete,
      unattributedBaseRequestCount: breakdown.unattributedBaseRequestCount,
      unattributedBaseRevenue: round(breakdown.unattributedBaseRevenue),
      unattributedUpstreamRequestCount: breakdown.unattributedUpstreamRequestCount,
      unattributedUpstreamCost: round(breakdown.unattributedUpstreamCost),
      unattributedAdministratorRequestCount: breakdown.unattributedAdministratorRequestCount,
      unattributedAdministratorExpense: round(breakdown.unattributedAdministratorExpense),
      unknownRequesterUserRequestCount,
      requesterUserCoverageComplete: unknownRequesterUserRequestCount === 0,
      accountingModeComplete: query.accountingMode === 'standard' || unknownRequesterUserRequestCount === 0,
      unconvertedCurrencies: [...unconvertedCurrencies].sort()
    };
    return {
      query: {
        dimension: query.dimension,
        granularity: query.granularity,
        from: query.from,
        to: query.to,
        connectionId: query.connectionId,
        currency: query.currency,
        timezone: query.timezone,
        accountingMode: query.accountingMode
      },
      summary,
      periods,
      entities: returnedEntities,
      items: returnedItems,
      filterOptions: this.#filterOptions(currencySettings),
      generatedAt: this.now().toISOString()
    };
  }
}

module.exports = {
  ADMINISTRATOR_USER_ID,
  ADMINISTRATOR_ACCOUNT_ID,
  GrossProfitService,
  bucketForTimestamp,
  startOfDateInTimezone
};
