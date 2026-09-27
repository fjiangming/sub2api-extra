'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { AppError } = require('../src/errors');
const {
  DetectionRunner,
  MODEL_REQUEST_RETRY_DELAYS_MS,
  assertPublicHttps,
  deterministicVerdict,
  extractHtml,
  imageDimensions,
  isPrivateAddress,
  responseImage,
  responseText,
  stripFence
} = require('../src/detection-runner');

test('text extraction covers all supported text protocols', () => {
  assert.equal(responseText({ output_text: 'responses' }, 'responses'), 'responses');
  assert.equal(responseText({
    output: [{ content: [{ type: 'output_text', text: 'nested' }] }]
  }, 'responses'), 'nested');
  assert.equal(responseText({ choices: [{ message: { content: 'chat' } }] }, 'chat_completions'), 'chat');
  assert.equal(responseText({ content: [{ type: 'text', text: 'claude' }] }, 'anthropic_messages'), 'claude');
  assert.equal(responseText({
    candidates: [{ content: { parts: [{ text: 'gemini' }] } }]
  }, 'gemini_generate_content'), 'gemini');
});

test('image extraction covers Images, Responses, and Gemini payloads', () => {
  assert.equal(responseImage({ data: [{ b64_json: 'aGVsbG8=' }] }).base64, 'aGVsbG8=');
  assert.equal(responseImage({
    output: [{ type: 'image_generation_call', result: 'cmVzcG9uc2Vz' }]
  }).base64, 'cmVzcG9uc2Vz');
  assert.deepEqual(responseImage({
    candidates: [{ content: { parts: [{ inlineData: { data: 'Z2VtaW5p', mimeType: 'image/png' } }] } }]
  }), { base64: 'Z2VtaW5p', mime: 'image/png', filename: undefined });
});

test('HTML extraction removes markdown fences and surrounding prose', () => {
  assert.equal(stripFence('```html\n<p>ok</p>\n```', 'html'), '<p>ok</p>');
  assert.equal(
    extractHtml('Here you go\n<!doctype html><html><body>ok</body></html>\nDone'),
    '<!doctype html><html><body>ok</body></html>'
  );
});

test('deterministic verdict distinguishes complete and degraded output', () => {
  const testCase = {
    output_type: 'html',
    validation: {
      min_bytes: 20,
      required_patterns: ['<body>', 'animation'],
      forbidden_patterns: ['cannot comply']
    }
  };
  const normal = deterministicVerdict(testCase, {
    text: '<html><body><style>animation: ride 1s</style></body></html>'
  });
  assert.equal(normal.status, 'normal');
  const degraded = deterministicVerdict(testCase, { text: '<html><body>short</body></html>' });
  assert.equal(degraded.status, 'degraded');
  assert.match(degraded.reason, /缺少预期特征/);
});

test('image dimensions and private network checks fail closed', async () => {
  const png = Buffer.alloc(24);
  png.set(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 0);
  png.writeUInt32BE(640, 16);
  png.writeUInt32BE(480, 20);
  assert.deepEqual(imageDimensions(png, 'image/png'), { width: 640, height: 480 });
  for (const address of ['127.0.0.1', '10.1.2.3', '100.64.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  await assert.rejects(
    () => assertPublicHttps(new URL('http://example.com/image.png')),
    (error) => error.code === 'ARTIFACT_URL_UNSAFE'
  );
  await assert.rejects(
    () => assertPublicHttps(new URL('https://127.0.0.1/image.png')),
    (error) => error.code === 'ARTIFACT_URL_UNSAFE'
  );
});

test('model requests use the configured gateway endpoint and API key', async () => {
  const calls = [];
  const runner = new DetectionRunner({
    config: {
      demoMode: false,
      requestTimeoutMs: 1000,
      maxResponseBytes: 1024 * 1024
    },
    store: {},
    sub2api: {
      gatewayJson: async (...args) => {
        calls.push(args);
        return { candidates: [] };
      },
      gatewayEventStream: async (...args) => {
        calls.push(args);
        const onEvent = args[3];
        await onEvent({ type: 'response.created', response: { id: 'resp_test' } });
        await onEvent({ type: 'response.output_text.delta', delta: '<html>streamed</html>' });
        await onEvent({
          type: 'response.completed',
          response: { id: 'resp_test', object: 'response', status: 'completed', output: [] }
        });
      }
    }
  });
  await runner.callModel({
    api: 'gemini_generate_content',
    model: 'models/gemini-test',
    prompt: 'hello',
    max_output_tokens: 512
  }, 'group-key');
  assert.equal(calls[0][0], '/v1beta/models/gemini-test:generateContent');
  assert.equal(calls[0][1], 'group-key');
  assert.equal(calls[0][2].contents[0].parts[0].text, 'hello');

  const responsePayload = await runner.callModel({
    api: 'responses',
    model: 'gpt-image-test',
    prompt: 'draw an image',
    output_type: 'image',
    reasoning_effort: 'max',
    max_output_tokens: 512
  }, 'group-key');
  assert.deepEqual(calls[1][2].tools, [{ type: 'image_generation' }]);
  assert.deepEqual(calls[1][2].reasoning, { effort: 'max' });
  assert.equal(calls[1][2].stream, true);
  assert.equal(calls[1][2].store, undefined);
  assert.equal(responsePayload.output_text, '<html>streamed</html>');
});

test('Responses streaming only returns output after a completed terminal event', async () => {
  const runner = new DetectionRunner({
    config: {
      demoMode: false,
      requestTimeoutMs: 60 * 1000,
      maxResponseBytes: 1024 * 1024
    },
    store: {},
    sub2api: {
      gatewayEventStream: async (_path, _key, _body, onEvent) => {
        await onEvent({ type: 'response.created', response: { id: 'resp_partial' } });
        await onEvent({ type: 'response.output_text.delta', delta: '<html>partial' });
      }
    },
    vault: {}
  });

  await assert.rejects(
    () => runner.callModel({
      api: 'responses',
      model: 'gpt-test',
      prompt: 'hello',
      output_type: 'html',
      max_output_tokens: 512
    }, 'group-key'),
    (error) => error.code === 'MODEL_STREAM_INCOMPLETE' && error.retryable === false
  );
});

test('Responses streaming rejects explicitly incomplete model output', async () => {
  const runner = new DetectionRunner({
    config: {
      demoMode: false,
      requestTimeoutMs: 60 * 1000,
      maxResponseBytes: 1024 * 1024
    },
    store: {},
    sub2api: {
      gatewayEventStream: async (_path, _key, _body, onEvent) => {
        await onEvent({
          type: 'response.incomplete',
          response: {
            id: 'resp_incomplete',
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' }
          }
        });
      }
    },
    vault: {}
  });

  await assert.rejects(
    () => runner.callModel({
      api: 'responses',
      model: 'gpt-test',
      prompt: 'hello',
      output_type: 'html',
      max_output_tokens: 512
    }, 'group-key'),
    (error) => error.code === 'MODEL_RESPONSE_INCOMPLETE' && /max_output_tokens/.test(error.message)
  );
});

test('retryable model failures reconnect at most five times with backoff', async () => {
  const delays = [];
  let attempts = 0;
  const runner = new DetectionRunner({
    config: {
      requestTimeoutMs: 60 * 1000,
      maxResponseBytes: 1024 * 1024
    },
    store: {},
    sub2api: {},
    vault: {},
    sleepFn: async (delayMs) => delays.push(delayMs)
  });
  runner.callModel = async () => {
    attempts += 1;
    throw new AppError('SUB2API_REQUEST_FAILED', 'upstream failed', {
      status: 502,
      retryable: true
    });
  };

  await assert.rejects(
    () => runner.callModelWithRetry({}, 'group-key', { runId: 9, monitorId: 3 }),
    (error) => error.code === 'SUB2API_REQUEST_FAILED' && error.retryAttempts === 5
  );
  assert.equal(attempts, 6);
  assert.deepEqual(delays, MODEL_REQUEST_RETRY_DELAYS_MS);
});

test('retryable model failures return normally after reconnecting succeeds', async () => {
  const delays = [];
  const timeouts = [];
  let attempts = 0;
  let now = 0;
  const runner = new DetectionRunner({
    config: {
      requestTimeoutMs: 60 * 1000,
      maxResponseBytes: 1024 * 1024
    },
    store: {},
    sub2api: {},
    vault: {},
    nowFn: () => now,
    sleepFn: async (delayMs) => {
      delays.push(delayMs);
      now += delayMs;
    }
  });
  runner.callModel = async (_testCase, _apiKey, options) => {
    attempts += 1;
    timeouts.push(options.timeoutMs);
    if (attempts < 3) {
      throw new AppError('SUB2API_REQUEST_FAILED', 'upstream failed', {
        status: 502,
        retryable: true
      });
    }
    return { output_text: 'reconnected' };
  };

  const payload = await runner.callModelWithRetry({}, 'group-key');

  assert.deepEqual(payload, { output_text: 'reconnected' });
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [1000, 2000]);
  assert.deepEqual(timeouts, [60000, 59000, 57000]);
});

test('retryable model failures stop when the total time budget is exhausted', async () => {
  const delays = [];
  let attempts = 0;
  let now = 0;
  const runner = new DetectionRunner({
    config: {
      requestTimeoutMs: 1500,
      maxResponseBytes: 1024 * 1024
    },
    store: {},
    sub2api: {},
    vault: {},
    nowFn: () => now,
    sleepFn: async (delayMs) => {
      delays.push(delayMs);
      now += delayMs;
    }
  });
  runner.callModel = async () => {
    attempts += 1;
    throw new AppError('SUB2API_TIMEOUT', 'upstream timed out', {
      status: 504,
      retryable: true
    });
  };

  await assert.rejects(
    () => runner.callModelWithRetry({}, 'group-key'),
    (error) => error.code === 'SUB2API_TIMEOUT' && error.retryAttempts === 1
  );
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [1000]);
});

test('a delayed backoff does not start a request after the total deadline', async () => {
  const delays = [];
  let attempts = 0;
  let now = 0;
  const runner = new DetectionRunner({
    config: {
      requestTimeoutMs: 1500,
      maxResponseBytes: 1024 * 1024
    },
    store: {},
    sub2api: {},
    vault: {},
    nowFn: () => now,
    sleepFn: async (delayMs) => {
      delays.push(delayMs);
      now += delayMs + 1000;
    }
  });
  runner.callModel = async () => {
    attempts += 1;
    throw new AppError('SUB2API_TIMEOUT', 'upstream timed out', {
      status: 504,
      retryable: true
    });
  };

  await assert.rejects(
    () => runner.callModelWithRetry({}, 'group-key'),
    (error) => error.code === 'SUB2API_TIMEOUT' && error.retryAttempts === 1
  );
  assert.equal(attempts, 1);
  assert.deepEqual(delays, [1000]);
});

test('non-retryable model failures are returned without reconnecting', async () => {
  let attempts = 0;
  const runner = new DetectionRunner({
    config: {
      requestTimeoutMs: 60 * 1000,
      maxResponseBytes: 1024 * 1024
    },
    store: {},
    sub2api: {},
    vault: {},
    sleepFn: assert.fail
  });
  runner.callModel = async () => {
    attempts += 1;
    throw new AppError('SUB2API_AUTH_EXPIRED', 'invalid key', { status: 401 });
  };

  await assert.rejects(
    () => runner.callModelWithRetry({}, 'group-key'),
    (error) => error.code === 'SUB2API_AUTH_EXPIRED' && error.retryAttempts === 0
  );
  assert.equal(attempts, 1);
});

test('a started streaming response is never resubmitted even when marked retryable', async () => {
  let attempts = 0;
  const runner = new DetectionRunner({
    config: {
      requestTimeoutMs: 60 * 1000,
      maxResponseBytes: 1024 * 1024
    },
    store: {},
    sub2api: {},
    vault: {},
    sleepFn: assert.fail
  });
  runner.callModel = async () => {
    attempts += 1;
    const error = new AppError('SUB2API_STREAM_INTERRUPTED', 'stream closed', {
      status: 502,
      retryable: true
    });
    error.responseStarted = true;
    throw error;
  };

  await assert.rejects(
    () => runner.callModelWithRetry({}, 'group-key'),
    (error) => error.code === 'SUB2API_STREAM_INTERRUPTED' && error.retryAttempts === 0
  );
  assert.equal(attempts, 1);
});

test('execution decrypts the configured service key from the credential vault', async () => {
  let usedKey;
  let completed;
  const currentMonitor = {
    id: 3,
    enabled: 1,
    user_id: '__degradation_detector_service__',
    group_id: '42',
    group_name: 'Configured Group',
    platform: 'openai',
    key_cipher: 'v1.encrypted-dedicated-key',
    key_fingerprint: 'fingerprint'
  };
  const store = {
    markRunRunning: () => ({ id: 7, prompt: 'test prompt' }),
    getMonitorById: () => currentMonitor,
    getPlatformTest: () => ({ platform: 'openai', output_type: 'text' }),
    nextScheduledAt: () => 123456789,
    completeRun: (_id, result) => {
      completed = result;
      return result;
    },
    failRun: assert.fail,
    pruneRuns: () => [],
    setMonitorEnabled: assert.fail
  };
  const runner = new DetectionRunner({
    config: {
      demoMode: false,
      historyLimit: 10,
      artifactDir: 'unused'
    },
    store,
    sub2api: {},
    vault: {
      decrypt: (groupId, cipher) => {
        assert.equal(groupId, '42');
        assert.equal(cipher, 'v1.encrypted-dedicated-key');
        return 'sk-service-only-1234567890';
      }
    }
  });
  runner.callModel = async (_testCase, apiKey) => {
    usedKey = apiKey;
    return {};
  };
  runner.normalizeOutput = async () => ({ text: 'answer', mime: 'text/plain' });
  runner.classify = async () => ({
    status: 'normal', quality: 'normal', reason: 'ok', source: 'test'
  });
  runner.persistArtifact = async () => null;

  await runner.execute(7, currentMonitor);

  assert.equal(usedKey, 'sk-service-only-1234567890');
  assert.equal(completed.status, 'normal');
});
