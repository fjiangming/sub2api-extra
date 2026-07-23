const { AppError } = require('../errors');
const { resolveSafeUrl } = require('../security/ssrf-guard');
const { createPinnedDispatcher } = require('./pinned-dispatcher');

async function safeFetch(input, config, options = {}) {
  const resolution = await resolveSafeUrl(input, config);
  const dispatcher = createPinnedDispatcher(resolution);
  const controller = new AbortController();
  const {
    timeoutMs = config.queryTimeoutMs,
    readBody = false,
    ...requestOptions
  } = options;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(resolution.url, {
      ...requestOptions,
      redirect: 'error',
      signal: controller.signal,
      dispatcher
    });
    const body = readBody ? await response.text() : null;
    if (!readBody) await response.body?.cancel();
    return {
      ok: response.ok,
      status: response.status,
      headers: response.headers,
      ...(readBody ? { body } : {})
    };
  } catch (error) {
    if (error?.name === 'AbortError' || controller.signal.aborted) {
      throw new AppError('TIMEOUT', 'Outbound request timed out', { status: 504, retryable: true });
    }
    if (error instanceof AppError) throw error;
    throw new AppError('NETWORK_UNREACHABLE', error?.message || 'Outbound request failed', {
      status: 502,
      retryable: true
    });
  } finally {
    clearTimeout(timeout);
    await dispatcher.close();
  }
}

module.exports = { safeFetch };
