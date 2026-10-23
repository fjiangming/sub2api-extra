'use strict';

const crypto = require('node:crypto');
const Decimal = require('decimal.js');
const { z } = require('zod');
const { AppError } = require('../errors');
const { parseBillingCSV, describeBillingCSV, hash } = require('./billing-import-csv');
const { matchBillingRows } = require('./billing-import-source');
const { observedTokens } = require('./billing-recovery-usage');

const id = z.string().uuid();
const positiveId = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const optionsSchema = z.object({
  timezone: z.string().max(100).default('Asia/Shanghai'), timeKind: z.enum(['start', 'end']).default('start'),
  toleranceSeconds: z.number().int().min(1).max(120).default(5), clockOffsetSeconds: z.number().int().min(-300).max(300).default(0),
  inputIncludesCache: z.boolean().default(false),
  accountMappings: z.record(z.string().max(200), positiveId).default({}),
  columns: z.record(z.string().max(30), z.string().max(200)).default({})
}).strict();
const price = z.number().finite().min(0).max(1000000);
const pricingSchema = z.record(z.string().max(128), z.object({
  input: price.optional(), output: price.optional(), cacheRead: price.optional(), cache5m: price.optional(), cache1h: price.optional(),
  multiplier: z.number().finite().positive().max(1000000).optional(), accountMultiplier: price.optional(),
  cacheTTL: z.enum(['5m', '1h', 'split']).default('split')
}).strict());
const validate = (schema, value) => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError('INVALID_REQUEST', parsed.error.issues[0].message, { status: 400 });
  return parsed.data;
};
const conflict = message => new AppError('IMPORT_REVIEW_REQUIRED', message, { status: 409 });
const money = value => new Decimal(value).toDecimalPlaces(8, Decimal.ROUND_HALF_UP).toNumber();
const metadata = parsed => ({ headers: parsed.headers, columns: parsed.columns, keys: parsed.keys, models: parsed.models });

function verifiedTokens(record, input, rule) {
  const tokens = { ...record.tokens };
  for (const name of ['CacheReadTokens', 'CacheCreationTokens']) {
    if (tokens[name] == null) {
      if (!input.missingCacheIsZero) throw conflict('CSV 缺少缓存明细，需要核实其确实为零');
      tokens[name] = 0;
    }
  }
  if (tokens.CacheCreationTokens > 0 && tokens.CacheCreation5mTokens == null && tokens.CacheCreation1hTokens == null) {
    if (!rule || rule.cacheTTL === 'split') throw conflict('需要核定缓存创建的 5 分钟 / 1 小时归属');
    tokens.CacheCreation5mTokens = rule.cacheTTL === '5m' ? tokens.CacheCreationTokens : 0;
    tokens.CacheCreation1hTokens = rule.cacheTTL === '1h' ? tokens.CacheCreationTokens : 0;
  }
  tokens.CacheCreation5mTokens ??= 0; tokens.CacheCreation1hTokens ??= 0;
  if (tokens.CacheCreation5mTokens + tokens.CacheCreation1hTokens !== tokens.CacheCreationTokens) throw conflict('缓存创建明细与总数不一致');
  return tokens;
}

function manualUsage(record, tokens, rule) {
  const cost = (count, unit) => money(new Decimal(count).times(unit).div(1000000));
  const usage = { Model: record.model, ...tokens, InputCost: cost(tokens.InputTokens, rule.input),
    OutputCost: cost(tokens.OutputTokens, rule.output), CacheReadCost: cost(tokens.CacheReadTokens, rule.cacheRead),
    CacheCreationCost: money(new Decimal(cost(tokens.CacheCreation5mTokens, rule.cache5m)).plus(cost(tokens.CacheCreation1hTokens, rule.cache1h))),
    RateMultiplier: rule.multiplier, AccountRateMultiplier: rule.accountMultiplier, Stream: record.stream, RequestType: record.stream ? 2 : 1 };
  usage.TotalCost = money(new Decimal(usage.InputCost).plus(usage.OutputCost).plus(usage.CacheReadCost).plus(usage.CacheCreationCost));
  // The native restore contract multiplies float64, then quantizes its shortest
  // decimal representation. Keep the preview identical even at half-unit edges.
  usage.ActualCost = money(usage.TotalCost * usage.RateMultiplier);
  if (usage.TotalCost > 1e8 || usage.ActualCost > 1e8) throw conflict('历史费用超出原生计费范围');
  if (usage.TotalCost <= 0 || usage.ActualCost <= 0) throw conflict('零元账单无需补扣；请核对历史售价');
  return usage;
}

class BillingImportService {
  constructor({ store, source, recovery, now = () => Date.now() }) { Object.assign(this, { store, source, recovery, now }); }
  async options() { return { accounts: await this.source.accounts(), batches: this.store.batches() }; }
  inspect(input) {
    const body = validate(z.object({ csv: z.string() }).strict(), input);
    const { headers, columns, matrix } = describeBillingCSV(body.csv);
    return { headers, columns, total: matrix.length };
  }
  async import(input) {
    const body = validate(z.object({ fileName: z.string().trim().min(1).max(200), csv: z.string(), options: optionsSchema.optional() }).strict(), input);
    const options = validate(optionsSchema, body.options || {});
    if (Object.keys(options.accountMappings).length > 20) throw conflict('每批最多映射 20 个上游 Key');
    const parsed = parseBillingCSV(body.csv, options);
    const batchId = this.store.create(body.fileName.replace(/[\\/]/g, '_'), body.csv, hash(body.csv), options, parsed.rows, metadata(parsed));
    return this.detail(batchId);
  }
  detail(batchId, query = {}) {
    validate(id, batchId);
    const batch = this.store.batch(batchId);
    const filter = validate(z.enum(['all', 'actionable', 'review', 'recorded', 'settled']), query.filter || 'all');
    const page = Math.max(1, Math.min(1000, Math.floor(Number(query.page) || 1)));
    const info = batch.metadata || metadata(parseBillingCSV(batch.csv, batch.options));
    if (!batch.metadata) this.store.metadata(batchId, info);
    return { id: batch.id, fileName: batch.file_name, createdAt: batch.created_at, options: batch.options,
      ...info, ...this.store.page(batchId, filter, page) };
  }
  async match(batchId, input, accessToken) {
    const options = validate(optionsSchema, input);
    if (Object.keys(options.accountMappings).length > 20) throw conflict('每批最多映射 20 个上游 Key');
    const batch = this.store.batch(validate(id, batchId));
    const parsed = parseBillingCSV(batch.csv, options);
    // Load before changing persistent selections. Query failure or truncation
    // must not leave a partially matched batch that appears ready to charge.
    const source = await this.source.load(parsed.rows, options, accessToken);
    const matches = matchBillingRows(parsed.rows, source.candidates, options);
    this.store.db.transaction(() => {
      this.store.configure(batchId, options, parsed.rows, metadata(parsed));
      this.store.rows(batchId).forEach((row, index) => this.store.save(row.id, { match: matches[index], status: matches[index].status,
        selection: matches[index].selected, preview: null, result: null }, row.version));
    })();
    return { ...this.detail(batchId), coreAvailable: source.coreAvailable };
  }
  async preview(batchId, input, accessToken) {
    const body = validate(z.object({ rowIds: z.array(id).min(1).max(20), assignments: z.record(id, z.string().max(200)).default({}),
      pricing: pricingSchema.default({}), pricingEvidence: z.string().trim().min(8).max(1500),
      assignmentEvidence: z.string().trim().max(1000).default(''), confirmTimeMatches: z.boolean().default(false),
      finalUsageConfirmed: z.literal(true), missingCacheIsZero: z.boolean().default(false)
    }).strict(), input);
    const batch = this.store.batch(validate(id, batchId));
    const results = [];
    for (const rowId of new Set(body.rowIds)) {
      const row = this.store.get(rowId);
      if (row.batch_id !== batchId) throw conflict('记录不属于当前批次');
      if (['confirming', 'settled', 'failed'].includes(row.status)) { results.push({ rowId, status: row.status }); continue; }
      try {
        const record = row.record;
        if (record.error || record.duplicateOf) throw conflict(record.error || '重复记录不能补扣');
        if (row.match?.totalCandidates > 30) throw conflict('候选过多，请缩小时间容差后重新匹配');
        if (record.billingMode && !/^(按量|tokens?|按token)$/i.test(record.billingMode)) throw conflict('该行不是标准 Token 计费，需原生维度核查');
        const reference = Object.hasOwn(body.assignments, row.id) ? body.assignments[row.id] : row.match?.selected;
        const candidate = row.match?.candidates.find(item => item.reference === reference);
        if (!candidate || candidate.recorded || !['unknown', 'review', 'legacy_error'].includes(candidate.state)) throw conflict('需要选择尚未记账的本地请求');
        if (candidate.blockedReason) throw conflict(candidate.blockedReason);
        if ([candidate.userId, candidate.apiKeyId, candidate.accountId].some(value => !Number.isSafeInteger(Number(value)) || Number(value) <= 0)) throw conflict('原生归属 ID 超出可核对范围');
        if (row.match.method !== 'request_id' && !body.confirmTimeMatches) throw conflict('时间匹配需要确认用户归属');
        if ((row.match.totalCandidates > 1 || row.match.status === 'assignment_conflict') && body.assignmentEvidence.length < 8) throw conflict('冲突匹配需要填写用户归属核对依据');
        if (this.store.hasPreview(batchId, reference, row.id)) throw conflict('同一本地请求已被其他行选择');
        const rule = Object.hasOwn(body.pricing, record.model) ? body.pricing[record.model] : null;
        const tokens = verifiedTokens(record, body, rule);
        let usage, pricingSource = 'operator_historical_prices';
        if (candidate.kind === 'case') {
          const fresh = (await this.recovery.detail(candidate.caseId, accessToken)).case;
          if (fresh.version !== candidate.version || fresh.usage_record) throw conflict('本地记录已变化，请重新匹配');
          const observed = observedTokens(fresh);
          if (!observed.supported) throw conflict('该请求有非标准 Token 消耗，请使用原生维度核查');
          if (fresh.request_snapshot?.pricing && fresh.request_snapshot.pricing.eligible !== true) throw conflict('该请求不支持标准 Token 报价，请在异常请求中核查原生维度与历史价格');
          if (['InputTokens', 'OutputTokens', 'CacheReadTokens', 'CacheCreationTokens', 'CacheCreation5mTokens', 'CacheCreation1hTokens'].some((field, i) => {
            const count = observed[['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'cache_creation_5m_tokens', 'cache_creation_1h_tokens'][i]];
            return count != null && (observed.complete ? tokens[field] !== count : tokens[field] < count);
          })) throw conflict('CSV 与本站已观察用量冲突');
          if (fresh.request_snapshot?.pricing?.eligible) {
            usage = (await this.recovery.request(`/${candidate.caseId}/quote`, { method: 'POST', body: { version: fresh.version, tokens } }, accessToken)).usage_record;
            pricingSource = 'immutable_dispatch_snapshot';
          }
        }
        if (!usage) {
          if (!rule || ['input', 'output', 'cacheRead', 'cache5m', 'cache1h', 'multiplier', 'accountMultiplier'].some(key => rule[key] == null)) throw conflict('缺少该模型的历史售卖单价和倍率');
          usage = manualUsage(record, tokens, rule);
        }
        usage.ActualCost = money(usage.TotalCost * usage.RateMultiplier);
        if (usage.ActualCost <= 0) throw conflict('零元账单无需补扣');
        const accountId = Object.hasOwn(batch.options.accountMappings, record.key) ? Number(batch.options.accountMappings[record.key]) : 0;
        if (!accountId || String(accountId) !== candidate.accountId) throw conflict('上游账号归属已变化，请重新匹配');
        const evidence = JSON.stringify({ source: 'operator_confirmed_supplier_csv', file: batch.file_name,
          file_hash: batch.content_hash, row: row.number, bill_identity: record.identity, supplier_cost: record.cost || null,
          match_method: row.match.method, time_difference_ms: candidate.timeDifferenceMs, local_reference: reference,
          assignment_evidence: body.assignmentEvidence, pricing_source: pricingSource, pricing_evidence: body.pricingEvidence,
          manual_price_rule: pricingSource === 'operator_historical_prices' ? rule : null,
          tokens_confirmed_final: true });
        const reservation = { account_id: accountId, bill_identity: record.identity,
          payload_digest: hash([reference, tokens, usage, pricingSource]), user_id: Number(candidate.userId), api_key_id: Number(candidate.apiKeyId),
          started_at: new Date(candidate.startUncertain ? record.startedAt : candidate.startMs).toISOString(), model: record.model,
          upstream_request_id: record.requestId || '', evidence,
          ...(candidate.kind === 'case' ? { case_id: candidate.caseId, version: candidate.version } : { error_id: candidate.errorId, event_index: candidate.eventIndex }) };
        const preview = { id: crypto.randomUUID(), reference, userId: candidate.userId, userEmail: candidate.userEmail,
          apiKeyId: candidate.apiKeyId, billingType: candidate.billingType, usage, pricingSource, reservation,
          expiresAt: this.now() + 3600000, assignmentEvidence: body.assignmentEvidence };
        this.store.save(row.id, { preview, selection: reference, selection_confirmed: 1, status: 'preview', result: null }, row.version);
        results.push({ rowId, status: 'preview' });
      } catch (error) {
        if (error.code === 'PREVIEW_CONFLICT') throw error;
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') error = conflict('同一本地请求已被其他行选择，请刷新');
        if (!(error instanceof AppError) || !['IMPORT_REVIEW_REQUIRED', 'INVALID_REQUEST'].includes(error.code)) throw error;
        this.store.save(row.id, { preview: null, status: 'needs_review', result: { error: error.message } }, row.version);
        results.push({ rowId, status: 'needs_review', error: error.message });
      }
    }
    return { results, detail: this.detail(batchId) };
  }
  async confirm(batchId, input, accessToken) {
    const body = validate(z.object({ acknowledge: z.literal(true), rows: z.array(z.object({ id, version: z.number().int().positive(), previewId: id }).strict()).min(1).max(20) }).strict(), input);
    validate(id, batchId); const results = [];
    for (const selected of body.rows) {
      let row = this.store.get(selected.id);
      if (row.batch_id !== batchId || row.preview?.id !== selected.previewId) throw conflict('预览不属于当前记录');
      if (row.status === 'settled') { results.push({ id: row.id, status: 'settled', caseId: row.case_id }); continue; }
      if (row.status === 'preview' && row.preview.expiresAt < this.now()) throw conflict('扣费预览已过期，请重新生成');
      row = this.store.claim(row.id, selected.version, selected.previewId);
      try {
        const preview = row.preview;
        const reserved = await this.recovery.request('/imports/reserve', { method: 'POST', body: preview.reservation }, accessToken);
        row = this.store.save(row.id, { case_id: reserved.case_id }, row.version);
        let entry = (await this.recovery.detail(reserved.case_id, accessToken)).case;
        if (String(entry.user_id) !== preview.userId || String(entry.api_key_id) !== preview.apiKeyId ||
            Number(entry.account_id) !== preview.reservation.account_id ||
            (entry.subscription_id ? 'subscription' : 'balance') !== preview.billingType) throw conflict('核心使用记录归属或计费类型与预览不一致');
        if (!entry.usage_record) {
          await this.recovery.restore(entry.id, { version: entry.version, usage_record: preview.usage, evidence: preview.reservation.evidence }, accessToken);
          entry = (await this.recovery.detail(entry.id, accessToken)).case;
        }
        const fields = ['Model', 'InputTokens', 'OutputTokens', 'CacheReadTokens', 'CacheCreationTokens', 'CacheCreation5mTokens',
          'CacheCreation1hTokens', 'InputCost', 'OutputCost', 'CacheReadCost', 'CacheCreationCost', 'TotalCost', 'RateMultiplier', 'ActualCost', 'AccountRateMultiplier'];
        if (fields.some(field => entry.usage_record?.[field] !== preview.usage[field])) throw conflict('核心待结算使用记录与预览不一致，已停止结算');
        if (entry.state === 'review') {
          await this.recovery.review(entry.id, { version: entry.version, state: 'prepared', evidence: preview.reservation.evidence }, accessToken);
          entry = (await this.recovery.detail(entry.id, accessToken)).case;
        }
        if (entry.state === 'prepared') {
          try { await this.recovery.settle(entry.id, { version: entry.version }, accessToken); }
          catch (error) {
            const latest = (await this.recovery.detail(entry.id, accessToken)).case;
            if (latest.state !== 'settled') throw error;
          }
          entry = (await this.recovery.detail(entry.id, accessToken)).case;
        }
        if (entry.state !== 'settled') throw conflict('核心记录尚未完成结算');
        this.store.save(row.id, { status: 'settled', lease_until: 0, result: { caseId: entry.id, amount: entry.usage_record.ActualCost, settledAt: new Date(this.now()).toISOString() } }, row.version);
        results.push({ id: row.id, status: 'settled', caseId: entry.id });
      } catch (error) {
        this.store.save(row.id, { status: 'failed', lease_until: 0, result: { error: error.message } }, row.version);
        results.push({ id: row.id, status: 'failed', error: error.message });
      }
    }
    return { results, detail: this.detail(batchId) };
  }
}

module.exports = { BillingImportService, optionsSchema, manualUsage, verifiedTokens };
