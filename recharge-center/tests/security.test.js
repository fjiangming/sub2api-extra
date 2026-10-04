'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hmacHex,
  maskEmail,
  microsToDecimal,
  minorToDecimal,
  normalizeTradeNo,
  parseRechargeAmount,
  parseMoneyToMinor,
  openText,
  sealText,
  safeEqual
} = require('../src/security');

test('money helpers preserve exact minor-unit values', () => {
  assert.equal(parseMoneyToMinor('100.37'), 10037);
  assert.equal(parseMoneyToMinor('0.01'), 1);
  assert.equal(minorToDecimal(10037), '100.37');
  assert.equal(microsToDecimal(10037000000), '100.37');
  assert.equal(microsToDecimal(5020000000), '50.20');
  assert.equal(microsToDecimal(5000000000), '50.00');
  assert.equal(microsToDecimal(5012345678), '50.12345678');
  assert.equal(parseRechargeAmount('50.25', 1, 100), 5025);
  assert.throws(() => parseRechargeAmount('0.99', 1, 100), { code: 'AMOUNT_TOO_LOW' });
  assert.throws(() => parseRechargeAmount('100.01', 1, 100), { code: 'AMOUNT_TOO_HIGH' });
  assert.throws(() => parseMoneyToMinor('1.001'), { code: 'AMOUNT_INVALID' });
});

test('numeric requests with more than two decimal places are rejected instead of rounded', () => {
  assert.throws(() => parseMoneyToMinor(10.001), { code: 'AMOUNT_INVALID' });
  assert.equal(parseMoneyToMinor(10.01), 1001);
});

test('Alipay trade numbers are normalized without weakening validation', () => {
  assert.equal(normalizeTradeNo('2026 1002-123456789012345678'), '20261002123456789012345678');
  assert.throws(() => normalizeTradeNo('merchant-order-123'), { code: 'ALIPAY_TRADE_NO_INVALID' });
  assert.throws(() => normalizeTradeNo('1234'), { code: 'ALIPAY_TRADE_NO_INVALID' });
});

test('financial identifiers use keyed hashes and constant-time comparison', () => {
  const one = hmacHex('a-secure-test-secret', 'alipay-trade:v1', '20261002123456789012345678');
  const two = hmacHex('another-secure-secret', 'alipay-trade:v1', '20261002123456789012345678');
  assert.notEqual(one, two);
  assert.equal(safeEqual(one, one), true);
  assert.equal(safeEqual(one, two), false);
  assert.equal(maskEmail('alice@example.com'), 'al***@example.com');
});

test('redeem capabilities are authenticated and encrypted at rest', () => {
  const secret = 'a-secure-test-secret-0123456789abcdef';
  const sealed = sealText(secret, 'redeem-code:v1', 'RC0123456789ABCDEF', 'order-1');
  assert.match(sealed, /^sealed:v1:/);
  assert.equal(sealed.includes('RC0123456789ABCDEF'), false);
  assert.equal(openText(secret, 'redeem-code:v1', sealed, 'order-1'), 'RC0123456789ABCDEF');
  assert.throws(() => openText(secret, 'redeem-code:v1', sealed, 'order-2'), { code: 'SEALED_VALUE_AUTH_FAILED' });
});
