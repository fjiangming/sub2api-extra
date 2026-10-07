'use strict';

const crypto = require('crypto');
const { AppError } = require('./errors');
const {
  hmacHex,
  minorToDecimal,
  openText,
  parseMoneyToMinor,
  safeEqual,
  sealText
} = require('./security');

const FAILURE_CODES = new Set([
  'login_required',
  'navigation_failed',
  'unexpected_page',
  'field_mismatch',
  'qr_not_generated',
  'adapter_unavailable',
  'other'
]);

function normalizeOpaqueAlipayQrUrl(value) {
  const raw = String(value || '').trim();
  if (raw.length < 20 || raw.length > 512 || /[\r\n\0]/.test(raw)) {
    throw new AppError('ALIPAY_QR_URL_INVALID', '支付宝收钱码地址格式无效', { status: 400 });
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError('ALIPAY_QR_URL_INVALID', '支付宝收钱码地址格式无效', { status: 400 });
  }
  if (url.protocol !== 'https:' || url.hostname !== 'qr.alipay.com' || url.port ||
      url.username || url.password || url.search || url.hash ||
      !/^\/fkx[A-Za-z0-9_-]{5,197}$/i.test(url.pathname)) {
    throw new AppError('ALIPAY_QR_URL_INVALID', '只接受 qr.alipay.com 的不透明 fkx 收钱码地址', { status: 400 });
  }
  return `https://qr.alipay.com${url.pathname}`;
}

class QrProvisioningService {
  constructor({ db, config, alerts = null, clock = () => new Date() }) {
    this.db = db;
    this.config = config;
    this.alerts = alerts;
    this.clock = clock;
    this.insertAudit = db.prepare(`
      INSERT INTO audit_events(
        occurred_at, order_id, actor_type, actor_id, event_type, request_id, ip_hash, metadata_json
      ) VALUES (?, ?, 'system', ?, ?, ?, ?, ?)
    `);
  }

  #now() {
    return this.clock();
  }

  #audit(orderId, eventType, request, metadata = {}) {
    const ipHash = request?.ip
      ? hmacHex(this.config.secret, 'audit-ip:v1', request.ip)
      : null;
    this.insertAudit.run(
      this.#now().toISOString(),
      orderId || null,
      this.config.listenerCollectorId || null,
      eventType,
      request?.requestId || null,
      ipHash,
      JSON.stringify(metadata)
    );
  }

  #assertEnabled() {
    if (!this.config.collectorQrProvisioning) {
      throw new AppError('QR_PROVISIONING_DISABLED', '逐单收钱码生成接口未启用', { status: 404 });
    }
  }

  #leaseHash(token) {
    return hmacHex(this.config.secret, 'qr-provision-lease:v1', token);
  }

  #assertLease(row, collectorId, leaseToken, now) {
    if (!row) throw new AppError('QR_JOB_NOT_FOUND', '收钱码生成任务不存在', { status: 404 });
    if (!safeEqual(row.collector_id, collectorId)) {
      throw new AppError('QR_JOB_COLLECTOR_MISMATCH', '收钱码任务不属于当前设备', { status: 403 });
    }
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(String(leaseToken || '')) ||
        !row.lease_hash || !safeEqual(row.lease_hash, this.#leaseHash(leaseToken))) {
      throw new AppError('QR_JOB_LEASE_INVALID', '收钱码任务租约无效', { status: 409 });
    }
    if (row.status !== 'leased' || !row.lease_expires_at || Date.parse(row.lease_expires_at) <= now.getTime()) {
      throw new AppError('QR_JOB_LEASE_EXPIRED', '收钱码任务租约已失效', { status: 409 });
    }
    if (row.order_status !== 'awaiting_payment' || Date.parse(row.expires_at) <= now.getTime()) {
      throw new AppError('ORDER_EXPIRED', '充值订单已失效', { status: 410 });
    }
  }

  #failLeased(row, code, request) {
    const now = this.#now().toISOString();
    this.db.prepare(`
      UPDATE qr_provision_jobs
      SET status = 'failed', failure_code = ?, updated_at = ?
      WHERE id = ? AND status = 'leased'
    `).run(code, now, row.id);
    this.db.prepare(`
      UPDATE recharge_orders
      SET status = 'cancelled', payment_qr_status = 'failed', cancelled_at = ?,
          last_error_code = ?, last_error_message = '逐单收钱码生成失败',
          updated_at = ?, version = version + 1
      WHERE id = ? AND status = 'awaiting_payment'
    `).run(now, code, now, row.order_id);
    this.#audit(row.order_id, 'QR_PROVISION_FAILED', request, { failureCode: code });
  }

  async #notifyFailure(row, code) {
    if (!this.alerts) return;
    try {
      await this.alerts.send({
        eventId: `qr:${row.id}:${code}`,
        anomalyCode: code,
        orderNo: row.order_no,
        amount: minorToDecimal(row.payable_amount_minor),
        tradeLast6: '',
        memoLast6: row.payment_memo_last6,
        occurredAt: this.#now().toISOString()
      });
    } catch (error) {
      this.#audit(row.order_id, 'RECHARGE_ALERT_DELIVERY_FAILED', null, {
        anomalyCode: code,
        alertErrorCode: error?.code || 'ALERT_DELIVERY_FAILED'
      });
    }
  }

  claim(collectorId, request = {}) {
    this.#assertEnabled();
    const now = this.#now();
    const nowIso = now.toISOString();
    return this.db.transaction(() => {
      this.db.prepare(`
        UPDATE qr_provision_jobs
        SET status = 'expired', lease_hash = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE status IN ('queued', 'leased') AND order_id IN (
          SELECT id FROM recharge_orders WHERE status = 'expired' OR expires_at <= ?
        )
      `).run(nowIso, nowIso);
      this.db.prepare(`
        UPDATE qr_provision_jobs
        SET status = 'queued', collector_id = NULL, lease_hash = NULL,
            lease_expires_at = NULL, updated_at = ?
        WHERE status = 'leased' AND lease_expires_at <= ? AND order_id IN (
          SELECT id FROM recharge_orders WHERE status = 'awaiting_payment' AND expires_at > ?
        )
      `).run(nowIso, nowIso, nowIso);

      const row = this.db.prepare(`
        SELECT q.*, o.order_no, o.payable_amount_minor, o.payment_memo_ciphertext, o.expires_at
        FROM qr_provision_jobs q
        JOIN recharge_orders o ON o.id = q.order_id
        WHERE q.status = 'queued' AND o.status = 'awaiting_payment' AND o.expires_at > ?
        ORDER BY q.created_at ASC LIMIT 1
      `).get(nowIso);
      if (!row) return null;

      const leaseToken = crypto.randomBytes(32).toString('base64url');
      const leaseEndsAt = new Date(Math.min(
        now.getTime() + this.config.qrJobLeaseSeconds * 1000,
        Date.parse(row.expires_at)
      )).toISOString();
      const changed = this.db.prepare(`
        UPDATE qr_provision_jobs
        SET status = 'leased', collector_id = ?, lease_hash = ?, lease_expires_at = ?,
            attempts = attempts + 1, failure_code = NULL, updated_at = ?
        WHERE id = ? AND status = 'queued'
      `).run(collectorId, this.#leaseHash(leaseToken), leaseEndsAt, nowIso, row.id);
      if (changed.changes !== 1) {
        throw new AppError('QR_JOB_CLAIM_CONFLICT', '收钱码任务已被其他请求领取', { status: 409 });
      }
      this.#audit(row.order_id, 'QR_PROVISION_JOB_LEASED', request, {
        leaseExpiresAt: leaseEndsAt,
        attempt: Number(row.attempts) + 1
      });
      return {
        jobId: row.id,
        orderNo: row.order_no,
        amount: minorToDecimal(row.payable_amount_minor),
        memo: openText(this.config.secret, 'payment-memo:v1', row.payment_memo_ciphertext, row.order_id),
        expiresAt: row.expires_at,
        leaseToken,
        leaseExpiresAt: leaseEndsAt
      };
    })();
  }

  async complete(input, request = {}) {
    this.#assertEnabled();
    const qrUrl = normalizeOpaqueAlipayQrUrl(input.qrUrl);
    const observedAmountMinor = parseMoneyToMinor(input.observedAmount);
    const observedMemo = String(input.observedMemo || '').trim();
    const generatedAtMs = Date.parse(String(input.generatedAt || ''));
    if (!Number.isFinite(generatedAtMs)) {
      throw new AppError('QR_GENERATED_TIME_INVALID', '收钱码生成时间无效', { status: 400 });
    }
    const now = this.#now();
    const qrHash = hmacHex(this.config.secret, 'alipay-qr-url:v1', qrUrl);
    const result = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT q.*, o.status AS order_status, o.order_no, o.expires_at, o.payable_amount_minor,
               o.payment_memo_ciphertext, o.payment_memo_last6, o.payment_qr_hash
        FROM qr_provision_jobs q
        JOIN recharge_orders o ON o.id = q.order_id
        WHERE q.id = ?
      `).get(input.jobId);

      if (row?.status === 'completed' && row.lease_hash &&
          safeEqual(row.collector_id, input.collectorId) &&
          safeEqual(row.lease_hash, this.#leaseHash(input.leaseToken)) &&
          safeEqual(row.payment_qr_hash, qrHash)) {
        return { accepted: true, duplicate: true, orderId: row.order_id, qrStatus: 'ready' };
      }
      this.#assertLease(row, input.collectorId, input.leaseToken, now);
      const expectedMemo = openText(
        this.config.secret,
        'payment-memo:v1',
        row.payment_memo_ciphertext,
        row.order_id
      );
      let failureCode = null;
      if (observedAmountMinor !== Number(row.payable_amount_minor)) failureCode = 'QR_AMOUNT_MISMATCH';
      else if (!safeEqual(observedMemo, expectedMemo)) failureCode = 'QR_MEMO_MISMATCH';
      else if (!safeEqual(String(input.observedRecipientId || '').trim(), this.config.alipayRecipientId)) {
        failureCode = 'QR_RECIPIENT_MISMATCH';
      }
      else if (generatedAtMs < Date.parse(row.created_at) - 5000 ||
               generatedAtMs > now.getTime() + this.config.listenerSignatureToleranceSeconds * 1000 ||
               generatedAtMs > Date.parse(row.expires_at)) failureCode = 'QR_GENERATED_TIME_INVALID';
      const duplicateQr = this.db.prepare(`
        SELECT id FROM recharge_orders WHERE payment_qr_hash = ? AND id <> ?
      `).get(qrHash, row.order_id);
      if (duplicateQr) failureCode = 'QR_URL_REUSED';
      if (failureCode) {
        this.#failLeased(row, failureCode, request);
        return {
          failedRow: row,
          failureCode,
          error: new AppError(failureCode, '收钱码生成结果未通过完整校验，订单已停止', { status: 409 })
        };
      }

      const reportedGeneratedAt = new Date(generatedAtMs).toISOString();
      const readyAt = now.toISOString();
      const ciphertext = sealText(this.config.secret, 'alipay-qr-url:v1', qrUrl, row.order_id);
      const updated = this.db.prepare(`
        UPDATE recharge_orders
        SET payment_qr_status = 'ready', payment_qr_hash = ?, payment_qr_ciphertext = ?,
            payment_qr_generated_at = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND status = 'awaiting_payment' AND payment_qr_status = 'pending'
      `).run(qrHash, ciphertext, readyAt, readyAt, row.order_id);
      if (updated.changes !== 1) {
        throw new AppError('ORDER_STATE_CHANGED', '订单状态已变化，停止接收收钱码', { status: 409 });
      }
      this.db.prepare(`
        UPDATE qr_provision_jobs
        SET status = 'completed', completed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'leased'
      `).run(readyAt, readyAt, row.id);
      this.#audit(row.order_id, 'QR_PROVISION_COMPLETED', request, {
        reportedGeneratedAt,
        readyAt,
        qrFingerprint: qrHash.slice(0, 12)
      });
      return { accepted: true, duplicate: false, orderId: row.order_id, qrStatus: 'ready' };
    })();
    if (result.error) {
      await this.#notifyFailure(result.failedRow, result.failureCode);
      throw result.error;
    }
    return result;
  }

  async fail(input, request = {}) {
    this.#assertEnabled();
    const code = FAILURE_CODES.has(input.failureCode) ? input.failureCode : 'other';
    const result = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT q.*, o.status AS order_status, o.order_no, o.expires_at,
               o.payable_amount_minor, o.payment_memo_last6
        FROM qr_provision_jobs q
        JOIN recharge_orders o ON o.id = q.order_id
        WHERE q.id = ?
      `).get(input.jobId);
      this.#assertLease(row, input.collectorId, input.leaseToken, this.#now());
      this.#failLeased(row, `QR_ADAPTER_${code.toUpperCase()}`, request);
      return { accepted: true, orderId: row.order_id, qrStatus: 'failed', failedRow: row, failureCode: `QR_ADAPTER_${code.toUpperCase()}` };
    })();
    await this.#notifyFailure(result.failedRow, result.failureCode);
    return { accepted: result.accepted, orderId: result.orderId, qrStatus: result.qrStatus };
  }
}

module.exports = { FAILURE_CODES, QrProvisioningService, normalizeOpaqueAlipayQrUrl };
