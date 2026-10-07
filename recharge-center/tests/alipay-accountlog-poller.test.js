'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AlipayAccountLogPoller } = require('../src/alipay-accountlog-poller');

function config() {
  return {
    env: 'test',
    accountLogPollSeconds: 15,
    accountLogLookbackSeconds: 900,
    accountLogStaleSeconds: 60
  };
}

test('accountlog poller uses one global overlapping query, pages, sorts, and becomes ready', async () => {
  const now = new Date('2026-10-07T04:10:00.000Z');
  const calls = [];
  const accepted = [];
  const scheduled = [];
  const client = {
    async queryPage(input) {
      calls.push(input);
      if (input.pageNo === 1) {
        return {
          entries: [{ accountLogId: 'log-b', paidAt: '2026-10-07T04:09:00.000Z' }],
          pageNo: 1, pageSize: 1000, totalSize: 1001
        };
      }
      return {
        entries: [{ accountLogId: 'log-a', paidAt: '2026-10-07T04:08:00.000Z' }],
        pageNo: 2, pageSize: 1000, totalSize: 1001
      };
    }
  };
  const poller = new AlipayAccountLogPoller({
    client,
    orders: { async acceptAccountLogEntry(entry) { accepted.push(entry.accountLogId); } },
    config: config(),
    clock: () => now,
    setTimer(_callback, delay) { scheduled.push(delay); return { unref() {} }; },
    clearTimer() {}
  });
  const result = await poller.pollNow();
  assert.equal(result.entries, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].startTime.toISOString(), '2026-10-07T03:55:00.000Z');
  assert.equal(calls[0].endTime.toISOString(), '2026-10-07T04:10:01.000Z');
  assert.deepEqual(accepted, ['log-a', 'log-b']);
  assert.equal(poller.status().healthy, true);
  assert.equal(scheduled.at(-1), 15000);
  poller.close();
});

test('accountlog poller fails closed and honors a minimum rate-limit backoff', async () => {
  const scheduled = [];
  const error = new Error('rate limited');
  error.code = 'ALIPAY_ACCOUNTLOG_REJECTED';
  error.retryAfterMs = 60000;
  const poller = new AlipayAccountLogPoller({
    client: { async queryPage() { throw error; } },
    orders: { async acceptAccountLogEntry() {} },
    config: config(),
    clock: () => new Date('2026-10-07T04:10:00.000Z'),
    setTimer(_callback, delay) { scheduled.push(delay); return { unref() {} }; },
    clearTimer() {}
  });
  await assert.rejects(poller.pollNow(), { code: 'ALIPAY_ACCOUNTLOG_REJECTED' });
  assert.equal(poller.status().healthy, false);
  assert.throws(() => poller.assertReady(), { code: 'ACCOUNTLOG_POLLER_NOT_READY' });
  assert.equal(scheduled.at(-1), 60000);
  poller.close();
});
