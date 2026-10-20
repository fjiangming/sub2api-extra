'use strict';

const { z } = require('zod');
const { AppError } = require('../errors');

const querySchema = z.object({
  accountId: z.string().regex(/^[1-9]\d{0,18}$/),
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  limit: z.coerce.number().int().min(1).max(2000).default(500)
});

// This endpoint reads synchronized business samples only; it never probes a model.
class LatencySamplesService {
  constructor(db) { this.db = db; }

  query(input) {
    const parsed = querySchema.safeParse(input);
    if (!parsed.success) throw new AppError('INVALID_REQUEST', 'Invalid latency sample query', { status: 400 });
    const query = parsed.data;
    const from = new Date(query.from).toISOString();
    const to = new Date(query.to).toISOString();
    if (from >= to || Date.parse(to) - Date.parse(from) > 2 * 86400000) {
      throw new AppError('INVALID_REQUEST', 'Sample window must be between zero and 48 hours', { status: 400 });
    }
    const historical = this.db.prepare(`SELECT DISTINCT connection_id, key_id, valid_from, valid_to
      FROM sub2api_mapping_history WHERE account_id = ? AND enabled = 1
        AND valid_from < ? AND (valid_to IS NULL OR valid_to > ?)`)
      .all(query.accountId, to, from);
    const current = this.db.prepare(`SELECT connection_id, key_id FROM sub2api_mappings
      WHERE CAST(account_id AS TEXT) = ? AND enabled = 1`).all(query.accountId);
    const targets = historical.map((row) => ({ ...row, scope: 'history' }));
    for (const row of current) {
      if (!targets.some((target) => target.connection_id === row.connection_id && target.key_id === row.key_id)) {
        targets.push({ ...row, valid_from: null, valid_to: null, scope: 'current_unverified' });
      }
    }
    const items = new Map();
    const mappings = [];
    let truncated = false;
    for (const target of targets.slice(0, 50)) {
      const provider = this.db.prepare('SELECT name, last_success_at FROM provider_connections WHERE id = ?').get(target.connection_id);
      if (!provider) continue;
      const coverage = target.key_id ? this.db.prepare(`SELECT status, coverage_from, coverage_to, truncated, last_synced_at
        FROM provider_request_key_sync_state WHERE key_id = ?`).get(target.key_id) : null;
      mappings.push({ providerName: provider.name, scope: target.scope, keyMapped: Boolean(target.key_id),
        validFrom: target.valid_from, validTo: target.valid_to,
        coverage: coverage || null, lastSyncAt: coverage?.last_synced_at || provider.last_success_at });
      if (!target.key_id) continue;
      const sampleFrom = new Date(Math.max(Date.parse(from), target.valid_from ? Date.parse(target.valid_from) : -Infinity)).toISOString();
      const sampleTo = new Date(Math.min(Date.parse(to), target.valid_to ? Date.parse(target.valid_to) : Infinity)).toISOString();
      const rows = this.db.prepare(`SELECT source_log_id, request_id, model, upstream_model, stream,
        status, duration_ms, first_token_ms, input_tokens, output_tokens, cache_creation_tokens,
        cache_read_tokens, created_at FROM provider_request_samples
        WHERE connection_id = ? AND key_id = ? AND created_at >= ? AND created_at < ?
        ORDER BY created_at DESC, source_log_id DESC LIMIT ?`)
        .all(target.connection_id, target.key_id, sampleFrom, sampleTo, query.limit + 1);
      truncated ||= rows.length > query.limit || Boolean(coverage?.truncated);
      for (const row of rows.slice(0, query.limit)) {
        const identity = `${target.connection_id}:${row.source_log_id}`;
        if (items.has(identity)) continue;
        items.set(identity, { ...row, identity, providerName: provider.name, mappingScope: target.scope });
      }
    }
    const rows = [...items.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
    return { items: rows.slice(0, query.limit), mappings, truncated: truncated || rows.length > query.limit || targets.length > 50,
      source: 'synchronized_business_samples', generatedAt: new Date().toISOString() };
  }
}

module.exports = { LatencySamplesService };
