'use strict';

const crypto = require('crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AlipayAccountLogClient,
  RESPONSE_KEY,
  canonicalizeParameters,
  formatShanghaiDateTime,
  parseShanghaiDateTime
} = require('../src/alipay-accountlog-client');

function keys() {
  const app = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const alipay = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { app, alipay };
}

function signedResponse(privateKey, result, mutate = (body) => body) {
  const source = JSON.stringify(result);
  const sign = crypto.sign('RSA-SHA256', Buffer.from(source), privateKey).toString('base64');
  return mutate(JSON.stringify({ [RESPONSE_KEY]: result, sign }));
}

function config() {
  return {
    env: 'test',
    alipayAppId: '2026100700000001',
    alipayGateway: 'https://openapi.alipay.com/gateway.do',
    accountLogRequestTimeoutMs: 1000
  };
}

test('accountlog client signs the exact request and verifies the raw Alipay response', async () => {
  const { app, alipay } = keys();
  let captured;
  const client = new AlipayAccountLogClient(config(), {
    privateKey: app.privateKey,
    publicKey: alipay.publicKey,
    clock: () => new Date('2026-10-07T04:05:06.000Z'),
    async fetch(url, options) {
      captured = { url, options };
      const parameters = Object.fromEntries(new URLSearchParams(options.body));
      const signature = Buffer.from(parameters.sign, 'base64');
      assert.equal(crypto.verify(
        'RSA-SHA256',
        Buffer.from(canonicalizeParameters(parameters)),
        app.publicKey,
        signature
      ), true);
      assert.equal(options.redirect, 'error');
      assert.deepEqual(JSON.parse(parameters.biz_content), {
        start_time: '2026-10-07 12:00:00',
        end_time: '2026-10-07 12:10:00',
        page_no: '1',
        page_size: '1000'
      });
      const result = {
        code: '10000', msg: 'Success', page_no: '1', page_size: '1000', total_size: '1',
        detail_list: [{
          account_log_id: '117007123456789151',
          alipay_order_no: '2026100722000000000001',
          merchant_order_no: '',
          trans_amount: '12.34',
          trans_dt: '2026-10-07 12:05:00',
          direction: '收入',
          trans_memo: '个人收钱码收款',
          other_account: '付款方***',
          bill_source: '支付宝',
          type: '收款'
        }]
      };
      return new Response(signedResponse(alipay.privateKey, result), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  const page = await client.queryPage({
    startTime: new Date('2026-10-07T04:00:00.000Z'),
    endTime: new Date('2026-10-07T04:10:00.000Z')
  });
  assert.equal(captured.url, config().alipayGateway);
  assert.equal(page.totalSize, 1);
  assert.deepEqual(page.entries[0], {
    accountLogId: '117007123456789151',
    alipayOrderNo: '2026100722000000000001',
    merchantOrderNo: null,
    amount: '12.34',
    amountMinor: 1234,
    paidAt: '2026-10-07T04:05:00.000Z',
    direction: 'income',
    memo: '个人收钱码收款',
    otherAccount: '付款方***',
    billSource: '支付宝',
    type: '收款'
  });
});

test('accountlog client rejects a response changed after Alipay signed it', async () => {
  const { app, alipay } = keys();
  const result = {
    code: '10000', msg: 'Success', page_no: '1', page_size: '1000', total_size: '1',
    detail_list: [{
      account_log_id: '117007123456789151', trans_amount: '12.34',
      trans_dt: '2026-10-07 12:05:00', direction: '收入'
    }]
  };
  const client = new AlipayAccountLogClient(config(), {
    privateKey: app.privateKey,
    publicKey: alipay.publicKey,
    async fetch() {
      return new Response(signedResponse(
        alipay.privateKey,
        result,
        (body) => body.replace('12.34', '99.99')
      ), { status: 200 });
    }
  });
  await assert.rejects(client.queryPage({
    startTime: new Date('2026-10-07T04:00:00.000Z'),
    endTime: new Date('2026-10-07T04:10:00.000Z')
  }), { code: 'ALIPAY_RESPONSE_SIGNATURE_INVALID' });
});

test('accountlog client rejects signed but inconsistent pagination metadata', async () => {
  const { app, alipay } = keys();
  const result = {
    code: '10000', msg: 'Success', page_no: '1', page_size: '2000', total_size: '0',
    detail_list: [{
      account_log_id: '117007123456789151', trans_amount: '12.34',
      trans_dt: '2026-10-07 12:05:00', direction: '收入'
    }]
  };
  const client = new AlipayAccountLogClient(config(), {
    privateKey: app.privateKey,
    publicKey: alipay.publicKey,
    async fetch() {
      return new Response(signedResponse(alipay.privateKey, result), { status: 200 });
    }
  });
  await assert.rejects(client.queryPage({
    startTime: new Date('2026-10-07T04:00:00.000Z'),
    endTime: new Date('2026-10-07T04:10:00.000Z'),
    pageSize: 1000
  }), { code: 'ALIPAY_ACCOUNTLOG_PAGE_INVALID' });
});

test('Alipay timestamps are interpreted explicitly in Asia/Shanghai', () => {
  assert.equal(formatShanghaiDateTime(new Date('2026-10-03T16:00:00.000Z')), '2026-10-04 00:00:00');
  assert.equal(parseShanghaiDateTime('2026-10-04 00:00:00'), '2026-10-03T16:00:00.000Z');
  assert.throws(() => parseShanghaiDateTime('2026-02-30 00:00:00'), { code: 'ALIPAY_ACCOUNTLOG_TIME_INVALID' });
});

test('accountlog client rejects RSA keys smaller than 2048 bits', () => {
  const weak = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  const strong = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => new AlipayAccountLogClient(config(), {
    privateKey: weak.privateKey,
    publicKey: strong.publicKey
  }), /至少 2048 位/);
  assert.throws(() => new AlipayAccountLogClient(config(), {
    privateKey: strong.privateKey,
    publicKey: weak.publicKey
  }), /至少 2048 位/);
});
