'use strict';

const { AppError } = require('../errors');
const {
  addUtcDays,
  dateInTimezone,
  parseDateRange,
  number
} = require('./metrics-service');

const GRANULARITIES = new Set(['day', 'week', 'month', 'year']);
const AUTOMATIC_INCOME_FILTER_SQL = `
  r.used_at >= $1::date::timestamp AT TIME ZONE $3
  AND r.used_at < $2::date::timestamp AT TIME ZONE $3
  AND r.used_at IS NOT NULL
  AND r.status = 'used'
  AND r.type IN ('balance', 'admin_balance')
  AND $4 = 'CNY'
`;

function amountFromMinor(value) {
  return number(value) / 100;
}

function publicEntry(entry) {
  const { amountMinor, ...rest } = entry;
  return { ...rest, amount: amountFromMinor(amountMinor) };
}

function utcDate(value) {
  return new Date(`${value}T00:00:00.000Z`);
}

function periodStart(date, granularity) {
  const value = utcDate(date);
  if (granularity === 'week') {
    const day = value.getUTCDay() || 7;
    value.setUTCDate(value.getUTCDate() - day + 1);
  } else if (granularity === 'month') {
    value.setUTCDate(1);
  } else if (granularity === 'year') {
    value.setUTCMonth(0, 1);
  }
  return value.toISOString().slice(0, 10);
}

function nextPeriod(date, granularity) {
  const value = utcDate(date);
  if (granularity === 'day') value.setUTCDate(value.getUTCDate() + 1);
  if (granularity === 'week') value.setUTCDate(value.getUTCDate() + 7);
  if (granularity === 'month') value.setUTCMonth(value.getUTCMonth() + 1, 1);
  if (granularity === 'year') value.setUTCFullYear(value.getUTCFullYear() + 1, 0, 1);
  return value.toISOString().slice(0, 10);
}

function periodLabel(start, granularity, end = start) {
  if (granularity === 'day') return start.slice(5);
  if (granularity === 'month') return start.slice(0, 7);
  if (granularity === 'year') return start.slice(0, 4);
  return `${start.slice(5)} ~ ${end.slice(5)}`;
}

function createPeriods(range, granularity) {
  const periods = [];
  let cursor = periodStart(range.start, granularity);
  while (cursor <= range.end) {
    const next = nextPeriod(cursor, granularity);
    const start = cursor < range.start ? range.start : cursor;
    const end = addUtcDays(next, -1) > range.end ? range.end : addUtcDays(next, -1);
    periods.push({
      key: cursor,
      label: periodLabel(start, granularity, end),
      start,
      end,
      automaticRevenue: 0,
      manualRevenue: 0,
      revenue: 0,
      expense: 0,
      profit: 0,
      transactions: 0,
      incomeCount: 0,
      expenseCount: 0,
      margin: null
    });
    cursor = next;
  }
  return periods;
}

function parseReportInput(input, config) {
  const range = parseDateRange(input, {
    maxDays: 3650,
    defaultDays: 30,
    today: dateInTimezone(config.financeTimezone)
  });
  const granularity = String(input.granularity || 'day').toLowerCase();
  if (!GRANULARITIES.has(granularity)) {
    throw new AppError('INVALID_GRANULARITY', '统计粒度必须是 day、week、month 或 year', { status: 400 });
  }
  const currency = String(input.currency || 'CNY').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_-]{0,11}$/.test(currency)) {
    throw new AppError('INVALID_CURRENCY', '币种格式无效', { status: 400 });
  }
  return { range, granularity, currency };
}

function parsePagination(input = {}) {
  const page = input.page == null || input.page === '' ? 1 : Number(input.page);
  const pageSize = input.pageSize == null || input.pageSize === '' ? 20 : Number(input.pageSize);
  if (!Number.isInteger(page) || page < 1 || page > 1000000 ||
      !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new AppError('INVALID_PAGINATION', '分页参数无效', { status: 400 });
  }
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function parseAutomaticIncomeInput(input, config) {
  const report = parseReportInput(input, config);
  const pagination = parsePagination(input);
  const search = String(input.search || '').trim();
  if (search.length > 100) {
    throw new AppError('INVALID_SEARCH', '搜索内容不能超过 100 个字符', { status: 400 });
  }
  return { ...report, ...pagination, search };
}

function parseAutomaticIncomeUserKey(value) {
  const key = String(value || '').trim();
  if (key === 'unassigned') return { userKey: key, userId: null };
  if (!/^[1-9]\d{0,18}$/.test(key) || BigInt(key) > 9223372036854775807n) {
    throw new AppError('INVALID_USER_ID', '用户 ID 无效', { status: 400 });
  }
  return { userKey: key, userId: key };
}

function paginationResult(page, pageSize, total) {
  return {
    page,
    pageSize,
    total,
    totalPages: Math.ceil(total / pageSize),
    hasPrevious: page > 1,
    hasNext: page * pageSize < total
  };
}

class CostAnalysisService {
  constructor({ pool, inspector, config, store, providerMonitor, sub2api }) {
    this.pool = pool;
    this.inspector = inspector;
    this.config = config;
    this.store = store;
    this.providerMonitor = providerMonitor;
    this.sub2api = sub2api;
  }

  async getProviders({ refresh = false, accessToken = null } = {}) {
    const cached = this.store.providers();
    const lastAttempt = cached.sync.attemptedAt || cached.sync.syncedAt;
    const age = lastAttempt ? Date.now() - Date.parse(lastAttempt) : Number.POSITIVE_INFINITY;
    const shouldRefresh = refresh || (this.providerMonitor.configured() && age > 5 * 60000);
    if (!shouldRefresh) return { ...cached, configured: this.providerMonitor.configured() };

    try {
      let token = accessToken;
      if (!this.providerMonitor.integrationToken && !token && this.sub2api?.configured()) {
        token = await this.sub2api.login();
      }
      const items = await this.providerMonitor.listProviders(token);
      await this.store.replaceProviders(items);
    } catch (error) {
      await this.store.recordProviderSyncFailure(error.message);
    }
    return { ...this.store.providers(), configured: this.providerMonitor.configured() };
  }

  listExpenses(input = {}) {
    const start = input.start || '0000-01-01';
    const end = input.end || '9999-12-31';
    const currency = input.currency ? String(input.currency).toUpperCase() : null;
    return this.store.entries()
      .filter((entry) => entry.date >= start && entry.date <= end && (!currency || entry.currency === currency))
      .sort((left, right) => right.date.localeCompare(left.date) || right.createdAt.localeCompare(left.createdAt))
      .map(publicEntry);
  }

  listCustomItems() {
    return [...new Set(this.store.entries()
      .filter((entry) => entry.kind === 'custom')
      .map((entry) => entry.name))]
      .sort((left, right) => left.localeCompare(right, 'zh-CN'));
  }

  listIncomes(input = {}) {
    const start = input.start || '0000-01-01';
    const end = input.end || '9999-12-31';
    const currency = input.currency ? String(input.currency).trim().toUpperCase() : null;
    return this.store.incomeEntries()
      .filter((entry) => entry.date >= start && entry.date <= end && (!currency || entry.currency === currency))
      .sort((left, right) => right.date.localeCompare(left.date) || right.createdAt.localeCompare(left.createdAt))
      .map(publicEntry);
  }

  listIncomeItems() {
    return [...new Set(this.store.incomeEntries().map((entry) => entry.name))]
      .sort((left, right) => left.localeCompare(right, 'zh-CN'));
  }

  async createExpense(input, actor) {
    const normalized = this.#normalizeExpense(input, null);
    return publicEntry(await this.store.createEntry({
      ...normalized,
      createdBy: actor || 'administrator',
      updatedBy: actor || 'administrator'
    }));
  }

  async updateExpense(id, input, actor) {
    const existing = this.store.entries().find((entry) => entry.id === id);
    if (!existing) throw new AppError('COST_ENTRY_NOT_FOUND', '支出记录不存在', { status: 404 });
    const normalized = this.#normalizeExpense(input, existing);
    return publicEntry(await this.store.updateEntry(id, {
      ...normalized,
      updatedBy: actor || 'administrator'
    }));
  }

  async deleteExpense(id) {
    return publicEntry(await this.store.deleteEntry(id));
  }

  async createIncome(input, actor) {
    const normalized = this.#normalizeIncome(input);
    return publicEntry(await this.store.createIncomeEntry({
      ...normalized,
      createdBy: actor || 'administrator',
      updatedBy: actor || 'administrator'
    }));
  }

  async updateIncome(id, input, actor) {
    if (!this.store.incomeEntries().some((entry) => entry.id === id)) {
      throw new AppError('COST_INCOME_NOT_FOUND', '手工收入记录不存在', { status: 404 });
    }
    return publicEntry(await this.store.updateIncomeEntry(id, {
      ...this.#normalizeIncome(input),
      updatedBy: actor || 'administrator'
    }));
  }

  async deleteIncome(id) {
    return publicEntry(await this.store.deleteIncomeEntry(id));
  }

  async getAutomaticIncomeUsers(input = {}) {
    const { range, currency, page, pageSize, offset, search } = parseAutomaticIncomeInput(input, this.config);
    await this.#requireAutomaticIncomeTables();
    const params = [
      range.start, range.endExclusive, this.config.financeTimezone, currency,
      search, pageSize, offset
    ];
    const searchSql = `
      AND (
        $5 = ''
        OR COALESCE(u.email, '') ILIKE '%' || $5 || '%'
        OR COALESCE(u.username, '') ILIKE '%' || $5 || '%'
        OR COALESCE(r.used_by::text, '') ILIKE '%' || $5 || '%'
        OR (r.used_by IS NULL AND '关联用户缺失' ILIKE '%' || $5 || '%')
      )
    `;
    const [summaryResult, usersResult] = await Promise.all([
      this.pool.query(`
        WITH user_totals AS (
          SELECT r.used_by,
                 COUNT(*) AS transactions,
                 COALESCE(SUM(r.value), 0) AS total_income
          FROM redeem_codes r
          LEFT JOIN users u ON u.id = r.used_by
          WHERE ${AUTOMATIC_INCOME_FILTER_SQL}
            ${searchSql}
          GROUP BY r.used_by
        )
        SELECT COUNT(*) AS total_users,
               COALESCE(SUM(transactions), 0) AS transactions,
               COALESCE(SUM(total_income), 0) AS total_income
        FROM user_totals
      `, params.slice(0, 5)),
      this.pool.query(`
        SELECT r.used_by::text AS user_id,
               MAX(u.email) AS email,
               MAX(NULLIF(u.username, '')) AS username,
               (MAX(u.deleted_at) IS NOT NULL) AS user_deleted,
               (r.used_by IS NOT NULL AND MAX(u.id) IS NULL) AS user_missing,
               COUNT(*) AS transactions,
               COALESCE(SUM(r.value), 0) AS total_income,
               MIN(r.used_at) AS first_used_at,
               MAX(r.used_at) AS last_used_at
        FROM redeem_codes r
        LEFT JOIN users u ON u.id = r.used_by
        WHERE ${AUTOMATIC_INCOME_FILTER_SQL}
          ${searchSql}
        GROUP BY r.used_by
        ORDER BY total_income DESC, last_used_at DESC NULLS LAST, r.used_by ASC NULLS LAST
        LIMIT $6 OFFSET $7
      `, params)
    ]);
    const summary = summaryResult.rows[0] || {};
    const totalUsers = number(summary.total_users);
    return {
      range,
      currency,
      timezone: this.config.financeTimezone,
      search,
      summary: {
        users: totalUsers,
        transactions: number(summary.transactions),
        totalIncome: Number(number(summary.total_income).toFixed(8))
      },
      pagination: paginationResult(page, pageSize, totalUsers),
      items: usersResult.rows.map((row) => ({
        userKey: row.user_id == null ? 'unassigned' : String(row.user_id),
        userId: row.user_id == null ? null : String(row.user_id),
        email: row.email || null,
        username: row.username || null,
        deleted: row.user_deleted === true || row.user_deleted === 'true',
        missing: row.user_id == null || row.user_missing === true || row.user_missing === 'true',
        transactions: number(row.transactions),
        totalIncome: Number(number(row.total_income).toFixed(8)),
        firstUsedAt: row.first_used_at || null,
        lastUsedAt: row.last_used_at || null
      }))
    };
  }

  async getAutomaticIncomeRecords(userKey, input = {}) {
    const { range, currency, page, pageSize, offset } = parseAutomaticIncomeInput(input, this.config);
    const user = parseAutomaticIncomeUserKey(userKey);
    await this.#requireAutomaticIncomeTables();
    const params = [
      range.start, range.endExclusive, this.config.financeTimezone, currency,
      user.userId, pageSize, offset
    ];
    const userFilterSql = `
      AND (($5::bigint IS NULL AND r.used_by IS NULL) OR r.used_by = $5::bigint)
    `;
    const [summaryResult, recordsResult, userResult] = await Promise.all([
      this.pool.query(`
        SELECT COUNT(*) AS transactions,
               COALESCE(SUM(r.value), 0) AS total_income,
               MIN(r.used_at) AS first_used_at,
               MAX(r.used_at) AS last_used_at
        FROM redeem_codes r
        WHERE ${AUTOMATIC_INCOME_FILTER_SQL}
          ${userFilterSql}
      `, params.slice(0, 5)),
      this.pool.query(`
        SELECT r.id::text AS id,
               r.code,
               r.type,
               r.value,
               r.notes,
               r.used_at,
               r.created_at
        FROM redeem_codes r
        WHERE ${AUTOMATIC_INCOME_FILTER_SQL}
          ${userFilterSql}
        ORDER BY r.used_at DESC, r.id DESC
        LIMIT $6 OFFSET $7
      `, params),
      user.userId == null
        ? Promise.resolve({ rows: [] })
        : this.pool.query(`
            SELECT id::text AS id, email, NULLIF(username, '') AS username, deleted_at
            FROM users
            WHERE id = $1::bigint
          `, [user.userId])
    ]);
    const summary = summaryResult.rows[0] || {};
    const total = number(summary.transactions);
    const userRow = userResult.rows[0];
    return {
      range,
      currency,
      timezone: this.config.financeTimezone,
      user: userRow ? {
        userKey: String(userRow.id),
        userId: String(userRow.id),
        email: userRow.email || null,
        username: userRow.username || null,
        deleted: Boolean(userRow.deleted_at),
        missing: false
      } : {
        userKey: user.userKey,
        userId: user.userId,
        email: null,
        username: null,
        deleted: false,
        missing: true
      },
      summary: {
        transactions: total,
        totalIncome: Number(number(summary.total_income).toFixed(8)),
        firstUsedAt: summary.first_used_at || null,
        lastUsedAt: summary.last_used_at || null
      },
      pagination: paginationResult(page, pageSize, total),
      items: recordsResult.rows.map((row) => ({
        id: String(row.id),
        code: row.code,
        type: row.type,
        value: Number(number(row.value).toFixed(8)),
        notes: row.notes || '',
        usedAt: row.used_at || null,
        createdAt: row.created_at || null
      }))
    };
  }

  async getReport(input = {}) {
    const { range, granularity, currency } = parseReportInput(input, this.config);
    await this.#requireAutomaticIncomeTables();
    const [automaticIncomeResult, balanceResult] = await Promise.all([
      this.pool.query(`
        SELECT (r.used_at AT TIME ZONE $3)::date::text AS date,
               COUNT(*) AS transactions,
               COALESCE(SUM(r.value), 0) AS revenue
        FROM redeem_codes r
        WHERE ${AUTOMATIC_INCOME_FILTER_SQL}
        GROUP BY 1 ORDER BY 1
      `, [range.start, range.endExclusive, this.config.financeTimezone, currency]),
      this.pool.query(`
        SELECT COALESCE(SUM(balance), 0) AS user_balance,
               COUNT(*) AS balance_users
        FROM users
        WHERE id <> 1
          AND deleted_at IS NULL
      `)
    ]);
    const rows = automaticIncomeResult.rows;

    const periods = createPeriods(range, granularity);
    const periodMap = new Map(periods.map((period) => [period.key, period]));
    for (const row of rows) {
      const period = periodMap.get(periodStart(row.date, granularity));
      if (!period) continue;
      period.automaticRevenue += number(row.revenue);
      period.transactions += number(row.transactions);
    }

    const breakdownMap = new Map();
    const incomeBreakdownMap = new Map();
    const incomes = this.store.incomeEntries().filter((entry) =>
      entry.date >= range.start && entry.date <= range.end && entry.currency === currency
    );
    for (const entry of incomes) {
      const amount = amountFromMinor(entry.amountMinor);
      const period = periodMap.get(periodStart(entry.date, granularity));
      if (period) {
        period.manualRevenue += amount;
        period.incomeCount += 1;
      }
      const current = incomeBreakdownMap.get(entry.name) || {
        name: entry.name,
        amount: 0,
        count: 0,
        percentage: 0
      };
      current.amount += amount;
      current.count += 1;
      incomeBreakdownMap.set(entry.name, current);
    }

    const expenses = this.store.entries().filter((entry) =>
      entry.date >= range.start && entry.date <= range.end && entry.currency === currency
    );
    for (const entry of expenses) {
      const amount = amountFromMinor(entry.amountMinor);
      const period = periodMap.get(periodStart(entry.date, granularity));
      if (period) {
        period.expense += amount;
        period.expenseCount += 1;
      }
      const identity = entry.kind === 'provider' ? `provider:${entry.providerId}` : `custom:${entry.name}`;
      const current = breakdownMap.get(identity) || {
        kind: entry.kind,
        providerId: entry.providerId || null,
        name: entry.name,
        amount: 0,
        count: 0,
        percentage: 0
      };
      current.amount += amount;
      current.count += 1;
      breakdownMap.set(identity, current);
    }

    let automaticRevenue = 0;
    let manualRevenue = 0;
    let expense = 0;
    let transactions = 0;
    for (const period of periods) {
      automaticRevenue += period.automaticRevenue;
      manualRevenue += period.manualRevenue;
      expense += period.expense;
      transactions += period.transactions;
      period.automaticRevenue = Number(period.automaticRevenue.toFixed(2));
      period.manualRevenue = Number(period.manualRevenue.toFixed(2));
      period.revenue = Number((period.automaticRevenue + period.manualRevenue).toFixed(2));
      period.expense = Number(period.expense.toFixed(2));
      period.profit = Number((period.revenue - period.expense).toFixed(2));
      period.margin = period.revenue ? Number((period.profit / period.revenue * 100).toFixed(2)) : null;
    }
    automaticRevenue = Number(automaticRevenue.toFixed(2));
    manualRevenue = Number(manualRevenue.toFixed(2));
    const revenue = Number((automaticRevenue + manualRevenue).toFixed(2));
    expense = Number(expense.toFixed(2));
    const profit = Number((revenue - expense).toFixed(2));
    const balanceApplies = currency === 'CNY';
    const userBalance = balanceApplies
      ? Number(number(balanceResult.rows[0]?.user_balance).toFixed(2))
      : null;
    const balanceUsers = balanceApplies ? number(balanceResult.rows[0]?.balance_users) : null;
    const actualProfit = balanceApplies ? Number((profit - userBalance).toFixed(2)) : null;
    const actualMargin = balanceApplies && revenue
      ? Number((actualProfit / revenue * 100).toFixed(2))
      : null;
    const breakdown = [...breakdownMap.values()]
      .map((row) => ({
        ...row,
        amount: Number(row.amount.toFixed(2)),
        percentage: expense ? Number((row.amount / expense * 100).toFixed(2)) : 0
      }))
      .sort((left, right) => right.amount - left.amount || left.name.localeCompare(right.name, 'zh-CN'));
    const incomeBreakdown = [...incomeBreakdownMap.values()]
      .map((row) => ({
        ...row,
        amount: Number(row.amount.toFixed(2)),
        percentage: manualRevenue ? Number((row.amount / manualRevenue * 100).toFixed(2)) : 0
      }))
      .sort((left, right) => right.amount - left.amount || left.name.localeCompare(right.name, 'zh-CN'));

    return {
      range,
      granularity,
      currency,
      timezone: this.config.financeTimezone,
      summary: {
        automaticRevenue,
        manualRevenue,
        revenue,
        expense,
        profit,
        margin: revenue ? Number((profit / revenue * 100).toFixed(2)) : null,
        userBalance,
        balanceUsers,
        actualProfit,
        actualMargin,
        transactions,
        incomeCount: incomes.length,
        expenseCount: expenses.length,
        averageTransaction: transactions ? Number((automaticRevenue / transactions).toFixed(2)) : null
      },
      periods,
      breakdown,
      incomeBreakdown,
      caveats: [
        '自动收入只统计 Sub2API 兑换页面中已使用的余额记录（balance、admin_balance），以 used_at 归属日期；每条记录只统计一次。',
        '并发、管理员并发调整、订阅和邀请记录不是金额，均不计入自动收入。',
        '管理员余额增加会增加自动收入，管理员扣减余额等负数记录会冲减自动收入；admin_balance 也可能是赠送或纠错，并不必然代表现金实收。',
        '同一笔线下充值若已录入手工收入，请删除对应手工记录，避免与管理员余额调整记录重复统计。',
        '兑换记录没有币种字段，自动收入统一按 CNY 归集；其他币种报表仅包含对应币种的手工收支。',
        '支付订单不会与兑换记录叠加；总收入为自动收入与手工收入之和，平均金额仅使用自动收入计算。',
        '支出按手工台账的发生日期归集；不同币种不会自动换算。',
        '利润为总收入减手工支出，不包含税费，也不扣除退款估算。',
        '用户总余额是当前未删除用户的 balance 合计并排除 ID 1；实际利润为利润减用户总余额，余额是当前快照且不随查询日期回溯。',
        '自动收入直接依赖 Sub2API 当前兑换记录；源记录被删除后，历史报表会同步减少。'
      ]
    };
  }

  async #requireAutomaticIncomeTables() {
    const missing = await this.inspector.requireTables(['redeem_codes', 'users']);
    if (missing.length) {
      throw new AppError('SCHEMA_INCOMPATIBLE', `缺少必要数据表：${missing.join(', ')}`, {
        status: 503,
        details: { missing }
      });
    }
  }

  #normalizeExpense(input, existing) {
    const kind = input.kind;
    if (!['provider', 'custom'].includes(kind)) {
      throw new AppError('COST_KIND_INVALID', '支出类型无效', { status: 400 });
    }
    const fields = this.#normalizeMoneyFields(input, '支出', 'COST');
    let providerId = null;
    let name = String(input.name || '').trim();
    if (kind === 'provider') {
      providerId = String(input.providerId || '').trim();
      const provider = this.store.providers().items.find((item) => item.id === providerId);
      if (!provider && !(existing?.kind === 'provider' && existing.providerId === providerId)) {
        throw new AppError('COST_PROVIDER_NOT_FOUND', '请选择供应商监控中已同步的供应商', { status: 400 });
      }
      const keepsExistingSnapshot = existing?.kind === 'provider' && existing.providerId === providerId;
      name = keepsExistingSnapshot ? existing.name : provider.name;
    } else if (!name) {
      throw new AppError('COST_NAME_REQUIRED', '请输入自定义支出项名称', { status: 400 });
    }
    return {
      kind,
      providerId,
      name,
      ...fields
    };
  }

  #normalizeIncome(input) {
    const name = String(input.name || '').trim();
    if (!name) {
      throw new AppError('COST_INCOME_NAME_REQUIRED', '请输入手工收入项名称', { status: 400 });
    }
    return { name, ...this.#normalizeMoneyFields(input, '收入', 'COST_INCOME') };
  }

  #normalizeMoneyFields(input, label, codePrefix) {
    const currency = String(input.currency || '').trim().toUpperCase();
    const amount = Number(input.amount);
    const amountMinor = Math.round(amount * 100);
    const date = String(input.date || '');
    const parsedDate = new Date(`${date}T00:00:00.000Z`);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000000000 ||
        Math.abs(amount - amountMinor / 100) >= 1e-9) {
      throw new AppError(`${codePrefix}_AMOUNT_INVALID`, `${label}金额必须大于零且最多保留两位小数`, { status: 400 });
    }
    if (date.startsWith('0000-') || Number.isNaN(parsedDate.getTime()) ||
        parsedDate.toISOString().slice(0, 10) !== date) {
      throw new AppError(`${codePrefix}_DATE_INVALID`, `${label}发生日期无效`, { status: 400 });
    }
    if (!/^[A-Z][A-Z0-9_-]{0,11}$/.test(currency)) {
      throw new AppError(`${codePrefix}_CURRENCY_INVALID`, `${label}币种格式无效`, { status: 400 });
    }
    return {
      date,
      amountMinor,
      currency,
      note: String(input.note || '').trim()
    };
  }
}

module.exports = {
  CostAnalysisService,
  amountFromMinor,
  createPeriods,
  parseAutomaticIncomeInput,
  parseAutomaticIncomeUserKey,
  parseReportInput,
  periodStart,
  publicEntry
};
