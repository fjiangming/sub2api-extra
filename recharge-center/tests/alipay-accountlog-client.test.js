'use strict';

const crypto = require('crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const { AlipayAccountLogPoller } = require('../src/alipay-accountlog-poller');
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

test('Alipay time formatting and parsing round-trip every hour including midnight and calendar boundaries', () => {
  for (const day of ['2026-11-11', '2027-01-01', '2028-02-29', '2028-03-01']) {
    for (let hour = 0; hour < 24; hour += 1) {
      for (const minute of ['00', '30', '59']) {
        for (const second of ['00', '59']) {
          const text = `${day} ${String(hour).padStart(2, '0')}:${minute}:${second}`;
          const instant = new Date(`${text.replace(' ', 'T')}+08:00`);
          assert.equal(formatShanghaiDateTime(instant), text);
          assert.equal(parseShanghaiDateTime(text), instant.toISOString());
        }
      }
    }
  }
});

test('Alipay bill timestamps reject hour 24 and invalid calendar or clock values', () => {
  for (const value of ['2026-11-11 24:00:00', '2026-11-11 24:30:00', '2026-11-11 25:00:00',
    '2026-11-11 00:60:00', '2026-11-11 00:00:60', '2026-02-29 00:10:00']) {
    assert.throws(() => parseShanghaiDateTime(value), { code: 'ALIPAY_ACCOUNTLOG_TIME_INVALID' }, value);
  }
});

test('signed midnight queries and receipts keep the real poller ready across day and year changes', async () => {
  const { app, alipay } = keys();
  const fixtures = [
    { now: '2026-11-10T16:00:00.000Z', timestamp: '2026-11-11 00:00:00',
      start: '2026-11-10 23:45:00', end: '2026-11-11 00:00:01',
      paidAt: '2026-11-11 00:00:00', paidUtc: '2026-11-10T16:00:00.000Z' },
    { now: '2026-11-10T16:30:00.000Z', timestamp: '2026-11-11 00:30:00',
      start: '2026-11-11 00:15:00', end: '2026-11-11 00:30:01',
      paidAt: '2026-11-11 00:25:00', paidUtc: '2026-11-10T16:25:00.000Z' },
    { now: '2026-11-10T17:00:00.000Z', timestamp: '2026-11-11 01:00:00',
      start: '2026-11-11 00:45:00', end: '2026-11-11 01:00:01',
      paidAt: '2026-11-11 00:55:00', paidUtc: '2026-11-10T16:55:00.000Z' },
    { now: '2026-12-31T16:00:00.000Z', timestamp: '2027-01-01 00:00:00',
      start: '2026-12-31 23:45:00', end: '2027-01-01 00:00:01',
      paidAt: '2027-01-01 00:00:00', paidUtc: '2026-12-31T16:00:00.000Z' }
  ];
  for (const fixture of fixtures) {
    const accepted = [];
    const clock = () => new Date(fixture.now);
    const client = new AlipayAccountLogClient(config(), {
      privateKey: app.privateKey, publicKey: alipay.publicKey, clock,
      async fetch(_url, options) {
        const parameters = Object.fromEntries(new URLSearchParams(options.body));
        assert.equal(parameters.timestamp, fixture.timestamp);
        assert.deepEqual(JSON.parse(parameters.biz_content), {
          start_time: fixture.start, end_time: fixture.end, page_no: '1', page_size: '1000'
        });
        assert.equal(crypto.verify('RSA-SHA256', Buffer.from(canonicalizeParameters(parameters)),
          app.publicKey, Buffer.from(parameters.sign, 'base64')), true);
        return new Response(signedResponse(alipay.privateKey, {
          code: '10000', msg: 'Success', page_no: '1', page_size: '1000', total_size: '1',
          detail_list: [{ account_log_id: '117007123456789151', trans_amount: '12.34',
            trans_dt: fixture.paidAt, direction: '收入' }]
        }), { status: 200 });
      }
    });
    const poller = new AlipayAccountLogPoller({ client, clock,
      config: { env: 'test', accountLogPollSeconds: 15, accountLogLookbackSeconds: 900, accountLogStaleSeconds: 60 },
      orders: { async acceptAccountLogEntry(entry) { accepted.push(entry); } },
      setTimer() { return { unref() {} }; }, clearTimer() {}
    });
    try {
      assert.equal((await poller.pollNow()).entries, 1);
      assert.equal(accepted.length, 1);
      assert.equal(accepted[0].paidAt, fixture.paidUtc);
      assert.equal(accepted[0].amountMinor, 1234);
      assert.equal(poller.status().lastSuccessAt, fixture.now);
      assert.equal(poller.status().healthy, true);
      assert.doesNotThrow(() => poller.assertReady());
    } finally { poller.close(); }
  }
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
