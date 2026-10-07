'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { QrProvisionerAgent, safeFailureCode } = require('../tools/qr-provisioner-agent');

const RECIPIENT_ID = '2088123456789012';

function job(now) {
  return {
    jobId: '11111111-1111-4111-8111-111111111111',
    orderNo: 'RC-261007-ABCDEF12',
    amount: '12.34',
    memo: 'S2-0123456789abcdef',
    expiresAt: new Date(now.getTime() + 180_000).toISOString(),
    leaseToken: 'abcdefghijklmnopqrstuvwxyzABCDEFG1234567890',
    leaseExpiresAt: new Date(now.getTime() + 45_000).toISOString()
  };
}

test('QR provisioner passes sensitive fields in memory and completes without logging them', async () => {
  const now = new Date('2026-10-07T00:00:00.000Z');
  const claimed = job(now);
  const logs = [];
  let adapterInput;
  let completion;
  const agent = new QrProvisionerAgent({
    clock: () => now,
    expectedRecipientId: RECIPIENT_ID,
    logger: { info(line) { logs.push(line); }, error(line) { logs.push(line); } },
    adapter: {
      async healthCheck() { return { ready: true, recipientId: RECIPIENT_ID }; },
      async generate(input) {
        adapterInput = input;
        return {
          qrUrl: 'https://qr.alipay.com/fkxAgentGenerated12345',
          observedAmount: input.amount,
          observedMemo: input.memo,
          observedRecipientId: RECIPIENT_ID,
          generatedAt: now.toISOString()
        };
      }
    },
    client: {
      async qrHeartbeat() {},
      async claimQrJob() { return claimed; },
      async completeQrJob(input) { completion = input; return { accepted: true }; },
      async failQrJob() { assert.fail('successful jobs must not be failed'); }
    }
  });
  const result = await agent.runOnce();
  assert.equal(result.status, 'completed');
  assert.equal(adapterInput.amount, claimed.amount);
  assert.equal(adapterInput.memo, claimed.memo);
  assert.equal(completion.leaseToken, claimed.leaseToken);
  assert.equal(logs.join('\n').includes(claimed.memo), false);
  assert.equal(logs.join('\n').includes(completion.qrUrl), false);
});

test('adapter errors fail the leased job with a strict public failure code', async () => {
  const now = new Date('2026-10-07T00:00:00.000Z');
  const failures = [];
  const heartbeats = [];
  let claims = 0;
  const error = new Error('page contains private diagnostic details');
  error.code = 'unexpected_page';
  const agent = new QrProvisionerAgent({
    clock: () => now,
    expectedRecipientId: RECIPIENT_ID,
    logger: { info() {}, error() {} },
    adapter: {
      async healthCheck() { return { ready: true, recipientId: RECIPIENT_ID }; },
      async generate() { throw error; }
    },
    client: {
      async qrHeartbeat(input) { heartbeats.push(input); },
      async claimQrJob() { claims += 1; return job(now); },
      async completeQrJob() { assert.fail('failed adapters must not complete jobs'); },
      async failQrJob(input) { failures.push(input); }
    }
  });
  const result = await agent.runOnce();
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'unexpected_page');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].failureCode, 'unexpected_page');
  assert.equal(heartbeats.at(-1).ready, false);
  assert.equal((await agent.runOnce()).status, 'not_ready');
  assert.equal(claims, 1);
  assert.equal(safeFailureCode(new Error('secret value')), 'other');
});

test('QR provisioner refuses to claim work when the logged-in recipient does not match', async () => {
  const now = new Date('2026-10-07T00:00:00.000Z');
  let claimed = false;
  const agent = new QrProvisionerAgent({
    clock: () => now,
    expectedRecipientId: RECIPIENT_ID,
    logger: { info() {}, error() {} },
    adapter: {
      async healthCheck() { return { ready: true, recipientId: 'different-recipient' }; },
      async generate() { assert.fail('wrong accounts must not generate a QR'); }
    },
    client: {
      async qrHeartbeat(input) { assert.equal(input.ready, false); },
      async claimQrJob() { claimed = true; return job(now); }
    }
  });
  assert.equal((await agent.runOnce()).status, 'not_ready');
  assert.equal(claimed, false);
});

test('an uncertain completion is retried and never converted into a destructive failure', async () => {
  const now = new Date('2026-10-07T00:00:00.000Z');
  let attempts = 0;
  let failed = false;
  const agent = new QrProvisionerAgent({
    clock: () => now,
    expectedRecipientId: RECIPIENT_ID,
    logger: { info() {}, error() {} },
    adapter: {
      async healthCheck() { return { ready: true, recipientId: RECIPIENT_ID }; },
      async generate(input) {
        return {
          qrUrl: 'https://qr.alipay.com/fkxUncertainResult123',
          observedAmount: input.amount,
          observedMemo: input.memo,
          observedRecipientId: RECIPIENT_ID,
          generatedAt: now.toISOString()
        };
      }
    },
    client: {
      async qrHeartbeat() {},
      async claimQrJob() { return job(now); },
      async completeQrJob() {
        attempts += 1;
        throw new TypeError('network unavailable');
      },
      async failQrJob() { failed = true; }
    }
  });
  const result = await agent.runOnce();
  assert.equal(result.status, 'completion_unknown');
  assert.equal(attempts, 3);
  assert.equal(failed, false);
});
