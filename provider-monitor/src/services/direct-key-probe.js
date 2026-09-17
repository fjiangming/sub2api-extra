const crypto = require('crypto');
const { performance } = require('node:perf_hooks');
const { AppError } = require('../errors');

const DIRECT_PROBE_PLATFORMS = new Set(['openai', 'anthropic', 'gemini']);
const RESPONSE_TEXT_LIMIT = 16000;
const DEFAULT_BASE_URLS = Object.freeze({
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com'
});

function normalizePlatform(value) {
  const platform = String(value || '').trim().toLowerCase();
  return ({ chatgpt: 'openai', 'open-ai': 'openai', claude: 'anthropic', google: 'gemini' })[platform] || platform || 'unknown';
}

function accountExportSignature(account) {
  return JSON.stringify([
    String(account?.name || '').trim(),
    normalizePlatform(account?.platform),
    String(account?.type || account?.account_type || '').trim().toLowerCase()
  ]);
}

function groupBy(items, keyForItem) {
  const groups = new Map();
  for (const item of items) {
    const key = keyForItem(item);
    const group = groups.get(key) || [];
    group.push(item);
    groups.set(key, group);
  }
  return groups;
}

function translateAccountExportError(error) {
  const remoteCode = String(error?.details?.remoteCode || '');
  const remoteStatus = Number(error?.details?.remoteStatus || error?.status) || null;
  if (remoteCode === 'STEP_UP_REQUIRED') {
    return new AppError('SUB2API_STEP_UP_REQUIRED', 'Sub2API 要求先完成近期 TOTP 验证，无法安全读取 Key 进行直连检测', {
      status: 403,
      details: { remoteCode, remoteStatus: remoteStatus || 403 }
    });
  }
  if (['STEP_UP_TOTP_NOT_ENABLED', 'TOTP_NOT_SETUP'].includes(remoteCode)) {
    return new AppError('SUB2API_TOTP_NOT_ENABLED', 'Sub2API 管理员未启用 TOTP，无法安全读取 Key 进行直连检测', {
      status: 409,
      details: { remoteCode, remoteStatus: remoteStatus || 403 }
    });
  }
  if (remoteCode === 'STEP_UP_ADMIN_API_KEY_FORBIDDEN') {
    return new AppError('SUB2API_SSO_REQUIRED', '当前 Sub2API 管理凭据无权导出账号 Key，请使用已验证的管理员会话', {
      status: 409,
      details: { remoteCode, remoteStatus: remoteStatus || 403 }
    });
  }
  if (remoteCode === 'STEP_UP_UNAVAILABLE') {
    return new AppError('SUB2API_STEP_UP_UNAVAILABLE', 'Sub2API 二次验证暂时不可用', {
      status: 503,
      retryable: true,
      details: { remoteCode, remoteStatus: remoteStatus || 503 }
    });
  }
  if (Number(error?.status) === 403) {
    return new AppError('SUB2API_KEY_EXPORT_FORBIDDEN', 'Sub2API 拒绝导出账号 Key，直连检测未执行', {
      status: 403,
      details: { remoteStatus: 403 }
    });
  }
  if ([404, 405, 501].includes(Number(error?.status))) {
    return new AppError('SUB2API_KEY_EXPORT_UNSUPPORTED', '当前 Sub2API 版本不支持管理员账号导出接口', {
      status: 409,
      details: { remoteStatus: Number(error.status) }
    });
  }
  return error;
}

function clearCredentialMap(credentials) {
  if (!(credentials instanceof Map)) return;
  for (const credential of credentials.values()) {
    if (!credential || typeof credential !== 'object') continue;
    credential.apiKey = '';
    credential.baseUrl = '';
  }
  credentials.clear();
}

class Sub2ApiProbeCredentialExporter {
  constructor({ sub2api }) {
    this.sub2api = sub2api;
  }

  async #request(rows) {
    let payload;
    try {
      payload = await this.sub2api.data('/api/v1/admin/accounts/data', {
        query: {
          ids: rows.map((account) => account.account_id).join(','),
          include_proxies: true
        }
      });
    } catch (error) {
      throw translateAccountExportError(error);
    }
    const exported = payload?.accounts;
    if (!Array.isArray(exported) || exported.length !== rows.length) {
      throw new AppError('SCHEMA_MISMATCH', 'Sub2API 账号导出结果与请求的 Key 集合不一致', {
        status: 502,
        details: { requested: rows.length, received: Array.isArray(exported) ? exported.length : null }
      });
    }
    payload = null;
    return exported;
  }

  #capture(credentials, source, item) {
    if (
      normalizePlatform(item?.platform) !== normalizePlatform(source.platform) ||
      String(item?.type || '').toLowerCase() !== String(source.account_type || '').toLowerCase()
    ) {
      throw new AppError('SCHEMA_MISMATCH', 'Sub2API 导出的账号与请求的 Key 不匹配', {
        status: 502,
        details: { accountId: String(source.account_id) }
      });
    }
    const platform = normalizePlatform(source.platform);
    const apiKey = String(item?.credentials?.api_key || '').trim();
    if (!apiKey) return;
    credentials.set(String(source.account_id), {
      apiKey,
      baseUrl: String(item.credentials?.base_url || DEFAULT_BASE_URLS[platform] || '').trim(),
      responsesSupported: item?.extra?.openai_responses_supported !== false,
      proxyConfigured: Boolean(item?.proxy_key)
    });
  }

  async export(rows) {
    const credentials = new Map();
    try {
      for (let offset = 0; offset < rows.length; offset += 50) {
        const batch = rows.slice(offset, offset + 50);
        const exported = await this.#request(batch);
        try {
          const sourceGroups = groupBy(batch, accountExportSignature);
          const exportedGroups = groupBy(exported, accountExportSignature);
          const matched = new Set();
          for (const [signature, sources] of sourceGroups) {
            const items = exportedGroups.get(signature) || [];
            if (sources.length !== 1 || items.length !== 1) continue;
            const source = sources[0];
            this.#capture(credentials, source, items[0]);
            matched.add(String(source.account_id));
          }
          for (const source of batch) {
            if (matched.has(String(source.account_id))) continue;
            const exact = await this.#request([source]);
            try {
              this.#capture(credentials, source, exact[0]);
            } finally {
              for (const item of exact) item.credentials = null;
            }
          }
        } finally {
          for (const item of exported) item.credentials = null;
        }
      }
      return credentials;
    } catch (error) {
      clearCredentialMap(credentials);
      throw error;
    }
  }
}

function openAiEndpoint(baseUrl, capability) {
  const normalized = String(baseUrl || DEFAULT_BASE_URLS.openai).trim().replace(/\/+$/, '');
  if (capability === 'responses') {
    if (/\/responses$/i.test(normalized)) return normalized;
    if (/\/chat\/completions$/i.test(normalized)) {
      return normalized.replace(/\/chat\/completions$/i, '/responses');
    }
    return /\/v1$/i.test(normalized) ? `${normalized}/responses` : `${normalized}/v1/responses`;
  }
  if (/\/chat\/completions$/i.test(normalized)) return normalized;
  if (/\/responses$/i.test(normalized)) return normalized.replace(/\/responses$/i, '/chat/completions');
  return /\/v1$/i.test(normalized) ? `${normalized}/chat/completions` : `${normalized}/v1/chat/completions`;
}

function anthropicEndpoint(baseUrl) {
  const normalized = String(baseUrl || DEFAULT_BASE_URLS.anthropic).trim().replace(/\/+$/, '');
  if (/\/messages$/i.test(normalized)) return normalized;
  return /\/v1$/i.test(normalized) ? `${normalized}/messages` : `${normalized}/v1/messages`;
}

function geminiEndpoint(baseUrl, model) {
  const normalized = String(baseUrl || DEFAULT_BASE_URLS.gemini).trim().replace(/\/+$/, '');
  const modelId = encodeURIComponent(String(model || '').replace(/^models\//i, ''));
  if (/\/models$/i.test(normalized)) return `${normalized}/${modelId}:streamGenerateContent?alt=sse`;
  if (/\/v1(?:beta)?$/i.test(normalized)) {
    return `${normalized}/models/${modelId}:streamGenerateContent?alt=sse`;
  }
  return `${normalized}/v1beta/models/${modelId}:streamGenerateContent?alt=sse`;
}

function canTryAlternateOpenAiEndpoint(error) {
  const status = Number(error?.details?.remoteStatus || error?.status);
  return ['CAPABILITY_UNSUPPORTED', 'REMOTE_REQUEST_FAILED'].includes(String(error?.code || '')) &&
    [400, 404, 405, 501].includes(status);
}

function eventError(data) {
  const value = data?.error;
  if (!value) return null;
  if (typeof value === 'string') return value;
  return String(value.message || value.code || '上游返回流式错误');
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((item) => item?.text || item?.content || '').join('');
}

function parseOpenAiResponsesEvent(event) {
  const data = event.data && typeof event.data === 'object' ? event.data : {};
  const type = String(data.type || event.event || '');
  const error = eventError(data);
  return {
    text: type === 'response.output_text.delta' ? String(data.delta || '') : '',
    completed: type === 'response.completed' || event.rawData === '[DONE]',
    error: error || (['error', 'response.failed', 'response.incomplete'].includes(type)
      ? String(data?.response?.error?.message || data?.error?.message || `上游返回 ${type}`)
      : null),
    model: data?.response?.model || null
  };
}

function parseOpenAiChatEvent(event) {
  if (event.rawData === '[DONE]') return { text: '', completed: true, error: null, model: null };
  const data = event.data && typeof event.data === 'object' ? event.data : {};
  const choice = data?.choices?.[0] || {};
  return {
    text: contentText(choice?.delta?.content) || String(choice?.text || ''),
    completed: choice.finish_reason != null,
    error: eventError(data),
    model: data.model || null
  };
}

function parseAnthropicEvent(event) {
  const data = event.data && typeof event.data === 'object' ? event.data : {};
  const type = String(data.type || event.event || '');
  return {
    text: type === 'content_block_delta' && data?.delta?.type === 'text_delta'
      ? String(data.delta.text || '')
      : '',
    completed: type === 'message_stop' || event.rawData === '[DONE]',
    error: eventError(data) || (type === 'error' ? 'Anthropic 上游返回流式错误' : null),
    model: data?.message?.model || null
  };
}

function parseGeminiEvent(event) {
  const data = event.data && typeof event.data === 'object' ? event.data : {};
  const candidates = Array.isArray(data.candidates) ? data.candidates : [];
  const text = candidates.flatMap((candidate) => candidate?.content?.parts || [])
    .map((part) => part?.text || '')
    .join('');
  return {
    text,
    completed: event.rawData === '[DONE]' || candidates.some((candidate) => candidate?.finishReason != null),
    error: eventError(data),
    model: data.modelVersion || null
  };
}

function createVerificationPrompt(prompt, marker) {
  return [
    `Connectivity verification: your response MUST begin with exactly ${marker}.`,
    'After that marker, complete the user task below. Do not omit, alter, translate, or explain the marker.',
    '',
    'User task:',
    String(prompt || '').trim()
  ].join('\n');
}

function cleanVerifiedResponse(responseText, marker) {
  return String(responseText || '').split(marker).join('').replace(/^\s*[:：\-–—]?\s*/, '').trim();
}

class DirectKeyProbeTransport {
  constructor({ http, config }) {
    this.http = http;
    this.config = config;
  }

  async #stream({ url, headers, body, timeoutMs, marker, parser, capability, model }) {
    const started = performance.now();
    let firstTokenMs = null;
    let responseText = '';
    let completed = false;
    let remoteModel = model;
    await this.http.requestSse(url, {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        ...headers
      },
      body,
      timeoutMs,
      maxResponseBytes: Math.min(this.config.maxResponseBytes, 2 * 1024 * 1024),
      maxRedirects: 0,
      retries: 0,
      onEvent: (event) => {
        const parsed = parser(event);
        if (parsed.error) {
          throw new AppError('UPSTREAM_PROBE_FAILED', parsed.error, {
            status: 502,
            details: { responseExcerpt: cleanVerifiedResponse(responseText, marker).slice(0, 500) }
          });
        }
        if (parsed.text) {
          if (firstTokenMs == null && parsed.text.trim()) {
            firstTokenMs = Math.round(performance.now() - started);
          }
          if (responseText.length < RESPONSE_TEXT_LIMIT) {
            responseText = (responseText + parsed.text).slice(0, RESPONSE_TEXT_LIMIT);
          }
        }
        if (parsed.completed) completed = true;
        if (parsed.model) remoteModel = String(parsed.model);
      }
    });
    const responseExcerpt = cleanVerifiedResponse(responseText, marker).slice(0, 500);
    if (!completed) {
      throw new AppError('INCOMPLETE_PROBE', '上游流式响应未返回明确的完成事件', {
        status: 502,
        details: { responseExcerpt }
      });
    }
    if (firstTokenMs == null) {
      throw new AppError('EMPTY_PROBE_RESPONSE', '上游流式响应没有返回文本内容', {
        status: 502,
        details: { responseExcerpt }
      });
    }
    if (!responseText.includes(marker)) {
      throw new AppError('PROMPT_VERIFICATION_FAILED', '上游响应未包含本次随机校验标记，不能证明配置的测试输入已被执行', {
        status: 502,
        details: { responseExcerpt }
      });
    }
    if (!cleanVerifiedResponse(responseText, marker)) {
      throw new AppError('EMPTY_PROBE_RESPONSE', '上游只返回了校验标记，没有回答测试输入', {
        status: 502,
        details: { responseExcerpt: null }
      });
    }
    return {
      capability,
      completed: true,
      promptVerified: true,
      firstTokenMs,
      durationMs: Math.round(performance.now() - started),
      responseText: cleanVerifiedResponse(responseText, marker).slice(0, 4000),
      model: remoteModel
    };
  }

  async #probeOpenAi(credential, model, prompt, marker, timeoutMs) {
    const order = credential.responsesSupported
      ? ['responses', 'chat_completions']
      : ['chat_completions', 'responses'];
    let lastError;
    for (let index = 0; index < order.length; index += 1) {
      const capability = order[index];
      const body = capability === 'responses'
        ? {
            model,
            input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
            stream: true
          }
        : {
            model,
            messages: [{ role: 'user', content: prompt }],
            stream: true
          };
      try {
        return await this.#stream({
          url: openAiEndpoint(credential.baseUrl, capability === 'responses' ? 'responses' : 'chat'),
          headers: { Authorization: `Bearer ${credential.apiKey}` },
          body,
          timeoutMs,
          marker,
          parser: capability === 'responses' ? parseOpenAiResponsesEvent : parseOpenAiChatEvent,
          capability,
          model
        });
      } catch (error) {
        lastError = error;
        if (index === order.length - 1 || !canTryAlternateOpenAiEndpoint(error)) throw error;
      }
    }
    throw lastError;
  }

  async probe({ platform, credential, model, prompt, timeoutMs }) {
    const normalizedPlatform = normalizePlatform(platform);
    if (!DIRECT_PROBE_PLATFORMS.has(normalizedPlatform)) {
      throw new AppError('DIRECT_PROBE_PLATFORM_UNSUPPORTED', `平台 ${normalizedPlatform} 暂不支持安全直连检测`, {
        status: 409
      });
    }
    if (!this.http?.requestSse) {
      throw new AppError('DIRECT_PROBE_TRANSPORT_UNAVAILABLE', 'Provider Monitor 流式直连客户端不可用', {
        status: 503
      });
    }
    if (!model) {
      throw new AppError('DIRECT_PROBE_MODEL_REQUIRED', '直连检测必须为该平台或 Key 配置具体模型', {
        status: 409
      });
    }
    if (!credential?.apiKey) {
      throw new AppError('DIRECT_PROBE_CREDENTIAL_UNAVAILABLE', '未能取得该 Key 的临时直连凭据', {
        status: 409
      });
    }
    if (credential.proxyConfigured) {
      throw new AppError('DIRECT_PROBE_PROXY_UNSUPPORTED', '该 Key 配置了账号代理，Provider Monitor 不会绕过代理直接检测', {
        status: 409
      });
    }

    const marker = `PMV_${crypto.randomBytes(12).toString('hex')}`;
    const verifiedPrompt = createVerificationPrompt(prompt, marker);
    if (normalizedPlatform === 'openai') {
      return this.#probeOpenAi(credential, model, verifiedPrompt, marker, timeoutMs);
    }
    if (normalizedPlatform === 'anthropic') {
      return this.#stream({
        url: anthropicEndpoint(credential.baseUrl),
        headers: {
          'x-api-key': credential.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: {
          model,
          max_tokens: 1024,
          messages: [{ role: 'user', content: verifiedPrompt }],
          stream: true
        },
        timeoutMs,
        marker,
        parser: parseAnthropicEvent,
        capability: 'anthropic_messages',
        model
      });
    }
    return this.#stream({
      url: geminiEndpoint(credential.baseUrl, model),
      headers: { 'x-goog-api-key': credential.apiKey },
      body: {
        contents: [{ role: 'user', parts: [{ text: verifiedPrompt }] }]
      },
      timeoutMs,
      marker,
      parser: parseGeminiEvent,
      capability: 'gemini_generate_content',
      model
    });
  }
}

module.exports = {
  DIRECT_PROBE_PLATFORMS,
  DirectKeyProbeTransport,
  Sub2ApiProbeCredentialExporter,
  clearCredentialMap,
  createVerificationPrompt,
  normalizePlatform,
  openAiEndpoint,
  anthropicEndpoint,
  geminiEndpoint
};
