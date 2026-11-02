const crypto = require('crypto');
const { createAdapter } = require('../adapters/registry');
const { AppError, asAppError } = require('../errors');
const { nowIso, stringifyJson } = require('../db');
const { redactText } = require('../security/redaction');

class BalanceMonitorService {
  constructor({ db, config, providers, http, onCompleted = async () => {} }) {
    this.db = db;
    this.config = config;
    this.providers = providers;
    this.http = http;
    this.onCompleted = onCompleted;
    this.inFlight = new Map();
    this.concurrency = config.globalConcurrency || 5;
    this.activeReads = 0;
    this.waiters = [];
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.checkDue(), 5000);
    this.timer.unref?.();
    this.checkDue();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled(this.inFlight.values());
  }

  checkDue() {
    const capacity = Math.max(0, this.concurrency - this.inFlight.size);
    if (!capacity) return [];
    const due = this.db.prepare(`
      SELECT id FROM provider_connections
      WHERE enabled = 1 AND (next_balance_check_at IS NULL OR next_balance_check_at <= ?)
      ORDER BY next_balance_check_at, id
    `).all(nowIso()).filter((row) => !this.inFlight.has(row.id)).slice(0, capacity);
    return due.map(({ id }) => this.run(id).catch((error) => {
      if (this.config.env !== 'test') console.warn(JSON.stringify({
        level: 'warn', component: 'balance_monitor', connectionId: id, code: error.code,
        message: redactText(error.message)
      }));
    }));
  }

  run(connectionId, options = {}) {
    const existing = this.inFlight.get(connectionId);
    if (existing) return existing;
    const operation = this.#limited(() => this.#run(connectionId, options))
      .finally(() => this.inFlight.delete(connectionId));
    this.inFlight.set(connectionId, operation);
    return operation;
  }

  async #limited(operation) {
    if (this.activeReads >= this.concurrency) await new Promise((resolve) => this.waiters.push(resolve));
    else this.activeReads += 1;
    try { return await operation(); }
    finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.activeReads -= 1;
    }
  }

  async #run(connectionId, options) {
    const connection = this.providers.get(connectionId, { forAdapter: true });
    if (!connection.enabled && !options.manual) return { status: 'disabled' };
    const startedAt = nowIso();
    const started = Date.now();
    const runId = crypto.randomUUID();
    let context;
    this.db.prepare(`INSERT INTO check_runs(id, job_type, connection_id, status, started_at)
      VALUES (?, 'balance_check', ?, 'running', ?)`).run(runId, connectionId, startedAt);
    try {
      const deadline = started + this.config.queryTimeoutMs;
      const http = { requestJson: (url, request = {}) => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new AppError('TIMEOUT', 'Balance check budget exceeded', { status: 504 });
        return this.http.requestJson(url, { ...request, retries: 0,
          timeoutMs: Math.min(remaining, request.timeoutMs || this.config.queryTimeoutMs) });
      } };
      context = this.providers.adapterContext(connection, http);
      const adapter = createAdapter(connection.adapter_type, context);
      const account = await adapter.getAccount();
      const balances = await adapter.getAccountBalances(account);
      if (Date.now() > deadline) throw new AppError('TIMEOUT', 'Balance check budget exceeded', { status: 504 });
      if (!account?.remoteId || !Array.isArray(balances) || !balances.length || balances.some((balance) =>
        (balance.scope && balance.scope !== 'account') ||
        (!balance.unlimited && !Number.isFinite(balance.available)))) {
        throw new AppError('SCHEMA_MISMATCH', 'Provider did not return a valid account balance', { status: 502 });
      }
      const current = context.verifyCredentials();
      if (!current.enabled && !options.manual) {
        this.db.prepare(`UPDATE check_runs SET status = 'succeeded', completed_at = ?, duration_ms = ?,
          summary_json = ? WHERE id = ?`).run(nowIso(), Date.now() - started, '{"skipped":"disabled"}', runId);
        return { status: 'disabled' };
      }
      const capturedAt = nowIso();
      const nextCheckAt = new Date(Math.max(started + current.balance_refresh_interval_minutes * 60000,
        Date.now() + 5000)).toISOString();
      this.db.transaction(() => {
        const accountId = this.providers.upsertAccount(connectionId, account, capturedAt);
        const insert = this.db.prepare(`INSERT INTO balance_snapshots(
          connection_id, subject_type, subject_id, currency, available, total,
          used, granted, topped_up, frozen, unlimited, source_field, raw_json, captured_at
        ) VALUES (?, 'account', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const balance of balances) insert.run(connectionId, accountId, balance.currency || 'USD',
          balance.available ?? null, balance.total ?? null, balance.used ?? null,
          balance.granted ?? null, balance.toppedUp ?? null, balance.frozen ?? null,
          balance.unlimited ? 1 : 0, balance.sourceField || null, stringifyJson(balance.raw || {}), capturedAt);
        this.db.prepare(`UPDATE provider_connections SET
          last_balance_check_at = ?, last_balance_success_at = ?, next_balance_check_at = ?,
          balance_error_code = NULL, balance_error_message = NULL, balance_failure_count = 0
          WHERE id = ?`).run(capturedAt, capturedAt, nextCheckAt, connectionId);
        this.db.prepare(`UPDATE check_runs SET status = 'succeeded', completed_at = ?, duration_ms = ?,
          summary_json = ? WHERE id = ?`).run(capturedAt, Date.now() - started,
          stringifyJson({ balanceCount: balances.length }), runId);
      })();
      // Publish the balance before any inventory, logs, or mapping work can delay alerts.
      await Promise.resolve().then(() => this.onCompleted({ connectionId, capturedAt })).catch((error) => {
        this.db.prepare(`UPDATE check_runs SET status = 'partial', error_code = ?, error_message = ? WHERE id = ?`)
          .run('BALANCE_ALERT_FAILED', redactText(error.message), runId);
      });
      return { status: 'succeeded', account, balances, capturedAt };
    } catch (error) {
      let appError = asAppError(error);
      try { context?.verifyCredentials(); }
      catch (changed) { appError = asAppError(changed); }
      this.db.transaction(() => {
        const current = this.providers.get(connectionId, { forAdapter: true, required: false });
        if (current && appError.code !== 'CONFIG_CHANGED') {
          const failures = current.balance_failure_count + 1;
          let delay = current.balance_refresh_interval_minutes * 60000 * 2 ** Math.min(4, failures - 1);
          delay = Math.min(delay, Math.max(current.balance_refresh_interval_minutes, 15) * 60000);
          if (appError.code === 'RATE_LIMITED') delay = Math.max(delay, 5 * 60000);
          this.db.prepare(`UPDATE provider_connections SET last_balance_check_at = ?,
            next_balance_check_at = ?, balance_error_code = ?, balance_error_message = ?, balance_failure_count = ?
            WHERE id = ?`).run(nowIso(), new Date(Date.now() + delay).toISOString(), appError.code,
              redactText(appError.message), failures, connectionId);
        }
        this.db.prepare(`UPDATE check_runs SET status = 'failed', completed_at = ?, duration_ms = ?,
          error_code = ?, error_message = ? WHERE id = ?`).run(nowIso(), Date.now() - started,
            appError.code, redactText(appError.message), runId);
      })();
      throw appError;
    }
  }
}

module.exports = { BalanceMonitorService };
