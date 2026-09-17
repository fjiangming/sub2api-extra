const httpServer = require('node:http');
const test = require('node:test');
const assert = require('node:assert/strict');
const { AppError } = require('../src/errors');
const { HttpClient } = require('../src/http/client');
const {
  DirectKeyProbeTransport,
  Sub2ApiProbeCredentialExporter,
  clearCredentialMap
} = require('../src/services/direct-key-probe');
const { createTestContext } = require('./helpers');

function credential(overrides = {}) {
  return {
    apiKey: 'sk-direct-probe-secret',
    baseUrl: 'https://upstream.example',
    responsesSupported: true,
    proxyConfigured: false,
    ...overrides
  };
}

function markerFromPrompt(prompt) {
  const marker = String(prompt || '').match(/PMV_[a-f0-9]+/)?.[0];
  assert.ok(marker, 'probe request must contain a random verification marker');
  return marker;
}

test('OpenAI Responses direct probe forwards the configured prompt and measures streamed first token', async () => {
  const requests = [];
  const transport = new DirectKeyProbeTransport({
    config: { maxResponseBytes: 1024 * 1024 },
    http: {
      async requestSse(url, options) {
        requests.push({ url, options });
        const prompt = options.body.input[0].content[0].text;
        const marker = markerFromPrompt(prompt);
        assert.match(prompt, /计算 27 \+ 58/);
        assert.doesNotMatch(prompt, /^hi$/i);
        await new Promise((resolve) => setTimeout(resolve, 15));
        await options.onEvent({
          event: 'response.output_text.delta',
          rawData: '{}',
          data: { type: 'response.output_text.delta', delta: marker.slice(0, 8) }
        });
        await options.onEvent({
          event: 'response.output_text.delta',
          rawData: '{}',
          data: { type: 'response.output_text.delta', delta: `${marker.slice(8)} 85` }
        });
        await options.onEvent({
          event: 'response.completed',
          rawData: '{}',
          data: { type: 'response.completed', response: { model: 'gpt-probe' } }
        });
        return { eventCount: 3, bytes: 100 };
      }
    }
  });

  const result = await transport.probe({
    platform: 'openai',
    credential: credential(),
    model: 'gpt-probe',
    prompt: '计算 27 + 58，并只返回数字结果。',
    timeoutMs: 5000
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://upstream.example/v1/responses');
  assert.equal(requests[0].options.maxRedirects, 0);
  assert.equal(requests[0].options.body.stream, true);
  assert.ok(result.firstTokenMs >= 10);
  assert.equal(result.responseText, '85');
  assert.equal(result.promptVerified, true);
  assert.equal(result.completed, true);
  assert.equal(result.capability, 'responses');
});

test('OpenAI direct probe safely falls back from Responses to Chat Completions', async () => {
  const urls = [];
  const transport = new DirectKeyProbeTransport({
    config: { maxResponseBytes: 1024 * 1024 },
    http: {
      async requestSse(url, options) {
        urls.push(url);
        if (url.endsWith('/responses')) {
          throw new AppError('CAPABILITY_UNSUPPORTED', 'not found', {
            status: 404,
            details: { remoteStatus: 404 }
          });
        }
        const marker = markerFromPrompt(options.body.messages[0].content);
        await options.onEvent({
          event: 'message',
          rawData: '{}',
          data: { choices: [{ delta: { content: `${marker} 可靠性` }, finish_reason: null }] }
        });
        await options.onEvent({ event: 'message', rawData: '[DONE]', data: '[DONE]' });
        return { eventCount: 2, bytes: 80 };
      }
    }
  });

  const result = await transport.probe({
    platform: 'openai',
    credential: credential(),
    model: 'gpt-compatible',
    prompt: '将 reliability 翻译成中文。',
    timeoutMs: 5000
  });

  assert.deepEqual(urls, [
    'https://upstream.example/v1/responses',
    'https://upstream.example/v1/chat/completions'
  ]);
  assert.equal(result.capability, 'chat_completions');
  assert.equal(result.responseText, '可靠性');
});

test('canned greeting and relay pool errors cannot pass prompt verification', async (t) => {
  await t.test('greeting is rejected even with a completion event', async () => {
    const transport = new DirectKeyProbeTransport({
      config: { maxResponseBytes: 1024 * 1024 },
      http: {
        async requestSse(_url, options) {
          await options.onEvent({
            event: 'response.output_text.delta',
            rawData: '{}',
            data: { type: 'response.output_text.delta', delta: 'Hi! What can I help you with?' }
          });
          await options.onEvent({
            event: 'response.completed',
            rawData: '{}',
            data: { type: 'response.completed', response: {} }
          });
          return { eventCount: 2, bytes: 64 };
        }
      }
    });
    await assert.rejects(
      transport.probe({
        platform: 'openai', credential: credential(), model: 'gpt-probe',
        prompt: '计算 27 + 58。', timeoutMs: 5000
      }),
      (error) => {
        assert.equal(error.code, 'PROMPT_VERIFICATION_FAILED');
        assert.match(error.details.responseExcerpt, /What can I help you with/);
        return true;
      }
    );
  });

  await t.test('relay pool error remains a failed probe', async () => {
    const transport = new DirectKeyProbeTransport({
      config: { maxResponseBytes: 1024 * 1024 },
      http: {
        async requestSse(_url, options) {
          await options.onEvent({
            event: 'error',
            rawData: '{}',
            data: { type: 'error', error: { message: '当前号池额度正在恢复中，服务将很快自动恢复。' } }
          });
        }
      }
    });
    await assert.rejects(
      transport.probe({
        platform: 'openai', credential: credential(), model: 'gpt-probe',
        prompt: '计算 27 + 58。', timeoutMs: 5000
      }),
      (error) => {
        assert.equal(error.code, 'UPSTREAM_PROBE_FAILED');
        assert.match(error.message, /号池额度/);
        return true;
      }
    );
  });
});

test('Anthropic and Gemini direct probes use native streaming protocols without URL secrets', async () => {
  const requests = [];
  const transport = new DirectKeyProbeTransport({
    config: { maxResponseBytes: 1024 * 1024 },
    http: {
      async requestSse(url, options) {
        requests.push({ url, options });
        if (url.includes('/messages')) {
          const marker = markerFromPrompt(options.body.messages[0].content);
          await options.onEvent({
            event: 'content_block_delta', rawData: '{}',
            data: { type: 'content_block_delta', delta: { type: 'text_delta', text: `${marker} Claude OK` } }
          });
          await options.onEvent({ event: 'message_stop', rawData: '{}', data: { type: 'message_stop' } });
        } else {
          const marker = markerFromPrompt(options.body.contents[0].parts[0].text);
          await options.onEvent({
            event: 'message', rawData: '{}',
            data: {
              candidates: [{
                content: { parts: [{ text: `${marker} Gemini OK` }] },
                finishReason: 'STOP'
              }]
            }
          });
        }
        return { eventCount: 2, bytes: 80 };
      }
    }
  });

  const anthropic = await transport.probe({
    platform: 'anthropic', credential: credential(), model: 'claude-probe',
    prompt: '完成检测。', timeoutMs: 5000
  });
  const gemini = await transport.probe({
    platform: 'gemini', credential: credential(), model: 'gemini-probe',
    prompt: '完成检测。', timeoutMs: 5000
  });

  assert.equal(anthropic.responseText, 'Claude OK');
  assert.equal(gemini.responseText, 'Gemini OK');
  assert.equal(requests[0].options.headers['x-api-key'], 'sk-direct-probe-secret');
  assert.equal(requests[0].options.headers['anthropic-version'], '2023-06-01');
  assert.equal(requests[1].options.headers['x-goog-api-key'], 'sk-direct-probe-secret');
  assert.doesNotMatch(requests[1].url, /direct-probe-secret/);
});

test('credential export is ephemeral, detects account proxies and translates step-up failures', async () => {
  const exportedAccount = {
    name: 'OpenAI Key',
    platform: 'openai',
    type: 'apikey',
    credentials: { api_key: 'sk-export-only-secret', base_url: 'https://relay.example/v1' },
    extra: { openai_responses_supported: false },
    proxy_key: 'socks5|proxy|1080|user|password'
  };
  let calls = 0;
  const exporter = new Sub2ApiProbeCredentialExporter({
    sub2api: {
      async data() {
        calls += 1;
        return { accounts: [exportedAccount] };
      }
    }
  });
  const rows = [{ account_id: '7', name: 'OpenAI Key', platform: 'openai', account_type: 'apikey' }];
  const credentials = await exporter.export(rows);

  assert.equal(calls, 1);
  assert.equal(credentials.get('7').apiKey, 'sk-export-only-secret');
  assert.equal(credentials.get('7').proxyConfigured, true);
  assert.equal(exportedAccount.credentials, null);
  clearCredentialMap(credentials);
  assert.equal(credentials.size, 0);

  const blocked = new Sub2ApiProbeCredentialExporter({
    sub2api: {
      async data() {
        throw new AppError('SUB2API_REQUEST_FAILED', 'step up', {
          status: 403,
          details: { remoteCode: 'STEP_UP_REQUIRED', remoteStatus: 403 }
        });
      }
    }
  });
  await assert.rejects(blocked.export(rows), { code: 'SUB2API_STEP_UP_REQUIRED' });
});

test('HttpClient parses SSE incrementally and rejects redirects', async (t) => {
  const server = httpServer.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/stream' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: token\ndata: {"value":"a"}\n');
    setTimeout(() => res.end('\ndata: [DONE]\n\n'), 5);
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const context = createTestContext();
  t.after(() => context.cleanup());
  const client = new HttpClient(context.config);
  const base = `http://127.0.0.1:${server.address().port}`;
  const events = [];

  const result = await client.requestSse(`${base}/stream`, {
    timeoutMs: 1000,
    maxResponseBytes: 1024,
    onEvent: (event) => events.push(event)
  });
  assert.equal(result.eventCount, 2);
  assert.deepEqual(events.map((event) => event.event), ['token', 'message']);
  assert.equal(events[0].data.value, 'a');
  assert.equal(events[1].rawData, '[DONE]');
  await assert.rejects(client.requestSse(`${base}/redirect`, { timeoutMs: 1000 }), {
    code: 'REDIRECT_NOT_ALLOWED'
  });
});
