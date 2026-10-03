const crypto = require('crypto');
const { AppError } = require('../errors');
const { nowIso, parseJson, stringifyJson } = require('../db');

const EVENT_FINGERPRINT_PREFIX = 'sub2api-business-ttft:';
const ACTIVE_PROBE_EVENT_FINGERPRINT_PREFIX = 'sub2api-active-probe-ttft:';
const SAMPLE_SOURCE = 'business_usage';
const ACTIVE_PROBE_SAMPLE_SOURCE = 'active_probe';

function integerInRange(value, name, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new AppError(
      'VALIDATION_ERROR',
      `${name}必须是 ${minimum} 到 ${maximum} 之间的整数`,
      { status: 400 }
    );
  }
  return number;
}

function normalizeChannelIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((id) => String(id || '').trim()).filter(Boolean))];
}

function milliseconds(value) {
  const number = Math.round(Number(value));
  return number >= 1000 ? `${(number / 1000).toFixed(2)} 秒` : `${number} 毫秒`;
}

function sampleFingerprint(metric) {
  const sourceLogId = String(metric.last_request_source_log_id || '');
  const createdAt = String(metric.last_request_at || '');
  if (!sourceLogId && !createdAt) return null;
  return crypto.createHash('sha256').update(`${createdAt}\0${sourceLogId}`).digest('hex');
}

function hasNewRequestSinceNotification(metric, existingDetails) {
  const currentFingerprint = sampleFingerprint(metric);
  const notifiedFingerprint = existingDetails.lastNotifiedSampleFingerprint || null;
  if (currentFingerprint && notifiedFingerprint) {
    return currentFingerprint !== notifiedFingerprint;
  }
  const currentAt = Date.parse(metric.last_request_at);
  const notifiedAt = Date.parse(
    existingDetails.lastNotifiedRequestAt || existingDetails.lastRequestAt
  );
  return Number.isFinite(currentAt) && (!Number.isFinite(notifiedAt) || currentAt > notifiedAt);
}

class KeyTtftAlertService {
  constructor({ db, notifications }) {
    this.db = db;
    this.notifications = notifications;
  }

  settings() {
    const row = this.db.prepare(
      'SELECT * FROM sub2api_key_ttft_alert_settings WHERE id = 1'
    ).get();
    return {
      enabled: Boolean(row.enabled),
      windowMinutes: row.window_minutes,
      sampleCount: row.sample_count,
      thresholdMs: row.threshold_ms,
      activeProbeEnabled: Boolean(row.active_probe_enabled),
      activeProbeConsecutiveCount: row.active_probe_consecutive_count,
      activeProbeThresholdMs: row.active_probe_threshold_ms,
      cooldownMinutes: row.cooldown_minutes,
      channelIds: normalizeChannelIds(parseJson(row.channel_ids_json, [])),
      sampleSource: SAMPLE_SOURCE,
      activeProbeSampleSource: ACTIVE_PROBE_SAMPLE_SOURCE,
      updatedAt: row.updated_at
    };
  }

  saveSettings(input = {}) {
    const current = this.settings();
    const next = {
      enabled: input.enabled ?? current.enabled,
      windowMinutes: input.windowMinutes ?? current.windowMinutes,
      sampleCount: input.sampleCount ?? current.sampleCount,
      thresholdMs: input.thresholdMs ?? current.thresholdMs,
      activeProbeEnabled: input.activeProbeEnabled ?? current.activeProbeEnabled,
      activeProbeConsecutiveCount: input.activeProbeConsecutiveCount ?? current.activeProbeConsecutiveCount,
      activeProbeThresholdMs: input.activeProbeThresholdMs ?? current.activeProbeThresholdMs,
      cooldownMinutes: input.cooldownMinutes ?? current.cooldownMinutes,
      channelIds: input.channelIds === undefined
        ? current.channelIds
        : normalizeChannelIds(input.channelIds)
    };
    next.windowMinutes = integerInRange(next.windowMinutes, '监控窗口', 1, 1440);
    next.sampleCount = integerInRange(next.sampleCount, '采样记录条数', 1, 1000);
    next.thresholdMs = integerInRange(next.thresholdMs, '平均首字阈值', 100, 600000);
    next.activeProbeConsecutiveCount = integerInRange(
      next.activeProbeConsecutiveCount,
      '主动检测连续超阈值次数',
      1,
      100
    );
    next.activeProbeThresholdMs = integerInRange(
      next.activeProbeThresholdMs,
      '主动检测首字阈值',
      100,
      600000
    );
    next.cooldownMinutes = integerInRange(next.cooldownMinutes, '提醒冷却时间', 1, 10080);
    if (next.enabled && next.channelIds.length === 0) {
      throw new AppError('VALIDATION_ERROR', '启用自动提醒前请至少选择一个通知渠道', {
        status: 400
      });
    }
    if (next.channelIds.length > 0) {
      const placeholders = next.channelIds.map(() => '?').join(', ');
      const existing = new Set(this.db.prepare(`
        SELECT id FROM notification_channels WHERE enabled = 1 AND id IN (${placeholders})
      `).all(...next.channelIds).map((row) => String(row.id)));
      const missing = next.channelIds.filter((id) => !existing.has(id));
      if (missing.length > 0) {
        throw new AppError('VALIDATION_ERROR', '所选通知渠道不存在、已停用或已删除', { status: 400 });
      }
    }
    this.db.prepare(`
      UPDATE sub2api_key_ttft_alert_settings SET
        enabled = ?, window_minutes = ?, sample_count = ?, threshold_ms = ?,
        active_probe_enabled = ?, active_probe_consecutive_count = ?,
        active_probe_threshold_ms = ?, cooldown_minutes = ?, channel_ids_json = ?,
        updated_at = ?
      WHERE id = 1
    `).run(
      next.enabled ? 1 : 0,
      next.windowMinutes,
      next.sampleCount,
      next.thresholdMs,
      next.activeProbeEnabled ? 1 : 0,
      next.activeProbeConsecutiveCount,
      next.activeProbeThresholdMs,
      next.cooldownMinutes,
      stringifyJson(next.channelIds, []),
      nowIso()
    );
    if (!next.enabled) {
      const resolvedAt = nowIso();
      this.#resolveAll(resolvedAt, new Set(), EVENT_FINGERPRINT_PREFIX);
      this.#resolveAll(resolvedAt, new Set(), ACTIVE_PROBE_EVENT_FINGERPRINT_PREFIX);
    } else if (!next.activeProbeEnabled) {
      this.#resolveAll(nowIso(), new Set(), ACTIVE_PROBE_EVENT_FINGERPRINT_PREFIX);
    }
    return this.settings();
  }

  #businessMetrics(settings, windowStart, evaluatedAt) {
    return this.db.prepare(`
      WITH ranked AS (
        SELECT sample.account_id, sample.first_token_ms, sample.created_at,
          sample.source_log_id,
          ROW_NUMBER() OVER (
            PARTITION BY sample.account_id
            ORDER BY sample.created_at DESC, sample.source_log_id DESC
          ) AS row_number
        FROM sub2api_account_request_samples sample
        JOIN sub2api_monitored_accounts account
          ON account.account_id = sample.account_id
        WHERE sample.sample_source = '${SAMPLE_SOURCE}'
          AND sample.stream = 1
          AND sample.first_token_ms > 0
          AND sample.created_at >= ?
          AND sample.created_at <= ?
          AND account.missing_since IS NULL
      )
      SELECT ranked.account_id, account.name AS account_name,
        account.platform, account.status AS account_status,
        COUNT(*) AS sample_count,
        AVG(ranked.first_token_ms) AS avg_first_token_ms,
        MIN(ranked.first_token_ms) AS min_first_token_ms,
        MAX(ranked.first_token_ms) AS max_first_token_ms,
        MAX(CASE WHEN ranked.row_number = 1 THEN ranked.created_at END) AS last_request_at,
        MAX(CASE WHEN ranked.row_number = 1 THEN ranked.source_log_id END)
          AS last_request_source_log_id
      FROM ranked
      JOIN sub2api_monitored_accounts account
        ON account.account_id = ranked.account_id
      WHERE ranked.row_number <= ?
      GROUP BY ranked.account_id, account.name, account.platform, account.status
      HAVING COUNT(*) >= ?
      ORDER BY avg_first_token_ms DESC, ranked.account_id
    `).all(windowStart, evaluatedAt, settings.sampleCount, settings.sampleCount);
  }

  #activeProbeMetrics(settings, evaluatedAt) {
    return this.db.prepare(`
      WITH ranked AS (
        SELECT batch.account_id, sample.id AS source_log_id, sample.status,
          sample.first_token_ms, sample.completed_at AS created_at,
          ROW_NUMBER() OVER (
            PARTITION BY batch.account_id
            ORDER BY sample.completed_at DESC, batch.completed_at DESC,
              sample.sample_index DESC, sample.id DESC
          ) AS row_number
        FROM sub2api_key_probe_samples sample
        JOIN sub2api_key_probe_batches batch ON batch.id = sample.batch_id
        JOIN sub2api_monitored_accounts account ON account.account_id = batch.account_id
        WHERE sample.completed_at <= ? AND account.missing_since IS NULL
      ), recent AS (
        SELECT * FROM ranked WHERE row_number <= ?
      )
      SELECT recent.account_id, account.name AS account_name,
        account.platform, account.status AS account_status,
        COUNT(*) AS sample_count,
        SUM(CASE WHEN recent.status = 'succeeded' AND recent.first_token_ms > ?
          THEN 1 ELSE 0 END) AS slow_sample_count,
        AVG(recent.first_token_ms) AS avg_first_token_ms,
        MIN(recent.first_token_ms) AS min_first_token_ms,
        MAX(recent.first_token_ms) AS max_first_token_ms,
        MAX(CASE WHEN recent.row_number = 1 THEN recent.first_token_ms END)
          AS latest_first_token_ms,
        MAX(CASE WHEN recent.row_number = 1 THEN recent.created_at END) AS last_request_at,
        MAX(CASE WHEN recent.row_number = 1 THEN recent.source_log_id END)
          AS last_request_source_log_id
      FROM recent
      JOIN sub2api_monitored_accounts account ON account.account_id = recent.account_id
      GROUP BY recent.account_id, account.name, account.platform, account.status
      HAVING COUNT(*) >= ?
      ORDER BY avg_first_token_ms DESC, recent.account_id
    `).all(
      evaluatedAt,
      settings.activeProbeConsecutiveCount,
      settings.activeProbeThresholdMs,
      settings.activeProbeConsecutiveCount
    );
  }

  #eventFingerprint(accountId, prefix = EVENT_FINGERPRINT_PREFIX) {
    return `${prefix}${accountId}`;
  }

  #resolveAll(resolvedAt, matchedAccountIds = new Set(), prefix = EVENT_FINGERPRINT_PREFIX) {
    const active = this.db.prepare(`
      SELECT id, subject_id FROM alert_events
      WHERE fingerprint LIKE ? AND status != 'resolved'
    `).all(`${prefix}%`);
    const resolve = this.db.prepare(`
      UPDATE alert_events SET status = 'resolved', resolved_at = ? WHERE id = ?
    `);
    let count = 0;
    this.db.transaction(() => {
      for (const event of active) {
        if (matchedAccountIds.has(String(event.subject_id))) continue;
        count += resolve.run(resolvedAt, event.id).changes;
      }
    })();
    return count;
  }

  async #applyMetric(metric, settings, evaluatedAt, alert) {
    const accountId = String(metric.account_id);
    const fingerprint = this.#eventFingerprint(accountId, alert.fingerprintPrefix);
    const existing = this.db.prepare(
      'SELECT * FROM alert_events WHERE fingerprint = ?'
    ).get(fingerprint);
    const existingDetails = parseJson(existing?.details_json, {});
    const cooldownElapsed = existing?.status === 'active' &&
      Date.parse(evaluatedAt) - Date.parse(existing.triggered_at) >=
        settings.cooldownMinutes * 60000;
    const hasNewRequest = !existing || existing.status === 'resolved' ||
      hasNewRequestSinceNotification(metric, existingDetails);
    const shouldNotify = !existing || existing.status === 'resolved' ||
      (cooldownElapsed && hasNewRequest);
    const eventId = existing?.id || crypto.randomUUID();
    const currentSampleFingerprint = sampleFingerprint(metric);
    const lastNotifiedRequestAt = shouldNotify
      ? metric.last_request_at
      : existingDetails.lastNotifiedRequestAt || existingDetails.lastRequestAt || null;
    const lastNotifiedSampleFingerprint = shouldNotify
      ? currentSampleFingerprint
      : existingDetails.lastNotifiedSampleFingerprint || null;
    const details = {
      ...alert.details,
      lastRequestAt: metric.last_request_at,
      lastNotifiedRequestAt,
      lastNotifiedSampleFingerprint
    };
    const status = existing?.status === 'acknowledged' ? 'acknowledged' : 'active';
    const triggeredAt = shouldNotify ? evaluatedAt : existing.triggered_at;
    if (existing) {
      this.db.prepare(`
        UPDATE alert_events SET status = ?, severity = 'warning', message = ?,
          details_json = ?, triggered_at = ?, resolved_at = NULL,
          acknowledged_at = ? WHERE id = ?
      `).run(
        status,
        alert.message,
        stringifyJson(details),
        triggeredAt,
        status === 'acknowledged' ? existing.acknowledged_at : null,
        eventId
      );
    } else {
      this.db.prepare(`
        INSERT INTO alert_events(
          id, rule_id, connection_id, subject_type, subject_id, status, severity,
          message, fingerprint, details_json, triggered_at
        ) VALUES (?, NULL, NULL, 'sub2api_key', ?, 'active', 'warning', ?, ?, ?, ?)
      `).run(
        eventId,
        accountId,
        alert.message,
        fingerprint,
        stringifyJson(details),
        triggeredAt
      );
    }
    const event = {
      id: eventId,
      status,
      severity: 'warning',
      title: alert.title,
      message: alert.message,
      triggered_at: triggeredAt,
      details
    };
    if (shouldNotify) {
      await this.notifications.dispatch(event, { channelIds: settings.channelIds });
    }
    return {
      event,
      notified: shouldNotify,
      renotified: Boolean(existing && existing.status !== 'resolved' && shouldNotify)
    };
  }

  async #applyBusinessMetric(metric, settings, evaluatedAt, windowStart) {
    const accountId = String(metric.account_id);
    const averageMs = Math.round(Number(metric.avg_first_token_ms));
    const message = `Key“${metric.account_name}”（#${accountId}）最近 ${settings.windowMinutes} 分钟的 ` +
      `${metric.sample_count} 条真实业务流式请求平均首字为 ${milliseconds(averageMs)}，` +
      `超过阈值 ${milliseconds(settings.thresholdMs)}。`;
    return this.#applyMetric(metric, settings, evaluatedAt, {
      fingerprintPrefix: EVENT_FINGERPRINT_PREFIX,
      title: 'Key 业务首字延迟提醒',
      message,
      details: {
        alertType: 'key_ttft_high',
        sampleSource: SAMPLE_SOURCE,
        sourceTable: 'sub2api_account_request_samples',
        accountId,
        accountName: metric.account_name,
        platform: metric.platform,
        accountStatus: metric.account_status,
        windowMinutes: settings.windowMinutes,
        windowStart,
        windowEnd: evaluatedAt,
        sampleCount: metric.sample_count,
        configuredSampleCount: settings.sampleCount,
        averageFirstTokenMs: averageMs,
        minimumFirstTokenMs: metric.min_first_token_ms,
        maximumFirstTokenMs: metric.max_first_token_ms,
        thresholdMs: settings.thresholdMs
      }
    });
  }

  async #applyActiveProbeMetric(metric, settings, evaluatedAt) {
    const accountId = String(metric.account_id);
    const averageMs = Math.round(Number(metric.avg_first_token_ms));
    const message = `Key“${metric.account_name}”（#${accountId}）最近 ` +
      `${settings.activeProbeConsecutiveCount} 次主动检测请求的首字均超过阈值 ` +
      `${milliseconds(settings.activeProbeThresholdMs)}，平均首字为 ${milliseconds(averageMs)}。`;
    return this.#applyMetric(metric, settings, evaluatedAt, {
      fingerprintPrefix: ACTIVE_PROBE_EVENT_FINGERPRINT_PREFIX,
      title: 'Key 主动检测首字延迟提醒',
      message,
      details: {
        alertType: 'key_active_probe_ttft_high',
        sampleSource: ACTIVE_PROBE_SAMPLE_SOURCE,
        sourceTable: 'sub2api_key_probe_samples',
        accountId,
        accountName: metric.account_name,
        platform: metric.platform,
        accountStatus: metric.account_status,
        windowEnd: evaluatedAt,
        sampleCount: metric.sample_count,
        consecutiveCount: metric.slow_sample_count,
        configuredConsecutiveCount: settings.activeProbeConsecutiveCount,
        averageFirstTokenMs: averageMs,
        minimumFirstTokenMs: metric.min_first_token_ms,
        maximumFirstTokenMs: metric.max_first_token_ms,
        latestFirstTokenMs: metric.latest_first_token_ms,
        thresholdMs: settings.activeProbeThresholdMs
      }
    });
  }

  async evaluate(options = {}) {
    const settings = this.settings();
    const timestamp = Number.isFinite(options.at) ? options.at : Date.now();
    const evaluatedAt = new Date(timestamp).toISOString();
    const windowStart = new Date(timestamp - settings.windowMinutes * 60000).toISOString();
    if (!settings.enabled) {
      const businessResolved = this.#resolveAll(
        evaluatedAt,
        new Set(),
        EVENT_FINGERPRINT_PREFIX
      );
      const activeProbeResolved = this.#resolveAll(
        evaluatedAt,
        new Set(),
        ACTIVE_PROBE_EVENT_FINGERPRINT_PREFIX
      );
      return {
        enabled: false,
        evaluatedAt,
        windowStart,
        evaluatedKeys: 0,
        matchedKeys: 0,
        notified: 0,
        renotified: 0,
        resolved: businessResolved + activeProbeResolved,
        events: [],
        business: {
          enabled: false, evaluatedKeys: 0, matchedKeys: 0,
          notified: 0, renotified: 0, resolved: businessResolved, events: []
        },
        activeProbe: {
          enabled: false, evaluatedKeys: 0, matchedKeys: 0,
          notified: 0, renotified: 0, resolved: activeProbeResolved, events: []
        }
      };
    }

    const businessMetrics = this.#businessMetrics(settings, windowStart, evaluatedAt);
    const matchedBusiness = businessMetrics.filter(
      (metric) => Number(metric.avg_first_token_ms) > settings.thresholdMs
    );
    const matchedBusinessAccountIds = new Set(
      matchedBusiness.map((metric) => String(metric.account_id))
    );
    const businessResults = [];
    for (const metric of matchedBusiness) {
      businessResults.push(
        await this.#applyBusinessMetric(metric, settings, evaluatedAt, windowStart)
      );
    }
    const businessResolved = this.#resolveAll(
      evaluatedAt,
      matchedBusinessAccountIds,
      EVENT_FINGERPRINT_PREFIX
    );

    const activeProbeMetrics = settings.activeProbeEnabled
      ? this.#activeProbeMetrics(settings, evaluatedAt)
      : [];
    const matchedActiveProbe = activeProbeMetrics.filter(
      (metric) => Number(metric.slow_sample_count) === settings.activeProbeConsecutiveCount
    );
    const matchedActiveProbeAccountIds = new Set(
      matchedActiveProbe.map((metric) => String(metric.account_id))
    );
    const activeProbeResults = [];
    for (const metric of matchedActiveProbe) {
      activeProbeResults.push(
        await this.#applyActiveProbeMetric(metric, settings, evaluatedAt)
      );
    }
    const activeProbeResolved = this.#resolveAll(
      evaluatedAt,
      matchedActiveProbeAccountIds,
      ACTIVE_PROBE_EVENT_FINGERPRINT_PREFIX
    );

    const business = {
      enabled: true,
      evaluatedKeys: businessMetrics.length,
      matchedKeys: matchedBusiness.length,
      notified: businessResults.filter((result) => result.notified).length,
      renotified: businessResults.filter((result) => result.renotified).length,
      resolved: businessResolved,
      events: businessResults.map((result) => result.event)
    };
    const activeProbe = {
      enabled: settings.activeProbeEnabled,
      evaluatedKeys: activeProbeMetrics.length,
      matchedKeys: matchedActiveProbe.length,
      notified: activeProbeResults.filter((result) => result.notified).length,
      renotified: activeProbeResults.filter((result) => result.renotified).length,
      resolved: activeProbeResolved,
      events: activeProbeResults.map((result) => result.event)
    };
    return {
      enabled: true,
      evaluatedAt,
      windowStart,
      evaluatedKeys: business.evaluatedKeys + activeProbe.evaluatedKeys,
      matchedKeys: business.matchedKeys + activeProbe.matchedKeys,
      notified: business.notified + activeProbe.notified,
      renotified: business.renotified + activeProbe.renotified,
      resolved: business.resolved + activeProbe.resolved,
      events: [...business.events, ...activeProbe.events],
      business,
      activeProbe
    };
  }
}

module.exports = {
  ACTIVE_PROBE_EVENT_FINGERPRINT_PREFIX,
  ACTIVE_PROBE_SAMPLE_SOURCE,
  EVENT_FINGERPRINT_PREFIX,
  KeyTtftAlertService,
  SAMPLE_SOURCE
};
