const crypto = require('crypto');
const { AppError, asAppError } = require('../errors');
const { joinUrl } = require('../adapters/base');
const { redactText } = require('../security/redaction');
const { nowIso, parseJson, stringifyJson } = require('../db');

class KeyHealthService {
  constructor({ db, config, providers, http }) {
    this.db = db;
    this.config = config;
    this.providers = providers;
    this.http = http;
  }

  async check(keyId, level = 'metadata') {
    const key = this.db.prepare(`
      SELECT k.*, p.adapter_type, p.base_url, p.type_config_json
      FROM remote_keys k JOIN provider_connections p ON p.id = k.connection_id
      WHERE k.id = ?
    `).get(keyId);
    if (!key) throw new AppError('KEY_NOT_FOUND', 'Remote key was not found', { status: 404 });
    const started = Date.now();
    let status = 'passed';
    let errorCode = null;
    let errorMessage = null;
    let modelCount = null;
    let details = {};
    try {
      details.metadata = this.#metadataAssessment(key);
      if (details.metadata.failures.length > 0) status = 'failed';
      if (level === 'models' || level === 'paid' || level === 'capabilities') {
        if (status === 'failed') throw new AppError('KEY_METADATA_FAILED', details.metadata.failures.join(', '), { status: 409 });
        const result = await this.#modelProbe(key);
        modelCount = result.modelCount;
        details.models = result.details;
      }
      if (level === 'paid' || level === 'capabilities') {
        details.paid = await this.#paidProbe(key);
      }
      if (level === 'capabilities') {
        details.capabilities = await this.#capabilityProbes(key);
        const failed = details.capabilities.filter((probe) => probe.status === 'failed');
        if (failed.length > 0) {
          throw new AppError(
            'KEY_CAPABILITY_FAILED',
            `Capability probes failed: ${failed.map((probe) => probe.name || 'unnamed').join(', ')}`,
            { status: 502 }
          );
        }
      }
    } catch (error) {
      const appError = asAppError(error, 'KEY_HEALTH_FAILED');
      status = 'failed';
      errorCode = appError.code;
      errorMessage = redactText(appError.message);
    }
    const result = {
      id: crypto.randomUUID(),
      connectionId: key.connection_id,
      keyId,
      level,
      status,
      latencyMs: Date.now() - started,
      modelCount,
      errorCode,
      errorMessage,
      details,
      checkedAt: nowIso()
    };
    this.db.prepare(`
      INSERT INTO key_health_checks(
        id, connection_id, key_id, level, status, latency_ms, model_count,
        error_code, error_message, details_json, checked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(result.id, result.connectionId, keyId, level, status, result.latencyMs, modelCount, errorCode, errorMessage, stringifyJson(details), result.checkedAt);
    return result;
  }

  async checkConnection(connectionId, level = 'metadata') {
    this.providers.get(connectionId);
    const keys = this.db.prepare(`
      SELECT id FROM remote_keys WHERE connection_id = ? AND status != 'missing'
      ORDER BY name LIMIT 1000
    `).all(connectionId);
    const pending = [...keys];
    const results = [];
    const concurrency = Math.min(
      pending.length,
      Math.max(1, Number(this.config.keyHealthConcurrency || 3))
    );
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (pending.length > 0) {
        const key = pending.shift();
        if (key) results.push(await this.check(key.id, level));
      }
    }));
    return {
      connectionId,
      level,
      checked: results.length,
      passed: results.filter((result) => result.status === 'passed').length,
      failed: results.filter((result) => result.status === 'failed').length,
      results
    };
  }

  #metadataAssessment(key) {
    const failures = [];
    const warnings = [];
    if (['disabled', 'expired', 'exhausted', 'missing'].includes(key.status)) failures.push(`status:${key.status}`);
    if (key.expires_at && Date.parse(key.expires_at) <= Date.now()) failures.push('expired');
    if (!key.unlimited && key.quota_remaining != null && Number(key.quota_remaining) <= 0) failures.push('quota_exhausted');
    if (key.expires_at && Date.parse(key.expires_at) > Date.now() && Date.parse(key.expires_at) <= Date.now() + 7 * 86400000) warnings.push('expires_within_7_days');
    if (key.primary_group_ref && key.backup_group_ref && key.primary_group_ref === key.backup_group_ref) warnings.push('primary_backup_group_equal');
    return { failures, warnings, status: key.status, expiresAt: key.expires_at, quotaRemaining: key.quota_remaining };
  }

  #runtimeCredential(key) {
    const credentials = this.providers.getCredentials(key.connection_id);
    if (credentials.runtimeApiKey) return credentials.runtimeApiKey;
    if (credentials.modelApiKey) return credentials.modelApiKey;
    if (['deepseek', 'openrouter'].includes(key.adapter_type)) return credentials.apiKey || credentials.managementKey;
    return null;
  }

  async #modelProbe(key) {
    const token = this.#runtimeCredential(key);
    if (!token) {
      throw new AppError('RUNTIME_KEY_REQUIRED', 'A runtimeApiKey credential is required for model probing', { status: 409 });
    }
    const typeConfig = parseJson(key.type_config_json, {});
    const defaultPath = key.adapter_type === 'openrouter' ? '/api/v1/models' : '/v1/models';
    const response = await this.http.requestJson(joinUrl(key.base_url, typeConfig.modelProbePath || defaultPath), {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      retries: 0
    });
    const models = Array.isArray(response.data?.data)
      ? response.data.data
      : Array.isArray(response.data?.models)
        ? response.data.models
        : Array.isArray(response.data)
          ? response.data
          : [];
    if (models.length === 0) throw new AppError('MODEL_LIST_EMPTY', 'Model probe returned no models', { status: 502 });
    return { modelCount: models.length, details: { path: typeConfig.modelProbePath || defaultPath, modelIds: models.slice(0, 100).map((model) => model.id || model.name || model) } };
  }

  async #paidProbe(key) {
    const typeConfig = parseJson(key.type_config_json, {});
    const probe = typeConfig.paidProbe || {};
    if (!probe.enabled) throw new AppError('PAID_PROBE_DISABLED', 'Paid key probing is disabled for this provider', { status: 409 });
    const estimatedCost = Number(probe.estimatedCost || 0);
    const dailyBudget = Number(probe.dailyBudget || 0);
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    const spent = this.db.prepare(`
      SELECT COALESCE(SUM(CAST(json_extract(details_json, '$.paid.estimatedCost') AS REAL)), 0) total
      FROM key_health_checks WHERE connection_id = ? AND checked_at >= ?
    `).get(key.connection_id, since.toISOString()).total;
    if (dailyBudget <= 0 || Number(spent) + estimatedCost > dailyBudget) {
      throw new AppError('PAID_PROBE_BUDGET_EXCEEDED', 'Paid probe daily budget would be exceeded', { status: 409 });
    }
    const token = this.#runtimeCredential(key);
    if (!token) throw new AppError('RUNTIME_KEY_REQUIRED', 'A runtimeApiKey credential is required for paid probing', { status: 409 });
    const endpoint = probe.path || '/v1/chat/completions';
    const body = probe.body || { model: probe.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false };
    if (!body.model) throw new AppError('PAID_PROBE_MODEL_REQUIRED', 'Paid probe model is required', { status: 400 });
    const response = await this.http.requestJson(joinUrl(key.base_url, endpoint), {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body, retries: 0
    });
    return { endpoint, model: body.model, estimatedCost, responseId: response.data?.id || null };
  }

  async #capabilityProbes(key) {
    const typeConfig = parseJson(key.type_config_json, {});
    const probes = Array.isArray(typeConfig.capabilityProbes) ? typeConfig.capabilityProbes : [];
    if (probes.length === 0) return [];
    const token = this.#runtimeCredential(key);
    if (!token) throw new AppError('RUNTIME_KEY_REQUIRED', 'A runtimeApiKey credential is required for capability probing', { status: 409 });
    const results = [];
    for (const probe of probes.slice(0, 10)) {
      try {
        await this.http.requestJson(joinUrl(key.base_url, probe.path || '/v1/chat/completions'), {
          method: probe.method || 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: probe.body, retries: 0
        });
        results.push({ name: probe.name, status: 'passed' });
      } catch (error) {
        results.push({ name: probe.name, status: 'failed', error: error.code || error.message });
      }
    }
    return results;
  }

  list({ connectionId, keyId, limit = 200 } = {}) {
    const clauses = [];
    const params = [];
    if (connectionId) { clauses.push('h.connection_id = ?'); params.push(connectionId); }
    if (keyId) { clauses.push('h.key_id = ?'); params.push(keyId); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(Math.min(500, Math.max(1, Number(limit) || 200)));
    return this.db.prepare(`
      SELECT h.*, k.name AS key_name, p.name AS provider_name
      FROM key_health_checks h JOIN remote_keys k ON k.id = h.key_id
      JOIN provider_connections p ON p.id = h.connection_id
      ${where} ORDER BY h.checked_at DESC LIMIT ?
    `).all(...params).map((row) => ({ ...row, details: parseJson(row.details_json, {}), details_json: undefined }));
  }
}

module.exports = { KeyHealthService };
