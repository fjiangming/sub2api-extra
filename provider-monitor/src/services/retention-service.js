const { nowIso } = require('../db');

class RetentionService {
  constructor({ db, config, credentials }) {
    this.db = db;
    this.config = config;
    this.credentials = credentials;
  }

  run(referenceTime = Date.now()) {
    const rawBefore = new Date(referenceTime - this.config.rawSnapshotRetentionDays * 86400000).toISOString();
    const hourlyBefore = new Date(referenceTime - this.config.snapshotRetentionDays * 86400000).toISOString();
    const jobBefore = new Date(referenceTime - this.config.jobRetentionDays * 86400000).toISOString();
    const auditBefore = new Date(referenceTime - this.config.auditRetentionDays * 86400000).toISOString();
    const notificationBefore = new Date(referenceTime - this.config.notificationRetentionDays * 86400000).toISOString();

    const aggregate = this.db.transaction(() => {
      this.#aggregateBalances(rawBefore, 'hourly', '%Y-%m-%dT%H:00:00.000Z');
      this.#aggregateUsage(rawBefore, 'hourly', '%Y-%m-%dT%H:00:00.000Z');
      this.#aggregateDailyBalances(hourlyBefore);
      this.#aggregateDailyUsage(hourlyBefore);
    });
    aggregate();

    const removed = {
      rawBalances: this.#deleteRaw('balance_snapshots', rawBefore, ['connection_id', 'subject_type', 'subject_id', 'currency']),
      rawUsage: this.#deleteRaw('usage_snapshots', rawBefore, ['connection_id', 'subject_type', 'subject_id', 'currency', 'model', 'period']),
      hourlyBalances: this.#deleteBatches('balance_aggregates', "granularity = 'hourly' AND captured_at < ?", [hourlyBefore]),
      hourlyUsage: this.#deleteBatches('usage_aggregates', "granularity = 'hourly' AND captured_at < ?", [hourlyBefore]),
      prices: this.#deleteBatches('model_prices', 'captured_at < ?', [hourlyBefore]),
      jobs: this.#deleteBatches('jobs', "status IN ('succeeded', 'failed') AND updated_at < ?", [jobBefore]),
      checks: this.#deleteBatches('check_runs', 'completed_at IS NOT NULL AND completed_at < ?', [jobBefore]),
      audits: this.#deleteBatches('audit_logs', 'created_at < ?', [auditBefore]),
      notifications: this.#deleteBatches('notification_deliveries', 'created_at < ?', [notificationBefore])
    };
    removed.credentialBackups = this.credentials.cleanupExpiredBackups();
    return { ranAt: nowIso(), cutoffs: { rawBefore, hourlyBefore, jobBefore, auditBefore, notificationBefore }, removed };
  }

  #aggregateBalances(before, granularity, format) {
    this.db.prepare(`
      INSERT OR IGNORE INTO balance_aggregates(
        connection_id, subject_type, subject_id, currency, available, total, used,
        granted, topped_up, frozen, unlimited, source_field, raw_json, granularity, captured_at
      )
      SELECT connection_id, subject_type, subject_id, currency, available, total, used,
        granted, topped_up, frozen, unlimited, source_field, raw_json, ?, bucket_at
      FROM (
        SELECT source.*, ROW_NUMBER() OVER (
          PARTITION BY connection_id, subject_type, subject_id, currency, bucket_at
          ORDER BY captured_at DESC, id DESC
        ) row_number
        FROM (
          SELECT snapshots.*, strftime(?, captured_at) bucket_at
          FROM balance_snapshots snapshots WHERE captured_at < ? AND id NOT IN (
            SELECT id FROM (
              SELECT id, ROW_NUMBER() OVER (
                PARTITION BY connection_id, subject_type, COALESCE(subject_id, ''), currency
                ORDER BY captured_at DESC, id DESC
              ) row_number FROM balance_snapshots
            ) latest WHERE row_number = 1
          )
        ) source WHERE bucket_at IS NOT NULL
      ) ranked WHERE row_number = 1
    `).run(granularity, format, before);
  }

  #aggregateUsage(before, granularity, format) {
    this.db.prepare(`
      INSERT OR IGNORE INTO usage_aggregates(
        connection_id, subject_type, subject_id, currency, cost, requests,
        input_tokens, output_tokens, total_tokens, model, period, raw_json,
        granularity, captured_at
      )
      SELECT connection_id, subject_type, subject_id, currency, cost, requests,
        input_tokens, output_tokens, total_tokens, model, period, raw_json, ?, bucket_at
      FROM (
        SELECT source.*, ROW_NUMBER() OVER (
          PARTITION BY connection_id, subject_type, subject_id, currency, model, period, bucket_at
          ORDER BY captured_at DESC, id DESC
        ) row_number
        FROM (
          SELECT snapshots.*, strftime(?, captured_at) bucket_at
          FROM usage_snapshots snapshots WHERE captured_at < ? AND id NOT IN (
            SELECT id FROM (
              SELECT id, ROW_NUMBER() OVER (
                PARTITION BY connection_id, subject_type, COALESCE(subject_id, ''), currency,
                  COALESCE(model, ''), period ORDER BY captured_at DESC, id DESC
              ) row_number FROM usage_snapshots
            ) latest WHERE row_number = 1
          )
        ) source WHERE bucket_at IS NOT NULL
      ) ranked WHERE row_number = 1
    `).run(granularity, format, before);
  }

  #aggregateDailyBalances(before) {
    this.db.prepare(`
      INSERT OR IGNORE INTO balance_aggregates(
        connection_id, subject_type, subject_id, currency, available, total, used,
        granted, topped_up, frozen, unlimited, source_field, raw_json, granularity, captured_at
      )
      SELECT connection_id, subject_type, subject_id, currency, available, total, used,
        granted, topped_up, frozen, unlimited, source_field, raw_json, 'daily', bucket_at
      FROM (
        SELECT source.*, ROW_NUMBER() OVER (
          PARTITION BY connection_id, subject_type, subject_id, currency, bucket_at
          ORDER BY captured_at DESC, id DESC
        ) row_number
        FROM (
          SELECT aggregates.*, strftime('%Y-%m-%dT00:00:00.000Z', captured_at) bucket_at
          FROM balance_aggregates aggregates
          WHERE granularity = 'hourly' AND captured_at < ?
        ) source WHERE bucket_at IS NOT NULL
      ) ranked WHERE row_number = 1
    `).run(before);
  }

  #aggregateDailyUsage(before) {
    this.db.prepare(`
      INSERT OR IGNORE INTO usage_aggregates(
        connection_id, subject_type, subject_id, currency, cost, requests,
        input_tokens, output_tokens, total_tokens, model, period, raw_json,
        granularity, captured_at
      )
      SELECT connection_id, subject_type, subject_id, currency, cost, requests,
        input_tokens, output_tokens, total_tokens, model, period, raw_json, 'daily', bucket_at
      FROM (
        SELECT source.*, ROW_NUMBER() OVER (
          PARTITION BY connection_id, subject_type, subject_id, currency, model, period, bucket_at
          ORDER BY captured_at DESC, id DESC
        ) row_number
        FROM (
          SELECT aggregates.*, strftime('%Y-%m-%dT00:00:00.000Z', captured_at) bucket_at
          FROM usage_aggregates aggregates
          WHERE granularity = 'hourly' AND captured_at < ?
        ) source WHERE bucket_at IS NOT NULL
      ) ranked WHERE row_number = 1
    `).run(before);
  }

  #deleteRaw(table, before, partitionColumns) {
    const partition = partitionColumns.map((column) => `COALESCE(${column}, '')`).join(', ');
    return this.#deleteBatches(table, `captured_at < ? AND id NOT IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY ${partition} ORDER BY captured_at DESC, id DESC) row_number
        FROM ${table}
      ) latest WHERE row_number = 1
    )`, [before]);
  }

  #deleteBatches(table, where, params) {
    let total = 0;
    while (true) {
      const result = this.db.prepare(`
        DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE ${where} LIMIT 5000)
      `).run(...params);
      total += result.changes;
      if (result.changes < 5000) return total;
    }
  }
}

module.exports = { RetentionService };
