const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createTestContext } = require('./helpers');
const { NotificationService } = require('../src/services/notification-service');

test('Bark failures preserve safe upstream reasons and retry behavior', async (t) => {
  const deviceKey = 'TestBarkDeviceKey/42+QA';
  let upstream;
  const receiver = http.createServer((request, response) => {
    request.resume();
    response.writeHead(upstream.status, { 'Content-Type': upstream.contentType || 'application/json' });
    response.end(upstream.body);
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const context = createTestContext();
  t.after(async () => {
    await new Promise((resolve) => receiver.close(resolve));
    context.cleanup();
  });
  const notifications = new NotificationService({ db: context.db, config: context.config });
  const channel = notifications.save({
    name: 'Bark diagnostic test',
    type: 'bark',
    config: { endpoint: `http://127.0.0.1:${receiver.address().port}/push` },
    credentials: { deviceKey }
  });

  const cases = [
    {
      name: 'HTTP 400 database lookup error redacts the echoed Device Key',
      status: 400,
      body: JSON.stringify({
        code: 400,
        message: `failed to get device token: failed to get [${deviceKey}] device token from database`
      }),
      message: 'Bark returned HTTP 400: failed to get device token: failed to get [[REDACTED]] device token from database',
      retryable: false
    },
    {
      name: 'HTTP 200 business error also redacts URL-encoded Device Keys',
      status: 200,
      body: JSON.stringify({ code: 400, message: `invalid device_key ${encodeURIComponent(deviceKey)}` }),
      message: 'Bark rejected the notification: invalid device_key [REDACTED]',
      retryable: false
    },
    {
      name: 'error reason is sanitized before it is truncated',
      status: 400,
      body: JSON.stringify({ code: 400, message: ` ${deviceKey}\r\n${'x'.repeat(400)}` }),
      message: `Bark returned HTTP 400: ${(`[REDACTED]  ${'x'.repeat(400)}`).slice(0, 300)}`,
      retryable: false
    },
    {
      name: 'non-JSON proxy error does not expose its raw response body',
      status: 400,
      contentType: 'text/html',
      body: `<html><body>Proxy error for ${deviceKey}</body></html>`,
      message: 'Bark returned HTTP 400',
      retryable: false
    },
    {
      name: 'a malformed JSON message falls back to the HTTP status',
      status: 400,
      body: JSON.stringify({ code: 400, message: { device_key: deviceKey } }),
      message: 'Bark returned HTTP 400',
      retryable: false
    },
    {
      name: 'rate limit remains retryable',
      status: 429,
      body: JSON.stringify({ code: 429, message: 'too many requests' }),
      message: 'Bark returned HTTP 429: too many requests',
      retryable: true
    },
    {
      name: 'HTTP server error remains retryable',
      status: 503,
      body: JSON.stringify({ code: 503, message: 'service unavailable' }),
      message: 'Bark returned HTTP 503: service unavailable',
      retryable: true
    },
    {
      name: 'business server error without a message remains retryable',
      status: 200,
      body: JSON.stringify({ code: 500 }),
      message: 'Bark rejected the notification: unknown response',
      retryable: true
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      upstream = scenario;
      await assert.rejects(() => notifications.test(channel.id), {
        code: 'NOTIFICATION_FAILED',
        status: 502,
        message: scenario.message,
        retryable: scenario.retryable
      });
    });
  }
});
