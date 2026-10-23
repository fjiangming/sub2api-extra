'use strict';

const { z } = require('zod');
const { AppError } = require('../errors');
const { unwrap } = require('../sub2api-client');
const { observedTokens, requestIds, upstreamTokens } = require('./billing-recovery-usage');

const idSchema = z.string().uuid();
const versionSchema = z.number().int().positive();
const evidenceSchema = z.string().trim().min(8).max(4000);
function validated(schema, value) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError('INVALID_REQUEST', parsed.error.issues[0].message, { status: 400 });
  return parsed.data;
}

class BillingRecoveryService {
  constructor({ config, sub2api, providerMonitor, store = null, now = () => Date.now() }) {
    this.config = config; this.sub2api = sub2api; this.providerMonitor = providerMonitor; this.now = now;
    this.running = null; this.timer = null; this.lastRun = null; this.lastError = null;
    this.store = store;
  }

  status() {
    return { automaticEnabled: this.config.billingRecoveryEnabled !== false,
      credentialsConfigured: this.sub2api.persistentCredentialsConfigured(), running: Boolean(this.running),
      lastRun: this.lastRun, lastError: this.lastError, reconciliation: this.store?.summary() || [] };
  }

  async request(path = '', options = {}, accessToken) {
    return unwrap(await this.sub2api.raw(`/api/v1/admin/billing-recovery${path}`, {
      ...options, ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      headers: { ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}), ...(options.headers || {}) }
    }, !accessToken));
  }

  async list(query = {}, accessToken) {
    const filter = validated(z.object({
      state: z.enum(['', 'unknown', 'prepared', 'settled', 'review', 'ignored', 'pending', 'incomplete']).default('unknown'),
      page: z.coerce.number().int().min(1).max(100000).default(1),
      page_size: z.coerce.number().int().min(1).max(100).default(20),
      user_id: z.union([z.literal(''), z.coerce.number().int().positive()]).optional(),
      api_key_id: z.union([z.literal(''), z.coerce.number().int().positive()]).optional(),
      account_id: z.union([z.literal(''), z.coerce.number().int().positive()]).optional(),
      request_id: z.string().trim().max(128).optional(),
      from: z.string().datetime({ offset: true }).optional(),
      to: z.string().datetime({ offset: true }).optional(),
      timeout_only: z.enum(['true','false']).optional()
    }), query);
    const result = await this.request(`?${new URLSearchParams(filter)}`, {}, accessToken);
    for (const entry of result.items || []) {
      this.store?.observe(entry);
      entry.observed_tokens = observedTokens(entry);
      const audit = this.store?.get(entry.id);
      entry.reconciliation = audit ? { status: audit.lookup_status, attempts: audit.attempts,
        next_check_at: new Date(audit.next_check_at).toISOString(), last_error: audit.last_error } : null;
    }
    return result;
  }

  async detail(id, accessToken) {
    const result = await this.request(`/${validated(idSchema, id)}`, {}, accessToken);
    this.store?.observe(result.case);
    result.case.observed_tokens = observedTokens(result.case);
    const audit = this.store?.get(id);
    result.reconciliation = audit ? { status: audit.lookup_status, attempts: audit.attempts,
      next_check_at: new Date(audit.next_check_at).toISOString(), last_error: audit.last_error,
      lookup: audit.lookup } : null;
    return result;
  }

  async review(id, input, accessToken) {
    const body = validated(z.object({ version: versionSchema,
      state: z.enum(['review', 'ignored', 'prepared']), evidence: evidenceSchema }).strict(), input);
    return this.request(`/${validated(idSchema, id)}/review`, { method: 'POST', body }, accessToken);
  }

  async restore(id, input, accessToken) {
    const body = validated(z.object({ version: versionSchema, evidence: evidenceSchema,
      usage_record: z.record(z.string(), z.unknown()) }).strict(), input);
    return this.request(`/${validated(idSchema, id)}/usage`, { method: 'POST', body }, accessToken);
  }

  async settle(id, input, accessToken) {
    const body = validated(z.object({ version: versionSchema }).strict(), input);
    return this.request(`/${validated(idSchema, id)}/settle`, { method: 'POST', body }, accessToken);
  }

  async draftVerifiedUsage(id, accessToken, lookup = null) {
    const detail = await this.detail(id, accessToken);
    const entry = detail.case;
    if (entry.usage_record || !['unknown', 'review'].includes(entry.state)) return { status: 'already_recorded' };
    const observed = observedTokens(entry);
    if (!lookup) {
      try { lookup = await this.lookup(id, accessToken); }
      catch (error) {
        if (!observed.complete) throw error;
        lookup = { exact: null, status: 'provider_unavailable', errorCode: error.code || 'LOOKUP_FAILED' };
      }
    }
    const providerFinal = lookup.exact && [true, 1].includes(lookup.exact.usage_complete);
    const tokens = observed.complete ? observed : providerFinal ? upstreamTokens(lookup.exact) : null;
    if (!tokens || tokens.input_tokens == null || tokens.output_tokens == null) return { status: 'final_usage_missing' };
    if (observed.complete && !observed.supported) return { status: 'multimodal_pricing_review' };
    if (entry.request_snapshot?.pricing?.eligible !== true) return { status: 'historical_price_missing' };
    if (observed.complete && providerFinal) {
      const upstream = upstreamTokens(lookup.exact);
      if (['input_tokens', 'output_tokens', 'cache_creation_tokens', 'cache_read_tokens']
        .some(field => (upstream[field] ?? 0) !== (observed[field] ?? 0))) {
        return { status: 'usage_conflict' };
      }
    }
    if ((tokens.cache_creation_tokens || 0) > 0 && tokens.cache_creation_5m_tokens == null && tokens.cache_creation_1h_tokens == null) {
      return { status: 'cache_ttl_unverified' };
    }
    const priced = await this.request(`/${validated(idSchema, id)}/quote`, { method: 'POST', body: {
      version: entry.version, tokens: { InputTokens: tokens.input_tokens, OutputTokens: tokens.output_tokens,
        CacheCreationTokens: tokens.cache_creation_tokens ?? 0, CacheReadTokens: tokens.cache_read_tokens ?? 0,
        CacheCreation5mTokens: tokens.cache_creation_5m_tokens ?? 0, CacheCreation1hTokens: tokens.cache_creation_1h_tokens ?? 0 }
    } }, accessToken);
    const evidence = JSON.stringify({ source: observed.complete ? 'persisted_terminal_usage' : 'unique_historical_provider_bill',
      case_id: id, request_ids: [...requestIds(entry)], provider_bill: lookup.exact?.identity || null,
      upstream_cost: lookup.exact?.actual_cost ?? null, pricing: 'immutable_dispatch_snapshot',
      checked_at: new Date(this.now()).toISOString() });
    const result = await this.restore(id, { version: entry.version, usage_record: priced.usage_record, evidence }, accessToken);
    await this.detail(result.case_id || id, accessToken);
    return { status: 'review_ready', caseId: result.case_id || id };
  }

  async lookup(id, accessToken, { refresh = true, persist = true } = {}) {
    const detail = await this.detail(id, accessToken);
    const entry = detail.case;
    const at = Date.parse(entry.created_at);
    const query = { accountId: String(entry.account_id),
      from: new Date(at - 15 * 60000).toISOString(),
      to: new Date(Math.min(this.now(), at + 2 * 3600000)).toISOString(), limit: '2000' };
    let payload = await this.providerMonitor.getLatencySamples(query, accessToken);
    const ids = requestIds(entry);
    let refreshStatus = null;
    if (refresh && this.providerMonitor.refreshBillingSamples &&
        (!payload.items?.some(row => ids.has(String(row.request_id ?? row.requestId ?? ''))) ||
         payload.truncated || payload.billingCoverageComplete === false)) {
      refreshStatus = await this.providerMonitor.refreshBillingSamples(query, accessToken);
      payload = await this.providerMonitor.getLatencySamples(query, accessToken);
    }
    const candidates = (payload.items || []).filter((row) => ids.has(String(row.request_id ?? row.requestId ?? '')));
    // Time, model and token similarity never authorize a charge.
    const exact = candidates.length === 1 && !payload.truncated && payload.billingCoverageComplete === true &&
      candidates[0].mappingScope === 'history' ? candidates[0] : null;
    const dimensions = { input_tokens: 'InputTokens', output_tokens: 'OutputTokens',
      cache_creation_tokens: 'CacheCreationTokens', cache_read_tokens: 'CacheReadTokens' };
    const comparison = exact ? Object.entries(dimensions).map(([field, native]) => {
      const upstream = upstreamTokens(exact)[field];
      const recorded = entry.usage_record?.[native] == null ? null : Number(entry.usage_record[native]);
      return { field, upstream, recorded, difference: upstream == null || recorded == null ? null : upstream - recorded };
    }) : [];
    const result = { caseId: id, exact, comparison, candidates: candidates.length, truncated: Boolean(payload.truncated),
      items: (payload.items || []).slice(0, 100), mappings: payload.mappings || [],
      coverageComplete: payload.billingCoverageComplete === true,
      observedTokens: observedTokens(entry), upstreamTokens: exact ? upstreamTokens(exact) : null, refreshStatus,
      status: exact ? 'exact' : ids.size ? 'unresolved' : 'missing_request_id' };
    if (persist) this.store?.checked(id, result);
    return result;
  }

  async reconcileUnknown(accessToken) {
    if (!this.store) return { checked: 0, unresolved: 0 };
    // Persist the page cursor so old unresolved cases cannot starve new cases or
    // vanish from the work queue after an operations-center restart.
    for (const state of ['unknown', 'review', 'incomplete']) {
      const page = this.store.cursor(undefined, state);
      const result = await this.list({ state, page, page_size: 100 }, accessToken);
      this.store.cursor(page * 100 >= result.total ? 1 : page + 1, state);
    }
    let checked = 0, unresolved = 0;
    for (const { id } of this.store.due(20)) {
      if (!this.store.claim(id)) continue;
      try {
        const detail = await this.detail(id, accessToken);
        const entry = detail.case;
        if (!['unknown', 'review', 'settled'].includes(entry.state)) continue;
        const deadline = Number(entry.request_snapshot?.recovery_timeout_seconds || 1800) * 1000 + 60000;
        if (this.now() - Date.parse(entry.created_at) < deadline || this.now() - Date.parse(entry.updated_at) < 60000) {
          this.store.checked(id, { status: 'in_flight' }); continue;
        }
        if (entry.usage_record && entry.state !== 'settled') { this.store.checked(id, { status: 'review_ready' }); continue; }
        let lookup;
        try { lookup = await this.lookup(id, accessToken, { persist: false }); }
        catch (error) {
          if (!observedTokens(entry).complete) throw error;
          lookup = { exact: null, status: 'provider_unavailable', errorCode: error.code || 'LOOKUP_FAILED' };
        }
        if (entry.state === 'settled') {
          const differences = (lookup.comparison || []).map(row => row.difference);
          this.store.checked(id, { ...lookup, status: !lookup.exact || differences.some(value => value == null)
            ? 'unresolved' : differences.some(value => value !== 0) ? 'usage_difference' : 'verified' });
          checked++; if (!lookup.exact) unresolved++; continue;
        }
        const draft = await this.draftVerifiedUsage(id, accessToken, lookup);
        this.store.checked(id, { ...lookup, draft, status: draft.status });
        checked += 1;
        if (!lookup.exact) unresolved += 1;
      } catch (error) {
        this.store.checked(id, null, error.code || 'LOOKUP_FAILED'); unresolved += 1;
      }
    }
    return { checked, unresolved };
  }

  async retryPending(accessToken) {
    if (this.running) return this.running;
    this.running = (async () => {
      let settled = 0, failed = 0;
      const result = await this.list({ state: 'pending', page_size: 100 }, accessToken);
      for (const entry of result.items || []) {
        if (Date.parse(entry.next_retry_at) > this.now()) continue;
        try { await this.settle(entry.id, { version: entry.version }, accessToken); settled += 1; }
        catch { failed += 1; }
      }
      const reconciliation = await this.reconcileUnknown(accessToken);
      this.lastRun = new Date(this.now()).toISOString(); this.lastError = null;
      return { settled, failed, ...reconciliation };
    })().catch((error) => { this.lastError = error.code || 'BILLING_RECOVERY_UNAVAILABLE'; throw error; })
      .finally(() => { this.running = null; });
    return this.running;
  }

  start() {
    if (this.timer || this.config.billingRecoveryEnabled === false) return;
    const run = () => {
      if (this.sub2api.persistentCredentialsConfigured()) this.retryPending().catch(() => {});
    };
    this.timer = setInterval(run, 30000); this.timer.unref?.(); run();
  }

  async stop() { clearInterval(this.timer); this.timer = null; await this.running?.catch(() => {}); }
}

module.exports = { BillingRecoveryService };
