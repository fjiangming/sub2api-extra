'use strict';

const crypto = require('crypto');
const { z } = require('zod');
const { AppError } = require('./errors');
const { readBoundedResponse } = require('./notification-service');
const { minorToDecimal, openText, parseMoneyToMinor, sealText } = require('./security');

const SETTINGS_KEY = 'large_recharge_bark_settings_v1';
const SETTINGS_NAMESPACE = 'large-recharge-bark-settings:v1';
const BARK_ENDPOINT = 'https://api.day.app/push';
const DEFAULT_THRESHOLD_MINOR = 100000;
const BARK_LEVEL = 'timeSensitive';
const BARK_GROUP = 'Sub2API 充值中心';
const MAX_ATTEMPTS = 3;
const EMAIL_SCHEMA = z.string().email().max(320).refine(value =>
  !/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(value));

function validateDeviceKey(value) {
  const key = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{6,256}$/.test(key)) {
    throw new AppError('LARGE_RECHARGE_BARK_CONFIG_INVALID', 'Bark Device Key 只能包含 6 至 256 位字母、数字、下划线或连字符', { status: 400 });
  }
  return key;
}

class LargeRechargeAlertService {
  constructor({ db, config, fetch = globalThis.fetch, clock = () => new Date() }) {
    this.db = db;
    this.config = config;
    this.fetch = fetch;
    this.clock = clock;
    this.timer = null;
    this.running = null;
    this.closed = false;
    this.controllers = new Set();
  }

  #readSettings() {
    const row = this.db.prepare('SELECT value FROM service_metadata WHERE key = ?').get(SETTINGS_KEY);
    if (!row) return { enabled: false, thresholdMinor: DEFAULT_THRESHOLD_MINOR, deviceKey: null };
    try {
      const settings = JSON.parse(openText(this.config.secret, SETTINGS_NAMESPACE, row.value, SETTINGS_KEY));
      if (typeof settings.enabled !== 'boolean' || !Number.isSafeInteger(settings.thresholdMinor) ||
          settings.thresholdMinor < 1 || settings.thresholdMinor > 100000000 ||
          (settings.enabled && !settings.deviceKey)) throw new Error('invalid settings');
      return { enabled: settings.enabled, thresholdMinor: settings.thresholdMinor,
        deviceKey: settings.deviceKey ? validateDeviceKey(settings.deviceKey) : null };
    } catch {
      throw new AppError('LARGE_RECHARGE_BARK_SETTINGS_INVALID', '大额充值提醒配置无法解密或校验', { status: 500 });
    }
  }

  settings() {
    const settings = this.#readSettings();
    const lastDelivery = this.db.prepare(`
      SELECT status, attempts, last_error, created_at, sent_at FROM large_recharge_alerts
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get();
    return { enabled: settings.enabled, threshold: minorToDecimal(settings.thresholdMinor),
      bark: { endpoint: BARK_ENDPOINT, configured: Boolean(settings.deviceKey),
        deviceKeyMasked: settings.deviceKey ? '****' : null, level: BARK_LEVEL, group: BARK_GROUP },
      lastDelivery: lastDelivery ? { status: lastDelivery.status, attempts: lastDelivery.attempts,
        errorCode: lastDelivery.last_error, createdAt: lastDelivery.created_at, sentAt: lastDelivery.sent_at } : null };
  }

  save(input, actor, request = {}) {
    const current = this.#readSettings();
    const thresholdMinor = parseMoneyToMinor(input.threshold);
    if (typeof input.enabled !== 'boolean' || thresholdMinor < 1 || thresholdMinor > 100000000) {
      throw new AppError('LARGE_RECHARGE_BARK_CONFIG_INVALID', '金额阈值必须为 0.01 至 1000000.00 元', { status: 400 });
    }
    const suppliedKey = input.deviceKey?.trim() ? validateDeviceKey(input.deviceKey) : null;
    const deviceKey = input.clearDeviceKey ? null : suppliedKey || current.deviceKey;
    const isolated = [this.config.secret, this.config.sub2apiAdminApiKey, this.config.listenerSecret,
      this.config.qrProvisionerSecret, this.config.smtpPassword, this.config.alertWebhookBearerToken].filter(Boolean);
    if (deviceKey && isolated.includes(deviceKey)) {
      throw new AppError('LARGE_RECHARGE_BARK_CONFIG_INVALID', 'Bark Device Key 必须使用独立凭据', { status: 400 });
    }
    if ((input.enabled && !deviceKey) || (input.clearDeviceKey && suppliedKey)) {
      throw new AppError('LARGE_RECHARGE_BARK_CONFIG_INVALID', '请填写 Bark Device Key；清除密钥前需关闭提醒', { status: 400 });
    }
    const next = { enabled: input.enabled, thresholdMinor, deviceKey };
    const now = this.clock().toISOString();
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO service_metadata(key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(SETTINGS_KEY, sealText(this.config.secret, SETTINGS_NAMESPACE, JSON.stringify(next), SETTINGS_KEY), now);
      if (!next.enabled) this.db.prepare(`
        UPDATE large_recharge_alerts SET status = 'failed', last_error = 'ALERT_DISABLED', updated_at = ?
        WHERE status = 'pending'
      `).run(now);
      this.#audit(null, 'admin', String(actor.id), 'LARGE_RECHARGE_ALERT_SETTINGS_UPDATED', {
        enabled: next.enabled, threshold: minorToDecimal(thresholdMinor), barkConfigured: Boolean(deviceKey)
      }, request.requestId);
    })();
    return this.settings();
  }

  async test(actor, request = {}) {
    const settings = this.#readSettings();
    if (!settings.deviceKey) {
      throw new AppError('LARGE_RECHARGE_BARK_NOT_CONFIGURED', '请先保存 Bark Device Key', { status: 400 });
    }
    await this.#send(settings, { title: '充值中心 Bark 测试', body: '充值中心大额充值提醒测试成功。' });
    this.#audit(null, 'admin', String(actor.id), 'LARGE_RECHARGE_ALERT_TEST_SENT', {}, request.requestId);
    return { sent: true };
  }

  enqueueCompleted(order) {
    if (order?.status !== 'completed') return false;
    const settings = this.#readSettings();
    if (!settings.enabled || order.payable_amount_minor <= settings.thresholdMinor) return false;
    const now = this.clock().toISOString();
    const inserted = this.db.prepare(`
      INSERT INTO large_recharge_alerts(
        id, order_id, amount_minor, threshold_minor, status, attempts, next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?) ON CONFLICT(order_id) DO NOTHING
    `).run(crypto.randomUUID(), order.id, order.payable_amount_minor, settings.thresholdMinor, now, now, now);
    if (inserted.changes) this.#audit(order.id, 'system', 'bark', 'LARGE_RECHARGE_ALERT_QUEUED', {
      amount: minorToDecimal(order.payable_amount_minor), threshold: minorToDecimal(settings.thresholdMinor)
    });
    return inserted.changes === 1;
  }

  start() {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => this.processPending().catch(() => {}), 5000);
    this.timer.unref?.();
    this.processPending().catch(() => {});
  }

  async processPending() {
    if (this.closed) return;
    if (this.running) return this.running;
    this.running = this.#process();
    try { return await this.running; } finally { this.running = null; }
  }

  async #process() {
    for (let count = 0; count < 10 && !this.closed; count += 1) {
      const settings = this.#readSettings();
      if (!settings.enabled) return;
      const job = this.#claim();
      if (!job) return;
      try {
        const order = this.db.prepare('SELECT * FROM recharge_orders WHERE id = ?').get(job.order_id);
        if (!order || order.status !== 'completed' || order.payable_amount_minor !== job.amount_minor) {
          throw new AppError('LARGE_RECHARGE_ORDER_INVALID', '大额提醒订单状态无法核验');
        }
        await this.#send(settings, this.#orderMessage(order, job));
        if (this.closed) return;
        const now = this.clock().toISOString();
        this.db.prepare(`
          UPDATE large_recharge_alerts SET status = 'sent', sent_at = ?, updated_at = ?,
            lease_until = NULL, last_error = NULL WHERE id = ? AND status = 'sending' AND attempts = ?
        `).run(now, now, job.id, job.attempts);
        this.#audit(order.id, 'system', 'bark', 'LARGE_RECHARGE_ALERT_SENT', { attempt: job.attempts });
      } catch (error) {
        if (this.closed) return;
        const retry = error.retryable === true && job.attempts < MAX_ATTEMPTS;
        const now = this.clock();
        this.db.prepare(`
          UPDATE large_recharge_alerts SET status = ?, next_attempt_at = ?, updated_at = ?,
            lease_until = NULL, last_error = ? WHERE id = ? AND status = 'sending' AND attempts = ?
        `).run(retry ? 'pending' : 'failed', new Date(now.getTime() + 15000 * job.attempts).toISOString(),
          now.toISOString(), error.code || 'LARGE_RECHARGE_BARK_FAILED', job.id, job.attempts);
        this.#audit(job.order_id, 'system', 'bark', 'LARGE_RECHARGE_ALERT_DELIVERY_FAILED', {
          code: error.code || 'LARGE_RECHARGE_BARK_FAILED', attempt: job.attempts, willRetry: retry
        });
      }
    }
  }

  #claim() {
    return this.db.transaction(() => {
      const now = this.clock();
      this.db.prepare(`
        UPDATE large_recharge_alerts SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END,
          lease_until = NULL, last_error = 'BARK_DELIVERY_INTERRUPTED', updated_at = ?
        WHERE status = 'sending' AND lease_until <= ?
      `).run(MAX_ATTEMPTS, now.toISOString(), now.toISOString());
      const job = this.db.prepare(`
        SELECT * FROM large_recharge_alerts WHERE status = 'pending' AND attempts < ? AND next_attempt_at <= ?
        ORDER BY created_at, id LIMIT 1
      `).get(MAX_ATTEMPTS, now.toISOString());
      if (!job) return null;
      const lease = new Date(now.getTime() + (this.config.alertTimeoutMs || 5000) + 30000).toISOString();
      this.db.prepare(`
        UPDATE large_recharge_alerts SET status = 'sending', attempts = attempts + 1, lease_until = ?, updated_at = ?
        WHERE id = ? AND status = 'pending'
      `).run(lease, now.toISOString(), job.id);
      return { ...job, attempts: job.attempts + 1 };
    }).immediate();
  }

  #orderMessage(order, job) {
    let email = '未记录完整邮箱';
    if (order.user_email_ciphertext) {
      try {
        const candidate = openText(this.config.secret, 'order-user-email:v1', order.user_email_ciphertext, order.id);
        if (EMAIL_SCHEMA.safeParse(candidate).success) email = candidate;
      } catch {}
    }
    const paidAt = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .format(new Date(order.alipay_paid_at || order.completed_at));
    return { title: '充值中心大额充值提醒', body: [
      `充值已完成: CNY ${minorToDecimal(job.amount_minor)}`,
      `超过阈值: CNY ${minorToDecimal(job.threshold_minor)}`,
      `订单号: ${order.order_no}`, `用户 ID: ${order.user_id}`,
      `下单账号: ${email}`, `付款时间（北京时间）: ${paidAt}`
    ].join('\n') };
  }

  async #send(settings, message) {
    if (this.closed) throw new AppError('LARGE_RECHARGE_ALERT_CLOSED', '通知服务已关闭');
    const controller = new AbortController();
    this.controllers.add(controller);
    let timeout;
    try {
      await Promise.race([
        (async () => {
          const response = await this.fetch(BARK_ENDPOINT, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ device_key: settings.deviceKey, title: message.title, body: message.body,
              group: BARK_GROUP, level: BARK_LEVEL }), redirect: 'error', signal: controller.signal
          });
          if (controller.signal.aborted) { await response.body?.cancel(); return; }
          const text = await readBoundedResponse(response);
          let result;
          try { result = JSON.parse(text); } catch { result = null; }
          if (!response.ok || Number(result?.code) !== 200) {
            const error = new AppError('LARGE_RECHARGE_BARK_FAILED', 'Bark 未确认提醒发送成功', { status: 502 });
            error.retryable = response.status === 429 || response.status >= 500 ||
              Number(result?.code) === 429 || Number(result?.code) >= 500;
            throw error;
          }
        })(),
        new Promise((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            const error = new AppError('LARGE_RECHARGE_BARK_TIMEOUT', 'Bark 提醒发送超时', { status: 504 });
            error.retryable = true;
            reject(error);
          }, this.config.alertTimeoutMs || 5000);
        })
      ]);
    } catch (error) {
      if (error instanceof AppError) throw error;
      const safe = new AppError('LARGE_RECHARGE_BARK_FAILED', '无法连接 Bark 通知服务', { status: 502 });
      safe.retryable = true;
      throw safe;
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(controller);
    }
  }

  #audit(orderId, actorType, actorId, type, metadata, requestId = null) {
    this.db.prepare(`
      INSERT INTO audit_events(occurred_at, order_id, actor_type, actor_id, event_type, request_id, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(this.clock().toISOString(), orderId, actorType, actorId, type, requestId, JSON.stringify(metadata));
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const controller of this.controllers) controller.abort();
  }
}

module.exports = { BARK_ENDPOINT, BARK_GROUP, BARK_LEVEL, LargeRechargeAlertService };
