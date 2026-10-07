'use strict';

const crypto = require('crypto');
const { AppError } = require('./errors');
const {
  hmacHex,
  microsToDecimal,
  minorToDecimal,
  normalizeTradeNo,
  openText,
  parseRechargeAmount,
  parseMoneyToMinor,
  redactText,
  safeEqual,
  sealText,
  tradeNoTail
} = require('./security');

const ACTIVE_STATUSES = ['awaiting_payment', 'payment_reported', 'fulfilling', 'needs_attention'];
const REJECTION_REASONS = new Set([
  'trade_not_found',
  'amount_mismatch',
  'payment_outside_window',
  'duplicate_payment',
  'payment_reversed',
  'other'
]);

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

function addHours(date, hours) {
  return new Date(date.getTime() + hours * 3600000);
}

function randomOrderNo(now = new Date()) {
  const date = now.toISOString().slice(2, 10).replace(/-/g, '');
  return `RC-${date}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function randomRedeemCode() {
  return `RC${crypto.randomBytes(15).toString('hex').toUpperCase()}`;
}

function randomPaymentMemo() {
  return `S2-${crypto.randomBytes(12).toString('base64url')}`;
}

function publicOrder(row, options = {}) {
  if (!row) return null;
  const order = {
    id: row.id,
    orderNo: row.order_no,
    userId: String(row.user_id),
    userEmailMasked: row.user_email_masked,
    requestedAmount: minorToDecimal(row.requested_amount_minor || row.payable_amount_minor),
    payableAmount: minorToDecimal(row.payable_amount_minor),
    creditAmount: microsToDecimal(row.credit_amount_micros),
    amountAdjusted: Number(row.requested_amount_minor || row.payable_amount_minor) !== Number(row.payable_amount_minor),
    currency: row.currency,
    status: row.status,
    tradeLast6: row.trade_last6 || null,
    expiresAt: row.expires_at,
    paymentReportedAt: row.payment_reported_at || null,
    alipayPaidAt: row.alipay_paid_at || null,
    reviewExpiresAt: row.review_expires_at || null,
    completedAt: row.completed_at || null,
    rejectedAt: row.rejected_at || null,
    rejectedReason: row.rejected_reason || null,
    cancelledAt: row.cancelled_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
  if (row.payment_mode === 'personal_transfer_auto') {
    order.qrStatus = row.payment_qr_status || 'ready';
    order.qrAvailable = order.qrStatus === 'ready';
  }
  if (options.admin) {
    order.fulfillmentAttempts = row.fulfillment_attempts;
    order.fulfillmentStartedAt = row.fulfillment_started_at || null;
    order.lastErrorCode = row.last_error_code || null;
    order.lastErrorMessage = row.last_error_message || null;
    order.verifiedAt = row.verified_at || null;
    order.verifiedBy = row.verified_by || null;
    order.autoMatchStatus = row.auto_match_status || null;
    order.paymentMemoLast6 = row.payment_memo_last6 || null;
  }
  return order;
}

class OrderService {
  constructor({ db, config, sub2api, alerts = null, clock = () => new Date() }) {
    this.db = db;
    this.config = config;
    this.sub2api = sub2api;
    this.alerts = alerts;
    this.clock = clock;
    this.insertAudit = db.prepare(`
      INSERT INTO audit_events(
        occurred_at, order_id, actor_type, actor_id, event_type, request_id, ip_hash, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  #now() {
    return this.clock();
  }

  #audit(orderId, actor, eventType, request, metadata = {}) {
    const now = this.#now().toISOString();
    const ipHash = request?.ip
      ? hmacHex(this.config.secret, 'audit-ip:v1', request.ip)
      : null;
    this.insertAudit.run(
      now,
      orderId || null,
      actor?.type || 'system',
      actor?.id == null ? null : String(actor.id),
      eventType,
      request?.requestId || null,
      ipHash,
      JSON.stringify(metadata)
    );
  }

  expireAwaiting() {
    const now = this.#now().toISOString();
    const rows = this.db.prepare(`
      SELECT id FROM recharge_orders
      WHERE status = 'awaiting_payment' AND expires_at <= ?
    `).all(now);
    const update = this.db.prepare(`
      UPDATE recharge_orders
      SET status = 'expired', updated_at = ?, version = version + 1
      WHERE id = ? AND status = 'awaiting_payment'
    `);
    const transaction = this.db.transaction(() => {
      for (const row of rows) {
        if (update.run(now, row.id).changes === 1) {
          this.db.prepare(`
            UPDATE recharge_orders SET payment_qr_status = 'expired'
            WHERE id = ? AND payment_qr_status = 'pending'
          `).run(row.id);
          this.db.prepare(`
            UPDATE qr_provision_jobs SET status = 'expired', updated_at = ?
            WHERE order_id = ? AND status IN ('queued', 'leased')
          `).run(now, row.id);
          this.#audit(row.id, { type: 'system' }, 'ORDER_EXPIRED', null);
        }
      }
      this.db.prepare('DELETE FROM amount_reservations WHERE expires_at <= ?').run(now);
    });
    transaction();
    return rows.length;
  }

  create(user, amount, request = {}) {
    const requestedMinor = parseRechargeAmount(amount, this.config.minAmount, this.config.maxAmount);
    const now = this.#now();
    const createdAt = now.toISOString();
    this.expireAwaiting();
    const createTransaction = this.db.transaction(() => {
      const active = this.db.prepare(`
        SELECT COUNT(*) AS count FROM recharge_orders
        WHERE user_id = ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(', ')})
      `).get(user.id, ...ACTIVE_STATUSES).count;
      if (active >= this.config.maxActiveOrders) {
        throw new AppError('ACTIVE_ORDER_EXISTS', '请先处理当前充值订单', { status: 409 });
      }
      let payableMinor = requestedMinor;
      const automatic = this.config.paymentMode === 'personal_transfer_auto';
      if (automatic) {
        this.db.prepare('DELETE FROM amount_reservations WHERE expires_at <= ?').run(createdAt);
        const reservationCount = this.db.prepare('SELECT COUNT(*) AS count FROM amount_reservations').get().count;
        if (reservationCount >= this.config.autoReservationLimit) {
          throw new AppError('AUTO_ORDER_CAPACITY_REACHED', '当前付款订单较多，请三分钟后再试', { status: 503 });
        }
        const reserved = new Set(this.db.prepare(`
          SELECT payable_amount_minor FROM amount_reservations WHERE expires_at > ?
        `).all(createdAt).map((entry) => Number(entry.payable_amount_minor)));
        const maximumMinor = parseMoneyToMinor(this.config.maxAmount);
        payableMinor = null;
        for (let offset = 0; offset <= 99; offset += 1) {
          const candidate = requestedMinor + offset;
          if (candidate <= maximumMinor && !reserved.has(candidate)) {
            payableMinor = candidate;
            break;
          }
        }
        if (payableMinor == null) {
          throw new AppError('AUTO_AMOUNT_UNAVAILABLE', '该金额附近暂无可用付款标识，请三分钟后再试', { status: 503 });
        }
      }
      const creditMicros = payableMinor * 1000000;
      if (!Number.isSafeInteger(creditMicros) || creditMicros <= 0) {
        throw new AppError('CREDIT_AMOUNT_INVALID', '入账额度超出安全范围', { status: 500 });
      }
      const row = {
        id: crypto.randomUUID(),
        orderNo: randomOrderNo(now),
        expiresAt: addMinutes(now, this.config.orderTtlMinutes).toISOString()
      };
      const redeemCode = randomRedeemCode();
      const sealedRedeemCode = sealText(this.config.secret, 'redeem-code:v1', redeemCode, row.id);
      const paymentMemo = automatic ? randomPaymentMemo() : null;
      const paymentQrSource = automatic ? (this.config.transferQrSource || 'template') : null;
      const paymentQrStatus = automatic
        ? (paymentQrSource === 'collector' ? 'pending' : 'ready')
        : null;
      const paymentMemoHash = paymentMemo
        ? hmacHex(this.config.secret, 'payment-memo:v1', paymentMemo)
        : null;
      const sealedPaymentMemo = paymentMemo
        ? sealText(this.config.secret, 'payment-memo:v1', paymentMemo, row.id)
        : null;
      this.db.prepare(`
        INSERT INTO recharge_orders(
          id, order_no, user_id, user_email_masked, payment_mode,
          requested_amount_minor, payable_amount_minor, credit_amount_micros,
          status, redeem_code, payment_memo_hash, payment_memo_ciphertext,
          payment_memo_last6, payment_qr_source, payment_qr_status,
          auto_match_status, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_payment', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.id, row.orderNo, user.id, user.emailMasked, this.config.paymentMode || 'personal_manual',
        requestedMinor, payableMinor, creditMicros, sealedRedeemCode,
        paymentMemoHash, sealedPaymentMemo, paymentMemo?.slice(-6) || null,
        paymentQrSource, paymentQrStatus, automatic ? 'awaiting_match' : null,
        row.expiresAt, createdAt, createdAt
      );
      if (automatic) {
        this.db.prepare(`
          INSERT INTO amount_reservations(payable_amount_minor, order_id, expires_at, created_at)
          VALUES (?, ?, ?, ?)
        `).run(payableMinor, row.id, row.expiresAt, createdAt);
        if (paymentQrSource === 'collector') {
          this.db.prepare(`
            INSERT INTO qr_provision_jobs(id, order_id, status, created_at, updated_at)
            VALUES (?, ?, 'queued', ?, ?)
          `).run(crypto.randomUUID(), row.id, createdAt, createdAt);
        }
      }
      this.#audit(row.id, { type: 'user', id: user.id }, 'ORDER_CREATED', request, {
        requestedAmount: minorToDecimal(requestedMinor),
        payableAmount: minorToDecimal(payableMinor),
        creditAmount: microsToDecimal(creditMicros),
        amountAdjusted: requestedMinor !== payableMinor,
        paymentMode: this.config.paymentMode,
        paymentQrSource,
        memoSuffix: paymentMemo?.slice(-6) || null,
        currency: 'CNY'
      });
      return this.db.prepare('SELECT * FROM recharge_orders WHERE id = ?').get(row.id);
    });
    try {
      return publicOrder(createTransaction());
    } catch (error) {
      if (String(error?.code || '').startsWith('SQLITE_CONSTRAINT')) {
        throw new AppError('ORDER_CREATE_CONFLICT', '订单创建冲突，请重试', { status: 409 });
      }
      throw error;
    }
  }

  listForUser(userId) {
    this.expireAwaiting();
    return this.db.prepare(`
      SELECT * FROM recharge_orders WHERE user_id = ?
      ORDER BY created_at DESC LIMIT 50
    `).all(userId).map((row) => publicOrder(row));
  }

  getForUser(orderId, userId) {
    this.expireAwaiting();
    const row = this.db.prepare('SELECT * FROM recharge_orders WHERE id = ? AND user_id = ?').get(orderId, userId);
    if (!row) throw new AppError('ORDER_NOT_FOUND', '订单不存在', { status: 404 });
    return publicOrder(row);
  }

  canAccessQr(orderId, user) {
    this.expireAwaiting();
    const row = this.db.prepare('SELECT user_id, status FROM recharge_orders WHERE id = ?').get(orderId);
    if (!row || (user.role !== 'admin' && Number(row.user_id) !== Number(user.id))) {
      throw new AppError('ORDER_NOT_FOUND', '订单不存在', { status: 404 });
    }
    if (row.status !== 'awaiting_payment') {
      throw new AppError('PAYMENT_QR_UNAVAILABLE', '该订单当前不显示收款码', { status: 409 });
    }
    return true;
  }

  paymentQrData(orderId, user) {
    this.canAccessQr(orderId, user);
    const row = this.db.prepare(`
      SELECT id, payable_amount_minor, payment_memo_ciphertext, payment_qr_source,
             payment_qr_status, payment_qr_ciphertext
      FROM recharge_orders WHERE id = ?
    `).get(orderId);
    if (!row?.payment_memo_ciphertext) return null;
    if (row.payment_qr_source === 'collector') {
      if (row.payment_qr_status === 'pending') {
        throw new AppError('PAYMENT_QR_PENDING', '正在生成本单支付宝收钱码', { status: 425 });
      }
      if (row.payment_qr_status !== 'ready' || !row.payment_qr_ciphertext) {
        throw new AppError('PAYMENT_QR_UNAVAILABLE', '本单支付宝收钱码生成失败', { status: 409 });
      }
      return {
        qrUrl: openText(this.config.secret, 'alipay-qr-url:v1', row.payment_qr_ciphertext, row.id)
      };
    }
    return {
      amount: minorToDecimal(row.payable_amount_minor),
      memo: openText(this.config.secret, 'payment-memo:v1', row.payment_memo_ciphertext, row.id)
    };
  }

  reportPayment(orderId, user, tradeNo, request = {}) {
    const normalized = normalizeTradeNo(tradeNo);
    const hash = hmacHex(this.config.secret, 'alipay-trade:v1', normalized);
    const tail = tradeNoTail(normalized);
    this.expireAwaiting();
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM recharge_orders WHERE id = ? AND user_id = ?').get(orderId, user.id);
      if (!row) throw new AppError('ORDER_NOT_FOUND', '订单不存在', { status: 404 });
      if (row.status === 'payment_reported' && safeEqual(row.trade_hash, hash)) return row;
      if (row.status === 'expired') {
        throw new AppError('ORDER_EXPIRED', '订单已过期，请不要继续付款', { status: 410 });
      }
      if (row.status !== 'awaiting_payment') {
        throw new AppError('ORDER_STATE_INVALID', '该订单当前不能提交付款信息', { status: 409 });
      }
      const now = this.#now();
      const reportedAt = now.toISOString();
      const reviewExpiresAt = addHours(now, this.config.reviewTtlHours).toISOString();
      try {
        this.db.prepare(`
          UPDATE recharge_orders SET
            status = 'payment_reported', trade_hash = ?, trade_last6 = ?,
            payment_reported_at = ?, review_expires_at = ?, updated_at = ?, version = version + 1
          WHERE id = ? AND status = 'awaiting_payment'
        `).run(hash, tail, reportedAt, reviewExpiresAt, reportedAt, row.id);
      } catch (error) {
        if (String(error?.code || '').startsWith('SQLITE_CONSTRAINT')) {
          throw new AppError('TRADE_ALREADY_REPORTED', '该支付宝交易号已用于其他订单', { status: 409 });
        }
        throw error;
      }
      this.#audit(row.id, { type: 'user', id: user.id }, 'PAYMENT_REPORTED', request, { tradeLast6: tail });
      return this.db.prepare('SELECT * FROM recharge_orders WHERE id = ?').get(row.id);
    });
    return publicOrder(transaction());
  }

  async acceptAutomaticPayment(input, request = {}) {
    if (this.config.paymentMode !== 'personal_transfer_auto') {
      throw new AppError('AUTOMATIC_PAYMENT_DISABLED', '个人转账自动匹配未启用', { status: 404 });
    }
    const normalizedTradeNo = normalizeTradeNo(input.tradeNo);
    const tradeHash = hmacHex(this.config.secret, 'alipay-trade:v1', normalizedTradeNo);
    const memo = String(input.memo || '').trim();
    const memoHash = hmacHex(this.config.secret, 'payment-memo:v1', memo);
    const recipientId = String(input.recipientId || '').trim();
    const recipientHash = hmacHex(this.config.secret, 'alipay-recipient:v1', recipientId);
    const collectorEventHash = hmacHex(this.config.secret, 'listener-event:v1', String(input.eventId));
    const amountMinor = parseMoneyToMinor(input.amount);
    const paidAtTimestamp = Date.parse(String(input.paidAt || ''));
    if (!Number.isFinite(paidAtTimestamp)) {
      throw new AppError('PAYMENT_TIME_INVALID', '监听器付款时间无效', { status: 400 });
    }
    const paidAt = new Date(paidAtTimestamp).toISOString();
    const receivedAt = this.#now().toISOString();
    this.expireAwaiting();

    const prepared = this.db.transaction(() => {
      const duplicateEvent = this.db.prepare(`
        SELECT * FROM payment_events WHERE collector_event_hash = ?
      `).get(collectorEventHash);
      if (duplicateEvent) {
        const conflict = !safeEqual(duplicateEvent.trade_hash, tradeHash);
        return {
          kind: conflict ? 'anomaly' : 'duplicate',
          anomalyCode: conflict ? 'COLLECTOR_EVENT_CONFLICT' : duplicateEvent.anomaly_code,
          paymentEvent: duplicateEvent,
          order: duplicateEvent.order_id
            ? this.db.prepare('SELECT * FROM recharge_orders WHERE id = ?').get(duplicateEvent.order_id)
            : null
        };
      }
      const duplicateTrade = this.db.prepare('SELECT * FROM payment_events WHERE trade_hash = ?').get(tradeHash);
      if (duplicateTrade) {
        const exactReplay = safeEqual(duplicateTrade.memo_hash, memoHash) &&
          safeEqual(duplicateTrade.recipient_hash, recipientHash) &&
          Number(duplicateTrade.amount_minor) === amountMinor &&
          duplicateTrade.paid_at === paidAt && duplicateTrade.source === input.source;
        return {
          kind: exactReplay ? 'duplicate' : 'anomaly',
          anomalyCode: exactReplay ? duplicateTrade.anomaly_code : 'DUPLICATE_TRADE_CONFLICT',
          paymentEvent: duplicateTrade,
          order: duplicateTrade.order_id
            ? this.db.prepare('SELECT * FROM recharge_orders WHERE id = ?').get(duplicateTrade.order_id)
            : null
        };
      }

      const order = this.db.prepare('SELECT * FROM recharge_orders WHERE payment_memo_hash = ?').get(memoHash);
      let anomalyCode = null;
      if (input.evidenceType !== 'ledger_detail') anomalyCode = 'EVIDENCE_TYPE_INVALID';
      else if (input.direction !== 'income') anomalyCode = 'PAYMENT_DIRECTION_INVALID';
      else if (input.status !== 'success') anomalyCode = 'PAYMENT_STATUS_INVALID';
      else if (!safeEqual(recipientId, this.config.alipayRecipientId)) anomalyCode = 'RECIPIENT_MISMATCH';
      else if (!/^S2-[A-Za-z0-9_-]{16}$/.test(memo)) anomalyCode = 'MEMO_FORMAT_INVALID';
      else if (paidAtTimestamp > Date.parse(receivedAt) + this.config.listenerSignatureToleranceSeconds * 1000) {
        anomalyCode = 'PAYMENT_TIME_IN_FUTURE';
      }
      else if (paidAtTimestamp < Date.parse(receivedAt) - this.config.listenerMaxEventAgeSeconds * 1000) {
        anomalyCode = 'PAYMENT_EVENT_TOO_OLD';
      }
      else if (!order) anomalyCode = 'MEMO_UNKNOWN';
      else if (order.payment_mode !== 'personal_transfer_auto') anomalyCode = 'ORDER_MODE_MISMATCH';
      else if (amountMinor !== Number(order.payable_amount_minor)) anomalyCode = 'PAYMENT_AMOUNT_MISMATCH';
      else if (order.payment_qr_source === 'collector' &&
               (order.payment_qr_status !== 'ready' || !order.payment_qr_generated_at ||
                !order.payment_qr_hash || !order.payment_qr_ciphertext)) anomalyCode = 'PAYMENT_QR_NOT_READY';
      else {
        const paidSecond = Math.floor(paidAtTimestamp / 1000);
        const payableFrom = order.payment_qr_source === 'collector'
          ? order.payment_qr_generated_at
          : order.created_at;
        const createdSecond = Math.floor(Date.parse(payableFrom) / 1000);
        const expiresSecond = Math.floor(Date.parse(order.expires_at) / 1000);
        if (paidSecond < createdSecond || paidSecond > expiresSecond) anomalyCode = 'PAYMENT_OUTSIDE_ORDER_WINDOW';
        else if (!['awaiting_payment', 'expired'].includes(order.status)) anomalyCode = 'ORDER_STATE_INVALID';
      }
      const priorTradeOrder = this.db.prepare(`
        SELECT id FROM recharge_orders WHERE trade_hash = ? AND (? IS NULL OR id <> ?)
      `).get(tradeHash, order?.id || null, order?.id || null);
      if (priorTradeOrder) anomalyCode = 'PAYMENT_TRADE_ALREADY_USED';

      const paymentEventId = crypto.randomUUID();
      this.db.prepare(`
        INSERT INTO payment_events(
          id, collector_event_hash, source, evidence_type, trade_hash, trade_last6,
          memo_hash, memo_last6, amount_minor, paid_at, recipient_hash, order_id,
          match_status, anomaly_code, received_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        paymentEventId, collectorEventHash, input.source, input.evidenceType,
        tradeHash, tradeNoTail(normalizedTradeNo), memoHash, memo.slice(-6), amountMinor,
        paidAt, recipientHash, order?.id || null, anomalyCode ? 'needs_attention' : 'matched',
        anomalyCode, receivedAt, receivedAt
      );

      if (anomalyCode) {
        if (order && ['awaiting_payment', 'expired', 'cancelled'].includes(order.status) && !priorTradeOrder) {
          const reviewExpiresAt = addHours(this.#now(), this.config.reviewTtlHours).toISOString();
          this.db.prepare(`
            UPDATE recharge_orders SET
              status = 'payment_reported', trade_hash = ?, trade_last6 = ?,
              payment_reported_at = ?, alipay_paid_at = ?, review_expires_at = ?,
              auto_match_status = 'needs_attention', last_error_code = ?,
              last_error_message = '自动到账证据未通过完整校验', updated_at = ?, version = version + 1
            WHERE id = ? AND status IN ('awaiting_payment', 'expired', 'cancelled')
          `).run(
            tradeHash, tradeNoTail(normalizedTradeNo), receivedAt, paidAt, reviewExpiresAt,
            anomalyCode, receivedAt, order.id
          );
        }
        this.#audit(order?.id || null, { type: 'system', id: this.config.listenerCollectorId },
          'AUTOMATIC_PAYMENT_NEEDS_ATTENTION', request, {
            anomalyCode,
            tradeLast6: tradeNoTail(normalizedTradeNo),
            memoSuffix: memo.slice(-6),
            amount: minorToDecimal(amountMinor),
            paidAt,
            source: input.source
          });
        return {
          kind: 'anomaly', anomalyCode,
          paymentEvent: this.db.prepare('SELECT * FROM payment_events WHERE id = ?').get(paymentEventId),
          order: order ? this.db.prepare('SELECT * FROM recharge_orders WHERE id = ?').get(order.id) : null
        };
      }

      const verifiedAt = receivedAt;
      const changed = this.db.prepare(`
        UPDATE recharge_orders SET
          status = 'fulfilling', trade_hash = ?, trade_last6 = ?, payment_reported_at = ?,
          alipay_paid_at = ?, verified_at = ?, verified_by = ?, auto_match_status = 'matched',
          fulfillment_started_at = ?, fulfillment_attempts = fulfillment_attempts + 1,
          last_error_code = NULL, last_error_message = NULL, updated_at = ?, version = version + 1
        WHERE id = ? AND version = ? AND status IN ('awaiting_payment', 'expired')
      `).run(
        tradeHash, tradeNoTail(normalizedTradeNo), receivedAt, paidAt, verifiedAt,
        `listener:${this.config.listenerCollectorId}`, receivedAt, receivedAt, order.id, order.version
      );
      if (changed.changes !== 1) {
        throw new AppError('ORDER_STATE_CHANGED', '订单状态已变化，付款证据已停止自动处理', { status: 409 });
      }
      this.#audit(order.id, { type: 'system', id: this.config.listenerCollectorId },
        'AUTOMATIC_PAYMENT_VERIFIED', request, {
          tradeLast6: tradeNoTail(normalizedTradeNo),
          memoSuffix: memo.slice(-6),
          amount: minorToDecimal(amountMinor),
          paidAt,
          source: input.source
        });
      return {
        kind: 'fulfill',
        paymentEvent: this.db.prepare('SELECT * FROM payment_events WHERE id = ?').get(paymentEventId),
        order: this.db.prepare('SELECT * FROM recharge_orders WHERE id = ?').get(order.id)
      };
    })();

    if (prepared.kind === 'duplicate') {
      return this.#automaticPaymentResult(prepared, true);
    }
    if (prepared.kind === 'anomaly') {
      await this.#notifyAutomaticAnomaly(prepared, prepared.anomalyCode, amountMinor);
      return this.#automaticPaymentResult(prepared, false);
    }

    try {
      const completed = await this.#fulfill(prepared.order, {
        automatic: true,
        actorId: this.config.listenerCollectorId
      }, request);
      const updatedAt = this.#now().toISOString();
      this.db.prepare(`
        UPDATE payment_events SET match_status = 'completed', updated_at = ? WHERE id = ?
      `).run(updatedAt, prepared.paymentEvent.id);
      return {
        accepted: true,
        duplicate: false,
        status: 'completed',
        orderId: completed.id,
        orderNo: completed.orderNo
      };
    } catch (error) {
      if (error?.code !== 'FULFILLMENT_NEEDS_ATTENTION') throw error;
      const updatedAt = this.#now().toISOString();
      this.db.prepare(`
        UPDATE payment_events SET match_status = 'needs_attention', anomaly_code = ?, updated_at = ? WHERE id = ?
      `).run('FULFILLMENT_RESULT_UNKNOWN', updatedAt, prepared.paymentEvent.id);
      const attention = {
        ...prepared,
        anomalyCode: 'FULFILLMENT_RESULT_UNKNOWN',
        paymentEvent: this.db.prepare('SELECT * FROM payment_events WHERE id = ?').get(prepared.paymentEvent.id),
        order: this.db.prepare('SELECT * FROM recharge_orders WHERE id = ?').get(prepared.order.id)
      };
      await this.#notifyAutomaticAnomaly(attention, 'FULFILLMENT_RESULT_UNKNOWN', amountMinor);
      return this.#automaticPaymentResult(attention, false, 'needs_attention');
    }
  }

  #automaticPaymentResult(prepared, duplicate, status = null) {
    const anomalyCode = prepared.anomalyCode || prepared.paymentEvent?.anomaly_code || null;
    const resolvedStatus = status || prepared.paymentEvent?.match_status || 'needs_attention';
    return {
      accepted: !anomalyCode && ['matched', 'completed'].includes(resolvedStatus),
      duplicate,
      status: resolvedStatus,
      anomalyCode,
      orderId: prepared.order?.id || null,
      orderNo: prepared.order?.order_no || null
    };
  }

  async #notifyAutomaticAnomaly(prepared, anomalyCode, amountMinor) {
    if (!this.alerts) return;
    try {
      await this.alerts.send({
        eventId: `recharge:${prepared.paymentEvent.id}:${anomalyCode}`,
        anomalyCode,
        orderNo: prepared.order?.order_no || null,
        amount: minorToDecimal(prepared.order?.payable_amount_minor || amountMinor),
        tradeLast6: prepared.paymentEvent.trade_last6,
        memoLast6: prepared.paymentEvent.memo_last6,
        occurredAt: prepared.paymentEvent.received_at
      });
    } catch (error) {
      this.#audit(prepared.order?.id || null, { type: 'system' }, 'RECHARGE_ALERT_DELIVERY_FAILED', null, {
        anomalyCode,
        alertErrorCode: error?.code || 'ALERT_DELIVERY_FAILED'
      });
    }
  }

  cancel(orderId, user, request = {}) {
    this.expireAwaiting();
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM recharge_orders WHERE id = ? AND user_id = ?').get(orderId, user.id);
      if (!row) throw new AppError('ORDER_NOT_FOUND', '订单不存在', { status: 404 });
      if (row.status === 'expired') {
        throw new AppError('ORDER_EXPIRED', '订单已过期', { status: 410 });
      }
      if (row.status !== 'awaiting_payment') {
        throw new AppError('ORDER_STATE_INVALID', '该订单当前不能取消', { status: 409 });
      }
      const now = this.#now().toISOString();
      this.db.prepare(`
        UPDATE recharge_orders SET status = 'cancelled', cancelled_at = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND status = 'awaiting_payment'
      `).run(now, now, row.id);
      this.db.prepare(`
        UPDATE qr_provision_jobs SET status = 'cancelled', updated_at = ?
        WHERE order_id = ? AND status IN ('queued', 'leased')
      `).run(now, row.id);
      this.#audit(row.id, { type: 'user', id: user.id }, 'ORDER_CANCELLED', request);
      return this.db.prepare('SELECT * FROM recharge_orders WHERE id = ?').get(row.id);
    });
    return publicOrder(transaction());
  }

  listForAdmin(input = {}) {
    this.expireAwaiting();
    const allowedStatus = ['all', ...ACTIVE_STATUSES, 'completed', 'rejected', 'expired', 'cancelled'];
    const status = allowedStatus.includes(input.status) ? input.status : 'payment_reported';
    const page = Math.max(1, Math.min(100000, Number(input.page) || 1));
    const pageSize = Math.max(1, Math.min(100, Number(input.pageSize) || 20));
    const where = status === 'all' ? '' : 'WHERE status = ?';
    const params = status === 'all' ? [] : [status];
    const total = this.db.prepare(`SELECT COUNT(*) AS count FROM recharge_orders ${where}`).get(...params).count;
    const rows = this.db.prepare(`
      SELECT * FROM recharge_orders ${where}
      ORDER BY CASE status WHEN 'payment_reported' THEN 0 WHEN 'needs_attention' THEN 1 ELSE 2 END,
               created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, (page - 1) * pageSize);
    return { items: rows.map((row) => publicOrder(row, { admin: true })), total, page, pageSize };
  }

  getForAdmin(orderId) {
    const row = this.db.prepare('SELECT * FROM recharge_orders WHERE id = ?').get(orderId);
    if (!row) throw new AppError('ORDER_NOT_FOUND', '订单不存在', { status: 404 });
    const events = this.db.prepare(`
      SELECT occurred_at, actor_type, actor_id, event_type, request_id, metadata_json
      FROM audit_events WHERE order_id = ? ORDER BY occurred_at DESC, id DESC LIMIT 100
    `).all(orderId).map((event) => ({
      occurredAt: event.occurred_at,
      actorType: event.actor_type,
      actorId: event.actor_id,
      eventType: event.event_type,
      requestId: event.request_id,
      metadata: JSON.parse(event.metadata_json)
    }));
    return { order: publicOrder(row, { admin: true }), events };
  }

  async confirm(orderId, adminSession, input, request = {}) {
    if (input.acknowledge !== true) {
      throw new AppError('CONFIRMATION_REQUIRED', '请确认已在支付宝账单中完成独立核验', { status: 400 });
    }
    const paidMinor = parseMoneyToMinor(input.paidAmount);
    const paidAtTimestamp = Date.parse(String(input.paidAt || ''));
    if (!Number.isFinite(paidAtTimestamp)) {
      throw new AppError('PAYMENT_TIME_INVALID', '请输入支付宝账单中的有效付款时间', { status: 400 });
    }
    const paidAt = new Date(paidAtTimestamp).toISOString();
    const normalized = normalizeTradeNo(input.tradeNo);
    const suppliedHash = hmacHex(this.config.secret, 'alipay-trade:v1', normalized);
    const prepared = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM recharge_orders WHERE id = ?').get(orderId);
      if (!row) throw new AppError('ORDER_NOT_FOUND', '订单不存在', { status: 404 });
      if (row.status === 'completed') return { row, completed: true };
      if (row.status !== 'payment_reported') {
        throw new AppError('ORDER_STATE_INVALID', '订单当前不能确认到账', { status: 409 });
      }
      if (row.review_expires_at && Date.parse(row.review_expires_at) <= this.#now().getTime()) {
        this.#audit(row.id, { type: 'admin', id: adminSession.user.id }, 'PAYMENT_VERIFICATION_FAILED', request, {
          reason: 'review_window_expired'
        });
        return {
          error: new AppError('REVIEW_WINDOW_EXPIRED', '付款核验窗口已过期，禁止直接入账', { status: 409 })
        };
      }
      if (paidMinor !== row.payable_amount_minor) {
        this.#audit(row.id, { type: 'admin', id: adminSession.user.id }, 'PAYMENT_VERIFICATION_FAILED', request, {
          reason: 'amount_mismatch'
        });
        return {
          error: new AppError('PAYMENT_AMOUNT_MISMATCH', '核验金额与订单应付金额不一致', { status: 409 })
        };
      }
      const createdAt = Date.parse(row.created_at);
      const expiresAt = Date.parse(row.expires_at);
      const paidSecond = Math.floor(paidAtTimestamp / 1000);
      const createdSecond = Math.floor(createdAt / 1000);
      const expiresSecond = Math.floor(expiresAt / 1000);
      if (paidSecond < createdSecond || paidSecond > expiresSecond) {
        this.#audit(row.id, { type: 'admin', id: adminSession.user.id }, 'PAYMENT_VERIFICATION_FAILED', request, {
          reason: 'payment_outside_window'
        });
        return {
          error: new AppError('PAYMENT_OUTSIDE_ORDER_WINDOW', '支付宝账单付款时间不在订单有效期内，禁止入账', { status: 409 })
        };
      }
      if (!row.trade_hash || !safeEqual(row.trade_hash, suppliedHash)) {
        this.#audit(row.id, { type: 'admin', id: adminSession.user.id }, 'PAYMENT_VERIFICATION_FAILED', request, {
          reason: 'trade_number_mismatch'
        });
        return {
          error: new AppError('PAYMENT_TRADE_MISMATCH', '管理员账单交易号与用户提交记录不一致', { status: 409 })
        };
      }
      const now = this.#now().toISOString();
      const changed = this.db.prepare(`
        UPDATE recharge_orders SET
          status = 'fulfilling', alipay_paid_at = ?, verified_at = ?, verified_by = ?, fulfillment_started_at = ?,
          fulfillment_attempts = fulfillment_attempts + 1, last_error_code = NULL,
          last_error_message = NULL, updated_at = ?, version = version + 1
        WHERE id = ? AND status = 'payment_reported'
      `).run(paidAt, now, String(adminSession.user.id), now, now, row.id);
      if (changed.changes !== 1) throw new AppError('ORDER_STATE_CHANGED', '订单状态已变化，请刷新后重试', { status: 409 });
      this.#audit(row.id, { type: 'admin', id: adminSession.user.id }, 'PAYMENT_VERIFIED', request, {
        paidAmount: minorToDecimal(paidMinor), paidAt, tradeLast6: row.trade_last6
      });
      return { row: this.db.prepare('SELECT * FROM recharge_orders WHERE id = ?').get(row.id), completed: false };
    })();
    if (prepared.error) throw prepared.error;
    if (prepared.completed) return publicOrder(prepared.row, { admin: true });
    return this.#fulfill(prepared.row, adminSession, request);
  }

  async retry(orderId, adminSession, request = {}) {
    const prepared = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM recharge_orders WHERE id = ?').get(orderId);
      if (!row) throw new AppError('ORDER_NOT_FOUND', '订单不存在', { status: 404 });
      if (row.status === 'completed') return { row, completed: true };
      const staleBefore = this.#now().getTime() - this.config.fulfillmentLeaseMinutes * 60000;
      const staleFulfillment = row.status === 'fulfilling' && Date.parse(row.fulfillment_started_at || '') <= staleBefore;
      if (row.status !== 'needs_attention' && !staleFulfillment) {
        throw new AppError('ORDER_RETRY_NOT_ALLOWED', '该订单当前不能恢复入账', { status: 409 });
      }
      if (!row.verified_at || !row.trade_hash) {
        throw new AppError('PAYMENT_NOT_VERIFIED', '订单缺少已核验的付款证据', { status: 409 });
      }
      const now = this.#now().toISOString();
      const changed = this.db.prepare(`
        UPDATE recharge_orders SET
          status = 'fulfilling', fulfillment_started_at = ?, fulfillment_attempts = fulfillment_attempts + 1,
          last_error_code = NULL, last_error_message = NULL, updated_at = ?, version = version + 1
        WHERE id = ? AND version = ?
      `).run(now, now, row.id, row.version);
      if (changed.changes !== 1) {
        throw new AppError('ORDER_STATE_CHANGED', '订单状态已变化，请刷新后重试', { status: 409 });
      }
      this.#audit(row.id, { type: 'admin', id: adminSession.user.id }, 'FULFILLMENT_RETRIED', request, {
        attempt: row.fulfillment_attempts + 1
      });
      return { row: this.db.prepare('SELECT * FROM recharge_orders WHERE id = ?').get(row.id), completed: false };
    })();
    if (prepared.completed) return publicOrder(prepared.row, { admin: true });
    return this.#fulfill(prepared.row, adminSession, request);
  }

  async #fulfill(row, principal, request) {
    const credit = microsToDecimal(row.credit_amount_micros);
    const attempt = Number(row.fulfillment_attempts);
    try {
      const redeemCode = openText(this.config.secret, 'redeem-code:v1', row.redeem_code, row.id);
      const fulfillmentInput = {
        idempotencyKey: `recharge-center-${row.id}-${attempt}`,
        code: redeemCode,
        value: Number(credit),
        userId: Number(row.user_id),
        notes: `充值中心订单 ${row.order_no}; 支付宝交易尾号 ${row.trade_last6}`
      };
      const result = principal.automatic
        ? await this.sub2api.createAndRedeemWithAdminKey(fulfillmentInput)
        : await this.sub2api.createAndRedeem(principal.upstreamToken, fulfillmentInput, principal.client);
      const redeem = result?.redeem_code || result?.redeemCode;
      const valid = redeem && redeem.code === redeemCode && redeem.type === 'balance' &&
        redeem.status === 'used' && Number(redeem.used_by) === Number(row.user_id) &&
        Math.abs(Number(redeem.value) - Number(credit)) < 1e-8;
      if (!valid) {
        throw new AppError('SUB2API_FULFILLMENT_UNVERIFIED', 'Sub2API 入账响应无法核验，禁止自动判定成功', { status: 502 });
      }
      const completed = this.db.transaction(() => {
        const current = this.db.prepare('SELECT * FROM recharge_orders WHERE id = ?').get(row.id);
        if (current.status === 'completed') return current;
        if (current.status !== 'fulfilling' || Number(current.fulfillment_attempts) !== attempt) {
          throw new AppError('FULFILLMENT_ATTEMPT_SUPERSEDED', '本次入账尝试已被新的恢复操作取代', { status: 409 });
        }
        const now = this.#now().toISOString();
        this.db.prepare(`
          UPDATE recharge_orders SET
            status = 'completed', completed_at = ?, updated_at = ?,
            last_error_code = NULL, last_error_message = NULL, version = version + 1
          WHERE id = ? AND status = 'fulfilling' AND fulfillment_attempts = ?
        `).run(now, now, row.id, attempt);
        this.#audit(row.id, principal.automatic
          ? { type: 'system', id: principal.actorId }
          : { type: 'admin', id: principal.user.id }, 'CREDIT_FULFILLED', request, {
          creditAmount: credit,
          redeemCodeSuffix: redeemCode.slice(-6)
        });
        return this.db.prepare('SELECT * FROM recharge_orders WHERE id = ?').get(row.id);
      })();
      return publicOrder(completed, { admin: true });
    } catch (error) {
      if (error?.code === 'FULFILLMENT_ATTEMPT_SUPERSEDED') throw error;
      const code = error?.code || 'FULFILLMENT_FAILED';
      const message = redactText(error?.message || 'Sub2API fulfillment failed');
      const marked = this.db.transaction(() => {
        const now = this.#now().toISOString();
        const changed = this.db.prepare(`
          UPDATE recharge_orders SET
            status = 'needs_attention', last_error_code = ?, last_error_message = ?,
            updated_at = ?, version = version + 1
          WHERE id = ? AND status = 'fulfilling' AND fulfillment_attempts = ?
        `).run(code, message, now, row.id, attempt);
        if (changed.changes !== 1) return false;
        this.#audit(row.id, { type: 'system' }, 'FULFILLMENT_NEEDS_ATTENTION', request, { code, attempt });
        return true;
      })();
      if (!marked) {
        throw new AppError('FULFILLMENT_ATTEMPT_SUPERSEDED', '本次入账尝试已被新的恢复操作取代', { status: 409 });
      }
      throw new AppError('FULFILLMENT_NEEDS_ATTENTION', '到账已核验，但自动入账结果不确定；请勿重复补款，管理员需执行恢复入账', {
        status: 502,
        details: { orderId: row.id, upstreamCode: code }
      });
    }
  }

  reject(orderId, admin, reason, request = {}) {
    if (!REJECTION_REASONS.has(reason)) {
      throw new AppError('REJECTION_REASON_INVALID', '请选择有效的拒绝原因', { status: 400 });
    }
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM recharge_orders WHERE id = ?').get(orderId);
      if (!row) throw new AppError('ORDER_NOT_FOUND', '订单不存在', { status: 404 });
      if (row.status !== 'payment_reported') {
        throw new AppError('ORDER_STATE_INVALID', '仅待核验订单可以拒绝', { status: 409 });
      }
      const now = this.#now().toISOString();
      this.db.prepare(`
        UPDATE recharge_orders SET status = 'rejected', rejected_at = ?, rejected_reason = ?,
          updated_at = ?, version = version + 1 WHERE id = ? AND status = 'payment_reported'
      `).run(now, reason, now, row.id);
      this.#audit(row.id, { type: 'admin', id: admin.id }, 'ORDER_REJECTED', request, { reason });
      return this.db.prepare('SELECT * FROM recharge_orders WHERE id = ?').get(row.id);
    });
    return publicOrder(transaction(), { admin: true });
  }

  stats() {
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) AS count, COALESCE(SUM(credit_amount_micros), 0) AS credit_micros
      FROM recharge_orders GROUP BY status
    `).all();
    return Object.fromEntries(rows.map((row) => [row.status, {
      count: row.count,
      creditAmount: microsToDecimal(row.credit_micros)
    }]));
  }
}

module.exports = {
  OrderService,
  publicOrder,
  randomOrderNo,
  randomPaymentMemo,
  randomRedeemCode,
  REJECTION_REASONS
};
