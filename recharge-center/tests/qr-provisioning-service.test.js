'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { OrderService } = require('../src/order-service');
const { QrProvisioningService, normalizeOpaqueAlipayQrUrl } = require('../src/qr-provisioning-service');
const { createTestContext } = require('./helpers');

const COLLECTOR_ID = 'collector-one';
const RECIPIENT_ID = '2088123456789012';
const QR_URL = 'https://qr.alipay.com/fkx165AbCdEfGhIjKlMn';

function setup(t) {
  let now = new Date('2026-10-07T00:00:00.000Z');
  const context = createTestContext({
    paymentMode: 'personal_transfer_auto',
    automaticPersonalMode: true,
    transferQrSource: 'collector',
    collectorQrProvisioning: true,
    qrJobLeaseSeconds: 45,
    listenerCollectorId: COLLECTOR_ID,
    alipayRecipientId: RECIPIENT_ID,
    listenerSignatureToleranceSeconds: 60,
    listenerMaxEventAgeSeconds: 600,
    orderTtlMinutes: 3,
    autoReservationLimit: 100,
    maxActiveOrders: 1
  });
  t.after(() => context.cleanup());
  const alerts = [];
  const redemptions = [];
  const clock = () => now;
  const orders = new OrderService({
    db: context.db,
    config: context.config,
    sub2api: {
      async createAndRedeemWithAdminKey(input) {
        redemptions.push(input);
        return {
          redeem_code: {
            code: input.code,
            type: 'balance',
            value: input.value,
            status: 'used',
            used_by: input.userId
          }
        };
      }
    },
    alerts: { async send(event) { alerts.push(event); } },
    clock
  });
  const provisioning = new QrProvisioningService({
    db: context.db,
    config: context.config,
    alerts: { async send(event) { alerts.push(event); } },
    clock
  });
  return {
    ...context,
    alerts,
    redemptions,
    orders,
    provisioning,
    now: () => now,
    advance(milliseconds) { now = new Date(now.getTime() + milliseconds); }
  };
}

function user(id) {
  return { id, emailMasked: `u${id}***@example.com`, role: 'user' };
}

test('collector QR jobs stay pending until a verified opaque URL is encrypted at rest', async (t) => {
  const ctx = setup(t);
  const order = ctx.orders.create(user(1), '12.34');
  assert.equal(order.qrStatus, 'pending');
  assert.equal(order.qrAvailable, false);
  assert.throws(() => ctx.orders.paymentQrData(order.id, user(1)), { code: 'PAYMENT_QR_PENDING' });

  const job = ctx.provisioning.claim(COLLECTOR_ID);
  assert.equal(job.amount, '12.34');
  assert.match(job.memo, /^S2-[A-Za-z0-9_-]{16}$/);
  const completed = await ctx.provisioning.complete({
    collectorId: COLLECTOR_ID,
    jobId: job.jobId,
    leaseToken: job.leaseToken,
    qrUrl: QR_URL,
    observedAmount: job.amount,
    observedMemo: job.memo,
    observedRecipientId: RECIPIENT_ID,
    generatedAt: ctx.now().toISOString()
  });
  assert.equal(completed.qrStatus, 'ready');

  const stored = ctx.db.prepare(`
    SELECT payment_qr_hash, payment_qr_ciphertext, payment_qr_generated_at
    FROM recharge_orders WHERE id = ?
  `).get(order.id);
  assert.match(stored.payment_qr_ciphertext, /^sealed:v1:/);
  assert.equal(stored.payment_qr_ciphertext.includes(QR_URL), false);
  assert.equal(stored.payment_qr_hash.includes('fkx'), false);
  assert.equal(stored.payment_qr_generated_at, ctx.now().toISOString());
  assert.equal(ctx.orders.paymentQrData(order.id, user(1)).qrUrl, QR_URL);

  const replay = await ctx.provisioning.complete({
    collectorId: COLLECTOR_ID,
    jobId: job.jobId,
    leaseToken: job.leaseToken,
    qrUrl: QR_URL,
    observedAmount: job.amount,
    observedMemo: job.memo,
    observedRecipientId: RECIPIENT_ID,
    generatedAt: ctx.now().toISOString()
  });
  assert.equal(replay.duplicate, true);
});

test('amount, memo, and reused QR mismatches cancel without exposing a payable code', async (t) => {
  const ctx = setup(t);
  const first = ctx.orders.create(user(1), '20.00');
  const firstJob = ctx.provisioning.claim(COLLECTOR_ID);
  await assert.rejects(() => ctx.provisioning.complete({
    collectorId: COLLECTOR_ID,
    jobId: firstJob.jobId,
    leaseToken: firstJob.leaseToken,
    qrUrl: QR_URL,
    observedAmount: '20.01',
    observedMemo: firstJob.memo,
    observedRecipientId: RECIPIENT_ID,
    generatedAt: ctx.now().toISOString()
  }), { code: 'QR_AMOUNT_MISMATCH' });
  assert.equal(ctx.db.prepare('SELECT status FROM recharge_orders WHERE id = ?').get(first.id).status, 'cancelled');

  const second = ctx.orders.create(user(2), '21.00');
  const secondJob = ctx.provisioning.claim(COLLECTOR_ID);
  await ctx.provisioning.complete({
    collectorId: COLLECTOR_ID,
    jobId: secondJob.jobId,
    leaseToken: secondJob.leaseToken,
    qrUrl: QR_URL,
    observedAmount: secondJob.amount,
    observedMemo: secondJob.memo,
    observedRecipientId: RECIPIENT_ID,
    generatedAt: ctx.now().toISOString()
  });

  const third = ctx.orders.create(user(3), '22.00');
  const thirdJob = ctx.provisioning.claim(COLLECTOR_ID);
  await assert.rejects(() => ctx.provisioning.complete({
    collectorId: COLLECTOR_ID,
    jobId: thirdJob.jobId,
    leaseToken: thirdJob.leaseToken,
    qrUrl: QR_URL,
    observedAmount: thirdJob.amount,
    observedMemo: thirdJob.memo,
    observedRecipientId: RECIPIENT_ID,
    generatedAt: ctx.now().toISOString()
  }), { code: 'QR_URL_REUSED' });
  assert.equal(ctx.db.prepare('SELECT status FROM recharge_orders WHERE id = ?').get(third.id).status, 'cancelled');

  const fourth = ctx.orders.create(user(4), '23.00');
  const fourthJob = ctx.provisioning.claim(COLLECTOR_ID);
  await assert.rejects(() => ctx.provisioning.complete({
    collectorId: COLLECTOR_ID,
    jobId: fourthJob.jobId,
    leaseToken: fourthJob.leaseToken,
    qrUrl: 'https://qr.alipay.com/fkxWrongRecipient12345',
    observedAmount: fourthJob.amount,
    observedMemo: fourthJob.memo,
    observedRecipientId: 'different-recipient',
    generatedAt: ctx.now().toISOString()
  }), { code: 'QR_RECIPIENT_MISMATCH' });
  assert.equal(ctx.db.prepare('SELECT status FROM recharge_orders WHERE id = ?').get(fourth.id).status, 'cancelled');
  assert.equal(ctx.alerts.length, 3);
  assert.deepEqual(ctx.alerts.map((event) => event.anomalyCode), [
    'QR_AMOUNT_MISMATCH',
    'QR_URL_REUSED',
    'QR_RECIPIENT_MISMATCH'
  ]);
  assert.ok(ctx.alerts.every((event) => event.tradeLast6 === '' && !JSON.stringify(event).includes(QR_URL)));
});

test('expired QR leases can be reclaimed but old lease tokens cannot be replayed', async (t) => {
  const ctx = setup(t);
  ctx.orders.create(user(1), '30.00');
  const firstJob = ctx.provisioning.claim(COLLECTOR_ID);
  ctx.advance(46_000);
  await assert.rejects(() => ctx.provisioning.complete({
    collectorId: COLLECTOR_ID,
    jobId: firstJob.jobId,
    leaseToken: firstJob.leaseToken,
    qrUrl: QR_URL,
    observedAmount: firstJob.amount,
    observedMemo: firstJob.memo,
    observedRecipientId: RECIPIENT_ID,
    generatedAt: ctx.now().toISOString()
  }), { code: 'QR_JOB_LEASE_EXPIRED' });

  const secondJob = ctx.provisioning.claim(COLLECTOR_ID);
  assert.equal(secondJob.jobId, firstJob.jobId);
  assert.notEqual(secondJob.leaseToken, firstJob.leaseToken);
  await assert.rejects(() => ctx.provisioning.complete({
    collectorId: COLLECTOR_ID,
    jobId: secondJob.jobId,
    leaseToken: firstJob.leaseToken,
    qrUrl: QR_URL,
    observedAmount: secondJob.amount,
    observedMemo: secondJob.memo,
    observedRecipientId: RECIPIENT_ID,
    generatedAt: ctx.now().toISOString()
  }), { code: 'QR_JOB_LEASE_INVALID' });
  assert.equal((await ctx.provisioning.complete({
    collectorId: COLLECTOR_ID,
    jobId: secondJob.jobId,
    leaseToken: secondJob.leaseToken,
    qrUrl: QR_URL,
    observedAmount: secondJob.amount,
    observedMemo: secondJob.memo,
    observedRecipientId: RECIPIENT_ID,
    generatedAt: ctx.now().toISOString()
  })).accepted, true);
});

test('adapter failures cancel the order and emit a redacted standalone alert', async (t) => {
  const ctx = setup(t);
  const order = ctx.orders.create(user(1), '40.00');
  const job = ctx.provisioning.claim(COLLECTOR_ID);
  const failed = await ctx.provisioning.fail({
    collectorId: COLLECTOR_ID,
    jobId: job.jobId,
    leaseToken: job.leaseToken,
    failureCode: 'unexpected_page'
  });
  assert.equal(failed.qrStatus, 'failed');
  assert.equal(ctx.db.prepare('SELECT status FROM recharge_orders WHERE id = ?').get(order.id).status, 'cancelled');
  assert.equal(ctx.alerts[0].anomalyCode, 'QR_ADAPTER_UNEXPECTED_PAGE');
  assert.equal(JSON.stringify(ctx.alerts[0]).includes(job.memo), false);
});

test('collector payments cannot credit before QR readiness and credit exactly once after readiness', async (t) => {
  const pending = setup(t);
  const pendingOrder = pending.orders.create(user(1), '50.00');
  const pendingJob = pending.provisioning.claim(COLLECTOR_ID);
  const rejected = await pending.orders.acceptAutomaticPayment({
    collectorId: COLLECTOR_ID,
    eventId: 'evt-qr-pending-0001',
    source: 'browser',
    evidenceType: 'ledger_detail',
    tradeNo: '2026100700000000000000000001',
    amount: pendingOrder.payableAmount,
    paidAt: pendingOrder.createdAt,
    memo: pendingJob.memo,
    recipientId: '2088123456789012',
    direction: 'income',
    status: 'success'
  });
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.anomalyCode, 'PAYMENT_QR_NOT_READY');
  assert.equal(pending.redemptions.length, 0);

  const ready = setup(t);
  const readyOrder = ready.orders.create(user(2), '50.00');
  const readyJob = ready.provisioning.claim(COLLECTOR_ID);
  await ready.provisioning.complete({
    collectorId: COLLECTOR_ID,
    jobId: readyJob.jobId,
    leaseToken: readyJob.leaseToken,
    qrUrl: 'https://qr.alipay.com/fkxReadyQrForPayment123',
    observedAmount: readyJob.amount,
    observedMemo: readyJob.memo,
    observedRecipientId: RECIPIENT_ID,
    generatedAt: ready.now().toISOString()
  });
  const completed = await ready.orders.acceptAutomaticPayment({
    collectorId: COLLECTOR_ID,
    eventId: 'evt-qr-ready-000001',
    source: 'browser',
    evidenceType: 'ledger_detail',
    tradeNo: '2026100700000000000000000002',
    amount: readyOrder.payableAmount,
    paidAt: ready.now().toISOString(),
    memo: readyJob.memo,
    recipientId: '2088123456789012',
    direction: 'income',
    status: 'success'
  });
  assert.equal(completed.status, 'completed');
  assert.equal(ready.redemptions.length, 1);
  assert.equal(ready.redemptions[0].value, 50);
});

test('opaque QR URL validation accepts only direct Alipay fkx HTTPS URLs', () => {
  assert.equal(normalizeOpaqueAlipayQrUrl(QR_URL), QR_URL);
  for (const value of [
    'http://qr.alipay.com/fkx165AbCdEfGhIjKlMn',
    'https://evil.example/fkx165AbCdEfGhIjKlMn',
    'https://qr.alipay.com/fkx165AbCdEfGhIjKlMn?next=https://evil.example',
    'https://user@qr.alipay.com/fkx165AbCdEfGhIjKlMn',
    'https://qr.alipay.com/not-fkx-token'
  ]) {
    assert.throws(() => normalizeOpaqueAlipayQrUrl(value), { code: 'ALIPAY_QR_URL_INVALID' });
  }
});
