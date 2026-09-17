const { AppError } = require('../errors');
const { resolveSafeUrl } = require('../security/ssrf-guard');
const { createPinnedDispatcher } = require('./pinned-dispatcher');

const SAFE_CUSTOM_HEADERS = new Set([
  'accept',
  'content-type',
  'authorization',
  'anthropic-version',
  'x-api-key',
  'api-key',
  'new-api-user',
  'veloera-user',
  'voapi-user',
  'user-id',
  'x-api-user',
  'rix-api-user',
  'neo-api-user'
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const timestamp = Date.parse(value);
  if (Number.isFinite(timestamp)) return Math.max(0, timestamp - Date.now());
  return null;
}

function remoteErrorCode(body) {
  const candidates = [body?.reason, body?.error?.code, body?.code];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const value = candidate.trim();
    if (value && !/^\d+$/.test(value)) return value;
  }
  return null;
}

function sanitizeHeaders(headers = {}) {
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalized = key.toLowerCase();
    if (!SAFE_CUSTOM_HEADERS.has(normalized) && normalized.startsWith('x-') === false) {
      continue;
    }
    if (['host', 'connection', 'content-length', 'transfer-encoding'].includes(normalized)) {
      continue;
    }
    result[key] = String(value);
  }
  return result;
}

async function readLimitedBody(response, maxBytes) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new AppError('RESPONSE_TOO_LARGE', 'Provider response exceeded the configured size limit', {
        status: 502
      });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

function parseSseBlock(block) {
  let event = 'message';
  let id = null;
  const dataLines = [];
  for (const rawLine of String(block || '').split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith(':')) continue;
    const separator = rawLine.indexOf(':');
    const field = separator === -1 ? rawLine : rawLine.slice(0, separator);
    let value = separator === -1 ? '' : rawLine.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value || 'message';
    if (field === 'id') id = value;
    if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  const rawData = dataLines.join('\n');
  let data = rawData;
  if (rawData !== '[DONE]') {
    try {
      data = JSON.parse(rawData);
    } catch {
      // Some compatible providers emit plain text SSE data.
    }
  }
  return { event, id, data, rawData };
}

async function readSseBody(response, options = {}) {
  if (!response.body) {
    throw new AppError('INCOMPLETE_PROBE', 'Provider returned an empty streaming response', {
      status: 502
    });
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const maxBytes = options.maxResponseBytes;
  let buffer = '';
  let bytes = 0;
  let eventCount = 0;

  const dispatch = async (block) => {
    const parsed = parseSseBlock(block);
    if (!parsed) return;
    eventCount += 1;
    await options.onEvent?.(parsed);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        throw new AppError('RESPONSE_TOO_LARGE', 'Provider stream exceeded the configured size limit', {
          status: 502
        });
      }
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)[0];
        buffer = buffer.slice(boundary + separator.length);
        await dispatch(block);
        boundary = buffer.search(/\r?\n\r?\n/);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) await dispatch(buffer);
    return { eventCount, bytes };
  } catch (error) {
    try {
      await reader.cancel();
    } catch {}
    throw error;
  }
}

function classifyHttpError(status, body, headers) {
  const message =
    body?.message ||
    body?.error?.message ||
    body?.error ||
    `Provider returned HTTP ${status}`;
  const details = { remoteCode: remoteErrorCode(body), remoteStatus: status };

  if (status === 401) {
    return new AppError('AUTH_FAILED', message, { status: 401, details });
  }
  if (status === 403) {
    return new AppError('PERMISSION_DENIED', message, { status: 403, details });
  }
  if (status === 404) {
    return new AppError('CAPABILITY_UNSUPPORTED', message, { status: 404, details });
  }
  if (status === 429) {
    return new AppError('RATE_LIMITED', message, {
      status: 429,
      retryable: true,
      details: { ...details, retryAfterMs: parseRetryAfter(headers.get('retry-after')) }
    });
  }
  if (status >= 500) {
    return new AppError('REMOTE_SERVER_ERROR', message, {
      status: 502,
      retryable: true,
      details
    });
  }
  return new AppError('REMOTE_REQUEST_FAILED', message, {
    status: status >= 400 && status < 500 ? status : 502,
    details
  });
}

class HttpClient {
  constructor(config) {
    this.config = config;
  }

  async requestJson(input, options = {}) {
    const retries = Number.isFinite(options.retries) ? options.retries : 2;
    let attempt = 0;
    let lastError;

    while (attempt <= retries) {
      try {
        return await this.#requestOnce(input, options);
      } catch (error) {
        lastError = error;
        if (!error.retryable || attempt >= retries) throw error;
        const retryAfterMs = Math.min(
          error.details?.retryAfterMs ?? 250 * 2 ** attempt,
          30000
        );
        const jitter = Math.floor(Math.random() * 200);
        await sleep(retryAfterMs + jitter);
        attempt += 1;
      }
    }
    throw lastError;
  }

  async requestSse(input, options = {}) {
    const resolution = await resolveSafeUrl(input, this.config);
    const dispatcher = createPinnedDispatcher(resolution);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      options.timeoutMs || this.config.queryTimeoutMs
    );
    try {
      const response = await fetch(resolution.url, {
        method: options.method || 'GET',
        headers: sanitizeHeaders(options.headers),
        body: options.body == null
          ? undefined
          : typeof options.body === 'string'
            ? options.body
            : JSON.stringify(options.body),
        redirect: 'manual',
        signal: controller.signal,
        dispatcher
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        throw new AppError('REDIRECT_NOT_ALLOWED', 'Provider streaming endpoint returned a redirect', {
          status: 502,
          details: { remoteStatus: response.status }
        });
      }
      if (!response.ok) {
        const rawText = await readLimitedBody(
          response,
          Math.min(options.maxResponseBytes || this.config.maxResponseBytes, 1024 * 1024)
        );
        let body = null;
        try {
          body = rawText ? JSON.parse(rawText) : null;
        } catch {}
        throw classifyHttpError(response.status, body, response.headers);
      }
      const stream = await readSseBody(response, {
        maxResponseBytes: options.maxResponseBytes || this.config.maxResponseBytes,
        onEvent: options.onEvent
      });
      return {
        status: response.status,
        headers: response.headers,
        url: resolution.url.toString(),
        ...stream
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error?.name === 'AbortError' || controller.signal.aborted) {
        throw new AppError('TIMEOUT', 'Provider streaming request timed out', {
          status: 504,
          retryable: true,
          cause: error
        });
      }
      throw new AppError('NETWORK_UNREACHABLE', error?.message || 'Provider streaming request failed', {
        status: 502,
        retryable: true,
        cause: error
      });
    } finally {
      clearTimeout(timeout);
      await dispatcher.close();
    }
  }

  async #requestOnce(input, options) {
    let currentUrl = input;
    const maxRedirects = options.maxRedirects ?? 3;
    let redirects = 0;

    while (true) {
      const resolution = await resolveSafeUrl(currentUrl, this.config);
      const dispatcher = createPinnedDispatcher(resolution);
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        options.timeoutMs || this.config.queryTimeoutMs
      );
      try {
        const response = await fetch(resolution.url, {
          method: options.method || 'GET',
          headers: sanitizeHeaders(options.headers),
          body:
            options.body == null
              ? undefined
              : typeof options.body === 'string'
                ? options.body
                : JSON.stringify(options.body),
          redirect: 'manual',
          signal: controller.signal,
          dispatcher
        });

        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          if (redirects >= maxRedirects) {
            throw new AppError('TOO_MANY_REDIRECTS', 'Provider returned too many redirects', {
              status: 502
            });
          }
          const location = response.headers.get('location');
          if (!location) {
            throw new AppError('INVALID_REDIRECT', 'Provider redirect is missing a Location header', {
              status: 502
            });
          }
          currentUrl = new URL(location, resolution.url).toString();
          redirects += 1;
          continue;
        }

        const rawText = await readLimitedBody(
          response,
          options.maxResponseBytes || this.config.maxResponseBytes
        );
        let body = null;
        if (rawText) {
          try {
            body = JSON.parse(rawText);
          } catch (error) {
            if (!response.ok) {
              throw classifyHttpError(response.status, null, response.headers);
            }
            throw new AppError('SCHEMA_MISMATCH', 'Provider response is not valid JSON', {
              status: 502,
              details: { contentType: response.headers.get('content-type') },
              cause: error
            });
          }
        }

        if (!response.ok) throw classifyHttpError(response.status, body, response.headers);

        return {
          status: response.status,
          headers: response.headers,
          data: body,
          url: resolution.url.toString()
        };
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (error.name === 'AbortError' || controller.signal.aborted) {
          throw new AppError('TIMEOUT', 'Provider request timed out', {
            status: 504,
            retryable: true,
            cause: error
          });
        }
        throw new AppError('NETWORK_UNREACHABLE', error.message || 'Provider network request failed', {
          status: 502,
          retryable: true,
          cause: error
        });
      } finally {
        clearTimeout(timeout);
        await dispatcher.close();
      }
    }
  }
}

module.exports = {
  HttpClient,
  classifyHttpError,
  parseRetryAfter,
  remoteErrorCode,
  sanitizeHeaders,
  parseSseBlock
};
