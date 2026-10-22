'use strict';

const { z } = require('zod');
const { AppError } = require('../errors');
const { unwrap } = require('../sub2api-client');

const idSchema = z.string().uuid();
const versionSchema = z.number().int().positive();
const evidenceSchema = z.string().trim().min(8).max(4000);
function validated(schema, value) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError('INVALID_REQUEST', parsed.error.issues[0].message, { status: 400 });
  return parsed.data;
}

class BillingRecoveryService {
  constructor({ config, sub2api, providerMonitor, now = () => Date.now() }) {
    this.config = config; this.sub2api = sub2api; this.providerMonitor = providerMonitor; this.now = now;
    this.running = null; this.timer = null; this.lastRun = null; this.lastError = null;
  }

  status() {
    return { automaticEnabled: this.config.billingRecoveryEnabled !== false,
      credentialsConfigured: this.sub2api.persistentCredentialsConfigured(), running: Boolean(this.running),
      lastRun: this.lastRun, lastError: this.lastError };
  }

  async request(path = '', options = {}, accessToken) {
    return unwrap(await this.sub2api.raw(`/api/v1/admin/billing-recovery${path}`, {
      ...options, ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      headers: { ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}), ...(options.headers || {}) }
    }, !accessToken));
  }

  async list(query = {}, accessToken) {
    const filter = validated(z.object({
      state: z.enum(['', 'unknown', 'prepared', 'settled', 'review', 'ignored', 'pending']).default('unknown'),
      page: z.coerce.number().int().min(1).max(100000).default(1),
      page_size: z.coerce.number().int().min(1).max(100).default(20)
    }), query);
    return this.request(`?${new URLSearchParams(filter)}`, {}, accessToken);
  }

  detail(id, accessToken) { return this.request(`/${validated(idSchema, id)}`, {}, accessToken); }

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

  async lookup(id, accessToken) {
    const detail = await this.detail(id, accessToken);
    const entry = detail.case;
    const at = Date.parse(entry.created_at);
    const payload = await this.providerMonitor.getLatencySamples({ accountId: String(entry.account_id),
      from: new Date(at - 15 * 60000).toISOString(),
      to: new Date(Math.min(this.now(), at + 2 * 3600000)).toISOString(), limit: '2000' }, accessToken);
    const uniqueId = String(entry.upstream_request_id || '').trim();
    const candidates = (payload.items || []).filter((row) => uniqueId &&
      String(row.request_id ?? row.requestId ?? '') === uniqueId);
    // Time, model and token similarity never authorize a charge.
    const exact = uniqueId && candidates.length === 1 && !payload.truncated &&
      candidates[0].mappingScope === 'history' ? candidates[0] : null;
    const dimensions = { input_tokens: 'InputTokens', output_tokens: 'OutputTokens',
      cache_creation_tokens: 'CacheCreationTokens', cache_read_tokens: 'CacheReadTokens' };
    const comparison = exact ? Object.entries(dimensions).map(([field, native]) => {
      const upstream = exact[field] == null ? null : Number(exact[field]);
      const recorded = entry.usage_record?.[native] == null ? null : Number(entry.usage_record[native]);
      return { field, upstream, recorded, difference: upstream == null || recorded == null ? null : upstream - recorded };
    }) : [];
    return { caseId: id, exact, comparison, candidates: candidates.length, truncated: Boolean(payload.truncated),
      items: (payload.items || []).slice(0, 100), mappings: payload.mappings || [],
      status: exact ? 'exact' : uniqueId ? 'unresolved' : 'missing_request_id' };
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
      this.lastRun = new Date(this.now()).toISOString(); this.lastError = null;
      return { settled, failed };
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
