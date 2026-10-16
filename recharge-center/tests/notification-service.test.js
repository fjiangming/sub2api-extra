'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  NotificationService,
  emailText,
  readBoundedResponse,
  sanitizeEvent
} = require('../src/notification-service');

const event = {
  eventId: 'recharge:event-00000001:PAYMENT_AMOUNT_MISMATCH',
  anomalyCode: 'PAYMENT_AMOUNT_MISMATCH',
  orderNo: 'RC202610030001',
  userId: 42,
  userEmailMasked: 'al***@example.test',
  amount: '50.01',
  tradeLast6: '345678',
  memoLast6: 'abcdef',
  occurredAt: '2026-10-03T08:01:02+08:00',
  tradeNo: '20261003000000000000345678',
  memo: 'S2-full-sensitive-memo',
  userEmail: 'alice@example.test'
};

function config(overrides = {}) {
  return {
    alertChannels: ['email'],
    alertTimeoutMs: 1000,
    smtpHost: 'smtp.mail.test',
    smtpPort: 587,
    smtpSecure: false,
    smtpRequireTls: true,
    smtpUser: 'recharge-alerts',
    smtpPassword: 'smtp-password',
    smtpFrom: 'recharge-alerts@mail.test',
    alertEmailTo: ['ops@mail.test'],
    alertWebhookUrl: null,
    alertWebhookBearerToken: null,
    ...overrides
  };
}

test('notification events are rebuilt from a strict redacted field allowlist', () => {
  const safe = sanitizeEvent(event);
  assert.deepEqual(Object.keys(safe), [
    'eventId', 'anomalyCode', 'orderNo', 'userId', 'userEmailMasked',
    'amount', 'tradeLast6', 'memoLast6', 'occurredAt'
  ]);
  assert.equal(safe.userId, '42');
  assert.equal(safe.userEmailMasked, event.userEmailMasked);
  assert.equal(JSON.stringify(safe).includes(event.tradeNo), false);
  assert.equal(JSON.stringify(safe).includes(event.memo), false);
  assert.throws(() => sanitizeEvent({ ...event, tradeLast6: 'not-six' }), /安全字段白名单/);
});

test('account identity rejects invalid IDs, unmasked emails, and control character injection', () => {
  for (const userId of [0, -1, 1.5, '42\n100', '42\n', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => sanitizeEvent({ ...event, userId }), /安全字段白名单/);
  }
  for (const userEmailMasked of [event.userEmail, 'al***@example.test\n伪造内容', 'al***@example.test\n',
    'al***@example.test\u0000', 'al***@example.test\u0085', 'al***@example.test\u202e', `al***@${'x'.repeat(320)}`]) {
    assert.throws(() => sanitizeEvent({ ...event, userEmailMasked }), /安全字段白名单/);
  }
  assert.throws(() => sanitizeEvent({ ...event, userId: null }), /安全字段白名单/);
  const longMaskedEmail = `al***@${'x'.repeat(63)}.${'x'.repeat(63)}.${'x'.repeat(63)}.test`;
  assert.equal(sanitizeEvent({ ...event, userEmailMasked: longMaskedEmail }).userEmailMasked, longMaskedEmail);
});

test('unattributed anomalies explicitly request review instead of guessing an account', () => {
  const safe = sanitizeEvent({ ...event, orderNo: null, userId: null, userEmailMasked: null });
  assert.equal(safe.userId, null);
  assert.equal(safe.userEmailMasked, null);
  assert.match(emailText(safe), /下单用户 ID: 未识别/);
  assert.match(emailText(safe), /下单账号（脱敏邮箱）: 归属未确认/);
  const { userId, userEmailMasked, ...legacyEvent } = event;
  assert.equal(sanitizeEvent(legacyEvent).userId, null);
  assert.match(emailText(sanitizeEvent({ ...event, userEmailMasked: null })), /未记录，请按用户 ID 查找/);
});

test('standalone SMTP delivery identifies the ordering account using only safe reconciliation fields', async () => {
  const messages = [];
  let closed = false;
  const service = new NotificationService(config(), {
    transport: {
      async sendMail(message) { messages.push(message); },
      close() { closed = true; }
    }
  });
  assert.deepEqual(await service.send(event), [{ channel: 'email', status: 'delivered' }]);
  assert.equal(messages.length, 1);
  const serialized = JSON.stringify(messages[0]);
  assert.match(messages[0].text, /PAYMENT_AMOUNT_MISMATCH/);
  assert.match(messages[0].text, /下单用户 ID: 42/);
  assert.match(messages[0].text, /下单账号（脱敏邮箱）: al\*{3}@example\.test/);
  assert.match(messages[0].text, /345678/);
  assert.equal(serialized.includes(event.tradeNo), false);
  assert.equal(serialized.includes(event.memo), false);
  assert.equal(serialized.includes(event.userEmail), false);
  service.close();
  assert.equal(closed, true);
});

test('standalone webhook uses bearer auth, rejects redirects, and does not resend permanent errors', async () => {
  const calls = [];
  const service = new NotificationService(config({
    alertChannels: ['webhook'],
    alertWebhookUrl: 'https://alerts.example.test/recharge',
    alertWebhookBearerToken: 'webhook-token-0123456789abcdef0123456789'
  }), {
    fetch: async (url, options) => {
      calls.push({ url, options });
      return new Response('rejected', { status: 401 });
    }
  });
  await assert.rejects(() => service.send(event), (error) => error.code === 'ALERT_DELIVERY_FAILED');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer webhook-token-0123456789abcdef0123456789');
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.source, 'recharge-center');
  assert.equal(payload.userId, '42');
  assert.equal(payload.userEmailMasked, event.userEmailMasked);
  assert.equal(JSON.stringify(payload).includes(event.tradeNo), false);
  assert.equal(JSON.stringify(payload).includes(event.userEmail), false);
});

test('webhook responses are bounded even when the server omits content-length', async () => {
  const response = new Response('x'.repeat(64 * 1024 + 1), { status: 200 });
  await assert.rejects(() => readBoundedResponse(response), (error) => error.code === 'ALERT_RESPONSE_TOO_LARGE');
});

test('all configured channels are attempted before a combined delivery failure is reported', async () => {
  let emailCalls = 0;
  let webhookCalls = 0;
  const service = new NotificationService(config({
    alertChannels: ['email', 'webhook'],
    alertWebhookUrl: 'https://alerts.example.test/recharge',
    alertWebhookBearerToken: 'webhook-token-0123456789abcdef0123456789'
  }), {
    transport: { async sendMail() { emailCalls += 1; } },
    fetch: async () => {
      webhookCalls += 1;
      return new Response('bad request', { status: 400 });
    }
  });
  await assert.rejects(() => service.send(event), (error) => {
    assert.equal(error.code, 'ALERT_DELIVERY_FAILED');
    assert.deepEqual(error.details.channels, ['webhook']);
    return true;
  });
  assert.equal(emailCalls, 1);
  assert.equal(webhookCalls, 1);
});
