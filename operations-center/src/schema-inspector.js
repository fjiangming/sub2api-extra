'use strict';

const REQUIRED_TABLES = [
  'users',
  'usage_logs',
  'usage_dashboard_hourly',
  'usage_dashboard_hourly_users',
  'usage_dashboard_daily',
  'usage_dashboard_daily_users',
  'usage_dashboard_aggregation_watermark',
  'payment_orders',
  'payment_audit_logs',
  'redeem_codes'
];

const OPTIONAL_TABLES = [
  'user_subscriptions',
  'usage_group_daily_rollups',
  'usage_group_rollup_state',
  'usage_cleanup_tasks',
  'ops_system_logs',
  'ops_error_logs',
  'ops_system_metrics',
  'ops_metrics_hourly',
  'ops_metrics_daily',
  'ops_ingress_reject_aggregates',
  'ops_alert_events',
  'ops_job_heartbeats',
  'usage_billing_dedup',
  'usage_billing_dedup_archive'
];

class SchemaInspector {
  constructor(pool) {
    this.pool = pool;
    this.cached = null;
    this.cachedAt = 0;
  }

  async inspect({ refresh = false } = {}) {
    if (!refresh && this.cached && Date.now() - this.cachedAt < 300000) return this.cached;
    const names = [...REQUIRED_TABLES, ...OPTIONAL_TABLES];
    const { rows } = await this.pool.query(`
      SELECT c.relname AS table_name,
             c.relkind,
             EXISTS (
               SELECT 1 FROM pg_partitioned_table p WHERE p.partrelid = c.oid
             ) AS partitioned,
             ARRAY_AGG(a.attname ORDER BY a.attnum) FILTER (WHERE a.attnum > 0 AND NOT a.attisdropped) AS columns
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attribute a ON a.attrelid = c.oid
      WHERE n.nspname = ANY(current_schemas(false))
        AND c.relname = ANY($1::text[])
        AND c.relkind IN ('r', 'p')
      GROUP BY c.oid, c.relname, c.relkind
    `, [names]);
    const tables = Object.fromEntries(rows.map((row) => [row.table_name, {
      exists: true,
      partitioned: row.partitioned,
      columns: row.columns || []
    }]));
    for (const name of names) {
      if (!tables[name]) tables[name] = { exists: false, partitioned: false, columns: [] };
    }
    const missingRequired = REQUIRED_TABLES.filter((name) => !tables[name].exists);
    this.cached = {
      compatible: missingRequired.length === 0,
      missingRequired,
      tables,
      checkedAt: new Date().toISOString()
    };
    this.cachedAt = Date.now();
    return this.cached;
  }

  async requireTables(names) {
    const state = await this.inspect();
    return names.filter((name) => !state.tables[name]?.exists);
  }
}

module.exports = { SchemaInspector, REQUIRED_TABLES, OPTIONAL_TABLES };
