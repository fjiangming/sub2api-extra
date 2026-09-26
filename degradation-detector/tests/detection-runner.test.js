'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DetectionRunner,
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

  await runner.callModel({
    api: 'responses',
    model: 'gpt-image-test',
    prompt: 'draw an image',
    output_type: 'image',
    reasoning_effort: 'max',
    max_output_tokens: 512
  }, 'group-key');
  assert.deepEqual(calls[1][2].tools, [{ type: 'image_generation' }]);
  assert.deepEqual(calls[1][2].reasoning, { effort: 'max' });
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
