'use strict';

const { Agent, fetch: undiciFetch } = require('undici');
const { AppError } = require('./errors');

const UNDICI_TIMEOUT_CODES = new Set([
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT'
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

  const dispatch = async (block) => {
    const data = block
      .split(/\r\n|\r|\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data || data.trim() === '[DONE]') return;

    let event;
    try {
      event = JSON.parse(data);
    } catch {
      throw new AppError('SUB2API_STREAM_INVALID', 'Sub2API 返回了无效的流式事件', { status: 502 });
    }
    events += 1;
    await onEvent(event);
  };

  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      try { await response.body.cancel(); } catch {}
      throw new AppError('UPSTREAM_RESPONSE_TOO_LARGE', '上游响应超过大小限制', { status: 502 });
    }
    pending += decoder.decode(buffer, { stream: true });
    let boundary;
    while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(pending))) {
      const block = pending.slice(0, boundary.index);
      pending = pending.slice(boundary.index + boundary[0].length);
      await dispatch(block);
    }
  }

  pending += decoder.decode();
  if (pending.trim()) await dispatch(pending);
  return { bytes: total, events };
}

function errorMessage(payload, status) {
  return payload?.error?.message || payload?.message || `Sub2API 返回 HTTP ${status}`;
}

function isTimeoutError(error) {
  return error?.name === 'AbortError' ||
    UNDICI_TIMEOUT_CODES.has(error?.code) ||
    UNDICI_TIMEOUT_CODES.has(error?.cause?.code);
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
        signal: controller.signal,
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {})
      });
      const raw = await readLimited(response, options.maxBytes || this.config.maxResponseBytes);
      const payload = parsePayload(raw);
      if (!response.ok) {
        const status = response.status === 401 ? 401 : response.status === 403 ? 403 : 502;
        throw new AppError(
          response.status === 401 ? 'SUB2API_AUTH_EXPIRED' : 'SUB2API_REQUEST_FAILED',
          errorMessage(payload, response.status),
          {
            status,
            retryable: response.status === 429 || response.status >= 500,
            details: { upstreamStatus: response.status }
          }
        );
      }
      return payload || {};
    } catch (error) {
      if (error instanceof AppError) throw error;
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
        signal: controller.signal,
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {})
      });

      if (!response.ok) {
        const payload = parsePayload(await readLimited(response, maxBytes));
        const status = response.status === 401 ? 401 : response.status === 403 ? 403 : 502;
        throw new AppError(
          response.status === 401 ? 'SUB2API_AUTH_EXPIRED' : 'SUB2API_REQUEST_FAILED',
          errorMessage(payload, response.status),
          {
            status,
            retryable: response.status === 429 || (response.status >= 500 && response.status !== 524),
            details: { upstreamStatus: response.status }
          }
        );
      }

      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      if (!contentType.includes('text/event-stream')) {
        const payload = parsePayload(await readLimited(response, maxBytes));
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
        await onEvent(event);
      });
    } catch (error) {
      if (error instanceof AppError) {
        error.responseStarted = receivedEvents > 0;
        if (error.responseStarted && error.retryable) error.retryable = false;
        throw error;
      }
      const responseStarted = receivedEvents > 0;
      if (isTimeoutError(error)) {
        const timeoutError = new AppError(
          responseStarted ? 'SUB2API_STREAM_INTERRUPTED' : 'SUB2API_TIMEOUT',
          responseStarted
            ? 'Sub2API 流式响应中断；为避免重复消费，未重新提交本次推理'
            : timeoutMessage(timeoutMs),
          { status: 504, retryable: !responseStarted }
        );
        timeoutError.responseStarted = responseStarted;
        throw timeoutError;
      }
      const unavailable = new AppError(
        responseStarted ? 'SUB2API_STREAM_INTERRUPTED' : 'SUB2API_UNAVAILABLE',
        responseStarted
          ? 'Sub2API 流式响应中断；为避免重复消费，未重新提交本次推理'
          : '无法连接 Sub2API',
        { status: 503, retryable: !responseStarted }
      );
      unavailable.responseStarted = responseStarted;
      throw unavailable;
    } finally {
      clearTimeout(timeout);
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
      method: 'POST',
      token: apiKey,
      body,
      timeoutMs: options.timeoutMs || this.config.requestTimeoutMs,
      maxBytes: options.maxBytes || this.config.maxResponseBytes,
      headers: options.headers
    });
  }

  async gatewayEventStream(path, apiKey, body, onEvent, options = {}) {
    return this.requestEventStream(path, {
      method: 'POST',
      token: apiKey,
      body,
      timeoutMs: options.timeoutMs || this.config.requestTimeoutMs,
      maxBytes: options.maxBytes || this.config.maxResponseBytes,
      headers: options.headers
    }, onEvent);
  }
}

module.exports = {
  Sub2ApiClient,
  asItems,
  isTimeoutError,
  parsePayload,
  readEventStream,
  readLimited,
  timeoutMessage,
  unwrap
};
