const { AppError } = require('../errors');
const { resolveSafeUrl } = require('../security/ssrf-guard');
const { createPinnedDispatcher } = require('./pinned-dispatcher');

const SAFE_CUSTOM_HEADERS = new Set([
  'accept',
  'content-type',
  'authorization',
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

function classifyHttpError(status, body, headers) {
  const message =
    body?.message ||
    body?.error?.message ||
    body?.error ||
    `Provider returned HTTP ${status}`;

  if (status === 401) {
    return new AppError('AUTH_FAILED', message, { status: 401 });
  }
  if (status === 403) {
    return new AppError('PERMISSION_DENIED', message, { status: 403 });
  }
  if (status === 404) {
    return new AppError('CAPABILITY_UNSUPPORTED', message, { status: 404 });
  }
  if (status === 429) {
    return new AppError('RATE_LIMITED', message, {
      status: 429,
      retryable: true,
      details: { retryAfterMs: parseRetryAfter(headers.get('retry-after')) }
    });
  }
  if (status >= 500) {
    return new AppError('REMOTE_SERVER_ERROR', message, {
      status: 502,
      retryable: true,
      details: { remoteStatus: status }
    });
  }
  return new AppError('REMOTE_REQUEST_FAILED', message, {
    status: status >= 400 && status < 500 ? status : 502,
    details: { remoteStatus: status }
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
  parseRetryAfter,
  sanitizeHeaders
};
