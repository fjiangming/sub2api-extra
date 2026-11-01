'use strict';

const crypto = require('node:crypto');
const Decimal = require('decimal.js');
const { DateTime } = require('luxon');
const { z } = require('zod');
const { AppError } = require('../errors');
const { AccountingSource } = require('./accounting-source');
const { addUtcDays, dateInTimezone } = require('./metrics-service');
const { parseReportInput, parseAutomaticIncomeInput, parseAutomaticIncomeUserKey, periodStart, createPeriods } = require('./cost-analysis-service');

const TYPES = ['customer_receipt', 'subscription', 'service_income', 'fee', 'provider_prepayment',
  'gift', 'correction', 'excluded', 'refund_unconsumed', 'refund_service', 'refund_subscription', 'transfer', 'reference'];
const CATEGORIES = ['infrastructure', 'domain', 'payment', 'marketing', 'labor', 'other'];
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = DateTime.fromISO(value, { zone: 'UTC' });
  return !value.startsWith('0000-') && parsed.isValid && parsed.toISODate() === value;
}, '日期无效');
const idSchema = z.string().regex(/^[1-9]\d{0,18}$/).refine(value => BigInt(value) <= 9223372036854775807n && value !== '1', '请填写非 ID 1 的有效用户');
const amountSchema = z.coerce.number().finite().min(0).max(1e12);
const decisionSchema = z.object({
  kind: z.enum(TYPES), amount: amountSchema.optional(), currency: z.string().regex(/^[A-Z][A-Z0-9_-]{0,11}$/).default('CNY'),
  rate: z.coerce.number().finite().positive().max(1e8).optional(), quantity: z.coerce.number().finite().min(-1e12).max(1e12).optional(),
  cashAdjustment: z.coerce.number().finite().min(-1e12).max(1e12).optional(),
  refundEarned: amountSchema.optional(), cancelDate: dateSchema.optional(),
  userId: idSchema.optional().nullable(), providerId: z.string().min(1).max(100).optional().nullable(),
  category: z.enum(CATEGORIES).default('other'), date: dateSchema.optional(),
  serviceStart: dateSchema.optional(), serviceEnd: dateSchema.optional(),
  paid: z.boolean().default(true), linkedKey: z.string().min(1).max(120).optional().nullable(),
  relatedKey: z.string().min(1).max(120).optional().nullable(),
  reason: z.string().trim().min(1).max(500)
}).superRefine((value, ctx) => {
  if (['subscription', 'service_income', 'fee'].includes(value.kind) && (!value.serviceStart || !value.serviceEnd || value.serviceStart > value.serviceEnd)) ctx.addIssue({ code: 'custom', message: '请填写正确的所属起止日期' });
  if (value.serviceStart && value.serviceEnd && DateTime.fromISO(value.serviceEnd).diff(DateTime.fromISO(value.serviceStart), 'days').days > 3650) ctx.addIssue({ code: 'custom', message: '分摊期间最多 3651 天' });
  if (value.currency !== 'CNY' && !value.rate) ctx.addIssue({ code: 'custom', message: '外币必须确认每单位兑换的 CNY 金额' });
  if (value.kind === 'reference' && !value.linkedKey) ctx.addIssue({ code: 'custom', message: '请选择已入账的原始记录' });
  if (['provider_prepayment'].includes(value.kind) && !value.providerId) ctx.addIssue({ code: 'custom', message: '请选择供应商' });
  if (value.kind === 'refund_subscription' && (!value.relatedKey || !value.cancelDate || value.refundEarned == null)) ctx.addIssue({ code: 'custom', message: '订阅退款需关联原订阅、终止服务日期及已履约退款金额（CNY）' });
});
function parse(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) throw new AppError('ACCOUNTING_INVALID_INPUT', result.error.issues.map(issue => issue.message).join('；'), { status: 400 });
  return result.data;
}
const dec = value => new Decimal(value == null ? 0 : value);
const numeric = value => value == null ? null : dec(value).toDecimalPlaces(8).toNumber();
const sum = (rows, key) => rows.some(row => row[key] == null) ? null : numeric(rows.reduce((total, row) => total.plus(row[key]), dec(0)));
const margin = (profit, revenue) => profit != null && revenue > 0 ? dec(profit).div(revenue).times(100).toDecimalPlaces(2).toNumber() : null;

function allocated(amount, start, end, date) {
  if (date < start || date > end) return dec(0);
  const days = Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1;
  const offset = Math.round((Date.parse(date) - Date.parse(start)) / 86400000);
  const units = dec(amount).times(1e8).toDecimalPlaces(0);
  const base = units.div(days).floor();
  const extra = units.minus(base.times(days));
  return base.plus(extra.gt(offset) ? 1 : 0).div(1e8);
}

class AccountingService {
  constructor({ pool, inspector, config, store, ledger, analysis, dailyProfit, now = () => new Date() }) {
    Object.assign(this, { pool, inspector, config, store, ledger, analysis, dailyProfit, now });
    this.source = new AccountingSource({ pool, inspector, config, store });
    if (!store.setting('policy')) store.saveSetting('policy', {
      startDate: dateInTimezone(config.financeTimezone, now()).slice(0, 7) + '-01', allocation: 'daily_weighted_average', version: 1
    }, 'system', '首次建立核算起点，历史期初需逐用户核验');
  }

  static scope(config) {
    const url = config.databaseUrl ? new URL(config.databaseUrl) : null;
    return crypto.createHash('sha256').update(JSON.stringify(['accounting-v1', url && `${url.host}${url.pathname}`, config.financeTimezone])).digest('hex');
  }

  settings() {
    const scope = AccountingService.scope(this.config);
    if (this.store.scope !== scope) { this.store.scope = scope; this.balanceCache = null; }
    return this.store.setting('policy', { startDate: dateInTimezone(this.config.financeTimezone, this.now()).slice(0, 7) + '-01', allocation: 'daily_weighted_average', version: 1 });
  }

  configure(input, actor) {
    this.settings();
    const value = parse(z.object({ startDate: dateSchema, reason: z.string().trim().min(1).max(500) }), input);
    const today = dateInTimezone(this.config.financeTimezone, this.now());
    if (value.startDate > today || addUtcDays(value.startDate, 3650) < today) throw new AppError('ACCOUNTING_START_INVALID', '核算起点需在过去十年内，且不能晚于今天', { status: 400 });
    this.balanceCache = null;
    return this.store.saveSetting('policy', { startDate: value.startDate, allocation: 'daily_weighted_average', version: 1 }, actor, value.reason);
  }

  opening(input, actor) {
    this.settings();
    const value = parse(z.object({ userId: idSchema, quantity: amountSchema, cashValue: amountSchema, reason: z.string().trim().min(1).max(500) }), input);
    if (!value.quantity && value.cashValue) throw new AppError('ACCOUNTING_OPENING_INVALID', '零额度不能包含待确认收入', { status: 400 });
    this.balanceCache = null;
    return this.store.saveSetting(`opening:${value.userId}`, { ...value, asOf: this.settings().startDate }, actor, value.reason);
  }

  importLegacy() {
    this.settings();
    const ledger = this.ledger.snapshot();
    this.store.importDocuments([
      ...ledger.entries.map(entry => ({ key: `legacy-expense:${entry.id}`, origin: 'legacy_expense',
        date: entry.date, amount: entry.amountMinor / 100, currency: entry.currency,
        name: entry.name, providerId: entry.providerId || null, note: entry.note })),
      ...ledger.incomes.map(entry => ({ key: `legacy-income:${entry.id}`, origin: 'legacy_income',
        date: entry.date, amount: entry.amountMinor / 100, currency: entry.currency, name: entry.name, note: entry.note }))
    ]);
  }

  create(input, actor) {
    this.settings();
    const fields = parse(decisionSchema, input);
    const meta = parse(z.object({ name: z.string().trim().min(1).max(120), date: dateSchema, requestId: z.string().uuid().optional() }), input);
    this.validateDecision(null, fields);
    return this.store.db.transaction(() => {
      const document = this.store.create({ ...meta, ...fields }, actor);
      if (!this.store.decisions()[document.key]) this.store.decide(document.key, fields, actor);
      return document;
    })();
  }

  validateDecision(document, fields) {
    if (document && ['redeem', 'payment', 'refund'].includes(document.origin) &&
      ((fields.date && fields.date !== document.date) || (Object.hasOwn(fields, 'userId') && fields.userId !== document.userId) ||
        (document.origin === 'redeem' && fields.quantity != null && !dec(fields.quantity).eq(document.quantity)))) throw new AppError('ACCOUNTING_SOURCE_IMMUTABLE', '主站记录的日期、用户和原始额度不能在核算账中改写', { status: 400 });
    if (fields.linkedKey) {
      const linked = this.store.document(fields.linkedKey);
      if (!linked || linked.key === document?.key) throw new AppError('ACCOUNTING_LINK_INVALID', '关联记录不存在或指向自身', { status: 400 });
      if (fields.kind === 'reference') {
        const target = this.effectiveDocuments().find(item => item.key === linked.key);
        if (target.pending || ['reference', 'excluded', 'gift', 'correction', 'transfer', 'funding'].includes(target.kind)) throw new AppError('ACCOUNTING_LINK_INVALID', '重复业务需关联已确认的原收付款记录，不能循环关联', { status: 400 });
      }
      if (fields.kind !== 'reference' && !(['customer_receipt', 'refund_unconsumed'].includes(fields.kind) && linked.origin === 'redeem')) throw new AppError('ACCOUNTING_LINK_INVALID', '补录充值或余额退款需关联兑换记录，重复记录请关联已有业务', { status: 400 });
      if (linked.userId && fields.userId && linked.userId !== fields.userId) throw new AppError('ACCOUNTING_LINK_USER', '关联记录与收款用户不一致', { status: 400 });
      if (fields.kind === 'customer_receipt' && linked.payments?.length) throw new AppError('ACCOUNTING_DUPLICATE_PAYMENT', '该额度已有线上订单，请关联已有业务，不能再次计收款', { status: 409 });
      if (fields.kind === 'customer_receipt' && (!fields.userId || !dec(linked.quantity).gt(0))) throw new AppError('ACCOUNTING_CREDIT_LINK_REQUIRED', '充值收款需关联同一用户的正向额度入账', { status: 400 });
      if (fields.kind === 'customer_receipt' && this.effectiveDocuments().some(item => item.key === linked.key && item.kind === 'customer_receipt')) throw new AppError('ACCOUNTING_DUPLICATE_LINK', '该兑换记录已确认收款，重复凭证请关联已有业务', { status: 409 });
      if (fields.kind === 'refund_unconsumed' && (!dec(linked.quantity).lt(0) || !dec(fields.quantity || 0).eq(dec(linked.quantity).abs()))) throw new AppError('ACCOUNTING_REFUND_LINK', '退款关联的余额调整必须为负数，且退回额度与其绝对值一致', { status: 400 });
    }
    if (fields.kind === 'provider_prepayment' && !this.ledger.providers().items.some(provider => provider.id === fields.providerId)) throw new AppError('ACCOUNTING_PROVIDER_INVALID', '供应商不存在，请同步后选择', { status: 400 });
    if (document?.origin === 'payment' && !['customer_receipt', 'subscription', 'gift', 'excluded'].includes(fields.kind)) throw new AppError('ACCOUNTING_KIND_INVALID', '支付订单只能确认收款、订阅、赠送或排除', { status: 400 });
    if (document?.origin === 'payment' && ['customer_receipt', 'subscription'].includes(fields.kind) && fields.kind !== document.kind) throw new AppError('ACCOUNTING_KIND_INVALID', '余额充值和订阅的类型以原支付订单为准', { status: 400 });
    if (document?.origin === 'payment' && ['customer_receipt', 'subscription'].includes(fields.kind) &&
      fields.amount != null && !dec(fields.amount).eq(document.amount)) throw new AppError('ACCOUNTING_SOURCE_IMMUTABLE', '线上支付金额以主站实收为准，不能改写', { status: 400 });
    if (document?.origin === 'redeem' && !['customer_receipt', 'gift', 'correction', 'excluded'].includes(fields.kind)) throw new AppError('ACCOUNTING_KIND_INVALID', '兑换记录请确认充值、赠送或余额纠错', { status: 400 });
    if (document?.origin === 'redeem' && document.payments?.length && fields.kind === 'customer_receipt') throw new AppError('ACCOUNTING_DUPLICATE_PAYMENT', '线上收款金额请在对应支付订单核对', { status: 409 });
    if (document?.origin === 'redeem' && fields.kind === 'customer_receipt' && this.effectiveDocuments().some(item => item.linkedKey === document.key && item.kind === 'customer_receipt')) throw new AppError('ACCOUNTING_DUPLICATE_LINK', '该兑换记录已关联收款，请修改关联收款记录，不能再次计入', { status: 409 });
    const amount = fields.amount ?? document?.amount;
    if (!['gift', 'correction', 'excluded', 'reference'].includes(fields.kind) && amount == null) throw new AppError('ACCOUNTING_AMOUNT_REQUIRED', '请确认实际现金金额', { status: 400 });
    if (!document && fields.kind === 'customer_receipt' && !fields.linkedKey) throw new AppError('ACCOUNTING_CREDIT_LINK_REQUIRED', '充值收款需要关联实际额度入账记录，避免重复增加核算额度', { status: 400 });
    if (fields.paid === false && !['fee', 'service_income', 'gift', 'correction', 'excluded', 'reference'].includes(fields.kind)) throw new AppError('ACCOUNTING_PAYMENT_REQUIRED', '充值、订阅、预付及退款只能登记已实际收付的金额', { status: 400 });
    if (!document && fields.kind === 'gift' && (!fields.userId || fields.quantity == null)) throw new AppError('ACCOUNTING_USER_REQUIRED', '赠送额度需要用户和额度数量', { status: 400 });
    if (document?.origin === 'redeem' && fields.kind === 'customer_receipt' && Number(document.quantity) <= 0) throw new AppError('ACCOUNTING_NEGATIVE_CREDIT', '负向余额调整不能当作充值收款，请分类为纠错并关联实际退款', { status: 400 });
    if (fields.kind === 'refund_unconsumed' && (!fields.userId && !document?.userId || !dec(fields.quantity ?? document?.quantity ?? 0).gt(0))) throw new AppError('ACCOUNTING_REFUND_INVALID', '未消费退款需填写用户及正数退回额度', { status: 400 });
    if (document?.origin === 'refund' && !['refund_unconsumed', 'refund_service', 'refund_subscription', 'excluded', 'reference'].includes(fields.kind)) throw new AppError('ACCOUNTING_KIND_INVALID', '退款记录需确认余额退款、已消费服务退款或订阅终止退款', { status: 400 });
    if (['refund_unconsumed', 'refund_service', 'refund_subscription'].includes(fields.kind)) {
      const relatedKey = fields.relatedKey || document?.linkedPayment;
      const original = this.effectiveDocuments().find(item => item.key === relatedKey);
      if (!original || original.pending || !['customer_receipt', 'subscription', 'service_income'].includes(original.kind) ||
        (original.userId && (fields.userId || document?.userId) && original.userId !== (fields.userId || document?.userId))) throw new AppError('ACCOUNTING_REFUND_ORIGINAL', '退款需关联同一用户已确认的原收款记录', { status: 400 });
      if (document?.linkedPayment && relatedKey !== document.linkedPayment) throw new AppError('ACCOUNTING_REFUND_ORIGINAL', '自动退款只能核对其原支付订单', { status: 400 });
      const cash = dec(amount).times(fields.currency === 'CNY' ? 1 : fields.rate);
      const refunded = this.effectiveDocuments().filter(item => item.key !== document?.key && !item.pending && item.kind.startsWith('refund_') &&
        (item.relatedKey || item.linkedPayment) === relatedKey).reduce((total, item) => total.plus(item.cash), dec(0));
      if (cash.plus(refunded).gt(original.cash)) throw new AppError('ACCOUNTING_REFUND_EXCESS', '累计退款不能超过原实收金额', { status: 400 });
      if (fields.kind === 'refund_subscription') {
        if (original.kind !== 'subscription' || fields.cancelDate < original.serviceStart || fields.cancelDate > addUtcDays(original.serviceEnd, 1)) throw new AppError('ACCOUNTING_REFUND_PERIOD', '终止日期必须在原订阅服务期间或紧接其结束日', { status: 400 });
        const existing = this.effectiveDocuments().some(item => item.key !== document?.key && item.kind === 'refund_subscription' && !item.pending && item.relatedKey === relatedKey);
        if (existing) throw new AppError('ACCOUNTING_REFUND_DUPLICATE', '原订阅已有终止退款，需修改已有记录', { status: 409 });
        let unearned = dec(0);
        for (let date = fields.cancelDate; date <= original.serviceEnd; date = addUtcDays(date, 1)) unearned = unearned.plus(allocated(original.cash, original.serviceStart, original.serviceEnd, date));
        if (!cash.minus(unearned).minus(fields.refundEarned).abs().lte('0.00000001') || dec(fields.refundEarned).gt(dec(original.cash).minus(unearned))) throw new AppError('ACCOUNTING_REFUND_ALLOCATION', '退款需等于未履约实收价值加已履约退款金额；差额请先核对服务期间和原售价', { status: 400 });
      }
    }
    if (fields.kind === 'correction' && !document?.userId && !fields.userId) throw new AppError('ACCOUNTING_USER_REQUIRED', '余额纠错需填写用户', { status: 400 });
    if (['gift', 'correction'].includes(fields.kind) && document?.origin !== 'payment' && (fields.quantity ?? document?.quantity) == null) throw new AppError('ACCOUNTING_QUANTITY_REQUIRED', '请填写额度数量', { status: 400 });
    if (fields.kind === 'gift' && (fields.quantity ?? document?.quantity) < 0) throw new AppError('ACCOUNTING_GIFT_INVALID', '赠送额度不能为负', { status: 400 });
  }

  classify(key, input, actor) {
    this.settings();
    const document = this.store.document(key);
    if (!document) throw new AppError('ACCOUNTING_NOT_FOUND', '记录不存在', { status: 404 });
    const fields = parse(decisionSchema, input);
    this.validateDecision(document, fields);
    return this.store.decide(key, { ...fields, sourceHash: this.sourceHash(document) }, actor);
  }

  sourceHash(document) {
    const { userName, ...financial } = document;
    return crypto.createHash('sha256').update(JSON.stringify(financial)).digest('hex');
  }

  async creditUsers(input = {}, userKey = null) {
    this.settings();
    const { range, page, pageSize, offset, search } = parseAutomaticIncomeInput(input, this.config);
    const identity = userKey == null ? null : parseAutomaticIncomeUserKey(userKey);
    const sourceUsers = this.pool ? (await this.pool.query(`SELECT id::text AS id,to_jsonb(u)->>'email' AS email,
      to_jsonb(u)->>'username' AS username,deleted_at FROM users u WHERE id<>1`)).rows : [];
    const byUser = new Map(sourceUsers.map(user => [user.id, user]));
    const groups = new Map();
    const credits = this.effectiveDocuments().filter(item => item.origin === 'redeem' && item.userId !== '1' && item.date >= range.start && item.date <= range.end);
    for (const credit of credits) {
      const key = credit.userId || 'unassigned';
      if (!groups.has(key)) {
        const user = byUser.get(credit.userId);
        groups.set(key, { userKey: key, userId: credit.userId, email: user?.email || null,
          username: user?.username || credit.userName || null, deleted: Boolean(user?.deleted_at), missing: !user,
          transactions: 0, total: dec(0), records: [] });
      }
      const group = groups.get(key); group.transactions++; group.total = group.total.plus(credit.quantity); group.records.push(credit);
    }
    const matched = [...groups.values()].filter(user => !search || `${user.userId || ''} ${user.username || ''} ${user.email || ''} ${user.missing ? '关联用户缺失' : ''}`.toLowerCase().includes(search.toLowerCase()))
      .map(({ total, records, ...user }) => ({ ...user, totalIncome: numeric(total), records: records.sort((a, b) => b.date.localeCompare(a.date) || b.key.localeCompare(a.key)) }))
      .sort((a, b) => b.totalIncome - a.totalIncome || a.userKey.localeCompare(b.userKey));
    const pagination = total => ({ page, pageSize, total, totalPages: Math.ceil(total / pageSize), hasPrevious: page > 1, hasNext: page * pageSize < total });
    const header = { range, currency: 'CNY', timezone: this.config.financeTimezone };
    const publicUser = user => { const { records, ...result } = user; return { ...result, firstUsedAt: records.at(-1)?.usedAt || records.at(-1)?.date, lastUsedAt: records[0]?.usedAt || records[0]?.date }; };
    if (identity) {
      const user = matched.find(group => group.userKey === identity.userKey) || { userKey: identity.userKey, userId: identity.userId, missing: true, records: [], transactions: 0, totalIncome: 0 };
      return { ...header, user: publicUser(user), summary: { transactions: user.transactions, totalIncome: user.totalIncome }, pagination: pagination(user.transactions),
        items: user.records.slice(offset, offset + pageSize).map(record => ({ id: record.key.slice(7), code: record.code || '归档未保存', type: record.redeemType, value: numeric(record.quantity), notes: record.note, usedAt: record.usedAt || record.date, createdAt: record.sourceCreatedAt })) };
    }
    return { ...header, search, summary: { users: matched.length, transactions: matched.reduce((total, user) => total + user.transactions, 0), totalIncome: numeric(matched.reduce((total, user) => total.plus(user.totalIncome), dec(0))) },
      pagination: pagination(matched.length), items: matched.slice(offset, offset + pageSize).map(publicUser) };
  }

  effectiveDocuments() {
    this.settings();
    const decisions = this.store.decisions();
    const documents = this.store.documents();
    const effective = documents.map(document => {
      const saved = decisions[document.key];
      const decision = saved && (!saved.sourceHash || saved.sourceHash === this.sourceHash(document)) ? saved : null;
      let kind = decision?.kind || (document.origin === 'payment' ? document.kind : null);
      if (document.origin === 'manual') kind = decision?.kind || null;
      const amount = decision?.amount ?? document.amount;
      const currency = decision?.currency || document.currency;
      const rate = currency === 'CNY' ? 1 : decision?.rate;
      let cash = amount != null && rate ? numeric(dec(amount).times(rate)) : null;
      if (['gift', 'correction', 'excluded', 'reference', 'transfer'].includes(kind)) cash = 0;
      return { ...document, ...(decision || {}), key: document.key, origin: document.origin,
        quantity: document.origin === 'redeem' ? document.quantity : decision?.quantity ?? document.quantity,
        date: decision?.date || document.date, amount, currency, rate, kind, cash,
        pending: !kind || cash == null || Boolean(saved && !decision) || (kind === 'subscription' && !decision?.serviceStart),
        sourceChanged: Boolean(saved && !decision), audit: Boolean(saved) };
    });
    const byKey = new Map(effective.map(document => [document.key, document]));
    const refundsByOriginal = new Map();
    for (const document of effective.filter(item => item.kind?.startsWith('refund_') && !item.pending)) {
      const key = document.relatedKey || document.linkedPayment;
      if (!refundsByOriginal.has(key)) refundsByOriginal.set(key, []);
      refundsByOriginal.get(key).push(document);
    }
    for (const [key, refunds] of refundsByOriginal) {
      const original = byKey.get(key);
      const overpaid = original && refunds.reduce((total, item) => total.plus(item.cash), dec(0)).gt(original.cash || 0);
      for (const refund of refunds) {
        if (!original || original.pending || !['customer_receipt', 'subscription', 'service_income'].includes(original.kind) || overpaid) { refund.pending = true; continue; }
        if (refund.kind === 'refund_subscription') {
          let unearned = dec(0);
          if (original.kind !== 'subscription' || refund.cancelDate < original.serviceStart || refund.cancelDate > addUtcDays(original.serviceEnd, 1)) { refund.pending = true; continue; }
          for (let date = refund.cancelDate; date <= original.serviceEnd; date = addUtcDays(date, 1)) unearned = unearned.plus(allocated(original.cash, original.serviceStart, original.serviceEnd, date));
          if (dec(refund.cash).minus(unearned).minus(refund.refundEarned).abs().gt('0.00000001')) refund.pending = true;
        }
      }
    }
    const linked = new Map(effective.filter(document => document.linkedKey && document.kind === 'customer_receipt').map(document => [document.linkedKey, document]));
    for (const document of effective) {
      if (document.origin !== 'redeem') continue;
      const payments = document.payments || [];
      const supplement = linked.get(document.key);
      if (supplement && (payments.length || document.kind === 'customer_receipt')) supplement.pending = true;
      if (supplement && !payments.length) {
        if (document.kind === 'excluded' && !document.sourceChanged) { supplement.cash = 0; supplement.kind = 'excluded'; supplement.pending = false; }
        document.fundingValue = ['gift', 'excluded'].includes(document.kind) ? 0 : supplement.cash;
        document.kind ||= 'funding'; document.pending = document.sourceChanged || supplement.pending;
      } else if (payments.length === 1) {
        const payment = byKey.get(`payment:${payments[0].id}`);
        const fallback = payments[0].currency === 'CNY' ? Number(payments[0].cash) : null;
        document.kind = document.kind || 'funding';
        document.fundingValue = ['gift', 'excluded'].includes(payment?.kind) || ['gift', 'excluded'].includes(document.kind) ? 0 : payment?.cash ?? fallback;
        document.pending = document.sourceChanged || document.fundingValue == null || (payment?.pending === true) || !dec(payments[0].amount).eq(document.quantity);
        if (document.kind === 'excluded' && !document.sourceChanged && payment) { payment.cash = 0; payment.kind = 'excluded'; payment.pending = false; }
      } else if (payments.length > 1) document.pending = true;
      else if (document.kind === 'customer_receipt') document.fundingValue = document.cash;
      else if (['gift', 'excluded'].includes(document.kind)) { document.fundingValue = 0; document.pending = false; }
      else if (document.kind === 'correction') { document.fundingValue = document.cashAdjustment || 0; document.pending = false; }
    }
    return effective;
  }

  async currentBalances({ accessToken = null, refresh = false } = {}) {
    if (!refresh && this.balanceCache?.until > Date.now()) return this.balanceCache.value;
    const { rows } = await this.pool.query(`SELECT u.id::text AS id,u.balance::text AS balance,u.deleted_at,
      to_jsonb(u)->>'created_at' AS created_date,to_jsonb(u)->>'email' AS email,to_jsonb(u)->>'username' AS username
      FROM users u WHERE u.id <> 1`);
    let provider = null;
    try {
      let token = accessToken;
      if (!token && !this.analysis.providerMonitor.integrationToken && this.analysis.sub2api?.configured()) token = await this.analysis.sub2api.login();
      provider = await this.analysis.providerMonitor.getFinancialBalances(token);
      if (provider?.currency !== 'CNY' || provider.providerFilter !== 'scheduled_enabled' || !Array.isArray(provider.items) ||
        (provider.complete === true && (typeof provider.total !== 'number' || !Number.isFinite(provider.total)))) provider = null;
    } catch { /* A balance failure must not discard the accounting report. */ }
    const users = rows.map(user => ({ id: user.id, balance: numeric(user.balance), deleted: Boolean(user.deleted_at),
      name: user.username || user.email || `用户 #${user.id}`, opening: this.store.setting(`opening:${user.id}`) }));
    const value = { capturedAt: this.now().toISOString(), userBalance: numeric(users.filter(user => !user.deleted).reduce((total, user) => total.plus(user.balance), dec(0))),
      deletedBalance: numeric(users.filter(user => user.deleted).reduce((total, user) => total.plus(user.balance), dec(0))),
      providerBalance: provider?.complete === true ? provider.total : null, providers: provider?.items || [], users };
    this.balanceCache = { value, until: Date.now() + 30000 };
    return value;
  }

  listDocuments(input = {}) {
    this.importLegacy();
    parse(z.object({ start: dateSchema.optional(), end: dateSchema.optional(), kind: z.enum([...TYPES, 'funding', '']).optional(), pending: z.enum(['', '1']).optional() }), input);
    const query = String(input.search || '').trim().toLowerCase().slice(0, 100);
    const { page, pageSize } = parse(z.object({ page: z.coerce.number().int().min(1).max(1000000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) }), input);
    const items = this.effectiveDocuments().filter(item => (!input.start || item.date >= input.start) && (!input.end || item.date <= input.end)
      && (!input.kind || item.kind === input.kind) && (input.pending !== '1' || item.pending)
      && (!query || `${item.key} ${item.name} ${item.userId || ''} ${item.note || ''}`.toLowerCase().includes(query)))
      .sort((a, b) => b.date.localeCompare(a.date) || a.key.localeCompare(b.key));
    return { items: items.slice((page - 1) * pageSize, page * pageSize), pagination: { page, pageSize, total: items.length, totalPages: Math.ceil(items.length / pageSize) } };
  }

  async collectDay(date) {
    try { return await this.source.collectDay(date); }
    catch { return { version: 1, complete: false, date, usage: [], users: [], reason: '主站收入来源读取失败' }; }
  }

  async getReport(input = {}, options = {}) {
    const { range, granularity } = parseReportInput({ ...input, currency: 'CNY' }, this.config);
    const policy = this.settings();
    this.importLegacy();
    const today = dateInTimezone(this.config.financeTimezone, this.now());
    const end = range.end > today ? today : range.end;
    const from = policy.startDate;
    let daily = { items: [], archive: {}, notices: [] };
    if (end >= from) daily = await this.dailyProfit.getDailyProfit({ start: from, end, granularity,
      currency: 'CNY', accounting: '1', refresh: input.refresh, poll: input.poll }, { ...options, refreshRange: range });
    const documents = this.effectiveDocuments();
    const result = this.calculate(daily.items, documents, policy);
    const byDate = new Map(result.items.map(row => [row.date, row]));
    const items = [];
    for (let date = range.start; date <= range.end; date = addUtcDays(date, 1)) items.push(byDate.get(date) || {
      date, siteConsumption: null, revenue: null, supplierCost: null, fee: null, profit: null, margin: null,
      complete: false, status: date < from ? 'before_start' : 'future', issues: [], providers: [] });
    const summary = this.totals(items);
    const buckets = new Map();
    for (const row of items) { const key = periodStart(row.date, granularity); if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push(row); }
    const periods = createPeriods(range, granularity).map(period => ({ label: period.label, start: period.start, end: period.end, ...this.totals(buckets.get(period.key) || []) }));
    const relevantDocuments = documents.filter(document => document.date >= range.start && document.date <= range.end);
    const cash = this.cashSummary(relevantDocuments);
    const cashSourceComplete = items.every(row => row.sourceComplete);
    if (!cashSourceComplete) { cash.receipts = null; cash.refunds = null; cash.payments = null; cash.net = null; cash.credit = null; cash.complete = false; }
    cash.sourceComplete = cashSourceComplete;
    const issues = result.issues.filter(issue => !issue.date || issue.date <= range.end);
    let balances;
    try { balances = await this.currentBalances({ ...options, refresh: input.refresh === '1' }); }
    catch { balances = { userBalance: null, deletedBalance: null, providerBalance: null, capturedAt: null, users: [], providers: [] }; }
    return { range, currency: 'CNY', timezone: this.config.financeTimezone, granularity, policy,
      generatedAt: this.now().toISOString(), items: items.reverse(), summary, periods, cash,
      balances: { ...balances, historical: { opening: null, closing: null, status: 'no_exact_snapshots' } },
      issues: issues.slice(0, 300), issueCount: issues.length, archive: daily.archive,
      notices: [...new Set(daily.notices || [])],
      verifiedSubtotal: this.totals(items.filter(row => row.complete)),
      documents: { items: relevantDocuments.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 20), total: relevantDocuments.length } };
  }

  rebuildArchived() {
    const start = this.settings().startDate;
    const end = addUtcDays(dateInTimezone(this.config.financeTimezone, this.now()), -1);
    const rows = this.dailyProfit.store.list(this.dailyProfit.scope(), start, end).map(snapshot => ({ ...snapshot.row, mode: 'archived', computedAt: snapshot.computedAt }));
    if (rows.length) this.calculate(rows, this.effectiveDocuments(), this.settings());
  }

  totals(rows) {
    const revenue = sum(rows, 'revenue'), profit = sum(rows, 'profit');
    return { revenue, supplierCost: sum(rows, 'supplierCost'), fee: sum(rows, 'fee'), profit,
      siteConsumption: sum(rows, 'siteConsumption'), grossProfit: revenue != null && sum(rows, 'supplierCost') != null ? numeric(dec(revenue).minus(sum(rows, 'supplierCost'))) : null,
      margin: margin(profit, revenue), days: rows.length, completeDays: rows.filter(row => row.complete).length };
  }

  cashSummary(documents) {
    const amounts = { receipts: dec(0), refunds: dec(0), payments: dec(0), credit: dec(0) };
    let complete = true;
    for (const document of documents) {
      if (document.origin === 'redeem') amounts.credit = amounts.credit.plus(document.quantity);
      if (document.pending) { complete = false; continue; }
      if (document.paid === false) continue;
      if (['customer_receipt', 'subscription', 'service_income'].includes(document.kind)) amounts.receipts = amounts.receipts.plus(document.cash);
      if (['refund_unconsumed', 'refund_service', 'refund_subscription'].includes(document.kind)) amounts.refunds = amounts.refunds.plus(document.cash);
      if (['provider_prepayment', 'fee'].includes(document.kind)) amounts.payments = amounts.payments.plus(document.cash);
    }
    return { receipts: complete ? numeric(amounts.receipts) : null, refunds: complete ? numeric(amounts.refunds) : null,
      payments: complete ? numeric(amounts.payments) : null, net: complete ? numeric(amounts.receipts.minus(amounts.refunds).minus(amounts.payments)) : null,
      credit: numeric(amounts.credit), complete, pending: documents.filter(document => document.pending).length,
      knownReceipts: numeric(amounts.receipts), knownRefunds: numeric(amounts.refunds), knownPayments: numeric(amounts.payments) };
  }

  calculate(sourceDays, documents, policy) {
    const days = [...sourceDays].sort((a, b) => a.date.localeCompare(b.date));
    const pools = new Map(); const allIssues = new Map(); const items = [];
    const addIssue = (row, key, message, extra = {}) => {
      const issue = { key, message, date: row.date, ...extra };
      row.issues.push(issue); if (!allIssues.has(key)) allIssues.set(key, issue);
    };
    let sourceChainComplete = true;
    let expectedDate = policy.startDate;
    const documentsByDate = new Map();
    for (const document of documents) {
      if (!documentsByDate.has(document.date)) documentsByDate.set(document.date, []);
      documentsByDate.get(document.date).push(document);
    }
    const allocatedDocuments = documents.filter(document => ['fee', 'subscription', 'service_income'].includes(document.kind));
    const pendingLegacyExpenses = documents.filter(document => document.origin === 'legacy_expense' && document.pending);
    const subscriptionRefunds = new Map(documents.filter(document => document.kind === 'refund_subscription' && !document.pending).map(document => [document.relatedKey, document]));
    for (const day of days) {
      const source = day.accountingSource;
      const row = { date: day.date, siteConsumption: day.siteConsumption, supplierCost: day.supplierConsumption,
        fee: 0, revenue: 0, balanceRevenue: 0, subscriptionRevenue: 0, otherRevenue: 0,
        giftConsumption: 0, profit: null, margin: null, providers: day.providers || [],
        mode: day.mode, computedAt: day.computedAt, archiveStatus: day.archiveStatus, issues: [], users: [], allocations: [],
        sourceComplete: source?.complete === true && day.siteComplete === true };
      sourceChainComplete = sourceChainComplete && day.date === expectedDate && source?.complete === true && day.siteComplete === true;
      expectedDate = addUtcDays(day.date, 1);
      let incomeComplete = sourceChainComplete;
      let feeComplete = true;
      if (!source?.complete) addIssue(row, `source:${day.date}`, source?.reason || '收入来源等待归档', { type: 'source' });
      const users = new Map((source?.users || []).map(user => [user.id, user]));
      const getPool = userId => {
        if (pools.has(userId)) return pools.get(userId);
        const opening = this.store.setting(`opening:${userId}`);
        const user = users.get(userId);
        const known = opening?.asOf === policy.startDate || Boolean(user?.createdDate && user.createdDate >= policy.startDate);
        const pool = { quantity: dec(opening?.asOf === policy.startDate ? opening.quantity : 0), cash: dec(opening?.asOf === policy.startDate ? opening.cashValue : 0), known };
        pools.set(userId, pool); return pool;
      };
      const todays = documentsByDate.get(day.date) || [];
      for (const document of todays) {
        if (document.pending) {
          if (document.origin === 'legacy_expense') feeComplete = false;
          else incomeComplete = false;
          addIssue(row, document.key, document.sourceChanged ? '来源发生变化，请重新核验分类' : '记录待分类或现金金额 / 汇率 / 服务期间待确认', { type: 'document', documentKey: document.key });
          if ((document.kind?.startsWith('refund_') || document.origin === 'refund') && document.userId) getPool(document.userId).known = false;
        }
        if (document.origin === 'redeem' || (['manual', 'legacy_income'].includes(document.origin) && ['gift', 'correction'].includes(document.kind))) {
          if (!document.userId && document.kind === 'excluded' && !document.pending) continue;
          if (!document.userId) { incomeComplete = false; addIssue(row, document.key, '额度入账缺少关联用户', { type: 'document', documentKey: document.key }); continue; }
          const pool = getPool(document.userId);
          const quantity = dec(document.quantity);
          const value = document.fundingValue ?? (['manual', 'legacy_income'].includes(document.origin) ? document.kind === 'correction' ? document.cashAdjustment || 0 : document.cash : null);
          if (document.pending || value == null) pool.known = false;
          pool.quantity = pool.quantity.plus(quantity);
          pool.cash = pool.cash.plus(value || 0);
        }
      }
      for (const document of todays) {
        if (!document.pending && document.kind === 'refund_unconsumed' && document.quantity && document.userId) {
          const pool = getPool(document.userId);
          // A linked negative redemption already performs the quantity reduction.
          if (!document.linkedKey || !documents.some(item => item.key === document.linkedKey && item.origin === 'redeem')) pool.quantity = pool.quantity.minus(document.quantity);
          pool.cash = pool.cash.minus(document.cash);
        }
      }
      for (const [userId, pool] of pools) if (pool.quantity.lt(0) || pool.cash.lt(0)) {
        pool.known = false; incomeComplete = false;
        addIssue(row, `pool:${userId}`, '调整或退款超过核算剩余额度或实收价值，请复核', { type: 'opening', userId });
      }
      for (const document of allocatedDocuments) {
        if (['fee', 'subscription', 'service_income'].includes(document.kind) && document.serviceStart <= day.date && document.serviceEnd >= day.date) {
          if (document.pending) {
            if (document.kind === 'fee') feeComplete = false; else incomeComplete = false;
            addIssue(row, document.key, '所属期间的金额或来源分类待核验', { type: 'document', documentKey: document.key });
            continue;
          }
          if (document.kind === 'subscription' && subscriptionRefunds.get(document.key)?.cancelDate <= day.date) continue;
          const value = allocated(document.cash, document.serviceStart, document.serviceEnd, day.date);
          const key = document.kind === 'fee' ? 'fee' : document.kind === 'subscription' ? 'subscriptionRevenue' : 'otherRevenue';
          row[key] = numeric(dec(row[key]).plus(value));
          row.allocations.push({ documentKey: document.key, name: document.name, kind: document.kind, category: document.category,
            amount: numeric(value), start: document.serviceStart, end: document.serviceEnd });
        }
        if (document.kind === 'subscription' && document.pending && document.date <= day.date && (!document.serviceEnd || document.serviceEnd >= day.date)) {
          incomeComplete = false;
          addIssue(row, document.key, '订阅服务期间或售价待核验', { type: 'document', documentKey: document.key });
        }
      }
      for (const document of todays) {
        if (document.kind === 'refund_service' && !document.pending) row.otherRevenue = numeric(dec(row.otherRevenue).minus(document.cash));
        if (document.kind === 'refund_subscription' && !document.pending) row.otherRevenue = numeric(dec(row.otherRevenue).minus(document.refundEarned));
      }
      for (const document of pendingLegacyExpenses) if (document.date <= day.date) {
        feeComplete = false;
        addIssue(row, document.key, '历史支出尚未确认所属期间和业务类型', { type: 'document', documentKey: document.key });
      }
      for (const usage of source?.usage || []) {
        if (!dec(usage.amount).isFinite() || dec(usage.amount).lt(0)) {
          incomeComplete = false;
          addIssue(row, `invalid-usage:${usage.userId}`, '消费存在负数或无效金额，需核对冲销依据', { type: 'source' });
          continue;
        }
        if (usage.billingType === 0 && dec(usage.amount).gt(0)) {
          const pool = getPool(usage.userId);
          const amount = dec(usage.amount);
          let confirmed = null;
          if (pool.known && pool.quantity.gte(amount) && pool.quantity.gt(0)) {
            const value = (amount.eq(pool.quantity) ? pool.cash : pool.cash.times(amount).div(pool.quantity)).toDecimalPlaces(8);
            confirmed = numeric(value); pool.quantity = pool.quantity.minus(amount); pool.cash = pool.cash.minus(value);
            row.balanceRevenue = numeric(dec(row.balanceRevenue).plus(value));
            if (confirmed === 0) row.giftConsumption = numeric(dec(row.giftConsumption).plus(amount));
          } else {
            incomeComplete = false; pool.known = false; pool.quantity = pool.quantity.minus(amount);
            addIssue(row, `opening:${usage.userId}`, '付费 / 赠送余额来源不足，请核对期初余额及遗漏额度变动', { type: 'opening', userId: usage.userId, userName: users.get(usage.userId)?.name });
          }
          row.users.push({ userId: usage.userId, name: users.get(usage.userId)?.name || `用户 #${usage.userId}`, consumption: numeric(amount), revenue: confirmed });
        } else if (usage.billingType === 1 && dec(usage.amount).gt(0)) {
          const covered = documents.some(document => document.userId === usage.userId && document.kind === 'subscription' && !document.pending && document.serviceStart <= day.date && document.serviceEnd >= day.date);
          if (!covered) { incomeComplete = false; addIssue(row, `subscription:${usage.userId}`, '订阅消费缺少已确认的售价 / 服务期间，可补录零价赠送订阅', { type: 'subscription', userId: usage.userId }); }
        } else if (![0, 1].includes(usage.billingType) && dec(usage.amount).gt(0)) {
          incomeComplete = false; addIssue(row, `billing:${usage.userId}:${usage.billingType}`, '未知计费类型，需核对收入归属', { type: 'source' });
        }
      }
      if (!day.supplierComplete) addIssue(row, `supplier:${day.date}`, '供应商实际成本尚未完整核验', { type: 'supplier' });
      if (!day.siteComplete) addIssue(row, `usage:${day.date}`, '主站用量明细覆盖不完整', { type: 'source' });
      if (!sourceChainComplete && source?.complete) addIssue(row, 'earlier-source-gap', '核算起点至本日之间存在来源缺口，收入等待历史补算', { type: 'source' });
      if (day.mode === 'live' && source?.complete) {
        for (const [userId, pool] of pools) {
          const current = users.get(userId);
          if (current && pool.known && pool.quantity.minus(current.balance).abs().gt('0.000001')) {
            incomeComplete = false;
            addIssue(row, `reconcile:${userId}`, '核算余额与主站快照不一致，请核对赠送、返利或余额纠错', { type: 'opening', userId, userName: current.name,
              ledgerQuantity: numeric(pool.quantity), sourceQuantity: numeric(current.balance) });
          }
        }
      }
      row.revenue = incomeComplete ? numeric(dec(row.balanceRevenue).plus(row.subscriptionRevenue).plus(row.otherRevenue)) : null;
      if (!feeComplete) row.fee = null;
      if (!day.supplierComplete) row.supplierCost = null;
      if (row.revenue != null && row.supplierCost != null && row.fee != null) row.profit = numeric(dec(row.revenue).minus(row.supplierCost).minus(row.fee));
      row.margin = margin(row.profit, row.revenue); row.complete = row.profit != null;
      row.status = !source?.complete ? 'source_pending' : !incomeComplete ? 'income_pending' : !feeComplete ? 'fee_pending' : !day.supplierComplete ? 'supplier_pending' : 'complete';
      items.push(row);
    }
    this.store.saveResults(items);
    return { items, issues: [...allIssues.values()] };
  }
}

module.exports = { AccountingService, allocated, decisionSchema, TYPES, CATEGORIES };
