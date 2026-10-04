'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { loadConfig } = require('../src/config');

const base = {
  NODE_ENV: 'test',
  RECHARGE_CENTER_PAYMENT_MODE: 'personal_manual',
  RECHARGE_CENTER_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
  SUB2API_BASE_URL: 'http://127.0.0.1:8080'
};

const emailAlerts = {
  RECHARGE_CENTER_ALERT_CHANNELS: 'email',
  RECHARGE_CENTER_SMTP_HOST: 'smtp.mail.test',
  RECHARGE_CENTER_SMTP_PORT: '587',
  RECHARGE_CENTER_SMTP_REQUIRE_TLS: 'true',
  RECHARGE_CENTER_SMTP_USER: 'recharge-alerts',
  RECHARGE_CENTER_SMTP_PASSWORD: 'smtp-password-0123456789abcdef',
  RECHARGE_CENTER_SMTP_FROM: 'recharge-alerts@mail.test',
  RECHARGE_CENTER_ALERT_EMAIL_TO: 'ops-one@mail.test,ops-two@mail.test'
};

test('payment mode must be selected explicitly', () => {
  const { RECHARGE_CENTER_PAYMENT_MODE: _mode, ...withoutMode } = base;
  assert.throws(() => loadConfig(withoutMode), /RECHARGE_CENTER_PAYMENT_MODE/);
});

test('configuration normalizes amounts and paths', () => {
  const root = path.resolve(__dirname, '..');
  const config = loadConfig({
    ...base,
    RECHARGE_CENTER_QUICK_AMOUNTS: '100,10,100,50.25',
    RECHARGE_CENTER_MIN_AMOUNT: '1.25',
    RECHARGE_CENTER_MAX_AMOUNT: '500.50'
  }, { projectRoot: root });
  assert.deepEqual(config.quickAmounts, [10, 50.25, 100]);
  assert.equal(config.minAmount, 1.25);
  assert.equal(config.maxAmount, 500.5);
  assert.equal(config.sub2apiBaseUrl, 'http://127.0.0.1:8080');
  assert.equal(config.cookieSecure, false);
  assert.equal(config.passwordLoginEnabled, true);
  assert.equal(config.databasePath, path.join(root, 'data', 'recharge-center.db'));
});

test('official mode does not require a personal QR image', () => {
  assert.doesNotThrow(() => loadConfig({
    ...base,
    NODE_ENV: 'production',
    RECHARGE_CENTER_PAYMENT_MODE: 'sub2api_official',
    RECHARGE_CENTER_OFFICIAL_ALIPAY_INSTANCE_IDS: '1',
    RECHARGE_CENTER_SECRET: 'production-random-0123456789abcdef0123456789abcdef0123456789',
    RECHARGE_CENTER_PUBLIC_URL: 'https://pay.example.com',
    SUB2API_PUBLIC_URL: 'https://api.example.com'
  }));
});

test('official mode requires an allowlist of official Alipay provider instances', () => {
  assert.throws(() => loadConfig({
    ...base,
    RECHARGE_CENTER_PAYMENT_MODE: 'sub2api_official'
  }), /OFFICIAL_ALIPAY_INSTANCE_IDS/);
});

test('custom amount limits and quick amounts reject invalid precision or range', () => {
  assert.throws(() => loadConfig({ ...base, RECHARGE_CENTER_MIN_AMOUNT: '1.001' }), /MIN_AMOUNT/);
  assert.throws(() => loadConfig({
    ...base,
    RECHARGE_CENTER_MIN_AMOUNT: '10',
    RECHARGE_CENTER_MAX_AMOUNT: '20',
    RECHARGE_CENTER_QUICK_AMOUNTS: '5,15'
  }), /QUICK_AMOUNTS/);
});

test('production disables password proxy login by default', () => {
  const config = loadConfig({
    ...base,
    NODE_ENV: 'production',
    RECHARGE_CENTER_SECRET: 'production-random-0123456789abcdef0123456789abcdef0123456789',
    RECHARGE_CENTER_PUBLIC_URL: 'https://pay.example.com',
    SUB2API_PUBLIC_URL: 'https://api.example.com',
    ALIPAY_QR_IMAGE_PATH: __filename
  });
  assert.equal(config.passwordLoginEnabled, false);
});

test('production requires HTTPS, Secure cookies, and a QR image path', () => {
  assert.throws(() => loadConfig({
    ...base,
    NODE_ENV: 'production',
    RECHARGE_CENTER_PUBLIC_URL: 'http://pay.example.com',
    RECHARGE_CENTER_COOKIE_SECURE: 'false'
  }), /HTTPS.*收款码.*Secure Cookie|HTTPS.*Secure Cookie.*收款码|生产环境/);
});

test('production rejects the documented placeholder secret', () => {
  assert.throws(() => loadConfig({
    ...base,
    NODE_ENV: 'production',
    RECHARGE_CENTER_SECRET: 'replace-with-at-least-48-random-characters',
    RECHARGE_CENTER_PUBLIC_URL: 'https://pay.example.com',
    SUB2API_PUBLIC_URL: 'https://api.example.com',
    ALIPAY_QR_IMAGE_PATH: __filename
  }), /独立随机密钥/);
});

test('configured URLs cannot contain credentials or query data', () => {
  assert.throws(() => loadConfig({ ...base, SUB2API_BASE_URL: 'https://user:pass@example.com/?x=1' }), /不含账号/);
});

test('credit amount is fixed at one-to-one with the verified payment', () => {
  assert.throws(
    () => loadConfig({ ...base, RECHARGE_CENTER_CREDIT_MULTIPLIER: '2' }),
    /只允许设置为 1/
  );
  assert.doesNotThrow(() => loadConfig({ ...base, RECHARGE_CENTER_CREDIT_MULTIPLIER: '1' }));
});

test('personal transfer auto mode requires isolated credentials and forces a three-minute order window', () => {
  const config = loadConfig({
    ...base,
    RECHARGE_CENTER_PAYMENT_MODE: 'personal_transfer_auto',
    RECHARGE_CENTER_ORDER_TTL_MINUTES: '20',
    RECHARGE_CENTER_TRANSFER_QR_TEMPLATE: 'alipays://platformapi/startapp?appId=20000123&amount={amount}&memo={memo}',
    RECHARGE_CENTER_LISTENER_SECRET: 'listener-secret-0123456789abcdef0123456789',
    RECHARGE_CENTER_LISTENER_COLLECTOR_ID: 'collector-one',
    RECHARGE_CENTER_ALIPAY_RECIPIENT_ID: '2088123456789012',
    SUB2API_ADMIN_API_KEY: 'admin-api-key-0123456789',
    ...emailAlerts
  });
  assert.equal(config.orderTtlMinutes, 3);
  assert.equal(config.automaticPersonalMode, true);
  assert.equal(config.autoReservationLimit, 100);
  assert.equal(config.listenerMaxEventAgeSeconds, 600);
  assert.deepEqual(config.alertChannels, ['email']);
  assert.deepEqual(config.alertEmailTo, ['ops-one@mail.test', 'ops-two@mail.test']);
});

test('personal transfer auto mode requires standalone email alerts', () => {
  assert.throws(() => loadConfig({
    ...base,
    RECHARGE_CENTER_PAYMENT_MODE: 'personal_transfer_auto',
    RECHARGE_CENTER_TRANSFER_QR_TEMPLATE: 'alipays://platformapi/startapp?appId=20000123&amount={amount}&memo={memo}',
    RECHARGE_CENTER_LISTENER_SECRET: 'listener-secret-0123456789abcdef0123456789',
    RECHARGE_CENTER_LISTENER_COLLECTOR_ID: 'collector-one',
    RECHARGE_CENTER_ALIPAY_RECIPIENT_ID: '2088123456789012',
    SUB2API_ADMIN_API_KEY: 'admin-api-key-0123456789',
    RECHARGE_CENTER_ALERT_CHANNELS: 'webhook',
    RECHARGE_CENTER_ALERT_WEBHOOK_URL: 'https://alerts.example.test/recharge',
    RECHARGE_CENTER_ALERT_WEBHOOK_BEARER_TOKEN: 'webhook-token-0123456789abcdef0123456789'
  }), /必须启用 email/);
});

test('production standalone alert channels enforce TLS and credential isolation', () => {
  const production = {
    ...base,
    NODE_ENV: 'production',
    RECHARGE_CENTER_PAYMENT_MODE: 'sub2api_official',
    RECHARGE_CENTER_OFFICIAL_ALIPAY_INSTANCE_IDS: '1',
    RECHARGE_CENTER_SECRET: 'production-random-0123456789abcdef0123456789abcdef0123456789',
    RECHARGE_CENTER_PUBLIC_URL: 'https://pay.example.com',
    SUB2API_PUBLIC_URL: 'https://api.example.com',
    ...emailAlerts
  };
  assert.throws(() => loadConfig({
    ...production,
    RECHARGE_CENTER_SMTP_REQUIRE_TLS: 'false'
  }), /STARTTLS/);
  assert.throws(() => loadConfig({
    ...production,
    RECHARGE_CENTER_ALERT_CHANNELS: 'email,webhook',
    RECHARGE_CENTER_ALERT_WEBHOOK_URL: 'http://alerts.example.test/recharge',
    RECHARGE_CENTER_ALERT_WEBHOOK_BEARER_TOKEN: 'webhook-token-0123456789abcdef0123456789'
  }), /必须使用 HTTPS/);
  assert.throws(() => loadConfig({
    ...production,
    RECHARGE_CENTER_SMTP_PASSWORD: production.RECHARGE_CENTER_SECRET
  }), /不能复用/);
});

test('personal transfer templates must contain exact amount and memo placeholders on an Alipay target', () => {
  const automatic = {
    ...base,
    RECHARGE_CENTER_PAYMENT_MODE: 'personal_transfer_auto',
    RECHARGE_CENTER_LISTENER_SECRET: 'listener-secret-0123456789abcdef0123456789',
    RECHARGE_CENTER_LISTENER_COLLECTOR_ID: 'collector-one',
    RECHARGE_CENTER_ALIPAY_RECIPIENT_ID: '2088123456789012',
    SUB2API_ADMIN_API_KEY: 'admin-api-key-0123456789',
    ...emailAlerts
  };
  assert.throws(() => loadConfig({
    ...automatic,
    RECHARGE_CENTER_TRANSFER_QR_TEMPLATE: 'https://evil.example/pay?amount={amount}&memo={memo}'
  }), /TRANSFER_QR_TEMPLATE/);
  assert.throws(() => loadConfig({
    ...automatic,
    RECHARGE_CENTER_TRANSFER_QR_TEMPLATE: 'https://qr.alipay.com/pay?amount={amount}'
  }), /TRANSFER_QR_TEMPLATE/);
  assert.throws(() => loadConfig({
    ...automatic,
    RECHARGE_CENTER_TRANSFER_QR_TEMPLATE: 'alipays://platformapi/startapp?url=https%3A%2F%2Fevil.example%2Fpay&amount={amount}&memo={memo}'
  }), /TRANSFER_QR_TEMPLATE/);
  assert.throws(() => loadConfig({
    ...automatic,
    RECHARGE_CENTER_TRANSFER_QR_TEMPLATE: 'alipays://platformapi/not-startapp?amount={amount}&memo={memo}'
  }), /TRANSFER_QR_TEMPLATE/);
  assert.throws(() => loadConfig({
    ...automatic,
    RECHARGE_CENTER_TRANSFER_QR_TEMPLATE: 'alipays://platformapi/startapp?appId=REPLACE_FROM_OWN_LINK&amount={amount}&memo={memo}'
  }), /TRANSFER_QR_TEMPLATE/);
  assert.throws(() => loadConfig({
    ...automatic,
    RECHARGE_CENTER_LISTENER_SECRET: automatic.RECHARGE_CENTER_SMTP_PASSWORD,
    RECHARGE_CENTER_TRANSFER_QR_TEMPLATE: 'alipays://platformapi/startapp?amount={amount}&memo={memo}'
  }), /不能复用/);
});

test('production personal transfer mode cannot start before explicit end-to-end verification', () => {
  const productionAuto = {
    ...base,
    NODE_ENV: 'production',
    RECHARGE_CENTER_PAYMENT_MODE: 'personal_transfer_auto',
    RECHARGE_CENTER_SECRET: 'production-random-0123456789abcdef0123456789abcdef0123456789',
    RECHARGE_CENTER_PUBLIC_URL: 'https://pay.example.com',
    SUB2API_PUBLIC_URL: 'https://api.example.com',
    RECHARGE_CENTER_TRANSFER_QR_TEMPLATE: 'https://qr.alipay.com/pay?amount={amount}&memo={memo}',
    RECHARGE_CENTER_LISTENER_SECRET: 'listener-secret-0123456789abcdef0123456789',
    RECHARGE_CENTER_LISTENER_COLLECTOR_ID: 'collector-one',
    RECHARGE_CENTER_ALIPAY_RECIPIENT_ID: '2088123456789012',
    SUB2API_ADMIN_API_KEY: `admin-${'a'.repeat(64)}`,
    ...emailAlerts
  };
  assert.throws(() => loadConfig(productionAuto), /AUTO_MODE_VERIFIED/);
  assert.doesNotThrow(() => loadConfig({ ...productionAuto, RECHARGE_CENTER_AUTO_MODE_VERIFIED: 'true' }));
});

test('production personal transfer mode rejects documented credential placeholders', () => {
  const production = {
    ...base,
    NODE_ENV: 'production',
    RECHARGE_CENTER_PAYMENT_MODE: 'personal_transfer_auto',
    RECHARGE_CENTER_SECRET: 'production-random-0123456789abcdef0123456789abcdef0123456789',
    RECHARGE_CENTER_PUBLIC_URL: 'https://pay.example.com',
    SUB2API_PUBLIC_URL: 'https://api.example.com',
    RECHARGE_CENTER_TRANSFER_QR_TEMPLATE: 'alipays://platformapi/startapp?appId=20000123&amount={amount}&memo={memo}',
    RECHARGE_CENTER_LISTENER_SECRET: 'replace-with-a-different-48-character-random-secret',
    RECHARGE_CENTER_LISTENER_COLLECTOR_ID: 'collector-one',
    RECHARGE_CENTER_ALIPAY_RECIPIENT_ID: '2088123456789012',
    RECHARGE_CENTER_AUTO_MODE_VERIFIED: 'true',
    SUB2API_ADMIN_API_KEY: `admin-${'a'.repeat(64)}`,
    ...emailAlerts
  };
  assert.throws(() => loadConfig(production), /不能使用示例监听密钥/);
  assert.throws(() => loadConfig({
    ...production,
    RECHARGE_CENTER_LISTENER_SECRET: 'listener-secret-0123456789abcdef0123456789',
    RECHARGE_CENTER_ALIPAY_RECIPIENT_ID: '<详情页稳定收款标识>'
  }), /不能使用示例监听密钥/);
});
