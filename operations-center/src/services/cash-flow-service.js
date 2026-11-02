'use strict';

const crypto = require('node:crypto');
const Decimal = require('decimal.js');
const { DateTime } = require('luxon');
const { z } = require('zod');
const { AppError } = require('../errors');
const { dateInTimezone } = require('./metrics-service');
const { localDate } = require('./accounting-source');
const { AccountingService } = require('./accounting-service');
const { parseAutomaticIncomeInput, parseAutomaticIncomeUserKey, createPeriods } = require('./cost-analysis-service');

const number = value => new Decimal(value).toDecimalPlaces(8).toNumber();
const validAmount = value => { try { return value != null && value !== '' && new Decimal(value).isFinite() && new Decimal(value).gte(0); } catch { return false; } };
const validCredit = value => { try { return value != null && value !== '' && new Decimal(value).isFinite(); } catch { return false; } };
const totals = rows => {
  const sum = direction => number(rows.filter(row => row.counted !== false && row.direction === direction).reduce((sum, row) => sum.plus(row.amount), new Decimal(0)));
  const income = sum('income'), expense = sum('expense');
  return { income, expense, net: number(new Decimal(income).minus(expense)) };
};
const noncash = new Set(['gift', 'correction', 'excluded', 'reference', 'transfer', 'funding']);
const paidStatuses = new Set(['PAID', 'COMPLETED', 'RECHARGING', 'FAILED', 'REFUND_REQUESTED', 'REFUND_PENDING',
  'REFUND_FAILED', 'REFUNDING', 'REFUNDED', 'PARTIAL_REFUNDED', 'PARTIALLY_REFUNDED']);
const entrySchema = z.object({
  direction: z.enum(['income', 'expense']), category: z.enum(['custom', 'provider']).default('custom'),
  name: z.string().trim().min(1).max(120), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount: z.coerce.number().finite().positive().max(1e12).refine(value => new Decimal(value).decimalPlaces() <= 2, '金额最多保留两位小数'),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_-]{0,11}$/).default('CNY'),
  providerId: z.string().trim().max(100).default(''), sourceRef: z.string().trim().max(120).default(''),
  note: z.string().trim().max(500).default(''), requestId: z.string().uuid().optional()
}).strict();

class CashFlowService {
  constructor({ pool, inspector, config, store, ledger, analysis, accounting, now = () => new Date() }) {
    Object.assign(this, { pool, inspector, config, store, ledger, analysis, accounting, now });
    this.running = null;
    this.error = null;
    this.scopeKey = null;
  }

  scope() {
    const scope = AccountingService.scope(this.config);
    if (scope !== this.scopeKey) {
      this.scopeKey = scope;
      this.store.scope = scope;
      this.balancesCache = null;
      this.rowsCache = null;
      this.providerCache = null;
      this.error = null;
    }
    return scope;
  }

  start() {
    if (this.started) return;
    this.started = true;
    const tick = () => this.sync().catch(() => {});
    this.timer = setInterval(tick, 60000);
    this.timer.unref?.();
    tick();
  }

  async stop() {
    this.started = false;
    clearInterval(this.timer);
    clearTimeout(this.continuation);
    await this.running;
  }

  async sync({ force = false } = {}) {
    this.scope();
    if (this.running) return this.running;
    const status = this.store.setting('cash:sync', {});
    if (!force && status.complete && status.creditsComplete && !status.cursor && !status.creditCursor && Date.parse(status.completedAt) + 60000 > this.now().getTime() && !this.error) return;
    const scope = this.scopeKey;
    this.running = (async () => {
      try {
        const schema = await this.inspector.inspect();
        if (!schema.tables.payment_orders?.exists) throw new Error('payment source missing');
        if (!schema.tables.redeem_codes?.exists) throw new Error('redemption source missing');
        let cursor = status.cursor || '0', finished = false;
        for (let page = 0; page < 4; page++) {
          const { rows } = await this.pool.query(`SELECT p.id::text AS id,p.user_id::text AS user_id,p.paid_at,
            p.pay_amount::text AS amount,p.order_type,p.status,p.refund_at,p.refund_amount::text AS refund_quantity,
            COALESCE(NULLIF(to_jsonb(p)->'provider_snapshot'->>'currency',''),
              NULLIF(to_jsonb(p)->'provider_snapshot'->'config'->>'currency','')) AS currency,
            COALESCE(to_jsonb(p)->>'order_no',to_jsonb(p)->>'order_number','') AS order_number,
            ${schema.tables.redeem_codes?.exists ? `(SELECT jsonb_agg(r.id::text) FROM redeem_codes r
              WHERE r.code=p.recharge_code AND p.recharge_code<>'' AND r.used_by=p.user_id AND r.status='used')` : 'NULL'} AS redeem_ids
            FROM payment_orders p WHERE p.id>$1::bigint ORDER BY p.id LIMIT 1000`, [cursor]);
          if (AccountingService.scope(this.config) !== scope) return;
          this.store.db.transaction(() => {
            const decisions = this.store.decisions();
            for (const row of rows) this.savePayment(row, decisions);
          })();
          if (rows.length < 1000) { finished = true; break; }
          cursor = rows.at(-1).id;
        }
        let creditCursor = status.creditCursor || '0', creditsFinished = false;
        if (schema.tables.redeem_codes?.exists) {
          for (let page = 0; page < 4; page++) {
            const { rows } = await this.pool.query(`SELECT r.id::text AS id,r.used_by::text AS user_id,
              r.type,r.value::text AS value,r.used_at,r.code,r.notes,to_jsonb(r)->>'created_at' AS created_at
              FROM redeem_codes r WHERE r.id>$1::bigint AND r.status='used' AND r.used_at IS NOT NULL
              AND r.type IN ('balance','admin_balance') AND r.used_by IS DISTINCT FROM 1 ORDER BY r.id LIMIT 1000`, [creditCursor]);
            if (AccountingService.scope(this.config) !== scope) return;
            this.store.importDocuments(rows.map(row => {
              const key = `redeem:${row.id}`, previous = this.store.document(key);
              return { ...previous, key, origin: 'redeem', date: localDate(row.used_at, this.config.financeTimezone),
                userId: row.user_id || previous?.userId || null, kind: 'credit', quantity: row.value, redeemType: row.type,
                name: `兑换记录 #${row.id}`, note: row.notes || '', code: row.code,
                usedAt: row.used_at instanceof Date ? row.used_at.toISOString() : row.used_at,
                sourceCreatedAt: row.created_at, payments: previous?.payments || [] };
            }).filter(row => row.date));
            if (rows.length < 1000) { creditsFinished = true; break; }
            creditCursor = rows.at(-1).id;
          }
        }
        this.store.saveCashSync({ complete: status.complete || finished,
          cursor: finished ? null : cursor, completedAt: finished ? this.now().toISOString() : status.completedAt || null,
          creditCursor: creditsFinished ? null : creditCursor, creditsComplete: status.creditsComplete || creditsFinished });
        this.error = null;
        this.rowsCache = null;
        if ((!finished || (!creditsFinished && schema.tables.redeem_codes?.exists)) && this.started) {
          clearTimeout(this.continuation);
          this.continuation = setTimeout(() => this.sync({ force: true }).catch(() => {}), 1000);
          this.continuation.unref?.();
        }
      } catch {
        this.error = '自动入账来源暂不可用，后台将自动重试';
      }
    })();
    try { await this.running; } finally { this.running = null; }
  }

  savePayment(row, decisions = this.store.decisions()) {
    const key = `payment:${row.id}`, previous = this.store.cashRecord(key);
    const date = localDate(row.paid_at, this.config.financeTimezone);
    const old = this.store.document(key), saved = decisions[key];
    const userId = row.user_id == null ? previous?.userId || old?.userId || null : String(row.user_id);
    const sameFacts = old && old.date === date && old.userId === userId && validAmount(old.amount) && new Decimal(old.amount).eq(row.amount || 0);
    const decision = sameFacts && saved && (!saved.sourceHash || saved.sourceHash === this.accounting?.sourceHash(old)) ? saved : null;
    const sameCash = previous && previous.date === date && previous.userId === userId && validAmount(row.amount) && new Decimal(previous.amount).eq(row.amount);
    const originalCurrency = String(row.currency || decision?.currency || (sameCash && previous.currency) || 'UNKNOWN').trim().toUpperCase();
    const currency = /^[A-Z][A-Z0-9_-]{0,11}$/.test(originalCurrency) ? originalCurrency : 'UNKNOWN';
    const active = userId !== '1' && Boolean(date) && validAmount(row.amount) && paidStatuses.has(String(row.status).toUpperCase());
    if (!active && !previous) return;
    const unchanged = previous && previous.amount === String(row.amount) && previous.currency === currency && previous.date === date;
    this.store.putCash({ key, source: 'automatic', direction: 'income', date: date || previous.date,
      amount: validAmount(row.amount) ? String(row.amount) : '0', currency, userId,
      name: row.order_type === 'subscription' ? `订阅付款 #${row.id}` : `余额充值付款 #${row.id}`,
      category: 'custom', providerId: '', sourceRef: row.order_number || key, note: '',
      aliases: [...new Set([key, row.order_number, ...(row.redeem_ids || []).map(id => `redeem:${id}`), ...(previous?.aliases || [])].filter(Boolean))],
      rate: (unchanged ? previous.rate : decision?.rate) ?? null, active,
      paidAt: row.paid_at instanceof Date ? row.paid_at.toISOString() : row.paid_at,
      refundDate: localDate(row.refund_at, this.config.financeTimezone),
      refundQuantity: validAmount(row.refund_quantity) ? String(row.refund_quantity) : '0' });
  }

  legacyRows() {
    const documents = this.store.documents(), decisions = this.store.decisions();
    const byKey = new Map(documents.map(document => [document.key, document]));
    const decisionFor = document => {
      const decision = decisions[document.key];
      if (!decision) return null;
      if (decision.sourceHash && this.accounting && decision.sourceHash !== this.accounting.sourceHash(document)) return null;
      return decision;
    };
    const rows = [];
    const append = (document, direction, source = 'legacy') => {
      const decision = decisionFor(document);
      if (document.userId === '1' || noncash.has(decision?.kind) || decision?.paid === false || document.paid === false) return;
      const currency = String(decision?.currency || document.currency || 'UNKNOWN').toUpperCase();
      const amount = decision?.amount ?? document.amount;
      if (!validAmount(amount)) return;
      rows.push({ key: document.key, source, direction, date: decision?.date || document.date,
        name: document.name, amount: String(amount), currency,
        rate: decision?.rate ?? null,
        providerId: decision?.providerId || document.providerId || '', category: (decision?.kind || document.kind) === 'provider_prepayment' || document.providerId ? 'provider' : 'custom',
        sourceRef: decision?.linkedKey || document.linkedKey || '', note: document.note || document.reason || '',
        userId: document.userId || null, active: true, legacy: true, aliases: document.payments?.map(payment => `payment:${payment.id}`) || [] });
      if (source === 'automatic') {
        const refund = byKey.get(`refund:${document.key.slice(8)}`);
        rows.at(-1).refundDate = refund?.date || null;
        rows.at(-1).refundQuantity = refund?.quantity || '0';
      }
    };
    const snapshot = this.ledger.snapshot();
    for (const [entries, direction, prefix] of [[snapshot.entries, 'expense', 'legacy-expense'], [snapshot.incomes, 'income', 'legacy-income']]) {
      for (const entry of entries) {
        const key = `${prefix}:${entry.id}`, original = byKey.get(key);
        const same = original && original.date === entry.date && original.name === entry.name &&
          new Decimal(original.amount).eq(entry.amountMinor / 100) && original.currency === entry.currency &&
          (original.providerId || '') === (entry.providerId || '') && (original.note || '') === (entry.note || '');
        append(same ? original : { key, date: entry.date, name: entry.name, amount: entry.amountMinor / 100,
          currency: entry.currency, providerId: entry.providerId || null, note: entry.note }, direction);
      }
    }
    for (const document of documents) {
      if (document.origin === 'payment' && !this.store.cashRecord(document.key) && (!document.status || paidStatuses.has(String(document.status).toUpperCase()))) {
        append(document, 'income', 'automatic');
      } else if (document.origin === 'redeem' && !document.payments?.length) {
        const decision = decisionFor(document);
        if (decision?.kind === 'customer_receipt' && validAmount(decision.amount)) append(document, 'income');
      } else if (document.origin === 'manual' || document.origin === 'refund') {
        const kind = decisionFor(document)?.kind || document.kind;
        if (['customer_receipt', 'subscription', 'service_income'].includes(kind)) append(document, 'income');
        if (['fee', 'provider_prepayment', 'refund_unconsumed', 'refund_service', 'refund_subscription'].includes(kind)) append(document, 'expense');
      }
    }
    return rows;
  }

  rows() {
    this.scope();
    const audit = this.store.db.prepare('SELECT MAX(id) AS id FROM accounting_audit WHERE scope=?').get(this.scopeKey).id;
    const cacheKey = String(audit);
    if (this.rowsCache?.key === cacheKey && this.rowsCache.ledger === this.ledger.state && this.rowsCache.until > Date.now()) return this.rowsCache.rows;
    const records = new Map(this.legacyRows().map(row => [row.key, row]));
    const decisions = this.store.decisions(), excluded = new Set(), documents = new Map(this.store.documents().map(document => [document.key, document]));
    for (const document of documents.values()) {
      const decision = decisions[document.key];
      if (!decision || (decision.sourceHash && this.accounting && decision.sourceHash !== this.accounting.sourceHash(document))) continue;
      if (noncash.has(decision.kind) || decision.paid === false) {
        excluded.add(document.key);
        if (document.origin === 'redeem' && decision.kind === 'excluded') for (const payment of document.payments || []) excluded.add(`payment:${payment.id}`);
      }
    }
    const today = dateInTimezone(this.config.financeTimezone, this.now());
    const redemptionKeys = new Set(), redeemedPayments = new Set();
    for (const credit of documents.values()) {
      if (credit.origin !== 'redeem' || !['balance', 'admin_balance'].includes(credit.redeemType) || !credit.date || !validCredit(credit.quantity)) continue;
      const decision = decisions[credit.key], validDecision = decision && (!decision.sourceHash || !this.accounting || decision.sourceHash === this.accounting.sourceHash(credit));
      const paymentKeys = (credit.payments || []).map(payment => `payment:${payment.id}`);
      if (credit.userId !== '1' && credit.date <= today) {
        redemptionKeys.add(credit.key);
        for (const key of paymentKeys) redeemedPayments.add(key);
      }
      records.set(credit.key, { key: credit.key, source: 'automatic', basis: 'redeem', direction: 'income',
        date: credit.date, name: `${credit.redeemType === 'admin_balance' ? '管理员余额入账' : '余额兑换'} #${credit.key.slice(7)}`,
        amount: credit.quantity, currency: 'CNY', rate: 1, userId: credit.userId || null,
        category: 'custom', providerId: '', sourceRef: credit.key, note: credit.note || '',
        active: !excluded.has(credit.key) && !paymentKeys.some(key => excluded.has(key)) && !(validDecision && decision.paid === false),
        aliases: [credit.key, credit.code, ...paymentKeys].filter(Boolean) });
    }
    for (const record of this.store.cashRecords()) {
      const old = documents.get(record.key), decision = decisions[record.key];
      const matchesOld = !old || (validAmount(old.amount) && new Decimal(old.amount).eq(record.amount) && old.date === record.date &&
        (!old.currency || old.currency === record.currency) && old.userId === record.userId);
      records.set(record.key, { ...record, ...(record.source === 'automatic' && matchesOld && excluded.has(record.key) ? { active: false } : {}),
        rate: record.rate || (matchesOld && decision?.rate) || null });
    }
    const rows = [...records.values()].filter(row => row.active !== false && row.date <= today && row.userId !== '1')
      .map(row => ({ ...row, amount: number(row.amount), counted: true }));
    // Excluded redemptions must also suppress linked orders so a late payment cannot restore excluded income.
    for (const row of rows) if (row.source === 'automatic' && row.basis !== 'redeem' &&
        (redeemedPayments.has(row.key) || (row.aliases || []).some(alias => redemptionKeys.has(alias)))) {
      row.counted = false; row.mergeReason = '已关联已使用余额兑换，不重复入账';
    }
    const automaticAliases = new Set(rows.filter(row => row.source === 'automatic').flatMap(row => row.aliases || [row.key, row.sourceRef]).map(value => value.toLowerCase()));
    const linked = new Set();
    for (const row of rows) {
      const reference = row.sourceRef?.toLowerCase();
      if (row.source !== 'automatic' && row.direction === 'income' && (automaticAliases.has(row.key.toLowerCase()) ||
          (reference && automaticAliases.has(reference)) || (row.aliases || []).some(alias => automaticAliases.has(alias.toLowerCase())))) {
        row.counted = false; row.mergeReason = '已由自动入账统计';
      } else if (reference && row.source !== 'automatic' && rows.some(other => other.key.toLowerCase() === reference && other.direction === row.direction && other.key !== row.key)) {
        row.counted = false; row.mergeReason = '已由关联原记录统计';
      } else if (reference && row.source !== 'automatic') {
        if (linked.has(reference)) { row.counted = false; row.mergeReason = '来源单号已统计'; }
        else linked.add(reference);
      }
      // Cash amounts are treated as RMB at face value; source currency remains archived.
      row.cnyAmount = row.amount;
    }
    rows.sort((left, right) => right.date.localeCompare(left.date) || (right.createdAt || '').localeCompare(left.createdAt || '') || right.key.localeCompare(left.key));
    this.rowsCache = { key: cacheKey, ledger: this.ledger.state, until: Date.now() + 30000, rows };
    return rows;
  }

  sourceStatus() {
    const status = this.store.setting('cash:sync', {});
    const complete = Boolean(status.complete && status.creditsComplete);
    return { complete: complete && !this.error, syncing: Boolean(status.cursor || status.creditCursor) || !complete,
      capturedAt: status.completedAt || null, message: this.error || (!complete ? '全历史入账正在自动同步' : null) };
  }

  async balances({ refresh = false } = {}) {
    const scope = this.scope();
    if (!refresh && this.balancesCache?.until > Date.now()) return this.balancesCache.value;
    const { rows } = await this.pool.query(`SELECT u.id::text AS id,u.balance::text AS balance,u.deleted_at,
      to_jsonb(u)->>'email' AS email,to_jsonb(u)->>'username' AS username
      FROM users u WHERE u.id<>1 AND u.deleted_at IS NULL`);
    if (scope !== AccountingService.scope(this.config)) throw new AppError('CASH_SOURCE_CHANGED', '数据来源已变更，正在重新读取', { status: 409 });
    const users = rows.filter(row => row.id !== '1' && !row.deleted_at).map(row => ({ id: row.id,
      name: row.username || row.email || `用户 #${row.id}`, email: row.email || '', balance: number(row.balance) }));
    const value = { capturedAt: this.now().toISOString(), userBalance: number(users.reduce((total, row) => total.plus(row.balance), new Decimal(0))), users };
    this.balancesCache = { until: Date.now() + 30000, value };
    return value;
  }

  async getBalances(input = {}) {
    const { page, pageSize, search, offset } = parseAutomaticIncomeInput(input, this.config);
    const balances = await this.balances({ refresh: input.refresh === '1' });
    const users = balances.users.filter(user => `${user.id} ${user.name} ${user.email}`.toLowerCase().includes(search.toLowerCase()));
    return { ...balances, users: undefined, items: users.slice(offset, offset + pageSize),
      pagination: { page, pageSize, total: users.length, totalPages: Math.ceil(users.length / pageSize) } };
  }

  async providerBalances({ accessToken = null, refresh = false } = {}) {
    const scope = this.scope();
    if (!refresh && this.providerCache?.until > Date.now()) return this.providerCache.value;
    if (!accessToken && !this.analysis.providerMonitor.integrationToken && this.analysis.sub2api?.configured()) accessToken = await this.analysis.sub2api.login();
    const result = await this.analysis.providerMonitor.getFinancialBalances(accessToken);
    if (scope !== AccountingService.scope(this.config)) throw new AppError('CASH_SOURCE_CHANGED', '数据来源已变更，正在重新读取', { status: 409 });
    if (result?.currency !== 'CNY' || result.providerFilter !== 'scheduled_enabled' || !Array.isArray(result.items) ||
        (result.complete === true && !validAmount(result.total))) throw new AppError('BALANCE_SOURCE_INVALID', '上游余额来源暂不可用', { status: 502 });
    const value = { ...result, total: result.complete ? number(result.total) : null, capturedAt: this.now().toISOString() };
    this.providerCache = { until: Date.now() + 30000, value };
    return value;
  }

  async creditUsers(input = {}, userKey = null) {
    this.scope();
    const today = dateInTimezone(this.config.financeTimezone, this.now());
    const { range, page, pageSize, offset, search } = parseAutomaticIncomeInput({ start: today.slice(0, 7) + '-01', end: today, ...input }, this.config);
    const identity = userKey == null ? null : parseAutomaticIncomeUserKey(userKey);
    await this.sync({ force: input.refresh === '1' });
    let sourceUsers = [];
    try { sourceUsers = (await this.pool.query(`SELECT u.id::text AS id,to_jsonb(u)->>'email' AS email,
      to_jsonb(u)->>'username' AS username,u.deleted_at FROM users u WHERE u.id<>1`)).rows; } catch { /* Archived credits retain their original identity. */ }
    const byUser = new Map(sourceUsers.map(user => [user.id, user])), groups = new Map();
    for (const credit of this.store.documents().filter(row => row.origin === 'redeem' && row.userId !== '1' &&
      ['balance', 'admin_balance'].includes(row.redeemType) && row.date >= range.start && row.date <= range.end && row.date <= today)) {
      const key = credit.userId || 'unassigned', user = byUser.get(credit.userId);
      if (!groups.has(key)) groups.set(key, { userKey: key, userId: credit.userId, username: user?.username || credit.userName || null,
        email: user?.email || null, missing: !user, deleted: Boolean(user?.deleted_at), records: [], total: new Decimal(0) });
      const group = groups.get(key); group.records.push(credit); group.total = group.total.plus(credit.quantity);
    }
    const matched = [...groups.values()].filter(user => `${user.userId || ''} ${user.username || ''} ${user.email || ''}`.toLowerCase().includes(search.toLowerCase()))
      .sort((a, b) => b.total.comparedTo(a.total) || a.userKey.localeCompare(b.userKey));
    const pagination = total => ({ page, pageSize, total, totalPages: Math.ceil(total / pageSize), hasPrevious: page > 1, hasNext: page * pageSize < total });
    const publicUser = user => ({ userKey: user.userKey, userId: user.userId, username: user.username, email: user.email,
      missing: user.missing, deleted: user.deleted, transactions: user.records.length, totalIncome: number(user.total),
      lastUsedAt: user.records.map(row => row.usedAt || row.date).sort().at(-1) });
    const header = { range, currency: 'CNY', timezone: this.config.financeTimezone, complete: Boolean(this.store.setting('cash:sync', {}).creditsComplete) && !this.error };
    if (identity) {
      const user = groups.get(identity.userKey) || { ...identity, records: [], total: new Decimal(0), missing: true };
      const records = user.records.sort((a, b) => (b.usedAt || b.date).localeCompare(a.usedAt || a.date) || b.key.localeCompare(a.key));
      return { ...header, user: publicUser(user), summary: { transactions: records.length, totalIncome: number(user.total) }, pagination: pagination(records.length),
        items: records.slice(offset, offset + pageSize).map(row => ({ id: row.key.slice(7), code: row.code || '归档未保存', type: row.redeemType,
          value: number(row.quantity), notes: row.note || '', usedAt: row.usedAt || row.date, createdAt: row.sourceCreatedAt })) };
    }
    return { ...header, summary: { users: matched.length, transactions: matched.reduce((sum, user) => sum + user.records.length, 0),
      totalIncome: number(matched.reduce((sum, user) => sum.plus(user.total), new Decimal(0))) }, pagination: pagination(matched.length), items: matched.slice(offset, offset + pageSize).map(publicUser) };
  }

  async getReport(input = {}) {
    const today = dateInTimezone(this.config.financeTimezone, this.now());
    const query = parseAutomaticIncomeInput({ start: today.slice(0, 7) + '-01', end: today, ...input, currency: 'CNY' }, this.config);
    if (!['all', 'income', 'expense'].includes(input.direction || 'all') || !['all', 'automatic', 'manual'].includes(input.origin || 'all')) throw new AppError('CASH_FILTER_INVALID', '收支或来源筛选无效', { status: 400 });
    await this.sync({ force: input.refresh === '1' });
    const source = this.sourceStatus(), rows = this.rows();
    const selected = rows.filter(row => row.date >= query.range.start && row.date <= query.range.end);
    const unresolved = this.unresolvedRefunds(rows, query.range);
    const complete = source.complete && !unresolved.length;
    const known = totals(selected), summary = { ...known, income: source.complete ? known.income : null,
      expense: unresolved.length ? null : known.expense, net: complete ? known.net : null, complete,
      automatic: totals(selected.filter(row => row.source === 'automatic')).income, manual: totals(selected.filter(row => row.source !== 'automatic')).income };
    const filtered = selected.filter(row => (input.direction == null || input.direction === 'all' || row.direction === input.direction) &&
      (input.origin == null || input.origin === 'all' || (input.origin === 'automatic' ? row.source === 'automatic' : row.source !== 'automatic')) &&
      `${row.name} ${row.providerId} ${this.ledger.providers().items.find(provider => provider.id === row.providerId)?.name || ''} ${row.key} ${row.sourceRef} ${row.note}`.toLowerCase().includes(query.search.toLowerCase()));
    const periods = createPeriods(query.range, query.granularity).map(period => ({ key: period.key, label: period.label,
      ...totals(selected.filter(row => row.date >= period.start && row.date <= period.end)),
      ...(!source.complete ? { income: null, net: null } : {}),
      ...(this.unresolvedRefunds(rows, period).length ? { expense: null, net: null } : {}) }));
    let balance;
    try { balance = await this.balances({ refresh: input.refresh === '1' }); } catch { balance = { userBalance: null, capturedAt: null }; }
    const cumulative = this.cumulative(rows, source, balance);
    const page = Math.min(query.page, Math.max(1, Math.ceil(filtered.length / query.pageSize)));
    return { range: query.range, currency: query.currency, timezone: this.config.financeTimezone, granularity: query.granularity,
      generatedAt: this.now().toISOString(), summary, known, cumulative, source, periods,
      currencies: ['CNY'],
      items: filtered.slice((page - 1) * query.pageSize, page * query.pageSize).map(row => this.publicRow(row)),
      pagination: { page, pageSize: query.pageSize, total: filtered.length, totalPages: Math.ceil(filtered.length / query.pageSize) },
      filteredSummary: totals(filtered), recordCount: selected.length,
      notices: [source.message, unresolved.length ? '存在退额度记录，尚无实际现金退款金额；未按额度估算现金' : null].filter(Boolean) };
  }

  unresolvedRefunds(rows, range = null) {
    return rows.filter(row => row.source === 'automatic' && row.refundDate && new Decimal(row.refundQuantity || 0).gt(0) &&
      row.refundDate <= dateInTimezone(this.config.financeTimezone, this.now()) &&
      (!range || (row.refundDate >= (range.start || range.key) && row.refundDate <= (range.end || range.key))) &&
      !rows.some(other => other.counted && other.direction === 'expense' && [other.sourceRef?.toLowerCase(), other.key].includes(`refund:${row.key.slice(8)}`)));
  }

  cumulative(rows, source, balance) {
    const counted = rows.filter(row => row.counted), amounts = totals(counted);
    const income = source.complete ? amounts.income : null, expense = this.unresolvedRefunds(rows).length ? null : amounts.expense;
    return { currency: 'CNY', income, expense, userBalance: balance.userBalance,
      net: income != null && expense != null && balance.userBalance != null ? number(new Decimal(income).minus(expense).minus(balance.userBalance)) : null,
      capturedAt: this.now().toISOString(), balanceCapturedAt: balance.capturedAt, recordCount: counted.length,
      missingRates: 0, from: counted.map(row => row.date).sort()[0] || null,
      originals: [{ currency: 'CNY', ...amounts }],
      notices: [!source.complete ? source.message : null,
        balance.userBalance == null ? '当前用户余额暂不可用' : null, this.unresolvedRefunds(rows).length ? '实际现金退款金额缺失' : null].filter(Boolean) };
  }

  publicRow(row) {
    const { aliases, refundQuantity, paidAt, ...value } = row;
    return { ...value, amount: number(row.amount), currency: 'CNY', rate: 1, cnyAmount: number(row.amount),
      editable: row.source !== 'automatic', providerName: this.ledger.providers().items.find(provider => provider.id === row.providerId)?.name || row.providerId || null };
  }

  detail(key) {
    const row = this.rows().find(row => row.key === key);
    if (!row) throw new AppError('CASH_NOT_FOUND', '收支记录不存在', { status: 404 });
    return { item: this.publicRow(row), history: [...this.store.history(`cash:${key}`), ...this.store.history(key)].sort((a, b) => b.id - a.id).slice(0, 100) };
  }

  normalize(input, existing = null) {
    const parsed = entrySchema.safeParse(input);
    if (!parsed.success) throw new AppError('CASH_INVALID_INPUT', parsed.error.issues.map(issue => issue.message).join('；'), { status: 400 });
    const value = parsed.data, date = DateTime.fromISO(value.date, { zone: this.config.financeTimezone });
    if (!date.isValid || date.toISODate() !== value.date || value.date.startsWith('0000') || value.date > dateInTimezone(this.config.financeTimezone, this.now())) throw new AppError('CASH_DATE_INVALID', '发生日期须为今天或以前的有效日期', { status: 400 });
    if (value.direction !== 'expense' || value.category !== 'provider') { value.providerId = ''; value.category = 'custom'; }
    else if (value.providerId !== existing?.providerId && !this.ledger.providers().items.some(provider => provider.id === value.providerId)) throw new AppError('CASH_PROVIDER_INVALID', '请选择供应商目录中的供应商，或改记自定义支出', { status: 400 });
    return { ...value, currency: 'CNY' };
  }

  async save(input, actor, key = null) {
    this.scope();
    const value = this.normalize(input, key ? this.rows().find(row => row.key === key) : null);
    const fingerprintFor = fields => crypto.createHash('sha256').update(JSON.stringify({ ...fields, requestId: undefined })).digest('hex');
    const fingerprint = fingerprintFor(value);
    if (!key && !value.requestId) throw new AppError('CASH_REQUEST_REQUIRED', '请提供本次记账请求 ID', { status: 400 });
    await this.sync();
    return this.store.db.transaction(() => {
      if (!key) {
        const request = this.store.db.prepare('SELECT * FROM cash_requests WHERE scope=? AND request_id=?').get(this.scopeKey, value.requestId);
        if (request) {
          const previous = this.store.cashRecord(request.key);
          const previousFingerprints = [input.currency, previous?.currency].filter(Boolean)
            .map(currency => fingerprintFor({ ...value, currency: String(currency).trim().toUpperCase() }));
          if (request.fingerprint !== fingerprint && !previousFingerprints.includes(request.fingerprint)) throw new AppError('CASH_REQUEST_CONFLICT', '同一次请求不能更换记账内容', { status: 409 });
          if (!previous?.active) throw new AppError('CASH_ALREADY_DELETED', '该次请求对应的记录已删除', { status: 409 });
          return this.publicRow(previous);
        }
      }
      const rows = this.rows(), existing = key && rows.find(row => row.key === key);
      if (key && !existing) throw new AppError('CASH_NOT_FOUND', '收支记录不存在', { status: 404 });
      if (existing?.source === 'automatic') throw new AppError('CASH_SOURCE_IMMUTABLE', '自动入账以主站来源记录为准，只能查看', { status: 400 });
      if (value.sourceRef && rows.some(row => row.key !== key && ((row.sourceRef?.toLowerCase() === value.sourceRef.toLowerCase()) ||
          (value.direction === 'income' && (row.aliases || [row.key]).some(alias => alias.toLowerCase() === value.sourceRef.toLowerCase()))))) throw new AppError('CASH_DUPLICATE_SOURCE', '该来源单号已有记录，请查看原记录，避免重复入账', { status: 409 });
      if (value.sourceRef && !this.sourceStatus().complete) throw new AppError('CASH_SYNC_PENDING', '自动入账尚未同步完成，来源单号将在同步完成后校验', { status: 409 });
      const now = this.now().toISOString(), { requestId, ...fields } = value;
      const record = { ...fields, key: key || `cash:${requestId}`, source: 'manual', amount: String(value.amount), rate: 1,
        active: true, createdAt: existing?.createdAt || now, updatedAt: now, actor: String(actor || 'administrator') };
      this.store.putCash(record, actor || 'administrator', key ? '修改现金收支记录' : '新增现金收支记录');
      if (!key) this.store.db.prepare('INSERT INTO cash_requests(scope,request_id,fingerprint,key) VALUES (?,?,?,?)').run(this.scopeKey, requestId, fingerprint, record.key);
      this.rowsCache = null;
      return this.publicRow({ ...record, amount: value.amount, counted: true });
    })();
  }

  remove(key, actor) {
    this.scope();
    const row = this.rows().find(row => row.key === key);
    if (!row) throw new AppError('CASH_NOT_FOUND', '收支记录不存在', { status: 404 });
    if (row.source === 'automatic') throw new AppError('CASH_SOURCE_IMMUTABLE', '自动入账以主站来源记录为准，只能查看', { status: 400 });
    this.store.db.transaction(() => this.store.putCash({ ...row, source: 'manual', active: false, updatedAt: this.now().toISOString() }, actor || 'administrator', '删除现金收支记录，原值保留在审计中'))();
    this.rowsCache = null;
  }
}

module.exports = { CashFlowService, entrySchema, totals };
