'use strict';

const { Agent, fetch: undiciFetch } = require('undici');
const { AppError } = require('./errors');

const UNDICI_TIMEOUT_CODES = new Set([
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT'
]);

const SAFE_PRECONNECT_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN'
]);

const STREAM_INTERRUPTION_CODES = new Set([
  'upstream_http2_stream_error',
  'upstream_stream_read_error',
  'upstream_stream_truncated'
]);

function unwrap(payload) {
  if (payload?.success === false || (payload?.code != null && ![0, 200].includes(Number(payload.code)))) {
    throw new AppError(
      'SUB2API_API_ERROR',
      payload?.message || payload?.error?.message || 'Sub2API 请求失败',
      {
        status: 502,
        details: { upstreamCode: payload?.code ?? payload?.error?.code ?? null }
      }
    );
  }
  return Object.prototype.hasOwnProperty.call(payload || {}, 'data') ? payload.data : payload;
}

async function readLimited(response, maxBytes) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) {
    throw new AppError('UPSTREAM_RESPONSE_TOO_LARGE', '上游响应超过大小限制', { status: 502 });
  }
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      try { await response.body.cancel(); } catch {}
      throw new AppError('UPSTREAM_RESPONSE_TOO_LARGE', '上游响应超过大小限制', { status: 502 });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

function parsePayload(raw) {
  if (!raw || raw.length === 0) return null;
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    return { message: raw.toString('utf8').slice(0, 1000) };
  }
}

async function readEventStream(response, maxBytes, onEvent) {
  if (!response.body) {
    throw new AppError('SUB2API_STREAM_EMPTY', 'Sub2API 没有返回流式响应内容', { status: 502 });
  }

  const decoder = new TextDecoder();
  let pending = '';
  let total = 0;
  let events = 0;
  let stopped = false;

  const dispatch = async (block) => {
    const lines = block.split(/\r\n|\r|\n/);
    const eventName = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data || data.trim() === '[DONE]') return;

    let event;
    try {
      event = JSON.parse(data);
      if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('invalid event');
    } catch {
      throw new AppError('SUB2API_STREAM_INVALID', 'Sub2API 返回了无效的流式事件', { status: 502 });
    }
    if (!event.type && eventName) event.type = eventName;
    events += 1;
    stopped = await onEvent(event) === false;
  };

  // Do not wait for EOF (or a broken socket) after the caller accepts a terminal event.
  const iterator = response.body[Symbol.asyncIterator]();
  try {
    while (!stopped) {
      const { value: chunk, done } = await iterator.next();
      if (done) break;
      const buffer = Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        throw new AppError('UPSTREAM_RESPONSE_TOO_LARGE', '上游响应超过大小限制', { status: 502 });
      }
      pending += decoder.decode(buffer, { stream: true });
      let boundary;
      while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(pending))) {
        const block = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index + boundary[0].length);
        await dispatch(block);
        if (stopped) break;
      }
    }

    if (!stopped) {
      pending += decoder.decode();
      if (pending.trim()) await dispatch(pending);
    }
    return { bytes: total, events };
  } finally {
    // Cancellation must not replace a valid terminal event or block the request deadline.
    Promise.resolve().then(() => iterator.return?.()).catch(() => {});
  }
}

function isPermanentModelFailure(code, message) {
  return /auth|api[ _-]?key|permission|forbidden|insufficient|quota|credit|balance|billing|invalid[ _-]?(request|argument|param)|unsupported|not[ _-]?found|context.{0,20}(window|length)|max_output_tokens|content[ _-]?filter|safety/i.test(`${code || ''} ${message || ''}`);
}

function isTransientModelFailure(code, message) {
  const text = `${code || ''} ${message || ''}`.toLowerCase();
  if (isPermanentModelFailure(code, message)) return false;
  return isUncertainModelFailure(code, message) ||
    /^(upstream_error|server_error|internal_error|internal_server_error|overloaded_error|api_error|rate_limit_error|rate_limit_exceeded|timeout|stream_timeout|upstream_timeout)$/i.test(String(code || '')) ||
    /maximum stream duration|temporar(?:y|ily)|overload|timed? ?out|timeout|connection (reset|closed)|service unavailable/.test(text);
}

function isUncertainModelFailure(code, message) {
  if (isPermanentModelFailure(code, message)) return false;
  return STREAM_INTERRUPTION_CODES.has(String(code || '').toLowerCase()) ||
    /upstream HTTP\/2 stream failed|upstream response stream (?:was interrupted|ended before completion)/i.test(String(message || ''));
}

function retryAfterMs(value, now = Date.now()) {
  if (value == null || String(value).trim() === '') return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

function httpFailure(response, payload, inference) {
  const upstreamCode = payload?.error?.code || payload?.error?.type || payload?.code || '';
  const message = errorMessage(payload, response.status);
  const transient = isTransientModelFailure(upstreamCode, message);
  const uncertain = isUncertainModelFailure(upstreamCode, message);
  const error = new AppError(response.status === 401 ? 'SUB2API_AUTH_EXPIRED' : 'SUB2API_REQUEST_FAILED', message, {
    status: response.status === 401 ? 401 : response.status === 403 ? 403 : 502,
    retryable: inference ? [429, 503].includes(response.status) && !uncertain && !isPermanentModelFailure(upstreamCode, message)
      : response.status === 429 || response.status >= 500,
    details: { upstreamStatus: response.status, upstreamCode: String(upstreamCode).slice(0, 80) }
  });
  error.retryAfterMs = retryAfterMs(response.headers.get('retry-after'));
  error.recoverable = inference && [429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529].includes(response.status) &&
    (transient || (!upstreamCode && !isPermanentModelFailure(upstreamCode, message)));
  error.outcomeUnknown = inference && (uncertain || [502, 504, 520, 521, 522, 523, 524].includes(response.status));
  return error;
}

function errorMessage(payload, status) {
  return payload?.error?.message || payload?.message || `Sub2API 返回 HTTP ${status}`;
}

function isTimeoutError(error) {
  return error?.name === 'AbortError' ||
    UNDICI_TIMEOUT_CODES.has(error?.code) ||
    UNDICI_TIMEOUT_CODES.has(error?.cause?.code);
}

function isSafePreconnectError(error) {
  return SAFE_PRECONNECT_CODES.has(error?.code) || SAFE_PRECONNECT_CODES.has(error?.cause?.code);
}

function canRecoverTransport(error) {
  const code = error?.cause?.code || error?.code || '';
  return isTimeoutError(error) || ['UND_ERR_SOCKET', 'ECONNRESET', 'ECONNABORTED', 'EPIPE',
    'ERR_HTTP2_STREAM_ERROR', 'ERR_HTTP2_SESSION_ERROR', 'ERR_HTTP2_GOAWAY_SESSION'].includes(code) ||
    /socket|connection (reset|closed)|terminated/i.test(String(error?.message || ''));
}

function timeoutMessage(timeoutMs) {
  const seconds = Math.max(1, Math.round(Number(timeoutMs) / 1000));
  if (seconds % 60 === 0) return `Sub2API 请求在 ${seconds / 60} 分钟内未完成`;
  return `Sub2API 请求在 ${seconds} 秒内未完成`;
}

function asItems(payload) {
  const data = unwrap(payload);
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

class Sub2ApiClient {
  constructor(config, fetchImpl) {
    this.config = config;
    this.fetch = fetchImpl || undiciFetch;
    this.dispatcher = fetchImpl ? null : new Agent({
      connectTimeout: Math.min(config.requestTimeoutMs, 30000),
      headersTimeout: config.requestTimeoutMs + 5000,
      bodyTimeout: config.requestTimeoutMs + 5000
    });
  }

  async close() {
    await this.dispatcher?.close();
  }

  async request(path, options = {}) {
    if (!this.config.sub2apiBaseUrl) {
      throw new AppError('SUB2API_NOT_CONFIGURED', '未配置 SUB2API_BASE_URL', { status: 503 });
    }
    const url = new URL(path, `${this.config.sub2apiBaseUrl}/`);
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs || this.config.requestTimeoutMs;
    const timeout = setTimeout(
      () => controller.abort(),
      timeoutMs
    );
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    let requestAccepted = false;
    try {
      const response = await this.fetch(url, {
        method: options.method || 'GET',
        headers: {
          accept: 'application/json',
          ...(options.body == null ? {} : { 'content-type': 'application/json' }),
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          ...(options.headers || {})
        },
        body: options.body == null ? undefined : JSON.stringify(options.body),
        redirect: 'error',
        signal,
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {})
      });
      requestAccepted = response.ok;
      const raw = await readLimited(response, options.maxBytes || this.config.maxResponseBytes);
      const payload = parsePayload(raw);
      if (!response.ok) {
        throw httpFailure(response, payload, options.inference);
      }
      return payload || {};
    } catch (error) {
      if (options.signal?.aborted) throw new AppError('DETECTION_CANCELLED', '检测已停止', { status: 409 });
      if (error instanceof AppError) {
        error.responseStarted = requestAccepted;
        throw error;
      }
      if (options.inference) {
        const safe = !requestAccepted && isSafePreconnectError(error);
        const failure = new AppError(safe ? (isTimeoutError(error) ? 'SUB2API_TIMEOUT' : 'SUB2API_UNAVAILABLE') : 'SUB2API_REQUEST_INTERRUPTED',
          safe ? '无法连接 Sub2API' : 'Sub2API 响应中断，本次请求结果未知', { status: 502, retryable: safe });
        failure.responseStarted = !safe;
        failure.recoverable = !safe && canRecoverTransport(error);
        failure.outcomeUnknown = !safe;
        throw failure;
      }
      if (isTimeoutError(error)) {
        throw new AppError('SUB2API_TIMEOUT', timeoutMessage(timeoutMs), {
          status: 504,
          retryable: true
        });
      }
      throw new AppError('SUB2API_UNAVAILABLE', '无法连接 Sub2API', {
        status: 503,
        retryable: true
      });
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }

  async requestEventStream(path, options = {}, onEvent = async () => {}) {
    if (!this.config.sub2apiBaseUrl) {
      throw new AppError('SUB2API_NOT_CONFIGURED', '未配置 SUB2API_BASE_URL', { status: 503 });
    }
    const url = new URL(path, `${this.config.sub2apiBaseUrl}/`);
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs || this.config.requestTimeoutMs;
    const maxBytes = options.maxBytes || this.config.maxResponseBytes;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    let requestAccepted = false;
    let receivedEvents = 0;

    try {
      const response = await this.fetch(url, {
        method: options.method || 'GET',
        headers: {
          accept: 'text/event-stream',
          ...(options.body == null ? {} : { 'content-type': 'application/json' }),
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          ...(options.headers || {})
        },
        body: options.body == null ? undefined : JSON.stringify(options.body),
        redirect: 'error',
        signal,
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {})
      });

      const recoveryToken = response.headers.get('x-sub2api-recovery-token');
      options.onResponse?.({
        token: typeof recoveryToken === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(recoveryToken)
          ? recoveryToken : null,
        applied: response.headers.get('x-sub2api-recovery-applied') === '1'
      });

      if (!response.ok) {
        const payload = parsePayload(await readLimited(response, maxBytes));
        throw httpFailure(response, payload, true);
      }
      requestAccepted = true;

      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      if (!contentType.includes('text/event-stream')) {
        const payload = parsePayload(await readLimited(response, maxBytes));
        if (payload?.error) {
          receivedEvents += 1;
          await onEvent({ type: 'error', error: payload.error });
          return { bytes: Buffer.byteLength(JSON.stringify(payload)), events: 1, fallbackJson: true };
        }
        if (payload?.object === 'response' || payload?.id) {
          receivedEvents += 1;
          await onEvent({
            type: `response.${payload.status || 'completed'}`,
            response: payload
          });
          return { bytes: Buffer.byteLength(JSON.stringify(payload)), events: 1, fallbackJson: true };
        }
        throw new AppError('SUB2API_STREAM_UNSUPPORTED', 'Sub2API 没有返回 Responses 流式事件', {
          status: 502
        });
      }

      return await readEventStream(response, maxBytes, async (event) => {
        receivedEvents += 1;
        return onEvent(event);
      });
    } catch (error) {
      if (options.signal?.aborted) throw new AppError('DETECTION_CANCELLED', '检测已停止', { status: 409 });
      if (error instanceof AppError) {
        error.responseStarted = requestAccepted || receivedEvents > 0;
        if (error.responseStarted && error.retryable) error.retryable = false;
        throw error;
      }
      const responseStarted = requestAccepted || receivedEvents > 0;
      const safeToRetry = !responseStarted && isSafePreconnectError(error);
      if (isTimeoutError(error)) {
        const timeoutError = new AppError(
          safeToRetry ? 'SUB2API_TIMEOUT' : 'SUB2API_STREAM_INTERRUPTED',
          safeToRetry
            ? timeoutMessage(timeoutMs)
            : responseStarted
            ? 'Sub2API 流式响应中断，本次请求结果未知'
            : 'Sub2API 请求状态未知',
          { status: 504, retryable: safeToRetry }
        );
        timeoutError.responseStarted = !safeToRetry;
        timeoutError.recoverable = !safeToRetry && canRecoverTransport(error);
        timeoutError.outcomeUnknown = !safeToRetry;
        throw timeoutError;
      }
      const unavailable = new AppError(
        safeToRetry ? 'SUB2API_UNAVAILABLE' : 'SUB2API_STREAM_INTERRUPTED',
        safeToRetry
          ? '无法连接 Sub2API'
          : responseStarted
          ? 'Sub2API 流式响应中断，本次请求结果未知'
          : 'Sub2API 请求状态未知',
        { status: 503, retryable: safeToRetry }
      );
      unavailable.responseStarted = !safeToRetry;
      unavailable.recoverable = !safeToRetry && canRecoverTransport(error);
      unavailable.outcomeUnknown = !safeToRetry;
      throw unavailable;
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }

  async verifyUser(accessToken) {
    const data = unwrap(await this.request('/api/v1/auth/me', { token: accessToken, timeoutMs: 15000 }));
    const user = data?.user || data?.profile || data || {};
    const id = user.id ?? user.user_id ?? user.sub;
    if (id == null || id === '') {
      throw new AppError('AUTH_INVALID_RESPONSE', 'Sub2API 没有返回有效用户身份', { status: 502 });
    }
    const role = String(user.role || 'user');
    return {
      id: String(id),
      name: String(user.username || user.name || user.email || `用户 ${id}`),
      email: String(user.email || ''),
      role,
      is_admin: user.is_admin === true,
      isAdmin: role.toLowerCase() === 'admin' ||
        role.toLowerCase() === 'root' ||
        user.is_admin === true ||
        user.isAdmin === true
    };
  }

  async listAvailableGroups(accessToken) {
    const groups = asItems(await this.request('/api/v1/groups/available', { token: accessToken }));
    return groups
      .filter((group) => group && group.id != null)
      .map((group) => ({
        ...group,
        id: String(group.id),
        name: String(group.name || `分组 ${group.id}`),
        platform: String(group.platform || '').trim().toLowerCase(),
        status: String(group.status || 'active')
      }));
  }

  async gatewayJson(path, apiKey, body, options = {}) {
    return this.request(path, {
      inference: true,
      method: 'POST',
      token: apiKey,
      body,
      timeoutMs: options.timeoutMs || this.config.requestTimeoutMs,
      maxBytes: options.maxBytes || this.config.maxResponseBytes,
      headers: options.headers,
      signal: options.signal
    });
  }

  async gatewayEventStream(path, apiKey, body, onEvent, options = {}) {
    return this.requestEventStream(path, {
      method: 'POST',
      token: apiKey,
      body,
      timeoutMs: options.timeoutMs || this.config.requestTimeoutMs,
      maxBytes: options.maxBytes || this.config.maxResponseBytes,
      headers: options.headers,
      onResponse: options.onResponse,
      signal: options.signal
    }, onEvent);
  }
}

module.exports = {
  Sub2ApiClient,
  asItems,
  isSafePreconnectError,
  isTimeoutError,
  isTransientModelFailure,
  isUncertainModelFailure,
  parsePayload,
  readEventStream,
  readLimited,
  retryAfterMs,
  timeoutMessage,
  unwrap
};
