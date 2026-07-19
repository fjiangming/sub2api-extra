const client = require('prom-client');

class Metrics {
  constructor(db, enabled = true) {
    this.db = db;
    this.enabled = enabled;
    this.registry = new client.Registry();
    if (!enabled) return;
    client.collectDefaultMetrics({ register: this.registry, prefix: 'provider_monitor_' });
    this.syncTotal = new client.Counter({
      name: 'provider_monitor_sync_total',
      help: 'Provider sync attempts by adapter and result',
      labelNames: ['adapter', 'status'],
      registers: [this.registry]
    });
    this.syncDuration = new client.Histogram({
      name: 'provider_monitor_sync_duration_seconds',
      help: 'Provider sync duration in seconds',
      labelNames: ['adapter', 'status'],
      buckets: [0.25, 0.5, 1, 2, 5, 10, 30, 60],
      registers: [this.registry]
    });
    this.providerGauge = new client.Gauge({
      name: 'provider_monitor_providers',
      help: 'Configured provider connections by state',
      labelNames: ['state'],
      registers: [this.registry],
      collect: () => {
        const row = this.db.prepare(`
          SELECT COUNT(*) total,
            SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) enabled,
            SUM(CASE WHEN last_error_code IS NOT NULL THEN 1 ELSE 0 END) failing
          FROM provider_connections
        `).get();
        this.providerGauge.set({ state: 'total' }, row.total || 0);
        this.providerGauge.set({ state: 'enabled' }, row.enabled || 0);
        this.providerGauge.set({ state: 'failing' }, row.failing || 0);
      }
    });
    this.alertGauge = new client.Gauge({
      name: 'provider_monitor_active_alerts',
      help: 'Currently active provider alerts',
      registers: [this.registry],
      collect: () => {
        const row = this.db.prepare(`SELECT COUNT(*) count FROM alert_events WHERE status IN ('active', 'acknowledged')`).get();
        this.alertGauge.set(row.count || 0);
      }
    });
    this.accountBalanceGauge = new client.Gauge({
      name: 'provider_monitor_account_balance',
      help: 'Latest account balance by provider, internal account id and currency',
      labelNames: ['provider_id', 'provider', 'account_id', 'currency'],
      registers: [this.registry],
      collect: () => {
        this.accountBalanceGauge.reset();
        const rows = this.db.prepare(`
          WITH ranked AS (
            SELECT s.*, ROW_NUMBER() OVER (
              PARTITION BY s.connection_id, s.subject_id, s.currency
              ORDER BY s.captured_at DESC, s.id DESC
            ) row_number
            FROM balance_snapshots s WHERE s.subject_type = 'account'
          ) SELECT r.*, p.name provider FROM ranked r
          JOIN provider_connections p ON p.id = r.connection_id
          WHERE r.row_number = 1 AND r.available IS NOT NULL
        `).all();
        for (const row of rows) this.accountBalanceGauge.set({
          provider_id: row.connection_id,
          provider: row.provider,
          account_id: row.subject_id || 'account',
          currency: row.currency
        }, Number(row.available));
      }
    });
    this.keyQuotaGauge = new client.Gauge({
      name: 'provider_monitor_key_remaining_quota',
      help: 'Latest key quota using internal key ids only',
      labelNames: ['provider_id', 'key_id', 'currency'],
      registers: [this.registry],
      collect: () => {
        this.keyQuotaGauge.reset();
        for (const row of this.db.prepare(`
          SELECT connection_id provider_id, id key_id, COALESCE(currency, 'USD') currency, quota_remaining
          FROM remote_keys WHERE quota_remaining IS NOT NULL
        `).all()) this.keyQuotaGauge.set({
          provider_id: row.provider_id, key_id: row.key_id, currency: row.currency
        }, Number(row.quota_remaining));
      }
    });
    this.teamBudgetGauge = new client.Gauge({
      name: 'provider_monitor_team_remaining_budget',
      help: 'Latest LiteLLM or provider team remaining budget',
      labelNames: ['provider_id', 'team_id', 'currency'],
      registers: [this.registry],
      collect: () => {
        this.teamBudgetGauge.reset();
        const rows = this.db.prepare(`
          WITH ranked AS (
            SELECT *, ROW_NUMBER() OVER (
              PARTITION BY connection_id, subject_id, currency ORDER BY captured_at DESC, id DESC
            ) row_number FROM balance_snapshots WHERE subject_type = 'team'
          ) SELECT * FROM ranked WHERE row_number = 1 AND available IS NOT NULL
        `).all();
        for (const row of rows) this.teamBudgetGauge.set({
          provider_id: row.connection_id, team_id: row.subject_id || 'team', currency: row.currency
        }, Number(row.available));
      }
    });
    this.lastSuccessGauge = new client.Gauge({
      name: 'provider_monitor_last_success_timestamp',
      help: 'Unix timestamp of the last successful provider sync',
      labelNames: ['provider_id', 'provider'],
      registers: [this.registry],
      collect: () => {
        this.lastSuccessGauge.reset();
        for (const row of this.db.prepare(`SELECT id provider_id, name provider, last_success_at FROM provider_connections WHERE last_success_at IS NOT NULL`).all()) {
          this.lastSuccessGauge.set({ provider_id: row.provider_id, provider: row.provider }, Date.parse(row.last_success_at) / 1000);
        }
      }
    });
    this.keyStatusGauge = new client.Gauge({
      name: 'provider_monitor_remote_key_status',
      help: 'Remote key status as one-hot values without key material',
      labelNames: ['provider_id', 'key_id', 'status'],
      registers: [this.registry],
      collect: () => {
        this.keyStatusGauge.reset();
        for (const row of this.db.prepare(`SELECT connection_id provider_id, id key_id, status FROM remote_keys`).all()) {
          this.keyStatusGauge.set(row, 1);
        }
      }
    });
    this.runwayGauge = new client.Gauge({
      name: 'provider_monitor_forecast_runway_days',
      help: 'Estimated provider runway in days from recent balance snapshots',
      labelNames: ['provider_id', 'currency'],
      registers: [this.registry],
      collect: () => {
        this.runwayGauge.reset();
        const currencies = this.db.prepare(`
          SELECT DISTINCT connection_id, currency FROM balance_snapshots WHERE subject_type = 'account'
        `).all();
        for (const item of currencies) {
          const rows = this.db.prepare(`
            WITH combined AS (
              SELECT connection_id, subject_type, currency, available, captured_at FROM balance_snapshots
              UNION ALL
              SELECT connection_id, subject_type, currency, available, captured_at FROM balance_aggregates
            )
            SELECT available, captured_at FROM combined
            WHERE connection_id = ? AND subject_type = 'account' AND currency = ?
              AND available IS NOT NULL ORDER BY captured_at DESC LIMIT 20
          `).all(item.connection_id, item.currency);
          if (rows.length < 3) continue;
          const latest = rows[0];
          const oldest = rows[rows.length - 1];
          const days = (Date.parse(latest.captured_at) - Date.parse(oldest.captured_at)) / 86400000;
          const burn = days > 0 ? (Number(oldest.available) - Number(latest.available)) / days : 0;
          if (burn > 0) this.runwayGauge.set({ provider_id: item.connection_id, currency: item.currency }, Math.max(0, Number(latest.available) / burn));
        }
      }
    });
  }

  recordSync(adapter, status, durationSeconds) {
    if (!this.enabled) return;
    this.syncTotal.inc({ adapter, status });
    this.syncDuration.observe({ adapter, status }, durationSeconds);
  }

  async render() {
    return this.enabled ? this.registry.metrics() : '';
  }

  contentType() {
    return this.registry.contentType;
  }
}

module.exports = {
  Metrics
};
