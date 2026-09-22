'use strict';

const { BoundedTtlCache } = require('../cache');

const CANDIDATE_TABLES = [
  'usage_logs',
  'usage_dashboard_hourly',
  'usage_dashboard_hourly_users',
  'usage_dashboard_daily',
  'usage_dashboard_daily_users',
  'ops_system_logs',
  'ops_error_logs',
  'ops_system_metrics',
  'ops_metrics_hourly',
  'ops_metrics_daily',
  'ops_ingress_reject_aggregates',
  'ops_alert_events'
];

function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

class StorageService {
  constructor(pool, inspector, config) {
    this.pool = pool;
    this.inspector = inspector;
    this.config = config;
    this.samples = [];
    this.cache = new BoundedTtlCache({ ttlMs: config.cacheTtlSeconds * 1000, maxEntries: 5 });
    this.timer = null;
  }

  start() {
    this.captureSample().catch((error) => console.error('[capacity] initial sample failed', error));
    this.timer = setInterval(() => {
      this.captureSample().catch((error) => console.error('[capacity] sample failed', error));
    }, this.config.capacitySampleIntervalMinutes * 60000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async captureSample() {
    const { rows } = await this.pool.query(`
      SELECT pg_database_size(current_database()) AS database_bytes,
             COALESCE((
               SELECT SUM(pg_total_relation_size(c.oid))
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = ANY(current_schemas(false)) AND c.relkind IN ('r', 'm')
             ), 0) AS relation_bytes,
             COALESCE((
               SELECT SUM(pg_total_relation_size(c.oid))
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
               LEFT JOIN pg_inherits i ON i.inhrelid = c.oid
               LEFT JOIN pg_class parent ON parent.oid = i.inhparent
               WHERE n.nspname = ANY(current_schemas(false))
                 AND c.relkind IN ('r', 'm')
                 AND (c.relname = ANY($1::text[]) OR parent.relname = ANY($1::text[]))
             ), 0) AS candidate_bytes
    `, [CANDIDATE_TABLES]);
    const relationBytes = asNumber(rows[0].relation_bytes);
    const candidateBytes = asNumber(rows[0].candidate_bytes);
    const sample = {
      at: new Date().toISOString(),
      databaseBytes: asNumber(rows[0].database_bytes),
      relationBytes,
      candidateBytes,
      protectedBytes: Math.max(relationBytes - candidateBytes, 0)
    };
    const last = this.samples[this.samples.length - 1];
    if (!last || last.databaseBytes !== sample.databaseBytes || Date.now() - Date.parse(last.at) >= 300000) {
      this.samples.push(sample);
      while (this.samples.length > this.config.capacitySampleLimit) this.samples.shift();
    }
    return sample;
  }

  growth() {
    if (this.samples.length < 2) return { available: false, reason: '样本不足，至少需要两个采样点' };
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const elapsedDays = (Date.parse(last.at) - Date.parse(first.at)) / 86400000;
    if (elapsedDays < 1 / 24) return { available: false, reason: '采样跨度不足一小时' };
    return {
      available: true,
      sampleCount: this.samples.length,
      elapsedDays,
      databaseBytesPerDay: (last.databaseBytes - first.databaseBytes) / elapsedDays,
      candidateBytesPerDay: (last.candidateBytes - first.candidateBytes) / elapsedDays
    };
  }

  async getStorage({ refresh = false } = {}) {
    const cached = !refresh && this.cache.get('storage');
    if (cached) return cached;
    const [relations, database, maintenance, schema] = await Promise.all([
      this.pool.query(`
        SELECT n.nspname AS schema_name,
               c.relname AS table_name,
               c.relkind,
               parent.relname AS parent_table,
               pg_total_relation_size(c.oid) AS total_bytes,
               pg_relation_size(c.oid) AS heap_bytes,
               pg_indexes_size(c.oid) AS index_bytes,
               GREATEST(pg_total_relation_size(c.oid) - pg_relation_size(c.oid) - pg_indexes_size(c.oid), 0) AS toast_bytes,
               COALESCE(s.n_live_tup, c.reltuples)::bigint AS estimated_live_rows,
               COALESCE(s.n_dead_tup, 0)::bigint AS estimated_dead_rows,
               s.last_autovacuum,
               s.last_autoanalyze
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
        LEFT JOIN pg_inherits i ON i.inhrelid = c.oid
        LEFT JOIN pg_class parent ON parent.oid = i.inhparent
        WHERE n.nspname = ANY(current_schemas(false))
          AND c.relkind IN ('r', 'p', 'm')
        ORDER BY pg_total_relation_size(c.oid) DESC
        LIMIT 200
      `),
      this.pool.query(`
        SELECT current_database() AS database,
               pg_database_size(current_database()) AS database_bytes,
               pg_size_pretty(pg_database_size(current_database())) AS database_size,
               NOW() AS measured_at
      `),
      this.getMaintenanceSignals(),
      this.inspector.inspect({ refresh })
    ]);
    const latestSample = await this.captureSample();
    const relationRows = relations.rows.map((row) => {
      const cleanupCandidate = CANDIDATE_TABLES.includes(row.table_name) || CANDIDATE_TABLES.includes(row.parent_table);
      return {
        ...row,
        total_bytes: asNumber(row.total_bytes),
        heap_bytes: asNumber(row.heap_bytes),
        index_bytes: asNumber(row.index_bytes),
        toast_bytes: asNumber(row.toast_bytes),
        estimated_live_rows: asNumber(row.estimated_live_rows),
        estimated_dead_rows: asNumber(row.estimated_dead_rows),
        cleanupCandidate,
        protected: !cleanupCandidate
      };
    });
    const result = {
      generatedAt: new Date().toISOString(),
      database: { ...database.rows[0], database_bytes: asNumber(database.rows[0].database_bytes) },
      relations: relationRows,
      totals: {
        candidateBytes: latestSample.candidateBytes,
        protectedBytes: latestSample.protectedBytes
      },
      maintenance,
      schema,
      latestSample,
      growth: this.growth(),
      samples: this.samples.slice(),
      filesystem: {
        available: false,
        reason: '数据库连接不能可靠反映 PostgreSQL、WAL、Redis、Docker 与备份所在宿主机文件系统。'
      },
      physicalReleaseNote: 'DELETE 主要产生数据库内可复用空间；普通 VACUUM 通常不会把同等字节立即归还操作系统。'
    };
    this.cache.set('storage', result);
    return result;
  }

  async getMaintenanceSignals() {
    const result = {
      longTransactions: null,
      replicationSlots: null,
      permissions: []
    };
    try {
      const { rows } = await this.pool.query(`
        SELECT COUNT(*) AS count,
               COALESCE(MAX(EXTRACT(EPOCH FROM (NOW() - xact_start))), 0) AS oldest_seconds
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND xact_start IS NOT NULL
          AND pid <> pg_backend_pid()
      `);
      result.longTransactions = {
        count: asNumber(rows[0].count),
        oldestSeconds: asNumber(rows[0].oldest_seconds)
      };
    } catch (error) {
      result.permissions.push({ capability: 'pg_stat_activity', available: false, reason: error.message });
    }
    try {
      const { rows } = await this.pool.query(`
        SELECT slot_name, active,
               GREATEST(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn), 0) AS retained_wal_bytes
        FROM pg_replication_slots
      `);
      result.replicationSlots = rows.map((row) => ({
        slotName: row.slot_name,
        active: row.active,
        retainedWalBytes: asNumber(row.retained_wal_bytes)
      }));
    } catch (error) {
      result.permissions.push({ capability: 'pg_replication_slots', available: false, reason: error.message });
    }
    return result;
  }
}

module.exports = { StorageService, CANDIDATE_TABLES, asNumber };
