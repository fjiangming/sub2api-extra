'use strict';

const { Pool } = require('pg');
const { parse: parseConnectionString } = require('pg-connection-string');

const CACHE_WINDOW_HOURS = 5;
const CACHE_TTL_MS = 60000;
const QUERY_TIMEOUT_MS = 5000;

const GROUP_CACHE_QUERY = `
  WITH totals AS (
    SELECT group_id::text AS group_id,
      SUM(GREATEST(COALESCE(cache_read_tokens, 0), 0)::numeric) AS cache_tokens,
      SUM(GREATEST(COALESCE(input_tokens, 0), 0)::numeric
        + GREATEST(COALESCE(cache_creation_tokens, 0), 0)::numeric
        + GREATEST(COALESCE(cache_read_tokens, 0), 0)::numeric) AS prompt_tokens
    FROM usage_logs
    WHERE group_id = ANY($1::bigint[])
      AND created_at >= $2::timestamptz AND created_at < $3::timestamptz
    GROUP BY group_id
  )
  SELECT group_id,
    CASE WHEN prompt_tokens > 0 THEN cache_tokens / prompt_tokens ELSE NULL END AS cache_rate
  FROM totals
`;

function normalizeGroupIds(groupIds) {
  return [...new Set(groupIds.map(String).filter((id) =>
    /^[1-9][0-9]{0,18}$/.test(id) && BigInt(id) <= 9223372036854775807n
  ))].sort();
}

function logQueryError(error) {
  console.error(JSON.stringify({
    event: 'group_cache_stats_failed',
    code: /^[A-Z0-9_]{1,64}$/.test(String(error?.code || '')) ? error.code : 'QUERY_FAILED'
  }));
}

function createMetricsPool(connectionString) {
  if (!connectionString) return null;
  const pool = new Pool({
    ...parseConnectionString(connectionString),
    max: 1,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: QUERY_TIMEOUT_MS,
    statement_timeout: QUERY_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS + 1000,
    options: '-c default_transaction_read_only=on',
    application_name: 'sub2api-degradation-detector-stats'
  });
  pool.on('error', logQueryError);
  return pool;
}

function snapshotAt(now, status) {
  return {
    status,
    window_start: (now - CACHE_WINDOW_HOURS * 3600000) / 1000,
    window_end: now / 1000,
    updated_at: status === 'ok' ? now / 1000 : null,
    rates: new Map()
  };
}

function publicGroupCacheStats(snapshot, groupId) {
  const rate = snapshot?.rates.get(String(groupId)) ?? null;
  return {
    status: snapshot?.status === 'ok' ? (rate == null ? 'no_data' : 'ok') : snapshot?.status || 'unavailable',
    rate,
    window_hours: CACHE_WINDOW_HOURS,
    window_start: snapshot?.window_start ?? null,
    window_end: snapshot?.window_end ?? null,
    updated_at: snapshot?.updated_at ?? null
  };
}

class GroupMetrics {
  constructor(config, { pool, now = Date.now } = {}) {
    this.demoMode = config.demoMode;
    this.now = now;
    this.pool = pool === undefined
      ? createMetricsPool(this.demoMode ? '' : config.sub2apiDatabaseUrl)
      : pool;
    this.cache = null;
    this.pending = null;
    this.closed = false;
  }

  async getRates(groupIds) {
    const ids = normalizeGroupIds(groupIds);
    const now = this.now();
    if (this.closed) return snapshotAt(now, 'unavailable');
    if (this.demoMode) {
      const snapshot = snapshotAt(now, 'ok');
      const fixtures = { '8': 0.934, '2': 0.762, '40': 0.073 };
      for (const id of ids) {
        if (Object.hasOwn(fixtures, id)) snapshot.rates.set(id, fixtures[id]);
      }
      return snapshot;
    }
    if (!this.pool) return snapshotAt(now, 'not_configured');
    if (!ids.length) return snapshotAt(now, 'ok');
    const key = ids.join(',');
    if (this.cache?.key === key && this.cache.expiresAt > now) return this.cache.snapshot;

    // Share one bounded snapshot across viewers; group authorization is checked for every response.
    if (this.pending) {
      await this.pending;
      return this.getRates(ids);
    }
    this.pending = this.load(ids, now).then((snapshot) => {
      this.cache = { key, snapshot, expiresAt: this.now() + CACHE_TTL_MS };
      return snapshot;
    });
    try {
      return await this.pending;
    } finally {
      this.pending = null;
    }
  }

  async load(ids, now) {
    try {
      const snapshot = snapshotAt(now, 'ok');
      const { rows } = await this.pool.query(GROUP_CACHE_QUERY, [
        ids, new Date(snapshot.window_start * 1000), new Date(now)
      ]);
      const allowed = new Set(ids);
      for (const row of rows) {
        const id = String(row.group_id);
        if (!allowed.has(id) || row.cache_rate == null) continue;
        const rate = Number(row.cache_rate);
        if (!Number.isFinite(rate) || rate < 0 || rate > 1) throw new Error('Invalid cache rate');
        snapshot.rates.set(id, rate);
      }
      return snapshot;
    } catch (error) {
      logQueryError(error);
      return snapshotAt(now, 'unavailable');
    }
  }

  async close() {
    this.closed = true;
    await this.pending;
    this.cache = null;
    await this.pool?.end();
  }
}

module.exports = {
  CACHE_TTL_MS,
  CACHE_WINDOW_HOURS,
  GROUP_CACHE_QUERY,
  GroupMetrics,
  createMetricsPool,
  publicGroupCacheStats
};
