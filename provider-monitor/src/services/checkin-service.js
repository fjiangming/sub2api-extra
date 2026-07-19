const crypto = require('crypto');
const { createAdapter } = require('../adapters/registry');
const { AppError, asAppError } = require('../errors');
const { nowIso, parseJson, stringifyJson } = require('../db');
const { redactText } = require('../security/redaction');

class CheckInService {
  constructor({ db, config, providers, http }) {
    this.db = db;
    this.config = config;
    this.providers = providers;
    this.http = http;
  }

  dateKey(date = new Date()) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: this.config.timezone || 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(date);
  }

  async run(connectionId, options = {}) {
    const connection = this.providers.get(connectionId, { forAdapter: true });
    const adapter = createAdapter(connection.adapter_type, {
      connection, credentials: this.providers.getCredentials(connection), http: this.http, config: this.config,
      onCredentialsUpdated: async (credentials) => this.providers.updateCredentials(connection, credentials)
    });
    const beforeBalance = this.db.prepare(`
      SELECT available FROM balance_snapshots WHERE connection_id = ? AND subject_type = 'account'
      ORDER BY captured_at DESC, id DESC LIMIT 1
    `).get(connectionId)?.available ?? null;
    let result;
    try {
      const status = await adapter.getCheckInStatus();
      if (!status.supported) result = { status: 'unsupported', rewardAmount: null, details: status };
      else if (status.checkedInToday) result = { status: 'already_checked', rewardAmount: null, details: status };
      else result = await adapter.checkIn();
    } catch (error) {
      const appError = asAppError(error, 'CHECKIN_FAILED');
      const manual = /turnstile|captcha|cloudflare|challenge|verify/i.test(`${appError.code} ${appError.message}`);
      result = { status: manual ? 'manual_action_required' : 'failed', rewardAmount: null, manualActionRequired: manual, error: { code: appError.code, message: redactText(appError.message), retryable: appError.retryable } };
    }
    let afterBalance = null;
    if (['succeeded', 'already_checked'].includes(result.status)) {
      try {
        const account = await adapter.getAccount();
        const balances = await adapter.getAccountBalances(account);
        const selected = balances.find((item) => item.currency === (result.currency || 'USD')) || balances[0];
        afterBalance = selected?.available ?? null;
        const accountRow = this.db.prepare(`
          SELECT id FROM remote_accounts WHERE connection_id = ? AND remote_id = ?
        `).get(connectionId, String(account.remoteId));
        if (selected && accountRow) {
          this.db.prepare(`
            INSERT INTO balance_snapshots(
              connection_id, subject_type, subject_id, currency, available, total,
              used, granted, topped_up, frozen, unlimited, source_field, raw_json, captured_at
            ) VALUES (?, 'account', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(connectionId, accountRow.id, selected.currency || 'USD', selected.available ?? null,
            selected.total ?? null, selected.used ?? null, selected.granted ?? null,
            selected.toppedUp ?? null, selected.frozen ?? null, selected.unlimited ? 1 : 0,
            selected.sourceField || 'checkin.balance', stringifyJson(selected.raw || {}), nowIso());
        }
      } catch (error) {
        result.details = { ...(result.details || {}), balanceRefreshWarning: asAppError(error).code };
      }
    }
    const record = {
      id: crypto.randomUUID(), connectionId, status: result.status,
      rewardAmount: result.rewardAmount ?? null, currency: result.currency || 'USD',
      beforeBalance, afterBalance, manualActionRequired: Boolean(result.manualActionRequired),
      details: result.details || result.error || {}, checkedAt: nowIso()
    };
    this.db.prepare(`
      INSERT INTO checkin_records(
        id, connection_id, status, reward_amount, currency, before_balance,
        after_balance, manual_action_required, details_json, checked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(record.id, connectionId, record.status, record.rewardAmount, record.currency, record.beforeBalance, record.afterBalance, record.manualActionRequired ? 1 : 0, stringifyJson(record.details), record.checkedAt);
    if (options.throwOnRetryable && result.error?.retryable) {
      throw new AppError(result.error.code, result.error.message, { status: 502, retryable: true });
    }
    return record;
  }

  dueConnections() {
    const today = this.dateKey();
    return this.db.prepare(`SELECT id, type_config_json FROM provider_connections WHERE enabled = 1`).all().filter((row) => {
      const config = parseJson(row.type_config_json, {});
      if (!config.autoCheckIn) return false;
      const latest = this.db.prepare(`SELECT checked_at, status FROM checkin_records WHERE connection_id = ? ORDER BY checked_at DESC LIMIT 1`).get(row.id);
      return !latest || this.dateKey(new Date(latest.checked_at)) !== today || !['succeeded', 'already_checked'].includes(latest.status);
    }).map((row) => row.id);
  }

  list(connectionId = null, limit = 200) {
    const rows = connectionId
      ? this.db.prepare(`SELECT * FROM checkin_records WHERE connection_id = ? ORDER BY checked_at DESC LIMIT ?`).all(connectionId, limit)
      : this.db.prepare(`SELECT * FROM checkin_records ORDER BY checked_at DESC LIMIT ?`).all(limit);
    return rows.map((row) => ({ ...row, manualActionRequired: Boolean(row.manual_action_required), details: parseJson(row.details_json, {}), details_json: undefined, manual_action_required: undefined }));
  }
}

module.exports = { CheckInService };
