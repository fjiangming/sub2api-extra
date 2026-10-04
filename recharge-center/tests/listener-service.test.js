'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ListenerService, listenerSignature } = require('../src/listener-service');
const { RechargeListenerClient } = require('../tools/listener-client');
const { createTestContext } = require('./helpers');

test('listener requests require a fresh HMAC signature and a one-time nonce', (t) => {
  const secret = 'listener-secret-0123456789abcdef0123456789';
  let now = new Date('2026-10-03T00:00:00.000Z');
  const context = createTestContext({
    paymentMode: 'personal_transfer_auto',
    automaticPersonalMode: true,
    listenerSecret: secret,
    listenerCollectorId: 'collector-one',
    listenerMaxStaleSeconds: 30,
    listenerSignatureToleranceSeconds: 60
  });
  t.after(() => context.cleanup());
  const listener = new ListenerService({ db: context.db, config: context.config, clock: () => now });
  const rawBody = Buffer.from(JSON.stringify({
    collectorId: 'collector-one', version: '1.0.0', ready: true, observedAt: now.toISOString()
  }));
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const nonce = 'nonce-0123456789abcdef';
  const signature = listenerSignature(secret, timestamp, nonce, rawBody);
  const request = {
    rawBody,
    get(name) {
      return ({
        'x-recharge-timestamp': timestamp,
        'x-recharge-nonce': nonce,
        'x-recharge-signature': signature
      })[name.toLowerCase()];
    }
  };

  assert.equal(listener.status().healthy, false);
  listener.authenticate(request);
  listener.heartbeat({
    collectorId: 'collector-one', version: '1.0.0', ready: false, observedAt: now.toISOString()
  });
  assert.equal(listener.status().healthy, false);
  listener.heartbeat({
    collectorId: 'collector-one', version: '1.0.0', ready: true, observedAt: now.toISOString()
  });
  assert.equal(listener.status().healthy, true);
  assert.equal(listener.status().lastSuccessfulPollAt, now.toISOString());
  assert.throws(() => listener.authenticate(request), { code: 'LISTENER_REPLAY_REJECTED' });

  now = new Date(now.getTime() + 31_000);
  assert.equal(listener.status().healthy, false);
  assert.throws(() => listener.assertReady(), { code: 'PAYMENT_LISTENER_UNAVAILABLE' });
});

test('listener rejects a validly signed request from a different collector', (t) => {
  const context = createTestContext({
    paymentMode: 'personal_transfer_auto',
    automaticPersonalMode: true,
    listenerSecret: 'listener-secret-0123456789abcdef0123456789',
    listenerCollectorId: 'collector-one',
    listenerMaxStaleSeconds: 30,
    listenerSignatureToleranceSeconds: 60
  });
  t.after(() => context.cleanup());
  const listener = new ListenerService({ db: context.db, config: context.config });
  assert.throws(() => listener.heartbeat({
    collectorId: 'collector-two', ready: true, observedAt: new Date().toISOString()
  }), { code: 'LISTENER_COLLECTOR_REJECTED' });
});

test('listener client signs the exact body and pins its configured collector identity', async () => {
  const secret = 'listener-secret-0123456789abcdef0123456789';
  let captured;
  const client = new RechargeListenerClient({
    baseUrl: 'http://127.0.0.1:9874',
    allowInsecureHttp: true,
    secret,
    collectorId: 'collector-one',
    fetch: async (url, options) => {
      captured = { url: String(url), options };
      return new Response(JSON.stringify({ accepted: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });
  await client.sendPayment({
    collectorId: 'attacker-controlled',
    eventId: 'event-00000001',
    source: 'browser'
  });
  const body = JSON.parse(captured.options.body);
  assert.equal(body.collectorId, 'collector-one');
  assert.equal(captured.url, 'http://127.0.0.1:9874/api/listener/alipay/events');
  const timestamp = captured.options.headers['X-Recharge-Timestamp'];
  const nonce = captured.options.headers['X-Recharge-Nonce'];
  assert.equal(
    captured.options.headers['X-Recharge-Signature'],
    listenerSignature(secret, timestamp, nonce, Buffer.from(captured.options.body))
  );
});
