'use strict';

// Only existing read contracts are used. This source never observes/reconciles billing cases.
class DomainAccessSource {
  constructor({ pool, now = () => Date.now() }) {
    this.pool = pool; this.now = now; this.lastError = null; this.lastSuccess = null; this.retryAt = 0; this.failures = 0;
  }

  async match(requests) {
    if (!requests.length) return [];
    if (this.now() < this.retryAt) return [];
    if (!this.pool || this.pool.configured?.() === false) {
      this.lastError = 'DATABASE_NOT_CONFIGURED'; return [];
    }
    let client;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN READ ONLY');
      await client.query("SET LOCAL statement_timeout = '5000ms'");
      const ids = requests.map(row => row.id);
      // Time only bounds the query. It never substitutes for an exact trusted request ID.
      const first = Math.min(...requests.map(row => row.at)) - 3600000;
      const last = Math.max(...requests.map(row => row.at)) + 3600000;
      const sql = `SELECT r.id AS evidence_id,r.user_id,r.api_key_id,
          r.request_snapshot->>'request_id' AS request_id,
          COALESCE(NULLIF(to_jsonb(u)->>'username',''),to_jsonb(u)->>'email','') AS name,
          COALESCE(to_jsonb(u)->>'email','') AS email,COALESCE(to_jsonb(u)->>'role','unknown') AS role,
          (u.id IS NOT NULL AND to_jsonb(u)->>'deleted_at' IS NULL) AS available
        FROM sub2api_custom.billing_recovery r LEFT JOIN public.users u ON u.id=r.user_id
        WHERE r.created_at >= $1::timestamptz AND r.created_at <= $2::timestamptz
          AND r.request_snapshot->>'request_id'=ANY($3::text[])
        LIMIT 2001`;
      const parameters = [new Date(first).toISOString(), new Date(last).toISOString(), ids];
      // EXPLAIN never executes the scan. Large unindexed plans require operator attention.
      const plan = (await client.query(`EXPLAIN (FORMAT JSON) ${sql}`, parameters)).rows[0]?.['QUERY PLAN'];
      const estimatedCost = Number(plan?.[0]?.Plan?.['Total Cost']);
      if (!Number.isFinite(estimatedCost) || estimatedCost > 2500) {
        throw Object.assign(new Error(), { code: 'IDENTITY_QUERY_PLAN_LIMIT' });
      }
      const result = await client.query(sql, parameters);
      await client.query('COMMIT');
      if (result.rows.length > 2000) { this.failure('IDENTITY_RESULT_LIMIT'); return []; }
      this.lastError = null; this.lastSuccess = this.now(); this.retryAt = 0; this.failures = 0;
      return requests.map(request => {
        const matches = result.rows.filter(row => row.request_id === request.id);
        const identities = new Set(matches.map(row => `${row.user_id}:${row.api_key_id}`));
        if (!matches.length) return { id: request.id, identity: 'pending', reason: 'exact_record_not_found' };
        if (identities.size !== 1) return { id: request.id, identity: 'ambiguous', reason: 'identity_conflict',
          evidence: matches.slice(0, 20).map(row => ({ source: 'billing_recovery', id: row.evidence_id })) };
        const row = matches[0], userId = Number(row.user_id), keyId = Number(row.api_key_id);
        if (!Number.isSafeInteger(userId) || userId <= 0 || !Number.isSafeInteger(keyId) || keyId <= 0 ||
            !row.available || !['user', 'admin'].includes(row.role)) {
          return { id: request.id, identity: 'pending', reason: 'user_unavailable' };
        }
        return { id: request.id, identity: 'confirmed', reason: 'trusted_gateway_exact_core_request', userId, keyId,
          evidence: matches.slice(0, 20).map(entry => ({ source: 'billing_recovery', id: String(entry.evidence_id).slice(0, 128) })),
          profile: { id: userId, name: String(row.name || `用户 #${userId}`).slice(0, 200),
            email: String(row.email).slice(0, 320), role: row.role } };
      });
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      this.failure(['42501', '42P01', '3F000', '42703', '57014', 'IDENTITY_QUERY_PLAN_LIMIT'].includes(error.code) ? error.code : 'IDENTITY_SOURCE_UNAVAILABLE');
      return [];
    } finally { client?.release(); }
  }

  failure(code) {
    this.lastError = code; this.failures++;
    this.retryAt = this.now() + Math.min(900000, 60000 * 2 ** Math.min(this.failures - 1, 4));
  }
}

module.exports = { DomainAccessSource };
